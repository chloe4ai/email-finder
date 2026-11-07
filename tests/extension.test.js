// extension/background.js with a stubbed chrome.* API and network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const area = (o) => ({ get: async (k) => ({ [k]: o[k] }), set: async (v) => Object.assign(o, v) });
globalThis.chrome = {
  storage: { local: area({}), session: area({}) },
  runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} },
};
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('dns-query') || u.includes('dns.google')) {
    const d = new URL(u).searchParams.get('name');
    return new Response(JSON.stringify({ Answer: [{ type: 15, data: `10 mx.${d}.` }] }));
  }
  return new Response('', { status: 404 }); // site crawl, gravatar
};

const { find, cacheKey } = await import('../extension/background.js');
const li = 'https://www.linkedin.com/in/jane-doe';

test('cache key includes the company / domain', () => {
  assert.notEqual(cacheKey({ linkedin: li, name: 'Jane Doe', company: 'Acme' }), cacheKey({ linkedin: li, name: 'Jane Doe', company: 'Globex' }));
  assert.notEqual(cacheKey({ name: 'Jane Doe', domain: 'acme.com' }), cacheKey({ name: 'Jane Doe', domain: 'globex.com' }));
  assert.equal(cacheKey({ linkedin: li, company: 'Acme ' }), cacheKey({ linkedin: li, company: 'acme' }));
});

test('picking another company for the same profile runs a new lookup', async () => {
  const a = await find({ name: 'Jane Doe', company: 'acme.com', linkedin: li });
  const b = await find({ name: 'Jane Doe', company: 'globex.com', linkedin: li });
  assert.equal(a.best.email, 'jane.doe@acme.com');
  assert.equal(b.best.email, 'jane.doe@globex.com');
  assert.ok(!b.cached);
  const again = await find({ name: 'Jane Doe', company: 'acme.com', linkedin: li });
  assert.equal(again.cached, true);
  assert.equal(again.best.email, 'jane.doe@acme.com');
});
