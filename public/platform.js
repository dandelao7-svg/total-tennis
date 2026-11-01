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
        <td class="small">${r.ownerEmail || ''}${r.heardFrom ? html`<div class="muted">Heard via: ${r.heardFrom}${r.heardDetail ? ` (${r.heardDetail})` : ''}</div>` : ''}</td>
        <td><select data-id="${r.id}" style="min-width:120px">${STATUSES.map((s) => html`<option ${raw(s === r.subStatus ? 'selected' : '')}>${s}</option>`)}</select>
          ${!r.verified ? html`<div class="small muted">Email not confirmed yet</div>`
            : r.subStatus === 'trialing' && r.trialEndsAt ? html`<div class="small muted">ends ${TT.fmtDate(r.trialEndsAt)}</div>`
            : r.subStatus === 'trialing' ? html`<div class="small muted">Waiting for card</div>` : ''}
          ${!r.verified || (r.subStatus === 'trialing' && !r.trialEndsAt) || r.subStatus === 'canceled'
            ? html`<div><button class="link small" data-trial="${r.id}" data-name="${r.name}">Start free trial (no card)</button></div>` : ''}
          ${!r.trialEligible ? html`<div class="small muted">Email already had a trial</div>` : ''}</td>
        <td class="num">${r.students}</td><td class="num">${r.sessions30d}</td><td class="num">${money(r.gmv30dCents)}</td>
        <td>${r.stripeConnected ? 'Yes' : '—'}</td><td class="small">${TT.fmtDate(r.createdAt)}</td></tr>`)}`.s;
    loadDocs();
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
  // ── Documents to sign ──

  function addSignerRow(name = '', email = '') {
    const row = document.createElement('div');
    row.className = 'form-row';
    row.innerHTML = html`<div><input data-f="name" placeholder="Full name" value="${name}" maxlength="120"></div>
      <div><input data-f="email" type="email" placeholder="Email" value="${email}" maxlength="200"></div>`.s;
    $('signers').appendChild(row);
  }
  addSignerRow(); addSignerRow();
  $('addSigner').addEventListener('click', () => {
    if ($('signers').children.length < 4) addSignerRow();
    if ($('signers').children.length >= 4) $('addSigner').classList.add('hidden');
  });

  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
  const linkList = (links) => html`<div class="notice info" style="margin-top:14px">
      <strong>Signing links</strong> (each is private to that person; anyone with the link can sign as them):
      ${links.map((l) => html`<div style="margin-top:8px"><strong>${l.name}</strong> ${l.emailed ? '(emailed)' : '(not emailed: send it yourself)'}
        <div class="row" style="gap:6px;flex-wrap:nowrap"><input readonly value="${l.url}" style="flex:1;min-width:0">
        <button type="button" class="sm" data-copy="${l.url}">Copy</button></div></div>`)}</div>`.s;

  $('signForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('signErr');
    err.classList.add('hidden');
    const file = $('signFile').files[0];
    const parties = [...$('signers').children].map((r) => ({
      name: r.querySelector('[data-f=name]').value.trim(), email: r.querySelector('[data-f=email]').value.trim(),
    })).filter((p) => p.name || p.email);
    try {
      if (!file) throw new Error('Choose a PDF file');
      if (file.size > 8 * 1024 * 1024) throw new Error('The PDF must be under 8 MB');
      $('signSubmit').disabled = true;
      let dataUrl = await readFile(file);
      // Some browsers report PDFs without a type; the server checks the bytes anyway.
      dataUrl = dataUrl.replace(/^data:[^;]*;base64,/, 'data:application/pdf;base64,');
      const r = await call('POST', '/api/platform/sign-docs', {
        title: $('signTitle').value.trim(), dataUrl, parties, sendEmails: $('signEmail').checked,
      });
      $('signLinks').innerHTML = linkList(r.links);
      $('signTitle').value = ''; $('signFile').value = '';
      $('signers').innerHTML = ''; addSignerRow(); addSignerRow(); $('addSigner').classList.remove('hidden');
      TT.toast('Sent for signature');
      loadDocs();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); } finally { $('signSubmit').disabled = false; }
  });

  async function loadDocs() {
    let docs;
    try { docs = await call('GET', '/api/platform/sign-docs'); } catch { return; }
    $('docs').innerHTML = html`${docs.map((d) => html`<div class="card">
      <div class="row" style="justify-content:space-between">
        <div><h3 style="margin:0">${d.title}</h3>
          <div class="small muted">Sent ${TT.fmtDate(d.createdAt)} · ${d.statusLabel}${d.completedAt ? ` on ${TT.fmtDate(d.completedAt)}` : ''}</div></div>
        <div class="row" style="gap:6px">
          <button type="button" class="sm" data-dl="${d.id}" data-title="${d.title}">${d.status === 'completed' ? 'Download signed copy' : 'Download PDF'}</button>
          ${d.status === 'open' ? html`<button type="button" class="sm" data-void="${d.id}" data-title="${d.title}">Cancel</button>` : ''}
        </div>
      </div>
      <ul class="signers small" style="list-style:none;padding:0;margin:10px 0 0">${d.parties.map((p) => html`<li style="padding:4px 0">
        ${p.signedAt ? html`✓ <strong>${p.signedName}</strong>${p.signedTitle ? `, ${p.signedTitle}` : ''} signed ${TT.fmtDateTime(p.signedAt)}`
          : html`○ <strong>${p.name}</strong> · ${p.viewedAt ? `opened ${TT.fmtDateTime(p.viewedAt)}` : 'not opened yet'}`}
        <span class="muted">(${p.email})</span>
        ${!p.signedAt && d.status === 'open' ? html` <button type="button" class="link small" data-link="${p.id}" data-doc="${d.id}" data-name="${p.name}">New link</button>` : ''}
      </li>`)}</ul>
      <div data-links="${d.id}"></div>
    </div>`)}`.s;
  }

  document.addEventListener('click', async (e) => {
    const copy = e.target.closest('button[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); TT.toast('Link copied'); } catch { TT.toast('Select the link and copy it', true); }
      return;
    }
    const dl = e.target.closest('button[data-dl]');
    if (dl) {
      try {
        const res = await fetch(`/api/platform/sign-docs/${dl.dataset.dl}/pdf`, { headers: { authorization: `Bearer ${tok()}` } });
        if (!res.ok) throw new Error('Download failed');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await res.blob());
        a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'document.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (ex) { TT.toast(ex.message, true); }
      return;
    }
    const v = e.target.closest('button[data-void]');
    if (v) {
      if (!window.confirm(`Cancel "${v.dataset.title}"? Its signing links will stop working.`)) return;
      try { await call('POST', `/api/platform/sign-docs/${v.dataset.void}/void`, {}); TT.toast('Cancelled'); loadDocs(); }
      catch (ex) { TT.toast(ex.message, true); }
      return;
    }
    const nl = e.target.closest('button[data-link]');
    if (nl) {
      if (!window.confirm(`Make a new signing link for ${nl.dataset.name}? Their old link will stop working.`)) return;
      const send = window.confirm(`Email the new link to ${nl.dataset.name}? (Cancel = just show it to me)`);
      try {
        const r = await call('POST', `/api/platform/sign-docs/${nl.dataset.doc}/parties/${nl.dataset.link}/link`, { send });
        await loadDocs();
        document.querySelector(`[data-links="${nl.dataset.doc}"]`).innerHTML = linkList([{ name: nl.dataset.name, url: r.url, emailed: r.emailed }]);
      } catch (ex) { TT.toast(ex.message, true); }
    }
  });

  load();
})();
