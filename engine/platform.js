// Platform adapters for the engine. The defaults run anywhere that has
// fetch + WebCrypto (a Chrome extension service worker, Node 22+):
//   • MX lookup over DNS-over-HTTPS
//   • sha256 via WebCrypto (md5 only where the host provides it)
//   • no SMTP probing (needs raw sockets — Node adds it)
//   • in-memory storage (Node swaps in SQLite, the extension chrome.storage)

async function dohResolveMx(domain) {
  const servers = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
  ];
  for (const url of servers) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json();
      return (j.Answer || []).filter((a) => a.type === 15).map((a) => {
        const [prio, exchange] = String(a.data).trim().split(/\s+/);
        return { priority: Number(prio), exchange: String(exchange || '').replace(/\.$/, '') };
      }).filter((m) => m.exchange);
    } catch { /* try the next resolver */ }
  }
  return [];
}

async function webSha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function memoryStorage() {
  const patterns = new Map();
  const lookups = [];
  const keys = {};
  return {
    async getPattern(domain) { return patterns.get(domain) || null; },
    async savePattern(domain, pattern, confidence, source) {
      const cur = patterns.get(domain);
      if (cur && confidence < cur.confidence) return;
      patterns.set(domain, { domain, pattern, confidence, source, updated_at: new Date().toISOString() });
    },
    async saveLookup(r) { const id = (lookups[0]?.id || 0) + 1; lookups.unshift({ id, created_at: new Date().toISOString(), ...r }); return id; },
    async listLookups(n = 50) { return lookups.slice(0, n); },
    async providerKeys() { return { ...keys }; },
    async setProviderKey(provider, key) { if (key) keys[provider] = key; else delete keys[provider]; },
  };
}

export const platform = {
  resolveMx: dohResolveMx, // (domain) → [{priority, exchange}]
  smtp: null, // (email, mxHosts, opts) → {status, reason, port25} — null when the host has no raw sockets
  sha256: webSha256,
  md5: null,
  storage: memoryStorage(),
};

export function configure(overrides) { Object.assign(platform, overrides); return platform; }
