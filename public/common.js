// Shared helpers for every page: API calls, escaping, formatting, modals, toasts.

const TT = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Tagged template that escapes interpolations unless wrapped with raw().
  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(s);
  function html(strings, ...vals) {
    let out = '';
    strings.forEach((s, i) => {
      out += s;
      if (i < vals.length) {
        const v = vals[i];
        if (v instanceof Raw) out += v.s;
        else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
        else if (v !== false && v !== null && v !== undefined) out += esc(v);
      }
    });
    return raw(out);
  }

  // Slug of the academy in the URL: /a/<slug> or /a/<slug>/app.
  const slug = (location.pathname.match(/^\/a\/([a-z0-9-]+)/) || [])[1] || null;
  const tokenKey = slug ? `tt_token_${slug}` : 'tt_token';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  const token = {
    get: () => store.get(tokenKey),
    set: (t) => store.set(tokenKey, t),
    clear: () => store.del(tokenKey),
  };

  async function api(method, path, body, { auth = true, tokenOverride } = {}) {
    const headers = { 'content-type': 'application/json' };
    const t = tokenOverride || (auth ? token.get() : null);
    if (t) headers.authorization = `Bearer ${t}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Network problem — check your connection'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
    return data;
  }

  // ── Formatting (always in the academy's time zone) ──
  let tz = 'America/Los_Angeles';
  const setTz = (z) => { if (z) tz = z; };
  const fmt = (opts) => (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(d));
  const fmtDay = (d) => fmt({ weekday: 'long', month: 'short', day: 'numeric' })(d);
  const fmtDate = (d) => fmt({ month: 'short', day: 'numeric', year: 'numeric' })(d);
  const fmtTime = (d) => fmt({ hour: 'numeric', minute: '2-digit' })(d);
  const fmtDateTime = (d) => fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })(d);
  const dayKey = (d) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' })(d);
  const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const length = (mins) => (mins === 60 ? '1 hr' : mins === 90 ? '1½ hr' : mins % 60 === 0 ? `${mins / 60} hr` : `${mins} min`);
  const endTime = (start, mins) => fmtTime(new Date(new Date(start).getTime() + mins * 60000));
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  function currentMonth() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
  }
  function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // A <input type=datetime-local> value means wall-clock time AT THE ACADEMY,
  // whatever time zone the browser happens to be in. Convert to a real instant.
  function zonedToIso(local) {
    if (!local) return null;
    const [d, t] = local.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    const asUtc = Date.UTC(y, mo - 1, da, h, mi);
    const offset = (instant) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(instant)).reduce((o, x) => ((o[x.type] = x.value), o), {});
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - instant;
    };
    let guess = asUtc - offset(asUtc);
    guess = asUtc - offset(guess);
    return new Date(guess).toISOString();
  }
  function isoToZoned(iso) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso)).reduce((o, x) => ((o[x.type] = x.value), o), {});
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  // ── UI bits ──
  let toastTimer;
  function toast(msg, isError = false) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3000);
  }

  // Opens a modal. `body` is html(); returns the modal element. onSubmit gets
  // the form's values; throw to show an error and keep the modal open.
  function modal({ title, body, submitLabel = 'Save', onSubmit, danger = false, wide = false }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = html`<form class="modal" ${raw(wide ? 'style="max-width:720px"' : '')} novalidate>
        <h2>${title}</h2>
        <div class="notice error hidden" data-err></div>
        <div>${body}</div>
        <div class="actions">
          <button type="button" data-close>${onSubmit ? 'Cancel' : 'Close'}</button>
          ${onSubmit ? html`<button type="submit" class="${danger ? 'danger' : 'primary'}">${submitLabel}</button>` : ''}
        </div>
      </form>`.s;
    document.body.appendChild(back);
    const form = back.querySelector('form');
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close();
      const btn = form.querySelector('button[type=submit]');
      const err = form.querySelector('[data-err]');
      btn.disabled = true; err.classList.add('hidden');
      try {
        const values = formValues(form);
        const keep = await onSubmit(values, form);
        if (keep !== true) close();
      } catch (ex) {
        err.textContent = ex.message; err.classList.remove('hidden');
        form.scrollIntoView({ block: 'start' });
      } finally { btn.disabled = false; }
    });
    const first = form.querySelector('input:not([type=hidden]),select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return back;
  }
  const confirmBox = (title, message, label = 'Confirm', danger = true) => new Promise((resolve) => {
    const m = modal({ title, body: html`<p>${message}</p>`, submitLabel: label, danger, onSubmit: () => resolve(true) });
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) resolve(false); });
  });

  function formValues(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    }
    return out;
  }
  const dollarsToCents = (v) => Math.round(parseFloat(String(v).replace(/[$,]/g, '')) * 100);

  // ── Field enhancements, applied to every page and every modal automatically ──

  // US phone numbers format as you type: (805) 495-0111. Numbers starting with
  // + (other than +1) are left alone for international callers.
  function formatPhone(raw) {
    const t = String(raw || '').trim();
    if (t.startsWith('+') && !t.startsWith('+1')) return raw;
    let d = t.replace(/\D/g, '');
    if (d.length > 10 && d[0] === '1') d = d.slice(1);
    d = d.slice(0, 10);
    if (!d) return '';
    if (d.length < 4) return `(${d}`;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  const digitsBefore = (s, pos) => s.slice(0, pos).replace(/\D/g, '').length;
  function caretAfterDigits(s, n) {
    if (n === 0) return s.startsWith('(') ? 1 : 0;
    let seen = 0;
    for (let i = 0; i < s.length; i++) if (/\d/.test(s[i]) && ++seen === n) return i + 1;
    return s.length;
  }
  function reformatPhone(el) {
    const before = el.value;
    const next = formatPhone(before);
    if (next === before) return;
    const n = digitsBefore(before, el.selectionStart ?? before.length);
    el.value = next;
    if (document.activeElement === el) { const p = caretAfterDigits(next, n); el.setSelectionRange(p, p); }
  }
  document.addEventListener('input', (e) => { if (e.target.matches('input[type=tel]')) reformatPhone(e.target); });
  // Backspacing over a ")" "-" or space would otherwise do nothing (the format
  // puts it straight back), so delete the digit before it instead.
  document.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (!el.matches('input[type=tel]') || e.inputType !== 'deleteContentBackward') return;
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd || pos === 0 || /\d/.test(el.value[pos - 1]) || el.value.trim().startsWith('+')) return;
    e.preventDefault();
    const n = digitsBefore(el.value, pos);
    if (!n) return;
    const d = el.value.replace(/\D/g, '');
    el.value = formatPhone(d.slice(0, n - 1) + d.slice(n));
    const p = caretAfterDigits(el.value, n - 1);
    el.setSelectionRange(p, p);
  });

  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.1 10.1 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const MIN_PASSWORD = 8;

  function enhance(root) {
    if (!root.querySelectorAll) return;
    // Show/hide eye on every password box; new-password boxes also get a live length check.
    for (const input of root.querySelectorAll('input[type=password]:not([data-pw])')) {
      input.dataset.pw = '1';
      const field = document.createElement('div');
      field.className = 'pw-field';
      const box = document.createElement('span');
      box.className = 'pw-box';
      input.replaceWith(field);
      field.appendChild(box);
      box.appendChild(input);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-eye';
      btn.setAttribute('aria-label', 'Show password');
      btn.innerHTML = EYE;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        input.focus();
      });
      box.appendChild(btn);
      // Shown only while the box is for a NEW password; a page that switches
      // a box between log-in and sign-up fires an 'input' event to refresh it.
      const rule = document.createElement('p');
      rule.className = 'pw-rule';
      field.appendChild(rule);
      const check = () => {
        const n = input.value.length;
        rule.hidden = input.autocomplete !== 'new-password';
        rule.classList.toggle('ok', n >= MIN_PASSWORD);
        rule.textContent = n >= MIN_PASSWORD ? `✓ At least ${MIN_PASSWORD} characters`
          : n ? `At least ${MIN_PASSWORD} characters (${MIN_PASSWORD - n} more)` : `At least ${MIN_PASSWORD} characters`;
      };
      input.addEventListener('input', check);
      check();
    }
    for (const input of root.querySelectorAll('input[type=tel]:not([data-tel])')) {
      input.dataset.tel = '1';
      input.setAttribute('inputmode', 'tel');
      if (!input.placeholder) input.placeholder = '(805) 555-0123';
      if (input.value) input.value = formatPhone(input.value);
    }
  }
  enhance(document);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) enhance(n);
  }).observe(document.documentElement, { childList: true, subtree: true });

  return {
    esc, html, raw, slug, token, api, setTz, fmtDay, fmtDate, fmtTime, fmtDateTime, dayKey, money, length, endTime,
    cap, monthLabel, currentMonth, addMonths, zonedToIso, isoToZoned, toast, modal, confirmBox, formValues, dollarsToCents, formatPhone,
    get tz() { return tz; },
  };
})();
