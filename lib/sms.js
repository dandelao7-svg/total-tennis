// Text messages via Twilio's HTTP API (no SDK needed).
// One platform-wide Twilio account sends for every academy; the cost is part
// of the subscription. Unset → nothing is sent; outside production the text is
// printed to the console instead so flows can be tested locally.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
// TWILIO_MESSAGING_SERVICE_SID (recommended — what US business-texting
// registration, "A2P 10DLC", is attached to) or TWILIO_FROM (+18055550123).

const PROD = process.env.NODE_ENV === 'production';

const isConfigured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM));

// "(805) 495-0111" → "+18054950111"; null when it isn't a US number.
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

async function sendSms({ to, body }) {
  const number = e164(to);
  if (!number) return false;
  if (!isConfigured()) {
    if (!PROD) console.log(`\n── TEXT (not sent, dev) ──\nTo: ${number}\n${body}\n──────────\n`);
    return false;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const form = new URLSearchParams({ To: number, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) {
    // 21610 = the person replied STOP; Twilio blocks texts to them, which is correct.
    console.error(`Text send failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return false;
  }
  return true;
}

module.exports = { sendSms, isConfigured, e164 };
