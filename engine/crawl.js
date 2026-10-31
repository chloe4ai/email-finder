// Crawl a company's own website for published email addresses (to learn
// the address pattern). Only touches the target domain; small page budget.

const SEED_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team', '/people', '/leadership', '/press', '/privacy', '/privacy-policy', '/legal', '/terms', '/imprint', '/impressum'];
const LINK_HINT = /about|team|contact|press|people|leadership|staff|company|legal|privacy|imprint/i;

export async function fetchText(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'follow', headers: { Accept: 'text/html,*/*' } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!/html|text|json|xml/.test(ct)) return null;
    return (await r.text()).slice(0, 1_500_000);
  } catch { return null; }
}

export function extractEmails(html, domain) {
  const out = new Set();
  const esc = domain.replace(/\./g, '\\.');
  const re = new RegExp(`[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)*${esc}`, 'gi');
  const decoded = html.replace(/&#64;|&commat;|%40/gi, '@').replace(/\s*\[at\]\s*|\s*\(at\)\s*/gi, '@').replace(/\s*\[dot\]\s*|\s*\(dot\)\s*/gi, '.');
  for (const m of decoded.match(re) || []) {
    const e = m.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e)) continue;
    if (/^[0-9a-f]{20,}@/.test(e)) continue; // tracking hashes
    out.add(e);
  }
  return [...out];
}

function extractLinks(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) continue;
      if (LINK_HINT.test(u.pathname)) out.add(u.origin + u.pathname);
    } catch {}
  }
  return [...out];
}

// Returns {emails: [...], pages_fetched, pages: {url: [emails]}, reachable}
export async function crawlEmails(domain, { maxPages = 12, concurrency = 4 } = {}) {
  const bases = [`https://${domain}`, `https://www.${domain}`];
  let base = null;
  let home = null;
  for (const b of bases) {
    home = await fetchText(b + '/');
    if (home) { base = b; break; }
  }
  if (!base) return { emails: [], pages_fetched: 0, pages: {}, reachable: false };

  const queue = [...new Set([...SEED_PATHS.map((p) => base + p), ...extractLinks(home, base)])].slice(0, maxPages);
  const pages = {};
  const all = new Set(extractEmails(home, domain));
  pages[base + '/'] = [...all];
  let fetched = 1;

  const work = queue.filter((u) => u !== base + '/');
  async function worker() {
    while (work.length && fetched < maxPages) {
      const u = work.shift();
      const html = await fetchText(u);
      fetched += 1;
      if (!html) continue;
      const found = extractEmails(html, domain);
      if (found.length) pages[u] = found;
      found.forEach((e) => all.add(e));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { emails: [...all], pages_fetched: fetched, pages, reachable: true };
}
