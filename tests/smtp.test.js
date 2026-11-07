// The Node SMTP probe against a fake MX on localhost (no real mail servers involved).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'email-finder-test-'));
process.env.EMAIL_FINDER_HOME = home;
const { smtp, port25 } = await import('../src/node-platform.js');

// behaviour: { mail?: reply, rcpt?: (addr) => reply, silent?: true }
function fakeMx(behaviour, host = '127.0.0.1', port = 0) {
  const srv = net.createServer((s) => {
    if (behaviour.silent) return; // accept the connection, never answer
    s.write('220 mx.test ESMTP\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(l)) s.write('250-mx.test\r\n250 PIPELINING\r\n');
        else if (/^MAIL/i.test(l)) s.write(behaviour.mail || '250 2.1.0 ok\r\n');
        else if (/^RCPT/i.test(l)) s.write(behaviour.rcpt(l.match(/<([^>]+)>/)[1]));
        else if (/^QUIT/i.test(l)) s.end('221 bye\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, host, () => resolve(srv)); });
}

const servers = [];
const start = async (b, host, port) => { const s = await fakeMx(b, host, port); servers.push(s); return s.address().port; };
after(() => { for (const s of servers) s.close(); fs.rmSync(home, { recursive: true, force: true }); });

const onlyReal = (addr) => (addr === 'real.person@acme.com' ? '250 2.1.5 ok\r\n' : '550 5.1.1 no such user\r\n');
const probe = (port, hosts = ['127.0.0.1'], opts = {}) => smtp('real.person@acme.com', hosts, { port, timeoutMs: 500, ...opts });

let realPort;
before(async () => { realPort = await start({ rcpt: onlyReal }); });

test('RCPT accepted, random mailbox rejected → valid', async () => {
  const r = await probe(realPort);
  assert.equal(r.status, 'valid');
  assert.equal(r.port25, 'open');
});

test('RCPT 550 → invalid', async () => {
  const port = await start({ rcpt: () => '550 5.1.1 no such user\r\n' });
  assert.equal((await probe(port)).status, 'invalid');
});

test('every RCPT accepted → catch_all', async () => {
  const port = await start({ rcpt: () => '250 ok\r\n' });
  assert.equal((await probe(port)).status, 'catch_all');
});

test('RCPT 451 greylisting → unknown', async () => {
  const port = await start({ rcpt: () => '451 4.7.1 try later\r\n' });
  assert.equal((await probe(port)).status, 'unknown');
});

test('MAIL FROM rejected (then 503 on RCPT) → unknown, not invalid', async () => {
  const port = await start({ mail: '553 5.1.8 sender domain verify.local does not exist\r\n', rcpt: () => '503 5.5.1 need MAIL command\r\n' });
  const r = await probe(port);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /MAIL FROM rejected/);
});

test('a timeout after port 25 answered does not mark it blocked', async () => {
  const silent = await start({ silent: true });
  const r = await probe(silent);
  assert.equal(r.status, 'unknown');
  assert.notEqual(port25(), 'blocked');
  assert.equal((await probe(realPort)).status, 'valid'); // probing still works afterwards
});

test('a silent first MX falls through to the second', async (t) => {
  // needs two loopback addresses on one port (Linux has all of 127/8; macOS only 127.0.0.1)
  let port;
  try { port = await start({ silent: true }, '127.0.0.2'); await start({ rcpt: onlyReal }, '127.0.0.1', port); } catch { return t.skip('127.0.0.2 not available'); }
  const r = await probe(port, ['127.0.0.2', '127.0.0.1']);
  assert.equal(r.status, 'valid');
});
