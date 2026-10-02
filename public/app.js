// The signed-in app. One page, hash-routed; tabs depend on role.
// Views render HTML strings into #view; clicks are handled by delegation on
// [data-act] elements, looked up in `acts`.

const { html, raw, api, toast, modal, confirmBox, money, cap } = TT;
const $view = document.getElementById('view');
const S = { me: null, academy: null, locations: null, pros: null, students: null };

if (!TT.slug) location.replace('/');
if (!TT.token.get()) location.replace(`/a/${TT.slug}`);

// ── Shell ────────────────────────────────────────────────────

const TABS = {
  student: [['book', 'Book a lesson'], ['my', 'My lessons'], ['buy', 'Buy lessons'], ['private', 'Private lessons'], ['account', 'Account']],
  pro: [['sessions', 'My schedule'], ['students', 'Students'], ['privates', 'Private lessons'], ['hours', 'My hours'], ['account', 'Account']],
  admin: [['dashboard', 'Dashboard'], ['sessions', 'Schedule'], ['students', 'Students'], ['privates', 'Private lessons'],
    ['payroll', 'Payroll'], ['payments', 'Payments'], ['setup', 'Setup'], ['billing', 'Billing'], ['account', 'Account']],
};

function route() {
  const [name, qs] = (location.hash.slice(1) || '').split('?');
  return { name, params: new URLSearchParams(qs || '') };
}
function go(name, params) { location.hash = params ? `${name}?${new URLSearchParams(params)}` : name; }

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    S.me = me.user; S.academy = me.academy; S.credits = me.credits;
  } catch (err) {
    if (err.status === 401 || err.status === 402) { TT.token.clear(); location.replace(`/a/${TT.slug}`); return; }
    $view.innerHTML = html`<div class="notice error">${err.message}</div>`.s; return;
  }
  TT.setTz(S.academy.timezone);
  TT.rememberAcademy(S.academy);
  document.title = S.academy.name;
  document.getElementById('acName').textContent = S.academy.name;
  document.getElementById('who').textContent = S.me.name;
  window.addEventListener('hashchange', render);
  render();
}

function tabsFor() { return TABS[S.me.role] || TABS.student; }

function renderTabs(active) {
  const tabs = tabsFor();
  document.getElementById('tabs').innerHTML = tabs.map(([k, label]) =>
    html`<a href="#${k}" class="${k === active ? 'active' : ''}">${label}</a>`.s).join('');
  const a = document.querySelector('#tabs a.active');
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderBanner() {
  const b = document.getElementById('banner');
  const a = S.academy;
  let out = '';
  if (a.subStatus === 'trialing' && S.me.role === 'admin' && a.live) {
    const days = Math.max(0, Math.ceil((new Date(a.trialEndsAt) - Date.now()) / 864e5));
    out = html`<div class="notice info">Free trial: ${days} day${days === 1 ? '' : 's'} left. <a href="#billing">Subscribe</a> to keep booking open after that.</div>`.s;
  } else if (a.subStatus === 'past_due' && S.me.role === 'admin') {
    out = html`<div class="notice warn">Your last subscription payment failed. <a href="#billing">Update your card</a> to avoid interruption.</div>`.s;
  }
  b.innerHTML = out;
}

async function render() {
  let { name, params } = route();
  if (!S.academy.live) {
    renderTabs(S.me.role === 'admin' ? 'billing' : '');
    if (S.me.role === 'admin') { if (name !== 'billing' && name !== 'account') name = 'billing'; }
    else {
      $view.innerHTML = html`<div class="card"><h2>Online booking is paused</h2>
        <p class="muted">${S.academy.name}'s online booking isn't available right now. Please contact the academy.</p>
        <button data-act="logout">Log out</button></div>`.s;
      return;
    }
  }
  // Owners also reach a pro's hours page from Payroll, though it isn't a tab.
  const allowed = [...tabsFor().map(([k]) => k), ...(isAdmin() ? ['hours'] : [])];
  if (!allowed.includes(name)) { name = allowed[0]; history.replaceState(null, '', `#${name}`); }
  renderTabs(name);
  renderBanner();
  $view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await VIEWS[name](params);
  } catch (err) {
    if (err.status === 401) { TT.token.clear(); location.replace(`/a/${TT.slug}`); return; }
    $view.innerHTML = html`<div class="notice error">${err.message}</div>`.s;
  }
}
const rerender = () => render();

// ── Shared lookups (cached) ──────────────────────────────────

async function locations(all = false) {
  if (all) return api('GET', '/api/locations?all=1');
  if (!S.locations) S.locations = await api('GET', '/api/locations');
  return S.locations;
}
async function pros() { if (!S.pros) S.pros = await api('GET', '/api/pros'); return S.pros; }
async function students(force) { if (!S.students || force) S.students = await api('GET', '/api/staff/students'); return S.students; }
async function refreshCredits() { const me = await api('GET', '/api/me'); S.credits = me.credits; return S.credits; }

const levelBadge = (l) => html`<span class="badge ${l}">${cap(l)}</span>`;
const isAdmin = () => S.me.role === 'admin';

function groupByDay(rows, key = 'startsAt') {
  const out = [];
  for (const r of rows) {
    const k = TT.dayKey(r[key]);
    if (!out.length || out[out.length - 1].k !== k) out.push({ k, label: TT.fmtDay(r[key]), rows: [] });
    out[out.length - 1].rows.push(r);
  }
  return out;
}

function creditPills(c) {
  return html`<div class="credits">
    <span class="credit-pill">${c[60]} × 1-hr credit${c[60] === 1 ? '' : 's'}</span>
    <span class="credit-pill">${c[90]} × 1½-hr credit${c[90] === 1 ? '' : 's'}</span>
  </div>`;
}

function courtOptions(locs, selected) {
  return raw(locs.map((l) => html`<optgroup label="${l.name}">${l.courts.map((c) =>
    html`<option value="${c.id}" ${raw(String(c.id) === String(selected) ? 'selected' : '')}>${l.name} — ${c.name}</option>`)}</optgroup>`.s).join(''));
}
function proOptions(list, selected) {
  return raw(list.map((p) => html`<option value="${p.id}" ${raw(String(p.id) === String(selected) ? 'selected' : '')}>${p.name}</option>`.s).join(''));
}
function studentOptions(list, selected, { blank = '' } = {}) {
  return raw((blank ? html`<option value="">${blank}</option>`.s : '') + list.map((s) =>
    html`<option value="${s.id}" ${raw(String(s.id) === String(selected) ? 'selected' : '')}>${s.name} (${s.level})</option>`.s).join(''));
}
function monthOptions(selected, back = 6, fwd = 1) {
  const cur = TT.currentMonth();
  const opts = [];
  for (let i = fwd; i >= -back; i--) {
    const m = TT.addMonths(cur, i);
    opts.push(html`<option value="${m}" ${raw(m === selected ? 'selected' : '')}>${TT.monthLabel(m)}</option>`.s);
  }
  return raw(opts.join(''));
}
// Default datetime-local value: tomorrow at 9:00 academy time.
function defaultStart() {
  const d = TT.isoToZoned(new Date(Date.now() + 864e5).toISOString());
  return `${d.slice(0, 10)}T09:00`;
}

// ── Student views ────────────────────────────────────────────

const VIEWS = {};

VIEWS.book = async (params) => {
  const locs = await locations();
  const locId = params.get('loc') || '';
  const [data, credits] = await Promise.all([
    api('GET', `/api/sessions?days=42${locId ? `&locationId=${locId}` : ''}`),
    refreshCredits(),
  ]);
  if (data.unrated) {
    $view.innerHTML = html`<h1>Book a group lesson</h1>
      <div class="card"><h2>One step first: your skill rating</h2>
      <p>Group lessons are split into beginner, intermediate and advanced. One of our pros will rate your level,
      and you can then book group lessons at that level.</p>
      <p class="muted">To get rated, book a <a href="#private">private lesson</a> or contact
      ${S.academy.contactPhone || S.academy.contactEmail || 'the academy'}.</p></div>`.s;
    return;
  }
  const days = groupByDay(data.sessions);
  const noCredits = credits[60] + credits[90] === 0;
  $view.innerHTML = html`
    <div class="row between"><h1>Book a group lesson</h1>${levelBadge(S.me.level)}</div>
    <div class="card row between">
      <div>${creditPills(credits)}<p class="hint">Each lesson uses one credit of its length. Cancel any time before the start and the credit comes back.</p></div>
      <a class="btn primary" href="#buy">Buy lessons</a>
    </div>
    ${noCredits ? html`<div class="notice warn">You don't have any lesson credits yet. <a href="#buy">Buy a pack</a> to start booking.</div>` : ''}
    <div class="row" style="margin-bottom:8px">
      <label class="small" for="locFilter" style="margin:0">Location</label>
      <select id="locFilter" data-change="locFilter" style="max-width:260px">
        <option value="">All locations</option>
        ${locs.map((l) => html`<option value="${l.id}" ${raw(String(l.id) === locId ? 'selected' : '')}>${l.name}</option>`)}
      </select>
    </div>
    ${days.length ? days.map((d) => html`<div class="day-head">${d.label}</div>
      <div class="list">${d.rows.map((s) => sessionItemForStudent(s, credits))}</div>`)
    : html`<div class="empty card">No ${S.me.level} lessons scheduled in the next six weeks${locId ? ' at this location' : ''}. Check back soon.</div>`}`.s;
};

function sessionItemForStudent(s, credits) {
  const left = s.capacity - s.booked;
  let action;
  if (s.myBookingId) action = html`<span class="badge ok">Booked</span> <button class="sm" data-act="cancelBooking" data-id="${s.myBookingId}" data-when="${s.startsAt}">Cancel</button>`;
  else if (left <= 0) action = html`<span class="badge">Full</span>`;
  else if (!credits[s.durationMinutes]) action = html`<a class="btn sm" href="#buy">Buy ${TT.length(s.durationMinutes)} credit</a>`;
  else action = html`<button class="primary sm" data-act="book" data-id="${s.id}">Book</button>`;
  return html`<div class="item">
    <div class="main">
      <div class="when">${TT.fmtTime(s.startsAt)} – ${TT.endTime(s.startsAt, s.durationMinutes)} <span class="muted small">(${TT.length(s.durationMinutes)})</span></div>
      <div class="small muted">${s.locationName} · ${s.courtName} · with ${s.proName}</div>
      ${s.notes ? html`<div class="small">${s.notes}</div>` : ''}
    </div>
    <span class="small ${left <= 1 ? '' : 'muted'}">${left > 0 ? `${left} spot${left === 1 ? '' : 's'} left` : ''}</span>
    ${action}
  </div>`;
}

VIEWS.my = async () => {
  const [upcoming, priv, credits] = await Promise.all([
    api('GET', '/api/my/bookings'), api('GET', '/api/my/private'), refreshCredits()]);
  const now = Date.now();
  const futurePriv = priv.filter((p) => new Date(p.startsAt).getTime() > now - 3 * 3600e3);
  $view.innerHTML = html`<h1>My lessons</h1>
    <div class="card">${creditPills(credits)}</div>
    <h2>Group lessons</h2>
    ${upcoming.length ? html`<div class="list">${upcoming.map((b) => html`<div class="item">
        <div class="main">
          <div class="when">${TT.fmtDateTime(b.startsAt)} <span class="muted small">(${TT.length(b.durationMinutes)})</span></div>
          <div class="small muted">${b.locationName} · ${b.courtName} · with ${b.proName}</div>
          ${b.status === 'cancelled' ? html`<div class="small" style="color:var(--danger)">Cancelled by the academy${b.cancelReason ? ` (${b.cancelReason})` : ''} — your credit was returned.</div>` : ''}
        </div>
        ${levelBadge(b.level)}
        ${b.status === 'scheduled' && b.bookingStatus === 'booked' && new Date(b.startsAt) > now
          ? html`<button class="sm" data-act="cancelBooking" data-id="${b.bookingId}" data-when="${b.startsAt}">Cancel</button>` : ''}
      </div>`)}</div>`
    : html`<div class="empty card">No group lessons booked. <a href="#book">Find a lesson</a></div>`}
    <h2 style="margin-top:24px">Private lessons</h2>
    ${futurePriv.length ? html`<div class="list">${futurePriv.map((p) => html`<div class="item">
        <div class="main">
          <div class="when">${TT.fmtDateTime(p.startsAt)} <span class="muted small">(${TT.length(p.durationMinutes)})</span></div>
          <div class="small muted">${p.locationName} · ${p.courtName} · with ${p.proName}</div>
          <div class="small">${p.studentPaid ? html`<span class="badge ok">Paid</span>`
            : html`Pay ${money(p.priceCents)} to ${p.proName} by Zelle${p.proZelle ? html`: <strong>${p.proZelle}</strong>` : ''}`}</div>
        </div>
        ${new Date(p.startsAt) > now ? html`<button class="sm" data-act="cancelPrivate" data-id="${p.id}">Cancel</button>` : ''}
      </div>`)}</div>`
    : html`<div class="empty card">No private lessons booked. <a href="#private">See open times</a></div>`}
    <p style="margin-top:20px"><button class="link" data-act="showPast">Show past lessons</button></p>
    <div id="past"></div>`.s;
};

VIEWS.buy = async (params) => {
  const sp = new URLSearchParams(location.search);
  if (sp.get('checkout') === 'success' && sp.get('session_id')) {
    try {
      const r = await api('POST', '/api/purchases/confirm', { sessionId: sp.get('session_id') });
      toast(r.paid ? 'Payment received — your credits are ready.' : 'Payment is processing — credits appear once it clears.');
    } catch (err) { toast(err.message, true); }
    history.replaceState(null, '', `${location.pathname}#buy`);
  } else if (sp.get('checkout') === 'cancelled') {
    toast('Checkout cancelled — nothing was charged.');
    history.replaceState(null, '', `${location.pathname}#buy`);
  }
  const [packs, credits, purchases] = await Promise.all([api('GET', '/api/packs'), api('GET', '/api/my/credits'), api('GET', '/api/my/purchases')]);
  const cur = TT.currentMonth();
  const month = params.get('month') || cur;
  const byLen = [60, 90].map((m) => ({ m, packs: packs.filter((p) => p.durationMinutes === m) })).filter((g) => g.packs.length);
  const soon = credits.summary.soonest || {};
  $view.innerHTML = html`<h1>Buy lessons</h1>
    <div class="card">
      ${creditPills(credits.summary)}
      ${soon[60] || soon[90] ? html`<p class="hint">${[60, 90].filter((m) => soon[m]).map((m) => `Next ${TT.length(m)} credit expires ${TT.fmtDate(soon[m] + 'T12:00:00Z')}`).join(' · ')}</p>` : ''}
    </div>
    <div class="row" style="margin-bottom:12px">
      <label for="buyMonth" style="margin:0">Lessons for</label>
      <select id="buyMonth" data-change="buyMonth" style="max-width:220px">
        ${[0, 1, 2].map((i) => { const m = TT.addMonths(cur, i); return html`<option value="${m}" ${raw(m === month ? 'selected' : '')}>${TT.monthLabel(m)}</option>`; })}
      </select>
    </div>
    <p class="hint" style="margin-top:-6px">Credits can be used any time until the end of the month after.</p>
    ${byLen.map((g) => html`<h2 style="margin-top:16px">${g.m === 60 ? '1-hour' : '1½-hour'} group lessons</h2>
      <div class="grid grid-2">${g.packs.map((p) => html`<div class="card">
        <h3>${p.name}</h3>
        <div class="price">${money(p.priceCents)}</div>
        <p class="muted small">${p.lessonCount} lesson${p.lessonCount === 1 ? '' : 's'} · ${money(p.priceCents / p.lessonCount)} each</p>
        <button class="primary block" data-act="buyPack" data-id="${p.id}" data-month="${month}">Buy</button>
      </div>`)}</div>`)}
    ${!packs.length ? html`<div class="empty card">No lesson packs are on sale right now.</div>` : ''}
    ${S.academy.devPayments ? html`<p class="hint">Test mode: card payments aren't connected, so purchases complete instantly.</p>` : ''}
    <h2 style="margin-top:24px">Purchase history</h2>
    ${purchases.length ? html`<div class="table-wrap"><table>
      <tr><th>Date</th><th>Pack</th><th>For</th><th class="num">Amount</th><th>Status</th></tr>
      ${purchases.map((p) => html`<tr><td>${TT.fmtDate(p.createdAt)}</td><td>${p.packName}</td><td>${TT.monthLabel(p.forMonth)}</td>
        <td class="num">${money(p.amountCents)}</td><td>${p.status === 'paid' ? html`<span class="badge ok">Paid</span>` : html`<span class="badge warn">Pending</span>`}</td></tr>`)}
    </table></div>` : html`<p class="muted">No purchases yet.</p>`}`.s;
};

VIEWS.private = async () => {
  const [open, mine] = await Promise.all([api('GET', '/api/private/open'), api('GET', '/api/my/private')]);
  const days = groupByDay(open);
  $view.innerHTML = html`<h1>Private lessons</h1>
    <p class="muted">Book an open time with one of our pros. You pay the pro directly by Zelle.</p>
    ${mine.length ? html`<div class="notice info">You have ${mine.length} private lesson${mine.length === 1 ? '' : 's'} booked — see <a href="#my">My lessons</a>.</div>` : ''}
    ${days.length ? days.map((d) => html`<div class="day-head">${d.label}</div><div class="list">${d.rows.map((p) => html`<div class="item">
      <div class="main">
        <div class="when">${TT.fmtTime(p.startsAt)} – ${TT.endTime(p.startsAt, p.durationMinutes)}</div>
        <div class="small muted">${p.locationName} · ${p.courtName} · with ${p.proName}</div>
      </div>
      <strong>${money(p.priceCents)}</strong>
      <button class="primary sm" data-act="bookPrivate" data-id="${p.id}" data-pro="${p.proName}" data-price="${p.priceCents}" data-zelle="${p.proZelle || ''}" data-when="${p.startsAt}">Book</button>
    </div>`)}</div>`)
    : html`<div class="empty card">No open private-lesson times right now. Contact ${S.academy.contactPhone || S.academy.contactEmail || 'the academy'} to arrange one.</div>`}`.s;
};

VIEWS.account = async () => {
  const u = S.me;
  $view.innerHTML = html`<h1>Account</h1>
    <form class="card" data-form="profile" novalidate>
      <h2>Your details</h2>
      <div class="form-row">
        <div><label>Name</label><input name="name" value="${u.name}"></div>
        <div><label>Mobile phone</label><input name="phone" type="tel" value="${u.phone || ''}"></div>
      </div>
      <label>Email</label><input value="${u.email}" disabled>
      ${u.role !== 'student' ? html`<label>Zelle (email or phone)</label><input name="zelleHandle" value="${u.zelleHandle || ''}">
        <p class="hint">Shown to students who book a private lesson with you.</p>` : ''}
      ${u.role === 'student' ? html`<p style="margin-top:12px">Skill level: ${levelBadge(u.level)}</p>` : ''}
      <button class="primary" type="submit" style="margin-top:12px">Save</button>
    </form>
    <form class="card" data-form="password" novalidate>
      <h2>Change password</h2>
      <div class="form-row">
        <div><label>Current password</label><input name="currentPassword" type="password" autocomplete="current-password"></div>
        <div><label>New password</label><input name="newPassword" type="password" autocomplete="new-password"></div>
      </div>
      <button type="submit" style="margin-top:12px">Change password</button>
    </form>
    <button data-act="logout">Log out</button>`.s;
};

// ── Staff views ──────────────────────────────────────────────

VIEWS.sessions = async (params) => {
  const everyone = isAdmin() ? params.get('mine') !== '1' : params.get('mine') === '0';
  const level = params.get('level') || '';
  const q = new URLSearchParams({ mine: everyone ? '0' : '1', to: new Date(Date.now() + 42 * 864e5).toISOString() });
  let rows = await api('GET', `/api/staff/sessions?${q}`);
  if (level) rows = rows.filter((s) => s.level === level);
  const days = groupByDay(rows);
  $view.innerHTML = html`<div class="row between"><h1>${isAdmin() ? 'Schedule' : 'My schedule'}</h1>
      <div class="row"><button class="primary" data-act="newSession">+ Group lesson</button></div></div>
    <div class="row" style="margin-bottom:8px">
      <select data-change="schedScope" style="max-width:200px">
        <option value="mine" ${raw(!everyone ? 'selected' : '')}>My lessons</option>
        <option value="all" ${raw(everyone ? 'selected' : '')}>All pros</option>
      </select>
      <select data-change="schedLevel" style="max-width:200px">
        <option value="">All levels</option>
        ${['beginner', 'intermediate', 'advanced'].map((l) => html`<option value="${l}" ${raw(l === level ? 'selected' : '')}>${cap(l)}</option>`)}
      </select>
    </div>
    ${days.length ? days.map((d) => html`<div class="day-head">${d.label}</div><div class="list">${d.rows.map((s) => html`
      <div class="item">
        <div class="main">
          <div class="when">${TT.fmtTime(s.startsAt)} – ${TT.endTime(s.startsAt, s.durationMinutes)} ${levelBadge(s.level)}</div>
          <div class="small muted">${s.locationName} · ${s.courtName}${everyone ? ` · ${s.proName}` : ''}${s.seriesId ? ' · weekly' : ''}</div>
        </div>
        <span class="small"><strong>${s.booked}</strong>/${s.capacity} booked</span>
        <button class="sm" data-act="openSession" data-id="${s.id}">Roster</button>
      </div>`)}</div>`)
    : html`<div class="empty card">No group lessons in the next six weeks. Use “+ Group lesson” to post some.</div>`}`.s;
};

VIEWS.students = async (params) => {
  const level = params.get('level') || '';
  const list = await students(true);
  const q = (params.get('q') || '').toLowerCase();
  const rows = list.filter((s) => (!level || s.level === level) && (!q || `${s.name} ${s.email} ${s.phone || ''}`.toLowerCase().includes(q)));
  const unrated = list.filter((s) => s.level === 'unrated').length;
  $view.innerHTML = html`<div class="row between"><h1>Students</h1>
      ${isAdmin() ? html`<button data-act="newUser" data-role="student">+ Add student</button>` : ''}</div>
    ${unrated ? html`<div class="notice warn">${unrated} student${unrated === 1 ? '' : 's'} waiting for a skill rating — they can't book group lessons until rated.</div>` : ''}
    <div class="row" style="margin-bottom:12px">
      <input type="search" placeholder="Search name, email, phone" value="${params.get('q') || ''}" data-change="studentSearch" style="max-width:280px">
      <select data-change="studentLevel" style="max-width:200px">
        <option value="">All levels</option>
        ${['unrated', 'beginner', 'intermediate', 'advanced'].map((l) => html`<option value="${l}" ${raw(l === level ? 'selected' : '')}>${cap(l)}</option>`)}
      </select>
    </div>
    ${rows.length ? html`<div class="table-wrap"><table>
      <tr><th>Name</th><th>Level</th><th>Contact</th><th class="num">Credits</th><th></th></tr>
      ${rows.map((s) => html`<tr>
        <td><button class="link" data-act="openStudent" data-id="${s.id}">${s.name}</button>
          ${s.levelNotes ? html`<div class="small muted">${s.levelNotes}</div>` : ''}</td>
        <td>${levelBadge(s.level)}${s.ratedBy ? html`<div class="small muted">by ${s.ratedBy}</div>` : ''}</td>
        <td class="small">${s.email}<br>${s.phone || ''}</td>
        <td class="num">${s.freeCredits}</td>
        <td><button class="sm" data-act="rate" data-id="${s.id}">Rate</button></td>
      </tr>`)}
    </table></div>` : html`<div class="empty card">No students match.</div>`}`.s;
};

VIEWS.privates = async (params) => {
  const month = params.get('month') || '';
  const rows = await api('GET', `/api/staff/private${month ? `?month=${month}` : ''}`);
  const days = groupByDay(rows);
  $view.innerHTML = html`<div class="row between"><h1>Private lessons</h1>
      <button class="primary" data-act="newPrivate">+ Private lesson / open time</button></div>
    <p class="muted small">Students pay the pro by Zelle. Each lesson owes the academy a court fee of ${money(rows[0] ? rows[0].academyFeeCents * 60 / rows[0].durationMinutes : 2000)}/hr.</p>
    <div class="row" style="margin-bottom:8px">
      <select data-change="privMonth" style="max-width:220px">
        <option value="">Upcoming</option>${monthOptions(month)}
      </select>
    </div>
    ${days.length ? days.map((d) => html`<div class="day-head">${d.label}</div><div class="list">${d.rows.map((p) => html`
      <div class="item">
        <div class="main">
          <div class="when">${TT.fmtTime(p.startsAt)} – ${TT.endTime(p.startsAt, p.durationMinutes)}
            ${p.status === 'open' ? html`<span class="badge">Open</span>` : ''}</div>
          <div class="small muted">${p.locationName} · ${p.courtName}${isAdmin() ? ` · ${p.proName}` : ''}</div>
          <div class="small">${p.studentName ? html`<strong>${p.studentName}</strong> ${p.studentPhone || ''}` : 'No student yet'}
            · ${money(p.priceCents)} (academy fee ${money(p.academyFeeCents)})</div>
        </div>
        ${p.studentId ? html`<label class="check small"><input type="checkbox" data-act="privPaid" data-id="${p.id}" ${raw(p.studentPaid ? 'checked' : '')}> Student paid</label>` : ''}
        ${p.studentId ? html`<label class="check small"><input type="checkbox" data-act="privFee" data-id="${p.id}" ${raw(p.feePaid ? 'checked' : '')} ${raw(isAdmin() ? '' : 'disabled')}> Court fee in</label>` : ''}
        <button class="sm" data-act="editPrivate" data-id="${p.id}" data-student="${p.studentId || ''}">Edit</button>
      </div>`)}</div>`)
    : html`<div class="empty card">Nothing here. Post open times so students can book you, or add a lesson you've arranged.</div>`}`.s;
};

VIEWS.hours = async (params) => {
  const month = params.get('month') || TT.currentMonth();
  const proId = params.get('pro') || '';
  const h = await api('GET', `/api/staff/hours?month=${month}${proId ? `&proId=${proId}` : ''}`);
  const p = h.private;
  $view.innerHTML = html`<div class="row between"><h1>${proId ? `${h.pro.name}'s hours` : 'My hours'}</h1>
      ${proId ? html`<a href="#payroll?month=${month}" class="btn sm">← Payroll</a>` : ''}</div>
    <div class="row" style="margin-bottom:12px">
      <select data-change="hoursMonth" data-pro="${proId}" style="max-width:220px">${monthOptions(month)}</select>
    </div>
    <div class="stats">
      <div class="stat"><div class="n">${h.groupHours}</div><div class="l">Group hours taught</div></div>
      <div class="stat"><div class="n">${h.upcomingHours}</div><div class="l">Group hours still scheduled</div></div>
      <div class="stat"><div class="n">${money(h.groupPayCents)}</div><div class="l">Group pay at ${money(h.pro.hourlyRateCents)}/hr</div></div>
      <div class="stat"><div class="n">${p.n}</div><div class="l">Private lessons</div></div>
      <div class="stat"><div class="n">${money(p.feeOwedCents)}</div><div class="l">Court fees still owed to academy</div></div>
    </div>
    ${h.payrollPaid ? html`<div class="notice info">Group pay for ${TT.monthLabel(month)} marked paid (${money(h.payrollPaid.amountCents)}) on ${TT.fmtDate(h.payrollPaid.paidAt)}.</div>` : ''}
    <h2>Group lessons in ${TT.monthLabel(month)}</h2>
    ${h.sessions.length ? html`<div class="table-wrap"><table>
      <tr><th>Date</th><th>Level</th><th>Where</th><th class="num">Hours</th><th class="num">Students</th><th>Status</th></tr>
      ${h.sessions.map((s) => html`<tr><td>${TT.fmtDateTime(s.startsAt)}</td><td>${levelBadge(s.level)}</td>
        <td class="small">${s.locationName} · ${s.courtName}</td><td class="num">${s.durationMinutes / 60}</td>
        <td class="num">${s.booked}</td><td>${s.ended ? html`<span class="badge ok">Taught</span>` : html`<span class="badge">Upcoming</span>`}</td></tr>`)}
    </table></div>` : html`<p class="muted">No group lessons this month.</p>`}`.s;
};

// ── Admin views ──────────────────────────────────────────────

VIEWS.dashboard = async () => {
  const s = await api('GET', '/api/admin/summary');
  const link = `${location.origin}/a/${S.academy.slug}`;
  const steps = [
    [s.locations > 0, 'Add your courts', '#setup'],
    [s.pros > 0, 'Add your tennis pros', '#setup'],
    [s.stripeConnected, 'Connect Stripe so students can pay by card', '#setup'],
    [s.sessionsNext7 > 0, 'Post your first group lessons', '#sessions'],
    [s.students > 0, 'Share your booking link with students', null],
  ];
  const todo = steps.filter((x) => !x[0]);
  $view.innerHTML = html`<h1>Dashboard</h1>
    <div class="stats">
      <div class="stat"><div class="n">${money(s.revenueCents)}</div><div class="l">Lesson sales in ${TT.monthLabel(s.month)}</div></div>
      <div class="stat"><div class="n">${s.purchases}</div><div class="l">Packs sold this month</div></div>
      <div class="stat"><div class="n">${s.students}</div><div class="l">Students</div></div>
      <div class="stat"><div class="n">${s.unrated}</div><div class="l">Waiting for a rating</div></div>
      <div class="stat"><div class="n">${s.sessionsNext7}</div><div class="l">Group lessons next 7 days</div></div>
      <div class="stat"><div class="n">${s.bookingsNext7}</div><div class="l">Students booked next 7 days</div></div>
      <div class="stat"><div class="n">${money(s.courtFeesOwedCents)}</div><div class="l">Court fees owed by pros</div></div>
    </div>
    <div class="card">
      <h2>Your booking page</h2>
      <p class="muted">Send students here to sign up, buy lessons and book.</p>
      <div class="row"><input readonly value="${link}" style="flex:1;min-width:200px"><button data-act="copy" data-text="${link}">Copy link</button></div>
    </div>
    ${todo.length ? html`<div class="card"><h2>Getting started</h2><div class="list">
      ${steps.map(([done, label, href]) => html`<div class="row"><span class="badge ${done ? 'ok' : ''}">${done ? 'Done' : 'To do'}</span>
        ${href && !done ? html`<a href="${href}">${label}</a>` : html`<span>${label}</span>`}</div>`)}
    </div></div>` : ''}`.s;
};

VIEWS.payroll = async (params) => {
  const month = params.get('month') || TT.currentMonth();
  const r = await api('GET', `/api/admin/payroll?month=${month}`);
  const tot = r.rows.reduce((a, x) => ({ h: a.h + x.groupHours, pay: a.pay + x.groupPayCents, fee: a.fee + x.courtFeesOwedCents }), { h: 0, pay: 0, fee: 0 });
  $view.innerHTML = html`<h1>Payroll</h1>
    <p class="muted">Group-lesson hours count once a lesson has ended and wasn't cancelled. Private-lesson court fees are what each pro owes the academy.</p>
    <div class="row" style="margin-bottom:12px"><select data-change="payrollMonth" style="max-width:220px">${monthOptions(month)}</select></div>
    <div class="stats">
      <div class="stat"><div class="n">${tot.h}</div><div class="l">Group hours taught</div></div>
      <div class="stat"><div class="n">${money(tot.pay)}</div><div class="l">Group pay owed to pros</div></div>
      <div class="stat"><div class="n">${money(tot.fee)}</div><div class="l">Court fees owed to academy</div></div>
    </div>
    ${r.rows.length ? html`<div class="table-wrap"><table>
      <tr><th>Pro</th><th class="num">Group hrs</th><th class="num">Rate</th><th class="num">Group pay</th><th class="num">Private lessons</th><th class="num">Court fees owed</th><th>Paid?</th></tr>
      ${r.rows.map((x) => html`<tr>
        <td><a href="#hours?month=${month}&pro=${x.proId}">${x.name}</a>
          ${x.emptySessions ? html`<div class="small muted">${x.emptySessions} lesson${x.emptySessions === 1 ? '' : 's'} with no students</div>` : ''}
          ${x.upcomingHours ? html`<div class="small muted">+${x.upcomingHours} hrs still scheduled</div>` : ''}</td>
        <td class="num">${x.groupHours}</td>
        <td class="num">${x.hourlyRateCents ? money(x.hourlyRateCents) : html`<button class="link small" data-act="editUser" data-id="${x.proId}">Set rate</button>`}</td>
        <td class="num"><strong>${money(x.groupPayCents)}</strong></td>
        <td class="num">${x.privateLessons}</td>
        <td class="num">${money(x.courtFeesOwedCents)}${x.courtFeesCents > x.courtFeesOwedCents ? html`<div class="small muted">${money(x.courtFeesCents - x.courtFeesOwedCents)} received</div>` : ''}</td>
        <td>${x.paid ? html`<span class="badge ok">Paid ${money(x.paid.amountCents)}</span> <button class="link small" data-act="payrollUndo" data-id="${x.proId}" data-month="${month}">Undo</button>`
          : html`<button class="sm" data-act="payrollPaid" data-id="${x.proId}" data-month="${month}" data-name="${x.name}" data-amount="${x.groupPayCents}">Mark paid</button>`}</td>
      </tr>`)}
    </table></div>` : html`<div class="empty card">No pro activity this month.</div>`}`.s;
};

VIEWS.payments = async (params) => {
  const month = params.get('month') || TT.currentMonth();
  const rows = await api('GET', `/api/admin/purchases?month=${month}`);
  const paid = rows.filter((r) => r.status === 'paid');
  const total = paid.reduce((a, r) => a + r.amountCents, 0);
  $view.innerHTML = html`<div class="row between"><h1>Payments</h1><button class="primary" data-act="recordPayment">+ Record cash / check / Zelle</button></div>
    <div class="row" style="margin-bottom:12px"><select data-change="paymentsMonth" style="max-width:220px">${monthOptions(month)}</select>
      <span class="muted">${paid.length} paid · <strong>${money(total)}</strong></span></div>
    ${rows.length ? html`<div class="table-wrap"><table>
      <tr><th>Date</th><th>Student</th><th>Pack</th><th>For</th><th>Method</th><th class="num">Amount</th><th>Status</th></tr>
      ${rows.map((p) => html`<tr><td>${TT.fmtDate(p.paidAt || p.createdAt)}</td>
        <td><button class="link" data-act="openStudent" data-id="${p.studentId}">${p.studentName}</button></td>
        <td>${p.packName}</td><td>${TT.monthLabel(p.forMonth)}</td><td>${p.method === 'stripe' ? 'Card' : cap(p.method)}</td>
        <td class="num">${money(p.amountCents)}</td>
        <td>${p.status === 'paid' ? html`<span class="badge ok">Paid</span>` : html`<span class="badge warn">Pending</span>`}</td></tr>`)}
    </table></div>` : html`<div class="empty card">No payments this month.</div>`}
    <p class="hint">Refunds for card payments are made in your Stripe dashboard; then remove the matching credits from the student's page.</p>`.s;
};

VIEWS.setup = async () => {
  const [locs, packs, staff, settings] = await Promise.all([
    locations(true), api('GET', '/api/admin/packs'), api('GET', '/api/admin/users?role=pro'), api('GET', '/api/admin/settings')]);
  const admins = await api('GET', '/api/admin/users?role=admin');
  const st = settings.settings;
  $view.innerHTML = html`<h1>Setup</h1>
    <section class="card">
      <div class="row between"><h2>Locations & courts</h2><button class="sm primary" data-act="newLocation">+ Location</button></div>
      ${locs.length ? locs.map((l) => html`<div style="margin:12px 0;padding-top:12px;border-top:1px solid var(--border)">
        <div class="row between"><div><strong>${l.name}</strong> ${l.active ? '' : html`<span class="badge">Hidden</span>`}
          <div class="small muted">${l.address || ''}</div></div>
          <div class="row"><button class="sm" data-act="addCourt" data-id="${l.id}">+ Court</button>
          <button class="sm" data-act="editLocation" data-id="${l.id}" data-name="${l.name}" data-address="${l.address || ''}" data-active="${l.active}">Edit</button></div></div>
        <div class="row" style="margin-top:8px">${l.courts.map((c) => html`<button class="sm ${c.active ? '' : 'muted'}" data-act="editCourt" data-id="${c.id}" data-name="${c.name}" data-active="${c.active}">${c.name}${c.active ? '' : ' (off)'}</button>`)}</div>
      </div>`) : html`<p class="muted">No locations yet. Add where you teach, e.g. "Cal Lutheran" with 7 courts.</p>`}
    </section>

    <section class="card">
      <div class="row between"><h2>Tennis pros & staff</h2><button class="sm primary" data-act="newUser" data-role="pro">+ Pro</button></div>
      <div class="table-wrap" style="margin-top:8px"><table>
        <tr><th>Name</th><th>Role</th><th class="num">Group pay/hr</th><th class="num">Private rate/hr</th><th>Zelle</th><th></th></tr>
        ${[...admins, ...staff].map((u) => html`<tr>
          <td>${u.name}${u.active ? '' : html` <span class="badge">Inactive</span>`}<div class="small muted">${u.email}</div></td>
          <td>${u.role === 'admin' ? 'Owner' : 'Pro'}</td>
          <td class="num">${money(u.hourlyRateCents)}</td><td class="num">${money(u.privateRateCents)}</td>
          <td class="small">${u.zelleHandle || '—'}</td>
          <td><button class="sm" data-act="editUser" data-id="${u.id}">Edit</button></td></tr>`)}
      </table></div>
    </section>

    <section class="card">
      <div class="row between"><h2>Lesson packs & prices</h2><button class="sm primary" data-act="editPack">+ Pack</button></div>
      <div class="table-wrap" style="margin-top:8px"><table>
        <tr><th>Name</th><th>Length</th><th class="num">Lessons</th><th class="num">Price</th><th class="num">Per lesson</th><th></th></tr>
        ${packs.map((p) => html`<tr class="${p.active ? '' : 'muted'}"><td>${p.name}${p.active ? '' : ' (hidden)'}</td><td>${TT.length(p.durationMinutes)}</td>
          <td class="num">${p.lessonCount}</td><td class="num">${money(p.priceCents)}</td><td class="num">${money(p.priceCents / p.lessonCount)}</td>
          <td><button class="sm" data-act="editPack" data-pack='${JSON.stringify(p)}'>Edit</button></td></tr>`)}
      </table></div>
    </section>

    <form class="card" data-form="settings" novalidate>
      <h2>Academy settings</h2>
      <div class="form-row">
        <div><label>Academy name</label><input name="name" value="${settings.name}"></div>
        <div><label>Time zone</label><input name="timezone" value="${settings.timezone}"><p class="hint">e.g. America/Los_Angeles</p></div>
        <div><label>Contact email</label><input name="contact_email" value="${st.contact_email}"></div>
        <div><label>Contact phone</label><input name="contact_phone" type="tel" value="${st.contact_phone}"></div>
        <div><label>Court fee per private hour ($)</label><input name="court_fee" inputmode="decimal" value="${(st.private_court_fee_cents_per_hour / 100).toFixed(2)}"><p class="hint">What a pro owes the academy per private-lesson hour.</p></div>
        <div><label>Default private rate per hour ($)</label><input name="private_rate" inputmode="decimal" value="${(st.default_private_rate_cents / 100).toFixed(2)}"></div>
        <div><label>Default group size</label><input name="default_group_capacity" type="number" min="1" value="${st.default_group_capacity}"></div>
        <div><label>Extra months credits stay valid</label><input name="credit_grace_months" type="number" min="0" max="12" value="${st.credit_grace_months}">
          <p class="hint">1 = credits bought for October can be used through November.</p></div>
      </div>
      <button class="primary" type="submit" style="margin-top:12px">Save settings</button>
    </form>

    <form class="card" data-form="stripe" novalidate>
      <h2>Card payments (Stripe)</h2>
      <p class="muted small">Students pay <strong>your</strong> Stripe account directly when they buy lesson packs.
        ${settings.stripeConnected ? html`Connected: <code>${settings.stripeKeyHint}</code>.` : 'Not connected yet.'}</p>
      <details ${raw(settings.stripeConnected ? '' : 'open')}><summary class="small">How to connect</summary>
        <ol class="small">
          <li>Log in at dashboard.stripe.com → <strong>Developers</strong> → <strong>API keys</strong>. Copy the <strong>Secret key</strong> (starts with <code>sk_live_</code>).</li>
          <li>Recommended: Developers → <strong>Webhooks</strong> → <strong>Add endpoint</strong>, URL <code>${settings.webhookUrl}</code>,
            event <code>checkout.session.completed</code>. Copy its <strong>Signing secret</strong> (starts with <code>whsec_</code>).</li>
        </ol></details>
      <div class="form-row">
        <div><label>Secret key</label><input name="secretKey" autocomplete="off" placeholder="${settings.stripeConnected ? 'Leave blank to keep current key' : 'sk_live_…'}"></div>
        <div><label>Webhook signing secret ${settings.stripeWebhookSet ? '(saved)' : ''}</label><input name="webhookSecret" autocomplete="off" placeholder="whsec_…"></div>
      </div>
      <div class="row" style="margin-top:12px"><button class="primary" type="submit">Save</button>
        ${settings.stripeConnected ? html`<button type="button" class="danger" data-act="disconnectStripe">Disconnect</button>` : ''}</div>
    </form>`.s;
};

VIEWS.billing = async () => {
  const sp = new URLSearchParams(location.search);
  if (sp.get('billing') === 'success') { toast('Thanks — your subscription is active.'); history.replaceState(null, '', `${location.pathname}#billing`); }
  const b = await api('GET', '/api/billing/status');
  const labels = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Cancelled', comped: 'Complimentary' };
  $view.innerHTML = html`<h1>Billing</h1>
    <div class="card">
      <p>Status: <span class="badge ${b.live ? 'ok' : 'danger'}">${labels[b.subStatus] || b.subStatus}</span></p>
      ${b.subStatus === 'trialing' ? html`<p>Your free trial ${b.live ? 'ends' : 'ended'} on <strong>${TT.fmtDate(b.trialEndsAt)}</strong>.</p>` : ''}
      ${b.currentPeriodEnd && b.subStatus !== 'trialing' ? html`<p class="muted">Current period ends ${TT.fmtDate(b.currentPeriodEnd)}.</p>` : ''}
      ${!b.live ? html`<div class="notice warn">Students and pros can't use the app until the subscription is active.</div>` : ''}
      ${b.priceLabel ? html`<p class="price">${b.priceLabel}</p>` : ''}
      <div class="row">
        ${b.subStatus !== 'comped' && (!b.hasSubscription || b.subStatus === 'canceled') ? html`<button class="primary" data-act="subscribe">Subscribe</button>` : ''}
        ${b.hasSubscription ? html`<button data-act="billingPortal">Manage payment method & invoices</button>` : ''}
      </div>
      ${!b.billingEnabled ? html`<p class="hint">Test mode: billing isn't connected, so Subscribe activates instantly.</p>` : ''}
    </div>`.s;
};

// ── Modals used by actions ───────────────────────────────────

async function sessionModal(existing) {
  const [locs, proList] = await Promise.all([locations(), isAdmin() ? pros() : Promise.resolve([])]);
  if (!locs.length) { toast('Add a location with courts in Setup first.', true); return; }
  const s = existing || {};
  modal({
    title: existing ? 'Edit group lesson' : 'New group lesson',
    body: html`<div class="form-row">
        <div><label>Level</label><select name="level">${['beginner', 'intermediate', 'advanced'].map((l) => html`<option value="${l}" ${raw(s.level === l ? 'selected' : '')}>${cap(l)}</option>`)}</select></div>
        <div><label>Length</label><select name="durationMinutes"><option value="60">1 hour</option><option value="90" ${raw(s.durationMinutes === 90 ? 'selected' : '')}>1½ hours</option></select></div>
      </div>
      <label>Starts (${TT.tz.replace('_', ' ')} time)</label>
      <input name="startsAt" type="datetime-local" step="900" value="${s.startsAt ? TT.isoToZoned(s.startsAt) : defaultStart()}">
      <label>Court</label><select name="courtId">${courtOptions(locs, s.courtId)}</select>
      ${isAdmin() ? html`<label>Pro</label><select name="proId">${proOptions(proList, s.proId || S.me.id)}</select>` : ''}
      <div class="form-row">
        <div><label>Max students</label><input name="capacity" type="number" min="1" max="40" value="${s.capacity || ''}" placeholder="default"></div>
        ${existing ? '' : html`<div><label>Repeat weekly for</label><select name="repeatWeeks">${[1, 2, 4, 6, 8, 10, 12, 16].map((n) => html`<option value="${n}">${n === 1 ? 'Just once' : `${n} weeks`}</option>`)}</select></div>`}
      </div>
      <label>Notes for students (optional)</label><input name="notes" value="${s.notes || ''}" placeholder="e.g. Bring water — drills & match play">`,
    submitLabel: existing ? 'Save' : 'Post lesson',
    onSubmit: async (v) => {
      const body = { ...v, startsAt: TT.zonedToIso(v.startsAt), capacity: v.capacity || undefined };
      if (existing) await api('PUT', `/api/staff/sessions/${existing.id}`, body);
      else { const r = await api('POST', '/api/staff/sessions', body); toast(`Posted ${r.created} lesson${r.created === 1 ? '' : 's'}.`); }
      rerender();
    },
  });
}

async function openSessionModal(id) {
  const s = await api('GET', `/api/staff/sessions/${id}`);
  const canEdit = isAdmin() || s.proId === S.me.id;
  const started = new Date(s.startsAt) <= new Date();
  const m = modal({
    title: `${cap(s.level)} · ${TT.fmtDateTime(s.startsAt)}`,
    wide: true,
    body: html`<p class="muted">${TT.length(s.durationMinutes)} · ${s.locationName} · ${s.courtName} · ${s.proName} · ${s.booked}/${s.capacity} booked</p>
      ${s.notes ? html`<p>${s.notes}</p>` : ''}
      ${s.roster.length ? html`<div class="table-wrap"><table>
        <tr><th>Student</th><th>Contact</th><th>Here?</th>${canEdit ? html`<th></th>` : ''}</tr>
        ${s.roster.map((r) => html`<tr><td>${r.name} ${r.level !== s.level ? levelBadge(r.level) : ''}</td>
          <td class="small">${r.phone || ''}<br>${r.email}</td>
          <td>${canEdit ? html`<input type="checkbox" data-act="attend" data-session="${s.id}" data-id="${r.bookingId}" ${raw(r.attended ? 'checked' : '')} aria-label="Attended">` : (r.attended ? '✓' : '')}</td>
          ${canEdit ? html`<td><button class="sm" data-act="staffCancelBooking" data-id="${r.bookingId}" data-session="${s.id}">Remove</button></td>` : ''}</tr>`)}
      </table></div>` : html`<p class="muted">No students booked yet.</p>`}
      ${canEdit && !started ? html`<div class="row" style="margin-top:14px">
        <button class="sm" data-act="addToSession" data-id="${s.id}" data-level="${s.level}">+ Add a student</button>
        <button class="sm" data-act="editSession" data-id="${s.id}">Edit</button>
        <button class="sm danger" data-act="cancelSession" data-id="${s.id}" data-series="${s.seriesId || ''}" data-booked="${s.booked}">Cancel lesson</button>
      </div>` : ''}`,
  });
  m.dataset.sessionModal = s.id;
}

async function studentModal(id) {
  const d = await api('GET', `/api/staff/students/${id}`);
  const u = d.user;
  modal({
    title: u.name,
    wide: true,
    body: html`<p>${levelBadge(u.level)} <span class="muted small">${u.email} · ${u.phone || 'no phone'}</span></p>
      ${u.levelNotes ? html`<p class="small">${u.levelNotes}</p>` : ''}
      <div style="margin:10px 0">${creditPills(d.credits)}</div>
      <div class="row">
        <button class="sm" data-act="rate" data-id="${u.id}">Rate level</button>
        ${isAdmin() ? html`<button class="sm" data-act="recordPayment" data-student="${u.id}">Record payment</button>
          <button class="sm" data-act="grantCredits" data-id="${u.id}">Give free credits</button>
          <button class="sm" data-act="editUser" data-id="${u.id}">Edit</button>
          <button class="sm" data-act="resetPassword" data-id="${u.id}" data-name="${u.name}">Reset password</button>` : ''}
      </div>
      <h3 style="margin-top:16px">Upcoming group lessons</h3>
      ${d.upcoming.length ? html`<ul class="small">${d.upcoming.map((b) => html`<li>${TT.fmtDateTime(b.startsAt)} · ${cap(b.level)} · ${b.locationName} ${b.courtName}</li>`)}</ul>` : html`<p class="muted small">None.</p>`}
      ${d.creditList ? html`<h3 style="margin-top:16px">Credits</h3>
        ${d.creditList.length ? html`<div class="table-wrap"><table><tr><th>Length</th><th>From</th><th>Expires</th><th>Status</th><th></th></tr>
          ${d.creditList.map((c) => html`<tr><td>${TT.length(c.durationMinutes)}</td><td class="small">${c.source === 'purchase' ? 'Purchase' : `Given${c.note ? `: ${c.note}` : ''}`}</td>
            <td>${c.expiresOn}</td>
            <td>${c.void ? html`<span class="badge">Removed</span>` : c.bookingId ? html`<span class="badge ok">Booked</span>` : c.expired ? html`<span class="badge danger">Expired</span>` : html`<span class="badge">Available</span>`}</td>
            <td>${!c.void && !c.bookingId ? html`<button class="link small" data-act="extendCredit" data-id="${c.id}" data-student="${u.id}" data-exp="${c.expiresOn}">Extend</button>
              <button class="link small" data-act="voidCredit" data-id="${c.id}" data-student="${u.id}">Remove</button>` : ''}</td></tr>`)}
        </table></div>` : html`<p class="muted small">No credits.</p>`}` : ''}
      ${d.purchases && d.purchases.length ? html`<h3 style="margin-top:16px">Purchases</h3><ul class="small">${d.purchases.map((p) =>
        html`<li>${TT.fmtDate(p.createdAt)} · ${p.packName} · ${money(p.amountCents)} · ${p.method === 'stripe' ? 'card' : p.method} · ${p.status}</li>`)}</ul>` : ''}`,
  });
}

function closeModals() { document.querySelectorAll('.modal-back').forEach((m) => m.remove()); }

async function userModal(id, role) {
  const u = id ? (await api('GET', '/api/admin/users')).find((x) => String(x.id) === String(id)) : { role, active: true, level: 'unrated' };
  const isNew = !id;
  modal({
    title: isNew ? `Add ${role === 'pro' ? 'a pro' : 'a student'}` : `Edit ${u.name}`,
    body: html`<div class="form-row">
        <div><label>Name</label><input name="name" value="${u.name || ''}"></div>
        <div><label>Email</label><input name="email" type="email" value="${u.email || ''}" ${raw(isNew ? '' : 'disabled')}></div>
        <div><label>Phone</label><input name="phone" type="tel" value="${u.phone || ''}"></div>
        <div><label>Role</label><select name="role">${['student', 'pro', 'admin'].map((r) => html`<option value="${r}" ${raw(u.role === r ? 'selected' : '')}>${r === 'admin' ? 'Owner/admin' : cap(r)}</option>`)}</select></div>
      </div>
      ${u.role === 'student' ? html`<label>Level</label><select name="level">${['unrated', 'beginner', 'intermediate', 'advanced'].map((l) => html`<option value="${l}" ${raw(u.level === l ? 'selected' : '')}>${cap(l)}</option>`)}</select>` : ''}
      <div class="form-row">
        <div><label>Group-lesson pay per hour ($)</label><input name="hourly" inputmode="decimal" value="${((u.hourlyRateCents || 0) / 100).toFixed(2)}"><p class="hint">What the academy pays this pro.</p></div>
        <div><label>Private rate per hour ($)</label><input name="private" inputmode="decimal" value="${u.privateRateCents != null ? (u.privateRateCents / 100).toFixed(2) : '100.00'}"><p class="hint">What students pay the pro.</p></div>
      </div>
      ${!isNew ? html`<label>Zelle</label><input name="zelleHandle" value="${u.zelleHandle || ''}">
        <label class="check" style="margin-top:12px"><input type="checkbox" name="active" ${raw(u.active ? 'checked' : '')}> Active (can log in)</label>` : ''}`,
    onSubmit: async (v) => {
      const body = { name: v.name, phone: v.phone, role: v.role, hourlyRateCents: TT.dollarsToCents(v.hourly || 0), privateRateCents: TT.dollarsToCents(v.private || 0) };
      if (v.level) body.level = v.level;
      if (isNew) {
        const r = await api('POST', '/api/admin/users', { ...body, email: v.email });
        S.pros = null;
        closeModals();
        showTempPassword(r.user.name, r.user.email, r.tempPassword);
      } else {
        await api('PUT', `/api/admin/users/${id}`, { ...body, zelleHandle: v.zelleHandle, active: v.active });
        S.pros = null; toast('Saved');
      }
      rerender();
    },
  });
}

function showTempPassword(name, email, pw) {
  modal({
    title: 'Account ready',
    body: html`<p>Give ${name} these login details. They can change the password under Account.</p>
      <div class="card"><div class="small muted">Booking page</div><div>${location.origin}/a/${TT.slug}</div>
      ${email ? html`<div class="small muted" style="margin-top:8px">Email</div><div>${email}</div>` : ''}
      <div class="small muted" style="margin-top:8px">Temporary password</div><div><code>${pw}</code></div></div>
      <p class="hint">This password is shown only once.</p>`,
  });
}

async function recordPaymentModal(studentId) {
  const [list, packs] = await Promise.all([students(), api('GET', '/api/admin/packs')]);
  const cur = TT.currentMonth();
  modal({
    title: 'Record a payment',
    body: html`<p class="muted small">For cash, check or Zelle taken in person. Credits are added right away.</p>
      <label>Student</label><select name="studentId">${studentOptions(list, studentId, { blank: 'Choose…' })}</select>
      <label>Pack</label><select name="packId">${packs.filter((p) => p.active).map((p) => html`<option value="${p.id}">${p.name} — ${money(p.priceCents)}</option>`)}</select>
      <div class="form-row">
        <div><label>Paid by</label><select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="zelle">Zelle</option><option value="comp">Free (comp)</option></select></div>
        <div><label>Amount ($)</label><input name="amount" inputmode="decimal" placeholder="pack price"></div>
        <div><label>For month</label><select name="forMonth">${[-1, 0, 1, 2].map((i) => { const m = TT.addMonths(cur, i); return html`<option value="${m}" ${raw(i === 0 ? 'selected' : '')}>${TT.monthLabel(m)}</option>`; })}</select></div>
      </div>
      <label>Note</label><input name="note">`,
    submitLabel: 'Record payment',
    onSubmit: async (v) => {
      if (!v.studentId) throw new Error('Choose a student');
      await api('POST', '/api/admin/purchases', { ...v, amountCents: v.amount ? TT.dollarsToCents(v.amount) : undefined });
      toast('Payment recorded and credits added');
      closeModals(); rerender();
    },
  });
}

async function privateModal(existingId, currentStudent) {
  const [locs, proList, list] = await Promise.all([locations(), isAdmin() ? pros() : Promise.resolve([]), students()]);
  if (existingId) {
    modal({
      title: 'Edit private lesson',
      body: html`<label>Student</label><select name="studentId">${studentOptions(list, currentStudent, { blank: '— Open for booking —' })}</select>
        <label>Notes</label><input name="notes">
        <div class="row" style="margin-top:14px">
          <button type="button" class="sm danger" data-act="cancelPrivateStaff" data-id="${existingId}">Cancel this lesson</button>
        </div>`,
      onSubmit: async (v) => {
        const body = { studentId: v.studentId || null };
        if (v.notes) body.notes = v.notes;
        await api('PUT', `/api/staff/private/${existingId}`, body);
        S.students = null; rerender();
      },
    });
    return;
  }
  if (!locs.length) { toast('Add a location with courts in Setup first.', true); return; }
  modal({
    title: 'New private lesson',
    body: html`<p class="muted small">Leave the student blank to post an open time that students can book themselves.</p>
      <label>Starts (${TT.tz.replace('_', ' ')} time)</label>
      <input name="startsAt" type="datetime-local" step="900" value="${defaultStart()}">
      <div class="form-row">
        <div><label>Length</label><select name="durationMinutes"><option value="60">1 hour</option><option value="90">1½ hours</option><option value="30">30 minutes</option><option value="120">2 hours</option></select></div>
        <div><label>Repeat weekly for</label><select name="repeatWeeks">${[1, 2, 4, 8, 12].map((n) => html`<option value="${n}">${n === 1 ? 'Just once' : `${n} weeks`}</option>`)}</select></div>
      </div>
      <label>Court</label><select name="courtId">${courtOptions(locs)}</select>
      ${isAdmin() ? html`<label>Pro</label><select name="proId">${proOptions(proList, S.me.id)}</select>` : ''}
      <label>Student</label><select name="studentId">${studentOptions(list, '', { blank: '— Open for booking —' })}</select>
      <label>Notes</label><input name="notes">`,
    submitLabel: 'Save',
    onSubmit: async (v) => {
      const r = await api('POST', '/api/staff/private', { ...v, startsAt: TT.zonedToIso(v.startsAt), studentId: v.studentId || null });
      toast(`Added ${r.created} lesson${r.created === 1 ? '' : 's'}`); rerender();
    },
  });
}

// ── Actions (click delegation) ───────────────────────────────

const acts = {
  async book(el) {
    el.disabled = true;
    try { await api('POST', `/api/sessions/${el.dataset.id}/book`); toast('Booked! See you on the court.'); rerender(); }
    catch (err) { toast(err.message, true); el.disabled = false; }
  },
  async cancelBooking(el) {
    if (!(await confirmBox('Cancel this lesson?', `${TT.fmtDateTime(el.dataset.when)} — your credit goes back to your account so you can book another day.`, 'Cancel lesson'))) return;
    try { await api('POST', `/api/bookings/${el.dataset.id}/cancel`); toast('Cancelled — credit returned.'); rerender(); }
    catch (err) { toast(err.message, true); }
  },
  async buyPack(el) {
    el.disabled = true;
    try {
      const r = await api('POST', '/api/purchases', { packId: el.dataset.id, forMonth: el.dataset.month });
      if (r.url) { location.href = r.url; return; }
      toast('Purchase complete — credits added.'); rerender();
    } catch (err) { toast(err.message, true); el.disabled = false; }
  },
  async bookPrivate(el) {
    const d = el.dataset;
    const ok = await confirmBox('Book this private lesson?',
      `${TT.fmtDateTime(d.when)} with ${d.pro}. You'll pay ${money(d.price)} to ${d.pro} by Zelle${d.zelle ? ` (${d.zelle})` : ''}.`, 'Book it', false);
    if (!ok) return;
    try { await api('POST', `/api/private/${d.id}/book`); toast('Booked! Details are in My lessons.'); go('my'); }
    catch (err) { toast(err.message, true); rerender(); }
  },
  async cancelPrivate(el) {
    if (!(await confirmBox('Cancel this private lesson?', 'The time will be released for other students.', 'Cancel lesson'))) return;
    try { await api('POST', `/api/private/${el.dataset.id}/cancel`); toast('Cancelled'); rerender(); }
    catch (err) { toast(err.message, true); }
  },
  async showPast(el) {
    const rows = await api('GET', '/api/my/bookings?scope=past');
    el.remove();
    document.getElementById('past').innerHTML = rows.length ? html`<h2>Past group lessons</h2><div class="table-wrap"><table>
      ${rows.map((b) => html`<tr><td>${TT.fmtDateTime(b.startsAt)}</td><td>${cap(b.level)}</td><td class="small">${b.locationName} · ${b.proName}</td>
        <td>${b.bookingStatus === 'cancelled' ? 'Cancelled' : b.attended === true ? 'Attended' : b.attended === false ? 'Missed' : ''}</td></tr>`)}
    </table></div>`.s : '<p class="muted">No past lessons yet.</p>';
  },
  logout() { TT.token.clear(); location.replace(`/a/${TT.slug}`); },
  copy(el) {
    navigator.clipboard?.writeText(el.dataset.text).then(() => toast('Link copied'), () => toast('Copy failed — select and copy the link instead', true));
  },

  newSession() { sessionModal(); },
  openSession(el) { openSessionModal(el.dataset.id).catch((e) => toast(e.message, true)); },
  async editSession(el) {
    const s = await api('GET', `/api/staff/sessions/${el.dataset.id}`);
    closeModals(); sessionModal(s);
  },
  async attend(el) {
    try { await api('POST', `/api/staff/sessions/${el.dataset.session}/attendance`, { bookingId: el.dataset.id, attended: el.checked }); }
    catch (err) { toast(err.message, true); el.checked = !el.checked; }
  },
  async staffCancelBooking(el) {
    if (!(await confirmBox('Remove this student?', 'Their credit is returned so they can book another lesson.', 'Remove'))) return;
    try { await api('POST', `/api/bookings/${el.dataset.id}/cancel`); closeModals(); openSessionModal(el.dataset.session); rerender(); }
    catch (err) { toast(err.message, true); }
  },
  async addToSession(el) {
    const list = await students();
    const sid = el.dataset.id;
    modal({
      title: 'Add a student',
      body: html`<p class="muted small">Uses one of the student's credits.</p>
        <label>Student</label><select name="studentId">${studentOptions(list.filter((s) => isAdmin() || s.level === el.dataset.level), '', { blank: 'Choose…' })}</select>
        ${isAdmin() ? html`<label class="check" style="margin-top:10px"><input type="checkbox" name="overrideLevel"> Allow a different level</label>` : ''}`,
      submitLabel: 'Add',
      onSubmit: async (v) => {
        if (!v.studentId) throw new Error('Choose a student');
        await api('POST', `/api/staff/sessions/${sid}/add`, v);
        closeModals(); openSessionModal(sid); rerender();
      },
    });
  },
  async cancelSession(el) {
    const id = el.dataset.id;
    modal({
      title: 'Cancel this lesson?',
      body: html`<p>${Number(el.dataset.booked) ? `${el.dataset.booked} booked student(s) get their credit back.` : 'No students are booked.'}</p>
        <label>Reason (shown to students)</label><input name="reason" placeholder="e.g. Rain">
        ${el.dataset.series ? html`<label class="check" style="margin-top:10px"><input type="checkbox" name="wholeSeries"> Also cancel all later weeks of this weekly lesson</label>` : ''}`,
      submitLabel: 'Cancel lesson', danger: true,
      onSubmit: async (v) => {
        const r = await api('POST', `/api/staff/sessions/${id}/cancel`, v);
        toast(`Cancelled ${r.cancelled} lesson${r.cancelled === 1 ? '' : 's'}`); closeModals(); rerender();
      },
    });
  },

  async rate(el) {
    const list = await students(true);
    const s = list.find((x) => String(x.id) === el.dataset.id);
    if (!s) return;
    modal({
      title: `Rate ${s.name}`,
      body: html`<label>Skill level</label><select name="level">${['unrated', 'beginner', 'intermediate', 'advanced'].map((l) => html`<option value="${l}" ${raw(s.level === l ? 'selected' : '')}>${cap(l)}</option>`)}</select>
        <label>Notes (staff only)</label><textarea name="notes" rows="3">${s.levelNotes || ''}</textarea>
        <p class="hint">Students can only book group lessons at their level.</p>`,
      onSubmit: async (v) => { await api('PUT', `/api/staff/students/${s.id}/level`, v); toast('Rating saved'); closeModals(); rerender(); },
    });
  },
  openStudent(el) { studentModal(el.dataset.id).catch((e) => toast(e.message, true)); },
  newUser(el) { userModal(null, el.dataset.role); },
  editUser(el) { closeModals(); userModal(el.dataset.id); },
  async resetPassword(el) {
    if (!(await confirmBox(`Reset ${el.dataset.name}'s password?`, 'Their current password stops working and you get a temporary one to give them.', 'Reset password'))) return;
    const r = await api('POST', `/api/admin/users/${el.dataset.id}/reset-password`);
    closeModals(); showTempPassword(el.dataset.name, null, r.tempPassword);
  },
  recordPayment(el) { closeModals(); recordPaymentModal(el.dataset.student); },
  grantCredits(el) {
    const id = el.dataset.id;
    modal({
      title: 'Give free credits',
      body: html`<div class="form-row">
          <div><label>Length</label><select name="durationMinutes"><option value="60">1 hour</option><option value="90">1½ hours</option></select></div>
          <div><label>How many</label><input name="count" type="number" min="1" max="50" value="1"></div>
          <div><label>Expires</label><input name="expiresOn" type="date"><p class="hint">Blank = end of next month</p></div>
        </div>
        <label>Reason</label><input name="note" placeholder="e.g. Make-up for rain-out">`,
      submitLabel: 'Add credits',
      onSubmit: async (v) => { await api('POST', '/api/admin/credits', { ...v, studentId: id }); toast('Credits added'); closeModals(); studentModal(id); },
    });
  },
  async voidCredit(el) {
    if (!(await confirmBox('Remove this credit?', 'Use this after refunding a card payment in Stripe, or to correct a mistake.', 'Remove credit'))) return;
    try { await api('POST', `/api/admin/credits/${el.dataset.id}/void`); closeModals(); studentModal(el.dataset.student); }
    catch (err) { toast(err.message, true); }
  },
  extendCredit(el) {
    const { id, student, exp } = el.dataset;
    modal({
      title: 'Extend credit',
      body: html`<label>New expiry date</label><input name="expiresOn" type="date" value="${exp}">`,
      onSubmit: async (v) => { await api('POST', `/api/admin/credits/${id}/extend`, v); closeModals(); studentModal(student); },
    });
  },

  newPrivate() { privateModal(); },
  editPrivate(el) { privateModal(el.dataset.id, el.dataset.student); },
  async privPaid(el) {
    try { await api('PUT', `/api/staff/private/${el.dataset.id}`, { studentPaid: el.checked }); toast(el.checked ? 'Marked paid' : 'Marked unpaid'); }
    catch (err) { toast(err.message, true); el.checked = !el.checked; }
  },
  async privFee(el) {
    try { await api('PUT', `/api/staff/private/${el.dataset.id}`, { feePaid: el.checked }); toast(el.checked ? 'Court fee received' : 'Court fee unmarked'); }
    catch (err) { toast(err.message, true); el.checked = !el.checked; }
  },
  async cancelPrivateStaff(el) {
    if (!(await confirmBox('Cancel this private lesson?', 'It will be removed from the schedule.', 'Cancel lesson'))) return;
    await api('POST', `/api/private/${el.dataset.id}/cancel`, {});
    closeModals(); toast('Cancelled'); rerender();
  },

  async payrollPaid(el) {
    const d = el.dataset;
    if (!(await confirmBox(`Mark ${d.name} paid?`, `Records ${money(d.amount)} group-lesson pay for ${TT.monthLabel(d.month)} as paid. Pay them through your usual payroll.`, 'Mark paid', false))) return;
    await api('POST', '/api/admin/payroll/mark-paid', { proId: d.id, month: d.month }); rerender();
  },
  async payrollUndo(el) { await api('POST', '/api/admin/payroll/mark-paid', { proId: el.dataset.id, month: el.dataset.month, undo: true }); rerender(); },

  newLocation() {
    modal({
      title: 'Add a location',
      body: html`<label>Name</label><input name="name" placeholder="e.g. Wildflower Tennis Courts">
        <label>Address</label><input name="address">
        <label>Number of courts</label><input name="courtCount" type="number" min="0" max="30" value="1">
        <p class="hint">Courts are named Court 1, Court 2… — you can rename them after.</p>`,
      onSubmit: async (v) => { await api('POST', '/api/admin/locations', v); S.locations = null; rerender(); },
    });
  },
  editLocation(el) {
    const d = el.dataset;
    modal({
      title: `Edit ${d.name}`,
      body: html`<label>Name</label><input name="name" value="${d.name}"><label>Address</label><input name="address" value="${d.address}">
        <label class="check" style="margin-top:10px"><input type="checkbox" name="active" ${raw(d.active === 'true' ? 'checked' : '')}> Available for booking</label>`,
      onSubmit: async (v) => { await api('PUT', `/api/admin/locations/${d.id}`, v); S.locations = null; rerender(); },
    });
  },
  addCourt(el) {
    modal({
      title: 'Add a court',
      body: html`<label>Court name</label><input name="name" placeholder="e.g. Court 8">`,
      onSubmit: async (v) => { await api('POST', `/api/admin/locations/${el.dataset.id}/courts`, v); S.locations = null; rerender(); },
    });
  },
  editCourt(el) {
    const d = el.dataset;
    modal({
      title: `Edit ${d.name}`,
      body: html`<label>Court name</label><input name="name" value="${d.name}">
        <label class="check" style="margin-top:10px"><input type="checkbox" name="active" ${raw(d.active === 'true' ? 'checked' : '')}> In use</label>`,
      onSubmit: async (v) => { await api('PUT', `/api/admin/courts/${d.id}`, v); S.locations = null; rerender(); },
    });
  },
  editPack(el) {
    const p = el.dataset.pack ? JSON.parse(el.dataset.pack) : { active: true, durationMinutes: 60, lessonCount: 4, priceCents: 9000, sort: 99 };
    modal({
      title: p.id ? 'Edit pack' : 'New lesson pack',
      body: html`<label>Name</label><input name="name" value="${p.name || ''}" placeholder="e.g. 4 × 1-hour lessons">
        <div class="form-row">
          <div><label>Length</label><select name="durationMinutes"><option value="60">1 hour</option><option value="90" ${raw(p.durationMinutes === 90 ? 'selected' : '')}>1½ hours</option></select></div>
          <div><label>Lessons</label><input name="lessonCount" type="number" min="1" max="50" value="${p.lessonCount}"></div>
          <div><label>Price ($)</label><input name="price" inputmode="decimal" value="${(p.priceCents / 100).toFixed(2)}"></div>
          <div><label>Sort order</label><input name="sort" type="number" value="${p.sort}"></div>
        </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" name="active" ${raw(p.active ? 'checked' : '')}> On sale</label>`,
      onSubmit: async (v) => {
        const body = { ...v, priceCents: TT.dollarsToCents(v.price) };
        if (p.id) await api('PUT', `/api/admin/packs/${p.id}`, body); else await api('POST', '/api/admin/packs', body);
        rerender();
      },
    });
  },
  async disconnectStripe() {
    if (!(await confirmBox('Disconnect Stripe?', 'Students won\'t be able to buy lessons by card until you reconnect.', 'Disconnect'))) return;
    await api('PUT', '/api/admin/stripe', { disconnect: true }); toast('Disconnected'); rerender();
  },
  async subscribe(el) {
    el.disabled = true;
    try {
      const r = await api('POST', '/api/billing/checkout');
      if (r.url) { location.href = r.url; return; }
      toast('Subscription active'); const me = await api('GET', '/api/me'); S.academy = me.academy; rerender();
    } catch (err) { toast(err.message, true); el.disabled = false; }
  },
  async billingPortal() { const r = await api('POST', '/api/billing/portal'); location.href = r.url; },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  e.preventDefault();
  Promise.resolve(acts[el.dataset.act](el)).catch((err) => toast(err.message, true));
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) {
    Promise.resolve(acts[el.dataset.act](el)).catch((err) => toast(err.message, true));
    return;
  }
  const key = el.dataset.change;
  if (!key) return;
  const { name, params } = route();
  const set = (k, v) => { if (v) params.set(k, v); else params.delete(k); go(name, params); };
  ({
    locFilter: () => set('loc', el.value),
    buyMonth: () => set('month', el.value),
    schedScope: () => set('mine', el.value === 'mine' ? '1' : '0'),
    schedLevel: () => set('level', el.value),
    studentSearch: () => set('q', el.value.trim()),
    studentLevel: () => set('level', el.value),
    privMonth: () => set('month', el.value),
    hoursMonth: () => set('month', el.value),
    payrollMonth: () => set('month', el.value),
    paymentsMonth: () => set('month', el.value),
  })[key]?.();
});

// Forms rendered inside views.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const v = TT.formValues(form);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (form.dataset.form === 'profile') {
      const r = await api('PUT', '/api/me', v); S.me = r.user; toast('Saved');
      document.getElementById('who').textContent = S.me.name;
    } else if (form.dataset.form === 'password') {
      const r = await api('PUT', '/api/me', { ...v, name: S.me.name, phone: S.me.phone, zelleHandle: S.me.zelleHandle });
      // Changing the password signs out other devices; keep this one signed in.
      if (r.token) TT.token.set(r.token);
      form.reset(); form.querySelectorAll('input').forEach((i) => i.dispatchEvent(new Event('input')));
      toast('Password changed. Other devices have been signed out.');
    } else if (form.dataset.form === 'settings') {
      await api('PUT', '/api/admin/settings', {
        name: v.name, timezone: v.timezone, contact_email: v.contact_email, contact_phone: v.contact_phone,
        private_court_fee_cents_per_hour: TT.dollarsToCents(v.court_fee), default_private_rate_cents: TT.dollarsToCents(v.private_rate),
        default_group_capacity: v.default_group_capacity, credit_grace_months: v.credit_grace_months,
      });
      const me = await api('GET', '/api/me'); S.academy = me.academy; TT.setTz(S.academy.timezone);
      document.getElementById('acName').textContent = S.academy.name;
      toast('Settings saved');
    } else if (form.dataset.form === 'stripe') {
      await api('PUT', '/api/admin/stripe', v); toast('Stripe saved'); rerender();
    }
  } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
});

boot();
