# Email Finder

Find and verify someone's **work email** from a name + company, or from a LinkedIn URL.
A zero-dependency take on Wiza / Hunter. The same engine runs two ways:

- **Chrome extension** (`extension/`) — one click on a LinkedIn profile, runs entirely in the
  browser, nothing to start, nothing hosted. This is the one to share.
- **CLI + local web UI** (Node 22+, SQLite) — batch CSV runs, history, SMTP probing where port 25 is open.

```bash
node bin/find.js "Satya Nadella" microsoft.com
node bin/find.js --linkedin https://www.linkedin.com/in/jane-doe/ --company "Acme"
node bin/find.js --csv contacts.csv            # columns: name, company, linkedin
node bin/find.js verify someone@acme.com
node bin/find.js "Name" acme.com --free        # skip paid providers, spend no credits
node server.js                                 # web UI → http://localhost:4790
```

## How it finds an address

1. **Who / where** — name from the LinkedIn slug if you only have a URL; company name → domain
   via Clearbit's public autocomplete (or a `.com` guess that has MX records).
2. **Your own provider keys first** (optional) — `find keys set apollo <key>` (also `hunter`,
   `prospeo`, or env `APOLLO_API_KEY` …). Apollo and Prospeo can resolve a LinkedIn URL directly.
3. **Learn the domain's pattern** — crawl the company site for published addresses, reuse
   patterns verified in earlier lookups, and Hunter's pattern endpoint if keyed.
4. **Generate + rank + verify** — 13 candidate formats (`first.last`, `first`, `flast`, …)
   weighted by evidence, then verified with free signals:
   - SMTP `RCPT TO` against the MX, with catch-all detection (needs outbound port 25 — most
     home / mobile networks block it; the tool detects this and says so)
   - Microsoft 365 account existence (reliable for M365-hosted domains, no port 25 needed)
   - Gravatar profile on the exact address

Every result is stored (SQLite `data/finder.db` for the CLI / server, `chrome.storage` for the
extension): lookup history plus the address pattern learned per domain, reused next time.

## Layout

```
engine/      the finder, platform-neutral ES modules (patterns, domain, crawl, verify, providers)
src/         Node adapters: system DNS, SMTP probe, SQLite  (src/node-platform.js)
bin/ server.js web/   CLI, JSON API, web UI
extension/   Chrome extension; extension/engine/ is a copy of engine/ made by `npm run build:extension`
```

The engine talks to the outside world through `engine/platform.js` (MX lookup, SMTP, hashing,
storage). Defaults work in any runtime with `fetch` + WebCrypto: DNS-over-HTTPS, no SMTP,
in-memory store. Node swaps in real DNS, a port-25 probe and SQLite; the extension swaps in
`chrome.storage`. After editing anything in `engine/`, run `npm run build:extension`.

## Honest limits

- LinkedIn itself is never scraped. Give the person's name + company, or add an Apollo /
  Prospeo key, or read the profile in your own logged-in browser.
- Google-Workspace-hosted domains cannot be verified for free when port 25 is blocked; results
  there are pattern-ranked guesses (typically 40–60% for `first.last`) until you add a key.
- Non-Latin names need their romanised form to build an address.

## Chrome extension (one click on a LinkedIn profile)

On any `linkedin.com/in/…` page the popup reads the name and current company from the page you
are already looking at (your own login, no scraping service), runs the engine inside the
browser, and shows the best email with a copy button and the alternatives. Results are cached
for an hour per profile; a lookup keeps running if you close the popup.

**No server, no account.** Free signals (company-site crawl, pattern inference, Microsoft 365
existence, Gravatar) run with no setup. For verified results on other domains, each user adds
their own Hunter / Apollo / Prospeo key on the extension's settings page — keys stay in that
browser profile and are never bundled into the extension.

Install from a zip (`npm run zip:extension` → `dist/email-finder-extension-<version>.zip`,
or a GitHub release):

1. Unzip it somewhere permanent.
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked**, and pick the unzipped `extension` folder.
3. Open a LinkedIn profile and click the icon. Click ⚙ in the popup to add a Hunter key.

From a checkout, run `npm run build:extension` first, then load the `extension` folder.

LinkedIn changes its page markup often. If the company field comes up empty, type it in; the
popup also works as a plain name + company lookup on any site.

### Permissions, for the Web Store listing

- `https://*/*` — the engine fetches the target company's own website to learn its address
  format, and calls Cloudflare DNS-over-HTTPS, login.microsoftonline.com, gravatar.com and the
  provider APIs you configured. Nothing is sent to a server of the extension's own.
- `activeTab` + `scripting` — read the name and company off the LinkedIn profile you clicked on.
- `storage` — your keys, learned patterns and lookup history, local to the browser profile.
