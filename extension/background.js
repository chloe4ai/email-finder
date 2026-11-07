// Service worker: runs the email-finder engine inside the browser. The popup
// sends {type:'find', input} and gets the result back; results are cached for
// an hour per profile so reopening the popup is instant, and a lookup that is
// still running when the popup closes keeps going and lands in the cache.
import { configure } from './engine/platform.js';
import { findEmail, verifyEmail } from './engine/finder.js';
import { store } from './store.js';

configure({ storage: store });

const CACHE_TTL = 60 * 60 * 1000;
const inflight = new Map(); // cache key → promise

// The company is part of the key: picking another company from the popup's "or:" list
// for the same profile must run a new lookup, not return the first company's result.
const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const cacheKey = (input) => `result:${norm(input.linkedin || input.name)}|${norm(input.domain || input.company)}`;

async function cached(key) {
  const hit = (await chrome.storage.session.get(key))[key];
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.result : null;
}

// Chrome stops an idle service worker after ~30 s; touching an extension API resets that clock.
const keepAlive = () => setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);

async function find(input, { force = false } = {}) {
  const key = cacheKey(input);
  if (!force) { const c = await cached(key); if (c) return { ...c, cached: true }; }
  if (inflight.has(key)) return inflight.get(key);
  const timer = keepAlive();
  const p = findEmail({ name: input.name, company: input.company, domain: input.domain, linkedin: input.linkedin }, { verifyTop: 4 })
    .then(async (result) => { await chrome.storage.session.set({ [key]: { at: Date.now(), result } }); return result; })
    .finally(() => { clearInterval(timer); inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

const handlers = {
  find: (m) => find(m.input, { force: !!m.force }),
  verify: (m) => verifyEmail(String(m.email || '')),
  keys: async () => Object.keys(await store.providerKeys()),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  h(msg).then((r) => reply(r), (e) => reply({ error: e.message || String(e) }));
  return true; // reply asynchronously
});

export { find, handlers, cacheKey };
