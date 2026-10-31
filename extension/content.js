// Reads name / headline / current company from the LinkedIn profile the user
// is looking at, in their own logged-in browser. Nothing is sent anywhere by
// this script; the popup asks for the fields and runs the lookup.
//
// LinkedIn renames its CSS classes constantly, so this avoids class names and
// anchors on things that stay stable: the page title, heading text, the order
// of lines in the top card, and /company/ links inside the Experience section.
(() => {
  if (window.__emailFinderInstalled) return;
  window.__emailFinderInstalled = true;

  const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  const lines = (el) => (el ? el.innerText.split('\n').map((s) => s.trim()).filter(Boolean) : []);
  const clean = (s) => String(s || '')
    .replace(/\s*[|•·].*$/, '') // "eBay | ex-Google" → "eBay"
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/^current company:\s*/i, '')
    .replace(/\s+logo$/i, '')
    .trim();
  const NOISE = /^(·\s*)?(1st|2nd|3rd\+?|3rd)$|^·$|^(she|he|they)\/(her|him|them)s?$|^contact info$|^\d[\d,+]*$|^connections?$|^followers?$|^verified$/i;

  function profileName() {
    // "(3) Megan Hart | LinkedIn" → "Megan Hart"
    const fromTitle = document.title.replace(/^\(\d+\)\s*/, '').split('|')[0].trim();
    if (fromTitle && !/^linkedin$/i.test(fromTitle)) return fromTitle;
    return text(document.querySelector('main h1')) || text(document.querySelector('main h2'));
  }

  function topCard(name) {
    const heads = [...document.querySelectorAll('main h1, main h2')].filter((h) => text(h) === name);
    for (const h of heads) {
      const sec = h.closest('section');
      if (sec && lines(sec).length > 3) return sec;
    }
    return heads[0]?.closest('section') || null;
  }

  function headlineFrom(card, name) {
    const ls = lines(card);
    const i = ls.indexOf(name);
    for (const l of ls.slice(i >= 0 ? i + 1 : 0)) {
      if (NOISE.test(l) || l === name || l.length < 3) continue;
      return l; // first real line after the name is the headline
    }
    return '';
  }

  // The block to the right of the name: current company first, then school.
  // It has no stable markup, so read it by position: the lines after
  // "Contact info" and before the followers / connections / mutual line.
  const STOP = /followers?$|connections?$|mutual connection|^message$|^connect$|^follow(ing)?$|^more$|^\d[\d,+]*$/i;
  const SCHOOL = /\b(university|universit[äeé]|college|school|institute of technology|academy|polytechnic)\b|大学|學|学院/i;
  function rightPanel(card) {
    const ls = lines(card);
    const i = ls.findIndex((l) => /^contact info$/i.test(l));
    if (i < 0) return [];
    const out = [];
    for (const l of ls.slice(i + 1)) {
      if (STOP.test(l)) break;
      if (l === '·' || l.length < 2) continue;
      out.push(l);
    }
    return out.filter((l) => !SCHOOL.test(l));
  }

  // Fallback: the person's experience page, fetched once in your own session.
  // Its first company logo is the current employer.
  async function experiencePageCompany() {
    const m = location.pathname.match(/^\/in\/[^/]+/);
    if (!m) return null;
    try {
      const html = await fetch(`${m[0]}/details/experience/`, { credentials: 'include' }).then((r) => (r.ok ? r.text() : ''));
      const hit = html.match(/a11yText\\*"\s*:\s*\\*"([^"\\]{1,80}?) logo\\*"/);
      if (hit) return hit[1];
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.querySelector('a[href*="/company/"] img[alt$=" logo"]')?.alt.replace(/ logo$/, '') || null;
    } catch { return null; }
  }

  function sectionByHeading(re) {
    return [...document.querySelectorAll('main section')].find((s) => re.test(text(s.querySelector('h2'))));
  }

  async function scrape() {
    const name = profileName();
    const card = name ? topCard(name) : null;
    const headline = card ? headlineFrom(card, name) : '';
    const companies = [];

    // 0. the company shown to the right of the name
    if (card) for (const c of rightPanel(card)) companies.push({ company: clean(c), how: 'top-card-right' });

    // 1. top card: a "current company" button or a /company/ link inside the card itself
    if (card) {
      for (const el of card.querySelectorAll('button[aria-label*="company" i], a[href*="/company/"]')) {
        const t = clean(el.getAttribute('aria-label')?.replace(/^current company:\s*/i, '').replace(/\.\s*click.*$/i, '') || text(el) || el.querySelector('img')?.alt);
        if (t) companies.push({ company: t, how: 'top-card' });
      }
    }

    // 2. first entry of the Experience section (by heading text, not by id/class)
    const exp = sectionByHeading(/^experience\b/i);
    if (exp) {
      const link = exp.querySelector('a[href*="/company/"]');
      const fromLink = link && (link.querySelector('img')?.alt || link.getAttribute('aria-label') || text(link));
      if (fromLink) companies.push({ company: clean(fromLink.replace(/^view\s+/i, '').replace(/\s+page$/i, '')), how: 'experience' });
      const ls = lines(exp).filter((l) => !/^experience$/i.test(l));
      if (ls.length >= 2) {
        // single role: [title, "Company · Full-time", dates]; grouped: [Company, "Full-time · 3 yrs", ...]
        const grouped = /^(full-time|part-time|contract|internship|freelance|self-employed|temporary|apprenticeship)\b/i.test(ls[1]);
        companies.push({ company: clean(grouped ? ls[0] : ls[1]), how: grouped ? 'experience-grouped' : 'experience' });
      }
    }

    // 3. headline "Title at Company" / "Title @ Company" / "Title, Company"
    const m = headline.match(/(?:\bat\b|@)\s*([^|•·,]+)/i);
    if (m) companies.push({ company: clean(m[1]), how: 'headline' });

    // 4. nothing on the profile page itself → read the experience page
    if (!companies.length) {
      const c = await experiencePageCompany();
      if (c) companies.push({ company: clean(c), how: 'experience-page' });
    }

    const seen = new Set();
    const uniq = companies.filter((c) => c.company && c.company.length < 80 && !/^(full-time|part-time|present)$/i.test(c.company)
      && !seen.has(c.company.toLowerCase()) && seen.add(c.company.toLowerCase()));
    return { name, headline, companies: uniq, url: location.href.split('?')[0] };
  }

  window.__emailFinderScrape = scrape; // handy for debugging from DevTools
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'scrape') { scrape().then(reply, () => reply(null)); return true; }
    return false;
  });
})();
