// Fills in the business name, contact email, terms version and trial length
// on the Terms of Service page from the server's settings.
(async () => {
  try {
    const s = await TT.api('GET', '/api/site', null, { auth: false });
    document.querySelectorAll('[data-legal-name]').forEach((el) => { el.textContent = s.legalName; });
    document.querySelectorAll('[data-terms-version]').forEach((el) => { el.textContent = s.termsVersion; });
    document.querySelectorAll('[data-trial-days]').forEach((el) => { el.textContent = s.trialDays; });
    if (s.supportEmail) {
      const p = document.querySelector('[data-contact]');
      p.textContent = 'Questions about these terms: ';
      const a = document.createElement('a');
      a.href = `mailto:${s.supportEmail}`; a.textContent = s.supportEmail;
      p.appendChild(a);
    }
  } catch { /* the page still reads correctly with its defaults */ }
})();
