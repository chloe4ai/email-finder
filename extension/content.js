// Reads name / headline / current company from the LinkedIn profile the user
// is looking at, in their own logged-in browser. Nothing is sent anywhere by
// this script; the popup asks for the fields and calls the local server.
(() => {
  if (window.__emailFinderInstalled) return;
  window.__emailFinderInstalled = true;

  const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  const clean = (s) => s.replace(/\s*[·•|].*$/, '').replace(/\s*\(.*?\)\s*$/, '').trim();

  function scrape() {
    const name = text(document.querySelector('main h1, h1'));
    const headline = text(document.querySelector('main .text-body-medium, [data-generated-suggestion-target] + div, .pv-text-details__left-panel .text-body-medium'));
    const companies = [];

    // 1. top card "current company" button / link
    for (const el of document.querySelectorAll('button[aria-label^="Current company"], button[aria-label*="current company" i], .pv-text-details__right-panel a[href*="/company/"], [data-view-name*="current-company" i]')) {
      const t = clean(text(el).replace(/^Current company:\s*/i, ''));
      if (t) companies.push({ company: t, how: 'top-card' });
    }
    // 2. first entry in the Experience section
    const exp = document.querySelector('#experience');
    const section = exp && exp.closest('section');
    const first = section && section.querySelector('li');
    if (first) {
      const spans = [...first.querySelectorAll('span[aria-hidden="true"]')].map(text).filter(Boolean);
      // a single-role entry reads [title, "Company · Full-time", dates...]; a grouped entry reads [Company, "Full-time · 3 yrs", ...]
      if (spans.length >= 2) {
        const second = spans[1];
        // grouped entry (several roles at one company): line 2 starts with the employment type
        const grouped = /^(full-time|part-time|contract|internship|freelance|self-employed|temporary|apprenticeship)\b/i.test(second);
        companies.push({ company: clean(grouped ? spans[0] : second), how: grouped ? 'experience-grouped' : 'experience' });
      }
      const logo = first.querySelector('a[href*="/company/"] img[alt]');
      if (logo && logo.alt) companies.push({ company: clean(logo.alt.replace(/ logo$/i, '')), how: 'experience-logo' });
    }
    // 3. headline "Title at Company" / "Title @ Company"
    const m = headline.match(/(?:\bat\b|@)\s+([^|•·]+)/i);
    if (m) companies.push({ company: clean(m[1]), how: 'headline' });

    const seen = new Set();
    const uniq = companies.filter((c) => c.company && c.company.length < 80 && !seen.has(c.company.toLowerCase()) && seen.add(c.company.toLowerCase()));
    return { name, headline, companies: uniq, url: location.href.split('?')[0] };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'scrape') reply(scrape());
    return true;
  });
})();
