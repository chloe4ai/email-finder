const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg);
let linkedin = '';

async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/linkedin\.com\/in\//.test(tab.url || '')) return null;
  linkedin = tab.url.split('?')[0];
  // fallback if the page can't be read: "(3) Jane Doe | LinkedIn" → "Jane Doe"
  const fromTitle = { name: (tab.title || '').replace(/^\(\d+\)\s*/, '').split('|')[0].trim(), headline: '', companies: [] };
  const ask = () => chrome.tabs.sendMessage(tab.id, { type: 'scrape' });
  let s = null;
  try { s = await ask(); } catch {
    // page was open before the extension was installed or reloaded → inject the content script now
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); s = await ask(); } catch { s = null; }
  }
  if (!s || !s.name) return fromTitle.name && !/^linkedin$/i.test(fromTitle.name) ? fromTitle : null;
  return s;
}

function render(r) {
  if (r.error) return `<div class="err">${esc(r.error)}</div>`;
  if (!r.best) return `<div class="err">No email found.</div><div class="muted">${esc((r.steps || []).slice(-2).join(' '))}</div>`;
  const alts = (r.candidates || []).slice(1, 4).map((c) => `<div class="alt">${esc(c.email)} · ${c.confidence}%</div>`).join('');
  return `<div class="best"><span class="email">${esc(r.best.email)}</span><button class="copy" id="copy">copy</button><span class="pill ${esc(r.best.status)}">${esc(r.best.status)} · ${r.best.confidence}%</span></div>
    <div class="muted">${esc(r.best.pattern || '')} · ${esc(r.best.source)}${r.mx_provider ? ' · mail on ' + esc(r.mx_provider) : ''}${r.domain_optout ? ' · domain opted out of Hunter' : ''}${r.cached ? ' · <a id="rerun">re-run</a>' : ''}</div>${alts}`;
}

async function find(force = false) {
  const input = { name: $('name').value.trim(), company: $('company').value.trim(), linkedin };
  if (!input.name) return;
  $('go').disabled = true; $('out').innerHTML = '<div class="muted">looking up…</div>';
  try {
    const r = await send({ type: 'find', input, force });
    $('out').innerHTML = render(r);
    const c = $('copy'); if (c) c.onclick = () => { navigator.clipboard.writeText(r.best.email); c.textContent = 'copied'; };
    const rr = $('rerun'); if (rr) rr.onclick = () => find(true);
  } catch (e) {
    $('out').innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
  } finally { $('go').disabled = false; }
}

(async () => {
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
  const keys = await Promise.race([send({ type: 'keys' }), new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
  if (!Array.isArray(keys)) $('keyhint').innerHTML = '';
  else if (!keys.length) $('keyhint').innerHTML = 'Free signals only. <a id="addkey">Add a Hunter key</a> for verified results.';
  const ak = $('addkey'); if (ak) ak.onclick = () => chrome.runtime.openOptionsPage();

  const s = await scrapeActiveTab();
  if (s) {
    $('name').value = s.name || '';
    if (s.companies.length) {
      $('company').value = s.companies[0].company;
      if (s.companies.length > 1) $('pick').innerHTML = 'or: ' + s.companies.slice(1).map((c) => `<a data-c="${esc(c.company)}">${esc(c.company)}</a>`).join('');
      for (const a of $('pick').querySelectorAll('a')) a.onclick = () => { $('company').value = a.dataset.c; find(); };
    }
    if (s.name && s.companies.length) find();
    else { $('out').innerHTML = '<div class="muted">Couldn\'t read the company from this profile. Type it above and press Enter.</div>'; $('company').focus(); }
  } else {
    $('out').innerHTML = '<div class="muted">Open a LinkedIn profile (linkedin.com/in/…) and the fields fill in by themselves — or type them here.</div>';
  }
  $('go').onclick = () => find(true);
  for (const id of ['name', 'company']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') find(true); });
})();
