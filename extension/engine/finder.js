// Orchestrator: name + company (or LinkedIn URL) → ranked, verified work emails.
//
//   1. resolve the person (name from LinkedIn slug if needed) and the company domain
//   2. paid providers first if you configured keys (Apollo → Hunter → Prospeo)
//   3. otherwise learn the domain's address pattern: crawl the company site,
//      reuse patterns learned earlier, ask Hunter's pattern endpoint if keyed
//   4. generate candidates, rank by evidence, verify the top ones
//      (SMTP RCPT / catch-all where available, Microsoft 365 existence, Gravatar)
//
// Runs on any platform configured through ./platform.js (Node, Chrome extension).
import * as P from './patterns.js';
import * as D from './domain.js';
import { crawlEmails } from './crawl.js';
import * as V from './verify.js';
import { runProviders, hunter } from './providers.js';
import { platform } from './platform.js';

const pct = (x) => Math.max(0, Math.min(99, Math.round(x * 100)));

export async function findEmail(input, opts = {}) {
  const t0 = Date.now();
  const steps = [];
  const log = (s) => { steps.push(s); if (opts.onStep) { try { opts.onStep(s); } catch {} } };
  const verifyTop = opts.verifyTop ?? 4;
  const store = platform.storage;
  const keys = { ...(opts.keys || await store.providerKeys()) };
  // a rejected key (401/403) fails the same way on every call — stop spending requests on it
  const dropHunter = (e) => { if (keys.hunter && (e.status === 401 || e.status === 403)) { delete keys.hunter; log('· hunter key rejected — skipping Hunter for the rest of this lookup'); } };

  // ── 1. who & where ─────────────────────────────────────────────────
  let name = input.name || (input.first ? `${input.first} ${input.last || ''}`.trim() : null);
  if (!name && input.linkedin) {
    name = P.nameFromLinkedin(input.linkedin);
    if (name) name = name.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    if (name) log(`→ name guessed from LinkedIn slug: "${name}" (check this)`);
  }
  const person = name ? P.splitName(name) : { first: '', last: '' };
  if (P.hasCJK(name || '')) log('! name contains CJK characters — need the romanised (pinyin) name to build an address');

  const dom = await D.resolveDomain(input.domain || input.company || '');
  let domain = dom.domain;
  if (domain) log(`→ company → ${domain} (${dom.how})`);
  else if (input.company) log(`✗ could not resolve "${input.company}" to a domain`);

  const base = { name, first: person.first, last: person.last, company: dom.company || input.company || null, domain, linkedin: input.linkedin || null, steps };

  // ── 2. paid providers (BYOK) ───────────────────────────────────────
  const prov = await runProviders({ ...person, domain, company: base.company, linkedin: input.linkedin }, keys);
  for (const a of prov.attempts) log(a.skipped ? `· ${a.provider}: skipped (${a.skipped})` : a.hit ? `✓ ${a.provider}: match` : a.optout ? `✗ ${a.provider}: ${domain || 'this domain'} opted out — its owner asked the provider to stop processing addresses on it` : `✗ ${a.provider}: no match${a.error ? ` (${a.error})` : ''}`);
  base.domain_optout = !!prov.optout;
  if (prov.attempts.some((a) => a.provider === 'hunter' && a.auth)) dropHunter({ status: 401 });
  if (prov.hit) {
    const e = prov.hit.email.toLowerCase();
    const [local, hitDomain] = e.split('@');
    if (!domain) domain = hitDomain;
    // MX / Microsoft 365 checks belong to the address's own domain, which can differ from the input
    // (person moved jobs, subsidiary, alias domain)
    const mx = await D.getMx(hitDomain);
    const mxProvider = D.providerFromMx(mx);
    const sig = await verifySignals(e, mx, mxProvider);
    if (prov.hit.status) sig.provider = { name: prov.hit.provider, status: prov.hit.status };
    const conf = applySignals(prov.hit.confidence, sig);
    const pat = P.patternsForLocal(local, person)[0];
    if (hitDomain !== domain) log(`· ${prov.hit.provider} returned an address on ${hitDomain}, not ${domain} — not learning a pattern for ${domain} from it`);
    else if (pat) await store.savePattern(domain, pat, conf, prov.hit.provider);
    const cand = { email: e, confidence: pct(conf), pattern: pat || null, status: statusOf(sig, conf), source: prov.hit.provider, signals: sig };
    return finish({ ...base, domain, best: cand, candidates: [cand], mx_provider: mxProvider, person: prov.hit.person || null }, t0);
  }

  if (!domain || !person.first) {
    log('✗ need at least a first name and a company/domain for the pattern engine');
    return finish({ ...base, best: null, candidates: [], mx_provider: null }, t0);
  }

  // ── 3. learn the domain's pattern ──────────────────────────────────
  const mx = await D.getMx(domain);
  const mxProvider = D.providerFromMx(mx);
  if (!mx.length) { log(`✗ ${domain} has no MX records — it does not receive mail`); return finish({ ...base, best: null, candidates: [], mx_provider: 'none' }, t0); }
  log(`→ mail hosted on ${mxProvider} (${mx[0]})`);

  const votes = {}; // pattern → weight
  const evidence = [];

  const learned = await store.getPattern(domain);
  if (learned) { votes[learned.pattern] = (votes[learned.pattern] || 0) + 2.5 * (learned.confidence || 0.5); evidence.push(`learned earlier: ${learned.pattern} (${learned.source})`); }

  let hunterAcceptAll = false;
  if (keys.hunter && !base.domain_optout) {
    try {
      const hp = await hunter.pattern(domain, keys.hunter);
      if (hp.pattern) { votes[hp.pattern] = (votes[hp.pattern] || 0) + 3; evidence.push(`hunter pattern: ${hp.pattern} (${hp.results} known addresses)`); }
      else log(`· hunter knows no addresses on ${domain}`);
      hunterAcceptAll = hp.accept_all;
      if (hunterAcceptAll) log('· hunter flags this domain as accept-all (catch-all)');
    } catch (e) { log(`· hunter pattern lookup failed: ${e.message}`); dropHunter(e); }
  }

  let crawl = { emails: [], pages_fetched: 0, reachable: false };
  if (opts.crawl !== false) {
    crawl = await crawlEmails(domain, { maxPages: opts.maxPages || 12 });
    const personal = crawl.emails.filter((e) => !P.isGeneric(e));
    log(crawl.reachable ? `→ crawled ${crawl.pages_fetched} pages on ${domain}: ${crawl.emails.length} addresses (${personal.length} personal)` : `· ${domain} website unreachable`);
    const cv = P.inferFromEmails(personal);
    for (const [k, w] of Object.entries(cv)) votes[k] = (votes[k] || 0) + w;
    if (personal.length) evidence.push(`site examples: ${personal.slice(0, 3).join(', ')}`);
    // the person's own address may literally be on the site
    const direct = crawl.emails.find((e) => P.patternsForLocal(e.split('@')[0], person).length);
    if (direct) { votes.__direct = direct; evidence.push(`found on site: ${direct}`); }
  }

  // ── 4. candidates → rank → verify ──────────────────────────────────
  let cands = P.candidates(person.first, person.last, domain).map((c) => {
    let s = c.prior;
    if (votes[c.pattern]) s += Math.min(0.6, 0.22 * votes[c.pattern]);
    if (votes.__direct && votes.__direct === c.email) s += 1;
    return { ...c, score: s, signals: {} };
  });
  const total = cands.reduce((a, c) => a + c.score, 0) || 1;
  cands = cands.map((c) => ({ ...c, confidence: c.score / total })).sort((a, b) => b.confidence - a.confidence);
  if (votes.__direct) cands = cands.map((c) => c.email === votes.__direct ? { ...c, confidence: Math.max(c.confidence, 0.9) } : c);
  log(`→ ${cands.length} candidates, top: ${cands.slice(0, 3).map((c) => c.email).join(' · ')}`);

  let verified = 0;
  if (opts.verify !== false) {
    // Microsoft 365 existence checks are cheap HTTP calls, so probe every candidate there.
    const probeN = mxProvider === 'microsoft_365' ? cands.length : verifyTop;
    for (const c of cands.slice(0, probeN)) {
      c.signals = await verifySignals(c.email, mx, mxProvider);
      // SMTP inconclusive (blocked, or not available here) → spend 0.5 Hunter credit on the top few
      if (keys.hunter && !base.domain_optout && c.signals.smtp?.status === 'unknown' && c.signals.o365?.exists !== true && cands.indexOf(c) < 3) {
        try { c.signals.hunter = await hunter.verify(c.email, keys.hunter); } catch (e) { c.signals.hunter = { error: e.optout ? 'domain opted out' : e.message, optout: !!e.optout }; if (e.optout) { base.domain_optout = true; log(`✗ ${domain} opted out: its owner asked Hunter to stop processing addresses on this domain`); } dropHunter(e); }
      }
      c.confidence = applySignals(c.confidence, c.signals);
      verified += 1;
      const s = c.signals;
      log(`· ${c.email}: smtp=${s.smtp?.status || '-'}${s.o365 ? ` m365=${s.o365.exists === null ? '?' : s.o365.exists}` : ''}${s.hunter ? ` hunter=${s.hunter.status || s.hunter.error}` : ''}${s.gravatar === true ? ' gravatar=yes' : ''}`);
      if (s.smtp?.status === 'valid' || s.o365?.exists === true || s.hunter?.status === 'valid') break; // found it
      if (s.hunter?.status === 'accept_all') { log('· hunter: domain is accept-all, mailbox existence cannot be confirmed'); break; }
      if (s.smtp?.status === 'catch_all') { log('· domain is catch-all: SMTP cannot distinguish addresses'); break; }
      if (s.smtp?.status === 'unknown' && mxProvider !== 'microsoft_365' && !keys.hunter) { log(`· ${s.smtp.port25 === 'n/a' ? 'no SMTP probing in the browser' : 'port 25 blocked here'}, so ranking stays pattern-based (add a Hunter/Apollo key for verified results)`); break; }
    }
    cands.sort((a, b) => b.confidence - a.confidence);
  }
  if (evidence.length) log(`→ evidence: ${evidence.join('; ')}`);

  let best = cands[0];
  if (best && best.confidence < 0.1 && verifiedStatus(best.signals) === 'invalid') { log('✗ every candidate was rejected by verification — this person probably has no mailbox on this domain'); best = null; }
  const result = {
    ...base, domain, mx_provider: mxProvider,
    best: best ? { email: best.email, confidence: pct(best.confidence), status: statusOf(best.signals, best.confidence), pattern: best.pattern, source: 'pattern-engine', signals: best.signals } : null,
    candidates: cands.map((c) => ({ email: c.email, pattern: c.pattern, confidence: pct(c.confidence), status: verifiedStatus(c.signals), signals: c.signals })),
    crawl: { pages: crawl.pages_fetched, emails_found: crawl.emails.length, examples: crawl.emails.slice(0, 8) },
    verified_count: verified,
  };
  if (best && (best.signals.smtp?.status === 'valid' || best.signals.o365?.exists === true || votes.__direct === best.email)) await store.savePattern(domain, best.pattern, best.confidence, 'verified');
  return finish(result, t0);
}

async function verifySignals(email, mx, mxProvider) {
  const sig = {};
  const [smtp, gravatar, o365] = await Promise.all([
    V.checkSmtp(email, mx),
    V.checkGravatar(email),
    mxProvider === 'microsoft_365' ? V.checkO365(email) : Promise.resolve(null),
  ]);
  sig.smtp = smtp; sig.gravatar = gravatar; if (o365) sig.o365 = o365;
  return sig;
}

function applySignals(conf, s) {
  if (s.smtp?.status === 'invalid') return 0.02;
  if (s.hunter?.status === 'invalid') return 0.02;
  if (s.hunter?.status === 'valid') conf = Math.max(conf, 0.96);
  if (s.provider?.status === 'valid') conf = Math.max(conf, 0.95);
  if (s.hunter?.status === 'accept_all') conf = Math.min(Math.max(conf, 0.5), 0.65);
  if (s.o365 && s.o365.exists === false) return Math.min(conf, 0.05);
  if (s.smtp?.status === 'valid') conf = Math.max(conf, 0.95);
  if (s.o365?.exists === true) conf = Math.max(conf, 0.93);
  if (s.gravatar === true) conf = Math.max(conf, 0.85);
  if (s.smtp?.status === 'catch_all') conf = Math.min(conf, 0.65);
  return conf;
}

function verifiedStatus(s) {
  if (!s || !Object.keys(s).length) return 'unverified';
  if (s.smtp?.status === 'valid' || s.o365?.exists === true || s.hunter?.status === 'valid') return 'valid';
  if (s.smtp?.status === 'invalid' || s.o365?.exists === false || s.hunter?.status === 'invalid') return 'invalid';
  if (s.provider?.status === 'valid') return 'valid'; // the provider verified it (Apollo / Prospeo / Hunter finder)
  if (s.smtp?.status === 'catch_all' || s.hunter?.status === 'accept_all' || s.provider?.status === 'accept_all') return 'catch_all';
  if (s.gravatar === true) return 'likely';
  return 'unknown';
}
function statusOf(s, conf) { const v = verifiedStatus(s); return v === 'unknown' || v === 'unverified' ? (conf >= 0.5 ? 'likely' : 'guess') : v; }

async function finish(r, t0) {
  r.ms = Date.now() - t0;
  r.id = await platform.storage.saveLookup({ name: r.name, company: r.company, domain: r.domain, linkedin: r.linkedin, email: r.best?.email, confidence: r.best?.confidence, status: r.best?.status, source: r.best?.source, result: { candidates: r.candidates, steps: r.steps } });
  return r;
}

export async function verifyEmail(email, opts = {}) {
  if (!V.syntaxOk(email)) return { email, status: 'invalid', reason: 'bad syntax' };
  const domain = email.split('@')[1];
  const mx = await D.getMx(domain);
  if (!mx.length) return { email, status: 'invalid', reason: 'domain has no MX', mx_provider: 'none' };
  const mxProvider = D.providerFromMx(mx);
  const signals = await verifySignals(email, mx, mxProvider);
  const keys = opts.keys || await platform.storage.providerKeys();
  if (keys.hunter) { try { signals.hunter = await hunter.verify(email, keys.hunter); } catch (e) { signals.hunter = { error: e.message, optout: !!e.optout }; } }
  let status = verifiedStatus(signals);
  if (signals.hunter?.status) status = { valid: 'valid', invalid: 'invalid', accept_all: 'catch_all', webmail: 'valid', disposable: 'invalid' }[signals.hunter.status] || status;
  return { email, status, mx_provider: mxProvider, signals };
}

export async function findMany(rows, opts = {}) {
  const concurrency = opts.concurrency || 2;
  const out = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) { const k = i++; try { out[k] = await findEmail(rows[k], opts); } catch (e) { out[k] = { ...rows[k], error: e.message, best: null, candidates: [], steps: [] }; } if (opts.onRow) opts.onRow(k, out[k]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return out;
}
