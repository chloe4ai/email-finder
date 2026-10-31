// Name normalisation + email-pattern generation / inference.


// Pattern id → builder. Priors are rough industry base rates for B2B domains.
const PATTERNS = [
  { id: 'first.last', prior: 0.40, build: (f, l) => `${f}.${l}` },
  { id: 'first', prior: 0.18, build: (f) => f },
  { id: 'flast', prior: 0.14, build: (f, l) => `${f[0]}${l}` },
  { id: 'firstlast', prior: 0.10, build: (f, l) => `${f}${l}` },
  { id: 'f.last', prior: 0.05, build: (f, l) => `${f[0]}.${l}` },
  { id: 'first_last', prior: 0.04, build: (f, l) => `${f}_${l}` },
  { id: 'firstl', prior: 0.03, build: (f, l) => `${f}${l[0]}` },
  { id: 'last.first', prior: 0.02, build: (f, l) => `${l}.${f}` },
  { id: 'lastfirst', prior: 0.015, build: (f, l) => `${l}${f}` },
  { id: 'last', prior: 0.01, build: (f, l) => l },
  { id: 'first-last', prior: 0.01, build: (f, l) => `${f}-${l}` },
  { id: 'lfirst', prior: 0.01, build: (f, l) => `${l[0]}${f}` },
  { id: 'first.l', prior: 0.005, build: (f, l) => `${f}.${l[0]}` },
];

function clean(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase().replace(/[^a-z]/g, '');
}

function hasCJK(s) {
  return /[㐀-鿿]/.test(String(s || ''));
}

// "Jane Doe" | "Doe, Jane" | "Dr. Jane A. Doe" → {first, last, middle}
function splitName(full) {
  let s = String(full || '').trim().replace(/\s+/g, ' ');
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    s = `${first} ${last}`;
  }
  const parts = s.split(' ').filter((p) => !/^(dr|mr|mrs|ms|prof|phd|jr|sr|ii|iii|md|mba)\.?$/i.test(p));
  if (parts.length === 0) return { first: '', last: '', middle: '' };
  if (parts.length === 1) return { first: clean(parts[0]), last: '', middle: '' };
  return {
    first: clean(parts[0]),
    last: clean(parts[parts.length - 1]),
    middle: parts.slice(1, -1).map(clean).join(''),
  };
}

// linkedin.com/in/jane2doe → "jane doe"; /in/eric-glyman-1a2b → "eric glyman"
function nameFromLinkedin(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug = decodeURIComponent(m[1]).toLowerCase();
  slug = slug.replace(/-[0-9a-f]{6,}$/g, ''); // trailing hash LinkedIn adds for dup names
  const tokens = slug.split(/[^a-z]+/).filter(Boolean);
  if (tokens.length >= 2) return `${tokens[0]} ${tokens[tokens.length - 1]}`;
  return tokens[0] || null;
}

function candidates(first, last, domain) {
  first = clean(first); last = clean(last);
  const out = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    if (!last && !['first'].includes(p.id)) continue;
    if (!first) continue;
    const local = p.build(first, last);
    if (!local || seen.has(local)) continue;
    seen.add(local);
    out.push({ email: `${local}@${domain}`, pattern: p.id, prior: p.prior });
  }
  return out;
}

// Given an observed local part, which patterns could have produced it?
// With a known name we match exactly; without, we use the shape.
function patternsForLocal(local, name) {
  local = String(local).toLowerCase();
  if (name && name.first) {
    return PATTERNS.filter((p) => p.build(name.first, name.last || '') === local).map((p) => p.id);
  }
  const votes = [];
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) votes.push('first.last');
  else if (/^[a-z]\.[a-z]{2,}$/.test(local)) votes.push('f.last');
  else if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) votes.push('first_last');
  else if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) votes.push('first-last');
  else if (/^[a-z]{3,8}$/.test(local)) votes.push('first', 'flast');
  else if (/^[a-z]{9,}$/.test(local)) votes.push('firstlast', 'flast');
  return votes;
}

const GENERIC = /^(info|contact|hello|hi|support|help|sales|press|media|pr|jobs|careers|hr|legal|privacy|security|abuse|admin|webmaster|team|office|billing|marketing|partners|partnerships|noreply|no-reply|newsletter|dpo|compliance|investors|ir|accounts|finance|enquiries|inquiries|general|mail|email|news|feedback|recruiting|talent|ops|dev|api|postmaster|ccpa|gdpr|dsar|trust|secure|sec|events|community|studio|store|shop|orders|returns|customerservice|customer|service|unsubscribe|do-not-reply|donotreply|bounce|mailer-daemon)$/i;

function isGeneric(email) {
  return GENERIC.test(String(email).split('@')[0]);
}

// Turn a list of observed emails at a domain into pattern votes {pattern: weight}
function inferFromEmails(emails, knownNames = {}) {
  const votes = {};
  for (const e of emails) {
    const [local] = String(e).toLowerCase().split('@');
    if (isGeneric(e)) continue;
    const ids = patternsForLocal(local, knownNames[e]);
    const w = knownNames[e] ? 1 : 1 / Math.max(1, ids.length);
    for (const id of ids) votes[id] = (votes[id] || 0) + w;
  }
  return votes;
}

export { PATTERNS, clean, hasCJK, splitName, nameFromLinkedin, candidates, patternsForLocal, isGeneric, inferFromEmails };
