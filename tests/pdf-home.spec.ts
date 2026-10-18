// Homepage PDF Tools tab + "Paraphrase this document" hand-off (index.html, lib/pdf-tools/home.js,
// lib/pdf-tools/handoff.js). Pages are served from THIS checkout (requests to parafree.app are
// fulfilled from disk); /api/process is MOCKED; GA, ads, web fonts and photos are BLOCKED. CDN
// libraries (jsDelivr, cdnjs, unpkg) are fetched once and cached on disk for later runs.
// Run: npx playwright test tests/pdf-home.spec.ts
import { test, expect, Page, Route, Locator } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdf-tools');
const fx = (n: string) => path.join(FIX, n);
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
// index.html on main before this change, as deployed (the git copy, LF line endings), in bytes.
// The homepage may grow by less than 15 KB.
const BASELINE_INDEX_BYTES = 473317;
const deployedSize = (file: string) => Buffer.byteLength(fs.readFileSync(file, 'utf8').split('\r\n').join('\n'), 'utf8');
// the PDF tools' own libraries — none of these may load with the homepage
const PDF_TOOL_LIBS = /cdn\.jsdelivr\.net\/npm\/(pdf-lib@|pdfjs-dist@|docx@|docx-preview@|jszip@|jspdf@|tesseract\.js|@tesseract\.js-data|@expo-google-fonts)|\/lib\/pdf-tools\/|\/pdf-tools\.(css|html)/;

test.setTimeout(180000);

type Req = { url: string; method: string };

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
  const apiCalls: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  ctx.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(CDN, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, result: 'A freshly reworded version of the text that is long enough to show.', usedApi: 'mock' }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { requests, apiCalls, errors };
}

const home = (page: Page) => page.locator('#pfHomePdf');
const panel = (page: Page, id: string) => home(page).locator('#panel-' + id);
const role = (p: Locator, r: string) => p.locator(`[data-role="${r}"]`);
async function download(page: Page, button: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync((await d.path())!) };
}
async function pdfPages(page: Page, buf: Buffer) {
  return page.evaluate(async (b64) => {
    const L = await (window as any).PFLoad.pdfLib();
    return (await L.PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).getPageCount();
  }, buf.toString('base64'));
}
async function openPdfTab(page: Page) {
  await page.locator('#tab-pdf').click();
  await expect(home(page).locator('.pf-subtab')).toHaveCount(5, { timeout: 60000 });
}

// ─────────────────────────────────────────────────────────────
test.describe('homepage load', () => {
  test('initial load fetches none of the PDF tools (no JS/CSS/CDN libraries) and grows < 15 KB', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500);
    expect(net.requests.filter((r) => PDF_TOOL_LIBS.test(r.url)).map((r) => r.url)).toEqual([]);
    await expect(page.locator('#tab-pdf')).toBeVisible();
    await expect(page.locator('#pfHomePdf')).toBeHidden();
    await expect(page.locator('#pfHomePdf')).toBeEmpty();
    const size = deployedSize(path.join(ROOT, 'index.html'));
    expect(size - BASELINE_INDEX_BYTES, `index.html grew by ${size - BASELINE_INDEX_BYTES} bytes`).toBeLessThan(15000);
    // the only same-origin requests are the ones the page already made before (no new files)
    const local = net.requests.filter((r) => r.url.startsWith('https://parafree.app/') && !r.url.includes('/api/process')).map((r) => new URL(r.url).pathname);
    for (const p of local) expect(p, p).not.toMatch(/pdf-tools/);
    // the existing tab row keeps its order; PDF Tools is last
    expect(await page.locator('.tool-tabs .tool-tab').evaluateAll((els) => els.map((e) => e.id)))
      .toEqual(['tab-paraphrase', 'tab-humanize', 'tab-summarize', 'tab-grammar', 'tab-detect', 'tab-ai', 'tab-pdf', 'tab-cv']);
    expect(net.errors).toEqual([]);
  });

  test('homepage title, H1, description unchanged; JSON-LD valid; new FAQ entries match the visible FAQ', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    expect(await page.title()).toBe('ParaFree — 100% Free Forever Paraphraser & CV Builder');
    await expect(page.locator('h1.hero-title')).toContainText('Paraphrase Documents');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = blocks.find((b) => b['@type'] === 'FAQPage').mainEntity;
    for (const q of ['Can I convert PDF to Word for free on ParaFree?', 'Are my PDF files uploaded?']) {
      const entry = faq.find((e: any) => e.name === q);
      expect(entry, q).toBeTruthy();
      const visible = await page.locator('.faq-item', { has: page.locator('.faq-q', { hasText: q }) }).locator('.faq-a').textContent();
      expect(entry.acceptedAnswer.text).toBe(visible!.trim());
    }
    // discoverability links
    await expect(page.locator('#homeNavLinks a[href="/pdf-tools.html"]')).toHaveText('PDF Tools');
    await expect(page.locator('#mobileMenu a[href="/pdf-tools.html"]')).toHaveCount(1);
    expect(await page.locator('footer a[href^="/pdf-tools.html#"]').evaluateAll((a) => a.map((x) => x.textContent))).toEqual(['PDF to Word', 'Word to PDF', 'JPG to PDF', 'Compress PDF', 'Merge PDF']);
    await expect(page.locator('a.pf-pdf-card')).toContainText('Convert, compress & merge PDFs — free, in your browser');
    await expect(page.locator('td', { hasText: 'PDF↔Word, JPG→PDF, compress, merge (in-browser, files stay on your device)' })).toHaveCount(1);
    await expect(page.locator('#pfPdfPromo')).toContainText('📄 New: free PDF tools — PDF to Word, compress, merge →');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('homepage PDF tab', () => {
  test('clicking the tab loads the tools; all five produce output on the homepage', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await openPdfTab(page);
    await expect(page.locator('#tab-pdf')).toHaveClass(/active/);
    await expect(page.locator('.tool-container')).toBeHidden();
    await expect(home(page).locator('.pf-home-full')).toHaveAttribute('href', '/pdf-tools.html#pdf-to-word');

    let p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(p, 'output').locator('h1')).toHaveText('Study Notes on Photosynthesis', { timeout: 60000 });
    const docx = await download(page, role(p, 'dl-docx'));
    expect(docx.name).toBe('text-converted.docx');
    expect(await (await JSZip.loadAsync(docx.buf)).file('word/document.xml')!.async('string')).toContain('Study Notes on Photosynthesis');

    await home(page).locator('[data-pftab="word-to-pdf"]').click();
    await expect(page).toHaveURL(/#word-to-pdf$/);
    p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('sample.docx'));
    await expect(role(p, 'output')).toContainText('Lab Report Heading', { timeout: 60000 });
    expect((await download(page, role(p, 'dl-pdf'))).name).toBe('sample-converted.pdf');

    await home(page).locator('[data-pftab="jpg-to-pdf"]').click();
    p = panel(page, 'jpg-to-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('shot.png')]);
    await role(p, 'go').click();
    const jpg = await download(page, role(p, 'dl-pdf'));
    expect(await pdfPages(page, jpg.buf)).toBe(2);

    await home(page).locator('[data-pftab="compress-pdf"]').click();
    p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('% smaller', { timeout: 60000 });

    await home(page).locator('[data-pftab="merge-pdf"]').click();
    p = panel(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await expect(role(p, 'go')).toBeEnabled();
    await role(p, 'go').click();
    expect(await pdfPages(page, (await download(page, role(p, 'dl-pdf'))).buf)).toBe(5);

    expect(net.apiCalls).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('isolation: PDF tools leave the Paraphraser and the page\'s own libraries alone; paraphrase + upload still work', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.fill('#inputText', 'This is my essay text about renewable energy that I want to keep exactly as typed.');
    const before = await page.evaluate(() => {
      const w = window as any;
      w.__libs = { pdfjsLib: w.pdfjsLib, jspdf: w.jspdf, JSZip: w.JSZip, Tesseract: w.Tesseract, docx: w.docx };
      return { pdfjs: w.pdfjsLib && w.pdfjsLib.version, input: (document.getElementById('inputText') as HTMLTextAreaElement).value };
    });
    expect(before.pdfjs).toBe('2.16.105');
    await openPdfTab(page);
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(p, 'output').locator('h1')).toBeVisible({ timeout: 60000 });
    await download(page, role(p, 'dl-pdf'));                                         // jsPDF 4 + fonts
    await home(page).locator('[data-pftab="word-to-pdf"]').click();
    await panel(page, 'word-to-pdf').locator('input[type=file]').setInputFiles(fx('sample.docx'));   // JSZip + docx-preview
    await expect(role(panel(page, 'word-to-pdf'), 'output')).toContainText('Lab Report Heading', { timeout: 60000 });
    await page.evaluate(() => (window as any).PFLoad.tesseract());                   // Tesseract 5
    // every global the homepage uses is still its own copy
    const same = await page.evaluate(() => {
      const w = window as any, b = w.__libs;
      return { pdfjsLib: w.pdfjsLib === b.pdfjsLib, jspdf: w.jspdf === b.jspdf, JSZip: w.JSZip === b.JSZip, Tesseract: w.Tesseract === b.Tesseract, docx: w.docx === b.docx, version: w.pdfjsLib && w.pdfjsLib.version };
    });
    expect(same).toEqual({ pdfjsLib: true, jspdf: true, JSZip: true, Tesseract: true, docx: true, version: '2.16.105' });

    // back to the Paraphraser: input untouched, PDF panel hidden and cleared
    await page.locator('#tab-paraphrase').click();
    await expect(page.locator('#tab-paraphrase')).toHaveClass(/active/);
    await expect(page.locator('#tab-pdf')).not.toHaveClass(/active/);
    await expect(page.locator('#pfHomePdf')).toBeHidden();
    await expect(page.locator('.tool-container')).toBeVisible();
    expect(await page.inputValue('#inputText')).toBe(before.input);
    // paraphrase still works (mocked API)
    await page.click('#paraphraseBtn');
    await expect(page.locator('#outputText')).toContainText('A freshly reworded version', { timeout: 30000 });
    expect(net.apiCalls.length).toBe(1);
    // and the Paraphraser's own upload still reads Word files (homepage JSZip/mammoth path)
    await page.locator('#fileUpload').setInputFiles(fx('sample.docx'));
    await expect(page.locator('#inputText')).toHaveValue(/important result/, { timeout: 30000 });
    // and its own PDF upload still uses the homepage's pdf.js 2.16
    await page.locator('#fileUpload').setInputFiles(fx('text.pdf'));
    await expect(page.locator('#inputText')).toHaveValue(/Study Notes on Photosynthesis/, { timeout: 30000 });
    expect(net.errors).toEqual([]);
  });

  test('hash deep links open the PDF tab on that tool; other hashes do not', async ({ page }) => {
    await setup(page);
    await page.goto('/#compress-pdf');
    await expect(home(page).locator('[data-pftab="compress-pdf"]')).toHaveClass(/active/, { timeout: 60000 });
    await expect(panel(page, 'compress-pdf')).toBeVisible();
    await expect(panel(page, 'pdf-to-word')).toBeHidden();
    await page.evaluate(() => { location.hash = 'merge-pdf'; });
    await expect(panel(page, 'merge-pdf')).toBeVisible();
    await page.goto('about:blank');
    await page.goto('/#tools');
    await expect(page.locator('#pfHomePdf')).toBeHidden();
    await expect(page.locator('#tab-paraphrase')).toHaveClass(/active/);
    // the promo line under the CV strip opens the tab too
    await page.locator('#pfPdfPromo a').click();
    await expect(panel(page, 'pdf-to-word')).toBeVisible({ timeout: 60000 });
  });

  test('360px: tab row wraps, no horizontal page scroll (closed and open)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await setup(page);
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await openPdfTab(page);
    await panel(page, 'pdf-to-word').locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(panel(page, 'pdf-to-word'), 'output').locator('h1')).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const tab = await page.locator('#tab-pdf').boundingBox();
    expect(tab!.x + tab!.width).toBeLessThanOrEqual(360);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('Paraphrase this document hand-off', () => {
  test('on the homepage: the Word file goes straight into the Paraphraser upload', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await openPdfTab(page);
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(p, 'output').locator('h1')).toBeVisible({ timeout: 60000 });
    await role(p, 'handoff').click();
    await expect(page.locator('#pfHomePdf')).toBeHidden();
    await expect(page.locator('#tab-paraphrase')).toHaveClass(/active/);
    await expect(page.locator('#fileName')).toContainText('text-converted.docx');
    // the Paraphraser loads body text (headings are kept out of the rewrite, by design)
    await expect(page.locator('#inputText')).toHaveValue(/Plants turn light into chemical energy/, { timeout: 30000 });
    const ga = await page.evaluate(() => ((window as any).dataLayer || []).filter((a: any) => a && a[0] === 'event').map((a: any) => [a[1], a[2]]));
    expect(ga).toContainEqual(['pdf_handoff', { tool: 'pdf_to_word' }]);
    expect(net.apiCalls).toEqual([]);
  });

  test('from pdf-tools.html: stored in IndexedDB, opened with /?handoff=pdf, injected, deleted, URL cleaned', async ({ page }) => {
    await setup(page);
    await page.goto('/pdf-tools.html#pdf-to-word');
    const p = page.locator('#panel-pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('1-assignment.pdf'));
    await expect(role(p, 'output').locator('h1').first()).toBeVisible({ timeout: 60000 });
    await Promise.all([page.waitForURL(/\/\?handoff=pdf$/), role(p, 'handoff').click()]);
    await expect(page.locator('#inputText')).toHaveValue(/Cybersecurity frameworks help organisations/, { timeout: 30000 });
    await expect(page.locator('#fileName')).toContainText('1-assignment-converted.docx');
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
    const left = await page.evaluate(() => new Promise((resolve) => {
      const r = indexedDB.open('parafree-handoff', 1);
      r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').count(); q.onsuccess = () => { resolve(q.result); r.result.close(); }; };
    }));
    expect(left).toBe(0);
    await expect(page.locator('#pfHandoffNote')).toHaveCount(0);
  });

  test('fallback: nothing stored, or older than 10 minutes → message, nothing else changes', async ({ page }) => {
    await setup(page);
    await page.goto('/?handoff=pdf');
    await expect(page.locator('#pfHandoffNote')).toHaveText('Download the Word file and upload it here', { timeout: 30000 });
    expect(await page.inputValue('#inputText')).toBe('');
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
    await expect(page.locator('#tab-paraphrase')).toHaveClass(/active/);

    // an expired record (11 minutes old) is not used, and is deleted
    await page.evaluate(() => new Promise<void>((resolve) => {
      const r = indexedDB.open('parafree-handoff', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => {
        const tx = r.result.transaction('files', 'readwrite');
        tx.objectStore('files').put({ ts: Date.now() - 11 * 60 * 1000, name: 'old.docx', type: 'application/octet-stream', blob: new Blob(['x']) }, 'pdf-1');
        tx.oncomplete = () => { r.result.close(); resolve(); };
      };
    }));
    await page.goto('/?handoff=pdf');
    await expect(page.locator('#pfHandoffNote')).toHaveText('Download the Word file and upload it here', { timeout: 30000 });
    expect(await page.inputValue('#inputText')).toBe('');
    await expect(page.locator('#fileName')).not.toContainText('old.docx');
  });

  test('without ?handoff=pdf the hand-off code never loads', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/?utm_source=x');
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);
    expect(net.requests.filter((r) => r.url.includes('handoff.js'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('hero CTA buttons (overlap fix)', () => {
  // short desktop screens are where the buttons used to be cut off under the stats band
  for (const [w, h] of [[1528, 730], [1280, 720], [1024, 700], [768, 900], [390, 844], [360, 780]]) {
    test(`${w}×${h}: CTA buttons fully visible, clickable, clear of the stats band and the scroll hint`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await setup(page);
      await page.goto('/');
      await page.waitForLoadState('load');
      const buttons = page.locator('#mainHero .cta-buttons a');
      await expect(buttons).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const btn = buttons.nth(i);
        await btn.scrollIntoViewIfNeeded();
        const r = await btn.evaluate((el) => {
          const box = (e: Element | null) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          const ind = document.getElementById('heroScrollIndicator')!;
          return { btn: box(el), stats: box(document.getElementById('statsStrip')), hero: box(document.getElementById('mainHero')),
            ind: getComputedStyle(ind).display === 'none' ? null : box(ind), hitIsButton: !!hit && (hit === el || el.contains(hit)) };
        });
        const overlap = (a: any, b: any) => a && b && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
        expect(overlap(r.btn, r.stats), `button ${i} vs stats band`).toBeFalsy();
        expect(r.btn.bottom, 'not clipped by the hero').toBeLessThanOrEqual(r.hero.bottom);
        expect(r.stats.top - r.btn.bottom, 'clear space above the stats band').toBeGreaterThanOrEqual(24);
        expect(overlap(r.btn, r.ind), `button ${i} vs "Explore Tools"`).toBeFalsy();
        expect(r.hitIsButton, `elementFromPoint at button ${i} centre`).toBe(true);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────
test.describe('homepage CV Builder tab', () => {
  test('shows the light panel (no CV builder code), GA cv_tab_click, button goes to cv-builder.html', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.fill('#inputText', 'Text that must still be here after visiting the CV tab.');
    await page.locator('#tab-cv').click();
    const cv = page.locator('#pfHomeCv');
    await expect(cv).toBeVisible();
    await expect(page.locator('#tab-cv')).toHaveClass(/active/);
    await expect(page.locator('.tool-container')).toBeHidden();
    await expect(cv.locator('h2')).toHaveText('Free CV Builder — 54 templates, no signup, no watermark');
    await expect(cv.locator('li')).toHaveCount(4);
    await expect(cv.locator('a', { hasText: 'See templates' })).toHaveAttribute('href', '/cv-templates.html');
    await expect(page.locator('#promoBar')).toContainText('Free CV Builder');                    // promo strip kept
    const ga = () => page.evaluate(() => ((window as any).dataLayer || []).filter((a: any) => a && a[0] === 'event').map((a: any) => [a[1], a[2]]));
    await expect.poll(ga).toContainEqual(['cv_tab_click', {}]);
    // no CV builder code (or the PDF tools) loads for this tab
    expect(net.requests.filter((r) => /cv-builder|cv-templates|\/lib\/pdf-tools\/(?!pdf-events\.js)|cdn\.jsdelivr\.net/.test(r.url)).map((r) => r.url)).toEqual([]);
    // back to the Paraphraser: exactly as before
    await page.locator('#tab-paraphrase').click();
    await expect(cv).toBeHidden();
    await expect(page.locator('.tool-container')).toBeVisible();
    expect(await page.inputValue('#inputText')).toBe('Text that must still be here after visiting the CV tab.');
    // the button opens the full CV builder
    await page.locator('#tab-cv').click();
    await Promise.all([page.waitForURL(/\/cv-builder\.html$/), page.locator('#pfCvStart').click()]);
  });

  test('other tabs unaffected; switching CV ↔ PDF ↔ text tools; #cv-builder deep link', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await page.locator('#tab-cv').click();
    await page.locator('#tab-humanize').click();                                                  // existing tab
    await expect(page.locator('#tab-humanize')).toHaveClass(/active/);
    await expect(page.locator('#humanizeWrap')).toBeVisible();
    await expect(page.locator('#pfHomeCv')).toBeHidden();
    await expect(page.locator('#tab-cv')).not.toHaveClass(/active/);
    // CV → PDF → CV: only one extra panel at a time
    await page.locator('#tab-cv').click();
    await page.locator('#tab-pdf').click();
    await expect(page.locator('#pfHomeCv')).toBeHidden();
    await expect(page.locator('#pfHomePdf')).toBeVisible();
    await expect(page.locator('#tab-cv')).not.toHaveClass(/active/);
    await page.locator('#tab-cv').click();
    await expect(page.locator('#pfHomePdf')).toBeHidden();
    await expect(page.locator('#pfHomeCv')).toBeVisible();
    await expect(page.locator('.tool-tabs .tool-tab.active')).toHaveCount(1);
    // back to an existing tab restores it (the humanizer was the last one used)
    await page.locator('#tab-summarize').click();
    await expect(page.locator('#summarizeWrap')).toBeVisible();
    await expect(page.locator('.tool-tabs .tool-tab.active')).toHaveCount(1);
    // deep link
    await page.goto('about:blank');
    await page.goto('/#cv-builder');
    await expect(page.locator('#pfHomeCv')).toBeVisible();
    await expect(page.locator('#tab-cv')).toHaveClass(/active/);
  });

  test('360px: CV tab open, no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await setup(page);
    await page.goto('/');
    await page.locator('#tab-cv').click();
    await expect(page.locator('#pfHomeCv')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const b = await page.locator('#pfCvStart').boundingBox();
    expect(b!.x + b!.width).toBeLessThanOrEqual(360);
  });
});
