// The signed copy of an e-signed document: the original PDF, untouched, with a
// signature certificate page added at the end listing who signed, when, from
// where, and the fingerprint (SHA-256) of the original everyone agreed to.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// The standard PDF fonts only cover Windows-1252 characters; anything else
// (a name in another script, an emoji) would make pdf-lib throw.
const SWAPS = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' };
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7e¡-ÿ]/g, (c) => SWAPS[c] ?? '?');

const when = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'long',
}).format(new Date(d));

async function buildSignedPdf({ original, title, sha256, completedAt, parties }) {
  const pdf = await PDFDocument.load(original);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, maxW = W - 2 * M;
  let page = pdf.addPage([W, H]);
  let y = H - M;

  // Write text wrapped to the page width, starting a new page when one fills up.
  function line(text, { f = font, size = 10, gap = 4, color = rgb(0.1, 0.14, 0.11) } = {}) {
    const words = safe(text).split(' ');
    let cur = '';
    const out = [];
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > maxW && cur) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
    for (const l of out) {
      if (y < M + size) { page = pdf.addPage([W, H]); y = H - M; }
      page.drawText(l, { x: M, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  }
  const space = (n) => { y -= n; };

  line('Electronic Signature Certificate', { f: bold, size: 18, gap: 10 });
  line(`Document: ${title}`, { f: bold, size: 11 });
  line(`Completed: ${when(completedAt)}`);
  line(`Pages in the original document: ${pdf.getPageCount() - 1}`);
  line(`SHA-256 fingerprint of the original document: ${sha256}`, { size: 8.5 });
  space(6);
  line('Every signer below viewed the document above, agreed to use electronic records and signatures, '
    + 'and adopted the typed name shown as their signature. The fingerprint identifies the exact document signed: '
    + 'any change to the original pages, however small, produces a different fingerprint.', { size: 9, color: rgb(0.36, 0.42, 0.38) });
  space(10);

  for (const p of parties) {
    if (y < M + 120) { page = pdf.addPage([W, H]); y = H - M; }
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.85, 0.88, 0.85) });
    space(12);
    line(p.signedName, { f: bold, size: 16, gap: 6 });
    if (p.signedTitle) line(`Title: ${p.signedTitle}`);
    line(`Email: ${p.email}`);
    line(`Opened the document: ${p.viewedAt ? when(p.viewedAt) : 'not recorded'}`);
    line(`Signed: ${when(p.signedAt)}`);
    line(`IP address: ${p.signedIp || 'not recorded'}`);
    line(`Device: ${p.signedAgent || 'not recorded'}`, { size: 8.5 });
    space(10);
  }
  return Buffer.from(await pdf.save());
}

module.exports = { buildSignedPdf };
