// The real CV builder inside the homepage "CV Builder" tab (cv-builder.html?embed=1 in a lazy iframe).
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk);
// /api/process is MOCKED (Jooble job search included); GA, ads, fonts and photos are BLOCKED; CDN
// libraries are cached on disk after the first run.
// Run: npx playwright test tests/cv-embed.spec.ts
import { test, expect, Page, Route, Frame } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
const JOBS = [{ title: 'Data Analyst', company: 'Acme Analytics', location: 'Sydney', link: 'https://example.com/j/1', snippet: 'SQL and dashboards' }];

test.setTimeout(180000);

// cv-builder.html as it was before embed mode: the added block removed, the old GA line back.
function originalCvBuilder() {
  const s = fs.readFileSync(path.join(ROOT, 'cv-builder.html'), 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('<!-- EMBED MODE (?embed=1)'), b = s.indexOf('</head>');
  expect(a, 'embed block present').toBeGreaterThan(0);
  const ga = "  // ?embed=1 (inside the homepage CV Builder tab): the homepage already sent the page view\n" +
    "  if (/[?&]embed=1(&|$)/.test(location.search)) gtag('config', 'G-0QEEGS0DZQ', { send_page_view: false });\n" +
    "  else gtag('config', 'G-0QEEGS0DZQ');";
  expect(s.includes(ga), 'GA embed line present').toBe(true);
  return (s.slice(0, a) + s.slice(b)).replace(ga, "  gtag('config', 'G-0QEEGS0DZQ');");
}

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
  const requests: string[] = [];
  const apiCalls: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(CDN, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.type === 'jobSearch' ? { jobs: JOBS, source: 'live' } : { success: false }) });
    }
    if (url.pathname === '/cv-builder-original.html') return route.fulfill({ status: 200, contentType: 'text/html', body: originalCvBuilder() });
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { requests, apiCalls, errors };
}

async function openCvTab(page: Page): Promise<Frame> {
  await page.locator('#tab-cv').click();
  await expect(page.locator('#pfCvFrame')).toHaveCount(1);
  await expect(page.locator('#pfCvLoading')).toHaveCount(0, { timeout: 60000 });
  const frame = page.frame({ url: /cv-builder\.html\?embed=1/ })!;
  await frame.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
  return frame;
}
const dataLayer = (f: Page | Frame) => f.evaluate(() => ((window as any).dataLayer || []).map((a: any) => Array.from(a)).map((a: any[]) => JSON.parse(JSON.stringify(a))));
const sizes = (page: Page, frame: Frame) => Promise.all([
  page.evaluate(() => { const f = document.getElementById('pfCvFrame')!; return { frameH: f.offsetHeight, top: Math.round(f.getBoundingClientRect().top), pageW: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight }; }),
  frame.evaluate(() => ({ scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight, scrollY: scrollY })),
]).then(([o, i]) => ({ ...o, ...i }));

// ─────────────────────────────────────────────────────────────
test.describe('homepage CV Builder tab (embedded builder)', () => {
  test('homepage load fetches nothing from the CV builder', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(5000);                                  // past the idle prefetch too
    expect(net.requests.filter((u) => /cv-builder/.test(u))).toEqual([]);
    await expect(page.locator('#pfCvFrame')).toHaveCount(0);
  });

  test('tab click creates the iframe; embed mode shows only the builder; one page view; homepage globals untouched', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.evaluate(() => { const w = window as any; w.__libs = ['pdfjsLib', 'jspdf', 'JSZip', 'Tesseract', 'docx', 'mammoth', 'PptxGenJS', 'PFEvents', 'gtag'].map((k) => [k, w[k]]); });
    await expect(page.locator('#pfHomeCv a', { hasText: 'Open full CV Builder ↗' })).toHaveAttribute('href', '/cv-builder.html');
    const frame = await openCvTab(page);
    expect(await page.locator('#pfCvFrame').getAttribute('src')).toBe('/cv-builder.html?embed=1');
    expect(await page.locator('#pfCvFrame').getAttribute('sandbox')).toBeNull();
    const shown = await frame.evaluate(() => {
      const vis = (sel: string) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; };
      return { embed: document.documentElement.classList.contains('pf-embed'), nav: vis('body > nav'), hero: vis('.cv-hero'), footer: vis('body > footer'),
        marketing: vis('#best-free-cv-builder'), scrollTop: vis('#pf-scroll-top'), builder: vis('#cvFormPanel'), tabs: vis('.cv-tabs'),
        canonical: document.querySelector('link[rel=canonical]')!.getAttribute('href'), robots: [...document.querySelectorAll('meta[name=robots]')].map((m) => m.getAttribute('content')) };
    });
    expect(shown).toEqual({ embed: true, nav: false, hero: false, footer: false, marketing: false, scrollTop: false, builder: true, tabs: true,
      canonical: 'https://parafree.app/cv-builder.html', robots: ['index, follow', 'noindex, follow'] });
    // GA: the embedded page does not send a second page view; the homepage records the tab click
    const configs = (await dataLayer(frame)).filter((a) => a[0] === 'config');
    expect(configs).toEqual([['config', 'G-0QEEGS0DZQ', { send_page_view: false }]]);
    expect((await dataLayer(page)).filter((a) => a[0] === 'event').map((a) => a[1])).toContain('cv_tab_click');
    // the iframe has its own window: nothing on the homepage changed
    expect(await page.evaluate(() => (window as any).__libs.every(([k, v]: [string, any]) => (window as any)[k] === v))).toBe(true);
    expect(await frame.evaluate(() => window.parent !== window && window.parent.location.pathname === '/')).toBe(true);
    // other tabs still work and the homepage text tools come back
    await page.locator('#tab-paraphrase').click();
    await expect(page.locator('#pfHomeCv')).toBeHidden();
    await expect(page.locator('.tool-container')).toBeVisible();
    expect(net.errors).toEqual([]);
  });

  // The CV itself downloads as PDF (on the full page too, "Word" for the CV only shows a hint to use PDF);
  // the cover letter downloads as PDF and DOCX. Both work inside the embed.
  test('a CV can be filled and downloaded (CV PDF; cover letter PDF + DOCX) inside the embed; events unchanged', async ({ page }) => {
    const net = await setup(page);
    await page.route('https://parafree.app/api/process', (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      net.apiCalls.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.type === 'cover_letter'
        ? { success: true, result: ['I would love to bring my analysis skills to your team.', 'I have built many dashboards.', 'I look forward to talking.'].join('\n\n') }
        : body.type === 'jobSearch' ? { jobs: JOBS, source: 'live' } : { success: false }) });
    });
    await page.goto('/');
    const frame = await openCvTab(page);
    await frame.fill('#f-name', 'Alice Embedded');
    await frame.fill('#f-jobtitle', 'Data Analyst');
    const pdfDl = page.waitForEvent('download', { timeout: 90000 });
    await frame.evaluate(() => (window as any).downloadPDF());
    const pdf = await pdfDl;
    expect(pdf.suggestedFilename()).toMatch(/\.pdf$/i);
    expect(fs.readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
    // cover letter (its own tab, as a user would): generate (mocked AI), then PDF + DOCX
    await frame.evaluate(() => (window as any).switchTab('cover'));
    await frame.evaluate(() => {
      (document.getElementById('clCompany') as HTMLInputElement).value = 'Acme Analytics';
      (document.getElementById('clJobTitle') as HTMLInputElement).value = 'Data Analyst';
    });
    await frame.evaluate(() => (window as any).generateCoverLetter());
    const clPdf = page.waitForEvent('download', { timeout: 90000 });
    await frame.evaluate(() => (window as any).downloadCLasPDF());
    expect((await clPdf).suggestedFilename()).toMatch(/\.pdf$/i);
    const clDoc = page.waitForEvent('download', { timeout: 90000 });
    await frame.evaluate(() => (window as any).downloadCLasDOCX());
    const docx = await clDoc;
    expect(docx.suggestedFilename()).toMatch(/\.docx$/i);
    const xml = await (await JSZip.loadAsync(fs.readFileSync((await docx.path())!))).file('word/document.xml')!.async('string');
    expect(xml).toContain('bring my analysis skills');
    // CV events fire as on the full page, with the allow-listed params only (no extra "surface")
    const ev = (await dataLayer(frame)).filter((a) => a[0] === 'event');
    const cv = ev.filter((a) => a[1] === 'cv_download').map((a) => a[2]);
    expect(cv).toEqual([{ template: 'classic', format: 'pdf' }]);
    expect(ev.filter((a) => a[1] === 'cover_letter_download').map((a) => a[2])).toEqual([{ format: 'pdf' }, { format: 'docx' }]);
    expect(net.errors).toEqual([]);
  });

  test('job search works inside the embed (mocked Jooble) and the frame grows with the results', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const net = await setup(page);
    await page.goto('/');
    const frame = await openCvTab(page);
    await frame.evaluate(() => { clearTimeout((window as any)._jobAutoTimer); });
    await frame.fill('#f-jobtitle', 'Data Analyst');
    await frame.evaluate(() => (window as any).runJobSearch());
    await expect(frame.locator('#jobListingsArea')).toContainText('Acme Analytics', { timeout: 30000 });
    expect(net.apiCalls.filter((c) => c.type === 'jobSearch').length).toBeGreaterThanOrEqual(1);
    expect((await dataLayer(frame)).filter((a) => a[0] === 'event' && a[1] === 'job_search').map((a) => a[2])).toContainEqual({ has_results: true });
    await expect.poll(async () => { const s = await sizes(page, frame); return Math.abs(s.frameH - s.scrollH) <= 2 && s.scrollH <= s.clientH + 1; }, { timeout: 10000 }).toBe(true);
  });

  for (const [w, h] of [[1280, 800], [360, 780]]) {
    test(`${w}px: frame height follows the builder — no inner scrollbar, no horizontal page scroll`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await setup(page);
      await page.goto('/');
      const frame = await openCvTab(page);
      await expect.poll(async () => { const s = await sizes(page, frame); return Math.abs(s.frameH - s.scrollH) <= 2; }, { timeout: 15000 }).toBe(true);
      const s = await sizes(page, frame);
      expect(s.scrollH, 'iframe document fits the frame').toBeLessThanOrEqual(s.clientH + 1);
      expect(s.pageW).toBeLessThanOrEqual(w);
      if (w <= 900) {
        // phone: the builder is a full-screen app, exactly one screen below the homepage nav
        expect(s.frameH).toBe(h - 68);
        // the frame only partly on screen: a tap on the builder brings it fully into view (top under the nav)…
        await page.evaluate(() => { const f = document.getElementById('pfCvFrame')!; scrollTo(0, f.getBoundingClientRect().top + scrollY - 400); });
        await expect.poll(async () => (await sizes(page, frame)).top).toBe(400);
        await page.mouse.click(w / 2, 480);
        await expect.poll(async () => (await sizes(page, frame)).top, { timeout: 10000 }).toBe(68);
        // …so its toolbar is reachable; the Edit sheet opens on screen
        const btn = await frame.evaluate(() => { const r = document.getElementById('ctb-edit')!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.click(btn.x, 68 + btn.y);
        await expect(frame.locator('#bottomSheet')).toBeInViewport();
        expect((await sizes(page, frame)).top).toBe(68);
        // the homepage's floating buttons don't cover the builder's toolbar
        await expect(page.locator('#pf-scroll-top')).toBeHidden();
      } else {
        // desktop: the builder's panels are sized from the homepage's screen, as on the full page
        const panel = await frame.evaluate(() => Math.round(document.getElementById('cvFormPanel')!.getBoundingClientRect().height));
        expect(panel).toBe(h - 68 - 24);
      }
    });
  }

  test('switching away and back keeps what was typed (one iframe, created once)', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    let frame = await openCvTab(page);
    await frame.fill('#f-name', 'Kept Name');
    await page.locator('#tab-pdf').click();
    await page.locator('#tab-cv').click();
    await expect(page.locator('#pfCvFrame')).toHaveCount(1);
    frame = page.frame({ url: /embed=1/ })!;
    expect(await frame.inputValue('#f-name')).toBe('Kept Name');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('cv-builder.html without ?embed=1 is unchanged', () => {
  test('same layout and GA calls as before embed mode', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    const snapshot = async (url: string) => {
      await page.goto(url);
      await page.waitForLoadState('load');
      await page.waitForTimeout(1500);
      return page.evaluate(() => ({
        embed: document.documentElement.classList.contains('pf-embed'),
        robots: [...document.querySelectorAll('meta[name=robots]')].map((m) => m.getAttribute('content')),
        layout: [...document.body.children].filter((el) => !/^(SCRIPT|STYLE)$/.test(el.tagName)).map((el) => {
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          return `${el.tagName}#${el.id} ${cs.display} ${cs.position} ${Math.round(r.height)}`;
        }),
        height: document.documentElement.scrollHeight,
        panels: ['#cvFormPanel', '#cvPreviewPanel'].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().height)),
        config: ((window as any).dataLayer || []).map((a: any) => Array.from(a)).filter((a: any[]) => a[0] === 'config').map((a: any[]) => a.length),
      }));
    };
    const now = await snapshot('/cv-builder.html');
    const before = await snapshot('/cv-builder-original.html');
    expect(now).toEqual(before);
    expect(now.embed).toBe(false);
    expect(now.config).toEqual([2]);                                   // gtag('config', id) — page view sent as before
    await expect(page.locator('body > nav')).toBeVisible();
  });
});
