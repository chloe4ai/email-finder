# Findings (updated 2026-10-31)

What we learned building and testing the email finder: what works for free, what
needs a key, which providers can plug in, and how LinkedIn's page has to be read.

## How to use it now

There are two ways to look someone up. They use different credit pools, so they
add up rather than compete.

| | Chrome extension | Chat with Claude + Lusha |
|---|---|---|
| How | Open a LinkedIn profile, click the yellow @ icon | Paste LinkedIn links into the chat |
| Data source | Free signals + your Hunter key | Lusha's database (+ the free engine as a fallback) |
| Credits | Hunter: 50/month | Lusha: this account shows 89, plus a daily cap of 100 lookups |
| Best for | One person at a time while browsing | A batch of links, or people Hunter can't find |

The extension still works exactly as before; connecting Lusha changed nothing in it.
Lusha only works through the chat, because MCP connectors can't be called from a
browser extension.

**Suggested order:** click the extension first. If it says `guess` or the company opted
out of Hunter, paste the link into the chat for a Lusha lookup.

## 1. How well the free engine works

The extension runs with no key and no server. Its free signals are a company-site
crawl, address-pattern inference, a Microsoft 365 account-existence check, and Gravatar.

| Company mail host | Free result | Example |
|---|---|---|
| Microsoft 365 | **Verified.** Every candidate address is checked against Microsoft's sign-in endpoint. | Satya Nadella → `satyan@microsoft.com`, valid |
| Google Workspace | Ranked guess only, about 40% for `first.last` | A product VP at a SaaS company → `first.last@` guess |
| Proofpoint / Mimecast gateways | Ranked guess only | Large retailers |

SMTP mailbox probing would verify Google-hosted domains, but it needs outbound port 25.
Most home and office networks block it, and a browser extension can never open raw
sockets, so the extension skips it. The Node CLI still tries it.

## 2. Providers: who is free, and who can plug in

"API" means a key can go into the extension's settings page. "MCP" means Claude can
look people up in chat; MCP connectors cannot be called from the extension.

| Provider | Free per month | Free API | Free MCP | Notes |
|---|---|---|---|---|
| **Hunter** | 50 credits | **Yes** | – | The only free key that works in the extension. A direct find costs 1 credit; a miss falls back to pattern + verify, up to 2.5 credits. |
| Lusha | 40 advertised (this account: 89) | Rate-limited | **Yes**, connected | Official docs say the Claude connector works on the free plan. 1 credit per email, 5 per phone, no charge when nothing is found. |
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

### Lusha in practice (tested 2026-10-31)

| Profile | Lusha result | Credits | Fallback |
|---|---|---|---|
| Intern at a design agency | Work email found, confidence A+ | 2 | Hunter: domain is accept-all, so it can't confirm |
| Founder of a small online academy | `COMPLIANCE_RESTRICTED`: the person opted out of Lusha | 0 | Free engine `first.last@` guess, ~40% |
| Staff member at the same academy | Not in Lusha, by LinkedIn URL or by name + company | 0 | Free engine `first.last@` guess, ~40% |

- **Credit balance:** this free account shows 89 credits, more than the advertised 40.
  The daily limit is 100 lookups and 40 per minute.
- **What costs credits:** a lookup that matches someone costs 1 credit; revealing the
  email can cost 1 more; a phone costs 5. No match and opted-out people cost nothing.
  Claude previews first and reveals only the email, never the phone, unless asked.
- **Lusha is not complete:** small companies and people who opted out are missing, so
  the free engine is still the fallback.
- **Company domain guesses can be wrong:** for one company the engine guessed the
  `.com` domain, but the real site was on a different TLD that the `.com` redirects to.
  Both accept mail, so pass the domain explicitly when you know it.
- **CLI `verify` spends Hunter credits** (0.5 each) when a key is stored; add `--free` to skip.

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

The name comes from the page title ("First Last | LinkedIn").

Tested live:

| Profile | Company read | Source |
|---|---|---|
| Satya Nadella | Microsoft | right of name |
| Product lead at a marketplace | correct employer | headline |
| Product VP at a SaaS company | correct employer | headline |
| The repo author | correct (stale) employer | right of name |

The experience-page fallback returned the correct employer for the first three.

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
