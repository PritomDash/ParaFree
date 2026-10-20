// PDF tools page (pdf-tools.html). Pages are served from THIS checkout (requests to parafree.app
// are fulfilled from disk), so the live site is never touched. Any /api/* request is answered
// with a 500 and fails the privacy test. GA / ads are BLOCKED. The pinned CDN libraries are
// fetched once and cached on disk (os.tmpdir()/parafree-cdn-cache) for later runs.
// Fixtures: tests/fixtures/pdf-tools (regenerate with `node tests/pdf-tools-fixtures.js`).
// Run: npx playwright test tests/pdf-tools.spec.ts
import { test, expect, Page, Route, Locator } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdf-tools');
const fx = (name: string) => path.join(FIX, name);
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};

test.setTimeout(180000);

type Req = { url: string; method: string; t: number };

async function cdnRoute(route: Route) {
  const url = route.request().url();
  fs.mkdirSync(CDN_CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const body = path.join(CDN_CACHE, key), meta = body + '.json';
  if (!fs.existsSync(body)) {
    const resp = await route.fetch();
    if (resp.status() !== 200) return route.fulfill({ response: resp });
    fs.writeFileSync(body, await resp.body());
    fs.writeFileSync(meta, JSON.stringify({ ct: resp.headers()['content-type'] || 'application/octet-stream' }));
  }
  const { ct } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return route.fulfill({ status: 200, body: fs.readFileSync(body), headers: { 'content-type': ct, 'access-control-allow-origin': '*' } });
}

async function setup(page: Page) {
  const ctx = page.context();
  const requests: Req[] = [];
  const apiCalls: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  ctx.on('request', (r) => requests.push({ url: r.url(), method: r.method(), t: Date.now() }));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route('https://cdn.jsdelivr.net/**', cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) { apiCalls.push(url.pathname); return route.fulfill({ status: 500, body: '{"error":"api must not be called"}' }); }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { requests, apiCalls, errors };
}

async function open(page: Page, hash = '') {
  const net = await setup(page);
  await page.goto('/pdf-tools.html' + hash);
  return net;
}
const panel = (page: Page, id: string) => page.locator('#panel-' + id);
const role = (p: Locator, r: string) => p.locator(`[data-role="${r}"]`);

async function ready(page: Page, id: string) {
  await expect(role(panel(page, id), 'lib-status')).toHaveText('Ready', { timeout: 60000 });
}

async function download(page: Page, button: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync((await d.path())!) };
}

// Re-parse a downloaded PDF with pdf-lib (the page's pinned copy) inside the browser.
async function pdfInfo(page: Page, buf: Buffer) {
  return page.evaluate(async (b64) => {
    const L = await (window as any).PFLoad.pdfLib();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await L.PDFDocument.load(bytes);
    return { pages: doc.getPageCount(), sizes: doc.getPages().map((p: any) => [Math.round(p.getWidth()), Math.round(p.getHeight())]) };
  }, buf.toString('base64'));
}
// Selectable text of a PDF, via pdf.js.
async function pdfText(page: Page, buf: Buffer) {
  return page.evaluate(async (b64) => {
    const W = window as any;
    const pdfjs = await W.PFLoad.pdfjs();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await pdfjs.getDocument(W.PFLoad.pdfjsOptions(bytes)).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(' ') + '\n';
    return text;
  }, buf.toString('base64'));
}
// Text of a PDF as a reader would copy it: items joined as positioned, a space at each line end,
// list markers at the start of a line dropped ("1.", "2)" — bullets are drawn as shapes).
async function pdfCopyText(page: Page, buf: Buffer) {
  const lines: string[] = await page.evaluate(async (b64) => {
    const W = window as any;
    const pdfjs = await W.PFLoad.pdfjs();
    const doc = await pdfjs.getDocument(W.PFLoad.pdfjsOptions(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).promise;
    const out: string[] = [];
    let cur = '';
    for (let i = 1; i <= doc.numPages; i++) {
      for (const it of (await (await doc.getPage(i)).getTextContent()).items as any[]) {
        cur += it.str;
        if (it.hasEOL) { out.push(cur); cur = ''; }
      }
      out.push(cur); cur = '';
    }
    return out;
  }, buf.toString('base64'));
  return norm(lines.map(stripMarker).join(' '));
}
const stripMarker = (l: string) => l.replace(/^\s*(?:\d{1,3}[.)]?(?=\s|$)|[●•▪◦])\s*/, '');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// Text of a .docx body: the runs of each paragraph, paragraphs separated by a space.
async function docxText(buf: Buffer) {
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
  return norm((xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((p) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => xmlText(t.replace(/<[^>]+>/g, ''))).join('')).join(' '));
}
const DAMAGE = [/%Ï/, / [,.;:!?)]/, /budg ets/, /Student :/];

const gaEvents = (page: Page) => page.evaluate(() =>
  ((window as any).dataLayer || []).filter((a: any) => a && a[0] === 'event').map((a: any) => [a[1], a[2]]));

// ─────────────────────────────────────────────────────────────
test.describe('page + tabs', () => {
  test('hash navigation, back button, and lazy-loading per tab', async ({ page }) => {
    const net = await open(page, '#merge-pdf');
    await expect(panel(page, 'merge-pdf')).toBeVisible();
    for (const id of ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf']) await expect(panel(page, id)).toBeHidden();
    await expect(page.locator('#tab-merge-pdf')).toHaveAttribute('aria-selected', 'true');
    await ready(page, 'merge-pdf');
    const cdn = () => net.requests.filter((r) => r.url.startsWith('https://cdn.jsdelivr.net/')).map((r) => r.url);
    expect(cdn().some((u) => u.includes('pdf-lib@1.17.1'))).toBe(true);
    for (const lib of ['pdfjs-dist', 'docx@', 'docx-preview', 'tesseract', 'jspdf', 'html2canvas']) expect(cdn().filter((u) => u.includes(lib)), lib).toEqual([]);

    await page.locator('#tab-compress-pdf').click();
    await expect(page).toHaveURL(/#compress-pdf$/);
    await expect(panel(page, 'compress-pdf')).toBeVisible();
    await expect(panel(page, 'merge-pdf')).toBeHidden();

    await page.locator('#tab-pdf-to-word').click();
    await ready(page, 'pdf-to-word');
    expect(cdn().some((u) => u.includes('pdfjs-dist@4.10.38'))).toBe(true);
    expect(cdn().some((u) => u.includes('docx@9.5.1'))).toBe(true);
    expect(cdn().filter((u) => u.includes('tesseract')), 'OCR loads only for scanned pages').toEqual([]);

    await page.goBack();
    await expect(page).toHaveURL(/#compress-pdf$/);
    await expect(panel(page, 'compress-pdf')).toBeVisible();

    // every CDN URL is an exact pinned version
    for (const u of cdn()) expect(u, u).toMatch(/cdn\.jsdelivr\.net\/npm\/(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\//);
    expect(net.errors).toEqual([]);
  });

  test('default tab is PDF to Word; unknown hash falls back to it', async ({ page }) => {
    await open(page, '#nope');
    await expect(panel(page, 'pdf-to-word')).toBeVisible();
    await expect(page.locator('.pf-privacy')).toHaveText(/Your files never leave your device\./);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('PDF to Word', () => {
  test('text PDF → headings, bold, lists, page break → valid .docx and PDF', async ({ page }) => {
    const net = await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    const box = role(p, 'output');
    await expect(box.locator('h1')).toHaveText('Study Notes on Photosynthesis', { timeout: 60000 });
    await expect(box.locator('strong', { hasText: 'Chlorophyll' })).toHaveCount(1);
    await expect(box.locator('em', { hasText: 'green' })).toHaveCount(1);
    await expect(box.locator('ul > li')).toHaveText(['Light-dependent reactions', 'The Calvin cycle', 'Glucose production']);
    await expect(box.locator('ol > li')).toHaveText(['Water is split', 'Oxygen is released']);
    await expect(box.locator('hr.pf-page-break')).toHaveCount(1);
    await expect(box.locator('h2, h3').filter({ hasText: 'Summary' })).toHaveCount(1);
    // two lines of the first paragraph are joined into one <p>
    await expect(box.locator('p', { hasText: 'Plants turn light' })).toContainText('which is why leaves look green to us.');
    await expect(role(p, 'summary')).toContainText('2 pages converted');

    const docx = await download(page, role(p, 'dl-docx'));
    expect(docx.name).toBe('text-converted.docx');
    const zip = await JSZip.loadAsync(docx.buf);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Study Notes on Photosynthesis');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t xml:space="preserve">Chlorophyll<\/w:t><\/w:r>/);
    expect(xml).toMatch(/<w:i\/>/);
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:br w:type="page"/>');

    const pdf = await download(page, role(p, 'dl-pdf'));
    expect(pdf.name).toBe('text-converted.pdf');
    expect((await pdfInfo(page, pdf.buf)).pages).toBeGreaterThanOrEqual(1);
    expect(await pdfText(page, pdf.buf)).toContain('Photosynthesis');
    expect(net.apiCalls).toEqual([]);
    expect(net.errors).toEqual([]);

    const ev = await gaEvents(page);
    expect(ev).toContainEqual(['tool_used', { tool: 'pdf_to_word', input_type: 'pdf' }]);
    expect(ev).toContainEqual(['result_download', { tool: 'pdf_to_word', format: 'docx' }]);
    expect(ev).toContainEqual(['result_download', { tool: 'pdf_to_word', format: 'pdf' }]);
    expect(JSON.stringify(ev)).not.toMatch(/text\.pdf|Photosynthesis|bytes/i);
  });

  test('editing the output box changes the downloaded .docx (and fires pdf_edit_used once)', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    const h1 = role(p, 'output').locator('h1');
    await expect(h1).toHaveText('Study Notes on Photosynthesis', { timeout: 60000 });
    await h1.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' EDITED');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A brand new line');
    const xml = await (await JSZip.loadAsync((await download(page, role(p, 'dl-docx'))).buf)).file('word/document.xml')!.async('string');
    expect(xml).toContain('Study Notes on Photosynthesis EDITED');
    expect(xml).toContain('A brand new line');
    const edits = (await gaEvents(page)).filter((e: any) => e[0] === 'pdf_edit_used');
    expect(edits).toEqual([['pdf_edit_used', { tool: 'pdf_to_word' }]]);
    // the ✏ toggle locks the box
    await role(p, 'edit-toggle').click();
    await expect(role(p, 'output')).toHaveAttribute('contenteditable', 'false');
  });

  test('scanned page → OCR text', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('scanned.pdf'));
    await expect(role(p, 'output')).toContainText(/Scanned lecture notes/i, { timeout: 150000 });
    await expect(role(p, 'output')).toContainText(/mitosis/i);
    await expect(role(p, 'summary')).toContainText('read with OCR');
  });

  test('limits and wrong files: 50 pages, 50 MB, encrypted, not a PDF', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    const input = p.locator('input[type=file]');
    await input.setInputFiles(fx('pages-51.pdf'));
    await expect(role(p, 'error')).toContainText('has 51 pages. This tool handles up to 50 pages', { timeout: 60000 });
    await input.setInputFiles(fx('encrypted.pdf'));
    await expect(role(p, 'error')).toContainText('"encrypted.pdf" is password-protected');
    await input.setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(fx('photo.jpg')) });
    await expect(role(p, 'error')).toContainText('Please choose a PDF file');
    const big = path.join(os.tmpdir(), 'pf-big-51mb.pdf');
    fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 51 * 1024 * 1024);
    await input.setInputFiles(big);
    await expect(role(p, 'error')).toContainText('The limit is 50 MB per file');
    const errs = (await gaEvents(page)).filter((e: any) => e[0] === 'tool_error').map((e: any) => e[1].error_type);
    expect(errs).toEqual(['too_many_pages', 'encrypted', 'unsupported', 'too_large']);
    await role(p, 'start-over').click();
    await expect(role(p, 'error')).toBeHidden();
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('Word to PDF', () => {
  test('.docx → preview → PDF with selectable text', async ({ page }) => {
    const net = await open(page, '#word-to-pdf');
    const p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('sample.docx'));
    const box = role(p, 'output');
    await expect(box).toContainText('Lab Report Heading', { timeout: 60000 });
    await expect(box).toContainText('important result');
    await expect(role(p, 'print')).toBeVisible();
    // edit before downloading
    await box.locator('p', { hasText: 'Second observation' }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' plus edit');
    const pdf = await download(page, role(p, 'dl-pdf'));
    expect(pdf.name).toBe('sample-converted.pdf');
    expect((await pdfInfo(page, pdf.buf)).pages).toBeGreaterThanOrEqual(1);
    const text = (await pdfText(page, pdf.buf)).replace(/\s+/g, ' ');
    expect(text).toContain('Lab Report Heading');
    expect(text).toContain('important result');
    expect(text).toContain('plus edit');
    expect(net.apiCalls).toEqual([]);
    expect(await gaEvents(page)).toContainEqual(['tool_used', { tool: 'word_to_pdf', input_type: 'docx' }]);
  });

  test('.doc is refused with a clear message', async ({ page }) => {
    await open(page, '#word-to-pdf');
    const p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('old-format.doc'));
    await expect(role(p, 'error')).toContainText('Please save as .docx first');
    expect((await gaEvents(page)).filter((e: any) => e[0] === 'tool_error')).toEqual([['tool_error', { tool: 'word_to_pdf', error_type: 'unsupported' }]]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('PDF text fidelity + document structure', () => {
  test('Word to PDF round trip: 7-word-to-pdf.docx text copies out of the PDF exactly', async ({ page }) => {
    await open(page, '#word-to-pdf');
    const p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('7-word-to-pdf.docx'));
    await expect(role(p, 'output')).toContainText('Cyber Risk Management', { timeout: 60000 });
    const pdf = await download(page, role(p, 'dl-pdf'));
    const source = await docxText(fs.readFileSync(fx('7-word-to-pdf.docx')));
    const text = await pdfCopyText(page, pdf.buf);
    for (const re of DAMAGE) expect(text, String(re)).not.toMatch(re);
    expect(source).toContain('Student: Test Student');
    expect(source).toContain('identify, protect, detect, respond');
    expect(source).toContain('large budgets;');
    expect(text).toBe(source);
    // the bullet glyph is drawn as a shape, so it never turns into stray characters
    expect(await pdfText(page, pdf.buf)).not.toMatch(/[●%Ï]/);
  });

  test('PDF to Word round trip: 1-assignment.pdf → box → PDF keeps the source text exactly', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    const box = role(p, 'output');
    await expect(box.locator('h1').first()).toHaveText('Cyber Risk Management for Small Businesses', { timeout: 60000 });
    const pdf = await download(page, role(p, 'dl-pdf'));
    const out = await pdfCopyText(page, pdf.buf);
    const source = await pdfCopyText(page, fs.readFileSync(fx('1-assignment.pdf')));
    for (const re of DAMAGE) expect(out, String(re)).not.toMatch(re);
    expect(out).toBe(source);
    // and what was in the editable box is what is in the PDF
    const boxText = norm((await box.evaluate((el) => [...el.querySelectorAll('h1,h2,h3,p,li,td')]
      .filter((n) => !n.querySelector('ul,ol')).map((n) => n.textContent || ''))).map(stripMarker).join(' '));
    expect(out).toBe(boxText);
  });

  test('PDF to Word: real Word lists (numbering.xml + numPr), nested by indentation', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    const box = role(p, 'output');
    await expect(box.locator('ul > li')).toHaveText(['Enable multi-factor authentication on all accounts', 'Patch operating systems within 14 days', 'Keep offline backups and test restores'], { timeout: 60000 });
    await expect(box.locator('ol > li')).toHaveText(['Audit existing assets', 'Prioritise high-risk systems', 'Train staff quarterly']);
    const zip = await JSZip.loadAsync((await download(page, role(p, 'dl-docx'))).buf);
    const numbering = await zip.file('word/numbering.xml')?.async('string');
    expect(numbering, 'numbering.xml').toBeTruthy();
    expect(numbering).toContain('w:val="decimal"');
    expect(numbering).toContain('w:val="bullet"');
    const xml = await zip.file('word/document.xml')!.async('string');
    const para = (text: string) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).find((x) => x.includes(text))!;
    for (const t of ['Enable multi-factor authentication', 'Patch operating systems', 'Audit existing assets', 'Train staff quarterly']) {
      expect(para(t), t).toContain('<w:numPr>');
      expect(para(t)).not.toMatch(/<w:t[^>]*>\s*(?:[•●▪*-]|\d+[.)]?)\s/);       // no typed markers
    }

    await role(p, 'start-over').click();
    await p.locator('input[type=file]').setInputFiles(fx('lists.pdf'));
    await expect(box.locator(':scope > ul > li')).toHaveCount(2, { timeout: 60000 });
    await expect(box.locator(':scope > ul > li').first().locator('ul > li')).toHaveText(['Apple', 'Banana']);
    await expect(box.locator(':scope > ul > li').nth(1).locator('ul > li')).toHaveText(['Carrot']);
    await expect(box.locator(':scope > ol > li')).toHaveText(['First step', 'Second step']);
    const xml2 = await (await JSZip.loadAsync((await download(page, role(p, 'dl-docx'))).buf)).file('word/document.xml')!.async('string');
    const apple = (xml2.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).find((x) => x.includes('>Apple<'))!;
    expect(apple).toContain('<w:ilvl w:val="1"/>');
  });

  test('PDF to Word: Control/Cost/Impact becomes a real 4×3 Word table with a bold header; chart image embedded', async ({ page }) => {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    const box = role(p, 'output');
    await expect(box.locator('table tr')).toHaveCount(4, { timeout: 60000 });
    await expect(box.locator('img')).toHaveCount(1);
    const zip = await JSZip.loadAsync((await download(page, role(p, 'dl-docx'))).buf);
    const xml = await zip.file('word/document.xml')!.async('string');
    const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
    expect(tables).toHaveLength(1);
    const rows = (tables[0].match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []).map((r) =>
      (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((c) => (c.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    expect(rows).toEqual([['Control', 'Cost', 'Impact'], ['MFA', 'Low', 'High'], ['Patching', 'Medium', 'High'], ['Training', 'Low', 'Medium']]);
    expect(tables[0]).toContain('<w:tblBorders>');
    expect(tables[0]).toContain('<w:tblHeader/>');
    const header = tables[0].match(/<w:tr[ >][\s\S]*?<\/w:tr>/)![0];
    expect((header.match(/<w:b\/>/g) || []).length).toBe(3);
    // the bar chart from page 1 is in the Word file
    const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !zip.files[f].dir);
    expect(media.length).toBe(1);
    expect((await zip.file(media[0])!.async('uint8array')).length).toBeGreaterThan(2000);
    expect(xml).toContain('<w:drawing>');
  });

  test('Bengali .docx: jsPDF is skipped and the print flow opens with the note', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__prints = [];
      window.print = () => {
        const a = document.getElementById('pfPrintArea')!;
        (window as any).__prints.push({ cls: a.className, text: a.textContent, printing: document.body.classList.contains('pf-printing') });
      };
    });
    const net = await open(page, '#word-to-pdf');
    const p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('bengali.docx'));
    await expect(role(p, 'output')).toContainText('আমার সোনার বাংলা', { timeout: 60000 });
    let downloads = 0;
    page.on('download', () => downloads++);
    await role(p, 'dl-pdf').click();
    await expect(role(p, 'note')).toHaveText("Your document uses non-English script — choose 'Save as PDF' in the print window for correct letters.");
    await expect.poll(() => page.evaluate(() => (window as any).__prints.length), { timeout: 10000 }).toBe(1);
    const pr = (await page.evaluate(() => (window as any).__prints))[0];
    expect(pr.cls).toContain('pf-complex');
    expect(pr.printing).toBe(true);
    expect(pr.text).toContain('আমার সোনার বাংলা');
    expect(downloads).toBe(0);
    expect(net.requests.filter((r) => /jspdf@|noto-sans@/.test(r.url)), 'jsPDF and its font are never fetched').toEqual([]);
    // detection covers the other scripts too, and leaves Latin text (with symbols) on the jsPDF path
    const detect = await page.evaluate(() => ['हिन्दी', 'العربية', '中文', '한국어', 'ภาษาไทย', 'Café — “quotes” • 1,200 €']
      .map((s) => (window as any).PFPdfWriter.hasComplexScript(s)));
    expect(detect).toEqual([true, true, true, true, true, false]);
  });
});

// ─────────────────────────────────────────────────────────────
// Word sections from document.xml: each <w:sectPr> closes a section → [{ xml, cols, type }].
async function docxSections(buf: Buffer) {
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
  const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('</w:body>'));
  const parts = body.split('</w:sectPr>').slice(0, -1);
  return parts.map((p) => {
    const sect = p.slice(p.lastIndexOf('<w:sectPr'));
    const num = /<w:cols[^>]*w:num="(\d+)"/.exec(sect);
    return { xml: p, text: norm((p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => xmlText(t.replace(/<[^>]+>/g, ''))).join(' ')), cols: num ? Number(num[1]) : 1, continuous: /<w:type w:val="continuous"\/>/.test(sect), colBreaks: (p.match(/<w:br w:type="column"\/>/g) || []).length };
  });
}

test.describe('PDF to Word: columns', () => {
  async function convert(page: Page, file: string) {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx(file));
    await expect(role(p, 'result')).toBeVisible({ timeout: 60000 });
    return p;
  }

  test('two columns: title full width, real 2-column section, source reading order', async ({ page }) => {
    const p = await convert(page, 'two-columns.pdf');
    const box = role(p, 'output');
    // preview shows the columns too
    const cols = box.locator('.pf-cols');
    await expect(cols).toHaveCount(1);
    expect(await cols.evaluate((el) => getComputedStyle(el).columnCount)).toBe('2');
    await expect(cols.locator(':scope > .pf-col')).toHaveCount(2);
    await expect(cols.locator(':scope > .pf-col').nth(0).locator('h2')).toHaveText(['Section 1: Cells', 'Section 2: Energy', 'Section 3: Genetics']);
    await expect(cols.locator(':scope > .pf-col').nth(1).locator('h2')).toHaveText(['Section 4: Evolution', 'Section 5: Ecology', 'Section 6: Immunity']);
    await expect(box.locator(':scope > h1')).toHaveText('Biology Revision Guide');            // outside the columns
    await expect(role(p, 'summary')).toContainText('columns kept on 1 page');

    const source = norm(fs.readFileSync(fx('two-columns.txt'), 'utf8'));
    const d = await download(page, role(p, 'dl-docx'));
    expect(await docxText(d.buf)).toBe(source);
    const secs = await docxSections(d.buf);
    const two = secs.filter((s) => s.cols === 2);
    expect(two).toHaveLength(1);
    expect(two[0].continuous).toBe(true);
    expect(two[0].colBreaks).toBe(0);                                  // Word balances the columns itself
    expect(two[0].text).toContain('Section 1: Cells');
    expect(two[0].text).toContain('End of immunity notes.');
    expect(two[0].text).not.toContain('Biology Revision Guide');
    const titleSec = secs.find((s) => s.text.includes('Biology Revision Guide'))!;
    expect(titleSec.cols).toBe(1);
    expect(titleSec.text).toContain('six revision sections that follow below it.');           // intro stays full width
    // the PDF download keeps the order too
    expect(await pdfCopyText(page, (await download(page, role(p, 'dl-pdf'))).buf)).toBe(source);
  });

  test('three columns → w:num="3" in source order', async ({ page }) => {
    const p = await convert(page, 'three-columns.pdf');
    await expect(role(p, 'output').locator('.pf-cols > .pf-col')).toHaveCount(3);
    const d = await download(page, role(p, 'dl-docx'));
    expect(await docxText(d.buf)).toBe(norm(fs.readFileSync(fx('three-columns.txt'), 'utf8')));
    const three = (await docxSections(d.buf)).filter((s) => s.cols === 3);
    expect(three).toHaveLength(1);
    expect(three[0].colBreaks).toBe(0);
  });

  test('no false columns: 1-assignment.pdf (table, chart, lists) and the other text PDFs stay single-column', async ({ page }) => {
    for (const f of ['1-assignment.pdf', 'text.pdf', 'lists.pdf']) {
      const p = await convert(page, f);
      await expect(role(p, 'output').locator('.pf-cols')).toHaveCount(0);
      await expect(role(p, 'summary')).not.toContainText('columns');
      const secs = await docxSections((await download(page, role(p, 'dl-docx'))).buf);
      expect(secs.map((s) => s.cols), f).toEqual([1]);
    }
  });

  test('two-columns.pdf keeps its 10 pt body: Word runs 10 pt, no column breaks, PDF re-export fits one page in order', async ({ page }) => {
    const p = await convert(page, 'two-columns.pdf');
    const box = role(p, 'output');
    expect(await box.evaluate((el) => el.style.fontSize)).toBe('10pt');
    const d = await download(page, role(p, 'dl-docx'));
    const xml = await (await JSZip.loadAsync(d.buf)).file('word/document.xml')!.async('string');
    const para = (t: string) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).find((x) => x.includes(t))!;
    for (const t of ['Cells notes part 1 begin here.', 'Immunity notes part 6 begin here.']) expect(para(t), t).toContain('<w:sz w:val="20"/>');
    expect(para('Section 1: Cells')).toContain('<w:sz w:val="26"/>');                   // 13 pt headings
    expect(para('Biology Revision Guide')).toContain('<w:sz w:val="40"/>');             // 20 pt title
    expect(para('This full-width introduction')).toContain('<w:sz w:val="22"/>');       // 11 pt intro
    expect(xml).not.toContain('<w:br w:type="column"/>');
    const source = norm(fs.readFileSync(fx('two-columns.txt'), 'utf8'));
    expect(await docxText(d.buf)).toBe(source);
    const pdf = (await download(page, role(p, 'dl-pdf'))).buf;
    expect((await pdfInfo(page, pdf)).pages).toBe(1);                                   // no overflow at the real size
    expect(await pdfCopyText(page, pdf)).toBe(source);
  });

  test('editing inside a column keeps the columns in the Word file', async ({ page }) => {
    const p = await convert(page, 'two-columns.pdf');
    const h = role(p, 'output').locator('.pf-col h2', { hasText: 'Section 5: Ecology' });
    await h.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (edited)');
    const secs = await docxSections((await download(page, role(p, 'dl-docx'))).buf);
    const two = secs.find((s) => s.cols === 2)!;
    expect(two.text).toContain('Section 5: Ecology (edited)');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('PDF to Word: font sizes and families', () => {
  async function docxOf(page: Page, file: string) {
    await open(page, '#pdf-to-word');
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx(file));
    await expect(role(p, 'result')).toBeVisible({ timeout: 60000 });
    const zip = await JSZip.loadAsync((await download(page, role(p, 'dl-docx'))).buf);
    const xml = await zip.file('word/document.xml')!.async('string');
    const styles = await zip.file('word/styles.xml')!.async('string');
    const para = (t: string) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).find((x) => x.includes(t))!;
    return { p, xml, styles, para };
  }
  const defaults = (styles: string) => styles.slice(styles.indexOf('<w:docDefaults>'), styles.indexOf('</w:docDefaults>'));

  test('1-assignment.pdf: 11 pt body (Normal), 18/14 pt headings as in the source, PDF re-export stays 2 pages', async ({ page }) => {
    const { p, styles, para } = await docxOf(page, '1-assignment.pdf');
    expect(defaults(styles)).toContain('<w:sz w:val="22"/>');                         // Normal = dominant body size
    expect(para('Cybersecurity frameworks help organisations')).toContain('<w:sz w:val="22"/>');
    expect(para('Enable multi-factor authentication')).toContain('<w:sz w:val="22"/>');
    expect(para('Cyber Risk Management for Small Businesses')).toContain('<w:sz w:val="36"/>');
    expect(para('1. Introduction')).toContain('<w:sz w:val="36"/>');
    expect(para('2.1 Implementation Steps')).toContain('<w:sz w:val="28"/>');
    expect(para('References')).toContain('<w:sz w:val="28"/>');
    expect(para('>MFA<')).toContain('<w:sz w:val="20"/>');                              // 10 pt table text
    expect(await role(p, 'output').evaluate((el) => el.style.fontSize)).toBe('11pt');
    const pdf = (await download(page, role(p, 'dl-pdf'))).buf;
    expect((await pdfInfo(page, pdf)).pages).toBe(2);
  });

  test('fonts.pdf: Times → Times New Roman, Helvetica → Arial, Calibri kept, Courier → Courier New', async ({ page }) => {
    const { p, para } = await docxOf(page, 'fonts.pdf');
    const font = (x: string) => (/<w:rFonts w:ascii="([^"]+)"/.exec(x) || [])[1];
    expect(font(para('Serif Heading in Times'))).toBe('Times New Roman');
    expect(font(para('Serif body text set in Times Roman'))).toBe('Times New Roman');
    expect(font(para('Sans body text set in Helvetica'))).toBe('Arial');
    expect(font(para('Sans body text set in Calibri'))).toBe('Calibri');
    expect(font(para('monospace'))).toBe('Courier New');
    expect(para('monospace')).toContain('<w:sz w:val="20"/>');
    expect(para('Serif Heading in Times')).toContain('<w:sz w:val="32"/>');
    // the preview uses the same families
    const fam = (t: string) => role(p, 'output').locator('p, h1', { hasText: t }).first().evaluate((el) => getComputedStyle(el.querySelector('span') || el).fontFamily);
    expect(await fam('Helvetica')).toMatch(/^"?Arial/);
    expect(await fam('Calibri at')).toMatch(/^"?Calibri/);
    expect(await fam('monospace')).toMatch(/^"?Courier New/);
    // the PDF download embeds a serif, a sans and a mono face
    const pdf = (await download(page, role(p, 'dl-pdf'))).buf.toString('latin1');
    for (const f of ['PFNotoSerif', 'PFNoto', 'PFNotoMono']) expect(pdf).toContain(f);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('JPG to PDF', () => {
  test('jpg + png + webp + EXIF-rotated photo → PDF in the chosen order', async ({ page }) => {
    await open(page, '#jpg-to-pdf');
    const p = panel(page, 'jpg-to-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('shot.png'), fx('pic.webp'), fx('rotated.jpg')]);
    await expect(p.locator('.pf-item')).toHaveCount(4);
    // move rotated.jpg (last) to the top with the ↑ button, remove pic.webp
    for (let i = 0; i < 3; i++) await p.locator('.pf-item', { hasText: 'rotated.jpg' }).locator('[data-act="up"]').click();
    await expect(p.locator('.pf-item-name').first()).toHaveText('rotated.jpg');
    await p.locator('.pf-item', { hasText: 'pic.webp' }).locator('[data-act="remove"]').click();
    await expect(p.locator('.pf-item-name')).toHaveText(['rotated.jpg', 'photo.jpg', 'shot.png']);
    await role(p, 'opt-size').selectOption('fit');
    await role(p, 'go').click();
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('images.pdf');
    // fit to image, small margin (20 pt each side), 96 px per inch
    expect((await pdfInfo(page, out.buf)).sizes).toEqual([[190, 340], [490, 340], [265, 415]]);
  });

  test('A4 with auto orientation; webp converted', async ({ page }) => {
    await open(page, '#jpg-to-pdf');
    const p = panel(page, 'jpg-to-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('shot.png'), fx('pic.webp')]);
    await role(p, 'go').click();
    const info = await pdfInfo(page, (await download(page, role(p, 'dl-pdf'))).buf);
    expect(info.sizes).toEqual([[842, 595], [595, 842], [842, 595]]);
    await role(p, 'start-over').click();
    await expect(p.locator('.pf-item')).toHaveCount(0);
    expect(await gaEvents(page)).toContainEqual(['tool_used', { tool: 'jpg_to_pdf', input_type: 'image' }]);
  });

  test('non-image files are skipped with a message', async ({ page }) => {
    await open(page, '#jpg-to-pdf');
    const p = panel(page, 'jpg-to-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('text.pdf')]);
    await expect(p.locator('.pf-item')).toHaveCount(1);
    await expect(role(p, 'error')).toContainText('Skipped "text.pdf"');
  });
});

// ─────────────────────────────────────────────────────────────
// 4-large-for-compress.pdf: 8 pages, each a 2400×1600 quality-95 JPEG shown 16 cm wide plus text.
// Pages 1–4 store the JPEG the way ReportLab does ([/ASCII85Decode /DCTDecode]); pages 5–8 as plain
// DCTDecode. Built in the browser with the page's pinned pdf-lib and cached in the temp folder
// (about 20 MB — too big to commit).
async function largeFixture(page: Page) {
  const dir = path.join(os.tmpdir(), 'parafree-large-fixture-v1');
  const file = path.join(dir, '4-large-for-compress.pdf');
  if (fs.existsSync(file)) return file;
  const b64 = await page.evaluate(async () => {
    const L = await (window as any).PFLoad.pdfLib();
    const a85 = (u8: Uint8Array) => {
      let out = '';
      for (let i = 0; i < u8.length; i += 4) {
        const n = Math.min(4, u8.length - i);
        let v = 0;
        for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? u8[i + k] : 0);
        if (n === 4 && v === 0) { out += 'z'; continue; }
        let s = '';
        for (let k = 0; k < 5; k++) { s = String.fromCharCode(33 + (v % 85)) + s; v = Math.floor(v / 85); }
        out += s.slice(0, n + 1);
        if (i % 300 === 296) out += '\n';
      }
      return new TextEncoder().encode(out + '~>');
    };
    const pdf = await L.PDFDocument.create();
    const font = await pdf.embedFont(L.StandardFonts.Helvetica);
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('canvas'); c.width = 2400; c.height = 1600;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 2400, 1600);
      grad.addColorStop(0, `hsl(${i * 40},60%,70%)`); grad.addColorStop(1, `hsl(${i * 40 + 120},55%,35%)`);
      g.fillStyle = grad; g.fillRect(0, 0, 2400, 1600);
      let seed = i + 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let k = 0; k < 400; k++) { g.fillStyle = `hsla(${rnd() * 360},70%,${30 + rnd() * 50}%,0.35)`; g.beginPath(); g.arc(rnd() * 2400, rnd() * 1600, 10 + rnd() * 200, 0, 7); g.fill(); }
      const id = g.getImageData(0, 0, 2400, 1600);
      for (let p = 0; p < id.data.length; p += 4) { const n = (rnd() - 0.5) * 40; id.data[p] += n; id.data[p + 1] += n; id.data[p + 2] += n; }
      g.putImageData(id, 0, 0);
      const jpg = new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.95))).arrayBuffer());
      const img = await pdf.embedJpg(jpg);
      const p = pdf.addPage([595.28, 841.89]);
      p.drawText(`Field trip photo ${i + 1} of 8`, { x: 70, y: 780, size: 18, font });
      p.drawImage(img, { x: 70, y: 440, width: 453.5, height: 302.4 });            // 16 cm wide
      p.drawText('Notes: soil samples were taken at each site.', { x: 70, y: 410, size: 11, font });
      if (i < 4) {
        await img.embed();
        pdf.context.assign(img.ref, L.PDFRawStream.of(pdf.context.obj({
          Type: 'XObject', Subtype: 'Image', Width: 2400, Height: 1600, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
          Filter: ['ASCII85Decode', 'DCTDecode'],
        }), a85(jpg)));
      }
    }
    const u8: Uint8Array = await pdf.save();
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
    return btoa(s);
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

// Same rule as the page: 1 KB = 1,000 bytes, 1 MB = 1,000,000 bytes.
const decimalSize = (n: number) => (n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + ' KB' : (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB');

// Image XObjects in a PDF: [width, height, filter] each (pdf-lib, in the page).
async function pdfImages(page: Page, buf: Buffer) {
  return page.evaluate(async (b64) => {
    const L = await (window as any).PFLoad.pdfLib();
    const doc = await L.PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const out: any[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream) || obj.dict.get(L.PDFName.of('Subtype')) !== L.PDFName.of('Image')) continue;
      out.push([obj.dict.get(L.PDFName.of('Width')).asNumber(), obj.dict.get(L.PDFName.of('Height')).asNumber(), String(obj.dict.get(L.PDFName.of('Filter')))]);
    }
    return out;
  }, buf.toString('base64'));
}

test.describe('Compress PDF: large photos, Strong rasterising, isolation', () => {
  test('Light on 8 × 2400×1600 q95 photos (incl. ReportLab-style ASCII85+DCT): ≥ 60% smaller, ~150 DPI, text kept', async ({ page }) => {
    await open(page, '#compress-pdf');
    await ready(page, 'compress-pdf');
    const big = await largeFixture(page);
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(big);
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toHaveText(/^Before: \d+(\.\d+)? MB → After: \d+(\.\d+)? (MB|KB) \(\d+% smaller\)$/, { timeout: 120000 });
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('4-large-for-compress-compressed.pdf');
    const before = fs.statSync(big).size;
    expect(out.buf.length, `${before} → ${out.buf.length}`).toBeLessThanOrEqual(before * 0.4);
    const pct = Math.round((1 - out.buf.length / before) * 100);
    await expect(role(p, 'summary')).toHaveText(`Before: ${decimalSize(before)} → After: ${decimalSize(out.buf.length)} (${pct}% smaller)`);
    // every photo, whatever its filter chain, now ~150 DPI at 16 cm (945 px wide) as JPEG
    const imgs = await pdfImages(page, out.buf);
    expect(imgs).toHaveLength(8);
    for (const [w, h, f] of imgs) { expect(w).toBeGreaterThanOrEqual(940); expect(w).toBeLessThanOrEqual(950); expect(h).toBeLessThan(640); expect(f).toBe('/DCTDecode'); }
    expect((await pdfInfo(page, out.buf)).pages).toBe(8);
    const text = await pdfText(page, out.buf);
    for (let i = 1; i <= 8; i++) expect(text).toContain(`Field trip photo ${i} of 8`);
    expect(text).toContain('Notes: soil samples were taken at each site.');
  });

  test('Strong after PDF to Word on 1-assignment.pdf: 8 image-only pages from the compress input', async ({ page }) => {
    await open(page, '#pdf-to-word');
    await ready(page, 'pdf-to-word');
    const big = await largeFixture(page);
    const pw = panel(page, 'pdf-to-word');
    await pw.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    await expect(role(pw, 'output').locator('h1').first()).toBeVisible({ timeout: 60000 });
    await download(page, role(pw, 'dl-pdf'));
    await page.locator('#tab-compress-pdf').click();
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(big);
    await p.locator('input[value="strong"]').check();
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('text is no longer selectable', { timeout: 120000 });
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('4-large-for-compress-compressed.pdf');
    expect((await pdfInfo(page, out.buf)).pages).toBe(8);
    expect((await pdfText(page, out.buf)).trim()).toBe('');                                        // image-only
    expect((await pdfImages(page, out.buf)).length).toBe(8);
  });

  test('Strong on a small text PDF that would grow: original offered clearly, image-only version still available', async ({ page }) => {
    await open(page, '#compress-pdf');
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    await p.locator('input[value="strong"]').check();
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('not smaller. This PDF is already well compressed. The download below is your original file, unchanged (its text stays selectable).', { timeout: 60000 });
    await expect(role(p, 'dl-pdf')).toHaveText('⬇ Download original PDF (unchanged)');
    const orig = await download(page, role(p, 'dl-pdf'));
    expect(orig.name).toBe('1-assignment.pdf');
    expect(orig.buf.equals(fs.readFileSync(fx('1-assignment.pdf')))).toBe(true);
    await expect(role(p, 'dl-alt')).toContainText('Download the image-only version anyway');
    const img = await download(page, role(p, 'dl-alt'));
    expect(img.name).toBe('1-assignment-compressed.pdf');
    expect((await pdfText(page, img.buf)).trim()).toBe('');
  });

  test('every pair of tabs: B downloads only B’s result; leaving A clears A', async ({ page }) => {
    test.setTimeout(600000);
    await open(page);
    const run: Record<string, () => Promise<void>> = {
      'pdf-to-word': async () => { const p = panel(page, 'pdf-to-word'); await p.locator('input[type=file]').setInputFiles(fx('text.pdf')); await expect(role(p, 'output').locator('h1')).toBeVisible({ timeout: 60000 }); },
      'word-to-pdf': async () => { const p = panel(page, 'word-to-pdf'); await p.locator('input[type=file]').setInputFiles(fx('sample.docx')); await expect(role(p, 'output')).toContainText('Lab Report Heading', { timeout: 60000 }); },
      'jpg-to-pdf': async () => { const p = panel(page, 'jpg-to-pdf'); await p.locator('input[type=file]').setInputFiles(fx('photo.jpg')); await role(p, 'go').click(); await expect(role(p, 'result')).toBeVisible({ timeout: 60000 }); },
      'compress-pdf': async () => { const p = panel(page, 'compress-pdf'); await p.locator('input[type=file]').setInputFiles(fx('images.pdf')); await role(p, 'go').click(); await expect(role(p, 'result')).toBeVisible({ timeout: 60000 }); },
      'merge-pdf': async () => { const p = panel(page, 'merge-pdf'); await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]); await expect(role(p, 'go')).toBeEnabled({ timeout: 60000 }); await role(p, 'go').click(); await expect(role(p, 'result')).toBeVisible({ timeout: 60000 }); },
    };
    const check: Record<string, () => Promise<void>> = {
      'pdf-to-word': async () => { const d = await download(page, role(panel(page, 'pdf-to-word'), 'dl-docx')); expect(d.name).toBe('text-converted.docx'); expect(await docxText(d.buf)).toContain('Study Notes on Photosynthesis'); },
      'word-to-pdf': async () => { const d = await download(page, role(panel(page, 'word-to-pdf'), 'dl-pdf')); expect(d.name).toBe('sample-converted.pdf'); expect(await pdfText(page, d.buf)).toContain('Lab Report Heading'); },
      'jpg-to-pdf': async () => { const d = await download(page, role(panel(page, 'jpg-to-pdf'), 'dl-pdf')); expect(d.name).toBe('images.pdf'); expect((await pdfInfo(page, d.buf)).sizes).toEqual([[842, 595]]); },
      'compress-pdf': async () => { const d = await download(page, role(panel(page, 'compress-pdf'), 'dl-pdf')); expect(d.name).toBe('images-compressed.pdf'); expect((await pdfInfo(page, d.buf)).pages).toBe(2); expect(await pdfText(page, d.buf)).toContain('Lab photos'); },
      'merge-pdf': async () => { const d = await download(page, role(panel(page, 'merge-pdf'), 'dl-pdf')); expect(d.name).toBe('merged.pdf'); expect((await pdfInfo(page, d.buf)).pages).toBe(5); },
    };
    const ids = Object.keys(run);
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      await page.locator('#tab-' + a).click();
      await run[a]();
      await page.locator('#tab-' + b).click();
      await run[b]();
      await check[b]();
      // back on A: its result and download are gone
      await page.locator('#tab-' + a).click();
      await expect(role(panel(page, a), 'result'), `${a} after visiting ${b}`).toBeHidden();
      if (a === 'pdf-to-word' || a === 'word-to-pdf') await expect(role(panel(page, a), 'output')).toBeEmpty();
      if (a === 'jpg-to-pdf' || a === 'merge-pdf') await expect(panel(page, a).locator('.pf-item')).toHaveCount(0);
      if (a === 'compress-pdf') { await expect(role(panel(page, a), 'go')).toBeDisabled(); await expect(role(panel(page, a), 'file-name')).toBeEmpty(); }
      // and B was cleared when we left it
      await expect(role(panel(page, b), 'result')).toBeHidden();
    }
  });
});

test.describe('Compress PDF', () => {
  test('light mode keeps text, shows before → after and % saved', async ({ page }) => {
    await open(page, '#compress-pdf');
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toHaveText(/^Before: \d+(\.\d+)? MB → After: \d+(\.\d+)? (MB|KB) \(\d+% smaller\)$/, { timeout: 60000 });
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('images-compressed.pdf');
    // decimal units: the summary matches the real byte counts at 1 MB = 1,000,000 bytes
    const before = fs.statSync(fx('images.pdf')).size;
    await expect(role(p, 'summary')).toContainText(`Before: ${(before / 1e6).toFixed(2)} MB`);
    await expect(p.locator('.pf-unit')).toContainText('1 MB = 1,000,000 bytes');
    expect(out.buf.length).toBeLessThan(fs.statSync(fx('images.pdf')).size);
    expect((await pdfInfo(page, out.buf)).pages).toBe(2);
    expect(await pdfText(page, out.buf)).toContain('Lab photos');
    expect(await gaEvents(page)).toContainEqual(['tool_used', { tool: 'compress_pdf', input_type: 'pdf' }]);
  });

  test('strong mode is smaller still and warns text is not selectable', async ({ page }) => {
    await open(page, '#compress-pdf');
    const p = panel(page, 'compress-pdf');
    await expect(p).toContainText("Text won't be selectable.");
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await p.locator('input[value="strong"]').check();
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('text is no longer selectable', { timeout: 60000 });
    const out = await download(page, role(p, 'dl-pdf'));
    const info = await pdfInfo(page, out.buf);
    expect(info.pages).toBe(2);
    expect(info.sizes).toEqual([[595, 842], [595, 842]]);
    expect(out.buf.length).toBeLessThan(fs.statSync(fx('images.pdf')).size / 4);
  });

  test('already-small PDF → original offered', async ({ page }) => {
    await open(page, '#compress-pdf');
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('This PDF is already well compressed.', { timeout: 60000 });
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('text.pdf');
    expect(out.buf.equals(fs.readFileSync(fx('text.pdf')))).toBe(true);
  });

  test('limits: 300 pages, encrypted', async ({ page }) => {
    await open(page, '#compress-pdf');
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('pages-301.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'error')).toContainText('has 301 pages. This tool handles up to 300 pages', { timeout: 60000 });
    await p.locator('input[type=file]').setInputFiles(fx('encrypted.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'error')).toContainText('"encrypted.pdf" is password-protected');
    await p.locator('input[value="strong"]').check();
    await role(p, 'go').click();
    await expect(role(p, 'error')).toContainText('"encrypted.pdf" is password-protected');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('Merge PDF', () => {
  test('page counts, reorder, merge order respected', async ({ page }) => {
    await open(page, '#merge-pdf');
    const p = panel(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await expect(p.locator('.pf-item')).toHaveCount(2);
    await expect(p.locator('.pf-item-meta')).toHaveText(['2 pages', '3 pages']);
    await expect(role(p, 'count')).toContainText('5 pages in total');
    await p.locator('.pf-item').nth(1).locator('[data-act="up"]').click();
    await expect(p.locator('.pf-item-name')).toHaveText(['three-pages.pdf', 'two-pages.pdf']);
    await role(p, 'go').click();
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.name).toBe('merged.pdf');
    const info = await pdfInfo(page, out.buf);
    expect(info.pages).toBe(5);
    expect(info.sizes).toEqual([[501, 701], [502, 702], [503, 703], [401, 601], [402, 602]]);
  });

  test('drag to reorder (desktop)', async ({ page }) => {
    await open(page, '#merge-pdf');
    const p = panel(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await expect(p.locator('.pf-item')).toHaveCount(2);
    await p.locator('.pf-item').nth(1).dragTo(p.locator('.pf-item').nth(0));
    await expect(p.locator('.pf-item-name')).toHaveText(['three-pages.pdf', 'two-pages.pdf']);
  });

  test('encrypted file is named in the error; 300-page and 200 MB limits', async ({ page }) => {
    await open(page, '#merge-pdf');
    const p = panel(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('encrypted.pdf')]);
    await expect(role(p, 'error')).toContainText('"encrypted.pdf" is password-protected');
    await expect(p.locator('.pf-item-name')).toHaveText(['two-pages.pdf']);
    await p.locator('input[type=file]').setInputFiles(fx('pages-301.pdf'));
    await expect(p.locator('.pf-item')).toHaveCount(2);
    await role(p, 'go').click();
    await expect(role(p, 'error')).toContainText('These PDFs have 303 pages together. This tool handles up to 300 pages');
    await role(p, 'start-over').click();
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(os.tmpdir(), `pf-41mb-${i}.pdf`);
      fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, 41 * 1024 * 1024);
      files.push(f);
    }
    await p.locator('input[type=file]').setInputFiles(files);
    await expect(role(p, 'error')).toContainText('The limit is 200 MB per task');
    await expect(p.locator('.pf-item')).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('privacy', () => {
  test('while processing, nothing goes to /api or any non-CDN host', async ({ page }) => {
    const net = await open(page, '#pdf-to-word');
    await ready(page, 'pdf-to-word');
    const start = Date.now();
    const p1 = panel(page, 'pdf-to-word');
    await p1.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(p1, 'output').locator('h1')).toBeVisible({ timeout: 60000 });
    await download(page, role(p1, 'dl-docx'));
    await download(page, role(p1, 'dl-pdf'));
    for (const [tab, files, go] of [
      ['merge-pdf', [fx('two-pages.pdf'), fx('three-pages.pdf')], true],
      ['compress-pdf', [fx('images.pdf')], true],
      ['jpg-to-pdf', [fx('photo.jpg'), fx('pic.webp')], true],
    ] as [string, string[], boolean][]) {
      await page.locator('#tab-' + tab).click();
      const p = panel(page, tab);
      await p.locator('input[type=file]').setInputFiles(files);
      if (go) { await expect(role(p, 'go')).toBeEnabled(); await role(p, 'go').click(); }
      await download(page, role(p, 'dl-pdf'));
    }
    await page.locator('#tab-word-to-pdf').click();
    const pw = panel(page, 'word-to-pdf');
    await pw.locator('input[type=file]').setInputFiles(fx('sample.docx'));
    await expect(role(pw, 'output')).toContainText('Lab Report Heading', { timeout: 60000 });
    await download(page, role(pw, 'dl-pdf'));

    const during = net.requests.filter((r) => r.t >= start);
    const bad = during.filter((r) => {
      if (/^(data|blob):/.test(r.url)) return false;
      const u = new URL(r.url);
      if (u.origin === 'https://cdn.jsdelivr.net' && r.method === 'GET') return false;
      if (u.origin === 'https://parafree.app' && !u.pathname.startsWith('/api/') && r.method === 'GET') return false;
      return true;
    });
    expect(bad.map((r) => r.method + ' ' + r.url)).toEqual([]);
    expect(net.apiCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('layout + SEO', () => {
  test('360px: no horizontal scroll on any tab, including results', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await open(page);
    const noScroll = async (label: string) => expect(await page.evaluate(() => document.documentElement.scrollWidth), label).toBeLessThanOrEqual(360);
    for (const id of ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf']) {
      await page.locator('#tab-' + id).click();
      await expect(panel(page, id)).toBeVisible();
      await noScroll(id);
    }
    await page.locator('#tab-word-to-pdf').click();
    await panel(page, 'word-to-pdf').locator('input[type=file]').setInputFiles(fx('sample.docx'));
    await expect(role(panel(page, 'word-to-pdf'), 'output')).toContainText('Lab Report Heading', { timeout: 60000 });
    await noScroll('word-to-pdf result');
    await page.locator('#tab-merge-pdf').click();
    await panel(page, 'merge-pdf').locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await expect(panel(page, 'merge-pdf').locator('.pf-item')).toHaveCount(2);
    await noScroll('merge list');
    const btn = await role(panel(page, 'merge-pdf'), 'go').boundingBox();
    expect(btn!.height).toBeGreaterThanOrEqual(44);
    await page.locator('#tab-pdf-to-word').click();
    await panel(page, 'pdf-to-word').locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(panel(page, 'pdf-to-word'), 'output').locator('h1')).toBeVisible({ timeout: 60000 });
    await noScroll('pdf-to-word result');
  });

  test('title, meta, canonical, H1, JSON-LD (valid, FAQ matches, no rating), honest copy, sitemap', async ({ page }) => {
    await open(page);
    expect(await page.title()).toBe('Free PDF Tools for Students — PDF to Word, Word to PDF, JPG to PDF, Compress & Merge | ParaFree');
    await expect(page.locator('h1')).toHaveText('Free PDF Tools for Students');
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://parafree.app/pdf-tools.html');
    const desc = await page.locator('meta[name=description]').getAttribute('content');
    expect(desc!.length).toBeGreaterThan(80);
    expect(await page.locator('meta[property="og:title"]').count()).toBe(1);
    expect(await page.locator('meta[name="twitter:card"]').count()).toBe(1);

    const html = fs.readFileSync(path.join(ROOT, 'pdf-tools.html'), 'utf8');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    expect(blocks.map((b) => b['@type']).sort()).toEqual(['FAQPage', 'WebApplication']);
    expect(html).not.toContain('aggregateRating');
    const app = blocks.find((b) => b['@type'] === 'WebApplication');
    expect(app.offers.price).toBe('0');
    const faq = blocks.find((b) => b['@type'] === 'FAQPage').mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text]);
    const visible = await page.evaluate(() => [...document.querySelectorAll('.faq-item')].map((d) =>
      [d.querySelector('.faq-q')!.textContent!.trim(), d.querySelector('.faq-a')!.textContent!.replace(/\s+/g, ' ').trim()]));
    expect(faq).toEqual(visible);
    expect(faq.length).toBeGreaterThanOrEqual(5);
    expect(await page.locator('.pf-section h2').count()).toBe(6);                  // five tools + "Each tool has its own page"

    const copy = await page.evaluate(() => ['.pf-hero', 'main', '.pf-content'].map((s) => document.querySelector(s)!.textContent).join(' '));
    for (const re of [/\bbest\b/i, /#1/, /\bonly\b/i, /100% formatting/i, /\bexact (copy|formatting|layout|match)\b/i, /quillbot|ilovepdf|smallpdf|adobe|sejda/i]) {
      expect(copy.match(re)?.[0], String(re)).toBeUndefined();
    }
    await expect(panel(page, 'pdf-to-word')).toContainText('Creates an editable Word file — text, headings, bold/italic, lists and images kept. Complex layouts (multi-column, tables, forms) may not match exactly.');
    // linked from the homepage (nav, footer, tools grid) since v2.11
    expect(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')).toContain('href="/pdf-tools.html"');
    const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    expect(sitemap.match(/pdf-tools/g)).toHaveLength(1);
    expect(sitemap).toContain('<loc>https://parafree.app/pdf-tools.html</loc>');
    // test files (incl. fixtures) are kept out of deployments
    expect(fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())).toContain('tests/');
  });
});

// ─────────────────────────────────────────────────────────────
// Compress PDF → Target size: Light first, then Strong (binary search down to ~72 DPI / q0.4); honest when unreachable
async function compressToTarget(page: Page, file: string, target: string, customKb?: string) {
  const p = panel(page, 'compress-pdf');
  await p.locator('input[type=file]').setInputFiles(file);
  await p.locator('input[name="pf-compress-mode"][value="target"]').check();
  await expect(role(p, 'target-row')).toBeVisible();
  await role(p, 'target').selectOption(target);
  if (customKb) { await expect(role(p, 'target-custom')).toBeVisible(); await role(p, 'target-custom').fill(customKb); }
  await role(p, 'go').click();
  await expect(role(p, 'result')).toBeVisible({ timeout: 300000 });
  return p;
}

test.describe('Compress PDF: target size', () => {
  test.setTimeout(600000);

  test('large photo PDF → under 1 MB and under 500 KB; the summary says how, and the file really is under', async ({ page }) => {
    const net = await open(page, '#compress-pdf');
    await ready(page, 'compress-pdf');
    const big = await largeFixture(page);
    const before = fs.statSync(big).size;
    expect(before).toBeGreaterThan(5e6);
    for (const [value, label, limit] of [['1000000', '1 MB', 1e6], ['500000', '500 KB', 5e5]] as [string, string, number][]) {
      const p = await compressToTarget(page, big, value);
      const out = await download(page, role(p, 'dl-pdf'));
      expect(out.name).toBe('4-large-for-compress-compressed.pdf');
      expect(out.buf.length, `${label}: ${out.buf.length} bytes`).toBeLessThanOrEqual(limit);
      await expect(role(p, 'summary')).toContainText(`Before: ${decimalSize(before)} → After: ${decimalSize(out.buf.length)} — under ${label}.`);
      await expect(role(p, 'summary')).toContainText(/Text stays selectable\.|Pages became images at \d+ DPI, so the text is no longer selectable\./);
      expect((await pdfInfo(page, out.buf)).pages).toBe(8);
      await role(p, 'start-over').click();
    }
    expect(net.apiCalls).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('an impossible target: honest message and the smallest version offered', async ({ page }) => {
    await open(page, '#compress-pdf');
    await ready(page, 'compress-pdf');
    const big = await largeFixture(page);
    const p = await compressToTarget(page, big, 'custom', '20');
    await expect(role(p, 'summary')).toContainText('Couldn’t get this PDF under 20 KB.');
    await expect(role(p, 'summary')).toContainText('The smallest we could make is');
    await expect(role(p, 'summary')).toContainText('Try removing pages you don’t need, or split the file');
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.buf.length).toBeGreaterThan(20000);
    expect(out.buf.length).toBeLessThan(fs.statSync(big).size / 10);
    await expect(role(p, 'dl-pdf')).toHaveText(`⬇ Download the smallest version (${decimalSize(out.buf.length)})`);
    await expect(role(p, 'summary')).toContainText(`The smallest we could make is ${decimalSize(out.buf.length)}`);
  });

  test('Light is enough → text stays selectable; already under → the original, unchanged', async ({ page }) => {
    await open(page, '#compress-pdf');
    await ready(page, 'compress-pdf');
    const big = await largeFixture(page);
    let p = await compressToTarget(page, big, '2000000');
    await expect(role(p, 'summary')).toContainText('— under 2 MB. Text stays selectable.');
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.buf.length).toBeLessThanOrEqual(2e6);
    expect(await pdfText(page, out.buf)).toContain('Field trip photo 3 of 8');
    await role(p, 'start-over').click();
    p = await compressToTarget(page, fx('text.pdf'), '1000000');
    await expect(role(p, 'summary')).toContainText('Already under 1 MB');
    const orig = await download(page, role(p, 'dl-pdf'));
    expect(orig.name).toBe('text.pdf');
    expect(orig.buf.equals(fs.readFileSync(fx('text.pdf')))).toBe(true);
  });

  test('a custom target below 10 KB is refused with a clear message; switching mode hides the target row', async ({ page }) => {
    await open(page, '#compress-pdf');
    await ready(page, 'compress-pdf');
    const p = panel(page, 'compress-pdf');
    await expect(role(p, 'target-row')).toBeHidden();
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await p.locator('input[name="pf-compress-mode"][value="target"]').check();
    await role(p, 'target').selectOption('custom');
    await role(p, 'target-custom').fill('5');
    await role(p, 'go').click();
    await expect(role(p, 'error')).toContainText('Enter a target size of at least 10 KB.');
    await p.locator('input[name="pf-compress-mode"][value="light"]').check();
    await expect(role(p, 'target-row')).toBeHidden();
  });

  test('homepage PDF tab: Target size works there too', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/#compress-pdf');
    await ready(page, 'compress-pdf');
    const big = await largeFixture(page);
    const p = await compressToTarget(page, big, '1000000');
    const out = await download(page, role(p, 'dl-pdf'));
    expect(out.buf.length).toBeLessThanOrEqual(1e6);
    await expect(role(p, 'summary')).toContainText('— under 1 MB.');
    expect(net.apiCalls.filter((u) => u !== '/api/process')).toEqual([]);         // the homepage's own rating call is mocked (500)
  });
});
