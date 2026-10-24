(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['check', 'verifying', 'signupCard'].forEach((x) => $(x).classList.toggle('hidden', x !== id));
  const openApp = (slug, token) => {
    try { localStorage.setItem(`tt_token_${slug}`, token); } catch { /* private mode */ }
    location.replace(`/a/${slug}/app#setup`);
  };

  // The link from the confirmation email: /start/verify#token=…
  if (location.pathname === '/start/verify') {
    show('verifying');
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', '/start/verify');
    TT.api('POST', '/api/auth/verify-email', { token }, { auth: false })
      .then((out) => openApp(out.slug, out.token))
      .catch((err) => {
        $('verifyTitle').textContent = 'That link didn\'t work';
        $('verifyErr').textContent = err.message;
        $('verifyErr').classList.remove('hidden');
      });
    return;
  }

  $('host').textContent = `${location.host}/a/`;
  try { $('timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default server-side */ }

  // Suggest a booking address from the academy name until the owner edits it.
  let slugTouched = false;
  $('slug').addEventListener('input', () => { slugTouched = true; });
  $('academyName').addEventListener('input', (e) => {
    if (slugTouched) return;
    $('slug').value = e.target.value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  });

  let pending = null;
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('submit').disabled = true;
    $('err').classList.add('hidden');
    try {
      const out = await TT.api('POST', '/api/auth/academy-signup', TT.formValues(e.target), { auth: false });
      if (out.token) return openApp(out.slug, out.token);
      pending = { slug: out.slug, email: out.email };
      $('checkEmail').textContent = out.email;
      show('check');
    } catch (err) {
      $('err').textContent = err.message;
      $('err').classList.remove('hidden');
      $('submit').disabled = false;
    }
  });

  $('resend').addEventListener('click', async () => {
    $('resend').disabled = true;
    try {
      await TT.api('POST', '/api/auth/resend-verification', pending, { auth: false });
      $('resent').textContent = `Sent again to ${pending.email}.`;
    } catch (err) { $('resent').textContent = err.message; }
    $('resent').classList.remove('hidden');
    setTimeout(() => { $('resend').disabled = false; }, 30000);
  });
})();
