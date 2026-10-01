// Local demo data: one academy ("totaltennis") with an owner, two pros, a
// handful of students, Cal Lutheran + Wildflower courts, and two weeks of
// group lessons. Refuses to run against production.
//
//   node seed-demo.js          create (skips if the academy already exists)
//   node seed-demo.js --wipe   delete the local PGlite database first
//
// All demo accounts share DEMO_PASSWORD below and log in at /a/totaltennis.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SLUG = 'totaltennis';
const DEMO_PASSWORD = 'demo-tennis-2026';

const PEOPLE = [
  // [name, email, role, level, hourly rate cents, zelle]
  ['Olivia Owner', 'owner@demo.test', 'admin', 'unrated', 0, null],
  ['Marco Pro', 'marco@demo.test', 'pro', 'unrated', 4000, 'marco@demo.test'],
  ['Jenna Pro', 'jenna@demo.test', 'pro', 'unrated', 4500, '805-555-0102'],
  ['Sam Beginner', 'sam@demo.test', 'student', 'beginner', 0, null],
  ['Ivy Intermediate', 'ivy@demo.test', 'student', 'intermediate', 0, null],
  ['Ari Advanced', 'ari@demo.test', 'student', 'advanced', 0, null],
  ['Nina New', 'nina@demo.test', 'student', 'unrated', 0, null],
];

(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.DATABASE_URL) {
    console.error('seed-demo.js only runs against the local PGlite database.');
    process.exit(1);
  }
  if (process.argv.includes('--wipe')) fs.rmSync(process.env.PGLITE_DIR || './.pglite', { recursive: true, force: true });
  await db.connect();
  if (await db.one('SELECT 1 FROM academies WHERE slug = $1', [SLUG])) {
    console.log(`Academy "${SLUG}" already exists — run with --wipe to rebuild.`);
    process.exit(0);
  }
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await db.tx(async (t) => {
    const { academy } = await db.createAcademy(t, {
      slug: SLUG, name: 'Total Tennis Academy', timezone: 'America/Los_Angeles',
      ownerName: PEOPLE[0][0], ownerEmail: PEOPLE[0][1], ownerPhone: '805-495-0111',
      passwordHash: hash, trialDays: 14, subStatus: 'trialing',
    });
    const aid = academy.id;
    await t.query(`UPDATE academies SET settings = $2::jsonb WHERE id = $1`,
      [aid, JSON.stringify({ contact_email: 'info@totaltennisacademy.org', contact_phone: '805.495.0111' })]);

    const ids = {};
    for (const [name, email, role, level, rate, zelle] of PEOPLE.slice(1)) {
      ids[email] = (await t.query(
        `INSERT INTO users (academy_id, name, email, password_hash, role, level, hourly_rate_cents, zelle_handle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [aid, name, email, hash, role, level, rate, zelle])).rows[0].id;
    }

    const calLu = (await t.query(
      `INSERT INTO locations (academy_id, name, address) VALUES ($1, 'Cal Lutheran', '60 W Olsen Rd, Thousand Oaks, CA') RETURNING id`,
      [aid])).rows[0].id;
    const courts = [];
    for (let i = 1; i <= 7; i++) {
      courts.push((await t.query(`INSERT INTO courts (academy_id, location_id, name) VALUES ($1,$2,$3) RETURNING id`,
        [aid, calLu, `Court ${i}`])).rows[0].id);
    }
    const wild = (await t.query(`INSERT INTO locations (academy_id, name) VALUES ($1, 'Wildflower Tennis Courts') RETURNING id`, [aid])).rows[0].id;
    const wildCourt = (await t.query(`INSERT INTO courts (academy_id, location_id, name) VALUES ($1,$2,'Court 1') RETURNING id`, [aid, wild])).rows[0].id;

    // Two weeks of lessons at 9am / 5pm local time, starting tomorrow.
    const plan = [
      ['beginner', 60, courts[0], 'marco@demo.test', 9],
      ['intermediate', 90, courts[1], 'jenna@demo.test', 9],
      ['advanced', 90, courts[2], 'marco@demo.test', 17],
      ['intermediate', 60, wildCourt, 'jenna@demo.test', 17],
    ];
    for (let day = 1; day <= 14; day++) {
      for (const [level, mins, court, pro, hour] of plan) {
        if ((day + hour) % 2) continue; // not every lesson every day
        await t.query(
          `INSERT INTO group_sessions (academy_id, level, starts_at, duration_minutes, court_id, pro_id, capacity)
           VALUES ($1, $2, ((date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + make_interval(days => $3::int, hours => $4::int))
                             AT TIME ZONE 'America/Los_Angeles'), $5, $6, $7, 6)`,
          [aid, level, day, hour, mins, court, ids[pro]]);
      }
    }
    // Open private-lesson slots from Marco.
    for (const day of [2, 3, 5]) {
      await t.query(
        `INSERT INTO private_lessons (academy_id, pro_id, starts_at, duration_minutes, court_id, price_cents, academy_fee_cents)
         VALUES ($1, $2, ((date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + make_interval(days => $3::int, hours => 12))
                          AT TIME ZONE 'America/Los_Angeles'), 60, $4, 10000, 2000)`,
        [aid, ids['marco@demo.test'], day, courts[4]]);
    }
  });
  console.log(`Demo academy created. Log in at /a/${SLUG} with any of:`);
  for (const p of PEOPLE) console.log(`  ${p[2].padEnd(8)} ${p[1]}`);
  console.log('Password: see DEMO_PASSWORD in seed-demo.js');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
