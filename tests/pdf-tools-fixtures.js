'use strict';
// Generates the test fixtures for tests/pdf-tools.spec.ts into tests/fixtures/pdf-tools/.
// PDFs, the .docx and the images are built in headless Chromium (Playwright, already a dev
// dependency) with the SAME pinned pdf-lib / docx builds the page uses, so nothing is added
// to package.json. The encrypted PDF is written here in Node (PDF standard security handler,
// RC4 40-bit, user password "secret") because qpdf is not available.
// Run: node tests/pdf-tools-fixtures.js   (the generated files are committed)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('@playwright/test');

const OUT = path.join(__dirname, 'fixtures', 'pdf-tools');
const PDF_LIB = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const DOCX = 'https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.js';

// ── Encrypted PDF (RC4, R2) ─────────────────────────────
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
function encryptedPdf() {
  const user = 'secret', owner = 'owner-secret', P = -44;
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const O = rc4(md5(padPw(owner)).subarray(0, 5), padPw(user));
  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(P);
  const key = md5(padPw(user), O, pBuf, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (num, gen) => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])).subarray(0, 10);
  const content = rc4(objKey(4, 0), Buffer.from('BT /F1 18 Tf 40 150 Td (Top secret notes) Tj ET', 'latin1'));
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); len += buf.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  offsets[4] = len; push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream\nendobj\n');
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  obj(6, `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`);
  const xref = len;
  push(`xref\n0 7\n0000000000 65535 f \n`);
  for (let n = 1; n <= 6; n++) push(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

// ── Adds an EXIF orientation tag to a JPEG ──────────────
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                                  // one IFD entry
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ url: PDF_LIB });
  await page.addScriptTag({ url: DOCX });

  const files = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const D = window.docx;
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const blobB64 = async (blob) => b64(new Uint8Array(await blob.arrayBuffer()));
    const out = {};

    // canvas helpers
    function photo(w, h, hue) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${hue},60%,70%)`); grad.addColorStop(1, `hsl(${(hue + 120) % 360},55%,35%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      let seed = hue + 1;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `hsla(${Math.floor(rnd() * 360)},70%,${30 + rnd() * 50}%,0.35)`;
        g.beginPath(); g.arc(rnd() * w, rnd() * h, 10 + rnd() * w / 8, 0, Math.PI * 2); g.fill();
      }
      const id = g.getImageData(0, 0, w, h);
      for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * 30; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
      g.putImageData(id, 0, 0);
      return c;
    }
    const toBytes = (c, type, q) => new Promise((r) => c.toBlob(async (b) => r(new Uint8Array(await b.arrayBuffer())), type, q));

    // 1. text PDF: heading, paragraph with bold + italic runs, bullet list, numbered list, page 2
    {
      const pdf = await PDFDocument.create();
      const reg = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
      const p1 = pdf.addPage([595, 842]);
      p1.drawText('Study Notes on Photosynthesis', { x: 56, y: 770, size: 24, font: bold });
      let y = 730;
      const line = (parts) => {
        let x = 56;
        for (const [text, font] of parts) { p1.drawText(text, { x, y, size: 11, font }); x += font.widthOfTextAtSize(text, 11); }
        y -= 15;
      };
      line([['Plants turn light into chemical energy. The green pigment ', reg], ['Chlorophyll', bold], [' absorbs light,', reg]]);
      line([['mostly red and blue wavelengths, which is why leaves look ', reg], ['green', ital], [' to us.', reg]]);
      y -= 12;
      line([['A second paragraph explains where this happens inside the cell.', reg]]);
      y -= 12;
      line([['• Light-dependent reactions', reg]]);
      line([['• The Calvin cycle', reg]]);
      line([['• Glucose production', reg]]);
      y -= 12;
      line([['1. Water is split', reg]]);
      line([['2. Oxygen is released', reg]]);
      const p2 = pdf.addPage([595, 842]);
      p2.drawText('Summary', { x: 56, y: 770, size: 18, font: bold });
      p2.drawText('Photosynthesis feeds almost every food chain on Earth.', { x: 56, y: 740, size: 11, font: reg });
      out['text.pdf'] = b64(await pdf.save({ useObjectStreams: true }));
    }

    // 1b. lists.pdf — nested bullets by indentation ("-" / "*" under "•") and a "1)" numbered list
    {
      const pdf = await PDFDocument.create();
      const reg = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const p = pdf.addPage([595, 842]);
      p.drawText('Shopping and steps', { x: 56, y: 770, size: 20, font: bold });
      let y = 735;
      const row = (marker, text, x) => { p.drawText(marker, { x, y, size: 11, font: reg }); p.drawText(text, { x: x + 14, y, size: 11, font: reg }); y -= 17; };
      row('•', 'Fruit', 56); row('-', 'Apple', 80); row('-', 'Banana', 80);
      row('•', 'Vegetables', 56); row('*', 'Carrot', 80);
      y -= 14;
      row('1)', 'First step', 56); row('2)', 'Second step', 56);
      out['lists.pdf'] = b64(await pdf.save({ useObjectStreams: true }));
    }

    // 2 + 3. PDFs to merge — every page has its own size so the order can be checked
    async function sized(sizes, label) {
      const pdf = await PDFDocument.create();
      const f = await pdf.embedFont(StandardFonts.Helvetica);
      sizes.forEach(([w, h], i) => { const p = pdf.addPage([w, h]); p.drawText(`${label} page ${i + 1}`, { x: 30, y: h - 50, size: 16, font: f }); });
      return b64(await pdf.save());
    }
    out['two-pages.pdf'] = await sized([[401, 601], [402, 602]], 'Doc A');
    out['three-pages.pdf'] = await sized([[501, 701], [502, 702], [503, 703]], 'Doc B');

    // 4. image-heavy PDF (a large PNG-style image and a high-quality JPEG)
    {
      const pdf = await PDFDocument.create();
      const f = await pdf.embedFont(StandardFonts.Helvetica);
      const png = await pdf.embedPng(await toBytes(photo(800, 580, 30), 'image/png'));
      const jpg = await pdf.embedJpg(await toBytes(photo(2000, 1450, 200), 'image/jpeg', 0.95));
      const a = pdf.addPage([595, 842]);
      a.drawText('Lab photos — week 3', { x: 50, y: 790, size: 18, font: f });
      a.drawImage(png, { x: 50, y: 380, width: 495, height: 360 });
      const b = pdf.addPage([595, 842]);
      b.drawImage(jpg, { x: 50, y: 400, width: 495, height: 360 });
      out['images.pdf'] = b64(await pdf.save());
    }

    // 5. scanned PDF: the page is only an image of text (no text layer)
    {
      const c = document.createElement('canvas'); c.width = 1240; c.height = 600;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111'; g.font = 'bold 72px Arial'; g.fillText('Scanned lecture notes', 80, 200);
      g.font = '48px Arial'; g.fillText('Cells divide by mitosis.', 80, 330);
      const pdf = await PDFDocument.create();
      const img = await pdf.embedPng(await toBytes(c, 'image/png'));
      const p = pdf.addPage([595, 842]);
      p.drawImage(img, { x: 0, y: 842 - 288, width: 595, height: 288 });
      out['scanned.pdf'] = b64(await pdf.save());
    }

    // 6. page-limit PDFs
    async function blank(n) {
      const pdf = await PDFDocument.create();
      const f = await pdf.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < n; i++) pdf.addPage([300, 300]).drawText(`Page ${i + 1}`, { x: 20, y: 260, size: 12, font: f });
      return b64(await pdf.save({ useObjectStreams: true }));
    }
    out['pages-51.pdf'] = await blank(51);
    out['pages-301.pdf'] = await blank(301);

    // 7. Word document: heading, paragraph with a bold run, bullet list
    {
      const doc = new D.Document({
        sections: [{ children: [
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun('Lab Report Heading')] }),
          new D.Paragraph({ children: [new D.TextRun('The experiment produced an '), new D.TextRun({ text: 'important result', bold: true }), new D.TextRun(' worth noting.')] }),
          new D.Paragraph({ bullet: { level: 0 }, children: [new D.TextRun('First observation')] }),
          new D.Paragraph({ bullet: { level: 0 }, children: [new D.TextRun('Second observation')] }),
        ] }],
      });
      out['sample.docx'] = await blobB64(await D.Packer.toBlob(doc));
    }

    // 7b. 7-word-to-pdf.docx — reproduces the reported copy-text damage: "●" bullets, words and
    //     punctuation split across separate runs ("budg" + "ets", "protect" + ", ", "Student" + ":")
    {
      const R = (text, o = {}) => new D.TextRun({ text, ...o });
      const lvl = (format, text) => ({ level: 0, format, text, alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } });
      const doc = new D.Document({
        numbering: { config: [
          { reference: 'dots', levels: [lvl(D.LevelFormat.BULLET, '●')] },
          { reference: 'nums', levels: [lvl(D.LevelFormat.DECIMAL, '%1.')] },
        ] },
        sections: [{ children: [
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [R('Cyber Risk Management for Small Businesses')] }),
          new D.Paragraph({ children: [R('Student', { bold: true }), R(':', { bold: true }), R(' Test Student · Unit ITSC2003 · Assignment 2')] }),
          new D.Paragraph({ children: [
            R('Cybersecurity frameworks help organisations identify'), R(', '), R('protect'), R(', '), R('detect'), R(','),
            R(' respond to and recover from threats. Small businesses can adopt practical controls without large '),
            R('budg'), R('ets'), R('; focusing on patch management, multi-factor authentication and staff awareness training.'),
          ] }),
          new D.Paragraph({ children: [R('This report argues that '), R('basic controls prevent most attacks', { bold: true }), R(' and that '), R('awareness training', { italics: true }), R(' is the cheapest defence.')] }),
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [R('Key Controls')] }),
          new D.Paragraph({ numbering: { reference: 'dots', level: 0 }, children: [R('Enable multi-factor authentication on all accounts')] }),
          new D.Paragraph({ numbering: { reference: 'dots', level: 0 }, children: [R('Patch operating systems within 14 days')] }),
          new D.Paragraph({ numbering: { reference: 'dots', level: 0 }, children: [R('Keep offline backups and test restores')] }),
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [R('Implementation Steps')] }),
          new D.Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [R('Audit existing assets')] }),
          new D.Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [R('Prioritise high-risk systems')] }),
          new D.Paragraph({ children: [R('Costs (approx.): '), R('$1,200', { bold: true }), R(' per year — "worth it?" Yes!')] }),
        ] }],
      });
      out['7-word-to-pdf.docx'] = await blobB64(await D.Packer.toBlob(doc));
    }

    // 7c. Bengali Word document (complex script → print flow, not jsPDF)
    {
      const doc = new D.Document({ sections: [{ children: [
        new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun('Bangla notes')] }),
        new D.Paragraph({ children: [new D.TextRun('আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।')] }),
      ] }] });
      out['bengali.docx'] = await blobB64(await D.Packer.toBlob(doc));
    }

    // 8. images
    out['photo.jpg'] = b64(await toBytes(photo(600, 400, 90), 'image/jpeg', 0.9));
    out['shot.png'] = b64(await toBytes(photo(300, 500, 150), 'image/png'));
    out['pic.webp'] = b64(await toBytes(photo(400, 300, 260), 'image/webp', 0.9));
    out['rotated-raw.jpg'] = b64(await toBytes(photo(400, 200, 320), 'image/jpeg', 0.9));
    return out;
  });

  // Existing fixtures are kept (regenerating changes their bytes); pass --force to rebuild all.
  const force = process.argv.includes('--force');
  const write = (file, buf) => { const p = path.join(OUT, file); if (force || !fs.existsSync(p)) fs.writeFileSync(p, buf); };
  for (const [name, data] of Object.entries(files)) {
    let buf = Buffer.from(data, 'base64');
    let file = name;
    if (name === 'rotated-raw.jpg') { buf = withExifOrientation(buf, 6); file = 'rotated.jpg'; }  // 400×200 stored, shown 200×400
    write(file, buf);
  }
  write('encrypted.pdf', encryptedPdf());
  // an old binary Word file header (OLE compound file) — only used to test the .doc message
  write('old-format.doc', Buffer.concat([Buffer.from('D0CF11E0A1B11AE1', 'hex'), Buffer.alloc(1024)]));
  // 1-assignment.pdf is not generated: it is the owner's test document (synthetic content —
  // "Test Student", a 900×500 bar-chart image, a Control/Cost/Impact table), copied in as-is.

  await browser.close();
  for (const f of fs.readdirSync(OUT)) console.log(f.padEnd(18), fs.statSync(path.join(OUT, f)).size, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
