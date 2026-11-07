import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, looksLikeDomain, providerFromMx, resolveDomain } from '../engine/domain.js';
import { extractEmails } from '../engine/crawl.js';

test('normalizeDomain strips scheme, www, path, query and case', () => {
  assert.equal(normalizeDomain('https://www.Acme.com/about?x=1#y'), 'acme.com');
  assert.equal(normalizeDomain('http://sub.acme.co.uk/'), 'sub.acme.co.uk');
  assert.equal(normalizeDomain('  ACME.COM  '), 'acme.com');
  assert.equal(normalizeDomain(null), '');
});

test('looksLikeDomain', () => {
  assert.ok(looksLikeDomain('acme.com'));
  assert.ok(looksLikeDomain('acme.co.uk'));
  assert.ok(!looksLikeDomain('Acme Inc'));
  assert.ok(!looksLikeDomain('acme'));
});

test('resolveDomain returns a given domain without any network call', async () => {
  const r = await resolveDomain('https://www.acme.com/team');
  assert.deepEqual(r, { domain: 'acme.com', company: null, how: 'given', alternatives: [] });
});

test('providerFromMx', () => {
  assert.equal(providerFromMx(['aspmx.l.google.com']), 'google_workspace');
  assert.equal(providerFromMx(['acme-com.mail.protection.outlook.com']), 'microsoft_365');
  assert.equal(providerFromMx(['mx1.pphosted.com']), 'proofpoint');
  assert.equal(providerFromMx(['mx.acme.com']), 'other');
  assert.equal(providerFromMx([]), 'none');
});

const EXTRACT = [
  ['plain', 'mail jane.doe@acme.com today', ['jane.doe@acme.com']],
  ['subdomain', 'bob@sales.acme.com', ['bob@sales.acme.com']],
  ['uppercase', 'Jane.Doe@ACME.com', ['jane.doe@acme.com']],
  ['trailing period', 'write to jane@acme.com.', ['jane@acme.com']],
  ['longer TLD is not this domain', 'jane@acme.community', []],
  ['domain suffix of another host', 'bob@acme.com.evil.io', []],
  ['hyphenated continuation', 'bob@acme.com-mail.net', []],
  ['other domain', 'jane@notacme.org', []],
  ['JSON \\u003e escape', '{"html":"\\u003ejane.doe@acme.com\\u003c/a\\u003e"}', ['jane.doe@acme.com']],
  ['JSON \\u0040 escape', '"jane.doe\\u0040acme.com"', ['jane.doe@acme.com']],
  ['HTML entities', '&lt;jane.doe@acme.com&gt; and joe&#64;acme.com', ['jane.doe@acme.com', 'joe@acme.com']],
  ['[at] [dot] obfuscation', 'jane [at] acme [dot] com', ['jane@acme.com']],
  ['image filename', 'logo@2x.acme.com.png', []],
  ['tracking hash', '0123456789abcdef0123456789@acme.com', []],
  ['dedupe', 'a@acme.com A@acme.com', ['a@acme.com']],
];

for (const [label, html, want] of EXTRACT) {
  test(`extractEmails: ${label}`, () => {
    assert.deepEqual(extractEmails(html, 'acme.com'), want);
  });
}
