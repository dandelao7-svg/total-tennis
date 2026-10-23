// Data layer. Talks to PostgreSQL via `pg` when DATABASE_URL is set (Railway,
// production). Without it, falls back to PGlite — real Postgres compiled to
// WASM, stored in ./.pglite — so the app runs locally with no database install.
// Both expose the same tiny surface: query(sql, params) and tx(fn).
//
// Multi-tenant: every row belongs to an academy (academy_id). Every query in
// server.js must filter by the caller's academy — there is no row-level
// security underneath to catch a missed filter.

let _query, _exec, _tx;

async function connect() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    _query = (sql, params) => pool.query(sql, params);
    _exec = (sql) => pool.query(sql);
    _tx = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (s, p) => client.query(s, p) });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
    console.log('Database: PostgreSQL (DATABASE_URL)');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || './.pglite';
    const db = new PGlite(dir);
    await db.waitReady;
    _query = (sql, params) => db.query(sql, params);
    _exec = (sql) => db.exec(sql);
    _tx = (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p) }));
    console.log(`Database: local PGlite (${dir}) — set DATABASE_URL to use PostgreSQL`);
  }
  await initSchema();
}

const query = (sql, params) => _query(sql, params);
const tx = (fn) => _tx(fn);
async function one(sql, params) { return (await _query(sql, params)).rows[0] || null; }
async function many(sql, params) { return (await _query(sql, params)).rows; }

// Every table lives here. Boot must stay idempotent: CREATE ... IF NOT EXISTS,
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS for later additions.
async function initSchema() {
  await _exec(`
    -- One row per paying customer (a tennis academy).
    CREATE TABLE IF NOT EXISTS academies (
      id                       SERIAL PRIMARY KEY,
      slug                     TEXT UNIQUE NOT NULL,
      name                     TEXT NOT NULL,
      timezone                 TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      settings                 JSONB NOT NULL DEFAULT '{}',
      -- Platform subscription (the academy paying us).
      sub_status               TEXT NOT NULL DEFAULT 'trialing'
                               CHECK (sub_status IN ('trialing','active','past_due','canceled','comped')),
      trial_ends_at            TIMESTAMPTZ,
      platform_customer_id     TEXT,
      platform_subscription_id TEXT,
      current_period_end       TIMESTAMPTZ,
      -- The academy's own Stripe account (students paying the academy). Encrypted.
      stripe_secret_enc        TEXT,
      stripe_webhook_secret_enc TEXT,
      stripe_key_hint          TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id                 SERIAL PRIMARY KEY,
      academy_id         INT NOT NULL REFERENCES academies(id),
      email              TEXT NOT NULL,
      password_hash      TEXT NOT NULL,
      name               TEXT NOT NULL,
      phone              TEXT,
      role               TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','pro','admin')),
      level              TEXT NOT NULL DEFAULT 'unrated'
                         CHECK (level IN ('unrated','beginner','intermediate','advanced')),
      level_notes        TEXT,
      rated_by           INT REFERENCES users(id),
      rated_at           TIMESTAMPTZ,
      hourly_rate_cents  INT NOT NULL DEFAULT 0,      -- pros: what the academy pays per group-lesson hour
      private_rate_cents INT NOT NULL DEFAULT 10000,  -- pros: what a student pays per private hour
      zelle_handle       TEXT,                        -- pros: where students send private-lesson payment
      active             BOOLEAN NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (academy_id, email)
    );

    CREATE TABLE IF NOT EXISTS locations (
      id         SERIAL PRIMARY KEY,
      academy_id INT NOT NULL REFERENCES academies(id),
      name       TEXT NOT NULL,
      address    TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (academy_id, name)
    );

    CREATE TABLE IF NOT EXISTS courts (
      id          SERIAL PRIMARY KEY,
      academy_id  INT NOT NULL REFERENCES academies(id),
      location_id INT NOT NULL REFERENCES locations(id),
      name        TEXT NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (location_id, name)
    );

    -- What students can buy: N group lessons of one length for a price.
    CREATE TABLE IF NOT EXISTS lesson_packs (
      id               SERIAL PRIMARY KEY,
      academy_id       INT NOT NULL REFERENCES academies(id),
      name             TEXT NOT NULL,
      duration_minutes INT NOT NULL CHECK (duration_minutes IN (60, 90)),
      lesson_count     INT NOT NULL CHECK (lesson_count > 0),
      price_cents      INT NOT NULL CHECK (price_cents >= 0),
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      sort             INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id                SERIAL PRIMARY KEY,
      academy_id        INT NOT NULL REFERENCES academies(id),
      student_id        INT NOT NULL REFERENCES users(id),
      pack_id           INT REFERENCES lesson_packs(id),
      pack_name         TEXT NOT NULL,
      for_month         TEXT NOT NULL,              -- 'YYYY-MM'
      duration_minutes  INT NOT NULL,
      lesson_count      INT NOT NULL,
      amount_cents      INT NOT NULL,
      method            TEXT NOT NULL CHECK (method IN ('stripe','cash','check','zelle','comp')),
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
      stripe_session_id TEXT UNIQUE,
      recorded_by       INT REFERENCES users(id),
      note              TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at           TIMESTAMPTZ
    );

    -- One row per lesson credit. A credit is free when booking_id IS NULL and it
    -- is not void and not expired. Cancelling a booking frees its credit again.
    CREATE TABLE IF NOT EXISTS credits (
      id               SERIAL PRIMARY KEY,
      academy_id       INT NOT NULL REFERENCES academies(id),
      student_id       INT NOT NULL REFERENCES users(id),
      duration_minutes INT NOT NULL CHECK (duration_minutes IN (60, 90)),
      source           TEXT NOT NULL CHECK (source IN ('purchase','admin')),
      purchase_id      INT REFERENCES purchases(id),
      expires_on       DATE NOT NULL,
      booking_id       INT,
      void             BOOLEAN NOT NULL DEFAULT FALSE,
      note             TEXT,
      created_by       INT REFERENCES users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS credits_student_idx ON credits (student_id) WHERE booking_id IS NULL AND NOT void;

    CREATE TABLE IF NOT EXISTS group_sessions (
      id               SERIAL PRIMARY KEY,
      academy_id       INT NOT NULL REFERENCES academies(id),
      level            TEXT NOT NULL CHECK (level IN ('beginner','intermediate','advanced')),
      starts_at        TIMESTAMPTZ NOT NULL,
      duration_minutes INT NOT NULL CHECK (duration_minutes IN (60, 90)),
      court_id         INT NOT NULL REFERENCES courts(id),
      pro_id           INT NOT NULL REFERENCES users(id),
      capacity         INT NOT NULL DEFAULT 6 CHECK (capacity > 0),
      status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
      cancel_reason    TEXT,
      notes            TEXT,
      series_id        TEXT,
      created_by       INT REFERENCES users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS group_sessions_academy_starts_idx ON group_sessions (academy_id, starts_at);

    CREATE TABLE IF NOT EXISTS bookings (
      id           SERIAL PRIMARY KEY,
      academy_id   INT NOT NULL REFERENCES academies(id),
      session_id   INT NOT NULL REFERENCES group_sessions(id),
      student_id   INT NOT NULL REFERENCES users(id),
      credit_id    INT REFERENCES credits(id),
      status       TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
      attended     BOOLEAN,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      cancelled_at TIMESTAMPTZ,
      cancelled_by INT REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active
      ON bookings (session_id, student_id) WHERE status = 'booked';

    -- Private lessons. A pro posts an open slot (student_id NULL) or books a
    -- student directly. The student pays the pro by Zelle; the pro owes the
    -- academy the court fee. Both payments are tracked by hand here.
    CREATE TABLE IF NOT EXISTS private_lessons (
      id                SERIAL PRIMARY KEY,
      academy_id        INT NOT NULL REFERENCES academies(id),
      pro_id            INT NOT NULL REFERENCES users(id),
      student_id        INT REFERENCES users(id),
      starts_at         TIMESTAMPTZ NOT NULL,
      duration_minutes  INT NOT NULL CHECK (duration_minutes > 0),
      court_id          INT NOT NULL REFERENCES courts(id),
      price_cents       INT NOT NULL,
      academy_fee_cents INT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled')),
      student_paid      BOOLEAN NOT NULL DEFAULT FALSE,
      student_paid_at   TIMESTAMPTZ,
      fee_paid          BOOLEAN NOT NULL DEFAULT FALSE,
      fee_paid_at       TIMESTAMPTZ,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS private_lessons_academy_starts_idx ON private_lessons (academy_id, starts_at);

    -- Bumped whenever a password changes; tokens carrying an older value stop
    -- working, so a reset logs the account out everywhere else.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pwv INT NOT NULL DEFAULT 0;

    -- "Forgot password" links. Only a SHA-256 of the token is stored.
    CREATE TABLE IF NOT EXISTS password_resets (
      id          SERIAL PRIMARY KEY,
      academy_id  INT NOT NULL REFERENCES academies(id),
      user_id     INT NOT NULL REFERENCES users(id),
      token_hash  TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Records that a pro's group-lesson pay for a month was paid out.
    CREATE TABLE IF NOT EXISTS payroll_payments (
      id           SERIAL PRIMARY KEY,
      academy_id   INT NOT NULL REFERENCES academies(id),
      pro_id       INT NOT NULL REFERENCES users(id),
      month        TEXT NOT NULL,
      hours        NUMERIC(8,2) NOT NULL,
      amount_cents INT NOT NULL,
      paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_by      INT REFERENCES users(id),
      UNIQUE (pro_id, month)
    );

    -- Notes on a student. 'shared' = the student (and parents on that login)
    -- can read it; 'staff' = pros and the owner only, never sent to students.
    CREATE TABLE IF NOT EXISTS student_notes (
      id          SERIAL PRIMARY KEY,
      academy_id  INT NOT NULL REFERENCES academies(id),
      student_id  INT NOT NULL REFERENCES users(id),
      author_id   INT NOT NULL REFERENCES users(id),
      visibility  TEXT NOT NULL CHECK (visibility IN ('shared','staff')),
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS student_notes_student_idx ON student_notes (academy_id, student_id, created_at DESC);

    -- Pro court-hour budgets. A pro with court_budget_hours set rents that
    -- many court hours a month and owes the court fee on the budget, used or
    -- not; NULL = the old way, a court fee per private lesson.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS court_budget_hours NUMERIC(6,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS court_budget_since TEXT;  -- 'YYYY-MM' the budget started
    -- Students who agreed to cancellation texts (US texting rules need opt-in).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

    -- One month of a pro's budget, once management changes it or the fee is
    -- received. Without a row, the month uses users.court_budget_hours.
    CREATE TABLE IF NOT EXISTS pro_court_months (
      id                 SERIAL PRIMARY KEY,
      academy_id         INT NOT NULL REFERENCES academies(id),
      pro_id             INT NOT NULL REFERENCES users(id),
      month              TEXT NOT NULL,
      hours              NUMERIC(6,2),
      fee_cents_per_hour INT,
      fee_paid_at        TIMESTAMPTZ,
      fee_paid_by        INT REFERENCES users(id),
      updated_by         INT REFERENCES users(id),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (pro_id, month)
    );

    -- A pro asking management for more court hours in a month.
    CREATE TABLE IF NOT EXISTS court_hour_requests (
      id          SERIAL PRIMARY KEY,
      academy_id  INT NOT NULL REFERENCES academies(id),
      pro_id      INT NOT NULL REFERENCES users(id),
      month       TEXT NOT NULL,
      hours       NUMERIC(6,2) NOT NULL CHECK (hours > 0),
      reason      TEXT,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
      decided_by  INT REFERENCES users(id),
      decided_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Card surcharge added on top of the pack price, and auto-renewal links.
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS surcharge_cents INT NOT NULL DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS renewal_id INT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT UNIQUE;

    -- A student's monthly auto-renewal of a lesson pack: a Stripe subscription
    -- in the academy's own Stripe account. Each paid invoice adds that month's
    -- credits. cancel_at_period_end = the student turned it off.
    CREATE TABLE IF NOT EXISTS renewals (
      id                     SERIAL PRIMARY KEY,
      academy_id             INT NOT NULL REFERENCES academies(id),
      student_id             INT NOT NULL REFERENCES users(id),
      pack_id                INT REFERENCES lesson_packs(id),
      pack_name              TEXT NOT NULL,
      duration_minutes       INT NOT NULL,
      lesson_count           INT NOT NULL,
      amount_cents           INT NOT NULL,       -- pack price
      surcharge_cents        INT NOT NULL DEFAULT 0,
      first_purchase_id      INT UNIQUE REFERENCES purchases(id),
      first_renewal_month    TEXT NOT NULL,      -- first month charged automatically
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status                 TEXT NOT NULL DEFAULT 'creating'
                             CHECK (status IN ('creating','active','past_due','canceled','failed')),
      cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
      turned_off_by          INT REFERENCES users(id),
      last_renewed_month     TEXT,
      payment_failed_at      TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS renewals_student_idx ON renewals (academy_id, student_id);
  `);
}

// Per-academy settings live in academies.settings (JSONB); these fill gaps.
const DEFAULT_SETTINGS = {
  // A credit stays usable through the end of the month AFTER the month it was
  // bought for (or the month of the lesson it was cancelled from).
  credit_grace_months: 1,
  private_court_fee_cents_per_hour: 2000,
  default_private_rate_cents: 10000,
  default_group_capacity: 6,
  contact_email: '',
  contact_phone: '',
  // What the academy calls one-on-one bookings, e.g. "Court rental".
  private_label: 'Private lesson',
  // Card processing fee added to card payments, in hundredths of a percent
  // (300 = 3%). Card-network rules cap surcharges at 3%.
  card_surcharge_bps: 0,
  // Text students about cancellations (needs the platform's Twilio set up).
  sms_enabled: true,
};
const settingsOf = (academy) => ({ ...DEFAULT_SETTINGS, ...(academy.settings || {}) });

const DEFAULT_PACKS = [
  ['Single 1-hour lesson', 60, 1, 2250],
  ['4 × 1-hour lessons', 60, 4, 9000],
  ['8 × 1-hour lessons', 60, 8, 18000],
  ['Single 1½-hour lesson', 90, 1, 3750],
  ['4 × 1½-hour lessons', 90, 4, 15000],
  ['8 × 1½-hour lessons', 90, 8, 30000],
];

// Creates an academy with its owner account and starter lesson packs.
async function createAcademy(t, { slug, name, timezone, ownerName, ownerEmail, ownerPhone, passwordHash, trialDays, subStatus }) {
  const academy = (await t.query(
    `INSERT INTO academies (slug, name, timezone, sub_status, trial_ends_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(days => $5::int)) RETURNING *`,
    [slug, name, timezone || 'America/Los_Angeles', subStatus || 'trialing', trialDays])).rows[0];
  const owner = (await t.query(
    `INSERT INTO users (academy_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,'admin') RETURNING *`,
    [academy.id, ownerName, ownerEmail, ownerPhone, passwordHash])).rows[0];
  let sort = 0;
  for (const [pname, mins, count, cents] of DEFAULT_PACKS) {
    await t.query(
      `INSERT INTO lesson_packs (academy_id, name, duration_minutes, lesson_count, price_cents, sort) VALUES ($1,$2,$3,$4,$5,$6)`,
      [academy.id, pname, mins, count, cents, sort++]);
  }
  return { academy, owner };
}

module.exports = { connect, query, one, many, tx, settingsOf, createAcademy, DEFAULT_SETTINGS };
