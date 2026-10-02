// /login: get people to their academy's own log-in page without ever listing
// academies publicly. One academy used on this device → go straight there.
// Several → pick from just those. None → email me my login link.
(() => {
  const { html } = TT;
  const $ = (id) => document.getElementById(id);
  const choosing = new URLSearchParams(location.search).has('choose');
  const recent = TT.recentAcademies();

  if (recent.length === 1 && !choosing) { location.replace(`/a/${recent[0].slug}`); return; }

  if (recent.length) {
    $('recent').innerHTML = recent.map((a) => html`<a class="item" href="/a/${a.slug}" style="text-decoration:none;color:inherit">
        <div class="main"><div class="when">${a.name}</div></div>
        <span class="btn sm primary">Log in</span></a>`.s).join('');
    $('recentWrap').classList.remove('hidden');
    $('intro').classList.add('hidden');
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    if (!email) { $('email').focus(); return; }
    $('submit').disabled = true;
    try {
      await TT.api('POST', '/api/auth/find-academies', { email }, { auth: false });
      $('form').classList.add('hidden');
      $('sent').textContent = `If ${email} has an account, we've emailed the login link to it. `
        + `It usually arrives within a minute. Check your spam folder too.`;
      $('sent').classList.remove('hidden');
    } catch (err) {
      TT.toast(err.message, true);
    } finally {
      $('submit').disabled = false;
    }
  });
})();
