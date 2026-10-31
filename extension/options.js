import { store, PROVIDERS } from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function load() {
  const keys = await store.providerKeys();
  for (const p of PROVIDERS) $(p).value = keys[p] || '';
  const rows = await store.listLookups(30);
  $('history').innerHTML = rows.map((l) => `<tr><td>${esc(l.name)}</td><td class="mono">${esc(l.domain || '')}</td><td class="mono">${esc(l.email || '—')}</td><td>${esc(l.status || '')}${l.confidence != null ? ` · ${l.confidence}%` : ''}</td></tr>`).join('')
    || '<tr><td colspan="4">No lookups yet.</td></tr>';
}

$('save').onclick = async () => {
  for (const p of PROVIDERS) await store.setProviderKey(p, $(p).value.trim());
  $('saved').textContent = 'saved'; setTimeout(() => { $('saved').textContent = ''; }, 2000);
};
$('clear').onclick = async () => { await store.clearLookups(); load(); };
load();
