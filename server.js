require('dotenv').config({ quiet: true });

const path      = require('path');
const crypto    = require('crypto');
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const Stripe    = require('stripe');
const db        = require('./db');
const { encrypt, decrypt, isConfigured: encryptionConfigured } = require('./lib/crypto');
const email     = require('./lib/email');
const sms       = require('./lib/sms');

const PROD = process.env.NODE_ENV === 'production';
// In production, refuse to start half-configured — and name everything that's
// missing at once, so a crash-looping deploy explains itself in the logs.
if (PROD) {
  const missing = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`STARTUP STOPPED — missing required variable(s): ${missing.join(', ')}. ` +
      'Set them in Railway → your service → Variables. See .env.example for what each one is.');
    process.exit(1);
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (!encryptionConfigured()) console.warn('ENCRYPTION_KEY not set — academies cannot connect Stripe until it is.');

// Platform Stripe account: academies pay us a monthly subscription.
const platformStripe = process.env.PLATFORM_STRIPE_SECRET_KEY ? Stripe(process.env.PLATFORM_STRIPE_SECRET_KEY) : null;
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'CourtDesk';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// ── Helpers ──────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const RESERVED_SLUGS = new Set(['a', 'api', 'app', 'admin', 'www', 'start', 'platform', 'login', 'signup', 'help', 'support']);
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate  = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function int(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(400, `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} is invalid`);
  return n;
}
function str(v, name, { optional = false, max = 500 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (optional) return null;
    fail(400, `${name} is required`);
  }
  const s = String(v).trim();
  if (s.length > max) fail(400, `${name} is too long`);
  return s;
}
function timestamp(v, name) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) fail(400, `${name} is invalid`);
  return d.toISOString();
}
function emailOf(v) {
  const email = str(v, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email');
  return email;
}

// US numbers are stored as (805) 495-0111; anything else (e.g. +44…) is kept as typed.
function phoneOf(v, name = 'Phone') {
  const s = str(v, name, { optional: true, max: 40 });
  if (!s) return null;
  if (s.startsWith('+') && !s.startsWith('+1')) return s;
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) fail(400, `${name}: enter a 10-digit number, e.g. (805) 495-0111`);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// 'YYYY-MM' of a moment, in the given time zone.
function monthOf(tz, date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// Last day ('YYYY-MM-DD') of the month `n` months after `ym`.
function endOfMonth(ym, n = 0) {
  const [y, m] = addMonths(ym, n).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
const genPassword = () => crypto.randomBytes(9).toString('base64url');
const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role,
    level: u.level, levelNotes: u.level_notes, ratedAt: u.rated_at,
    hourlyRateCents: u.hourly_rate_cents, privateRateCents: u.private_rate_cents,
    zelleHandle: u.zelle_handle, active: u.active, createdAt: u.created_at,
    smsOptIn: u.sms_opt_in,
    courtBudgetHours: u.court_budget_hours == null ? null : Number(u.court_budget_hours),
  };
}

// An academy can use the app while trialing, paid up, briefly past due, or comped.
function academyLive(a) {
  if (['active', 'past_due', 'comped'].includes(a.sub_status)) return true;
  return a.sub_status === 'trialing' && a.trial_ends_at && new Date(a.trial_ends_at) > new Date();
}

function publicAcademy(a) {
  const s = db.settingsOf(a);
  return {
    id: a.id, slug: a.slug, name: a.name, timezone: a.timezone,
    contactEmail: s.contact_email, contactPhone: s.contact_phone,
    privateLabel: s.private_label,
    cardSurchargeBps: s.card_surcharge_bps,
    smsEnabled: !!s.sms_enabled,
  };
}

// The card processing fee added to a card payment of `cents`.
const surchargeOf = (academy, cents) => Math.round(cents * db.settingsOf(academy).card_surcharge_bps / 10000);

// ── Each academy's own Stripe (students paying the academy) ──

const _academyStripe = new Map();
function academyStripe(a) {
  if (!a.stripe_secret_enc) return null;
  const cacheKey = `${a.id}:${a.stripe_secret_enc}`;
  if (!_academyStripe.has(cacheKey)) _academyStripe.set(cacheKey, Stripe(decrypt(a.stripe_secret_enc)));
  return _academyStripe.get(cacheKey);
}

// ── Auth ─────────────────────────────────────────────────────

const signToken = (user) => jwt.sign({ uid: user.id, pwv: user.pwv || 0 }, JWT_SECRET, { expiresIn: '30d' });

// While an academy's subscription is lapsed, only the owner can get in, and
// only far enough to see their account and pay.
const LAPSED_ALLOWED = [/^\/api\/me$/, /^\/api\/billing\//];

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Session expired — please log in again' }); }
  if (!payload.uid) return res.status(401).json({ error: 'Please log in' });
  // Load fresh every request so role/level/deactivation changes apply immediately.
  const row = await db.one(
    `SELECT row_to_json(u) AS u, row_to_json(a) AS a
       FROM users u JOIN academies a ON a.id = u.academy_id WHERE u.id = $1`, [payload.uid]);
  if (!row || !row.u.active) return res.status(401).json({ error: 'Account not active' });
  // Password changed since this token was issued → log out.
  if ((payload.pwv || 0) !== row.u.pwv) return res.status(401).json({ error: 'Your password was changed — please log in again' });
  req.user = row.u;
  req.academy = row.a;
  req.aid = row.a.id;
  req.tz = row.a.timezone;
  req.live = academyLive(row.a);
  const urlPath = req.originalUrl.split('?')[0];
  if (!req.live && !(req.user.role === 'admin' && LAPSED_ALLOWED.some((r) => r.test(urlPath)))) {
    return res.status(402).json({
      error: req.user.role === 'admin'
        ? 'Your subscription is not active — go to Billing to restart it'
        : `${req.academy.name}'s online booking is paused — please contact the academy`,
      code: 'SUBSCRIPTION_INACTIVE',
    });
  }
  next();
}
const isStaff = (u) => u.role === 'pro' || u.role === 'admin';
function requireStaff(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Owner/admin only' });
  next();
}

// Platform operator (you): a separate login set by env, never an academy user,
// so signing up anywhere with the operator's email grants nothing.
function requirePlatform(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    if (p.platform === true) return next();
  } catch { /* fall through */ }
  res.status(401).json({ error: 'Platform login required' });
}

// ── Webhooks (need the raw body — register BEFORE express.json) ──

// Each academy's own Stripe account → student pack purchases.
app.post('/api/stripe/webhook/:academyId', express.raw({ type: 'application/json' }), async (req, res) => {
  const a = await db.one('SELECT * FROM academies WHERE id = $1', [Number(req.params.academyId) || 0]);
  if (!a || !a.stripe_webhook_secret_enc) return res.status(400).send('Webhook not configured for this academy');
  let event;
  try {
    event = academyStripe(a).webhooks.constructEvent(req.body, req.headers['stripe-signature'], decrypt(a.stripe_webhook_secret_enc));
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.metadata && s.metadata.purchase_id) {
      await fulfillPurchase(a, Number(s.metadata.purchase_id), s.id);
      if (s.metadata.renew === '1') await startRenewal(a, Number(s.metadata.purchase_id), s);
    }
  } else if (['invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    await renewalWebhook(a, event);
  }
  res.json({ received: true });
});

// Platform Stripe account → academy subscriptions.
app.post('/api/platform/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!platformStripe || !process.env.PLATFORM_STRIPE_WEBHOOK_SECRET) return res.status(400).send('Platform billing not configured');
  let event;
  try {
    event = platformStripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.PLATFORM_STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }
  const o = event.data.object;
  if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && o.metadata?.academy_id) {
    await db.query(
      `UPDATE academies SET platform_customer_id = $2, platform_subscription_id = $3,
              sub_status = CASE WHEN sub_status = 'comped' THEN sub_status ELSE 'active' END
        WHERE id = $1`, [Number(o.metadata.academy_id), o.customer, o.subscription]);
  } else if (event.type.startsWith('customer.subscription.')) {
    await applySubscription(o);
  }
  res.json({ received: true });
});

async function applySubscription(sub) {
  const map = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'canceled', canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled' };
  const status = map[sub.status];
  if (!status) return;
  const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  await db.query(
    `UPDATE academies SET sub_status = CASE WHEN sub_status = 'comped' THEN sub_status ELSE $2 END,
            platform_subscription_id = $3,
            current_period_end = COALESCE(to_timestamp($4::double precision), current_period_end)
      WHERE platform_customer_id = $1 OR id = $5`,
    [sub.customer, status, sub.id, periodEnd || null, Number(sub.metadata?.academy_id) || 0]);
}

app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/platform/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ ok: true }));

// ── Academy sign-up (a new paying customer) ──────────────────

app.post('/api/auth/academy-signup', async (req, res) => {
  const name = str(req.body.academyName, 'Academy name', { max: 100 });
  const slug = str(req.body.slug, 'Web address', { max: 40 }).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) fail(400, 'Web address: 3–40 lowercase letters, numbers or dashes');
  if (RESERVED_SLUGS.has(slug)) fail(409, 'That web address is taken');
  if (await db.one('SELECT 1 FROM academies WHERE slug = $1', [slug])) fail(409, 'That web address is taken');
  const timezone = req.body.timezone && validTimezone(req.body.timezone) ? req.body.timezone : 'America/Los_Angeles';
  const password = String(req.body.password || '');
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  const passwordHash = await bcrypt.hash(password, 12);
  const { owner } = await db.tx((t) => db.createAcademy(t, {
    slug, name, timezone,
    ownerName: str(req.body.name, 'Your name', { max: 100 }),
    ownerEmail: emailOf(req.body.email),
    ownerPhone: phoneOf(req.body.phone),
    passwordHash,
    trialDays: TRIAL_DAYS,
  }));
  res.json({ token: signToken(owner), slug });
});

app.get('/api/academy/:slug', async (req, res) => {
  const a = await db.one('SELECT * FROM academies WHERE slug = $1', [String(req.params.slug).toLowerCase()]);
  if (!a) fail(404, 'Academy not found');
  res.json(publicAcademy(a));
});

// ── Student / staff auth (scoped to one academy) ─────────────

async function academyBySlug(slug) {
  const a = await db.one('SELECT * FROM academies WHERE slug = $1', [String(slug || '').toLowerCase()]);
  if (!a) fail(404, 'Academy not found');
  return a;
}

app.post('/api/auth/signup', async (req, res) => {
  const a = await academyBySlug(req.body.academy);
  if (!academyLive(a)) fail(402, `${a.name}'s online booking is paused — please contact the academy`);
  const name = str(req.body.name, 'Name', { max: 100 });
  const email = emailOf(req.body.email);
  const phone = phoneOf(req.body.phone);
  const password = String(req.body.password || '');
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  if (await db.one('SELECT 1 FROM users WHERE academy_id = $1 AND email = $2', [a.id, email])) {
    fail(409, 'An account with that email already exists — try logging in');
  }
  const user = await db.one(
    `INSERT INTO users (academy_id, name, email, phone, password_hash, sms_opt_in) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [a.id, name, email, phone, await bcrypt.hash(password, 12), req.body.smsOptIn === true && !!phone]);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const a = await academyBySlug(req.body.academy);
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.one('SELECT * FROM users WHERE academy_id = $1 AND email = $2', [a.id, email]);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    fail(401, 'Wrong email or password');
  }
  if (!user.active) fail(403, 'This account has been deactivated — contact the academy');
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ── Forgot / reset password ──────────────────────────────────

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const RESET_MINUTES = 60;
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Always answers the same way, so it can't be used to discover who has an account.
app.post('/api/auth/forgot', async (req, res) => {
  const a = await academyBySlug(req.body.academy);
  const addr = String(req.body.email || '').trim().toLowerCase();
  const user = addr ? await db.one('SELECT * FROM users WHERE academy_id = $1 AND email = $2 AND active', [a.id, addr]) : null;
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO password_resets (academy_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))`, [a.id, user.id, sha256(token), RESET_MINUTES]);
    // The token rides in the #fragment so it never reaches server logs or Referer headers.
    const link = `${originOf(req)}/a/${a.slug}/reset#token=${token}`;
    const s = db.settingsOf(a);
    await email.sendEmail({
      to: user.email,
      replyTo: s.contact_email || undefined,
      subject: `Reset your ${a.name} password`,
      text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your password for ${a.name}'s lesson booking.\n\n`
        + `Choose a new password here. The link works once, for ${RESET_MINUTES} minutes:\n${link}\n\n`
        + `If you didn't ask for this, ignore this email and your password won't change.`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>Someone (hopefully you) asked to reset your password for ${escapeHtml(a.name)}'s lesson booking.</p>`
        + `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1f6b3a;color:#fff;border-radius:8px;text-decoration:none">Choose a new password</a></p>`
        + `<p style="color:#5d6b61;font-size:14px">The link works once, for ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email and your password won't change.</p>`,
    }).catch((err) => console.error('Reset email failed:', err));
  }
  res.json({ ok: true });
});

// "Email me my login links" on /login. Academies are never listed on screen —
// the links go only to the inbox of someone with an account — so nobody can
// browse which academies use the platform. Same answer whether or not it matched.
app.post('/api/auth/find-academies', async (req, res) => {
  const addr = String(req.body.email || '').trim().toLowerCase();
  const rows = addr ? await db.many(
    `SELECT a.slug, a.name, u.name AS user_name FROM users u JOIN academies a ON a.id = u.academy_id
      WHERE u.email = $1 AND u.active ORDER BY a.name`, [addr]) : [];
  if (rows.length) {
    const origin = originOf(req);
    const links = rows.map((r) => ({ name: r.name, url: `${origin}/a/${r.slug}` }));
    await email.sendEmail({
      to: addr,
      subject: rows.length === 1 ? `Your ${rows[0].name} login link` : 'Your lesson booking login links',
      text: `Hi ${rows[0].user_name},\n\nHere's where to log in:\n\n`
        + links.map((l) => `${l.name}: ${l.url}`).join('\n')
        + `\n\nBookmark it for next time. If you didn't ask for this, you can ignore this email.`,
      html: `<p>Hi ${escapeHtml(rows[0].user_name)},</p><p>Here's where to log in:</p>`
        + links.map((l) => `<p><a href="${l.url}" style="display:inline-block;padding:10px 18px;background:#1f6b3a;color:#fff;border-radius:8px;text-decoration:none">Log in to ${escapeHtml(l.name)}</a></p>`).join('')
        + `<p style="color:#5d6b61;font-size:14px">Bookmark it for next time. If you didn't ask for this, you can ignore this email.</p>`,
    }).catch((err) => console.error('Find-academies email failed:', err));
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  const hash = await bcrypt.hash(password, 12);
  const user = await db.tx(async (t) => {
    const r = (await t.query(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(token)])).rows[0];
    if (!r) fail(400, 'This reset link has expired or was already used. Request a new one.');
    // One reset retires every other outstanding link for the account.
    await t.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
    return (await t.query(
      'UPDATE users SET password_hash = $2, pwv = pwv + 1 WHERE id = $1 AND active RETURNING *', [r.user_id, hash])).rows[0];
  });
  if (!user) fail(403, 'This account has been deactivated. Contact the academy.');
  res.json({ token: signToken(user) });
});

// ── Shared lookups ───────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
  const a = req.academy;
  res.json({
    user: publicUser(req.user),
    credits: await creditSummary(req.aid, req.user.id, req.tz),
    academy: {
      ...publicAcademy(a),
      live: req.live,
      subStatus: a.sub_status,
      trialEndsAt: a.trial_ends_at,
      stripeConnected: !!a.stripe_secret_enc,
      // Local development only: purchases complete without Stripe.
      devPayments: !a.stripe_secret_enc && !PROD,
      renewAvailable: renewAvailable(a),
      smsAvailable: sms.isConfigured() || !PROD,
    },
  });
});

// Monthly auto-renewal needs the webhook: renewals are charged while nobody
// has the app open, and only the webhook tells us they were paid.
const renewAvailable = (a) => (a.stripe_secret_enc ? !!a.stripe_webhook_secret_enc : !PROD);

// A valid email not already used by someone else at this academy.
async function freeEmail(aid, value, exceptUserId) {
  const e = emailOf(value);
  if (await db.one('SELECT 1 FROM users WHERE academy_id = $1 AND email = $2 AND id <> $3', [aid, e, exceptUserId])) {
    fail(409, 'Someone at this academy already uses that email');
  }
  return e;
}

app.put('/api/me', requireAuth, async (req, res) => {
  const u = req.user;
  const name = str(req.body.name ?? u.name, 'Name', { max: 100 });
  const phone = phoneOf(req.body.phone);
  const zelle = isStaff(u) ? str(req.body.zelleHandle, 'Zelle', { optional: true, max: 200 }) : u.zelle_handle;
  let hash = u.password_hash;
  let pwv = u.pwv;
  let newEmail = u.email;
  if (req.body.email !== undefined && String(req.body.email).trim().toLowerCase() !== u.email) {
    // Changing the address you log in with needs your password, so an
    // unattended logged-in phone can't be used to take the account over.
    if (!(await bcrypt.compare(String(req.body.currentPassword || ''), u.password_hash))) {
      fail(400, 'Enter your current password to change your email');
    }
    newEmail = await freeEmail(req.aid, req.body.email, u.id);
  }
  if (req.body.newPassword) {
    if (!(await bcrypt.compare(String(req.body.currentPassword || ''), u.password_hash))) fail(400, 'Current password is wrong');
    if (String(req.body.newPassword).length < 8) fail(400, 'New password must be at least 8 characters');
    hash = await bcrypt.hash(String(req.body.newPassword), 12);
    pwv += 1;
  }
  const smsOptIn = (req.body.smsOptIn !== undefined ? req.body.smsOptIn === true : u.sms_opt_in) && !!phone;
  const user = await db.one(
    `UPDATE users SET name=$2, phone=$3, zelle_handle=$4, password_hash=$5, pwv=$6, email=$7, sms_opt_in=$8 WHERE id=$1 RETURNING *`,
    [u.id, name, phone, zelle, hash, pwv, newEmail, smsOptIn]);
  // A password change signs out other devices; hand this one a fresh token.
  res.json({ user: publicUser(user), ...(pwv !== u.pwv ? { token: signToken(user) } : {}) });
});

app.get('/api/locations', requireAuth, async (req, res) => {
  const locs = await db.many('SELECT id, name, address, active FROM locations WHERE academy_id = $1 ORDER BY id', [req.aid]);
  const courts = await db.many('SELECT id, location_id, name, active FROM courts WHERE academy_id = $1 ORDER BY location_id, id', [req.aid]);
  const all = isStaff(req.user) && req.query.all === '1';
  res.json(locs.filter((l) => all || l.active).map((l) => ({
    ...l,
    courts: courts.filter((c) => c.location_id === l.id && (all || c.active))
      .map((c) => ({ id: c.id, name: c.name, active: c.active })),
  })));
});

app.get('/api/pros', requireAuth, async (req, res) => {
  res.json(await db.many(
    `SELECT id, name, zelle_handle AS "zelleHandle", private_rate_cents AS "privateRateCents", role
       FROM users WHERE academy_id = $1 AND role IN ('pro','admin') AND active ORDER BY name`, [req.aid]));
});

app.get('/api/packs', requireAuth, async (req, res) => {
  res.json(await db.many(
    `SELECT id, name, duration_minutes AS "durationMinutes", lesson_count AS "lessonCount", price_cents AS "priceCents"
       FROM lesson_packs WHERE academy_id = $1 AND active ORDER BY sort, id`, [req.aid]));
});

// ── Credits ──────────────────────────────────────────────────

async function creditSummary(aid, studentId, tz) {
  const rows = await db.many(
    `SELECT duration_minutes AS mins, count(*)::int AS n, min(expires_on)::text AS soonest
       FROM credits
      WHERE academy_id = $1 AND student_id = $2 AND booking_id IS NULL AND NOT void
        AND expires_on >= (now() AT TIME ZONE $3)::date
      GROUP BY duration_minutes`, [aid, studentId, tz]);
  const out = { 60: 0, 90: 0, soonest: {} };
  for (const r of rows) { out[r.mins] = r.n; out.soonest[r.mins] = r.soonest; }
  return out;
}

async function issueCredits(t, { aid, studentId, minutes, count, expiresOn, source, purchaseId = null, note = null, createdBy = null }) {
  for (let i = 0; i < count; i++) {
    await t.query(
      `INSERT INTO credits (academy_id, student_id, duration_minutes, source, purchase_id, expires_on, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [aid, studentId, minutes, source, purchaseId, expiresOn, note, createdBy]);
  }
}

function creditList(aid, studentId, tz) {
  return db.many(
    `SELECT c.id, c.duration_minutes AS "durationMinutes", c.source, c.expires_on::text AS "expiresOn",
            c.void, c.note, c.booking_id AS "bookingId", c.created_at AS "createdAt",
            (c.expires_on < (now() AT TIME ZONE $3)::date) AS expired
       FROM credits c WHERE c.academy_id = $1 AND c.student_id = $2
      ORDER BY (c.booking_id IS NULL AND NOT c.void) DESC, c.expires_on, c.id`, [aid, studentId, tz]);
}

app.get('/api/my/credits', requireAuth, async (req, res) => {
  res.json({
    summary: await creditSummary(req.aid, req.user.id, req.tz),
    credits: await creditList(req.aid, req.user.id, req.tz),
  });
});

// ── Purchases (credit packs) ─────────────────────────────────

// Idempotent: only the first call for a pending purchase issues credits.
async function fulfillPurchase(academy, purchaseId, stripeSessionId = null) {
  const settings = db.settingsOf(academy);
  return db.tx(async (t) => {
    const p = (await t.query(
      `UPDATE purchases SET status = 'paid', paid_at = now(), stripe_session_id = COALESCE($3, stripe_session_id)
        WHERE id = $1 AND academy_id = $2 AND status = 'pending' RETURNING *`,
      [purchaseId, academy.id, stripeSessionId])).rows[0];
    if (!p) return false;
    await issueCredits(t, {
      aid: academy.id, studentId: p.student_id, minutes: p.duration_minutes, count: p.lesson_count,
      expiresOn: endOfMonth(p.for_month, settings.credit_grace_months), source: 'purchase', purchaseId: p.id,
    });
    return true;
  });
}

function originOf(req) {
  return process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
}

app.post('/api/purchases', requireAuth, async (req, res) => {
  const a = req.academy;
  const pack = await db.one('SELECT * FROM lesson_packs WHERE id = $1 AND academy_id = $2 AND active', [int(req.body.packId, 'Pack'), req.aid]);
  if (!pack) fail(404, 'That lesson pack is no longer available');
  const thisMonth = monthOf(req.tz);
  const forMonth = req.body.forMonth || thisMonth;
  if (!isMonth(forMonth) || forMonth < thisMonth || forMonth > addMonths(thisMonth, 2)) {
    fail(400, 'Pick this month or one of the next two');
  }
  const stripe = academyStripe(a);
  if (!stripe && PROD) fail(503, `${a.name} hasn't set up online card payments yet — please pay the academy directly`);
  const renew = req.body.renew === true;
  if (renew) {
    if (!renewAvailable(a)) fail(400, `${a.name} hasn't turned on monthly renewal yet`);
    // California's automatic-renewal law: the student must actively agree.
    if (req.body.agreeRenew !== true) fail(400, 'Tick the box to agree to the monthly charge');
    if (await activeRenewal(req.aid, req.user.id)) {
      fail(409, 'You already have a monthly plan. Turn it off under Account first to switch packs.');
    }
  }
  const surcharge = surchargeOf(a, pack.price_cents);

  const purchase = await db.one(
    `INSERT INTO purchases (academy_id, student_id, pack_id, pack_name, for_month, duration_minutes, lesson_count, amount_cents, surcharge_cents, method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stripe') RETURNING *`,
    [req.aid, req.user.id, pack.id, pack.name, forMonth, pack.duration_minutes, pack.lesson_count, pack.price_cents, surcharge]);

  if (!stripe) {
    // Local development only: no Stripe key, so "pay" instantly to exercise the flow.
    await db.query(`UPDATE purchases SET note = 'dev mode: no Stripe key' WHERE id = $1`, [purchase.id]);
    await fulfillPurchase(a, purchase.id);
    if (renew) await startRenewal(a, purchase.id, null);
    return res.json({ paid: true, renewing: renew });
  }

  const back = `${originOf(req)}/a/${a.slug}/app`;
  const lineItem = (cents, name, description) => ({
    quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name, description } },
  });
  const pct = (db.settingsOf(a).card_surcharge_bps / 100).toFixed(2).replace(/\.?0+$/, '');
  const prior = renew ? await db.one(
    `SELECT stripe_customer_id FROM renewals WHERE academy_id = $1 AND student_id = $2 AND stripe_customer_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [req.aid, req.user.id]) : null;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...(prior ? { customer: prior.stripe_customer_id } : { customer_email: req.user.email }),
    line_items: [
      lineItem(pack.price_cents, `${a.name}: ${pack.name}`, `Group lessons for ${monthName(forMonth)}`),
      ...(surcharge ? [lineItem(surcharge, 'Card processing fee', `${pct}% added to card payments`)] : []),
    ],
    metadata: { purchase_id: String(purchase.id), academy_id: String(a.id), student_id: String(req.user.id), renew: renew ? '1' : '' },
    // Monthly renewal: keep the card on file so next month's charge can run.
    ...(renew ? {
      ...(prior ? {} : { customer_creation: 'always' }),
      payment_intent_data: { setup_future_usage: 'off_session' },
      custom_text: { submit: { message: renewTerms(a, pack.price_cents + surcharge, addMonths(forMonth, 1)) } },
    } : {}),
    success_url: `${back}?checkout=success&session_id={CHECKOUT_SESSION_ID}#buy`,
    cancel_url: `${back}?checkout=cancelled#buy`,
  });
  await db.query('UPDATE purchases SET stripe_session_id = $2 WHERE id = $1', [purchase.id, session.id]);
  res.json({ url: session.url });
});

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
// The automatic-renewal terms, shown before paying and in the confirmation email.
const renewTerms = (a, cents, firstMonth) =>
  `You agree that ${a.name} will charge your card ${dollars(cents)} on the 1st of every month, starting ${monthName(firstMonth)}, `
  + `for that month's lessons, until you turn it off. Turn it off any time in the app under Account → My monthly plan; `
  + `lessons you've already paid for stay yours.`;

// Midnight on the 1st of month `ym` in time zone `tz`, as a Date.
function monthStartIn(ym, tz) {
  const [y, m] = ym.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, 1);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shownAs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (shownAs - guess));
}

// Called when Stripe redirects back, so credits appear even if the webhook is
// slow or not configured. Safe to repeat — fulfillment is idempotent.
app.post('/api/purchases/confirm', requireAuth, async (req, res) => {
  const stripe = academyStripe(req.academy);
  if (!stripe) fail(400, 'Card payments are not set up');
  const sessionId = str(req.body.sessionId, 'Session', { max: 300 });
  const p = await db.one(
    'SELECT * FROM purchases WHERE stripe_session_id = $1 AND student_id = $2 AND academy_id = $3',
    [sessionId, req.user.id, req.aid]);
  if (!p) fail(404, 'Purchase not found');
  if (p.status === 'paid' && await db.one('SELECT 1 FROM renewals WHERE first_purchase_id = $1', [p.id])) {
    return res.json({ paid: true, renewing: true });
  }
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  if (s.payment_status === 'paid') {
    await fulfillPurchase(req.academy, p.id, s.id);
    const renewing = !!(s.metadata && s.metadata.renew === '1');
    if (renewing) await startRenewal(req.academy, p.id, s);
    return res.json({ paid: true, renewing });
  }
  res.json({ paid: false });
});

// ── Monthly auto-renewal ─────────────────────────────────────
// After the first month is paid, a Stripe subscription in the academy's own
// account charges the same pack on the 1st of each following month. It is
// created with a free "trial" up to that 1st, so nothing extra is charged now.

const RENEWAL_SELECT = `
  SELECT r.id, r.student_id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
         r.pack_name AS "packName", r.duration_minutes AS "durationMinutes", r.lesson_count AS "lessonCount",
         r.amount_cents AS "amountCents", r.surcharge_cents AS "surchargeCents", r.status,
         r.cancel_at_period_end AS "turnedOff", r.first_renewal_month AS "firstRenewalMonth",
         r.last_renewed_month AS "lastRenewedMonth", r.payment_failed_at AS "paymentFailedAt",
         r.created_at AS "createdAt", r.updated_at AS "updatedAt"
    FROM renewals r JOIN users u ON u.id = r.student_id`;

const activeRenewal = (aid, studentId) => db.one(
  `SELECT * FROM renewals WHERE academy_id = $1 AND student_id = $2
      AND status IN ('creating','active','past_due') AND NOT cancel_at_period_end`, [aid, studentId]);

// The month the next automatic charge pays for.
const nextRenewalMonth = (r) => (r.lastRenewedMonth ? addMonths(r.lastRenewedMonth, 1) : r.firstRenewalMonth);

async function renewalEmail(academy, renewalId, kind) {
  const r = await db.one(`${RENEWAL_SELECT} WHERE r.id = $1`, [renewalId]);
  if (!r || !r.studentEmail) return;
  const s = db.settingsOf(academy);
  const total = r.amountCents + r.surchargeCents;
  const next = nextRenewalMonth(r);
  const lines = kind === 'started' ? [
    `Hi ${r.studentName},`, '',
    `Your monthly plan with ${academy.name} is on: ${r.packName}, ${dollars(total)} a month.`,
    renewTerms(academy, total, next), '',
    `To turn it off: log in, tap Account, then "Turn off monthly renewal" under My monthly plan.`,
  ] : [
    `Hi ${r.studentName},`, '',
    `Monthly renewal of ${r.packName} with ${academy.name} is now off. You won't be charged again.`,
    `Lessons you've already paid for stay in your account until they expire.`,
  ];
  lines.push('', `Questions? Contact ${academy.name}${s.contact_phone ? ` at ${s.contact_phone}` : ''}.`);
  await email.sendEmail({
    to: r.studentEmail, replyTo: s.contact_email || undefined,
    subject: kind === 'started' ? `Your monthly lesson plan with ${academy.name}` : `Monthly renewal turned off — ${academy.name}`,
    text: lines.join('\n'),
    html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
  }).catch((err) => console.error('Renewal email failed:', err));
}

// Idempotent: the webhook and the return-from-Checkout call may both arrive;
// whoever inserts the row first creates the Stripe subscription.
async function startRenewal(academy, purchaseId, session) {
  const p = await db.one(`SELECT * FROM purchases WHERE id = $1 AND academy_id = $2 AND status = 'paid'`, [purchaseId, academy.id]);
  if (!p) return null;
  const first = addMonths(p.for_month, 1);
  const r = await db.one(
    `INSERT INTO renewals (academy_id, student_id, pack_id, pack_name, duration_minutes, lesson_count, amount_cents,
                           surcharge_cents, first_purchase_id, first_renewal_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (first_purchase_id) DO NOTHING RETURNING *`,
    [academy.id, p.student_id, p.pack_id, p.pack_name, p.duration_minutes, p.lesson_count, p.amount_cents,
     p.surcharge_cents, p.id, first]);
  if (!r) return null;
  await db.query('UPDATE purchases SET renewal_id = $2 WHERE id = $1', [p.id, r.id]);
  const stripe = academyStripe(academy);
  if (!stripe) {
    // Local development: no Stripe; POST /api/dev/run-renewals plays the 1st of the month.
    await db.query(`UPDATE renewals SET status = 'active' WHERE id = $1`, [r.id]);
  } else {
    try {
      const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
      const customer = session.customer || pi.customer;
      const product = await stripe.products.create({ name: `${academy.name}: ${p.pack_name} (monthly)` });
      const sub = await stripe.subscriptions.create({
        customer,
        default_payment_method: pi.payment_method,
        items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: p.amount_cents + p.surcharge_cents, recurring: { interval: 'month' } } }],
        // A few minutes past midnight so the charge clearly belongs to the new month.
        trial_end: Math.floor(monthStartIn(first, academy.timezone).getTime() / 1000) + 300,
        proration_behavior: 'none',
        description: `${p.pack_name}, renewed monthly`,
        metadata: { renewal_id: String(r.id), academy_id: String(academy.id), student_id: String(p.student_id) },
      });
      await db.query(
        `UPDATE renewals SET status = 'active', stripe_customer_id = $2, stripe_subscription_id = $3, updated_at = now() WHERE id = $1`,
        [r.id, customer, sub.id]);
    } catch (err) {
      console.error(`Renewal setup failed for purchase ${p.id}:`, err.message);
      await db.query(`UPDATE renewals SET status = 'failed', updated_at = now() WHERE id = $1`, [r.id]);
      return null;
    }
  }
  renewalEmail(academy, r.id, 'started');
  return r;
}

// One month's automatic charge went through: record it and add the credits.
// Keyed by the invoice id, so a repeated webhook adds nothing.
async function renewMonth(academy, r, month, invoiceId) {
  const p = await db.one(
    `INSERT INTO purchases (academy_id, student_id, pack_id, pack_name, for_month, duration_minutes, lesson_count,
                            amount_cents, surcharge_cents, method, renewal_id, stripe_invoice_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stripe',$10,$11,'Monthly renewal')
     ON CONFLICT (stripe_invoice_id) DO NOTHING RETURNING id`,
    [academy.id, r.student_id, r.pack_id, r.pack_name, month, r.duration_minutes, r.lesson_count,
     r.amount_cents, r.surcharge_cents, r.id, invoiceId]);
  if (!p) return false;
  await fulfillPurchase(academy, p.id);
  await db.query(
    `UPDATE renewals SET last_renewed_month = GREATEST(COALESCE(last_renewed_month, ''), $2), status = 'active',
            payment_failed_at = NULL, updated_at = now() WHERE id = $1`, [r.id, month]);
  return true;
}

const idOf = (x) => (x && typeof x === 'object' ? x.id : x) || null;
// Newer Stripe API versions moved the subscription id under invoice.parent.
const invoiceSubscription = (inv) => idOf(inv.subscription)
  || idOf(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);

async function renewalWebhook(academy, event) {
  const o = event.data.object;
  const subId = event.type.startsWith('invoice.') ? invoiceSubscription(o) : o.id;
  if (!subId) return;
  const r = await db.one('SELECT * FROM renewals WHERE academy_id = $1 AND stripe_subscription_id = $2', [academy.id, subId]);
  if (!r) return;
  if (event.type === 'invoice.paid') {
    if (!o.amount_paid) return; // the $0 invoice when the plan starts
    const line = o.lines && o.lines.data && o.lines.data[0];
    const start = (line && line.period && line.period.start) || o.period_end;
    await renewMonth(academy, r, monthOf(academy.timezone, new Date((start + 3600) * 1000)), o.id);
  } else if (event.type === 'invoice.payment_failed') {
    await db.query(`UPDATE renewals SET status = 'past_due', payment_failed_at = now(), updated_at = now() WHERE id = $1`, [r.id]);
  } else {
    const status = { trialing: 'active', active: 'active', past_due: 'past_due', unpaid: 'past_due' }[o.status] || 'canceled';
    await db.query(
      `UPDATE renewals SET status = $2, cancel_at_period_end = $3, updated_at = now() WHERE id = $1`,
      [r.id, event.type === 'customer.subscription.deleted' ? 'canceled' : status, !!(o.cancel_at_period_end || o.cancel_at)]);
  }
}

// Turn a plan's renewal off (stops future charges) or back on.
async function setRenewal(academy, r, on, byUserId) {
  if (!['active', 'past_due'].includes(r.status)) fail(400, 'This plan has ended. Buy a pack with "Renew every month" to start a new one.');
  if (on === !r.cancel_at_period_end) return;
  if (on && await activeRenewal(academy.id, r.student_id)) fail(409, 'There is already a monthly plan running.');
  if (r.stripe_subscription_id) {
    const stripe = academyStripe(academy);
    if (!stripe) fail(400, 'Card payments are disconnected, so this plan cannot be changed here — change it in Stripe');
    await stripe.subscriptions.update(r.stripe_subscription_id, { cancel_at_period_end: !on });
  }
  await db.query(
    `UPDATE renewals SET cancel_at_period_end = $2, turned_off_by = $3, updated_at = now() WHERE id = $1`,
    [r.id, !on, on ? null : byUserId]);
  if (!on) renewalEmail(academy, r.id, 'stopped');
}

app.get('/api/my/renewals', requireAuth, async (req, res) => {
  const rows = await db.many(
    `${RENEWAL_SELECT} WHERE r.academy_id = $1 AND r.student_id = $2 AND r.status <> 'failed' ORDER BY r.id DESC LIMIT 10`,
    [req.aid, req.user.id]);
  res.json(rows.map((r) => ({ ...r, nextMonth: nextRenewalMonth(r) })));
});

app.put('/api/my/renewals/:id', requireAuth, async (req, res) => {
  const r = await db.one('SELECT * FROM renewals WHERE id = $1 AND academy_id = $2 AND student_id = $3',
    [int(req.params.id, 'Plan'), req.aid, req.user.id]);
  if (!r) fail(404, 'Plan not found');
  await setRenewal(req.academy, r, req.body.on === true, req.user.id);
  res.json({ ok: true });
});

function purchaseList(aid, where, params) {
  return db.many(
    `SELECT p.id, p.pack_name AS "packName", p.for_month AS "forMonth", p.duration_minutes AS "durationMinutes",
            p.lesson_count AS "lessonCount", p.amount_cents AS "amountCents", p.surcharge_cents AS "surchargeCents",
            p.renewal_id AS "renewalId", p.method, p.status, p.note,
            p.created_at AS "createdAt", p.paid_at AS "paidAt", u.name AS "studentName", p.student_id AS "studentId"
       FROM purchases p JOIN users u ON u.id = p.student_id
      WHERE p.academy_id = $1 AND ${where} AND p.status <> 'cancelled'
        AND NOT (p.status = 'pending' AND p.created_at < now() - interval '1 day')
      ORDER BY p.created_at DESC LIMIT 300`, [aid, ...params]);
}

app.get('/api/my/purchases', requireAuth, async (req, res) => {
  res.json(await purchaseList(req.aid, 'p.student_id = $2', [req.user.id]));
});

// ── Group sessions & bookings ────────────────────────────────

// Callers must add `g.academy_id = $n` to the WHERE clause.
const SESSION_SELECT = `
  SELECT g.id, g.level, g.starts_at AS "startsAt", g.duration_minutes AS "durationMinutes",
         g.capacity, g.status, g.notes, g.cancel_reason AS "cancelReason", g.series_id AS "seriesId",
         g.court_id AS "courtId", c.name AS "courtName", l.id AS "locationId", l.name AS "locationName",
         g.pro_id AS "proId", pu.name AS "proName",
         (SELECT count(*)::int FROM bookings b WHERE b.session_id = g.id AND b.status = 'booked') AS booked
    FROM group_sessions g
    JOIN courts c ON c.id = g.court_id
    JOIN locations l ON l.id = c.location_id
    JOIN users pu ON pu.id = g.pro_id`;

// Students see upcoming sessions at their own level; staff can see any level.
app.get('/api/sessions', requireAuth, async (req, res) => {
  const me = req.user;
  const params = [req.aid];
  const where = ['g.academy_id = $1', `g.status = 'scheduled'`, `g.starts_at > now()`];
  if (me.role === 'student') {
    if (me.level === 'unrated') return res.json({ sessions: [], unrated: true });
    params.push(me.level); where.push(`g.level = $${params.length}`);
  } else if (LEVELS.includes(req.query.level)) {
    params.push(req.query.level); where.push(`g.level = $${params.length}`);
  }
  if (req.query.locationId) { params.push(int(req.query.locationId, 'Location')); where.push(`l.id = $${params.length}`); }
  params.push(int(req.query.days ?? 28, 'Days', { min: 1, max: 120 }));
  where.push(`g.starts_at < now() + make_interval(days => $${params.length}::int)`);
  params.push(me.id);
  const rows = await db.many(
    `SELECT * FROM (${SESSION_SELECT} WHERE ${where.join(' AND ')}) s
       LEFT JOIN LATERAL (SELECT b.id AS "myBookingId" FROM bookings b
                           WHERE b.session_id = s.id AND b.student_id = $${params.length} AND b.status = 'booked') mb ON true
      ORDER BY s."startsAt"`, params);
  res.json({ sessions: rows });
});

// Books a student into a session using one matching credit. Shared by the
// student self-serve route and the staff "add student" route.
async function bookSession(t, { aid, tz, sessionId, student, enforceLevel }) {
  const s = (await t.query(
    `SELECT *, (starts_at AT TIME ZONE $3)::date::text AS local_date FROM group_sessions
      WHERE id = $1 AND academy_id = $2 FOR UPDATE`, [sessionId, aid, tz])).rows[0];
  if (!s || s.status !== 'scheduled') fail(404, 'That lesson is not available');
  if (new Date(s.starts_at) <= new Date()) fail(400, 'That lesson has already started');
  if (enforceLevel && student.level !== s.level) {
    fail(403, student.level === 'unrated'
      ? 'A pro needs to rate your level before you can join group lessons'
      : `This is a ${s.level} lesson — you can book ${student.level} lessons`);
  }
  const dup = (await t.query(
    `SELECT 1 FROM bookings WHERE session_id = $1 AND student_id = $2 AND status = 'booked'`, [s.id, student.id])).rows[0];
  if (dup) fail(409, 'Already booked into this lesson');
  const { n } = (await t.query(
    `SELECT count(*)::int AS n FROM bookings WHERE session_id = $1 AND status = 'booked'`, [s.id])).rows[0];
  if (n >= s.capacity) fail(409, 'Sorry — that lesson just filled up');
  const credit = (await t.query(
    `SELECT id FROM credits
      WHERE academy_id = $1 AND student_id = $2 AND duration_minutes = $3 AND booking_id IS NULL AND NOT void
        AND expires_on >= $4::date
      ORDER BY expires_on, id LIMIT 1 FOR UPDATE`, [aid, student.id, s.duration_minutes, s.local_date])).rows[0];
  if (!credit) {
    fail(402, `No ${s.duration_minutes === 60 ? '1-hour' : '1½-hour'} lesson credits left — buy a lesson pack first`, 'NO_CREDIT');
  }
  const booking = (await t.query(
    `INSERT INTO bookings (academy_id, session_id, student_id, credit_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [aid, s.id, student.id, credit.id])).rows[0];
  await t.query('UPDATE credits SET booking_id = $2 WHERE id = $1', [credit.id, booking.id]);
  return booking;
}

// Cancels a booking. What happens to the student's credit:
//   'standard' — it comes back, good through the end of the lesson's month
//                (plus the academy's credit_grace_months, which may be 0);
//   'next'     — it comes back, good through the end of the following month
//                (management's choice, e.g. a late-month rain-out);
//   'none'     — management decided no credit back; it stays used.
const CREDIT_MODES = ['standard', 'next', 'none'];
async function cancelBooking(t, { academy, bookingId, by, credit = 'standard' }) {
  const b = (await t.query(
    `SELECT b.*, to_char(g.starts_at AT TIME ZONE $3, 'YYYY-MM') AS lesson_month
       FROM bookings b JOIN group_sessions g ON g.id = b.session_id
      WHERE b.id = $1 AND b.academy_id = $2 FOR UPDATE OF b`,
    [bookingId, academy.id, academy.timezone])).rows[0];
  if (!b || b.status !== 'booked') return null;
  await t.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [b.id, by]);
  if (b.credit_id && credit !== 'none') {
    const grace = db.settingsOf(academy).credit_grace_months;
    await t.query(
      `UPDATE credits SET booking_id = NULL, expires_on = GREATEST(expires_on, $2::date) WHERE id = $1`,
      [b.credit_id, endOfMonth(b.lesson_month, credit === 'next' ? Math.max(1, grace) : grace)]);
  }
  return b;
}

// ── Telling students about a cancellation ──
// Emails every affected student (best effort, never blocks the cancel) and
// returns their contacts so staff can also copy the phone numbers into a text.
function creditLine(academy, credit, lessonMonth) {
  if (credit === 'none') return '';
  const grace = db.settingsOf(academy).credit_grace_months;
  const until = endOfMonth(lessonMonth, credit === 'next' ? Math.max(1, grace) : grace);
  const d = new Date(`${until}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `Your lesson credit is back in your account and can be used through ${d}.`;
}
// Also texts students who opted in; returns the set of student ids texted.
async function notifyCancelled(academy, items, reason) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: academy.timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const short = new Intl.DateTimeFormat('en-US', { timeZone: academy.timezone, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const s = db.settingsOf(academy);
  const texted = new Set();
  // Outside production, texts are printed to the console so this can be tried.
  if (s.sms_enabled && (sms.isConfigured() || !PROD)) {
    const ids = [...new Set(items.map((it) => it.studentId))];
    const rows = ids.length ? await db.many(
      'SELECT id FROM users WHERE academy_id = $1 AND id = ANY($2::int[]) AND sms_opt_in AND phone IS NOT NULL', [academy.id, ids]) : [];
    for (const r of rows) texted.add(r.id);
  }
  for (const it of items) {
    if (!texted.has(it.studentId)) continue;
    const body = `${academy.name}: your ${it.what} ${short.format(new Date(it.startsAt))} is cancelled${reason ? ` (${reason})` : ''}.`
      + `${it.smsExtra ? ` ${it.smsExtra}` : ''} Reply STOP to opt out.`;
    sms.sendSms({ to: it.phone, body }).catch((err) => console.error('Cancel text failed:', err));
  }
  for (const it of items) {
    if (!it.email) continue;
    const when = fmt.format(new Date(it.startsAt));
    const lines = [
      `Hi ${it.name},`, '',
      `Your ${it.what} on ${when}${it.where ? ` at ${it.where}` : ''} has been cancelled${reason ? ` (${reason})` : ''}.`,
      it.extra || '', '',
      `Questions? Contact ${academy.name}${s.contact_phone ? ` at ${s.contact_phone}` : ''}.`,
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
    email.sendEmail({
      to: it.email, replyTo: s.contact_email || undefined,
      subject: `Cancelled: your ${it.what} on ${when}`,
      text: lines.join('\n'),
      html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
    }).catch((err) => console.error('Cancel email failed:', err));
  }
  return texted;
}
const contactsOf = (items, texted = new Set()) => {
  const seen = new Map();
  for (const it of items) {
    if (!seen.has(it.studentId)) seen.set(it.studentId, { name: it.name, phone: it.phone, email: it.email, texted: texted.has(it.studentId) });
  }
  return [...seen.values()];
};

// Cancels one group session inside a transaction; returns who was booked.
async function cancelSessionTx(t, academy, sessionId, { by, reason, credit }) {
  await t.query(`UPDATE group_sessions SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [sessionId, reason]);
  const rows = (await t.query(
    `SELECT b.id, u.id AS student_id, u.name, u.phone, u.email, g.starts_at, l.name AS loc, c.name AS court,
            to_char(g.starts_at AT TIME ZONE $2, 'YYYY-MM') AS lesson_month
       FROM bookings b JOIN users u ON u.id = b.student_id JOIN group_sessions g ON g.id = b.session_id
       JOIN courts c ON c.id = g.court_id JOIN locations l ON l.id = c.location_id
      WHERE b.session_id = $1 AND b.status = 'booked'`, [sessionId, academy.timezone])).rows;
  for (const b of rows) await cancelBooking(t, { academy, bookingId: b.id, by, credit });
  return rows.map((b) => ({
    studentId: b.student_id, name: b.name, phone: b.phone, email: b.email, startsAt: b.starts_at,
    what: 'group lesson', where: `${b.loc}, ${b.court}`, extra: creditLine(academy, credit, b.lesson_month),
    smsExtra: credit === 'none' ? '' : 'Your lesson credit is back in your account.',
  }));
}

app.post('/api/sessions/:id/book', requireAuth, async (req, res) => {
  const booking = await db.tx((t) => bookSession(t, {
    aid: req.aid, tz: req.tz, sessionId: int(req.params.id, 'Lesson'), student: req.user, enforceLevel: true,
  }));
  res.json({ bookingId: booking.id, credits: await creditSummary(req.aid, req.user.id, req.tz) });
});

// Students may cancel right up until the lesson starts and get the credit back.
app.post('/api/bookings/:id/cancel', requireAuth, async (req, res) => {
  const b = await db.one(
    `SELECT b.*, g.starts_at, g.pro_id FROM bookings b JOIN group_sessions g ON g.id = b.session_id
      WHERE b.id = $1 AND b.academy_id = $2`, [int(req.params.id, 'Booking'), req.aid]);
  if (!b || (b.student_id !== req.user.id && !isStaff(req.user))) fail(404, 'Booking not found');
  if (b.status !== 'booked') fail(400, 'That booking is already cancelled');
  if (!isStaff(req.user) && new Date(b.starts_at) <= new Date()) fail(400, 'This lesson has already started — it can no longer be cancelled');
  await db.tx((t) => cancelBooking(t, { academy: req.academy, bookingId: b.id, by: req.user.id }));
  res.json({ ok: true, credits: await creditSummary(req.aid, b.student_id, req.tz) });
});

app.get('/api/my/bookings', requireAuth, async (req, res) => {
  const past = req.query.scope === 'past';
  res.json(await db.many(
    `SELECT b.id AS "bookingId", b.status AS "bookingStatus", b.attended, s.*
       FROM bookings b
       JOIN (${SESSION_SELECT} WHERE g.academy_id = $1) s ON s.id = b.session_id
      WHERE b.academy_id = $1 AND b.student_id = $2
        AND ${past ? `s."startsAt" <= now()` : `s."startsAt" > now() - interval '3 hours'`}
        AND (b.status = 'booked' OR s.status = 'cancelled')
      ORDER BY s."startsAt" ${past ? 'DESC LIMIT 100' : ''}`, [req.aid, req.user.id]));
});

// ── Private lessons ──────────────────────────────────────────

// Callers must add `p.academy_id = $n` to the WHERE clause.
const PRIVATE_SELECT = `
  SELECT p.id, p.starts_at AS "startsAt", p.duration_minutes AS "durationMinutes", p.status,
         p.price_cents AS "priceCents", p.academy_fee_cents AS "academyFeeCents",
         p.student_paid AS "studentPaid", p.fee_paid AS "feePaid", p.notes,
         p.pro_id AS "proId", pu.name AS "proName", pu.zelle_handle AS "proZelle",
         (pu.court_budget_hours IS NOT NULL) AS "onBudget",
         p.student_id AS "studentId", su.name AS "studentName", su.phone AS "studentPhone", su.email AS "studentEmail",
         p.court_id AS "courtId", c.name AS "courtName", l.name AS "locationName"
    FROM private_lessons p
    JOIN users pu ON pu.id = p.pro_id
    LEFT JOIN users su ON su.id = p.student_id
    JOIN courts c ON c.id = p.court_id
    JOIN locations l ON l.id = c.location_id`;

const studentView = ({ academyFeeCents, feePaid, studentEmail, studentPhone, onBudget, ...r }) => r;

app.get('/api/private/open', requireAuth, async (req, res) => {
  const rows = await db.many(
    `${PRIVATE_SELECT} WHERE p.academy_id = $1 AND p.status = 'open' AND p.starts_at > now() AND pu.active
      ORDER BY p.starts_at LIMIT 200`, [req.aid]);
  res.json(rows.map(studentView));
});

app.get('/api/my/private', requireAuth, async (req, res) => {
  const rows = await db.many(
    `${PRIVATE_SELECT} WHERE p.academy_id = $1 AND p.student_id = $2 AND p.status = 'booked'
        AND p.starts_at > now() - interval '30 days'
      ORDER BY p.starts_at`, [req.aid, req.user.id]);
  res.json(rows.map(studentView));
});

app.post('/api/private/:id/book', requireAuth, async (req, res) => {
  const id = int(req.params.id, 'Lesson');
  await db.tx(async (t) => {
    const p = (await t.query('SELECT * FROM private_lessons WHERE id = $1 AND academy_id = $2 FOR UPDATE', [id, req.aid])).rows[0];
    if (!p || p.status !== 'open') fail(409, 'Sorry — that time was just taken');
    if (new Date(p.starts_at) <= new Date()) fail(400, 'That time has passed');
    await t.query(`UPDATE private_lessons SET status = 'booked', student_id = $2 WHERE id = $1`, [id, req.user.id]);
  });
  res.json({ ok: true });
});

// Student cancel → the slot reopens for someone else. Staff cancel → the
// lesson is cancelled outright (or reopened with reopen: true).
app.post('/api/private/:id/cancel', requireAuth, async (req, res) => {
  const p = await db.one('SELECT * FROM private_lessons WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Lesson'), req.aid]);
  const staffOwner = p && (req.user.role === 'admin' || p.pro_id === req.user.id);
  if (!p || (!staffOwner && p.student_id !== req.user.id)) fail(404, 'Lesson not found');
  if (p.status === 'cancelled') fail(400, 'Already cancelled');
  if (staffOwner && !req.body.reopen) {
    await db.query(`UPDATE private_lessons SET status = 'cancelled' WHERE id = $1`, [p.id]);
    if (p.student_id) {
      const st = await db.one(
        `SELECT u.id, u.name, u.phone, u.email, l.name AS loc, c.name AS court FROM users u, courts c JOIN locations l ON l.id = c.location_id
          WHERE u.id = $1 AND c.id = $2`, [p.student_id, p.court_id]);
      const reason = str(req.body.reason, 'Reason', { optional: true, max: 200 });
      const items = [{ studentId: st.id, name: st.name, phone: st.phone, email: st.email, startsAt: p.starts_at,
        what: db.settingsOf(req.academy).private_label.toLowerCase(), where: `${st.loc}, ${st.court}`,
        extra: 'Please contact your pro to reschedule.', smsExtra: 'Please contact your pro to reschedule.' }];
      const texted = req.body.notify !== false ? await notifyCancelled(req.academy, items, reason) : undefined;
      return res.json({ ok: true, contacts: contactsOf(items, texted) });
    }
  } else {
    if (!staffOwner && new Date(p.starts_at) <= new Date()) fail(400, 'This lesson has already started');
    await db.query(
      `UPDATE private_lessons SET status = 'open', student_id = NULL, student_paid = FALSE, student_paid_at = NULL WHERE id = $1`,
      [p.id]);
  }
  res.json({ ok: true });
});

// ── Staff: scheduling ────────────────────────────────────────

// Returns anything already using that court or that pro during the window.
// Courts and pros are academy-scoped already, so no academy filter is needed.
async function findConflicts(t, { startsAt, minutes, courtId, proId, skipGroupId = null, skipPrivateId = null }) {
  return (await t.query(
    `SELECT 'group lesson' AS kind, g.starts_at AS "startsAt", c.name AS court, u.name AS pro,
            (g.court_id = $3) AS "sameCourt"
       FROM group_sessions g JOIN courts c ON c.id = g.court_id JOIN users u ON u.id = g.pro_id
      WHERE g.status = 'scheduled' AND (g.court_id = $3 OR g.pro_id = $4) AND g.id <> COALESCE($5::int, -1)
        AND g.starts_at < $1::timestamptz + make_interval(mins => $2::int)
        AND $1::timestamptz < g.starts_at + make_interval(mins => g.duration_minutes)
     UNION ALL
     SELECT 'private lesson', p.starts_at, c.name, u.name, (p.court_id = $3)
       FROM private_lessons p JOIN courts c ON c.id = p.court_id JOIN users u ON u.id = p.pro_id
      WHERE p.status <> 'cancelled' AND (p.court_id = $3 OR p.pro_id = $4) AND p.id <> COALESCE($6::int, -1)
        AND p.starts_at < $1::timestamptz + make_interval(mins => $2::int)
        AND $1::timestamptz < p.starts_at + make_interval(mins => p.duration_minutes)`,
    [startsAt, minutes, courtId, proId, skipGroupId, skipPrivateId])).rows;
}

// Weekly repeats keep the same local wall-clock time across daylight saving.
async function weeklyStarts(t, tz, startsAt, weeks) {
  const rows = (await t.query(
    `SELECT ((($1::timestamptz AT TIME ZONE $2) + make_interval(weeks => i)) AT TIME ZONE $2) AS ts
       FROM generate_series(0, $3::int - 1) AS i ORDER BY i`, [startsAt, tz, weeks])).rows;
  return rows.map((r) => new Date(r.ts).toISOString());
}

function conflictError(tz, conflicts) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const lines = conflicts.slice(0, 5).map((c) =>
    `${fmt.format(new Date(c.startsAt))}: ${c.sameCourt ? `${c.court} is taken` : `${c.pro} is busy`} (${c.kind})`);
  return new HttpError(409, `Time clash — nothing was saved.\n${lines.join('\n')}${conflicts.length > 5 ? `\n…and ${conflicts.length - 5} more` : ''}`);
}

async function resolveProId(req, requested) {
  if (req.user.role !== 'admin' || !requested) return req.user.id;
  const pro = await db.one(
    `SELECT id FROM users WHERE id = $1 AND academy_id = $2 AND role IN ('pro','admin') AND active`,
    [int(requested, 'Pro'), req.aid]);
  if (!pro) fail(400, 'Pick an active pro');
  return pro.id;
}

async function activeCourt(req, id) {
  const c = await db.one(
    `SELECT c.id FROM courts c JOIN locations l ON l.id = c.location_id
      WHERE c.id = $1 AND c.academy_id = $2 AND c.active AND l.active`, [int(id, 'Court'), req.aid]);
  if (!c) fail(400, 'Pick an active court');
  return c.id;
}

async function academyStudent(req, id) {
  const s = await db.one(`SELECT * FROM users WHERE id = $1 AND academy_id = $2 AND active`, [int(id, 'Student'), req.aid]);
  if (!s) fail(404, 'Student not found');
  return s;
}

app.post('/api/staff/sessions', requireAuth, requireStaff, async (req, res) => {
  const settings = db.settingsOf(req.academy);
  const level = req.body.level;
  if (!LEVELS.includes(level)) fail(400, 'Pick a level');
  const minutes = int(req.body.durationMinutes, 'Length');
  if (![60, 90].includes(minutes)) fail(400, 'Group lessons are 1 hour or 1½ hours');
  const startsAt = timestamp(req.body.startsAt, 'Start time');
  if (new Date(startsAt) <= new Date()) fail(400, 'Start time must be in the future');
  const courtId = await activeCourt(req, req.body.courtId);
  const proId = await resolveProId(req, req.body.proId);
  const capacity = int(req.body.capacity ?? settings.default_group_capacity, 'Capacity', { min: 1, max: 40 });
  const weeks = int(req.body.repeatWeeks ?? 1, 'Repeat', { min: 1, max: 26 });
  const notes = str(req.body.notes, 'Notes', { optional: true });
  const seriesId = weeks > 1 ? crypto.randomUUID() : null;

  const created = await db.tx(async (t) => {
    const starts = await weeklyStarts(t, req.tz, startsAt, weeks);
    const clashes = [];
    for (const s of starts) clashes.push(...await findConflicts(t, { startsAt: s, minutes, courtId, proId }));
    if (clashes.length) throw conflictError(req.tz, clashes);
    for (const s of starts) {
      await t.query(
        `INSERT INTO group_sessions (academy_id, level, starts_at, duration_minutes, court_id, pro_id, capacity, notes, series_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.aid, level, s, minutes, courtId, proId, capacity, notes, seriesId, req.user.id]);
    }
    return starts.length;
  });
  res.json({ created });
});

app.get('/api/staff/sessions', requireAuth, requireStaff, async (req, res) => {
  const from = req.query.from ? timestamp(req.query.from, 'From') : new Date(Date.now() - 864e5).toISOString();
  const to = req.query.to ? timestamp(req.query.to, 'To') : new Date(Date.now() + 28 * 864e5).toISOString();
  const params = [req.aid, from, to];
  const where = ['g.academy_id = $1', 'g.starts_at >= $2', 'g.starts_at < $3'];
  // Pros see their own sessions by default; ?mine=0 shows the whole board.
  if (req.query.mine === '1' || (req.user.role !== 'admin' && req.query.mine !== '0')) {
    params.push(req.user.id); where.push(`g.pro_id = $${params.length}`);
  }
  if (req.query.includeCancelled !== '1') where.push(`g.status = 'scheduled'`);
  res.json(await db.many(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY g.starts_at`, params));
});

async function staffSession(req) {
  const s = await db.one(`${SESSION_SELECT} WHERE g.id = $1 AND g.academy_id = $2`, [int(req.params.id, 'Lesson'), req.aid]);
  if (!s) fail(404, 'Lesson not found');
  if (req.user.role !== 'admin' && s.proId !== req.user.id && req.method !== 'GET') fail(403, 'Only the assigned pro or the owner can change this lesson');
  return s;
}

app.get('/api/staff/sessions/:id', requireAuth, requireStaff, async (req, res) => {
  const s = await staffSession(req);
  s.roster = await db.many(
    `SELECT b.id AS "bookingId", b.attended, b.created_at AS "bookedAt",
            u.id AS "studentId", u.name, u.phone, u.email, u.level
       FROM bookings b JOIN users u ON u.id = b.student_id
      WHERE b.session_id = $1 AND b.status = 'booked' ORDER BY u.name`, [s.id]);
  res.json(s);
});

app.put('/api/staff/sessions/:id', requireAuth, requireStaff, async (req, res) => {
  const s = await staffSession(req);
  if (s.status !== 'scheduled') fail(400, 'This lesson was cancelled');
  const level = req.body.level ?? s.level;
  if (!LEVELS.includes(level)) fail(400, 'Pick a level');
  const startsAt = req.body.startsAt ? timestamp(req.body.startsAt, 'Start time') : new Date(s.startsAt).toISOString();
  const minutes = int(req.body.durationMinutes ?? s.durationMinutes, 'Length');
  if (![60, 90].includes(minutes)) fail(400, 'Group lessons are 1 hour or 1½ hours');
  if (minutes !== s.durationMinutes && s.booked > 0) fail(400, 'Students are booked with credits for the current length — cancel and recreate the lesson instead');
  if (level !== s.level && s.booked > 0) fail(400, 'Students are already booked at this level — cancel and recreate the lesson instead');
  const courtId = req.body.courtId ? await activeCourt(req, req.body.courtId) : s.courtId;
  const proId = req.body.proId ? await resolveProId(req, req.body.proId) : s.proId;
  const capacity = int(req.body.capacity ?? s.capacity, 'Capacity', { min: Math.max(1, s.booked), max: 40 });
  const notes = req.body.notes !== undefined ? str(req.body.notes, 'Notes', { optional: true }) : s.notes;
  await db.tx(async (t) => {
    const clashes = await findConflicts(t, { startsAt, minutes, courtId, proId, skipGroupId: s.id });
    if (clashes.length) throw conflictError(req.tz, clashes);
    await t.query(
      `UPDATE group_sessions SET level=$2, starts_at=$3, duration_minutes=$4, court_id=$5, pro_id=$6, capacity=$7, notes=$8
        WHERE id = $1`, [s.id, level, startsAt, minutes, courtId, proId, capacity, notes]);
  });
  res.json({ ok: true });
});

// Cancelling a session (rain, no pro, …). Booked students get their credit back
// unless the owner chooses otherwise (only the owner decides credit-backs), and
// are emailed; the reply lists their contacts for a group text.
const creditModeFor = (req) => (req.user.role === 'admin' && CREDIT_MODES.includes(req.body.credit) ? req.body.credit : 'standard');
app.post('/api/staff/sessions/:id/cancel', requireAuth, requireStaff, async (req, res) => {
  const s = await staffSession(req);
  if (s.status !== 'scheduled') fail(400, 'Already cancelled');
  const reason = str(req.body.reason, 'Reason', { optional: true, max: 200 });
  const credit = creditModeFor(req);
  const series = req.body.wholeSeries && s.seriesId;
  const { n, items } = await db.tx(async (t) => {
    const targets = series
      ? (await t.query(
          `SELECT id FROM group_sessions WHERE academy_id = $1 AND series_id = $2 AND status = 'scheduled' AND starts_at >= $3`,
          [req.aid, s.seriesId, s.startsAt])).rows.map((r) => r.id)
      : [s.id];
    const all = [];
    for (const id of targets) all.push(...await cancelSessionTx(t, req.academy, id, { by: req.user.id, reason, credit }));
    return { n: targets.length, items: all };
  });
  const texted = req.body.notify !== false ? await notifyCancelled(req.academy, items, reason) : undefined;
  res.json({ cancelled: n, contacts: contactsOf(items, texted), emailed: req.body.notify !== false && email.isConfigured() });
});

// Owner only: cancel everything on one day (weather), optionally at one location.
// dryRun: true returns what would be cancelled without changing anything.
app.post('/api/admin/cancel-day', requireAuth, requireAdmin, async (req, res) => {
  if (!isDate(req.body.date)) fail(400, 'Pick a date');
  const reason = str(req.body.reason, 'Reason', { optional: true, max: 200 });
  const credit = creditModeFor(req);
  const locationId = req.body.locationId ? int(req.body.locationId, 'Location') : null;
  // Lessons on that local date that haven't finished yet.
  const scope = (alias) => `${alias}.academy_id = $1 AND (${alias}.starts_at AT TIME ZONE $2)::date = $3::date
    AND ${alias}.starts_at + make_interval(mins => ${alias}.duration_minutes) > now()
    AND ($4::int IS NULL OR c.location_id = $4::int)`;
  const params = [req.aid, req.tz, req.body.date, locationId];
  const groups = await db.many(
    `SELECT g.id, (SELECT count(*)::int FROM bookings b WHERE b.session_id = g.id AND b.status = 'booked') AS booked
       FROM group_sessions g JOIN courts c ON c.id = g.court_id
      WHERE ${scope('g')} AND g.status = 'scheduled'`, params);
  const privs = await db.many(
    `SELECT p.id, p.student_id, p.starts_at, u.name, u.phone, u.email, l.name AS loc, c.name AS court
       FROM private_lessons p JOIN courts c ON c.id = p.court_id JOIN locations l ON l.id = c.location_id
       LEFT JOIN users u ON u.id = p.student_id
      WHERE ${scope('p')} AND p.status <> 'cancelled'`, params);
  const summary = {
    groupLessons: groups.length, privateLessons: privs.length,
    studentsAffected: groups.reduce((a, g) => a + g.booked, 0) + privs.filter((p) => p.student_id).length,
  };
  if (req.body.dryRun) return res.json(summary);
  const label = db.settingsOf(req.academy).private_label.toLowerCase();
  const items = await db.tx(async (t) => {
    const all = [];
    for (const g of groups) all.push(...await cancelSessionTx(t, req.academy, g.id, { by: req.user.id, reason, credit }));
    for (const p of privs) {
      await t.query(`UPDATE private_lessons SET status = 'cancelled' WHERE id = $1`, [p.id]);
      if (p.student_id) {
        all.push({ studentId: p.student_id, name: p.name, phone: p.phone, email: p.email, startsAt: p.starts_at,
          what: label, where: `${p.loc}, ${p.court}`, extra: 'Please contact your pro to reschedule.', smsExtra: 'Please contact your pro to reschedule.' });
      }
    }
    return all;
  });
  const texted = req.body.notify !== false ? await notifyCancelled(req.academy, items, reason) : undefined;
  res.json({ ...summary, contacts: contactsOf(items, texted), emailed: req.body.notify !== false && email.isConfigured() });
});

app.post('/api/staff/sessions/:id/attendance', requireAuth, requireStaff, async (req, res) => {
  const s = await staffSession(req);
  const attended = req.body.attended === null ? null : !!req.body.attended;
  const r = await db.one(
    `UPDATE bookings SET attended = $3 WHERE id = $1 AND session_id = $2 AND status = 'booked' RETURNING id`,
    [int(req.body.bookingId, 'Booking'), s.id, attended]);
  if (!r) fail(404, 'Booking not found');
  res.json({ ok: true });
});

// Staff add a student (walk-in, or someone who called). Uses one of the
// student's credits; the owner may skip the level check.
app.post('/api/staff/sessions/:id/add', requireAuth, requireStaff, async (req, res) => {
  const s = await staffSession(req);
  const student = await academyStudent(req, req.body.studentId);
  await db.tx((t) => bookSession(t, {
    aid: req.aid, tz: req.tz, sessionId: s.id, student,
    enforceLevel: !(req.user.role === 'admin' && req.body.overrideLevel),
  }));
  res.json({ ok: true });
});

// ── Staff: students & ratings ────────────────────────────────

app.get('/api/staff/students', requireAuth, requireStaff, async (req, res) => {
  const params = [req.aid, req.tz];
  const where = ['u.academy_id = $1', `u.role = 'student'`, 'u.active'];
  if (req.query.q) {
    params.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(u.name) LIKE $${params.length} OR lower(u.email) LIKE $${params.length} OR u.phone LIKE $${params.length})`);
  }
  if ([...LEVELS, 'unrated'].includes(req.query.level)) { params.push(req.query.level); where.push(`u.level = $${params.length}`); }
  res.json(await db.many(
    `SELECT u.id, u.name, u.email, u.phone, u.level, u.level_notes AS "levelNotes", u.rated_at AS "ratedAt",
            r.name AS "ratedBy", u.created_at AS "createdAt",
            (SELECT count(*)::int FROM credits c WHERE c.student_id = u.id AND c.booking_id IS NULL AND NOT c.void
               AND c.expires_on >= (now() AT TIME ZONE $2)::date) AS "freeCredits"
       FROM users u LEFT JOIN users r ON r.id = u.rated_by
      WHERE ${where.join(' AND ')}
      ORDER BY (u.level = 'unrated') DESC, u.name LIMIT 500`, params));
});

app.get('/api/staff/students/:id', requireAuth, requireStaff, async (req, res) => {
  const u = await db.one(`SELECT * FROM users WHERE id = $1 AND academy_id = $2`, [int(req.params.id, 'Student'), req.aid]);
  if (!u) fail(404, 'Student not found');
  const upcoming = await db.many(
    `SELECT b.id AS "bookingId", s.* FROM bookings b JOIN (${SESSION_SELECT} WHERE g.academy_id = $1) s ON s.id = b.session_id
      WHERE b.student_id = $2 AND b.status = 'booked' AND s."startsAt" > now() ORDER BY s."startsAt"`, [req.aid, u.id]);
  const admin = req.user.role === 'admin';
  res.json({
    user: publicUser(u),
    credits: await creditSummary(req.aid, u.id, req.tz),
    creditList: admin ? await creditList(req.aid, u.id, req.tz) : undefined,
    purchases: admin ? await purchaseList(req.aid, 'p.student_id = $2', [u.id]) : undefined,
    upcoming,
  });
});

// Staff see both kinds of note; students only ever get 'shared' ones (/api/my/notes).
const noteList = (aid, studentId, sharedOnly) => db.many(
  `SELECT n.id, n.visibility, n.body, n.created_at AS "createdAt", a.name AS "authorName", n.author_id AS "authorId"
     FROM student_notes n JOIN users a ON a.id = n.author_id
    WHERE n.academy_id = $1 AND n.student_id = $2 ${sharedOnly ? `AND n.visibility = 'shared'` : ''}
    ORDER BY n.created_at DESC LIMIT 200`, [aid, studentId]);

app.get('/api/staff/students/:id/notes', requireAuth, requireStaff, async (req, res) => {
  const st = await academyStudent(req, req.params.id);
  res.json(await noteList(req.aid, st.id, false));
});
app.post('/api/staff/students/:id/notes', requireAuth, requireStaff, async (req, res) => {
  const st = await academyStudent(req, req.params.id);
  const visibility = req.body.visibility === 'shared' ? 'shared' : 'staff';
  const n = await db.one(
    `INSERT INTO student_notes (academy_id, student_id, author_id, visibility, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.aid, st.id, req.user.id, visibility, str(req.body.body, 'Note', { max: 4000 })]);
  res.json({ id: n.id });
});
app.delete('/api/staff/notes/:id', requireAuth, requireStaff, async (req, res) => {
  const n = await db.one('SELECT * FROM student_notes WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Note'), req.aid]);
  if (!n) fail(404, 'Note not found');
  if (n.author_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Only the note\'s author or the owner can delete it');
  await db.query('DELETE FROM student_notes WHERE id = $1', [n.id]);
  res.json({ ok: true });
});
app.get('/api/my/notes', requireAuth, async (req, res) => {
  res.json((await noteList(req.aid, req.user.id, true)).map(({ id, body, createdAt, authorName }) => ({ id, body, createdAt, authorName })));
});

app.put('/api/staff/students/:id/level', requireAuth, requireStaff, async (req, res) => {
  const level = req.body.level;
  if (![...LEVELS, 'unrated'].includes(level)) fail(400, 'Pick a level');
  const u = await db.one(
    `UPDATE users SET level = $3, level_notes = $4, rated_by = $5, rated_at = now()
      WHERE id = $1 AND academy_id = $2 AND role = 'student' RETURNING *`,
    [int(req.params.id, 'Student'), req.aid, level, str(req.body.notes, 'Notes', { optional: true, max: 1000 }), req.user.id]);
  if (!u) fail(404, 'Student not found');
  res.json({ user: publicUser(u) });
});

// ── Staff: private lessons ───────────────────────────────────

app.post('/api/staff/private', requireAuth, requireStaff, async (req, res) => {
  const settings = db.settingsOf(req.academy);
  const proId = await resolveProId(req, req.body.proId);
  const pro = await db.one('SELECT * FROM users WHERE id = $1', [proId]);
  const minutes = int(req.body.durationMinutes, 'Length', { min: 30, max: 240 });
  const startsAt = timestamp(req.body.startsAt, 'Start time');
  if (new Date(startsAt) <= new Date()) fail(400, 'Start time must be in the future');
  const courtId = await activeCourt(req, req.body.courtId);
  const weeks = int(req.body.repeatWeeks ?? 1, 'Repeat', { min: 1, max: 26 });
  const notes = str(req.body.notes, 'Notes', { optional: true });
  const studentId = req.body.studentId ? (await academyStudent(req, req.body.studentId)).id : null;
  const price = Math.round(pro.private_rate_cents * minutes / 60);
  const fee = Math.round(settings.private_court_fee_cents_per_hour * minutes / 60);
  const n = await db.tx(async (t) => {
    const starts = await weeklyStarts(t, req.tz, startsAt, weeks);
    const clashes = [];
    for (const s of starts) clashes.push(...await findConflicts(t, { startsAt: s, minutes, courtId, proId }));
    if (clashes.length) throw conflictError(req.tz, clashes);
    for (const s of starts) {
      await t.query(
        `INSERT INTO private_lessons (academy_id, pro_id, student_id, starts_at, duration_minutes, court_id, price_cents, academy_fee_cents, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.aid, proId, studentId, s, minutes, courtId, price, fee, studentId ? 'booked' : 'open', notes]);
    }
    return starts.length;
  });
  // Over budget is allowed — management decides — but say so straight away.
  const month = monthOf(req.tz, new Date(startsAt));
  const budget = await courtBudget(req.academy, pro, month);
  res.json({
    created: n,
    ...(budget && budget.overBy ? { budgetWarning: `${pro.name} now has ${budget.scheduledHours} court hours scheduled in ${monthName(month)}, `
      + `${budget.overBy} over the ${budget.hours}-hour budget. Ask management for more hours under My hours.` } : {}),
  });
});

app.get('/api/staff/private', requireAuth, requireStaff, async (req, res) => {
  const params = [req.aid];
  const where = ['p.academy_id = $1', `p.status <> 'cancelled'`];
  if (isMonth(req.query.month)) {
    params.push(req.query.month, req.tz);
    where.push(`to_char(p.starts_at AT TIME ZONE $3, 'YYYY-MM') = $2`);
  } else {
    where.push(`p.starts_at > now() - interval '1 day'`);
  }
  if (req.user.role !== 'admin' || req.query.mine === '1') { params.push(req.user.id); where.push(`p.pro_id = $${params.length}`); }
  else if (req.query.proId) { params.push(int(req.query.proId, 'Pro')); where.push(`p.pro_id = $${params.length}`); }
  res.json(await db.many(`${PRIVATE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.starts_at`, params));
});

// Pro marks "student paid me by Zelle"; only the owner marks the court fee received.
app.put('/api/staff/private/:id', requireAuth, requireStaff, async (req, res) => {
  const p = await db.one('SELECT * FROM private_lessons WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Lesson'), req.aid]);
  if (!p || (req.user.role !== 'admin' && p.pro_id !== req.user.id)) fail(404, 'Lesson not found');
  const sets = [];
  const params = [p.id];
  if (req.body.studentPaid !== undefined) {
    params.push(!!req.body.studentPaid);
    sets.push(`student_paid = $${params.length}`, `student_paid_at = CASE WHEN $${params.length} THEN now() END`);
  }
  if (req.body.feePaid !== undefined) {
    if (req.user.role !== 'admin') fail(403, 'Only the owner can mark court fees received');
    params.push(!!req.body.feePaid);
    sets.push(`fee_paid = $${params.length}`, `fee_paid_at = CASE WHEN $${params.length} THEN now() END`);
  }
  if (req.body.notes !== undefined) { params.push(str(req.body.notes, 'Notes', { optional: true })); sets.push(`notes = $${params.length}`); }
  if (req.body.studentId !== undefined && p.status !== 'cancelled') {
    const sid = req.body.studentId ? (await academyStudent(req, req.body.studentId)).id : null;
    params.push(sid); sets.push(`student_id = $${params.length}`, `status = '${sid ? 'booked' : 'open'}'`);
  }
  if (!sets.length) fail(400, 'Nothing to change');
  await db.query(`UPDATE private_lessons SET ${sets.join(', ')} WHERE id = $1`, params);
  res.json({ ok: true });
});

// ── Hours & payroll ──────────────────────────────────────────

// Group hours count once a session has ended and wasn't cancelled.
async function proMonth(aid, tz, proId, month) {
  const sessions = await db.many(
    `${SESSION_SELECT}
      WHERE g.academy_id = $1 AND g.pro_id = $2 AND g.status = 'scheduled'
        AND to_char(g.starts_at AT TIME ZONE $4, 'YYYY-MM') = $3
      ORDER BY g.starts_at`, [aid, proId, month, tz]);
  const now = Date.now();
  let doneMin = 0, upcomingMin = 0;
  for (const s of sessions) {
    s.ended = new Date(s.startsAt).getTime() + s.durationMinutes * 60000 <= now;
    if (s.ended) doneMin += s.durationMinutes; else upcomingMin += s.durationMinutes;
  }
  const priv = await db.one(
    `SELECT count(*)::int AS n,
            COALESCE(sum(duration_minutes), 0)::int AS mins,
            COALESCE(sum(price_cents), 0)::int AS "priceCents",
            COALESCE(sum(academy_fee_cents), 0)::int AS "feeCents",
            COALESCE(sum(academy_fee_cents) FILTER (WHERE NOT fee_paid), 0)::int AS "feeOwedCents",
            count(*) FILTER (WHERE NOT student_paid)::int AS "unpaidByStudents"
       FROM private_lessons
      WHERE academy_id = $1 AND pro_id = $2 AND status = 'booked'
        AND to_char(starts_at AT TIME ZONE $4, 'YYYY-MM') = $3 AND starts_at < now()`, [aid, proId, month, tz]);
  return { sessions, groupHours: doneMin / 60, upcomingHours: upcomingMin / 60, private: priv };
}

// ── Pro court-hour budgets ──
// Management sets how many court-rental hours a pro gets each month; the pro
// owes the court fee on those hours whether used or not. Going over is
// allowed (management decides) but flagged; pros ask for more via a request.

function hoursOf(v, name = 'Hours') {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 744) fail(400, `${name} is invalid`);
  return Math.round(n * 100) / 100;
}
const hasBudget = (pro, month) => pro.court_budget_hours != null && (!pro.court_budget_since || month >= pro.court_budget_since);

async function courtBudget(academy, pro, month) {
  if (!hasBudget(pro, month)) return null;
  const row = await db.one('SELECT * FROM pro_court_months WHERE pro_id = $1 AND month = $2', [pro.id, month]);
  const hours = Number(row && row.hours != null ? row.hours : pro.court_budget_hours);
  const rate = row && row.fee_cents_per_hour != null ? row.fee_cents_per_hour : db.settingsOf(academy).private_court_fee_cents_per_hour;
  const used = await db.one(
    `SELECT COALESCE(sum(duration_minutes), 0)::int AS mins FROM private_lessons
      WHERE academy_id = $1 AND pro_id = $2 AND status <> 'cancelled'
        AND to_char(starts_at AT TIME ZONE $4, 'YYYY-MM') = $3`, [academy.id, pro.id, month, academy.timezone]);
  const requests = await db.many(
    `SELECT id, hours::float AS hours, reason, status, created_at AS "createdAt", decided_at AS "decidedAt"
       FROM court_hour_requests WHERE pro_id = $1 AND month = $2 ORDER BY id DESC`, [pro.id, month]);
  const scheduledHours = used.mins / 60;
  return {
    month, hours, defaultHours: Number(pro.court_budget_hours), changed: !!(row && row.hours != null),
    scheduledHours, overBy: Math.max(0, Math.round((scheduledHours - hours) * 100) / 100),
    feeCentsPerHour: rate, feeCents: Math.round(hours * rate), feePaidAt: row ? row.fee_paid_at : null, requests,
  };
}

// Court fees budgeted pros still owe for months that have ended.
async function budgetFeesOwed(academy) {
  const last = addMonths(monthOf(academy.timezone), -1);
  const pros = await db.many(
    `SELECT * FROM users WHERE academy_id = $1 AND court_budget_hours IS NOT NULL AND active`, [academy.id]);
  let total = 0;
  for (const p of pros) {
    for (let m = p.court_budget_since || last; m <= last; m = addMonths(m, 1)) {
      const b = await courtBudget(academy, p, m);
      if (b && !b.feePaidAt) total += b.feeCents;
    }
  }
  return total;
}

// Per-lesson court fees don't apply to a budgeted pro's months.
const PER_LESSON_FEE = (alias, tzParam) => `NOT EXISTS (SELECT 1 FROM users bu WHERE bu.id = ${alias}.pro_id
  AND bu.court_budget_hours IS NOT NULL AND to_char(${alias}.starts_at AT TIME ZONE ${tzParam}, 'YYYY-MM') >= COALESCE(bu.court_budget_since, ''))`;

async function upsertCourtMonth(aid, proId, month, sets, by) {
  // sets: { hours?, fee_cents_per_hour?, fee_paid_at? } — only listed columns change.
  const cols = Object.keys(sets);
  await db.query(
    `INSERT INTO pro_court_months (academy_id, pro_id, month, ${cols.join(', ')}, updated_by)
     VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 5}`).join(', ')}, $4)
     ON CONFLICT (pro_id, month) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [aid, proId, month, by, ...cols.map((c) => sets[c])]);
}

async function academyPro(req, id) {
  const pro = await db.one(`SELECT * FROM users WHERE id = $1 AND academy_id = $2 AND role IN ('pro','admin')`, [int(id, 'Pro'), req.aid]);
  if (!pro) fail(404, 'Pro not found');
  return pro;
}

// Management changes one month's hours (blank = back to the usual amount).
app.put('/api/admin/court-budget', requireAuth, requireAdmin, async (req, res) => {
  const pro = await academyPro(req, req.body.proId);
  const month = req.body.month;
  if (!isMonth(month)) fail(400, 'Month is invalid');
  if (!hasBudget(pro, month)) fail(400, `${pro.name} isn't on a monthly court-hour budget for that month. Set one under Setup → Edit.`);
  const hours = req.body.hours === '' || req.body.hours === null ? null : hoursOf(req.body.hours);
  await upsertCourtMonth(req.aid, pro.id, month, { hours }, req.user.id);
  res.json({ budget: await courtBudget(req.academy, pro, month) });
});

app.post('/api/admin/court-budget/fee', requireAuth, requireAdmin, async (req, res) => {
  const pro = await academyPro(req, req.body.proId);
  const month = req.body.month;
  if (!isMonth(month)) fail(400, 'Month is invalid');
  const b = await courtBudget(req.academy, pro, month);
  if (!b) fail(400, 'No court-hour budget that month');
  // Freeze the hours and rate the fee was paid on.
  await upsertCourtMonth(req.aid, pro.id, month, req.body.paid === false
    ? { fee_paid_at: null }
    : { hours: b.hours, fee_cents_per_hour: b.feeCentsPerHour, fee_paid_at: new Date().toISOString() }, req.user.id);
  res.json({ ok: true });
});

// A pro asks management for more court hours.
app.post('/api/staff/court-requests', requireAuth, requireStaff, async (req, res) => {
  const month = req.body.month;
  if (!isMonth(month) || month < monthOf(req.tz)) fail(400, 'Pick this month or a later one');
  if (!hasBudget(req.user, month)) fail(400, 'You are not on a monthly court-hour budget — ask the owner');
  const hours = hoursOf(req.body.hours, 'Extra hours');
  if (hours <= 0) fail(400, 'Ask for at least a half hour');
  const reason = str(req.body.reason, 'Reason', { optional: true, max: 300 });
  await db.query(`INSERT INTO court_hour_requests (academy_id, pro_id, month, hours, reason) VALUES ($1,$2,$3,$4,$5)`,
    [req.aid, req.user.id, month, hours, reason]);
  const owners = await db.many(`SELECT email FROM users WHERE academy_id = $1 AND role = 'admin' AND active`, [req.aid]);
  const text = `${req.user.name} is asking for ${hours} more court hour${hours === 1 ? '' : 's'} in ${monthName(month)}`
    + `${reason ? `: "${reason}"` : '.'}\n\nApprove or decline it in the app under Payroll.`;
  for (const o of owners) {
    email.sendEmail({ to: o.email, subject: `Court hours request from ${req.user.name}`, text, html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` })
      .catch((err) => console.error('Request email failed:', err));
  }
  res.json({ ok: true });
});

app.post('/api/admin/court-requests/:id', requireAuth, requireAdmin, async (req, res) => {
  const r = await db.one(`SELECT * FROM court_hour_requests WHERE id = $1 AND academy_id = $2 AND status = 'pending'`,
    [int(req.params.id, 'Request'), req.aid]);
  if (!r) fail(404, 'Request not found or already answered');
  const approve = req.body.approve === true;
  if (approve) {
    const pro = await db.one('SELECT * FROM users WHERE id = $1', [r.pro_id]);
    const b = await courtBudget(req.academy, pro, r.month);
    if (!b) fail(400, `${pro.name} is no longer on a court-hour budget`);
    await upsertCourtMonth(req.aid, pro.id, r.month, { hours: b.hours + Number(r.hours) }, req.user.id);
  }
  await db.query(`UPDATE court_hour_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
    [r.id, approve ? 'approved' : 'declined', req.user.id]);
  res.json({ ok: true });
});

app.get('/api/staff/hours', requireAuth, requireStaff, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : monthOf(req.tz);
  const proId = req.user.role === 'admin' && req.query.proId ? int(req.query.proId, 'Pro') : req.user.id;
  const pro = await db.one('SELECT * FROM users WHERE id = $1 AND academy_id = $2', [proId, req.aid]);
  if (!pro) fail(404, 'Pro not found');
  const m = await proMonth(req.aid, req.tz, proId, month);
  const paid = await db.one(
    'SELECT amount_cents AS "amountCents", paid_at AS "paidAt" FROM payroll_payments WHERE pro_id = $1 AND month = $2',
    [proId, month]);
  res.json({
    month, pro: { id: pro.id, name: pro.name, hourlyRateCents: pro.hourly_rate_cents },
    ...m, groupPayCents: Math.round(m.groupHours * pro.hourly_rate_cents), payrollPaid: paid,
    courtBudget: await courtBudget(req.academy, pro, month),
  });
});

app.get('/api/admin/payroll', requireAuth, requireAdmin, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : monthOf(req.tz);
  const pros = await db.many(`SELECT * FROM users WHERE academy_id = $1 AND role IN ('pro','admin') ORDER BY name`, [req.aid]);
  const paid = await db.many('SELECT pro_id, amount_cents, paid_at FROM payroll_payments WHERE academy_id = $1 AND month = $2', [req.aid, month]);
  const rows = [];
  for (const p of pros) {
    const m = await proMonth(req.aid, req.tz, p.id, month);
    const idle = !m.sessions.length && !m.private.n && !hasBudget(p, month);
    if (idle && (!p.active || p.role === 'admin')) continue;
    const pp = paid.find((x) => x.pro_id === p.id);
    const budget = await courtBudget(req.academy, p, month);
    if (budget) {
      m.private.feeCents = budget.feeCents;
      m.private.feeOwedCents = budget.feePaidAt ? 0 : budget.feeCents;
    }
    rows.push({
      courtBudget: budget,
      proId: p.id, name: p.name, hourlyRateCents: p.hourly_rate_cents,
      groupSessions: m.sessions.filter((s) => s.ended).length,
      emptySessions: m.sessions.filter((s) => s.ended && s.booked === 0).length,
      groupHours: m.groupHours, upcomingHours: m.upcomingHours,
      groupPayCents: Math.round(m.groupHours * p.hourly_rate_cents),
      privateLessons: m.private.n, privateHours: m.private.mins / 60,
      courtFeesCents: m.private.feeCents, courtFeesOwedCents: m.private.feeOwedCents,
      paid: pp ? { amountCents: pp.amount_cents, paidAt: pp.paid_at } : null,
    });
  }
  const requests = await db.many(
    `SELECT r.id, r.pro_id AS "proId", u.name AS "proName", r.month, r.hours::float AS hours, r.reason, r.created_at AS "createdAt"
       FROM court_hour_requests r JOIN users u ON u.id = r.pro_id
      WHERE r.academy_id = $1 AND r.status = 'pending' ORDER BY r.created_at`, [req.aid]);
  res.json({ month, rows, requests });
});

app.post('/api/admin/payroll/mark-paid', requireAuth, requireAdmin, async (req, res) => {
  const month = req.body.month;
  if (!isMonth(month)) fail(400, 'Month is invalid');
  const pro = await db.one('SELECT * FROM users WHERE id = $1 AND academy_id = $2', [int(req.body.proId, 'Pro'), req.aid]);
  if (!pro) fail(404, 'Pro not found');
  if (req.body.undo) {
    await db.query('DELETE FROM payroll_payments WHERE pro_id = $1 AND month = $2', [pro.id, month]);
    return res.json({ ok: true });
  }
  const m = await proMonth(req.aid, req.tz, pro.id, month);
  await db.query(
    `INSERT INTO payroll_payments (academy_id, pro_id, month, hours, amount_cents, paid_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (pro_id, month) DO UPDATE SET hours = EXCLUDED.hours, amount_cents = EXCLUDED.amount_cents,
       paid_at = now(), paid_by = EXCLUDED.paid_by`,
    [req.aid, pro.id, month, m.groupHours, Math.round(m.groupHours * pro.hourly_rate_cents), req.user.id]);
  res.json({ ok: true });
});

// ── Admin ────────────────────────────────────────────────────

app.get('/api/admin/summary', requireAuth, requireAdmin, async (req, res) => {
  const month = monthOf(req.tz);
  const row = await db.one(
    `SELECT
       (SELECT COALESCE(sum(amount_cents),0)::int FROM purchases
         WHERE academy_id = $1 AND status = 'paid' AND to_char(paid_at AT TIME ZONE $2, 'YYYY-MM') = $3) AS "revenueCents",
       (SELECT count(*)::int FROM purchases
         WHERE academy_id = $1 AND status = 'paid' AND to_char(paid_at AT TIME ZONE $2, 'YYYY-MM') = $3) AS "purchases",
       (SELECT count(*)::int FROM users WHERE academy_id = $1 AND role = 'student' AND active) AS "students",
       (SELECT count(*)::int FROM users WHERE academy_id = $1 AND role = 'student' AND active AND level = 'unrated') AS "unrated",
       (SELECT count(*)::int FROM group_sessions WHERE academy_id = $1 AND status = 'scheduled'
         AND starts_at > now() AND starts_at < now() + interval '7 days') AS "sessionsNext7",
       (SELECT count(*)::int FROM bookings b JOIN group_sessions g ON g.id = b.session_id
         WHERE b.academy_id = $1 AND b.status = 'booked' AND g.starts_at > now() AND g.starts_at < now() + interval '7 days') AS "bookingsNext7",
       (SELECT COALESCE(sum(academy_fee_cents),0)::int FROM private_lessons
         WHERE academy_id = $1 AND status = 'booked' AND NOT fee_paid AND starts_at < now()
           AND ${PER_LESSON_FEE('private_lessons', '$2')}) AS "courtFeesOwedCents",
       (SELECT count(*)::int FROM court_hour_requests WHERE academy_id = $1 AND status = 'pending') AS "courtRequests",
       (SELECT count(*)::int FROM locations WHERE academy_id = $1) AS "locations",
       (SELECT count(*)::int FROM users WHERE academy_id = $1 AND role = 'pro') AS "pros"`,
    [req.aid, req.tz, month]);
  row.courtFeesOwedCents += await budgetFeesOwed(req.academy);
  res.json({ month, ...row, stripeConnected: !!req.academy.stripe_secret_enc });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const params = [req.aid];
  const where = ['academy_id = $1'];
  if (['student', 'pro', 'admin'].includes(req.query.role)) { params.push(req.query.role); where.push(`role = $${params.length}`); }
  if (req.query.q) {
    params.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length})`);
  }
  const rows = await db.many(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY active DESC, role, name LIMIT 1000`, params);
  res.json(rows.map(publicUser));
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const settings = db.settingsOf(req.academy);
  const name = str(req.body.name, 'Name', { max: 100 });
  const email = emailOf(req.body.email);
  const role = ['student', 'pro', 'admin'].includes(req.body.role) ? req.body.role : 'student';
  if (await db.one('SELECT 1 FROM users WHERE academy_id = $1 AND email = $2', [req.aid, email])) fail(409, 'That email already has an account');
  const tempPassword = genPassword();
  const u = await db.one(
    `INSERT INTO users (academy_id, name, email, phone, role, password_hash, hourly_rate_cents, private_rate_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.aid, name, email, phoneOf(req.body.phone), role, await bcrypt.hash(tempPassword, 12),
     int(req.body.hourlyRateCents ?? 0, 'Hourly rate', { min: 0, max: 100000 }),
     int(req.body.privateRateCents ?? settings.default_private_rate_cents, 'Private rate', { min: 0, max: 100000 })]);
  if (req.body.courtBudgetHours !== undefined && req.body.courtBudgetHours !== '') await setCourtBudget(req, u, req.body.courtBudgetHours);
  res.json({ user: publicUser(u), tempPassword });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'User'), req.aid]);
  if (!u) fail(404, 'User not found');
  const b = req.body;
  const role = b.role ?? u.role;
  if (!['student', 'pro', 'admin'].includes(role)) fail(400, 'Role is invalid');
  if (u.id === req.user.id && (role !== 'admin' || b.active === false)) fail(400, "You can't remove your own owner access");
  const level = b.level ?? u.level;
  if (![...LEVELS, 'unrated'].includes(level)) fail(400, 'Level is invalid');
  const newEmail = b.email !== undefined ? await freeEmail(req.aid, b.email, u.id) : u.email;
  const out = await db.one(
    `UPDATE users SET name=$2, phone=$3, role=$4, level=$5, hourly_rate_cents=$6, private_rate_cents=$7,
            zelle_handle=$8, active=$9, email=$11,
            rated_by = CASE WHEN $5 <> level THEN $10 ELSE rated_by END,
            rated_at = CASE WHEN $5 <> level THEN now() ELSE rated_at END
      WHERE id = $1 RETURNING *`,
    [u.id, str(b.name ?? u.name, 'Name', { max: 100 }), b.phone !== undefined ? phoneOf(b.phone) : u.phone,
     role, level,
     int(b.hourlyRateCents ?? u.hourly_rate_cents, 'Hourly rate', { min: 0, max: 100000 }),
     int(b.privateRateCents ?? u.private_rate_cents, 'Private rate', { min: 0, max: 100000 }),
     b.zelleHandle !== undefined ? str(b.zelleHandle, 'Zelle', { optional: true, max: 200 }) : u.zelle_handle,
     b.active ?? u.active, req.user.id, newEmail]);
  if (b.courtBudgetHours !== undefined) await setCourtBudget(req, out, b.courtBudgetHours);
  res.json({ user: publicUser(await db.one('SELECT * FROM users WHERE id = $1', [u.id])) });
});

// A pro's usual monthly court hours; blank = court fee per lesson instead.
// Changing it must not rewrite months already over, so those are frozen first.
async function setCourtBudget(req, pro, value) {
  const hours = value === '' || value === null ? null : hoursOf(value, 'Monthly court hours');
  const was = pro.court_budget_hours == null ? null : Number(pro.court_budget_hours);
  if (hours === was) return;
  const cur = monthOf(req.tz);
  if (was !== null && pro.court_budget_since) {
    for (let m = pro.court_budget_since; m < cur; m = addMonths(m, 1)) {
      await db.query(
        `INSERT INTO pro_court_months (academy_id, pro_id, month, hours, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (pro_id, month) DO UPDATE SET hours = COALESCE(pro_court_months.hours, EXCLUDED.hours)`,
        [req.aid, pro.id, m, was, req.user.id]);
    }
  }
  await db.query('UPDATE users SET court_budget_hours = $2, court_budget_since = $3 WHERE id = $1',
    [pro.id, hours, hours === null ? null : (was === null ? cur : pro.court_budget_since || cur)]);
}

// No email is configured yet, so the owner hands the person a temporary password.
app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const tempPassword = genPassword();
  const u = await db.one('UPDATE users SET password_hash = $3, pwv = pwv + 1 WHERE id = $1 AND academy_id = $2 RETURNING id',
    [int(req.params.id, 'User'), req.aid, await bcrypt.hash(tempPassword, 12)]);
  if (!u) fail(404, 'User not found');
  res.json({ tempPassword });
});

app.post('/api/admin/credits', requireAuth, requireAdmin, async (req, res) => {
  const student = await academyStudent(req, req.body.studentId);
  const minutes = int(req.body.durationMinutes, 'Length');
  if (![60, 90].includes(minutes)) fail(400, 'Length must be 1 hour or 1½ hours');
  const count = int(req.body.count, 'Count', { min: 1, max: 50 });
  const expiresOn = isDate(req.body.expiresOn)
    ? req.body.expiresOn : endOfMonth(monthOf(req.tz), db.settingsOf(req.academy).credit_grace_months);
  await db.tx((t) => issueCredits(t, {
    aid: req.aid, studentId: student.id, minutes, count, expiresOn, source: 'admin',
    note: str(req.body.note, 'Note', { optional: true, max: 200 }), createdBy: req.user.id,
  }));
  res.json({ ok: true });
});

app.post('/api/admin/credits/:id/void', requireAuth, requireAdmin, async (req, res) => {
  const r = await db.one(
    `UPDATE credits SET void = TRUE WHERE id = $1 AND academy_id = $2 AND booking_id IS NULL AND NOT void RETURNING id`,
    [int(req.params.id, 'Credit'), req.aid]);
  if (!r) fail(400, 'Only unused credits can be removed (cancel the booking first)');
  res.json({ ok: true });
});

app.post('/api/admin/credits/:id/extend', requireAuth, requireAdmin, async (req, res) => {
  if (!isDate(req.body.expiresOn)) fail(400, 'Pick a date');
  const r = await db.one('UPDATE credits SET expires_on = $3 WHERE id = $1 AND academy_id = $2 RETURNING id',
    [int(req.params.id, 'Credit'), req.aid, req.body.expiresOn]);
  if (!r) fail(404, 'Credit not found');
  res.json({ ok: true });
});

app.get('/api/admin/purchases', requireAuth, requireAdmin, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : monthOf(req.tz);
  res.json(await purchaseList(req.aid,
    `(to_char(COALESCE(p.paid_at, p.created_at) AT TIME ZONE $3, 'YYYY-MM') = $2)`, [month, req.tz]));
});

// Record a cash / check / Zelle payment taken in person; issues credits at once.
app.post('/api/admin/purchases', requireAuth, requireAdmin, async (req, res) => {
  const student = await academyStudent(req, req.body.studentId);
  const pack = await db.one('SELECT * FROM lesson_packs WHERE id = $1 AND academy_id = $2', [int(req.body.packId, 'Pack'), req.aid]);
  if (!pack) fail(404, 'Pack not found');
  const method = req.body.method;
  if (!['cash', 'check', 'zelle', 'comp'].includes(method)) fail(400, 'Pick how they paid');
  const forMonth = isMonth(req.body.forMonth) ? req.body.forMonth : monthOf(req.tz);
  const amount = method === 'comp' ? 0 : int(req.body.amountCents ?? pack.price_cents, 'Amount', { min: 0 });
  const p = await db.one(
    `INSERT INTO purchases (academy_id, student_id, pack_id, pack_name, for_month, duration_minutes, lesson_count, amount_cents, method, recorded_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.aid, student.id, pack.id, pack.name, forMonth, pack.duration_minutes, pack.lesson_count, amount, method, req.user.id,
     str(req.body.note, 'Note', { optional: true, max: 200 })]);
  await fulfillPurchase(req.academy, p.id);
  res.json({ ok: true });
});

app.get('/api/admin/packs', requireAuth, requireAdmin, async (req, res) => {
  res.json(await db.many(
    `SELECT id, name, duration_minutes AS "durationMinutes", lesson_count AS "lessonCount",
            price_cents AS "priceCents", active, sort FROM lesson_packs WHERE academy_id = $1 ORDER BY sort, id`, [req.aid]));
});

function packFields(b) {
  const minutes = int(b.durationMinutes, 'Length');
  if (![60, 90].includes(minutes)) fail(400, 'Length must be 1 hour or 1½ hours');
  return [str(b.name, 'Name', { max: 100 }), minutes, int(b.lessonCount, 'Lessons', { min: 1, max: 50 }),
    int(b.priceCents, 'Price', { min: 0, max: 1000000 }), b.active !== false, int(b.sort ?? 0, 'Sort')];
}
app.post('/api/admin/packs', requireAuth, requireAdmin, async (req, res) => {
  await db.query(
    `INSERT INTO lesson_packs (academy_id, name, duration_minutes, lesson_count, price_cents, active, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [req.aid, ...packFields(req.body)]);
  res.json({ ok: true });
});
app.put('/api/admin/packs/:id', requireAuth, requireAdmin, async (req, res) => {
  const r = await db.one(
    `UPDATE lesson_packs SET name=$3, duration_minutes=$4, lesson_count=$5, price_cents=$6, active=$7, sort=$8
      WHERE id=$1 AND academy_id=$2 RETURNING id`, [int(req.params.id, 'Pack'), req.aid, ...packFields(req.body)]);
  if (!r) fail(404, 'Pack not found');
  res.json({ ok: true });
});

app.post('/api/admin/locations', requireAuth, requireAdmin, async (req, res) => {
  const name = str(req.body.name, 'Name', { max: 100 });
  if (await db.one('SELECT 1 FROM locations WHERE academy_id = $1 AND lower(name) = lower($2)', [req.aid, name])) fail(409, 'That location already exists');
  const courts = int(req.body.courtCount ?? 1, 'Courts', { min: 0, max: 30 });
  const id = await db.tx(async (t) => {
    const loc = (await t.query('INSERT INTO locations (academy_id, name, address) VALUES ($1,$2,$3) RETURNING id',
      [req.aid, name, str(req.body.address, 'Address', { optional: true, max: 300 })])).rows[0];
    for (let i = 1; i <= courts; i++) {
      await t.query('INSERT INTO courts (academy_id, location_id, name) VALUES ($1,$2,$3)', [req.aid, loc.id, `Court ${i}`]);
    }
    return loc.id;
  });
  res.json({ id });
});
app.put('/api/admin/locations/:id', requireAuth, requireAdmin, async (req, res) => {
  const l = await db.one('SELECT * FROM locations WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Location'), req.aid]);
  if (!l) fail(404, 'Location not found');
  await db.query('UPDATE locations SET name=$2, address=$3, active=$4 WHERE id=$1', [l.id,
    str(req.body.name ?? l.name, 'Name', { max: 100 }),
    req.body.address !== undefined ? str(req.body.address, 'Address', { optional: true, max: 300 }) : l.address,
    req.body.active ?? l.active]);
  res.json({ ok: true });
});
app.post('/api/admin/locations/:id/courts', requireAuth, requireAdmin, async (req, res) => {
  const name = str(req.body.name, 'Court name', { max: 60 });
  const l = await db.one('SELECT id FROM locations WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Location'), req.aid]);
  if (!l) fail(404, 'Location not found');
  if (await db.one('SELECT 1 FROM courts WHERE location_id = $1 AND name = $2', [l.id, name])) fail(409, 'That court already exists here');
  await db.query('INSERT INTO courts (academy_id, location_id, name) VALUES ($1,$2,$3)', [req.aid, l.id, name]);
  res.json({ ok: true });
});
app.put('/api/admin/courts/:id', requireAuth, requireAdmin, async (req, res) => {
  const c = await db.one('SELECT * FROM courts WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Court'), req.aid]);
  if (!c) fail(404, 'Court not found');
  await db.query('UPDATE courts SET name=$2, active=$3 WHERE id=$1',
    [c.id, str(req.body.name ?? c.name, 'Court name', { max: 60 }), req.body.active ?? c.active]);
  res.json({ ok: true });
});

const NUMERIC_SETTINGS = ['credit_grace_months', 'private_court_fee_cents_per_hour', 'default_private_rate_cents', 'default_group_capacity'];
app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  res.json({
    name: req.academy.name, timezone: req.academy.timezone, settings: db.settingsOf(req.academy),
    stripeConnected: !!req.academy.stripe_secret_enc, stripeKeyHint: req.academy.stripe_key_hint,
    stripeWebhookSet: !!req.academy.stripe_webhook_secret_enc,
    webhookUrl: `${originOf(req)}/api/stripe/webhook/${req.aid}`,
    renewAvailable: renewAvailable(req.academy), smsConfigured: sms.isConfigured(),
  });
});

// Everyone on monthly auto-renewal, plus students who paid last month but
// have nothing for this one (cash/Zelle payers to chase).
app.get('/api/admin/renewals', requireAuth, requireAdmin, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : monthOf(req.tz);
  const plans = await db.many(
    `${RENEWAL_SELECT} WHERE r.academy_id = $1 AND (r.status IN ('active','past_due','creating')
        OR r.updated_at > now() - interval '60 days') AND r.status <> 'failed'
      ORDER BY (r.status = 'canceled'), r.cancel_at_period_end, u.name`, [req.aid]);
  const notRenewed = await db.many(
    `SELECT u.id AS "studentId", u.name AS "studentName", u.phone, u.email,
            string_agg(DISTINCT p.pack_name, ', ') AS "lastPacks"
       FROM purchases p JOIN users u ON u.id = p.student_id
      WHERE p.academy_id = $1 AND p.status = 'paid' AND p.for_month = $2 AND u.active
        AND NOT EXISTS (SELECT 1 FROM purchases q WHERE q.student_id = p.student_id AND q.status = 'paid' AND q.for_month = $3)
        AND NOT EXISTS (SELECT 1 FROM renewals r WHERE r.student_id = p.student_id
                          AND r.status IN ('active','past_due','creating') AND NOT r.cancel_at_period_end)
      GROUP BY u.id ORDER BY u.name`, [req.aid, addMonths(month, -1), month]);
  res.json({ month, plans: plans.map((r) => ({ ...r, nextMonth: nextRenewalMonth(r) })), notRenewed });
});

app.put('/api/admin/renewals/:id', requireAuth, requireAdmin, async (req, res) => {
  const r = await db.one('SELECT * FROM renewals WHERE id = $1 AND academy_id = $2', [int(req.params.id, 'Plan'), req.aid]);
  if (!r) fail(404, 'Plan not found');
  await setRenewal(req.academy, r, req.body.on === true, req.user.id);
  res.json({ ok: true });
});

// Local development only (no Stripe): play "the 1st of `month`" for this
// academy's plans — charge the ones still on, end the ones turned off.
app.post('/api/dev/run-renewals', requireAuth, requireAdmin, async (req, res) => {
  if (PROD || req.academy.stripe_secret_enc) fail(404, 'Not found');
  const month = isMonth(req.body.month) ? req.body.month : monthOf(req.tz);
  const plans = await db.many(
    `SELECT * FROM renewals WHERE academy_id = $1 AND stripe_subscription_id IS NULL AND status IN ('active','past_due')
        AND first_renewal_month <= $2`, [req.aid, month]);
  let renewed = 0, ended = 0;
  for (const r of plans) {
    if (r.cancel_at_period_end) {
      await db.query(`UPDATE renewals SET status = 'canceled', updated_at = now() WHERE id = $1`, [r.id]); ended++;
    } else if (await renewMonth(req.academy, r, month, `dev_${r.id}_${month}`)) renewed++;
  }
  res.json({ month, renewed, ended });
});
app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const patch = {};
  for (const k of NUMERIC_SETTINGS) {
    if (req.body[k] !== undefined) patch[k] = int(req.body[k], k, { min: 0, max: 1000000 });
  }
  if (req.body.contact_email !== undefined) patch.contact_email = str(req.body.contact_email, 'Contact email', { optional: true, max: 200 }) || '';
  if (req.body.contact_phone !== undefined) patch.contact_phone = phoneOf(req.body.contact_phone, 'Contact phone') || '';
  if (req.body.private_label !== undefined) patch.private_label = str(req.body.private_label, 'Name for one-on-one bookings', { max: 40 });
  if (req.body.card_surcharge_percent !== undefined) {
    const pct = Number(req.body.card_surcharge_percent || 0);
    // Visa/Mastercard cap surcharges at 3% (and lower where the academy's actual fee is lower).
    if (!Number.isFinite(pct) || pct < 0 || pct > 3) fail(400, 'Card processing fee must be between 0% and 3%');
    patch.card_surcharge_bps = Math.round(pct * 100);
  }
  if (req.body.sms_enabled !== undefined) patch.sms_enabled = req.body.sms_enabled === true;
  const name = req.body.name !== undefined ? str(req.body.name, 'Academy name', { max: 100 }) : req.academy.name;
  const tz = req.body.timezone && validTimezone(req.body.timezone) ? req.body.timezone : req.academy.timezone;
  await db.query('UPDATE academies SET name = $2, timezone = $3, settings = settings || $4::jsonb WHERE id = $1',
    [req.aid, name, tz, JSON.stringify(patch)]);
  res.json({ ok: true });
});

// The academy connects its OWN Stripe account so student payments go to it.
app.put('/api/admin/stripe', requireAuth, requireAdmin, async (req, res) => {
  if (req.body.disconnect) {
    await db.query(
      'UPDATE academies SET stripe_secret_enc = NULL, stripe_webhook_secret_enc = NULL, stripe_key_hint = NULL WHERE id = $1', [req.aid]);
    return res.json({ ok: true });
  }
  if (!encryptionConfigured()) fail(500, 'Server is missing ENCRYPTION_KEY — card payments cannot be connected yet');
  const sets = [];
  const params = [req.aid];
  if (req.body.secretKey) {
    const key = String(req.body.secretKey).trim();
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) fail(400, 'That doesn\'t look like a Stripe secret key (starts with sk_live_ or sk_test_)');
    try { await Stripe(key).balance.retrieve(); } catch (err) { fail(400, `Stripe rejected that key: ${err.message}`); }
    params.push(encrypt(key), `${key.slice(0, 8)}…${key.slice(-4)}`);
    sets.push(`stripe_secret_enc = $${params.length - 1}`, `stripe_key_hint = $${params.length}`);
  }
  if (req.body.webhookSecret) {
    const ws = String(req.body.webhookSecret).trim();
    if (!ws.startsWith('whsec_')) fail(400, 'The webhook signing secret starts with whsec_');
    params.push(encrypt(ws)); sets.push(`stripe_webhook_secret_enc = $${params.length}`);
  }
  if (!sets.length) fail(400, 'Nothing to save');
  await db.query(`UPDATE academies SET ${sets.join(', ')} WHERE id = $1`, params);
  res.json({ ok: true });
});

// ── Billing (the academy's subscription to this platform) ───

app.get('/api/billing/status', requireAuth, requireAdmin, async (req, res) => {
  const a = req.academy;
  res.json({
    subStatus: a.sub_status, live: req.live, trialEndsAt: a.trial_ends_at, currentPeriodEnd: a.current_period_end,
    hasSubscription: !!a.platform_subscription_id, billingEnabled: !!platformStripe,
    priceLabel: process.env.PLATFORM_PRICE_LABEL || '',
  });
});

app.post('/api/billing/checkout', requireAuth, requireAdmin, async (req, res) => {
  const a = req.academy;
  if (!platformStripe || !process.env.PLATFORM_STRIPE_PRICE_ID) {
    if (PROD) fail(503, 'Billing is not set up yet');
    // Local development: activate without a payment.
    await db.query(`UPDATE academies SET sub_status = 'active' WHERE id = $1 AND sub_status <> 'comped'`, [a.id]);
    return res.json({ activated: true });
  }
  const back = `${originOf(req)}/a/${a.slug}/app`;
  const session = await platformStripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.PLATFORM_STRIPE_PRICE_ID, quantity: 1 }],
    ...(a.platform_customer_id ? { customer: a.platform_customer_id } : { customer_email: req.user.email }),
    client_reference_id: String(a.id),
    metadata: { academy_id: String(a.id) },
    subscription_data: { metadata: { academy_id: String(a.id), academy_slug: a.slug } },
    success_url: `${back}?billing=success#billing`,
    cancel_url: `${back}#billing`,
  });
  res.json({ url: session.url });
});

app.post('/api/billing/portal', requireAuth, requireAdmin, async (req, res) => {
  if (!platformStripe || !req.academy.platform_customer_id) fail(400, 'No subscription on file yet');
  const s = await platformStripe.billingPortal.sessions.create({
    customer: req.academy.platform_customer_id,
    return_url: `${originOf(req)}/a/${req.academy.slug}/app#billing`,
  });
  res.json({ url: s.url });
});

// ── Platform operator ────────────────────────────────────────

app.post('/api/platform/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const hash = process.env.PLATFORM_ADMIN_PASSWORD_HASH;
  const ok = hash && email && email === String(process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase()
    && await bcrypt.compare(String(req.body.password || ''), hash);
  if (!ok) fail(401, 'Wrong email or password');
  res.json({ token: jwt.sign({ platform: true }, JWT_SECRET, { expiresIn: '12h' }) });
});

app.get('/api/platform/academies', requirePlatform, async (req, res) => {
  res.json(await db.many(
    `SELECT a.id, a.slug, a.name, a.sub_status AS "subStatus", a.trial_ends_at AS "trialEndsAt",
            a.current_period_end AS "currentPeriodEnd", a.created_at AS "createdAt",
            (a.stripe_secret_enc IS NOT NULL) AS "stripeConnected",
            (SELECT email FROM users u WHERE u.academy_id = a.id AND u.role = 'admin' ORDER BY id LIMIT 1) AS "ownerEmail",
            (SELECT count(*)::int FROM users u WHERE u.academy_id = a.id AND u.role = 'student') AS students,
            (SELECT count(*)::int FROM group_sessions g WHERE g.academy_id = a.id AND g.starts_at > now() - interval '30 days') AS "sessions30d",
            (SELECT COALESCE(sum(amount_cents),0)::int FROM purchases p WHERE p.academy_id = a.id AND p.status = 'paid'
               AND p.paid_at > now() - interval '30 days') AS "gmv30dCents"
       FROM academies a ORDER BY a.created_at DESC`));
});

app.put('/api/platform/academies/:id', requirePlatform, async (req, res) => {
  const status = req.body.subStatus;
  if (status && !['trialing', 'active', 'past_due', 'canceled', 'comped'].includes(status)) fail(400, 'Bad status');
  const trialEnds = req.body.trialEndsAt ? timestamp(req.body.trialEndsAt, 'Trial end') : null;
  const r = await db.one(
    `UPDATE academies SET sub_status = COALESCE($2, sub_status), trial_ends_at = COALESCE($3, trial_ends_at)
      WHERE id = $1 RETURNING id`, [int(req.params.id, 'Academy'), status || null, trialEnds]);
  if (!r) fail(404, 'Academy not found');
  res.json({ ok: true });
});

// ── Pages & errors ───────────────────────────────────────────

const PUBLIC = path.join(__dirname, 'public');
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get('/', page('index.html'));
app.get('/start', page('start.html'));
app.get('/login', page('login.html'));
app.get('/platform', page('platform.html'));
app.get('/a/:slug', page('academy.html'));
app.get('/a/:slug/reset', page('academy.html'));
app.get('/a/:slug/app', page('app.html'));
app.use(express.static(PUBLIC, { index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request body' });
  if (err.code === '23505') return res.status(409).json({ error: 'That already exists' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong — please try again' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  db.connect().then(() => {
    app.listen(PORT, () => console.log(`${PLATFORM_NAME} running on http://localhost:${PORT}`));
  }).catch((err) => { console.error('Startup failed:', err); process.exit(1); });
}

module.exports = { app, endOfMonth, monthOf, addMonths };
