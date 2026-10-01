(async () => {
  const $ = (id) => document.getElementById(id);
  const appUrl = `/a/${TT.slug}/app`;
  if (TT.token.get()) { location.replace(appUrl); return; }

  let academy;
  try {
    academy = await TT.api('GET', `/api/academy/${TT.slug}`, null, { auth: false });
  } catch {
    $('acName').textContent = 'Not found';
    $('notFound').classList.remove('hidden');
    return;
  }
  document.title = `${academy.name} — Book Lessons`;
  $('acName').textContent = academy.name;
  const contact = [academy.contactEmail, academy.contactPhone].filter(Boolean).join(' · ');
  if (contact) $('contact').textContent = `Questions? ${contact}`;
  $('panel').classList.remove('hidden');

  let mode = location.hash === '#signup' ? 'signup' : 'login';
  function render() {
    const signup = mode === 'signup';
    $('heading').textContent = signup ? `Join ${academy.name}` : 'Log in';
    $('signupOnly').classList.toggle('hidden', !signup);
    $('pwHint').classList.toggle('hidden', !signup);
    $('forgot').classList.toggle('hidden', signup);
    $('submit').textContent = signup ? 'Create account' : 'Log in';
    $('switchText').textContent = signup ? 'Already have an account?' : 'New student?';
    $('switch').textContent = signup ? 'Log in' : 'Create an account';
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('err').classList.add('hidden');
  }
  render();
  $('switch').addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'signup' : 'login'; render(); });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = TT.formValues(e.target);
    $('submit').disabled = true;
    try {
      const out = await TT.api('POST', mode === 'signup' ? '/api/auth/signup' : '/api/auth/login',
        { ...v, academy: TT.slug }, { auth: false });
      TT.token.set(out.token);
      location.replace(appUrl);
    } catch (err) {
      $('err').textContent = err.message;
      $('err').classList.remove('hidden');
    } finally {
      $('submit').disabled = false;
    }
  });
})();
