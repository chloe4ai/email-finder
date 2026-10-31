# Findings (as of 2026-10-30)

What we learned building and testing the email finder: what works for free, what
needs a key, which providers can plug in, and how LinkedIn's page has to be read.

## 1. How well the free engine works

The extension runs with no key and no server. Its free signals are a company-site
crawl, address-pattern inference, a Microsoft 365 account-existence check, and Gravatar.

| Company mail host | Free result | Example |
|---|---|---|
| Microsoft 365 | **Verified.** Every candidate address is checked against Microsoft's sign-in endpoint. | Satya Nadella → `satyan@microsoft.com`, valid |
| Google Workspace | Ranked guess only, about 40% for `first.last` | A product VP at a SaaS company → `first.last@` guess |
| Proofpoint / Mimecast gateways | Ranked guess only | Walmart addresses |

SMTP mailbox probing would verify Google-hosted domains, but it needs outbound port 25.
Most home and office networks block it, and a browser extension can never open raw
sockets, so the extension skips it. The Node CLI still tries it.

## 2. Providers: who is free, and who can plug in

"API" means a key can go into the extension's settings page. "MCP" means Claude can
look people up in chat; MCP connectors cannot be called from the extension.

| Provider | Free per month | Free API | Free MCP | Notes |
|---|---|---|---|---|
| **Hunter** | 50 credits | **Yes** | – | The only free key that works in the extension. A direct find costs 1 credit; a miss falls back to pattern + verify, up to 2.5 credits. |
| Lusha | 40 credits | Rate-limited | **Yes** | Official docs say the Claude connector works on the free plan. 1 credit per email, 5 per phone, no charge when nothing is found. |
| Vibe Prospecting (Explorium) | ~100 credits (vendor blog, unconfirmed) | – | Yes | No official pricing page found. |
| Prospeo | 100 credits | **No** (API from the $49 Starter plan) | – | Free credits only work in Prospeo's own site and extension. Adapter updated to the new `/enrich-person` API for paid keys. |
| Snov.io | 50 credits | **No** | – | Pricing FAQ: API not available in Trial. |
| Tomba | 25 searches | Probably no | – | API listed for paid plans only. |
| Apollo | some credits | **No** | **No** | Free-plan API and MCP calls (people match, search, bulk enrich) all fail with a plan-limit error. Free lead credits only work in Apollo's own app. |

Other observations:

- **Domain opt-outs.** Some companies ask Hunter to stop processing their domain
  (one SaaS company in our tests did). Hunter returns `blacklisted_domain`; the engine stops calling
  Hunter for that domain so no more credits are spent.
- **Keys are per tool.** A key stored for the CLI (`data/finder.db`) is not visible to
  the extension, which keeps its own copy in `chrome.storage`.
- **Each user brings their own key.** Nothing is bundled, so sharing the extension
  never spends anyone else's credits.

## 3. Reading LinkedIn

LinkedIn is never scraped from outside. The extension reads only the profile the user
is already viewing, in their own logged-in session.

LinkedIn's 2026 layout broke the first version: the name moved from `h1` to `h2`, the
`#experience` anchor disappeared, the Experience section is no longer on the main
profile page, and every CSS class is a random string. The scraper now avoids class
names entirely. Sources, first hit wins:

1. **The company to the right of the name.** Read by position: the lines after
   "Contact info" and before the followers / connections line. Schools are filtered out.
2. **The headline.** "… at Company" or "… @ Company".
3. **The experience page.** `/in/<slug>/details/experience/` is fetched once in the
   user's session; its first company logo is the current employer.

The name comes from the page title ("Megan Hart | LinkedIn").

Tested live:

| Profile | Company read | Source |
|---|---|---|
| Satya Nadella | Microsoft | right of name |
| Megan Hart | eBay | headline |
| Product VP at a SaaS company | correct employer | headline |
| The repo author | correct (stale) employer | right of name |

The experience-page fallback returned Microsoft, eBay and Amplitude for the first three.

**Caveat:** if someone has left a job but not updated LinkedIn's current position, the
right-of-name company is stale (one tested profile's headline says "Ex-<company>" while
the card still shows that company). The company field stays editable for that case.

## 4. Known gaps

- Google Workspace and gateway-protected domains can't be verified for free.
- Non-Latin names need their romanised form.
- The Chrome Web Store listing is not done yet; installs go through a GitHub release zip
  and "Load unpacked".
- Idea not yet built: skip Hunter for Microsoft 365 domains, where the free check is
  already conclusive, to save credits.
