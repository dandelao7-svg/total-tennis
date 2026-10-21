// Builds a ready-to-show demo academy through the app's own API, so it works
// against the live site as well as a local copy:
//
//   node seed-live-demo.js                         live site, address /a/tta-demo
//   node seed-live-demo.js --base http://localhost:3100 --slug tta-demo
//
// Creates an owner, two pros and twelve students (one owner, one pro and one
// student have the demo login), Cal Lutheran + Wildflower courts, paid lesson
// packs, three weeks of group lessons, private lessons and bookings. A few
// lessons are placed early tomorrow morning so that, by a meeting later that
// day, they have been taught and show up in Payroll. Run it the evening before.
//
// Logins are written to sales/demo-logins.txt (not committed).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const BASE = opt('base', 'https://total-tennis-production.up.railway.app').replace(/\/$/, '');
const SLUG = opt('slug', 'tta-demo');
const TZ = 'America/Los_Angeles';
const DOMAIN = `${SLUG}.test`;
const PASSWORD = `Tennis-Demo-${crypto.randomInt(1000, 9999)}`;

// Paced under the server's 200-requests-a-minute limit, with a wait-and-retry
// if it still says "too many requests".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function api(token, method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const wait = last + 400 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(BASE + url, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) {
      process.stdout.write(' (pausing for the rate limit…)');
      await sleep(20000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data.error || 'failed'}`);
    return data;
  }
}

// Wall-clock time at the academy → real instant (handles daylight saving).
function laTime(dayOffset, hh, mm = 0) {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day + dayOffset, hh, mm);
  const offset = (t) => {
    const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}
const laWeekday = (dayOffset) => new Date(laTime(dayOffset, 12)).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });

const STUDENTS = [
  ['Sam Rivera', 'student', 'intermediate'], // demo student login
  ['Jordan Lee', 'new', 'unrated'],          // shows the "needs a rating" flow
  ['Emma Rodriguez', null, 'beginner'], ['Liam Chen', null, 'beginner'], ['Olivia Park', null, 'beginner'],
  ['Ava Thompson', null, 'intermediate'], ['Ethan Brooks', null, 'intermediate'], ['Mia Nguyen', null, 'intermediate'],
  ['Sophia Kim', null, 'advanced'], ['Jack Morgan', null, 'advanced'], ['Chloe Davis', null, 'advanced'],
  ['Henry Walsh', null, 'unrated'],
];

(async () => {
  console.log(`Building demo academy "${SLUG}" on ${BASE} …`);
  if (await fetch(`${BASE}/api/academy/${SLUG}`).then((r) => r.ok)) {
    throw new Error(`An academy already uses /a/${SLUG}. Pick another with --slug, e.g. --slug tta-demo2`);
  }

  // Academy + owner
  const signup = await api(null, 'POST', '/api/auth/academy-signup', {
    academyName: 'Total Tennis Academy (Demo)', slug: SLUG, name: 'Mike Gennette', phone: '(805) 495-0111',
    email: `owner@${DOMAIN}`, password: PASSWORD, timezone: TZ,
  });
  const owner = signup.token;
  await api(owner, 'PUT', '/api/admin/settings', { contact_email: 'info@totaltennisacademy.org', contact_phone: '(805) 495-0111' });

  console.log('• academy and owner created');
  // Courts
  await api(owner, 'POST', '/api/admin/locations', { name: 'Cal Lutheran', address: '60 W Olsen Rd, Thousand Oaks, CA', courtCount: 7 });
  await api(owner, 'POST', '/api/admin/locations', { name: 'Wildflower Tennis Courts', courtCount: 1 });
  const locs = await api(owner, 'GET', '/api/locations');
  const court = (loc, n) => locs.find((l) => l.name.startsWith(loc)).courts.find((c) => c.name === `Court ${n}`).id;

  console.log('• courts added');
  // People. Accounts with a demo login get the demo password; the rest keep a random one.
  const makeUser = async (name, role, email, extra = {}) => {
    const r = await api(owner, 'POST', '/api/admin/users', { name, email, role, ...extra });
    return { id: r.user.id, temp: r.tempPassword, email };
  };
  const setDemoPassword = async (u) => {
    const t = (await api(null, 'POST', '/api/auth/login', { academy: SLUG, email: u.email, password: u.temp })).token;
    await api(t, 'PUT', '/api/me', { currentPassword: u.temp, newPassword: PASSWORD });
  };
  const marco = await makeUser('Marco Alvarez', 'pro', `pro@${DOMAIN}`, { phone: '(805) 555-0142', hourlyRateCents: 4000 });
  const jenna = await makeUser('Jenna Fields', 'pro', `jenna@${DOMAIN}`, { phone: '(805) 555-0187', hourlyRateCents: 4500 });
  await setDemoPassword(marco);
  await api(owner, 'PUT', `/api/admin/users/${marco.id}`, { zelleHandle: '(805) 555-0142' });
  await api(owner, 'PUT', `/api/admin/users/${jenna.id}`, { zelleHandle: '(805) 555-0187' });

  const students = {};
  let n = 0;
  for (const [name, login, level] of STUDENTS) {
    const email = login ? `${login}@${DOMAIN}` : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`;
    const u = await makeUser(name, 'student', email, { phone: `(805) 555-${String(1200 + n++ * 37).slice(-4)}` });
    if (level !== 'unrated') await api(owner, 'PUT', `/api/admin/users/${u.id}`, { level });
    if (login) await setDemoPassword(u);
    students[name] = { ...u, level };
  }

  console.log('• pros and students added');
  // Paid lesson packs (recorded as cash/Zelle, so no card account is needed).
  const packs = await api(owner, 'GET', '/api/admin/packs');
  const pack = (mins, count) => packs.find((p) => p.durationMinutes === mins && p.lessonCount === count).id;
  let k = 0;
  for (const [name, s] of Object.entries(students)) {
    if (s.level === 'unrated') continue;
    const buys = name === 'Sam Rivera' ? [pack(60, 8), pack(90, 4)] : k++ % 2 ? [pack(60, 8)] : [pack(60, 4), pack(90, 4)];
    for (const packId of buys) {
      await api(owner, 'POST', '/api/admin/purchases', { studentId: s.id, packId, method: k % 3 ? 'cash' : 'zelle' });
    }
  }

  console.log('• lesson packs paid');
  // Group lessons. Tomorrow-morning lessons finish before a later meeting.
  const post = (level, mins, courtId, proId, day, hh, mm, weeks = 1) => api(owner, 'POST', '/api/staff/sessions', {
    level, durationMinutes: mins, courtId, proId, startsAt: laTime(day, hh, mm), repeatWeeks: weeks, capacity: 6,
  });
  await post('beginner', 60, court('Cal', 1), marco.id, 1, 6, 0);
  await post('advanced', 90, court('Cal', 3), marco.id, 1, 7, 0);
  await post('intermediate', 90, court('Cal', 2), jenna.id, 1, 6, 30);
  await post('intermediate', 60, court('Wild', 1), jenna.id, 1, 8, 0);
  // A weekly schedule over the next three weeks, starting the day after tomorrow.
  const weekly = [
    ['beginner', 60, court('Cal', 1), marco.id, 9, 0], ['intermediate', 90, court('Cal', 2), jenna.id, 9, 0],
    ['advanced', 90, court('Cal', 3), marco.id, 17, 0], ['intermediate', 60, court('Wild', 1), jenna.id, 17, 0],
  ];
  for (let d = 2; d <= 8; d++) {
    const wd = laWeekday(d);
    if (wd === 'Sun') continue;
    for (const [i, [level, mins, c, pro, hh, mm]] of weekly.entries()) {
      if ((d + i) % 2) continue; // not every lesson every day
      await post(level, mins, c, pro, d, hh, mm, 3);
    }
  }

  console.log('• group lessons posted');
  // Fill rosters (each booking uses one of the student's credits).
  const sessions = await api(owner, 'GET', `/api/staff/sessions?mine=0&to=${encodeURIComponent(laTime(30, 0))}`);
  let fill = 0;
  for (const g of sessions) {
    const pool = Object.entries(students).filter(([nm, s]) => s.level === g.level && nm !== 'Sam Rivera');
    for (const [, s] of pool.slice(0, 2 + (fill++ % 3))) {
      await api(owner, 'POST', `/api/staff/sessions/${g.id}/add`, { studentId: s.id }).catch(() => {});
    }
  }
  // The demo student already has one lesson booked (and plenty left to book live).
  const samLesson = sessions.find((g) => g.level === 'intermediate' && new Date(g.startsAt) > new Date(laTime(2, 0)));
  if (samLesson) await api(owner, 'POST', `/api/staff/sessions/${samLesson.id}/add`, { studentId: students['Sam Rivera'].id });

  console.log('• rosters filled');
  // Private lessons: one taught tomorrow morning (court fee owed), one booked for
  // the demo student, and open times students can book.
  await api(owner, 'POST', '/api/staff/private', { proId: marco.id, studentId: students['Sophia Kim'].id, courtId: court('Cal', 5), durationMinutes: 60, startsAt: laTime(1, 8, 30) });
  await api(owner, 'POST', '/api/staff/private', { proId: jenna.id, studentId: students['Ava Thompson'].id, courtId: court('Cal', 6), durationMinutes: 60, startsAt: laTime(1, 5, 30) });
  await api(owner, 'POST', '/api/staff/private', { proId: marco.id, studentId: students['Sam Rivera'].id, courtId: court('Cal', 5), durationMinutes: 60, startsAt: laTime(4, 12, 0) });
  for (const d of [2, 3, 5]) {
    await api(owner, 'POST', '/api/staff/private', { proId: jenna.id, courtId: court('Cal', 6), durationMinutes: 60, startsAt: laTime(d, 16, 0) });
  }
  await api(owner, 'POST', '/api/staff/private', { proId: marco.id, courtId: court('Cal', 5), durationMinutes: 60, startsAt: laTime(3, 12, 0) });
  const priv = await api(owner, 'GET', '/api/staff/private');
  for (const p of priv.filter((x) => x.studentName === 'Sophia Kim' || x.studentName === 'Ava Thompson')) {
    await api(owner, 'PUT', `/api/staff/private/${p.id}`, { studentPaid: true });
  }

  const logins = [
    `Demo academy: Total Tennis Academy (Demo)`,
    `Log-in page:  ${BASE}/a/${SLUG}`,
    ``,
    `Owner    owner@${DOMAIN}`,
    `Pro      pro@${DOMAIN}       (Marco Alvarez)`,
    `Student  student@${DOMAIN}   (Sam Rivera, intermediate)`,
    `New student (unrated): new@${DOMAIN}`,
    ``,
    `Password for all of them: ${PASSWORD}`,
    ``,
    `Created ${new Date().toLocaleString('en-US', { timeZone: TZ })} (California time).`,
  ].join('\n');
  const file = path.join(__dirname, 'sales', 'demo-logins.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${logins}\n`);
  console.log(`\nDone. ${sessions.length} group lessons, ${Object.keys(students).length} students.\n`);
  console.log(logins);
  console.log(`\n(Saved to ${file})`);
})().catch((err) => { console.error(`\nStopped: ${err.message}`); process.exit(1); });
