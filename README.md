# CourtDesk — lesson booking for tennis academies

A multi-academy (SaaS) web app. Each academy pays a monthly subscription and gets its
own booking page at `/a/<slug>` where students sign up, buy lesson packs and book
lessons. Built first for Total Tennis Academy.

## What it does

**Students** (phone-friendly)
- Sign up on the academy's booking page.
- Buy a month of group lessons as a credit pack (1-hour at $22.50, 1½-hour at $37.50 by default), paid by card into the academy's own Stripe account.
- Book group lessons by day, time and location — only at the skill level a pro gave them.
- Cancel up to the start time; the credit comes back and stays good through the end of the following month.
- Book a pro's open private-lesson times and see who to pay by Zelle and how much.

**Pros**
- Post group lessons (one-off or weekly), see rosters, take attendance, add walk-ins.
- Rate students beginner / intermediate / advanced.
- Post open private-lesson times or book a student directly; tick "student paid" when the Zelle arrives.
- See their own hours and group pay per month.

**Owner**
- Dashboard, setup checklist and a shareable booking link.
- Locations and courts (add more any time), lesson packs and prices, pros and their pay rates.
- Payroll: group hours × rate per pro per month, plus private-lesson court fees each pro owes (default $20/hr). Mark pay sent and fees received.
- Payments: every pack sold; record cash/check/Zelle payments; give or remove credits.
- Double-booking checks for courts and pros.
- Billing for their own subscription.

**You (the operator)** — `/platform`: every academy, its subscription status, students and sales. Change status (e.g. `comped` for a free account).

## Run locally

```bash
npm install
cp .env.example .env     # then set NODE_ENV= (blank), JWT_SECRET, ENCRYPTION_KEY
node seed-demo.js --wipe # optional: demo academy at /a/totaltennis
npm start                # http://localhost:3000
```

With no `DATABASE_URL`, the app uses an embedded Postgres (PGlite) in `./.pglite`.
With no Stripe keys and `NODE_ENV` not `production`, purchases and subscriptions complete instantly ("test mode").

## Deploy to Railway

1. Push this repo to GitHub. In Railway: **New Project → Deploy from GitHub repo**.
2. **+ New → Database → PostgreSQL**. In the app service's **Variables**, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Set the other variables from `.env.example` (`NODE_ENV=production`, `APP_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, the operator login). The schema is created on first boot.
4. **Your subscription billing**, in your own Stripe dashboard:
   - Product catalog → Add product → recurring monthly price → copy the price ID (`price_…`) into `PLATFORM_STRIPE_PRICE_ID`.
   - Developers → API keys → secret key into `PLATFORM_STRIPE_SECRET_KEY`.
   - Developers → Webhooks → Add endpoint `<APP_URL>/api/platform/webhook` with the four events listed in `.env.example`, then put the signing secret in `PLATFORM_STRIPE_WEBHOOK_SECRET`.
   - Settings → Billing → Customer portal → turn it on (lets academies update their card or cancel).
5. Visit `/start` to create the first academy, then `/platform` to check it's there.

## Each academy's own card payments

In the app: **Setup → Card payments**. The owner pastes their Stripe secret key, and optionally a webhook signing secret for `<APP_URL>/api/stripe/webhook/<academy id>`. The page shows the exact URL. Keys are encrypted at rest. Even without the webhook, credits are issued when the student returns from Stripe Checkout.

## To do

- **Show-password eye icon** on every password field (log in, sign up, academy sign-up, change password, operator login).
- **Self-serve password reset**: "Forgot password?" emails a one-time link. Needs email sending first (e.g. Resend, as in ShopSell). Today the owner resets passwords from the student's page.
- **Phone number formatting**: fields format as you type, `(805) 495-0111`, on every phone field.

## Not built yet

- Email (booking confirmations, reminders).
- Card refunds from inside the app (refund in Stripe, then remove the credits).
- Waitlists for full lessons, and SMS reminders.
- Custom domains / subdomains (booking pages are `/a/<slug>` for now).
