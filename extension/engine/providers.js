// Optional paid data providers, bring-your-own-key. Each adapter returns
// {email, confidence(0-1), status, provider, raw} or null. All are skipped
// silently when no key is configured.


const T = (ms) => AbortSignal.timeout(ms);

const HUNTER_PATTERNS = {
  '{first}.{last}': 'first.last', '{first}': 'first', '{f}{last}': 'flast', '{first}{last}': 'firstlast',
  '{f}.{last}': 'f.last', '{first}_{last}': 'first_last', '{first}{l}': 'firstl', '{last}.{first}': 'last.first',
  '{last}{first}': 'lastfirst', '{last}': 'last', '{first}-{last}': 'first-last', '{l}{first}': 'lfirst', '{first}.{l}': 'first.l',
};

// Hunter returns a typed error when a domain owner asked them to stop processing it.
function hunterError(j, status) {
  const err = j.errors?.[0] || {};
  const e = new Error(err.details || `hunter ${status}`);
  e.code = err.id || null;
  e.optout = err.id === 'blacklisted_domain';
  return e;
}

const hunter = {
  name: 'hunter',
  needs: ['first', 'last', 'domain'],
  async find({ first, last, domain }, key) {
    const u = `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${key}`;
    const r = await fetch(u, { signal: T(12000) });
    const j = await r.json();
    if (!r.ok) throw hunterError(j, r.status);
    const d = j.data;
    if (!d?.email) return null;
    return { email: d.email, confidence: (d.score || 0) / 100, status: d.verification?.status || null, provider: 'hunter', raw: d };
  },
  // → {pattern, accept_all, results} ; pattern is our id or null
  async pattern(domain, key) {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&limit=1&api_key=${key}`, { signal: T(12000) });
    const j = await r.json();
    if (!r.ok) throw hunterError(j, r.status);
    const p = j.data?.pattern;
    return { pattern: p ? (HUNTER_PATTERNS[p] || null) : null, accept_all: !!j.data?.accept_all, results: j.meta?.results ?? 0 };
  },
  async verify(email, key) {
    const r = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${key}`, { signal: T(15000) });
    const j = await r.json();
    if (!r.ok) throw hunterError(j, r.status);
    return j.data ? { status: j.data.status, score: j.data.score, accept_all: j.data.accept_all, raw: { result: j.data.result, smtp_check: j.data.smtp_check } } : null;
  },
};

const apollo = {
  name: 'apollo',
  needs: ['any'],
  async find({ first, last, domain, company, linkedin }, key) {
    const body = { reveal_personal_emails: false };
    if (linkedin) body.linkedin_url = linkedin;
    if (first) body.first_name = first;
    if (last) body.last_name = last;
    if (domain) body.domain = domain;
    else if (company) body.organization_name = company;
    const r = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body), signal: T(15000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || j.message || `apollo ${r.status}`);
    const p = j.person;
    if (!p?.email) return null;
    return {
      email: p.email, confidence: p.email_status === 'verified' ? 0.95 : 0.7, status: p.email_status || null, provider: 'apollo',
      person: { name: p.name, title: p.title, company: p.organization?.name, domain: p.organization?.primary_domain, linkedin: p.linkedin_url },
      raw: { id: p.id },
    };
  },
};

const prospeo = {
  name: 'prospeo',
  needs: ['any'],
  async find({ first, last, domain, linkedin }, key) {
    let url; let body;
    if (linkedin) { url = 'https://api.prospeo.io/linkedin-email-finder'; body = { url: linkedin }; }
    else if (first && last && domain) { url = 'https://api.prospeo.io/email-finder'; body = { first_name: first, last_name: last, company: domain }; }
    else return null;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KEY': key }, body: JSON.stringify(body), signal: T(15000) });
    const j = await r.json();
    if (j.error) return null;
    const e = j.response?.email?.email || j.response?.email;
    if (!e) return null;
    const st = j.response?.email?.email_status || j.response?.email_status || null;
    return { email: e, confidence: st === 'VALID' ? 0.95 : 0.7, status: st, provider: 'prospeo', raw: { status: st } };
  },
};

const ADAPTERS = { apollo, hunter, prospeo }; // waterfall order

// Try configured providers in order; first hit wins. Returns {hit, attempts}
async function runProviders(input, keys = {}) {
  const attempts = [];
  for (const [name, a] of Object.entries(ADAPTERS)) {
    const key = keys[name];
    if (!key) continue;
    if (a.needs[0] !== 'any' && !a.needs.every((k) => input[k])) { attempts.push({ provider: name, skipped: 'missing input' }); continue; }
    try {
      const hit = await a.find(input, key);
      attempts.push({ provider: name, hit: !!hit });
      if (hit) return { hit, attempts };
    } catch (e) {
      attempts.push({ provider: name, hit: false, error: e.message, optout: !!e.optout });
      if (e.optout) return { hit: null, attempts, optout: true }; // the domain owner opted out — stop asking providers
    }
  }
  return { hit: null, attempts };
}

export { ADAPTERS, runProviders, hunter };
