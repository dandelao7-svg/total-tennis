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

  return {
    esc, html, raw, slug, token, api, setTz, fmtDay, fmtDate, fmtTime, fmtDateTime, dayKey, money, length, endTime,
    cap, monthLabel, currentMonth, addMonths, zonedToIso, isoToZoned, toast, modal, confirmBox, formValues, dollarsToCents,
    get tz() { return tz; },
  };
})();
