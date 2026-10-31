// Company name → domain, plus mail-provider fingerprinting via MX.
import { platform } from './platform.js';

export const looksLikeDomain = (s) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(s || '').trim());

export function normalizeDomain(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

export async function getMx(domain) {
  try {
    const mx = await platform.resolveMx(domain);
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  } catch { return []; }
}

export async function hasMx(domain) { return (await getMx(domain)).length > 0; }

export function providerFromMx(mx) {
  const s = mx.join(' ');
  if (/google|googlemail/.test(s)) return 'google_workspace';
  if (/outlook|microsoft|office365/.test(s)) return 'microsoft_365';
  if (/pphosted|proofpoint/.test(s)) return 'proofpoint';
  if (/mimecast/.test(s)) return 'mimecast';
  if (/barracuda/.test(s)) return 'barracuda';
  if (/zoho/.test(s)) return 'zoho';
  if (/protonmail|proton\.ch/.test(s)) return 'proton';
  if (/messagingengine|fastmail/.test(s)) return 'fastmail';
  return mx.length ? 'other' : 'none';
}

// Clearbit's public autocomplete needs no key. Returns [{name, domain}].
export async function suggestCompanies(query) {
  try {
    const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    return (await r.json()).map((x) => ({ name: x.name, domain: x.domain }));
  } catch { return []; }
}

const slug = (s) => String(s).toLowerCase().replace(/\b(inc|llc|ltd|corp|co|gmbh|sa|ag|plc|limited|company|corporation)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

// Resolve whatever the user typed (domain, URL, or company name) to a domain.
// Returns {domain, company, how, alternatives}
export async function resolveDomain(input) {
  const raw = String(input || '').trim();
  if (!raw) return { domain: null, company: null, how: 'none', alternatives: [] };
  const d = normalizeDomain(raw);
  if (looksLikeDomain(d)) return { domain: d, company: null, how: 'given', alternatives: [] };

  const sugg = await suggestCompanies(raw);
  const target = slug(raw);
  const exact = sugg.find((s) => slug(s.name) === target) || sugg.find((s) => slug(s.name).startsWith(target));
  if (exact) return { domain: exact.domain, company: exact.name, how: 'clearbit_autocomplete', alternatives: sugg.slice(0, 5) };
  if (sugg[0]) return { domain: sugg[0].domain, company: sugg[0].name, how: 'clearbit_autocomplete_fuzzy', alternatives: sugg.slice(0, 5) };

  const guess = `${target}.com`;
  if (await hasMx(guess)) return { domain: guess, company: raw, how: 'guess_dotcom_mx', alternatives: [] };
  return { domain: null, company: raw, how: 'unresolved', alternatives: [] };
}
