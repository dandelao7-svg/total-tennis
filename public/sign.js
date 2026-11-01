(() => {
  const { html } = TT;
  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split('/')[2] || '';
  const base = `/api/sign/${encodeURIComponent(token)}`;
  const call = (m, b) => TT.api(m, base, b, { auth: false });

  async function load() {
    let d;
    try { d = await call('GET'); } catch (err) {
      $('errMsg').textContent = err.message;
      $('error').classList.remove('hidden');
      return;
    }
    $('doc').classList.remove('hidden');
    document.title = `Sign: ${d.title}`;
    $('title').textContent = d.title;
    $('sentTo').textContent = `Sent to ${d.me.name} (${d.me.email})`;
    $('signers').innerHTML = html`${d.parties.map((p) => html`<li>${p.signed ? '✓ Signed' : '○ Not signed yet'}: <strong>${p.name}</strong></li>`)}`.s;

    if (d.status === 'void') {
      $('frame').remove();
      document.querySelector('.row').remove();
      return done('This document was cancelled', 'The sender cancelled it, so it can no longer be signed.');
    }
    $('frame').src = `${base}/pdf?s=${d.status}`;
    $('open').href = `${base}/pdf`;
    $('download').href = `${base}/pdf?download=1`;

    if (d.status === 'completed') {
      return done('Everyone has signed', 'The signed copy, with a signature certificate on the last page, was emailed to everyone. You can also download it above.');
    }
    if (d.me.signedAt) {
      const waiting = d.parties.filter((p) => !p.signed).map((p) => p.name).join(', ');
      return done('You have signed', `Thank you, ${d.me.signedName}. Still waiting for: ${waiting}. When everyone has signed, you'll get the signed copy by email.`);
    }
    $('name').value = d.me.name;
    $('preview').textContent = d.me.name;
  }

  function done(title, msg) {
    $('signCard').classList.add('hidden');
    $('doneTitle').textContent = title;
    $('doneMsg').textContent = msg;
    $('doneCard').classList.remove('hidden');
  }

  $('name').addEventListener('input', () => { $('preview').textContent = $('name').value; });
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('formErr').classList.add('hidden');
    const name = $('name').value.trim();
    if (!name) return showErr('Type your full legal name');
    if (!$('consent').checked) return showErr('Tick the box to agree to sign electronically');
    $('submit').disabled = true;
    try {
      await call('POST', { name, title: $('sigTitle').value.trim(), consent: true });
      window.scrollTo(0, 0);
      await load();
    } catch (err) { showErr(err.message); } finally { $('submit').disabled = false; }
  });
  function showErr(msg) { $('formErr').textContent = msg; $('formErr').classList.remove('hidden'); }
  load();
})();
