#!/usr/bin/env node
// email-finder CLI
//   find "Jane Doe" acme.com
//   find --linkedin https://linkedin.com/in/jane-doe --company "Acme Inc"
//   find --csv contacts.csv --out results.csv      (columns: name, company, linkedin)
//   find verify someone@acme.com
//   find keys [set hunter|apollo|prospeo <key> | unset <provider>]
//   find history
//   --free on any lookup skips the paid providers (no credits spent)
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/node-platform.js';
import { findEmail, verifyEmail, findMany } from '../engine/finder.js';


const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const mark = { valid: c.g('✓'), likely: c.g('~'), catch_all: c.y('≈'), unknown: c.y('?'), unverified: c.d('·'), invalid: c.r('✗'), guess: c.d('?') };

function parse(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) flags[k] = true; else { flags[k] = v; i += 1; } }
    else pos.push(argv[i]);
  }
  return { flags, pos };
}

function printResult(r) {
  console.log(c.b(`\n  ${r.name || '(no name)'} @ ${r.company || r.domain || '(no company)'}`) + (r.linkedin ? c.d(`  ${r.linkedin}`) : ''));
  for (const s of r.steps) console.log(c.d(`  ${s}`));
  if (r.error) return console.log(c.r(`  error: ${r.error}\n`));
  if (!r.best) return console.log(c.r('\n  no email found\n'));
  console.log(`\n  ${mark[r.best.status] || '·'} ${c.b(r.best.email)}  ${r.best.confidence}%  ${c.d(`${r.best.status} · ${r.best.pattern || ''} · ${r.best.source}`)}`);
  const rest = r.candidates.slice(1, 5);
  for (const x of rest) console.log(c.d(`    ${mark[x.status] || '·'} ${x.email.padEnd(36)} ${String(x.confidence).padStart(2)}%  ${x.pattern}`));
  console.log(c.d(`\n  ${r.ms} ms · saved as lookup #${r.id}\n`));
}

function csvParse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (l) => { const out = []; let cur = ''; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => { const v = split(l); const o = {}; head.forEach((h, i) => { o[h] = v[i] || ''; }); return o; });
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

(async () => {
  const { flags, pos } = parse(process.argv.slice(2));
  const cmd = pos[0];

  if (cmd === 'verify') { const r = await verifyEmail(pos[1]); console.log(`\n  ${mark[r.status] || '·'} ${c.b(r.email)} → ${r.status}  ${c.d(JSON.stringify(r.signals || r.reason))}\n`); return; }
  if (cmd === 'keys') {
    if (pos[1] === 'set') { await db.setProviderKey(pos[2], pos[3]); console.log(c.g(`  ✓ ${pos[2]} key stored in ${db.DATA_DIR}`)); }
    if (pos[1] === 'unset') { await db.setProviderKey(pos[2], null); console.log(`  ✓ ${pos[2]} key removed`); }
    for (const k of db.listProviderKeys()) console.log(`  ${k.provider.padEnd(8)} ${k.key ? c.g(k.key) + c.d(` (${k.source})`) : c.d('not set')}`);
    return;
  }
  if (cmd === 'history') { for (const l of await db.listLookups(Number(flags.n) || 30)) console.log(`  ${String(l.id).padStart(4)}  ${(l.name || '').padEnd(22)} ${(l.domain || '').padEnd(22)} ${(l.email || '—').padEnd(34)} ${l.confidence ?? ''}%  ${l.status || ''}  ${c.d(l.created_at)}`); return; }

  if (flags.csv) {
    const rows = csvParse(fs.readFileSync(flags.csv, 'utf8'));
    console.log(c.d(`\n  ${rows.length} contacts from ${flags.csv}\n`));
    const results = await findMany(rows, { concurrency: Number(flags.concurrency) || 2, onRow: (i, r) => console.log(`  ${r.best ? mark[r.best.status] : c.r('✗')} ${(r.name || '').padEnd(24)} ${(r.best?.email || '—').padEnd(36)} ${r.best ? r.best.confidence + '%' : ''} ${c.d(r.best?.status || r.error || 'not found')}`) });
    const out = flags.out || flags.csv.replace(/\.csv$/i, '') + '.results.csv';
    const cols = ['name', 'company', 'domain', 'linkedin', 'email', 'confidence', 'status', 'pattern', 'source', 'alternatives'];
    fs.writeFileSync(out, cols.join(',') + '\n' + results.map((r) => cols.map((k) => csvCell(
      k === 'email' ? r.best?.email : k === 'confidence' ? r.best?.confidence : k === 'status' ? r.best?.status : k === 'pattern' ? r.best?.pattern : k === 'source' ? r.best?.source
      : k === 'alternatives' ? (r.candidates || []).slice(1, 4).map((x) => `${x.email} (${x.confidence}%)`).join(' | ') : r[k])).join(',')).join('\n') + '\n');
    console.log(c.d(`\n  → ${path.resolve(out)}\n`));
    return;
  }

  const input = { name: flags.name || (cmd && !cmd.includes('linkedin.com') ? cmd : undefined), company: flags.company || flags.domain || pos[1], linkedin: flags.linkedin || (cmd?.includes('linkedin.com') ? cmd : undefined) };
  if (!input.name && !input.linkedin) {
    console.log(`\n  ${c.b('find')} "First Last" company-or-domain\n  ${c.b('find')} --linkedin <url> --company <name|domain>\n  ${c.b('find')} --csv contacts.csv [--out results.csv]\n  ${c.b('find')} verify <email> · keys [set <provider> <key>] · history\n`);
    return;
  }
  printResult(await findEmail(input, { verifyTop: Number(flags['verify-top']) || 4, crawl: !flags['no-crawl'], keys: flags.free ? {} : undefined }));
})().catch((e) => { console.error(c.r(`\n  error: ${e.message}\n`)); process.exit(1); });
