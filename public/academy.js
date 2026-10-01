// An academy's public page: log in, sign up, forgot password, and the
// "choose a new password" screen that the reset email links to.
(async () => {
  const $ = (id) => document.getElementById(id);
  const appUrl = `/a/${TT.slug}/app`;
  const resetToken = /\/reset$/.test(location.pathname)
    ? new URLSearchParams(location.hash.slice(1)).get('token') : null;
  if (TT.token.get() && !resetToken) { location.replace(appUrl); return; }

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

  const MODES = {
    login: { heading: 'Log in', sub: 'Book group and private lessons online.', submit: 'Log in', pw: 'current-password' },
    signup: { heading: `Join ${academy.name}`, sub: 'Create your account to buy and book lessons.', submit: 'Create account', pw: 'new-password' },
    forgot: { heading: 'Reset your password', sub: "Enter your account's email and we'll send you a link to choose a new password.", submit: 'Email me a link' },
    reset: { heading: 'Choose a new password', sub: '', submit: 'Save new password', pw: 'new-password', noEmail: true },
  };
  let mode = resetToken ? 'reset' : location.hash === '#signup' ? 'signup' : 'login';
  if (/\/reset$/.test(location.pathname) && !resetToken) mode = 'forgot';

  const link = (m, text) => `<a href="#" data-mode="${m}">${text}</a>`;
  function render() {
    const m = MODES[mode];
    $('heading').textContent = m.heading;
    $('sub').textContent = m.sub;
    $('sub').classList.toggle('hidden', !m.sub);
    $('signupOnly').classList.toggle('hidden', mode !== 'signup');
    $('emailRow').classList.toggle('hidden', !!m.noEmail);
    $('passwordRow').classList.toggle('hidden', !m.pw);
    $('passwordLabel').textContent = mode === 'reset' ? 'New password' : 'Password';
    $('submit').textContent = m.submit;
    $('submit').classList.remove('hidden');
    $('form').classList.remove('hidden');
    const pw = $('password');
    if (m.pw) { pw.autocomplete = m.pw; pw.dispatchEvent(new Event('input')); }
    $('err').classList.add('hidden');
    $('info').classList.add('hidden');
    $('links').innerHTML = {
      login: `${link('forgot', 'Forgot your password?')}<br><span>New student?</span> ${link('signup', 'Create an account')}`,
      signup: `<span>Already have an account?</span> ${link('login', 'Log in')}`,
      forgot: link('login', 'Back to log in'),
      reset: link('login', 'Back to log in'),
    }[mode];
  }
  render();

  $('links').addEventListener('click', (e) => {
    const a = e.target.closest('[data-mode]');
    if (!a) return;
    e.preventDefault();
    mode = a.dataset.mode;
    if (/\/reset$/.test(location.pathname)) history.replaceState(null, '', `/a/${TT.slug}`);
    render();
  });

  const showErr = (msg) => { $('err').textContent = msg; $('err').classList.remove('hidden'); };

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = TT.formValues(e.target);
    $('submit').disabled = true;
    $('err').classList.add('hidden');
    try {
      if (mode === 'forgot') {
        if (!v.email) throw new Error('Enter your email');
        await TT.api('POST', '/api/auth/forgot', { academy: TT.slug, email: v.email }, { auth: false });
        $('form').classList.add('hidden');
        $('info').textContent = `If ${v.email} has an account here, a reset link is on its way. It works for 60 minutes. `
          + `Check your spam folder if it doesn't arrive within a few minutes.`;
        $('info').classList.remove('hidden');
        return;
      }
      if (mode === 'reset') {
        const out = await TT.api('POST', '/api/auth/reset', { token: resetToken, password: v.password }, { auth: false });
        TT.token.set(out.token);
        location.replace(appUrl);
        return;
      }
      const out = await TT.api('POST', mode === 'signup' ? '/api/auth/signup' : '/api/auth/login',
        { ...v, academy: TT.slug }, { auth: false });
      TT.token.set(out.token);
      location.replace(appUrl);
    } catch (err) {
      showErr(err.message);
    } finally {
      $('submit').disabled = false;
    }
  });
})();
