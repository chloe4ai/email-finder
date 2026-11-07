// Node adapters for the engine: system DNS, a real SMTP probe (needs outbound
// port 25), md5 for legacy Gravatar hashes, and SQLite storage. Importing this
// module configures the engine; the CLI and server import it first.
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configure } from '../engine/platform.js';

// ── SMTP probe ───────────────────────────────────────────────────────
// 'unknown' | 'open' | 'blocked'. A port-25 timeout is remembered for a while (so a
// batch on a blocked network doesn't wait on every lookup) but not forever: one
// slow MX must not disable SMTP probing for the life of the process.
let port25State = 'unknown';
let blockedUntil = 0;
const BLOCKED_TTL = 10 * 60 * 1000;

function smtpSession(host, lines, { port = 25, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const replies = [];
    let buf = '';
    let i = 0;
    let done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve({ replies, err }); };
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('error', (e) => finish(e.code || e.message));
    sock.on('close', () => finish('closed'));
    sock.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (/^\d{3} /.test(line)) { // end of a (possibly multi-line) reply
          replies.push(line);
          if (i < lines.length) sock.write(lines[i++] + '\r\n');
          else finish(null);
        }
      }
    });
  });
}

const randomLocal = () => `zq${crypto.randomBytes(6).toString('hex')}`;
const codeOf = (reply) => Number(String(reply || '').slice(0, 3));

// opts.port / opts.timeoutMs exist for tests; real MX hosts are always probed on 25.
async function smtp(email, mxHosts, { probeCatchAll = true, port = 25, timeoutMs = 6000 } = {}) {
  if (port25State === 'blocked' && Date.now() < blockedUntil) return { status: 'unknown', reason: 'outbound port 25 blocked on this network', port25: 'blocked' };
  const domain = email.split('@')[1];
  const helo = 'verify.local';
  const cmds = [`EHLO ${helo}`, `MAIL FROM:<probe@${helo}>`, `RCPT TO:<${email}>`];
  if (probeCatchAll) cmds.push(`RCPT TO:<${randomLocal()}@${domain}>`);
  cmds.push('QUIT');

  let timeouts = 0;
  const hosts = mxHosts.slice(0, 2);
  for (const host of hosts) {
    const { replies, err } = await smtpSession(host, cmds, { port, timeoutMs });
    if (err === 'timeout' && replies.length === 0) { timeouts += 1; continue; } // try next MX
    if (err && replies.length === 0) continue; // refused / DNS error → try next MX
    port25State = 'open';
    // replies: [0] greeting, [1] EHLO, [2] MAIL FROM, [3] RCPT, [4] random RCPT
    const [greet, ehlo, mail, rcpt, rnd] = replies;
    if (codeOf(greet) >= 400) return { status: 'unknown', reason: `server refused the session: ${greet}`, port25: 'open' };
    if (ehlo && codeOf(ehlo) >= 400) return { status: 'unknown', reason: `EHLO rejected: ${ehlo}`, port25: 'open' };
    // a rejected sender says nothing about the mailbox: the RCPT reply after it is a 503 "bad sequence"
    if (mail && codeOf(mail) >= 400) return { status: 'unknown', reason: `MAIL FROM rejected: ${mail}`, port25: 'open' };
    if (!rcpt) return { status: 'unknown', reason: `server closed early: ${replies.at(-1) || err}`, port25: 'open' };
    const code = codeOf(rcpt);
    if (code === 503) return { status: 'unknown', reason: `bad sequence: ${rcpt}`, port25: 'open' };
    if (code >= 500) return { status: 'invalid', reason: rcpt, port25: 'open' };
    if (code >= 400) return { status: 'unknown', reason: `greylisted/temporary: ${rcpt}`, port25: 'open' };
    if (probeCatchAll && rnd && codeOf(rnd) < 300) return { status: 'catch_all', reason: 'random mailbox also accepted', port25: 'open' };
    return { status: 'valid', reason: rcpt, port25: 'open' };
  }
  if (timeouts && timeouts === hosts.length && port25State !== 'open') {
    // every MX timed out and nothing has ever answered here → very likely an ISP/firewall block
    port25State = 'blocked'; blockedUntil = Date.now() + BLOCKED_TTL;
    return { status: 'unknown', reason: 'port 25 timeout (blocked by ISP/firewall?)', port25: 'blocked' };
  }
  return { status: 'unknown', reason: timeouts ? 'MX hosts timed out' : 'all MX hosts unreachable', port25: port25State };
}

// ── SQLite storage ───────────────────────────────────────────────────
export const DATA_DIR = process.env.EMAIL_FINDER_HOME || path.join(import.meta.dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new DatabaseSync(path.join(DATA_DIR, 'finder.db'));
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS patterns (
    domain TEXT PRIMARY KEY, pattern TEXT NOT NULL, confidence REAL, source TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lookups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, company TEXT, domain TEXT, linkedin TEXT,
    email TEXT, confidence INTEGER, status TEXT, source TEXT, result TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
const q = {
  getPattern: sqlite.prepare('SELECT * FROM patterns WHERE domain = ?'),
  savePattern: sqlite.prepare(`INSERT INTO patterns (domain, pattern, confidence, source, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(domain) DO UPDATE SET pattern = excluded.pattern, confidence = excluded.confidence, source = excluded.source, updated_at = excluded.updated_at
    WHERE excluded.confidence >= patterns.confidence`),
  saveLookup: sqlite.prepare('INSERT INTO lookups (name, company, domain, linkedin, email, confidence, status, source, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  listLookups: sqlite.prepare('SELECT id, name, company, domain, linkedin, email, confidence, status, source, created_at FROM lookups ORDER BY id DESC LIMIT ?'),
  getSetting: sqlite.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  delSetting: sqlite.prepare('DELETE FROM settings WHERE key = ?'),
};

const PROVIDER_ENV = { hunter: 'HUNTER_API_KEY', apollo: 'APOLLO_API_KEY', prospeo: 'PROSPEO_API_KEY' };
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-3)}` : null);

function providerKeys() {
  const out = {};
  for (const [p, env] of Object.entries(PROVIDER_ENV)) {
    const v = process.env[env] || q.getSetting.get(`key:${p}`)?.value;
    if (v) out[p] = v;
  }
  return out;
}

export const db = {
  async getPattern(d) { return q.getPattern.get(d) || null; },
  async savePattern(d, pattern, confidence, source) { q.savePattern.run(d, pattern, confidence, source); },
  async saveLookup(r) {
    return Number(q.saveLookup.run(r.name || null, r.company || null, r.domain || null, r.linkedin || null,
      r.email || null, r.confidence ?? null, r.status || null, r.source || null, JSON.stringify(r.result || null)).lastInsertRowid);
  },
  async listLookups(n = 50) { return q.listLookups.all(n); },
  async providerKeys() { return providerKeys(); },
  async setProviderKey(p, key) { if (!PROVIDER_ENV[p]) throw new Error(`unknown provider ${p}`); key ? q.setSetting.run(`key:${p}`, key) : q.delSetting.run(`key:${p}`); },
  listProviderKeys: () => Object.keys(PROVIDER_ENV).map((p) => ({ provider: p, key: mask(providerKeys()[p]), source: process.env[PROVIDER_ENV[p]] ? 'env' : providerKeys()[p] ? 'stored' : null })),
  DATA_DIR,
};

configure({
  resolveMx: (domain) => dns.resolveMx(domain),
  smtp,
  sha256: async (s) => crypto.createHash('sha256').update(s).digest('hex'),
  md5: async (s) => crypto.createHash('md5').update(s).digest('hex'),
  storage: db,
});

export const port25 = () => port25State;
export { smtp };
