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

// Letters NFD can't decompose into "base + accent" — map them by hand.
const TRANSLIT = {
  ø: 'o', Ø: 'o', ł: 'l', Ł: 'l', ß: 'ss', ẞ: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th', ı: 'i', ħ: 'h', Ħ: 'h', ŧ: 't', Ŧ: 't',
};
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLIT).join('')}]`, 'g');

function clean(s) {
  return String(s || '')
    .replace(TRANSLIT_RE, (c) => TRANSLIT[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase().replace(/[^a-z]/g, '');
}

function hasCJK(s) {
  return /[㐀-鿿]/.test(String(s || ''));
}

// Honorifics, generational suffixes and post-nominal credentials (compared without dots).
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const CREDENTIALS = new Set([
  'phd', 'md', 'mba', 'pmp', 'cpa', 'pe', 'cfa', 'cfp', 'esq', 'jd', 'dds', 'dmd', 'do', 'rn', 'np', 'pa',
  'msc', 'bsc', 'mph', 'mpa', 'mfa', 'llm', 'edd', 'psyd', 'cissp', 'cism', 'cisa', 'shrmcp', 'shrmscp',
  'phr', 'sphr', 'csm', 'cma', 'cpcu', 'faia', 'aia', 'leedap', 'pmiacp', 'frm', 'caia', 'acca', 'cima',
]);
const bare = (w) => w.replace(/[.\-]/g, '').toLowerCase();
const isSuffixWord = (w) => SUFFIXES.has(bare(w)) || CREDENTIALS.has(bare(w));

// "MBA" / "Ph.D." / "CISSP, CISM" / "Jr." → true. All-caps words count as
// credentials too, unless the whole name was typed in capitals ("DOE, JANE").
function isCredentialPart(part, allCaps) {
  const words = part.split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => isSuffixWord(w) || (!allCaps && /^[A-Z][A-Z0-9.&\-]{1,9}$/.test(w)));
}

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;

// "Jane Doe" | "Doe, Jane" | "Dr. Jane A. Doe" | "Jane Doe, PMP" | "Jane Doe (She/Her) 🚀"
// | "Jane Doe - Senior Engineer - Acme" → {first, last, middle}
function splitName(full) {
  let s = String(full || '')
    .replace(EMOJI, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]|"[^"]*"|“[^”]*”/g, ' ') // pronouns, nicknames
    .replace(/\s+/g, ' ').trim();
  s = s.split(/ [-–—|•·] /)[0].trim(); // "Jane Doe - Title - Company" / "Jane Doe | Title"
  if (s.includes(',')) {
    const allCaps = !/[a-z]/.test(s);
    const segs = s.split(',').map((x) => x.trim()).filter(Boolean);
    while (segs.length > 1 && isCredentialPart(segs[segs.length - 1], allCaps)) segs.pop();
    s = segs.length > 1 ? `${segs.slice(1).join(' ')} ${segs[0]}` : (segs[0] || ''); // "Doe, Jane" → "Jane Doe"
  }
  const words = s.split(' ').filter((p) => clean(p));
  while (words.length > 1 && TITLES.has(bare(words[0]))) words.shift();
  while (words.length > 1 && isSuffixWord(words[words.length - 1])) words.pop();
  const parts = words;
  if (parts.length === 0) return { first: '', last: '', middle: '' };
  if (parts.length === 1) return { first: clean(parts[0]), last: '', middle: '' };
  return {
    first: clean(parts[0]),
    last: clean(parts[parts.length - 1]),
    middle: parts.slice(1, -1).map(clean).join(''),
  };
}

// decodeURIComponent that never throws: a malformed "%E0" is dropped, valid runs still decode.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch {
    return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return ''; } });
  }
}

// linkedin.com/in/jane2doe → "jane doe"; /in/eric-glyman-1a2b → "eric glyman";
// /in/jos%C3%A9-garc%C3%ADa → "jose garcia"; /in/jane-doe-mba → "jane doe"
function nameFromLinkedin(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug = safeDecode(m[1]).replace(TRANSLIT_RE, (c) => TRANSLIT[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // trailing id LinkedIn adds for duplicate names ("-1a2b3c4d", "-123456"); it always has a digit,
  // so real short surnames that happen to be hex ("decafe", "abbe") are kept
  slug = slug.replace(/-(?=[0-9a-z]*[0-9])[0-9a-z]{3,}$/, '');
  const tokens = slug.split(/[^a-z]+/).filter(Boolean);
  while (tokens.length > 2 && (SUFFIXES.has(tokens[tokens.length - 1]) || CREDENTIALS.has(tokens[tokens.length - 1]))) tokens.pop();
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
    if (!name.last) return name.first === local ? ['first'] : []; // other builders need a last name
    return PATTERNS.filter((p) => p.build(name.first, name.last) === local).map((p) => p.id);
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
