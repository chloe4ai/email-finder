import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitName, nameFromLinkedin, candidates, clean, patternsForLocal, inferFromEmails, isGeneric } from '../engine/patterns.js';

const SPLIT = [
  ['Jane Doe', 'jane', 'doe', ''],
  ['Doe, Jane', 'jane', 'doe', ''],
  ['DOE, JANE', 'jane', 'doe', ''],
  ['Doe, Jane, MBA', 'jane', 'doe', ''],
  ['Dr. Jane A. Doe', 'jane', 'doe', 'a'],
  ['John Smith, Jr.', 'john', 'smith', ''],
  ['John Smith Jr.', 'john', 'smith', ''],
  ['Jane Doe, MBA', 'jane', 'doe', ''],
  ['Jane Doe, PMP', 'jane', 'doe', ''],
  ['Jane Doe, Ph.D.', 'jane', 'doe', ''],
  ['Jane Doe, CPA', 'jane', 'doe', ''],
  ['Jane Doe, PE', 'jane', 'doe', ''],
  ['Jane Doe, CISSP, CISM', 'jane', 'doe', ''],
  ['Jane Doe PhD', 'jane', 'doe', ''],
  ['Jane Doe 🚀', 'jane', 'doe', ''],
  ['🇺🇸 Jane Doe 👩🏽‍💻', 'jane', 'doe', ''],
  ['Jane Doe (She/Her)', 'jane', 'doe', ''],
  ['Jane Doe [he/him]', 'jane', 'doe', ''],
  ['Robert "Bob" Smith', 'robert', 'smith', ''],
  ['Jane Doe - Senior Engineer - Acme', 'jane', 'doe', ''],
  ['Jane Doe | Product at Acme', 'jane', 'doe', ''],
  ['Mary-Jane Smith-Jones', 'maryjane', 'smithjones', ''],
  ['José García', 'jose', 'garcia', ''],
  ['Søren Østergaard', 'soren', 'ostergaard', ''],
  ['Łukasz Wróbel', 'lukasz', 'wrobel', ''],
  ['Hans Groß', 'hans', 'gross', ''],
  ['Æsa Þórsdóttir', 'aesa', 'thorsdottir', ''],
  ['Đorđe Đukić', 'dorde', 'dukic', ''],
  ['Ma Long', 'ma', 'long', ''],
  ['Long, Ma', 'ma', 'long', ''],
  ['Cher', 'cher', '', ''],
  ['', '', '', ''],
];

for (const [input, first, last, middle] of SPLIT) {
  test(`splitName ${JSON.stringify(input)}`, () => {
    assert.deepEqual(splitName(input), { first, last, middle });
  });
}

const SLUGS = [
  ['https://www.linkedin.com/in/jane-doe', 'jane doe'],
  ['https://www.linkedin.com/in/jane-doe/', 'jane doe'],
  ['https://www.linkedin.com/in/jane-doe-1a2b3c4d', 'jane doe'],
  ['https://www.linkedin.com/in/eric-glyman-1a2b', 'eric glyman'],
  ['https://www.linkedin.com/in/jane-doe-123456789?trk=x', 'jane doe'],
  ['https://www.linkedin.com/in/ana-decafe', 'ana decafe'],
  ['https://www.linkedin.com/in/jane-doe-mba', 'jane doe'],
  ['https://www.linkedin.com/in/john-smith-jr', 'john smith'],
  ['https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa', 'jose garcia'],
  ['https://www.linkedin.com/in/s%C3%B8ren-%C3%B8stergaard', 'soren ostergaard'],
  ['https://www.linkedin.com/in/jane%E0-doe', 'jane doe'], // malformed % must not throw
  ['https://www.linkedin.com/in/jane%ZZ-doe', 'jane doe'],
  ['https://www.linkedin.com/in/jane2doe', 'jane doe'],
  ['https://www.linkedin.com/in/cher', 'cher'],
  ['https://example.com/jane', null],
];

for (const [url, want] of SLUGS) {
  test(`nameFromLinkedin ${url.split('/').slice(3).join('/')}`, () => {
    assert.equal(nameFromLinkedin(url), want);
  });
}

test('clean strips accents and non-letters', () => {
  assert.equal(clean("O'Brien-Ñúñez"), 'obriennunez');
  assert.equal(clean('Ødegård'), 'odegard');
});

test('candidates dedupes identical local parts and keeps pattern order', () => {
  const c = candidates('Al', 'A', 'acme.com');
  const emails = c.map((x) => x.email);
  assert.equal(new Set(emails).size, emails.length);
  assert.equal(c[0].pattern, 'first.last');
  // first='al', last='a': 'firstl' (ala) == 'firstlast' (ala) → only one kept
  assert.equal(emails.filter((e) => e === 'ala@acme.com').length, 1);
});

test('candidates without a last name only builds first@', () => {
  assert.deepEqual(candidates('Jane', '', 'acme.com').map((c) => c.email), ['jane@acme.com']);
});

test('candidates cleans names', () => {
  assert.equal(candidates('José', 'García', 'acme.com')[0].email, 'jose.garcia@acme.com');
});

test('patternsForLocal with a known name', () => {
  assert.deepEqual(patternsForLocal('jdoe', { first: 'jane', last: 'doe' }), ['flast']);
  assert.deepEqual(patternsForLocal('jane', { first: 'jane', last: '' }), ['first']);
  assert.deepEqual(patternsForLocal('janeundefined', { first: 'jane', last: '' }), []);
});

test('inferFromEmails skips generic addresses', () => {
  assert.ok(isGeneric('info@acme.com'));
  const v = inferFromEmails(['info@acme.com', 'jane.doe@acme.com', 'bob.smith@acme.com']);
  assert.deepEqual(v, { 'first.last': 2 });
});
