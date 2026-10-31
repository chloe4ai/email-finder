// Local web UI + JSON API for the email finder.  node server.js → http://localhost:4790
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './src/node-platform.js';
import { findEmail, verifyEmail, findMany } from './engine/finder.js';


const PORT = process.env.PORT || 4790;
const WEB = path.join(import.meta.dirname, 'web');

const routes = {
  'POST /api/find': (b) => findEmail({ name: b.name, first: b.first, last: b.last, company: b.company, domain: b.domain, linkedin: b.linkedin }, { verifyTop: b.verify_top || 4, crawl: b.crawl !== false, keys: b.free ? {} : undefined }),
  'POST /api/batch': (b) => findMany((b.contacts || []).slice(0, 200), { concurrency: 2 }),
  'POST /api/verify': (b) => verifyEmail(String(b.email || '')),
  'GET /api/history': async () => ({ lookups: await db.listLookups(100) }),
  'GET /api/keys': () => ({ keys: db.listProviderKeys() }),
  'POST /api/keys': async (b) => { await db.setProviderKey(b.provider, b.key || null); return { keys: db.listProviderKeys() }; },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  // the Chrome extension calls this from a chrome-extension:// origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
}).listen(PORT, () => console.log(`\n  email-finder → http://localhost:${PORT}\n  data: ${db.DATA_DIR}\n`));
