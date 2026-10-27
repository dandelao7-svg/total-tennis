(() => {
  const { html, raw, money } = TT;
  const $ = (id) => document.getElementById(id);
  const KEY = 'tt_platform_token';
  const tok = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
  const call = (m, p, b) => TT.api(m, p, b, { tokenOverride: tok(), auth: false });
  const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'comped'];

  async function load() {
    let rows;
    try { rows = await call('GET', '/api/platform/academies'); } catch { return showLogin(); }
    $('login').classList.add('hidden'); $('console').classList.remove('hidden'); $('logout').classList.remove('hidden');
    const paying = rows.filter((r) => r.subStatus === 'active').length;
    const trial = rows.filter((r) => r.subStatus === 'trialing' && new Date(r.trialEndsAt) > new Date()).length;
    $('stats').innerHTML = html`
      <div class="stat"><div class="n">${rows.length}</div><div class="l">Academies</div></div>
      <div class="stat"><div class="n">${paying}</div><div class="l">Paying</div></div>
      <div class="stat"><div class="n">${trial}</div><div class="l">In trial</div></div>
      <div class="stat"><div class="n">${rows.reduce((a, r) => a + r.students, 0)}</div><div class="l">Students</div></div>`.s;
    $('table').innerHTML = html`<tr><th>Academy</th><th>Owner</th><th>Status</th><th class="num">Students</th><th class="num">Lessons 30d</th><th class="num">Sales 30d</th><th>Stripe</th><th>Created</th></tr>
      ${rows.map((r) => html`<tr>
        <td><a href="/a/${r.slug}" target="_blank" rel="noopener">${r.name}</a><div class="small muted">/a/${r.slug}</div></td>
        <td class="small">${r.ownerEmail || ''}</td>
        <td><select data-id="${r.id}" style="min-width:120px">${STATUSES.map((s) => html`<option ${raw(s === r.subStatus ? 'selected' : '')}>${s}</option>`)}</select>
          ${!r.verified ? html`<div class="small muted">Email not confirmed yet</div>`
            : r.subStatus === 'trialing' && r.trialEndsAt ? html`<div class="small muted">ends ${TT.fmtDate(r.trialEndsAt)}</div>`
            : r.subStatus === 'trialing' ? html`<div class="small muted">Waiting for card</div>` : ''}
          ${!r.verified || (r.subStatus === 'trialing' && !r.trialEndsAt) || r.subStatus === 'canceled'
            ? html`<div><button class="link small" data-trial="${r.id}" data-name="${r.name}">Start free trial (no card)</button></div>` : ''}
          ${!r.trialEligible ? html`<div class="small muted">Email already had a trial</div>` : ''}</td>
        <td class="num">${r.students}</td><td class="num">${r.sessions30d}</td><td class="num">${money(r.gmv30dCents)}</td>
        <td>${r.stripeConnected ? 'Yes' : '—'}</td><td class="small">${TT.fmtDate(r.createdAt)}</td></tr>`)}`.s;
  }

  function showLogin() {
    $('console').classList.add('hidden'); $('logout').classList.add('hidden'); $('login').classList.remove('hidden');
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await TT.api('POST', '/api/platform/login', TT.formValues(e.target), { auth: false });
      try { sessionStorage.setItem(KEY, r.token); } catch { /* private mode */ }
      load();
    } catch (err) { $('err').textContent = err.message; $('err').classList.remove('hidden'); }
  });
  $('logout').addEventListener('click', () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } showLogin(); });
  $('table').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-trial]');
    if (!b) return;
    if (!window.confirm(`Open "${b.dataset.name}" with a free trial, no card needed?`)) return;
    try { await call('PUT', `/api/platform/academies/${b.dataset.trial}`, { startTrial: true }); TT.toast('Trial started'); load(); }
    catch (err) { TT.toast(err.message, true); }
  });
  $('table').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-id]');
    if (!sel) return;
    try { await call('PUT', `/api/platform/academies/${sel.dataset.id}`, { subStatus: sel.value }); TT.toast('Status updated'); load(); }
    catch (err) { TT.toast(err.message, true); }
  });
  load();
})();
