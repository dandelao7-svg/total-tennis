// Transactional email via Resend's HTTP API (no SDK needed).
// Unset RESEND_API_KEY → nothing is sent; outside production the message is
// printed to the console instead so flows can be tested locally.

const PROD = process.env.NODE_ENV === 'production';

const isConfigured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!isConfigured()) {
    if (PROD) console.warn(`Email not sent (RESEND_API_KEY / EMAIL_FROM unset): "${subject}"`);
    else console.log(`\n── EMAIL (not sent, dev) ──\nTo: ${to}\nSubject: ${subject}\n\n${text}\n──────────\n`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!res.ok) {
    console.error(`Email send failed (${res.status}): ${await res.text().catch(() => '')}`);
    return false;
  }
  return true;
}

module.exports = { sendEmail, isConfigured };
