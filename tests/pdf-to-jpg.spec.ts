// PDF to JPG: the tool (lib/pdf-tools/pdf-to-jpg.js) on its landing page, pdf-tools.html and the homepage PDF tab,
// plus the page's SEO bits. Pages are served from THIS checkout; /api/* must never be called (answered 500 and
// recorded); GA, ads and fonts are BLOCKED; CDN libraries are cached on disk.
// Run (one file at a time, low memory): npx playwright test tests/pdf-to-jpg.spec.ts --workers=1
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
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
const TITLE = 'Free PDF to JPG Converter — Convert PDF Pages to Images | No Signup';
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
test.setTimeout(180000);

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
  const net = { api: [] as string[], errors: [] as string[], requests: [] as { url: string; method: string; body: number }[] };
  page.on('pageerror', (e) => net.errors.push(String(e)));
  ctx.on('request', (r) => net.requests.push({ url: r.url(), method: r.method(), body: (r.postDataBuffer() || Buffer.alloc(0)).length }));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) { net.api.push(url.pathname); return route.fulfill({ status: 500, body: '{"error":"api must not be called"}' }); }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return net;
}
const panel = (page: Page) => page.locator('#panel-pdf-to-jpg');
const role = (p: Locator, r: string) => p.locator(`[data-role="${r}"]`);
async function ready(page: Page) { await expect(role(panel(page), 'lib-status')).toHaveText('Ready', { timeout: 60000 }); }
async function choose(page: Page, file: string, pages: number) {
  const p = panel(page);
  await p.locator('input[type=file]').setInputFiles(file);
  await expect(p.locator('.pf-thumb')).toHaveCount(pages, { timeout: 60000 });
  return p;
}
async function download(page: Page, button: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync((await d.path())!) };
}
// decode an image in the page → its size (proves it is a real, readable image)
const imgSize = (page: Page, buf: Buffer, type: string) => page.evaluate(async ([b64, t]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: t }));
  return { w: bm.width, h: bm.height };
}, [buf.toString('base64'), type]);
// expected pixel width of a page at a DPI, from the page's real size (pdf.js, in the page)
const expectedWidth = (page: Page, file: string, n: number, dpi: number) => page.evaluate(async ([b64, n, dpi]) => {
  const lib = await (window as any).PFLoad.pdfjs();
  const doc = await lib.getDocument((window as any).PFLoad.pdfjsOptions(Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0)))).promise;
  const w = (await doc.getPage(n)).getViewport({ scale: (dpi as number) / 72 }).width;
  doc.destroy();
  return Math.floor(w);
}, [fs.readFileSync(file).toString('base64'), n, dpi] as const);
const isJpg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const gaEvents = (page: Page) => page.evaluate(() => ((window as any).dataLayer || []).map((a: any) => Array.from(a))
  .filter((a: any[]) => a[0] === 'event').map((a: any[]) => JSON.parse(JSON.stringify([a[1], a[2]]))));

// ─────────────────────────────────────────────────────────────
test.describe('PDF to JPG — the tool', () => {
  test('landing page opens with the tool; one page → a valid JPG (name-p2.jpg, 150 DPI); GA events; nothing uploaded', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/pdf-to-jpg.html');
    await expect(page).toHaveTitle(TITLE);
    await expect(panel(page)).toBeVisible();
    await ready(page);
    const p = await choose(page, fx('three-pages.pdf'), 3);
    await expect(role(p, 'sel-count')).toHaveText('3 of 3 pages selected');
    await expect(role(p, 'go')).toHaveText('Convert 3 pages to JPG');
    await role(p, 'range').fill('2');
    await expect(role(p, 'sel-count')).toHaveText('1 of 3 pages selected');
    await expect(p.locator('.pf-thumb-on')).toHaveCount(1);
    await expect(p.locator('.pf-thumb[data-page="2"]')).toHaveClass(/pf-thumb-on/);
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 60000 });
    await expect(role(p, 'summary')).toContainText('Page 2 → JPG, 150 DPI');
    await expect(role(p, 'links').locator('li')).toHaveCount(0);
    const out = await download(page, role(p, 'dl-main'));
    expect(out.name).toBe('three-pages-p2.jpg');
    expect(isJpg(out.buf)).toBe(true);
    const size = await imgSize(page, out.buf, 'image/jpeg');
    expect(size.w).toBe(await expectedWidth(page, fx('three-pages.pdf'), 2, 150));
    const ev = await gaEvents(page);
    expect(ev).toContainEqual(['tool_used', { tool: 'pdf_to_jpg', input_type: 'pdf' }]);
    expect(ev).toContainEqual(['result_download', { tool: 'pdf_to_jpg', format: 'jpg' }]);
    // privacy: no API call and no request carries a body (the PDF never leaves the page)
    expect(net.api).toEqual([]);
    expect(net.requests.filter((r) => r.method !== 'GET' || r.body > 0)).toEqual([]);
    expect(net.requests.filter((r) => /three-pages/.test(r.url) && !r.url.startsWith('blob:'))).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('several pages → one ZIP with the images in page order, plus a link per page; thumbnails toggle', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/pdf-to-jpg.html');
    await ready(page);
    const p = await choose(page, fx('three-pages.pdf'), 3);
    await p.locator('.pf-thumb[data-page="2"]').click();                // unselect page 2
    await expect(role(p, 'range')).toHaveValue('1, 3');
    await expect(role(p, 'go')).toHaveText('Convert 2 pages to JPG');
    await p.locator('.pf-thumb[data-page="2"]').click();                // and back
    await expect(role(p, 'range')).toHaveValue('');                     // all pages selected again
    await role(p, 'opt-quality').selectOption('low');
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 90000 });
    await expect(role(p, 'summary')).toContainText('3 pages → JPG, 100 DPI');
    await expect(role(p, 'links').locator('a')).toHaveText([/^Page 1 · /, /^Page 2 · /, /^Page 3 · /]);
    const out = await download(page, role(p, 'dl-main'));
    expect(out.name).toBe('three-pages-images.zip');
    const zip = await JSZip.loadAsync(out.buf);
    const names = Object.keys(zip.files);
    expect(names).toEqual(['three-pages-p1.jpg', 'three-pages-p2.jpg', 'three-pages-p3.jpg']);
    for (const n of names) {
      const b = Buffer.from(await zip.file(n)!.async('uint8array'));
      expect(isJpg(b), n).toBe(true);
      const s = await imgSize(page, b, 'image/jpeg');
      expect(s.w, n).toBe(await expectedWidth(page, fx('three-pages.pdf'), names.indexOf(n) + 1, 100));
    }
    // a single page from its own link
    const [d] = await Promise.all([page.waitForEvent('download'), role(p, 'links').locator('a').nth(1).click()]);
    expect(d.suggestedFilename()).toBe('three-pages-p2.jpg');
    const ev = await gaEvents(page);
    expect(ev).toContainEqual(['result_download', { tool: 'pdf_to_jpg', format: 'zip' }]);
    expect(ev).toContainEqual(['result_download', { tool: 'pdf_to_jpg', format: 'jpg' }]);
    expect(net.requests.filter((r) => r.method !== 'GET' || r.body > 0)).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('PNG option: one page → PNG; two pages → ZIP of PNGs', async ({ page }) => {
    await setup(page);
    await page.goto('/pdf-to-jpg.html');
    await ready(page);
    const p = await choose(page, fx('two-pages.pdf'), 2);
    await role(p, 'opt-format').selectOption('png');
    await role(p, 'opt-quality').selectOption('high');
    await expect(role(p, 'go')).toHaveText('Convert 2 pages to PNG');
    await role(p, 'range').fill('1');
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('Page 1 → PNG, 220 DPI', { timeout: 60000 });
    const one = await download(page, role(p, 'dl-main'));
    expect(one.name).toBe('two-pages-p1.png');
    expect(isPng(one.buf)).toBe(true);
    const s = await imgSize(page, one.buf, 'image/png');
    expect(s.w).toBe(await expectedWidth(page, fx('two-pages.pdf'), 1, 220));
    await role(p, 'sel-all').click();
    await role(p, 'go').click();
    await expect(role(p, 'summary')).toContainText('2 pages → PNG', { timeout: 60000 });
    const out = await download(page, role(p, 'dl-main'));
    const zip = await JSZip.loadAsync(out.buf);
    expect(Object.keys(zip.files)).toEqual(['two-pages-p1.png', 'two-pages-p2.png']);
    for (const n of Object.keys(zip.files)) expect(isPng(Buffer.from(await zip.file(n)!.async('uint8array'))), n).toBe(true);
    expect((await gaEvents(page))).toContainEqual(['result_download', { tool: 'pdf_to_jpg', format: 'zip' }]);
  });

  test('page-range parsing (and the range box in the UI)', async ({ page }) => {
    await setup(page);
    await page.goto('/pdf-to-jpg.html');
    await ready(page);
    const r = await page.evaluate(() => {
      const T = (window as any).PFTools['pdf-to-jpg'];
      const ok = (s: string, max: number) => { try { return T.parseRange(s, max); } catch (e: any) { return 'ERR ' + e.message; } };
      return {
        a: ok('1-3, 5', 9), b: ok(' 5-3 ', 9), c: ok('2,2, 1', 9), d: ok('1–2; 4', 9), e: ok('7', 9),
        zero: ok('0', 9), big: ok('1-12', 9), word: ok('two', 9), empty: ok('  ', 9), dash: ok('3-', 9),
        fmt: [T.formatRange([1, 2, 3, 5]), T.formatRange([2]), T.formatRange([1, 3, 4, 5, 9])],
      };
    });
    expect(r.a).toEqual([1, 2, 3, 5]);
    expect(r.b).toEqual([3, 4, 5]);
    expect(r.c).toEqual([1, 2]);
    expect(r.d).toEqual([1, 2, 4]);
    expect(r.e).toEqual([7]);
    expect(r.zero).toBe('ERR Pages start at 1.');
    expect(r.big).toBe('ERR This PDF has 9 pages, so page 12 doesn’t exist.');
    expect(r.word).toMatch(/^ERR “two” isn’t a page number or range/);
    expect(r.empty).toMatch(/^ERR Type the pages you want/);
    expect(r.dash).toMatch(/^ERR “3-” isn’t a page number or range/);
    expect(r.fmt).toEqual(['1-3, 5', '2', '1, 3-5, 9']);
    const p = await choose(page, fx('three-pages.pdf'), 3);
    await role(p, 'range').fill('2-3');
    await expect(role(p, 'sel-count')).toHaveText('2 of 3 pages selected');
    await role(p, 'range').fill('2-8');                                 // invalid: message, selection unchanged
    await expect(role(p, 'range-error')).toHaveText('This PDF has 3 pages, so page 8 doesn’t exist.');
    await expect(role(p, 'sel-count')).toHaveText('2 of 3 pages selected');
    await role(p, 'sel-none').click();
    await expect(role(p, 'go')).toBeDisabled();
    await expect(role(p, 'range-error')).toBeHidden();
  });

  test('errors: password-protected PDF, over 50 MB, over 300 pages, not a PDF — clear messages and tool_error', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/pdf-to-jpg.html');
    await ready(page);
    const p = panel(page);
    await p.locator('input[type=file]').setInputFiles(fx('encrypted.pdf'));
    await expect(role(p, 'error')).toContainText('"encrypted.pdf" is password-protected (encrypted). Please remove the password first', { timeout: 30000 });
    await expect(p.locator('.pf-thumb')).toHaveCount(0);
    await expect(role(p, 'go')).toBeDisabled();
    const big = Buffer.alloc(51 * 1000 * 1000, 0x20); big.write('%PDF-1.4\n');
    await p.locator('input[type=file]').setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: big });
    await expect(role(p, 'error')).toHaveText('"huge.pdf" is 51.0 MB. The limit is 50 MB per file — try compressing it first or splitting it.');
    await p.locator('input[type=file]').setInputFiles(fx('pages-301.pdf'));
    await expect(role(p, 'error')).toHaveText('"pages-301.pdf" has 301 pages. This tool handles up to 300 pages at a time — try splitting it into smaller parts.', { timeout: 30000 });
    await p.locator('input[type=file]').setInputFiles(fx('photo.jpg'));
    await expect(role(p, 'error')).toContainText('Please choose a PDF file (.pdf).');
    const errs = (await gaEvents(page)).filter((e) => e[0] === 'tool_error').map((e) => e[1]);
    expect(errs).toEqual([
      { tool: 'pdf_to_jpg', error_type: 'encrypted' }, { tool: 'pdf_to_jpg', error_type: 'too_large' },
      { tool: 'pdf_to_jpg', error_type: 'too_many_pages' }, { tool: 'pdf_to_jpg', error_type: 'unsupported' }]);
    // a good file after errors works, and "Start over" clears everything
    await choose(page, fx('two-pages.pdf'), 2);
    await expect(role(p, 'error')).toBeHidden();
    await role(p, 'start-over').click();
    await expect(p.locator('.pf-thumb')).toHaveCount(0);
    await expect(role(p, 'select-row')).toBeHidden();
    expect(net.api).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('PDF to JPG — everywhere the PDF tools are', () => {
  test('homepage PDF tab: nothing of PDF to JPG loads until its sub-tab is opened; then it converts', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(4500);                                    // past the idle prefetch
    // (the homepage has its own JSZip from cdnjs; the PDF tools' copy comes from jsDelivr)
    expect(net.requests.filter((r) => /\/lib\/pdf-tools\/pdf-to-jpg|cdn\.jsdelivr\.net\/npm\/jszip/.test(r.url))).toEqual([]);
    await page.locator('#tab-pdf').click();
    await expect(page.locator('#pfHomePdf [data-pftab="pdf-to-jpg"]')).toHaveText('🖼 PDF to JPG');
    await expect(page.locator('#panel-pdf-to-word')).toBeVisible({ timeout: 60000 });
    expect(net.requests.filter((r) => /pdf-to-jpg/.test(r.url))).toEqual([]);
    await page.locator('#pfHomePdf [data-pftab="pdf-to-jpg"]').click();
    await expect(panel(page)).toBeVisible();
    await ready(page);
    const mod = net.requests.filter((r) => /\/lib\/pdf-tools\/pdf-to-jpg\.js/.test(r.url));
    expect(mod.length).toBe(1);
    expect(mod[0].url).toMatch(/\?v=[0-9a-f]{10}$/);                    // versioned like the other modules
    expect(page.url()).toMatch(/#pdf-to-jpg$/);
    await expect(page.locator('#pfHomePdf .pf-home-full')).toHaveAttribute('href', '/pdf-tools.html#pdf-to-jpg');
    const p = await choose(page, fx('two-pages.pdf'), 2);
    await role(p, 'range').fill('2');
    await role(p, 'go').click();
    const out = await download(page, role(p, 'dl-main'));
    expect(out.name).toBe('two-pages-p2.jpg');
    expect(isJpg(out.buf)).toBe(true);
    // the paraphraser's own tools are untouched
    await page.locator('#tab-paraphrase').click();
    await expect(page.locator('.tool-container')).toBeVisible();
    expect(net.requests.filter((r) => r.method !== 'GET' && !/\/api\/process/.test(r.url))).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('pdf-tools.html: tab #pdf-to-jpg, hub link; other tabs still work', async ({ page }) => {
    await setup(page);
    await page.goto('/pdf-tools.html#pdf-to-jpg');
    await expect(page.locator('#tab-pdf-to-jpg')).toHaveText('🖼 PDF to JPG');
    await expect(page.locator('#tab-pdf-to-jpg')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toBeVisible();
    await ready(page);
    await expect(page.locator('.pf-hub-links a[href="/pdf-to-jpg.html"]')).toContainText('PDF to JPG');
    await choose(page, fx('two-pages.pdf'), 2);
    await page.locator('#tab-merge-pdf').click();                       // leaving clears its state
    await expect(page.locator('#panel-merge-pdf')).toBeVisible();
    await page.locator('#tab-pdf-to-jpg').click();
    await expect(panel(page).locator('.pf-thumb')).toHaveCount(0);
    expect(await page.locator('.tool-tab[data-tab]').count()).toBe(6);
  });

  test('landing page: title, one H1, JSON-LD (WebApplication price 0, FAQPage = visible FAQ, BreadcrumbList), no ratings, honest copy, 900–1,200 words', async () => {
    const s = read('pdf-to-jpg.html');
    expect(s).toContain(`<title>${TITLE.replace(/&/g, '&amp;')}</title>`);
    expect(s).toContain('<body data-pf-tool="pdf-to-jpg">');
    expect(s).toContain('<link rel="canonical" href="https://parafree.app/pdf-to-jpg.html">');
    expect(s.match(/<h1[\s>]/g)!.length).toBe(1);
    const ld = [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    expect(ld.map((x) => x['@type'])).toEqual(['WebApplication', 'FAQPage', 'BreadcrumbList']);
    expect(ld[0].offers.price).toBe('0');
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|ratingValue/);
    const visibleQ = [...s.matchAll(/<p class="faq-q">([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
    expect(ld[1].mainEntity.map((q: any) => q.name)).toEqual(visibleQ);
    expect(ld[2].itemListElement.map((i: any) => i.item)).toEqual(['https://parafree.app/', 'https://parafree.app/pdf-tools.html', 'https://parafree.app/pdf-to-jpg.html']);
    const body = s.split('<main class="pf-tools">')[1].split('<footer')[0].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ');
    const words = body.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(900);
    expect(words).toBeLessThanOrEqual(1200);
    for (const re of [/\bbest\b/i, /#1/, /\bonly\b/i, /quillbot|ilovepdf|smallpdf|adobe|sejda|zety|\bcanva\b|novoresume/i]) expect(body.match(re)?.[0], String(re)).toBeUndefined();
    for (const use of ['WhatsApp', 'PowerPoint', 'Word', 'slides', 'upload']) expect(body, use).toContain(use);
  });

  test('links: related tools on every PDF landing page; "PDF Tools:" footer on every page that has one; sitemap; llms', () => {
    for (const t of ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf']) {
      const s = read(`${t}.html`);
      expect(s, t).toContain('<a href="/pdf-to-jpg.html">🖼 PDF to JPG</a>');            // related tools
    }
    expect(read('pdf-to-jpg.html')).not.toContain('<a href="/pdf-to-jpg.html">🖼 PDF to JPG</a>');
    const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && /PDF Tools:<\/span>/.test(read(f)));
    expect(pages.length).toBeGreaterThanOrEqual(15);
    for (const f of pages) {
      const s = read(f), i = s.search(/PDF Tools:<\/span>/), group = s.slice(i, s.indexOf('</div>', i));
      expect(i, f).toBeGreaterThan(0);
      expect(group, f).toContain('href="/pdf-to-jpg.html"');
      expect(group, f).toContain('href="/merge-pdf.html"');
    }
    const sm = read('sitemap.xml');
    expect(sm).toMatch(/<url>\s*<loc>https:\/\/parafree\.app\/pdf-to-jpg\.html<\/loc>\s*<lastmod>2026-10-22<\/lastmod>/);
    const locs = [...sm.matchAll(/<loc>https:\/\/parafree\.app\/([^<]*)<\/loc>/g)].map((m) => m[1] || 'index.html');
    expect(new Set(locs).size).toBe(locs.length);
    for (const l of locs) expect(fs.existsSync(path.join(ROOT, l)), l).toBe(true);
    expect((sm.match(/<url>/g) || []).length).toBe((sm.match(/<\/url>/g) || []).length);
    expect(read('llms.txt')).toContain('[PDF to JPG](https://parafree.app/pdf-to-jpg.html)');
    expect(read('llms-full.txt')).toContain('| PDF to JPG | https://parafree.app/pdf-to-jpg.html |');
    const home = read('index.html');
    expect(home).toContain('"PDF to JPG https://parafree.app/pdf-to-jpg.html"');
    for (const m of home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(() => JSON.parse(m[1])).not.toThrow();
  });
});
