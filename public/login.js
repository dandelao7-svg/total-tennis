// /login: send people to their academy's own log-in page. Shows academies
// used before on this device, plus a search by name.
(() => {
  const { html } = TT;
  const $ = (id) => document.getElementById(id);
  const row = (a) => html`<a class="item" href="/a/${a.slug}" style="text-decoration:none;color:inherit">
      <div class="main"><div class="when">${a.name}</div><div class="small muted">/a/${a.slug}</div></div>
      <span class="btn sm primary">Log in</span></a>`.s;

  const recent = TT.recentAcademies();
  if (recent.length) {
    $('recent').innerHTML = recent.map(row).join('');
    $('recentWrap').classList.remove('hidden');
    $('intro').classList.add('hidden');
  }

  let timer, seq = 0;
  $('q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('results').innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const list = await TT.api('GET', `/api/academies/search?q=${encodeURIComponent(q)}`, null, { auth: false });
        if (mine !== seq) return;
        $('results').innerHTML = list.length ? list.map(row).join('')
          : html`<p class="muted small">No academy matches “${q}”. Check the spelling, or ask your academy for its booking link.</p>`.s;
      } catch (err) { $('results').innerHTML = html`<p class="notice error">${err.message}</p>`.s; }
    }, 250);
  });
})();
