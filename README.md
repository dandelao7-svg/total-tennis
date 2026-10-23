# CourtDesk — lesson booking for tennis academies

A multi-academy (SaaS) web app. Each academy pays a monthly subscription and gets its
own booking page at `/a/<slug>` where students sign up, buy lesson packs and book
lessons. Built first for Total Tennis Academy.

## What it does

**Students** (phone-friendly)
- Sign up on the academy's booking page. Forgot password? A one-time reset link is emailed (needs RESEND_API_KEY + EMAIL_FROM).
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

Change requests from Total Tennis Academy's owner (demo, 2026-10-21), with the answers decided:

**Batch 1 (quick wins): DONE 2026-10-22** (wording setting in Setup; set "Extra months credits stay valid" to 0 for use it or lose it; texts via copy-numbers / Open in Messages until real texting is set up)
1. **"Private lesson" → "Court rental"** everywhere, as a per-academy wording setting. (Reason: workers' comp audits.)
2. **Use it or lose it:** lesson credits expire at the end of the month they were bought for (set credit grace to 0). When a lesson is cancelled for weather, **management decides** whether students get the credit back, and it can be valid into the next month.
3. **Notes on students:** "Coaching notes" visible to the student/parents (e.g. tournament feedback) and "Staff only" notes visible only to pros and the owner. Staff-only notes must never reach student screens.
4. **Weather cancellation:** cancel one lesson (exists), owner-only "cancel all lessons today" (optionally per location), email everyone booked, and a "copy phone numbers" button for group texts.

**Batch 2**
5. **Pro monthly court-hour budget:** owner sets each pro's monthly court-rental hours (default each month); only management can change them; a pro needing more requests it from management, who adjusts; the pro owes the court fee on the budgeted hours at month end; the owner sees fees still owed per pro. Replaces per-lesson court-fee tracking for these pros.
6. **Card surcharge:** customers paying by card pay the card processing fee so the academy nets the full price; disclosed before payment. Must follow card-network rules (cap ~3%, no surcharge on debit cards) and California pricing law; confirm with a lawyer / Stripe before going live.
7. **Real text messages** for cancellations (the owner wants texts, not just email): a texting service such as Twilio, which needs US business texting registration (A2P 10DLC) first, taking days to weeks.

8b. **Monthly auto-renewal of lesson packs** (owner request 2026-10-22: staff forget to recharge students). At checkout the student chooses **"Buy this month only"** or **"Buy and renew every month"** (California's automatic-renewal law needs an active choice, so no pre-ticked box). Built on Stripe subscriptions in the academy's own Stripe account: charge the current month now, then the same pack on the 1st of each month; each paid invoice adds that month's credits (needs the academy's Stripe webhook). Declined cards: Stripe retries and emails the student; owner sees "payment failed". **Students turn it off in Account → "My monthly plan"** (stops future charges, keeps this month's lessons), with a note on the Buy lessons tab. Owner sees everyone on auto-renew, can turn it off for a student, and gets a "Not renewed for <month>" list for cash/Zelle payers. Confirmation email with how to cancel. Build together with the card surcharge (item 6).

**Batch 3**
8. **Waivers:** annual e-signed waiver per student (parent signs for minors), owner pastes the waiver text, records name/date/version, expires after 12 months, can block booking until signed, QR code to the waiver page. Waiting on the academy's lawyer-written waiver.

Other ideas:

- **Academy shop (merch + stringing).** A "Shop" tab inside the app: the owner adds items (shirts, hats, bottles, towels, balls, grips) with photo, price and sizes; students pay by card into the academy's own Stripe. **Pick up at your next lesson** instead of shipping, and the pro sees "has an item to collect" on the lesson roster. Stringing works the same way: book and pay for a string job, then collect the racquet at the next lesson. For academies that want to ship to non-students, link a ShopSell store instead. Check with Total Tennis Academy's owner and the tester before building.

## Not built yet

- Booking confirmation and reminder emails (password-reset email is built).
- Card refunds from inside the app (refund in Stripe, then remove the credits).
- Waitlists for full lessons, and SMS reminders.
- Custom domains / subdomains (booking pages are `/a/<slug>` for now).
