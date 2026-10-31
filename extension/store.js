// chrome.storage.local adapter for the engine's storage interface.
// Keys, learned patterns and lookup history never leave the browser.
const get = async (k, dflt) => (await chrome.storage.local.get(k))[k] ?? dflt;
const set = (k, v) => chrome.storage.local.set({ [k]: v });

export const PROVIDERS = ['hunter', 'apollo', 'prospeo'];
const MAX_LOOKUPS = 100;

export const store = {
  async getPattern(domain) { return (await get('patterns', {}))[domain] || null; },
  async savePattern(domain, pattern, confidence, source) {
    const all = await get('patterns', {});
    const cur = all[domain];
    if (cur && confidence < cur.confidence) return;
    all[domain] = { domain, pattern, confidence, source, updated_at: new Date().toISOString() };
    await set('patterns', all);
  },
  async saveLookup(r) {
    const list = await get('lookups', []);
    const id = (list[0]?.id || 0) + 1;
    list.unshift({ id, created_at: new Date().toISOString(), ...r });
    await set('lookups', list.slice(0, MAX_LOOKUPS));
    return id;
  },
  async listLookups(n = 50) { return (await get('lookups', [])).slice(0, n); },
  async clearLookups() { await set('lookups', []); },
  async providerKeys() {
    const keys = await get('keys', {});
    return Object.fromEntries(Object.entries(keys).filter(([p, k]) => PROVIDERS.includes(p) && k));
  },
  async setProviderKey(provider, key) {
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);
    const keys = await get('keys', {});
    if (key) keys[provider] = key; else delete keys[provider];
    await set('keys', keys);
  },
};
