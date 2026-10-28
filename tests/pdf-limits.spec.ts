// Large files (branch feat/file-size): the PDF tools and the Flashcards document upload read files in slices and
// write results as they go (lib/pdf-tools/pdf-stream.js) instead of loading whole files.
// • no tool reads a whole file into memory: every Blob/File arrayBuffer()/text() read is recorded, and none may be
//   bigger than a window (a few MB) on a file far larger than that
// • the result goes straight to disk when the File System Access API is there (a stand-in save dialog records the
//   writes), and into memory otherwise; cancelling the dialog falls back to an ordinary download
// • per-tool limits for desktop Chrome/Edge and for other browsers, the "large file" note, clear errors
// • zero API: the PDF tools make no /api request at all; a document upload makes exactly the one AI call it always
//   made, with TextRank-trimmed text, however big the document is
// Pages are served from this checkout, /api/process is mocked, GA and ads are blocked, the pinned CDN libraries
// come from the test cache. Large inputs are generated into os.tmpdir() (sparse files where only the size matters).
// Run: npx playwright test tests/pdf-limits.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdf-tools');
const fx = (name: string) => path.join(FIX, name);
const TMP = path.join(os.tmpdir(), 'pf-limits');
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml',
};
const MB = 1000 * 1000;
test.setTimeout(240000);
// the generated inputs are large (Windows writes the zeros of a "sparse" file to disk): remove them afterwards
test.afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

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

const PACK = {
  key_points: ['Photosynthesis turns light into chemical energy.', 'It happens in chloroplasts.', 'Chlorophyll absorbs red and blue light.'],
  flashcards: [{ front: 'Where?', back: 'Chloroplasts.' }, { front: 'Absorbs?', back: 'Red and blue.' }, { front: 'Fixes CO2?', back: 'Calvin cycle.' }],
  quiz: [0, 1, 2].map((i) => ({ question: 'Q' + i + '?', options: ['A', 'B', 'C', 'D'], answer_index: 1, explanation: 'Because.' })),
};
type Opts = { saveDialog?: 'record' | 'cancel' | 'none'; reads?: boolean };
// API answers (studypack only), every request recorded; GA blocked; a save-dialog stand-in; read sizes recorded.
async function setup(page: Page, o: Opts = {}) {
  const ctx = page.context(), api: any[] = [], requests: string[] = [], errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route(/^https:\/\/(www\.)?youtube\.com\//, (r) => r.abort());
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      api.push(body);
      const r = body.type === 'studypack_config' ? { success: true, audio: { enabled: true, cap: 5, maxBytes: 50 * 1048576, maxSeconds: 3600, chunkBytes: 2359296, pieceBytes: 3 * 1048576, pieceSeconds: 90, gemini: true, whisper: true } }
        : body.type === 'studypack' ? { success: true, pack: PACK } : { success: false, error: 'bad_request', message: 'unexpected' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  await ctx.addInitScript((opt) => {
    const W = window as any;
    // the biggest single read of file data the page makes (Blob/File arrayBuffer, text, FileReader)
    W.__maxRead = 0;
    const note = (n: number) => { if (n > W.__maxRead) W.__maxRead = n; };
    const ab = Blob.prototype.arrayBuffer, tx = Blob.prototype.text, rd = FileReader.prototype.readAsArrayBuffer, du = FileReader.prototype.readAsDataURL;
    Blob.prototype.arrayBuffer = function () { note(this.size); return ab.call(this); };
    Blob.prototype.text = function () { note(this.size); return tx.call(this); };
    FileReader.prototype.readAsArrayBuffer = function (b: Blob) { note(b.size); return rd.call(this, b); };
    FileReader.prototype.readAsDataURL = function (b: Blob) { note(b.size); return du.call(this, b); };
    if (opt.saveDialog === 'none') { delete W.showSaveFilePicker; return; }
    W.__saves = [];
    W.showSaveFilePicker = async (p: any) => {
      if (opt.saveDialog === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
      const rec = { name: p.suggestedName, writes: 0, parts: [] as any[], closed: false };
      W.__saves.push(rec);
      return {
        name: p.suggestedName,
        createWritable: async () => ({
          write: async (x: any) => { rec.writes++; rec.parts.push(x instanceof Blob ? x : new Blob([x])); },
          close: async () => { rec.closed = true; },
          abort: async () => {},
        }),
        getFile: async () => new File(rec.parts, p.suggestedName),
      };
    };
  }, { saveDialog: o.saveDialog || 'record' });
  return { api, requests, errors };
}
const role = (p: any, r: string) => p.locator(`[data-role="${r}"]`);
async function tool(page: Page, id: string) {
  await page.goto('/pdf-tools.html#' + id);
  const p = page.locator('#panel-' + id);
  await expect(role(p, 'lib-status')).toHaveText('Ready', { timeout: 60000 });
  return p;
}
const maxRead = (page: Page) => page.evaluate(() => (window as any).__maxRead);
const saves = (page: Page) => page.evaluate(() => (window as any).__saves.map((s: any) => ({ name: s.name, writes: s.writes, closed: s.closed, size: s.parts.reduce((t: number, x: Blob) => t + x.size, 0) })));
// re-open a saved result (in the page) → its page count
const savedPages = (page: Page) => page.evaluate(async () => {
  const W = window as any, rec = W.__saves[W.__saves.length - 1];
  const doc = await W.PFStream.open(new File(rec.parts, rec.name), await W.PFLoad.pdfLib());
  return W.PFStream.pages(doc).length;
});
const sparse = (name: string, bytes: number) => { const f = path.join(TMP, name); fs.mkdirSync(TMP, { recursive: true }); fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, bytes); return f; };

// A "scanned" PDF of a given size: pages of one big incompressible image each (written to disk, not built in memory).
function bigPdf(name: string, pages: number, imageBytes: number) {
  const f = path.join(TMP, name);
  if (fs.existsSync(f)) return f;
  fs.mkdirSync(TMP, { recursive: true });
  const jpg = fs.readFileSync(fx('photo.jpg'));              // a real JPEG, padded after its end marker to imageBytes
  const pad = Buffer.alloc(Math.max(0, imageBytes - jpg.length));
  for (let i = 0; i < pad.length; i++) pad[i] = (i * 2654435761) >>> 24;
  const img = Buffer.concat([jpg, pad]);
  const sof = (() => { for (let i = 2; i < jpg.length;) { if (jpg[i] !== 0xff) { i++; continue; } const m = jpg[i + 1]; if (m >= 0xc0 && m <= 0xc2) return { h: jpg.readUInt16BE(i + 5), w: jpg.readUInt16BE(i + 7) }; i += 2 + jpg.readUInt16BE(i + 2); } return { h: 100, w: 100 }; })();
  const fd = fs.openSync(f, 'w');
  let pos = 0;
  const offs: number[] = [];
  const w = (s: string | Buffer) => { const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s; fs.writeSync(fd, b); pos += b.length; };
  const obj = (id: number, body: () => void) => { offs[id] = pos; w(`${id} 0 obj\n`); body(); w('\nendobj\n'); };
  w('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const ids = Array.from({ length: pages }, (_, p) => 4 + p * 3);
  obj(1, () => w('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => w(`<< /Type /Pages /Count ${pages} /Kids [${ids.map((i) => i + ' 0 R').join(' ')}] >>`));
  obj(3, () => w('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  ids.forEach((id, p) => {
    obj(id, () => w(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    const cs = `q 595 0 0 842 0 0 cm /Im0 Do Q\nBT /F1 14 Tf 40 810 Td (Page ${p + 1}: photosynthesis converts light energy into chemical energy.) Tj ET`;
    obj(id + 1, () => { w(`<< /Length ${cs.length} >>\nstream\n`); w(cs); w('\nendstream'); });
    obj(id + 2, () => { w(`<< /Type /XObject /Subtype /Image /Width ${sof.w} /Height ${sof.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); w(img); w('\nendstream'); });
  });
  const xref = pos, n = 4 + pages * 3;
  w(`xref\n0 ${n}\n0000000000 65535 f \n`);
  for (let i = 1; i < n; i++) w(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  w(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.closeSync(fd);
  return f;
}
// 60 pages × 1 MB images ≈ 60 MB: bigger than the old 50 MB limit and 60× a read window
const big = () => bigPdf('scan-60mb.pdf', 60, 1000 * 1000);
const WINDOW_MAX = 4 * MB;            // a read window, or one image/page stream

// ─────────────────────────────────────────────────────────────
test.describe('the streaming engine (lib/pdf-tools/pdf-stream.js)', () => {
  test('every fixture PDF, plus object streams / an incremental update / a broken xref / junk before %PDF, round-trips page for page', async ({ page }) => {
    await setup(page);
    await tool(page, 'merge-pdf');
    const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.pdf') && f !== 'encrypted.pdf');
    const res = await page.evaluate(async (inputs: { name: string; b64: string }[]) => {
      const W = window as any, L = await W.PFLoad.pdfLib(), S = W.PFStream;
      const out: any[] = [];
      // edge cases made here with pdf-lib
      const d = await L.PDFDocument.create();
      for (let i = 0; i < 5; i++) d.addPage([300, 300]).drawText('Edge ' + (i + 1));
      const objstm = await d.save({ useObjectStreams: true }), classic = await d.save({ useObjectStreams: false });
      const enc = new TextEncoder(), dec = new TextDecoder('latin1');
      const broken = enc.encode(dec.decode(classic).replace(/startxref\s+\d+/, 'startxref\n999999999'));
      const junk = new Uint8Array([...enc.encode('JUNK\n'), ...classic]);
      // incremental update: page 1's content replaced in an appended section with /Prev
      const s = dec.decode(objstm), prev = +/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf('startxref')))![1];
      const d2 = await L.PDFDocument.load(objstm), p1 = d2.getPage(0), c0 = p1.node.get(L.PDFName.of('Contents'));
      const cref = c0 instanceof L.PDFArray ? c0.get(0) : c0;
      const font = [...p1.node.Resources().lookup(L.PDFName.of('Font')).keys()][0].asString();
      const content = `BT ${font} 24 Tf 20 150 Td (UPDATED) Tj ET`;
      const body = `${cref.objectNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
      const xoff = objstm.length + body.length, root = d2.context.trailerInfo.Root.objectNumber;
      const tail = `xref\n${cref.objectNumber} 1\n${String(objstm.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${d2.context.largestObjectNumber + 1} /Root ${root} 0 R /Prev ${prev} >>\nstartxref\n${xoff}\n%%EOF\n`;
      const incr = new Uint8Array([...objstm, ...enc.encode(body + tail)]);
      const all = inputs.map((x) => ({ name: x.name, bytes: Uint8Array.from(atob(x.b64), (c) => c.charCodeAt(0)) }))
        .concat([{ name: 'objstm', bytes: objstm }, { name: 'incremental', bytes: incr }, { name: 'broken-xref', bytes: broken }, { name: 'junk', bytes: junk }]);
      for (const x of all) {
        const doc = await S.open(new File([x.bytes], x.name), L);
        const sink = S.blobSink(), w = S.writer(sink, L, { firstFree: doc.ctx.largestObjectNumber + 1 });
        await w.start(); await S.copyAll(doc, w); await w.finish({ root: doc.root, info: doc.info });
        const copy = await sink.close();
        const before = await L.PDFDocument.load(x.bytes, { updateMetadata: false, ignoreEncryption: true });
        const after = await L.PDFDocument.load(new Uint8Array(await copy.arrayBuffer()), { updateMetadata: false });
        const pdfjs = await W.PFLoad.pdfjs();
        const pj = await S.openPdfjs(pdfjs, copy, W.PFLoad.pdfjsOptions()).promise;
        const text = (await (await pj.getPage(1)).getTextContent()).items.map((t: any) => t.str).join(' ');
        await pj.destroy();
        out.push({ name: x.name, pages: [before.getPageCount(), S.pages(doc).length, after.getPageCount()], text });
      }
      return out;
    }, files.map((f) => ({ name: f, b64: fs.readFileSync(fx(f)).toString('base64') })));
    for (const r of res) expect(r.pages, r.name).toEqual([r.pages[0], r.pages[0], r.pages[0]]);
    expect(res.find((r: any) => r.name === 'incremental').text).toContain('UPDATED');     // the newest version of the page
    expect(res.find((r: any) => r.name === 'text.pdf').text.length).toBeGreaterThan(20);
    expect(res.length).toBe(files.length + 4);
  });

  test('encrypted PDFs are refused by the engine; a non-PDF is reported as such', async ({ page }) => {
    await setup(page);
    await tool(page, 'merge-pdf');
    const r = await page.evaluate(async (b64) => {
      const W = window as any, L = await W.PFLoad.pdfLib(), S = W.PFStream;
      const t = async (f: File) => { try { await S.open(f, L); return 'opened'; } catch (e: any) { return e.type; } };
      return [await t(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'e.pdf')), await t(new File(['hello'], 'x.pdf'))];
    }, fs.readFileSync(fx('encrypted.pdf')).toString('base64'));
    expect(r).toEqual(['encrypted', 'file_error']);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('no tool reads the whole file', () => {
  test('Compress Light on a 60 MB PDF: largest read ≤ 4 MB, smaller output, text kept, zero API', async ({ page }) => {
    const net = await setup(page, { saveDialog: 'none' });
    const p = await tool(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(big());
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 180000 });
    await expect(role(p, 'summary')).toContainText('smaller');
    expect(await maxRead(page)).toBeLessThanOrEqual(WINDOW_MAX);
    expect(net.requests.filter((u) => u.includes('/api/'))).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('Compress Strong and PDF to JPG on a 60 MB PDF: pdf.js reads byte ranges, never the whole file', async ({ page }) => {
    const net = await setup(page, { saveDialog: 'none' });
    let p = await tool(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(big());
    await p.locator('input[value="strong"]').check();
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('text is no longer selectable', { timeout: 180000 });
    expect(await maxRead(page)).toBeLessThanOrEqual(WINDOW_MAX);
    p = await tool(page, 'pdf-to-jpg');
    await p.locator('input[type=file]').setInputFiles(big());
    await expect(role(p, 'sel-count')).toContainText('60 of 60 pages selected', { timeout: 60000 });
    await role(p, 'range').fill('1-3');
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('3 pages', { timeout: 120000 });
    const [d] = await Promise.all([page.waitForEvent('download'), role(p, 'dl-main').click()]);
    const zip = await JSZip.loadAsync(fs.readFileSync((await d.path())!));
    expect(Object.keys(zip.files)).toEqual(['scan-60mb-p1.jpg', 'scan-60mb-p2.jpg', 'scan-60mb-p3.jpg']);   // the streamed ZIP is a valid ZIP
    expect(await maxRead(page)).toBeLessThanOrEqual(WINDOW_MAX);
    expect(net.requests.filter((u) => u.includes('/api/'))).toEqual([]);
  });

  test('Merge two 60 MB PDFs: image data goes from the files to the result without being read', async ({ page }) => {
    const net = await setup(page, { saveDialog: 'none' });
    const p = await tool(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([big(), fx('two-pages.pdf'), big()]);
    await expect(p.locator('.pf-item')).toHaveCount(3, { timeout: 60000 });
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('Merged 3 files into one PDF: 122 pages', { timeout: 120000 });
    expect(await maxRead(page)).toBeLessThanOrEqual(WINDOW_MAX);
    const [d] = await Promise.all([page.waitForEvent('download'), role(p, 'dl-pdf').click()]);
    expect(fs.statSync((await d.path())!).size).toBeGreaterThan(2 * fs.statSync(big()).size * 0.99);
    expect(net.requests.filter((u) => u.includes('/api/'))).toEqual([]);
  });

  test('JPG to PDF: JPEGs that need no change are not read (only their first 256 KB)', async ({ page }) => {
    const net = await setup(page, { saveDialog: 'none' });
    const p = await tool(page, 'jpg-to-pdf');
    // a 3 MB JPEG (padding after the end marker), five times
    const img = path.join(TMP, 'padded-3mb.jpg');
    fs.mkdirSync(TMP, { recursive: true });
    const jpg = fs.readFileSync(fx('photo.jpg'));
    fs.writeFileSync(img, Buffer.concat([jpg, Buffer.alloc(3 * MB - jpg.length, 7)]));
    await p.locator('input[type=file]').setInputFiles(Array(5).fill(img));
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('Your PDF is ready: 5 pages', { timeout: 60000 });
    expect(await maxRead(page)).toBeLessThanOrEqual(256 * 1024);
    expect(net.requests.filter((u) => u.includes('/api/'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('straight to disk (File System Access API)', () => {
  test('a large input: the save dialog opens from the click, the result is written in pieces, "Saved to your computer", no download button', async ({ page }) => {
    await setup(page, { saveDialog: 'record' });
    const p = await tool(page, 'compress-pdf');
    await page.evaluate(() => { (window as any).PFC.LIMITS.bigFile = 1000; });      // treat everything as "large" here
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await expect(role(p, 'big-note')).toBeVisible();
    await expect(role(p, 'big-note')).toHaveText('Large file: it is processed on your device, so this can take a few minutes — keep this tab open. Very large files work best on desktop Chrome or Edge.');
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('Saved to your computer as “images-compressed.pdf”.', { timeout: 60000 });
    await expect(role(p, 'dl-pdf')).toBeHidden();
    const [s] = await saves(page);
    expect(s).toMatchObject({ name: 'images-compressed.pdf', closed: true });
    expect(s.writes).toBeGreaterThan(1);
    expect(await savedPages(page)).toBe(2);
    // Merge and JPG to PDF save the same way
    const m = await tool(page, 'merge-pdf');
    await page.evaluate(() => { (window as any).PFC.LIMITS.bigFile = 1000; });
    await m.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await role(m, 'go').click();
    await expect(role(m, 'summary')).toContainText('Saved to your computer as “merged.pdf”.', { timeout: 60000 });
    await expect(role(m, 'dl-pdf')).toBeHidden();
    expect(await savedPages(page)).toBe(5);
  });

  test('cancelling the save dialog: the result is made in memory and offered as a normal download', async ({ page }) => {
    await setup(page, { saveDialog: 'cancel' });
    const p = await tool(page, 'compress-pdf');
    await page.evaluate(() => { (window as any).PFC.LIMITS.bigFile = 1000; });
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'dl-pdf')).toBeVisible({ timeout: 60000 });
    await expect(role(p, 'summary')).not.toContainText('Saved to your computer');
    const [d] = await Promise.all([page.waitForEvent('download'), role(p, 'dl-pdf').click()]);
    expect(d.suggestedFilename()).toBe('images-compressed.pdf');
  });

  test('a small input never opens the save dialog', async ({ page }) => {
    await setup(page, { saveDialog: 'record' });
    const p = await tool(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'dl-pdf')).toBeVisible({ timeout: 60000 });
    expect(await saves(page)).toEqual([]);
    await expect(role(p, 'big-note')).toBeHidden();
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('limits per tool and browser', () => {
  test('the limits (set from crash tests on a machine with 2–3 GB free)', async ({ page }) => {
    await setup(page);
    await tool(page, 'compress-pdf');
    const ops = await page.evaluate(() => (window as any).PFC.OPS);
    const G = 1000 * MB;
    expect(ops).toEqual({
      'merge-pdf':    { big: { file: 2 * G, total: 4 * G }, basic: { file: 500 * MB, total: 1 * G } },
      'compress-pdf': { big: { file: 2 * G, render: 1 * G }, basic: { file: 500 * MB, render: 500 * MB } },
      'pdf-to-jpg':   { big: { file: 1 * G }, basic: { file: 500 * MB } },
      'jpg-to-pdf':   { big: { file: 50 * MB, total: 1 * G }, basic: { file: 50 * MB, total: 500 * MB } },
      'pdf-to-word':  { big: { file: 100 * MB }, basic: { file: 50 * MB } },
      'word-to-pdf':  { big: { file: 50 * MB }, basic: { file: 50 * MB } },
    });
  });

  test('desktop Chrome/Edge: Compress 2 GB (Strong / Target size 1 GB), PDF to JPG 1 GB, PDF to Word 100 MB, Word to PDF 50 MB; big-file note', async ({ page }) => {
    await setup(page, { saveDialog: 'record' });
    const cases: [string, number, string][] = [
      ['compress-pdf', 2100 * MB, '"x.pdf" is 2100.0 MB. The limit is 2 GB per file — try compressing it first or splitting it.'],
      ['pdf-to-jpg', 1100 * MB, '"x.pdf" is 1100.0 MB. The limit is 1 GB per file — try compressing it first or splitting it.'],
      ['pdf-to-word', 110 * MB, '"x.pdf" is 110.0 MB. The limit is 100 MB per file — try compressing it first or splitting it.'],
    ];
    for (const [id, size, msg] of cases) {
      const p = await tool(page, id);
      await p.locator('input[type=file]').setInputFiles(sparse('x.pdf', size));
      await expect(role(p, 'error')).toHaveText(msg, { timeout: 30000 });
    }
    const w = await tool(page, 'word-to-pdf');
    await w.locator('input[type=file]').setInputFiles(sparse('x.docx', 51 * MB));
    await expect(role(w, 'error')).toContainText('The limit is 50 MB per file');
    // within the limit and over 200 MB: the note, before anything is read
    const c = await tool(page, 'compress-pdf');
    await c.locator('input[type=file]').setInputFiles(sparse('y.pdf', 300 * MB));
    await expect(role(c, 'big-note')).toBeVisible();
    await expect(role(c, 'error')).toBeHidden();
    await expect(c.locator('.pf-drop-hint')).toContainText('up to 2 GB');
    // Strong and Target size render every page: 1 GB, checked on the click, before anything is read
    await c.locator('input[type=file]').setInputFiles(sparse('z.pdf', 1500 * MB));
    await c.locator('input[value="strong"]').check();
    await role(c, 'go').click();
    await expect(role(c, 'error')).toHaveText('"z.pdf" is 1500.0 MB. Strong and Target size handle files up to 1 GB — use Light for this file (up to 2 GB), or split it.');
  });

  test('other browsers (no File System Access API): 500 MB, and the message says where larger files work', async ({ page }) => {
    await setup(page, { saveDialog: 'none' });
    const p = await tool(page, 'compress-pdf');
    await expect(p.locator('.pf-drop-hint')).toContainText('up to 500 MB');
    await p.locator('input[type=file]').setInputFiles(sparse('x.pdf', 600 * MB));
    await expect(role(p, 'error')).toHaveText('"x.pdf" is 600.0 MB. The limit is 500 MB per file in this browser (up to 2 GB on desktop Chrome or Edge) — try compressing it first or splitting it.');
    const m = await tool(page, 'merge-pdf');
    await m.locator('input[type=file]').setInputFiles([sparse('a.pdf', 400 * MB), sparse('b.pdf', 400 * MB), sparse('c.pdf', 400 * MB)]);
    await expect(role(m, 'error')).toContainText('The limit is 1 GB per task in this browser');
    const w = await tool(page, 'pdf-to-word');
    await w.locator('input[type=file]').setInputFiles(sparse('x.pdf', 60 * MB));
    await expect(role(w, 'error')).toContainText('The limit is 50 MB per file in this browser (up to 100 MB on desktop Chrome or Edge)');
    const j = await tool(page, 'pdf-to-jpg');
    await expect(j.locator('.pf-drop-hint')).toContainText('up to 300 pages, 500 MB');
    // a large file within this browser's limit: the note says where larger files work, and the limit here
    const c = await tool(page, 'compress-pdf');
    await c.locator('input[type=file]').setInputFiles(sparse('y.pdf', 300 * MB));
    await expect(role(c, 'big-note')).toHaveText('Large file: it is processed on your device, so this can take a few minutes — keep this tab open. Very large files work best on desktop Chrome or Edge. In this browser the limit is 500 MB.');
    await c.locator('input[value="strong"]').check();
    await role(c, 'go').click();                                 // 300 MB < 500 MB: Strong is allowed here too
    await expect(role(c, 'error')).not.toContainText('Strong and Target size handle files up to');
  });

  test('out of memory and a full disk get clear messages, never a silent failure', async ({ page }) => {
    await setup(page);
    await tool(page, 'compress-pdf');
    const r = await page.evaluate(() => {
      const C = (window as any).PFC;
      return [C.toToolError(new RangeError('Array buffer allocation failed')), C.toToolError(new DOMException('quota', 'QuotaExceededError'))].map((e: any) => [e.type, e.message]);
    });
    expect(r[0]).toEqual(['too_large', 'This file needs more memory than this browser tab has. Close other tabs and try again, use desktop Chrome or Edge, or split the file into smaller parts.']);
    expect(r[1]).toEqual(['too_large', 'There isn’t enough free space on your disk to save the result. Free up some space, or choose another drive, and try again.']);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('Flashcards & Quiz: document upload', () => {
  const docx = async (paras: string[], mediaBytes: number) => {
    const z = new JSZip();
    z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
    z.file('word/media/image1.png', crypto.randomBytes(mediaBytes), { compression: 'STORE' });
    return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  const PARAS = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: photosynthesis converts light energy into chemical energy that the plant stores as glucose in its cells.`);
  async function open(page: Page) {
    await page.goto('/flashcard-quiz-maker.html');
    await page.waitForFunction(() => !!(window as any).PFStudyPack);
    await page.locator('.sp-in[data-input="file"]').click();
  }

  test('a 60 MB PDF and a .docx with 30 MB of images: read in slices; exactly one AI call each, with trimmed text — size has no effect on API use', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    for (const [file, label] of [[big(), 'pdf'], [{ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await docx(PARAS, 30 * MB) }, 'docx']] as any[]) {
      const before = net.api.length;
      await page.locator('#spFile').setInputFiles(file);
      await page.locator('#spGo').click();
      await expect.poll(() => net.api.slice(before).filter((c) => c.type === 'studypack').length, { timeout: 120000 }).toBe(1);
      await expect(page.locator('#spGo')).toBeEnabled({ timeout: 60000 });
      const calls = net.api.slice(before).filter((c) => c.type !== 'studypack_config');
      expect(calls.map((c) => c.type), label).toEqual(['studypack']);
      expect(calls[0].inputType, label).toBe(label);
      expect(calls[0].text.split(/\s+/).length, label).toBeLessThanOrEqual(4000);
      expect(await maxRead(page), label).toBeLessThanOrEqual(WINDOW_MAX);
    }
    expect(net.requests.filter((u) => /\/api\//.test(u) && !/parafree\.app\/api\/process/.test(u))).toEqual([]);
    expect(net.requests.filter((u) => /api.groq.com|generativelanguage.googleapis.com|api.openai.com|api.anthropic.com|openrouter.ai|api.cerebras.ai|api.mistral.ai/.test(u))).toEqual([]);
  });

  test('the guard it lacked: over 2 GB is refused before anything is read or sent; large files get the note', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#spFile').setInputFiles(sparse('huge.pdf', 2100 * MB));
    await expect(page.locator('#spStatus')).toHaveText('This file is 2.1 GB. Documents can be up to 2 GB here — try a shorter part of it.');
    await page.locator('#spGo').click();
    await expect(page.locator('#spStatus')).toContainText('Documents can be up to 2 GB here');
    await page.locator('#spFile').setInputFiles(sparse('big.pdf', 300 * MB));
    await expect(page.locator('#spFileName')).toContainText('large file: it is read on your device');
    expect(net.api.filter((c) => c.type === 'studypack')).toEqual([]);
  });

  test('without the File System Access API (Firefox, Safari, phones): 500 MB, and where larger files work', async ({ page }) => {
    await setup(page, { saveDialog: 'none' });
    await open(page);
    await page.locator('#spFile').setInputFiles(sparse('mid.pdf', 600 * MB));
    await expect(page.locator('#spStatus')).toHaveText('This file is 600 MB. Documents can be up to 500 MB here (up to 2 GB on desktop Chrome or Edge) — try a shorter part of it.');
    await page.locator('#spFile').setInputFiles(sparse('mid2.pdf', 300 * MB));
    await expect(page.locator('#spFileName')).toContainText('Works best on desktop Chrome or Edge; in this browser the limit is 500 MB.');
  });
});
