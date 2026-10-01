# CLAUDE.md

Guidance for Claude Code in this repository.

## Commands

```bash
npm install
npm start                    # node server.js — needs .env (see .env.example)
node seed-demo.js --wipe     # local only: rebuild PGlite DB with demo academy /a/totaltennis
```

No build step, no test suite, no linter. Frontend is static files in `public/`. Node >= 18.

Without `DATABASE_URL` the app runs on PGlite (embedded Postgres, `./.pglite`) — only one process can open it at a time, so stop the server before running `seed-demo.js`. Schema lives in `db.js` `initSchema()`; keep it idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). No migrations.

## Architecture

Multi-tenant SaaS. One Express server (`server.js`), one data layer (`db.js`), vanilla HTML/JS pages.

- **Tenancy is enforced in application code only.** Every table has `academy_id`; every query must filter on the caller's `req.aid`. IDs from request bodies (court, pro, student, pack) must be checked against the academy (`activeCourt`, `resolveProId`, `academyStudent`). There is no row-level security to catch a missed filter.
- **Auth:** JWT `{ uid }` → `requireAuth` loads user + academy and sets `req.user`, `req.academy`, `req.aid`, `req.tz`. Roles: `student`, `pro`, `admin` (owner), per academy. Same email may exist in several academies. The operator (`/platform`) is a separate env-configured login with a `{ platform: true }` token, never an academy user.
- **Subscription gate:** `academyLive()` — trialing (before `trial_ends_at`), active, past_due, comped. When not live, `requireAuth` returns 402 for everyone except the owner on `/api/me` and `/api/billing/*`.
- **Two Stripe integrations.** Platform account (env `PLATFORM_STRIPE_*`) bills academies monthly; webhook `/api/platform/webhook`. Each academy's own account (encrypted in `academies.stripe_secret_enc` via `lib/crypto.js`) takes student pack payments; webhook `/api/stripe/webhook/:academyId`, plus `/api/purchases/confirm` on return. `fulfillPurchase` is idempotent. Webhook routes use `express.raw()` and must stay registered before `express.json()`.
- **Credits:** one row per lesson credit. Free = `booking_id IS NULL AND NOT void AND expires_on >= today`. Booking takes the soonest-expiring matching-length credit (`FOR UPDATE`); cancelling frees it and extends expiry to end of the month after the lesson (`credit_grace_months`).
- **Times:** stored `timestamptz`; everything displayed and grouped in the academy's `timezone`. The frontend converts `datetime-local` input as academy wall-clock time (`TT.zonedToIso`). Weekly repeats are computed in SQL in local time so DST doesn't shift them.
- **Pro hours** are derived, not logged: non-cancelled group sessions that have ended. Private lessons track `student_paid` (pro marks) and `fee_paid` (owner only).
- **Frontend:** helmet's default CSP is on, so no inline scripts or `on*=` handlers. Pages use `common.js` (`TT.html` escaping template, `TT.api`, modal/toast) and delegate clicks via `data-act` → `acts` in `app.js`.

## Product context

Built for Total Tennis Academy (Thousand Oaks, CA; mostly Cal Lutheran courts 1–7, plus Wildflower). Defaults: group $22.50/1 hr, $37.50/1½ hr; private $100/hr paid to the pro by Zelle, of which $20/hr court fee goes to the academy.
