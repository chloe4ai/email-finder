// server.js origin allow-list, driven over a real socket on an ephemeral port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'email-finder-test-'));
process.env.EMAIL_FINDER_HOME = home;
const { server, originAllowed } = await import('../server.js');

let port;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });

function req(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('originAllowed', () => {
  assert.ok(originAllowed(undefined, 'localhost:4790'));
  assert.ok(originAllowed('http://localhost:4790', 'localhost:4790'));
  assert.ok(originAllowed(EXT, 'localhost:4790'));
  assert.ok(!originAllowed('https://evil.example', 'localhost:4790'));
  assert.ok(!originAllowed('http://localhost:4791', 'localhost:4790'));
  assert.ok(!originAllowed('null', 'localhost:4790'));
});

test('no Origin (curl, CLI) → allowed, no CORS header', async () => {
  const r = await req('GET', '/api/history');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.ok(Array.isArray(JSON.parse(r.body).lookups));
});

test('another website cannot read history or spend credits', async () => {
  const evil = { Origin: 'https://evil.example' };
  assert.equal((await req('GET', '/api/history', evil)).status, 403);
  assert.equal((await req('GET', '/api/keys', evil)).status, 403);
  assert.equal((await req('POST', '/api/find', { ...evil, 'Content-Type': 'text/plain' }, '{"name":"Jane Doe","domain":"acme.com"}')).status, 403);
  const pre = await req('OPTIONS', '/api/find', evil);
  assert.equal(pre.status, 403);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
});

test('same-origin page and the extension are allowed and echoed', async () => {
  for (const origin of [`http://127.0.0.1:${port}`, EXT]) {
    const r = await req('GET', '/api/keys', { Origin: origin });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], origin);
  }
});

test('non-loopback Host header is refused (DNS rebinding)', async () => {
  assert.equal((await req('GET', '/api/history', { Host: `evil.example:${port}` })).status, 403);
});

test('serves the web UI', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /data-copy=/);
  assert.doesNotMatch(r.body, /onclick="navigator\.clipboard/);
});
