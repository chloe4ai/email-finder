// Local web UI + JSON API for the email finder.  node server.js → http://localhost:4790
//
// Listens on 127.0.0.1 only (set HOST to change it). The API can spend provider
// credits and returns lookup history, so only same-origin pages and the Chrome
// extension may call it: requests from any other website's origin are refused.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './src/node-platform.js';
import { findEmail, verifyEmail, findMany } from './engine/finder.js';


const PORT = process.env.PORT || 4790;
const HOST = process.env.HOST || '127.0.0.1';
const WEB = path.join(import.meta.dirname, 'web');
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i;

const routes = {
  'POST /api/find': (b) => findEmail({ name: b.name, first: b.first, last: b.last, company: b.company, domain: b.domain, linkedin: b.linkedin }, { verifyTop: b.verify_top || 4, crawl: b.crawl !== false, keys: b.free ? {} : undefined }),
  'POST /api/batch': (b) => findMany((b.contacts || []).slice(0, 200), { concurrency: 2 }),
  'POST /api/verify': (b) => verifyEmail(String(b.email || '')),
  'GET /api/history': async () => ({ lookups: await db.listLookups(100) }),
  'GET /api/keys': () => ({ keys: db.listProviderKeys() }),
  'POST /api/keys': async (b) => { await db.setProviderKey(b.provider, b.key || null); return { keys: db.listProviderKeys() }; },
};

const hostname = (host) => String(host || '').replace(/:\d+$/, '');

// Same origin as the page this server serves, or the Chrome extension.
export function originAllowed(origin, host) {
  if (!origin) return true; // curl, the CLI, same-origin GETs
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return origin === `http://${host}`;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  const origin = req.headers.origin;
  // DNS rebinding: while bound to loopback, only answer for loopback host names
  if (LOOPBACK.test(HOST) && !LOOPBACK.test(hostname(req.headers.host))) { res.writeHead(403); return res.end('forbidden host'); }
  if (origin && !originAllowed(origin, req.headers.host)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"origin not allowed"}'); }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (routes[key]) {
    let body = {};
    if (req.method === 'POST') { const chunks = []; for await (const ch of req) chunks.push(ch); try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); } }
    try { const out = await routes[key](body); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out)); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  const file = path.join(WEB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' }); return res.end(fs.readFileSync(file)); }
  res.writeHead(404); res.end('not found');
}

export const server = http.createServer(handle);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`\n  email-finder → http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}\n  data: ${db.DATA_DIR}\n`));
}
