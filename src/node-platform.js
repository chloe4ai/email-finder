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
let port25State = 'unknown'; // 'open' | 'blocked' — remembered per process

function smtpSession(host, lines, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = net.connect(25, host);
    const replies = [];
    let buf = '';
    let i = 0;
    let done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve({ replies, err }); };
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('error', (e) => finish(e.code || e.message));
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

async function smtp(email, mxHosts, { probeCatchAll = true } = {}) {
  if (port25State === 'blocked') return { status: 'unknown', reason: 'outbound port 25 blocked on this network', port25: 'blocked' };
  const domain = email.split('@')[1];
  const helo = 'verify.local';
  const cmds = [`EHLO ${helo}`, `MAIL FROM:<probe@${helo}>`, `RCPT TO:<${email}>`];
  if (probeCatchAll) cmds.push(`RCPT TO:<${randomLocal()}@${domain}>`);
  cmds.push('QUIT');

  for (const host of mxHosts.slice(0, 2)) {
    const { replies, err } = await smtpSession(host, cmds);
    if (err === 'timeout' && replies.length === 0) { port25State = 'blocked'; return { status: 'unknown', reason: 'port 25 timeout (blocked by ISP/firewall?)', port25: 'blocked' }; }
    if (err && replies.length === 0) continue; // try next MX
    port25State = 'open';
    const rcpt = replies[3]; const rnd = replies[4];
    if (!rcpt) return { status: 'unknown', reason: `server closed early: ${replies.at(-1) || err}`, port25: 'open' };
    const code = Number(rcpt.slice(0, 3));
    if (code >= 500) return { status: 'invalid', reason: rcpt, port25: 'open' };
    if (code >= 400) return { status: 'unknown', reason: `greylisted/temporary: ${rcpt}`, port25: 'open' };
    if (probeCatchAll && rnd && Number(rnd.slice(0, 3)) < 300) return { status: 'catch_all', reason: 'random mailbox also accepted', port25: 'open' };
    return { status: 'valid', reason: rcpt, port25: 'open' };
  }
  return { status: 'unknown', reason: 'all MX hosts unreachable', port25: port25State };
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
