(() => {
  const $ = (id) => document.getElementById(id);
  $('host').textContent = `${location.host}/a/`;
  try { $('timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default server-side */ }

  // Suggest a booking address from the academy name until the owner edits it.
  let slugTouched = false;
  $('slug').addEventListener('input', () => { slugTouched = true; });
  $('academyName').addEventListener('input', (e) => {
    if (slugTouched) return;
    $('slug').value = e.target.value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('submit').disabled = true;
    $('err').classList.add('hidden');
    try {
      const out = await TT.api('POST', '/api/auth/academy-signup', TT.formValues(e.target), { auth: false });
      try { localStorage.setItem(`tt_token_${out.slug}`, out.token); } catch { /* private mode */ }
      location.replace(`/a/${out.slug}/app#setup`);
    } catch (err) {
      $('err').textContent = err.message;
      $('err').classList.remove('hidden');
      $('submit').disabled = false;
    }
  });
})();
