# Email Finder

Find someone's **work email** from their LinkedIn profile, in one click.
A free, open-source take on Wiza / Apollo's Chrome extensions: it runs entirely in your
browser, needs no account, and sends nothing to a server of ours (there is none).

## Install the Chrome extension (2 minutes)

1. Download **`email-finder-extension-0.2.3.zip`** from the
   [latest release](https://github.com/chloe4ai/email-finder/releases/latest).
2. Unzip it into a folder you'll keep (Chrome loads the extension from that folder, so don't
   leave it in Downloads and delete it later).
3. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked**, and choose the unzipped `extension` folder.
4. Pin it: click the puzzle-piece icon in Chrome's toolbar and pin **Email Finder**
   (the yellow **@**).

## Use it

1. Open anyone's LinkedIn profile (`linkedin.com/in/…`).
2. Click the yellow **@** icon <img src="extension/icon48.png" alt="Email Finder icon: a black @ on a yellow square" width="20" height="20" align="absmiddle"> in Chrome's toolbar.
3. Name and company fill in by themselves and the lookup starts. In a few seconds you get
   the best email, a **copy** button, and two or three alternatives.

If the company is wrong (for example the person changed jobs but didn't update LinkedIn),
edit it and click **Find email**. The popup also works as a plain name + company search on
any page.

### Reading the result

| Label | Meaning |
|---|---|
| **valid** | Confirmed to exist (by Microsoft 365, an SMTP check, or a Hunter / Apollo / Prospeo key). Safe to send. |
| **likely** | Strong evidence, not confirmed. Usually right. |
| **catch_all** | The company's server accepts every address, so nobody can confirm it. |
| **guess** | Best guess from the company's email format. Send it, but expect some bounces. |

The small line under the email says where it came from: `hunter`, or `pattern-engine` for
the free guess.

### Free, or with a key?

- **No key (free, unlimited).** Works well for companies whose email runs on Microsoft 365,
  which it can verify. For Google Workspace and most others it gives a format-based guess.
- **Add a free Hunter key (50 lookups a month, verified).** Sign up at
  [hunter.io](https://hunter.io/users/sign_up), copy your API key, click **⚙** in the popup,
  paste it into **Hunter**, and save. Keys stay in your browser and are never shared.
  When the 50 credits run out, the extension quietly falls back to the free mode.
- Apollo and Prospeo keys are also supported, but their free plans don't include API access.

### Need more lookups? Use Claude + Lusha

If you use Claude, connect the **Lusha** connector (free plan, about 40+ lookups a month) and
paste LinkedIn links into the chat. Claude looks them up in Lusha's database and falls back to
this engine when Lusha has no match. Lusha's credits are separate from Hunter's, so the two add
up. It's also the best second try when the extension only gives a `guess`.

See [FINDINGS.md](FINDINGS.md) for test results and a comparison of free
email-finder providers.

## For developers: command line and local web UI

Node 22+, no dependencies. Adds batch CSV runs, a lookup history, and SMTP probing on networks
where outbound port 25 is open.

```bash
git clone https://github.com/chloe4ai/email-finder.git && cd email-finder
node bin/find.js "Satya Nadella" microsoft.com
node bin/find.js --linkedin https://www.linkedin.com/in/jane-doe/ --company "Acme"
node bin/find.js --csv contacts.csv            # columns: name, company, linkedin
node bin/find.js verify someone@acme.com --free
node bin/find.js keys set hunter <key>         # store a provider key for the CLI
node server.js                                 # web UI → http://localhost:4790
```

Add `--free` to any lookup to skip paid providers and spend no credits. The CLI keeps its own
keys in `data/finder.db`; they are separate from the extension's.

The web server listens on `127.0.0.1` only (set `HOST` to change that) and answers API calls
only from its own page and the Chrome extension, so other websites can't read your history or
spend your provider credits.

To work on the extension from a checkout, run `npm run build:extension` (copies `engine/` into
`extension/engine/`), then **Load unpacked** the `extension` folder. `npm test` runs the test
suite (`node --test`, no dependencies, no network). `npm run zip:extension`
builds the release zip in `dist/`.

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

## Limits

- LinkedIn is not scraped in bulk. The extension reads only the profile you are viewing, in
  your own logged-in session, and at most loads that person's experience page once to find
  their current company. The CLI never touches LinkedIn; give it a name + company.
- Google-Workspace-hosted domains cannot be verified for free when port 25 is blocked; results
  there are pattern-ranked guesses (typically 40–60% for `first.last`) until you add a key.
- Non-Latin names need their romanised form to build an address.

## Extension permissions

- `https://*/*` — the engine fetches the target company's own website to learn its address
  format, and calls Cloudflare DNS-over-HTTPS, login.microsoftonline.com, gravatar.com and the
  provider APIs you configured. Nothing is sent to a server of the extension's own.
- `activeTab` + `scripting` — read the name and company off the LinkedIn profile you clicked on.
- `storage` — your keys, learned patterns and lookup history, local to the browser profile.
