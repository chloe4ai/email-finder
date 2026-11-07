// findEmail / verifyEmail with every network call stubbed: no request leaves the process.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, memoryStorage } from '../engine/platform.js';
import { findEmail } from '../engine/finder.js';

const MX = {
  'acme.com': [{ priority: 10, exchange: 'aspmx.l.google.com' }],
  'newco.io': [{ priority: 10, exchange: 'newco-io.mail.protection.outlook.com' }],
  'm365co.com': [{ priority: 10, exchange: 'm365co-com.mail.protection.outlook.com' }],
};
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const HTML = (status) => new Response('<html><body>Too Many Requests</body></html>', { status, headers: { 'content-type': 'text/html' } });

let storage;
let calls;
let routes; // host substring → (url, init) => Response

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, body: init.body });
  for (const [k, fn] of Object.entries(routes)) if (url.includes(k)) return fn(url, init);
  if (url.includes('gravatar.com')) return new Response(null, { status: 404 });
  if (url.includes('microsoftonline.com')) return J({ IfExistsResult: 1 });
  throw new Error(`unexpected fetch in test: ${url}`);
};

beforeEach(() => {
  storage = memoryStorage();
  calls = [];
  routes = {};
  configure({ resolveMx: async (d) => MX[d] || [], smtp: null, storage, md5: null });
});

const o365Probes = () => calls.filter((c) => c.url.includes('microsoftonline')).map((c) => JSON.parse(c.body).Username);

test('Apollo email_status "verified" → status valid', async () => {
  routes['apollo.io'] = () => J({ person: { email: 'jane.doe@acme.com', email_status: 'verified', name: 'Jane Doe' } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { apollo: 'k' } });
  assert.equal(r.best.email, 'jane.doe@acme.com');
  assert.equal(r.best.status, 'valid');
  assert.equal(r.best.source, 'apollo');
  assert.ok(r.best.confidence >= 95);
});

test('Apollo unverified stays likely, not valid', async () => {
  routes['apollo.io'] = () => J({ person: { email: 'jane.doe@acme.com', email_status: 'extrapolated' } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { apollo: 'k' } });
  assert.equal(r.best.status, 'likely');
});

test('Prospeo VERIFIED → status valid', async () => {
  routes['prospeo.io'] = () => J({ error: false, person: { full_name: 'Jane Doe', email: { email: 'jane.doe@acme.com', status: 'VERIFIED' } } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { prospeo: 'k' } });
  assert.equal(r.best.status, 'valid');
  assert.equal(r.best.source, 'prospeo');
});

test('Hunter email-finder verification.status "valid" → status valid', async () => {
  routes['hunter.io/v2/email-finder'] = () => J({ data: { email: 'jane.doe@acme.com', score: 91, verification: { status: 'valid' } } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { hunter: 'k' } });
  assert.equal(r.best.status, 'valid');
  assert.equal(r.best.source, 'hunter');
});

test('Hunter email-finder accept_all → status catch_all', async () => {
  routes['hunter.io/v2/email-finder'] = () => J({ data: { email: 'jane.doe@acme.com', score: 60, verification: { status: 'accept_all' } } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { hunter: 'k' } });
  assert.equal(r.best.status, 'catch_all');
});

test('same-domain provider hit saves the pattern for the domain', async () => {
  routes['apollo.io'] = () => J({ person: { email: 'jdoe@acme.com', email_status: 'verified' } });
  await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { apollo: 'k' } });
  const p = await storage.getPattern('acme.com');
  assert.equal(p.pattern, 'flast');
  assert.equal(p.source, 'apollo');
});

test('cross-domain provider hit does not poison the input domain pattern, and checks the hit domain', async () => {
  routes['apollo.io'] = () => J({ person: { email: 'jane@newco.io', email_status: 'verified' } });
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { apollo: 'k' } });
  assert.equal(r.best.email, 'jane@newco.io');
  assert.equal(await storage.getPattern('acme.com'), null);
  assert.equal(await storage.getPattern('newco.io'), null);
  assert.equal(r.mx_provider, 'microsoft_365'); // newco.io's MX, not acme.com's Google MX
  assert.deepEqual(o365Probes(), ['jane@newco.io']);
  assert.ok(r.steps.some((s) => /not learning a pattern/.test(s)));
});

test('a later lookup on the input domain is not steered by a cross-domain hit', async () => {
  routes['apollo.io'] = () => J({ person: { email: 'jane@newco.io', email_status: 'verified' } });
  await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: { apollo: 'k' } });
  routes = {};
  const r = await findEmail({ name: 'Bob Smith', domain: 'acme.com' }, { keys: {}, crawl: false, verify: false });
  assert.equal(r.best.email, 'bob.smith@acme.com'); // prior, not the poisoned 'first'
});

test('Apollo 429 HTML body, Hunter 401 and Prospeo 500 HTML all fall through to the pattern engine', async () => {
  routes['apollo.io'] = () => HTML(429);
  routes['hunter.io'] = () => J({ errors: [{ id: 'authentication_failed', code: 401, details: 'No user found for the API key supplied' }] }, 401);
  routes['prospeo.io'] = () => HTML(500);
  const r = await findEmail({ name: 'Bob Smith', domain: 'acme.com' }, { keys: { apollo: 'k', hunter: 'k', prospeo: 'k' }, crawl: false });
  assert.equal(r.best.source, 'pattern-engine');
  assert.equal(r.best.email, 'bob.smith@acme.com');
  assert.ok(r.steps.some((s) => s.includes('apollo: no match (apollo 429)')), r.steps.join('\n'));
  assert.ok(r.steps.some((s) => s.includes('prospeo: no match (prospeo: 500)')), r.steps.join('\n'));
  assert.ok(!r.steps.some((s) => /not valid JSON/.test(s)));
  // a rejected key is not retried for the pattern lookup and every candidate
  assert.equal(calls.filter((c) => c.url.includes('hunter.io')).length, 1);
});

test('Hunter opt-out stops the provider waterfall', async () => {
  routes['apollo.io'] = () => J({ person: null });
  routes['hunter.io'] = () => J({ errors: [{ id: 'blacklisted_domain', details: 'opted out' }] }, 451);
  routes['prospeo.io'] = () => { throw new Error('should not be called'); };
  const r = await findEmail({ name: 'Bob Smith', domain: 'acme.com' }, { keys: { apollo: 'k', hunter: 'k', prospeo: 'k' }, crawl: false, verify: false });
  assert.equal(r.domain_optout, true);
  assert.equal(calls.filter((c) => c.url.includes('prospeo')).length, 0);
});

test('Microsoft 365 existence check confirms a candidate → valid, pattern learned', async () => {
  routes['microsoftonline.com'] = (_u, init) => J({ IfExistsResult: JSON.parse(init.body).Username === 'jsmith@m365co.com' ? 0 : 1 });
  const r = await findEmail({ name: 'Jane Smith', domain: 'm365co.com' }, { keys: {}, crawl: false });
  assert.equal(r.best.email, 'jsmith@m365co.com');
  assert.equal(r.best.status, 'valid');
  assert.equal((await storage.getPattern('m365co.com')).pattern, 'flast');
});

test('every candidate rejected by Microsoft 365 → no best guess', async () => {
  const r = await findEmail({ name: 'Jane Smith', domain: 'm365co.com' }, { keys: {}, crawl: false });
  assert.equal(r.best, null);
  assert.ok(r.candidates.every((c) => c.status === 'invalid'));
});

test('no SMTP and no keys → pattern-based guess, status likely/guess', async () => {
  const r = await findEmail({ name: 'Jane Doe', domain: 'acme.com' }, { keys: {}, crawl: false });
  assert.equal(r.best.email, 'jane.doe@acme.com');
  assert.ok(['likely', 'guess'].includes(r.best.status));
});

test('LinkedIn-only input guesses the name from the slug', async () => {
  const r = await findEmail({ linkedin: 'https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-1a2b3c', domain: 'acme.com' }, { keys: {}, crawl: false, verify: false });
  assert.equal(r.first, 'jose');
  assert.equal(r.last, 'garcia');
});
