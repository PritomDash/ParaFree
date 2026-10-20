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

// cv-builder.html as it is on main (before the PDF text layer) — to compare the PDF page images
function mainCvBuilder() {
  return require('child_process').execSync('git show main:cv-builder.html', { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8');
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
    if (url.pathname === '/cv-builder-main.html') return route.fulfill({ status: 200, contentType: 'text/html', body: mainCvBuilder() });
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

// ─────────────────────────────────────────────────────────────
const SIZES: [number, number][] = [[1528, 651], [1280, 720], [1024, 768], [390, 844], [360, 740]];
// visible pixels of the bottom sheet inside the viewport of its own document
const sheetVisiblePx = (f: Page | Frame) => f.evaluate(() => {
  const el = document.getElementById('bottomSheet')!, cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) : 0;
});
const useThisHit = (f: Page | Frame) => f.evaluate(() => {
  const e = document.getElementById('carUse')!, b = e.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return { ok: !!hit && (hit === e || e.contains(hit)), hit: hit ? (hit.id || hit.tagName) : null, x: b.left + b.width / 2, y: b.top + b.height / 2 };
});

test.describe('template bar + bottom sheet', () => {
  for (const [w, h] of SIZES) {
    test(`full page ${w}×${h}: "Use This" is clickable; the closed sheet shows no pixels`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await setup(page);
      await page.goto('/cv-builder.html');
      await expect(page.locator('#carouselControls')).toBeVisible({ timeout: 30000 });
      await page.locator('#carUse').scrollIntoViewIfNeeded();
      expect(await sheetVisiblePx(page)).toBe(0);
      const r = await useThisHit(page);
      expect(r.ok, `elementFromPoint → ${r.hit}`).toBe(true);
      if (w >= 901) await expect(page.locator('#bottomSheet')).toBeHidden();
    });

    test(`embed ${w}×${h}: "Use This" is clickable through the homepage; the closed sheet shows no pixels`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await setup(page);
      await page.goto('/');
      const frame = await openCvTab(page);
      await expect(frame.locator('#carouselControls')).toBeVisible({ timeout: 30000 });
      // bring the button on screen the way a user would (app mode: the frame fills the screen under the nav)
      const app = await frame.evaluate(() => matchMedia('(max-width: 900px)').matches);
      await page.evaluate(async (isApp) => {
        const f = document.getElementById('pfCvFrame') as HTMLIFrameElement;
        const b = f.contentDocument!.getElementById('carUse')!.getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        const target = isApp ? fr.top + scrollY - 68 : fr.top + scrollY + b.top + b.height / 2 - innerHeight / 2;
        scrollTo({ top: Math.max(0, target), behavior: 'instant' as ScrollBehavior });      // the homepage scrolls smoothly by default
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, app);
      const inner = await useThisHit(frame);
      expect(inner.ok, `inside the frame elementFromPoint → ${inner.hit}`).toBe(true);
      const outer = await page.evaluate(([x, y]) => {
        const f = document.getElementById('pfCvFrame')!, fr = f.getBoundingClientRect();
        const px = fr.left + x, py = fr.top + y;
        const hit = document.elementFromPoint(px, py);
        return { onScreen: py > 68 && py < innerHeight, hitFrame: hit === f };
      }, [inner.x, inner.y]);
      expect(outer, 'on screen and not covered by anything on the homepage').toEqual({ onScreen: true, hitFrame: true });
      expect(await sheetVisiblePx(frame)).toBe(0);
    });
  }

  test('390px: the bottom sheet opens and closes (Edit, Design, Save)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await expect(page.locator('#canvaToolbar')).toBeVisible({ timeout: 30000 });
    for (const id of ['ctb-edit', 'ctb-design', 'ctb-download']) {
      await page.locator('#' + id).click();
      await expect(page.locator('#bottomSheet')).toHaveClass(/open/);
      await expect.poll(() => sheetVisiblePx(page)).toBeGreaterThan(300);
      if (id === 'ctb-download') {
        await expect(page.locator('#sheetContent')).toContainText('Download PDF');
        await expect(page.locator('#sheetContent')).not.toContainText('Word');          // CV: PDF only
      }
      await page.evaluate(() => (window as any).closeSheet());
      await expect.poll(() => sheetVisiblePx(page)).toBe(0);
      expect((await useThisHit(page)).ok, 'template bar usable again').toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────
async function fillCv(f: Page | Frame, template: string) {
  await f.evaluate((tpl) => {
    const w = window as any;
    w.setTemplate(tpl);
    if (!document.querySelector('.exp-entry')) w.addExp();
    if (!document.querySelector('.edu-entry')) w.addEdu();
    const set = (sel: string, v: string, root: ParentNode = document) => {
      const el = root.querySelector(sel) as HTMLInputElement;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#f-name', 'Jordan Rivers'); set('#f-jobtitle', 'Data Analyst'); set('#f-email', 'jordan@example.com'); set('#f-phone', '+61 400 000 000');
    set('#f-location', 'Brisbane'); set('#f-summary', 'Analyst who turns messy data into clear decisions.');
    const exp = document.querySelector('.exp-entry')!;
    set('.exp-role', 'Senior Data Analyst', exp); set('.exp-company', 'Acme Analytics', exp); set('.exp-start', '2021', exp); set('.exp-end', 'Present', exp);
    set('.exp-bullets', 'Built a churn dashboard used by 40 managers\nCut report time by 60%', exp);
    const edu = document.querySelector('.edu-entry')!;
    set('.edu-degree', 'BSc Statistics', edu); set('.edu-school', 'University of Queensland', edu); set('.edu-start', '2016', edu); set('.edu-end', '2019', edu);
    set('#f-skills', 'SQL, Python, Power BI'); set('#f-certs', 'Google Data Analytics Certificate');
  }, template);
}

test.describe('CV downloads: PDF only (cover letter keeps Word)', () => {
  test('no CV Word button, note or builder anywhere; the cover letter Word download is still there', async ({ page }) => {
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).downloadPDF === 'function');
    expect(await page.evaluate(() => ({
      docx: typeof (window as any).downloadDOCX, builder: typeof (window as any).buildCVDocxBlob,
      btn: document.querySelectorAll('#cvDocxBtn, .cv-docx-note').length,
      footer: document.getElementById('dlGrid')!.textContent!.includes('Word'),
      hint: document.body.innerHTML.includes('Use ⬇ PDF to download your CV'),
      cl: typeof (window as any).downloadCLasDOCX,
    }))).toEqual({ docx: 'undefined', builder: 'undefined', btn: 0, footer: false, hint: false, cl: 'function' });
    await expect(page.locator('text=Word version uses a clean ATS-friendly layout.')).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────
const PAGE_H = 1123;                                   // A4 at the sheet's 794px width
async function fillBigCv(f: Page | Frame, template: string, jobs = 6, bullets = 6) {
  await fillCv(f, template);
  await f.evaluate(([jobs, bullets]) => {
    const w = window as any;
    while (document.querySelectorAll('.exp-entry').length < jobs) w.addExp();
    const set = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.getElementById('f-summary') as HTMLTextAreaElement, 'Analyst with eight years of experience turning messy operational data into clear, trusted decisions for finance, sales and operations teams. ' +
      'Known for building dashboards people actually use, automating slow manual reporting, and explaining numbers to non-technical managers in plain language. ' +
      'Comfortable owning a problem end to end, from the first stakeholder interview to a production pipeline that keeps running without me.');
    document.querySelectorAll('.exp-entry').forEach((e, i) => {
      set(e.querySelector('.exp-role')!, `Role ${i + 1} Analyst`);
      set(e.querySelector('.exp-company')!, `Company ${i + 1} Pty Ltd`);
      set(e.querySelector('.exp-start')!, `${2020 - i * 2}`);
      set(e.querySelector('.exp-end')!, i ? `${2022 - i * 2}` : 'Present');
      set(e.querySelector('.exp-bullets')!, Array.from({ length: bullets }, (_, b) =>
        `Job ${i + 1} bullet ${b + 1}: delivered a measurable improvement to reporting accuracy and speed for the regional team`).join('\n'));
    });
  }, [jobs, bullets]);
  await f.waitForTimeout(400);
  await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => { (window as any).scalePreview(); requestAnimationFrame(r); })));
}
// every text line of the preview, in sheet coordinates (unscaled px)
const previewLines = (f: Page | Frame) => f.evaluate(() => {
  const pv = document.getElementById('cv-preview')!, box = pv.getBoundingClientRect(), unit = box.width / pv.offsetWidth;
  const out: { t: number; b: number; text: string }[] = [];
  const w = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT), r = document.createRange();
  let n: Node | null;
  while ((n = w.nextNode())) {
    if (!n.nodeValue!.trim()) continue;
    const el = n.parentElement!;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    r.selectNodeContents(n);
    for (const q of r.getClientRects()) if (q.height) out.push({ t: (q.top - box.top) / unit, b: (q.bottom - box.top) / unit, text: n.nodeValue!.trim().slice(0, 50) });
  }
  return { lines: out, pages: Math.round(pv.offsetHeight / 1123), sheetH: pv.offsetHeight };
});
const pageOf = (y: number) => Math.floor(y / PAGE_H);
// pages + each page's JPEG (jsPDF stores one DCT image per page)
function pdfPages(buf: Buffer) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const jpgs: string[] = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!/DCTDecode/.test(m[1])) continue;
    const len = +(/\/Length (\d+)/.exec(m[1]) || [])[1];
    jpgs.push(buf.subarray(m.index + m[0].length, m.index + m[0].length + len).toString('base64'));
  }
  return { pages, jpgs };
}
const samplePx = (page: Page, b64: string, fx: number, fy: number) => page.evaluate(async ([b64, fx, fy]) => {
  const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0);
  const d = g.getImageData(Math.round(bmp.width * (fx as number)), Math.round(bmp.height * (fy as number)), 1, 1).data;
  return { rgb: [d[0], d[1], d[2]], w: bmp.width, h: bmp.height };
}, [b64, fx, fy] as [string, number, number]);
async function downloadCvPdf(page: Page, f: Page | Frame) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), f.evaluate(() => (window as any).downloadPDF())]);
  expect(dl.suggestedFilename()).toBe('Jordan-Rivers-CV.pdf');
  return pdfPages(fs.readFileSync((await dl.path())!));
}

test.describe('multi-page CV', () => {
  for (const tpl of ['classic', 'exec-pro', 'minimal', 'modern-blue']) {
    test(`${tpl}: a long CV flows onto 2+ pages — preview, page count and PDF; no line cut at a page boundary`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const net = await setup(page);
      await page.goto('/cv-builder.html');
      await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
      await fillBigCv(page, tpl);
      const { lines, pages, sheetH } = await previewLines(page);
      expect(pages, 'pages').toBeGreaterThanOrEqual(2);
      expect(sheetH).toBe(pages * PAGE_H);                                          // whole A4 pages, nothing cut off at the end
      await expect(page.locator('#cvPageCount')).toHaveText(`${pages} pages`);
      await expect(page.locator('#cvPageCount')).toHaveAttribute('title', 'Most graduate CVs fit on 1 page; 2 pages is fine for experienced roles.');
      await expect(page.locator('#cvPreviewScale .pf-page-gap')).toHaveCount(pages - 1);
      // no text line in (or across) the 40px margins either side of a page boundary, none past the last page
      const cut = lines.filter((l) => l.b > pages * PAGE_H || Array.from({ length: pages - 1 }, (_, i) => (i + 1) * PAGE_H).some((y) => l.t < y + 30 && l.b > y - 30));
      expect(cut, 'lines at a page boundary').toEqual([]);
      for (const want of ['Job 6 bullet 6', 'Role 6 Analyst', 'BSc Statistics']) expect(lines.some((l) => l.text.includes(want)), want).toBe(true);
      // keep-together: each job title is on the same page as its company, its dates and its first bullet
      const at = (t: string) => lines.find((l) => l.text.includes(t))!;
      for (let i = 1; i <= 6; i++) {
        const role = at(`Role ${i} Analyst`);
        expect(pageOf(at(`Company ${i} Pty`).t), `company ${i}`).toBe(pageOf(role.t));
        expect(pageOf(at(`Job ${i} bullet 1:`).t), `first bullet ${i}`).toBe(pageOf(role.t));
      }
      // a section heading stays with its first entry
      const heading = lines.find((l) => /^(work\s+)?experience$|^professional experience$|^employment/i.test(l.text));
      if (heading) expect(pageOf(heading.t)).toBe(pageOf(at('Role 1 Analyst').t));
      // PDF: one real A4 page per sheet page
      const pdf = await downloadCvPdf(page, page);
      expect(pdf.pages).toBe(pages);
      expect(pdf.jpgs.length).toBe(pages);
      const px = await samplePx(page, pdf.jpgs[1], 0.5, 0.5);
      expect(Math.abs(px.h / px.w - 297 / 210)).toBeLessThan(0.01);               // A4 proportions, not stretched
      expect(fs.statSync).toBeTruthy();
      expect(net.errors).toEqual([]);
    });
  }

  test('exec-pro: the sidebar colour continues on page 2; the header is on page 1 only', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
    await fillBigCv(page, 'exec-pro');
    await page.evaluate(() => (window as any).setAccentColor('#1565c0'));
    await page.waitForTimeout(300);
    const pdf = await downloadCvPdf(page, page);
    expect(pdf.pages).toBeGreaterThanOrEqual(2);
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 30);
    const side1 = await samplePx(page, pdf.jpgs[0], 0.08, 0.7), side2 = await samplePx(page, pdf.jpgs[1], 0.08, 0.5);
    expect(near(side1.rgb, [0x15, 0x65, 0xc0]), `page 1 sidebar ${side1.rgb}`).toBe(true);
    expect(near(side2.rgb, [0x15, 0x65, 0xc0]), `page 2 sidebar ${side2.rgb}`).toBe(true);
    const main2 = await samplePx(page, pdf.jpgs[1], 0.9, 0.98);
    expect(near(main2.rgb, [255, 255, 255]), `page 2 main column ${main2.rgb}`).toBe(true);
    const { lines } = await previewLines(page);
    expect(pageOf(lines.find((l) => l.text === 'Jordan Rivers')!.t)).toBe(0);
    expect(lines.filter((l) => l.text === 'Jordan Rivers').length).toBe(1);
  });

  test('a short CV is exactly 1 page in each of the 4 templates (preview and PDF)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
    for (const tpl of ['classic', 'exec-pro', 'minimal', 'modern-blue']) {
      await fillCv(page, tpl);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { (window as any).scalePreview(); requestAnimationFrame(r); })));
      const { pages, sheetH } = await previewLines(page);
      expect(pages, tpl).toBe(1);
      expect(sheetH, tpl).toBe(PAGE_H);
      await expect(page.locator('#cvPageCount')).toHaveText('1 page');
      await expect(page.locator('#cvPreviewScale .pf-page-gap')).toHaveCount(0);
      const pdf = await downloadCvPdf(page, page);
      expect(pdf.pages, tpl).toBe(1);
    }
  });

  test('the font size is the user\'s: a long CV is not shrunk to fit', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
    const size = () => page.evaluate(() => {
      const li = [...document.querySelectorAll('#cv-preview li')].find((e) => e.textContent!.includes('bullet 1'))!;
      return getComputedStyle(li).fontSize;
    });
    await fillBigCv(page, 'classic', 1, 2);
    const short = await size();
    await fillBigCv(page, 'classic', 6, 6);
    expect(await size()).toBe(short);
  });

  test('390px: the long CV shows its pages in the phone preview', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
    await fillBigCv(page, 'modern-blue');
    const { pages } = await previewLines(page);
    expect(pages).toBeGreaterThanOrEqual(2);
    // the preview scrolls to the end of the last page, and no further
    const r = await page.evaluate(() => {
      const w = document.getElementById('cvPreviewWrapper')!, s = document.getElementById('cvPreviewScale')!;
      return { visualH: s.getBoundingClientRect().height, scrollH: w.scrollHeight };
    });
    expect(Math.abs(r.scrollH - r.visualH - 24)).toBeLessThan(4);
  });

  test('inside the homepage embed: a long CV downloads as a 2+ page PDF; the frame height still follows the page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await setup(page);
    await page.goto('/');
    const frame = await openCvTab(page);
    await fillBigCv(frame, 'exec-pro');
    const { pages } = await previewLines(frame);
    expect(pages).toBeGreaterThanOrEqual(2);
    await expect(frame.locator('#cvPageCount')).toHaveText(`${pages} pages`);
    const pdf = await downloadCvPdf(page, frame);
    expect(pdf.pages).toBe(pages);
    await expect.poll(async () => { const s = await sizes(page, frame); return Math.abs(s.frameH - s.scrollH); }, { timeout: 10000 }).toBeLessThan(3);
  });
});

// ─────────────────────────────────────────────────────────────
// PDF text layer (selectable / ATS-readable text over the page images), read back with pdf.js
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
async function readPdf(page: Page, buf: Buffer) {
  const reader = await page.context().newPage();                     // a blank tab: the homepage has its own pdf.js
  await reader.goto('about:blank');
  await reader.addScriptTag({ url: PDFJS + 'pdf.min.js' });
  const out = await reader.evaluate(async ([b64, base]) => {
    const lib = (window as any).pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
    const doc = await lib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const meta = await doc.getMetadata();
    const pages: { items: string[]; links: string[] }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      const ann = await pg.getAnnotations();
      pages.push({ items: tc.items.map((t: any) => t.str).filter((x: string) => x.trim()), links: ann.filter((a: any) => a.subtype === 'Link').map((a: any) => a.url || a.unsafeUrl) });
    }
    return { pages, title: meta.info.Title, author: meta.info.Author };
  }, [buf.toString('base64'), PDFJS] as [string, string]);
  await reader.close();
  return out;
}
async function cvPdfBuffer(page: Page, f: Page | Frame) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), f.evaluate(() => (window as any).downloadPDF())]);
  return fs.readFileSync((await dl.path())!);
}
const TL_TEMPLATES = ['classic', 'exec-pro', 'minimal', 'modern-blue'];

test.describe('PDF text layer', () => {
  for (const tpl of TL_TEMPLATES) {
    test(`${tpl}: one page — text is extractable in reading order, with links and metadata`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const net = await setup(page);
      await page.goto('/cv-builder.html');
      await page.waitForFunction(() => typeof (window as any).pfTextRuns === 'function');
      await fillCv(page, tpl);
      await page.fill('#f-linkedin', 'linkedin.com/in/jordanrivers');
      await page.waitForTimeout(300);
      const buf = await cvPdfBuffer(page, page);
      const pdf = await readPdf(page, buf);
      expect(pdf.pages.length).toBe(1);
      expect(pdf.title).toBe('Jordan Rivers — CV');
      expect(pdf.author).toBe('Jordan Rivers');
      const items = pdf.pages[0].items;
      const idx = (s: string) => {
        const i = items.findIndex((x) => x.toLowerCase().includes(s.toLowerCase()));
        expect(i, `"${s}" in the PDF text: ${JSON.stringify(items)}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      expect(items.join(' ')).not.toMatch(/(?:[A-Z] ){4,}/);                                // letter-spaced headings read as words
      for (const s of ['Jordan Rivers', 'jordan@example.com', 'Senior Data Analyst', 'Acme Analytics', '2021', 'Present', 'Built a churn dashboard used by 40 managers',
        'Cut report time by 60%', 'BSc Statistics', 'SQL', 'Python', 'Power BI']) idx(s);
      expect(items.join(' ')).not.toMatch(/�/);
      // the main column reads in order: summary → role → its bullets in order → education
      expect(idx('Analyst who turns messy data')).toBeLessThan(idx('Senior Data Analyst'));
      expect(idx('Senior Data Analyst')).toBeLessThan(idx('Built a churn dashboard'));
      expect(idx('Built a churn dashboard')).toBeLessThan(idx('Cut report time'));
      expect(idx('Cut report time')).toBeLessThan(idx('BSc Statistics'));
      if (tpl !== 'exec-pro') expect(idx('Jordan Rivers')).toBeLessThan(idx('Senior Data Analyst'));
      expect(pdf.pages[0].links).toEqual(expect.arrayContaining(['mailto:jordan@example.com', 'tel:+61400000000', 'https://linkedin.com/in/jordanrivers']));
      expect(buf.length).toBeLessThan(1024 * 1024);
      expect(net.errors).toEqual([]);
    });
  }

  test('exec-pro (sidebar): the sidebar is one block, not interleaved with the main column', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfTextRuns === 'function');
    await fillCv(page, 'exec-pro');
    await page.waitForTimeout(300);
    const items = (await readPdf(page, await cvPdfBuffer(page, page))).pages[0].items;
    const at = (s: string) => items.findIndex((x) => x.includes(s));
    const side = ['jordan@example.com', '+61 400 000 000', 'SQL', 'Python', 'Google Data Analytics'].map(at);
    const main = ['Jordan Rivers', 'Analyst who turns', 'Senior Data Analyst', 'Built a churn', 'Cut report time', 'BSc Statistics'].map(at);
    for (const i of [...side, ...main]) expect(i, JSON.stringify(items)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...side) < Math.min(...main) || Math.max(...main) < Math.min(...side), `sidebar ${side} / main ${main}`).toBe(true);
  });

  for (const tpl of TL_TEMPLATES) {
    test(`${tpl}: multi-page — each page's text layer has only that page's text`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await setup(page);
      await page.goto('/cv-builder.html');
      await page.waitForFunction(() => typeof (window as any).pfTextRuns === 'function');
      await fillBigCv(page, tpl);
      const { lines, pages } = await previewLines(page);
      expect(pages).toBeGreaterThanOrEqual(2);
      const buf = await cvPdfBuffer(page, page);
      const pdf = await readPdf(page, buf);
      expect(pdf.pages.length).toBe(pages);
      expect(buf.length / pages).toBeLessThan(1024 * 1024);
      const label = /Job \d+ bullet \d+/g;
      for (let p = 0; p < pages; p++) {
        const inDom = new Set(lines.filter((l) => pageOf(l.t) === p).flatMap((l) => l.text.match(label) || []));
        const inPdf = new Set(pdf.pages[p].items.join(' ').match(label) || []);
        expect([...inPdf].sort(), `page ${p + 1}`).toEqual([...inDom].sort());
        expect(inPdf.size, `page ${p + 1} has text`).toBeGreaterThan(0);
      }
      const seq = pdf.pages.flatMap((pg) => pg.items.join(' ').match(label) || []);
      const want = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, b) => `Job ${i + 1} bullet ${b + 1}`)).flat();
      expect(seq, 'bullets in order across the pages').toEqual(want);
      expect(pdf.pages[1].items.join(' ')).not.toContain('Jordan Rivers');
    });
  }

  // decoded-pixel difference between two page JPEGs
  const jpgDiff = (page: Page, x: string, y: string) => page.evaluate(async ([x, y]) => {
    const load = async (s: string) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const [p, q] = [await load(x), await load(y)];
    if (p.length !== q.length) return { mean: 999, bigShare: 1 };
    let sum = 0, big = 0;
    for (let k = 0; k < p.length; k += 4) {
      const d = Math.abs(p[k] - q[k]) + Math.abs(p[k + 1] - q[k + 1]) + Math.abs(p[k + 2] - q[k + 2]);
      sum += d; if (d > 96) big++;
    }
    return { mean: sum / (p.length / 4), bigShare: big / (p.length / 4) };
  }, [x, y] as [string, string]);
  const pageJpgs = async (page: Page, url: string, during?: string) => {
    await page.goto(url);
    await page.waitForFunction(() => typeof (window as any).pfPaginate === 'function');
    await fillBigCv(page, 'exec-pro');
    await page.waitForTimeout(800);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.evaluate((js) => {
      if (js) (window as any).__spam = setInterval(new Function(js) as any, 5);
      return Promise.resolve((window as any).downloadPDF()).finally(() => clearInterval((window as any).__spam));
    }, during || '')]);
    return pdfPages(fs.readFileSync((await dl.path())!)).jpgs;
  };
  const same = async (page: Page, a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { const d = await jpgDiff(page, a[i], b[i]); if (d.mean >= 1 || d.bigShare >= 0.001) return false; }
    return true;
  };

  test('the page images are unchanged: same pixels as main\'s PDF', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    const now = await pageJpgs(page, '/cv-builder.html');
    expect(now.length).toBeGreaterThanOrEqual(2);
    // main's capture is racy (see the next test), so compare with main's first capture that wasn't hit by it
    let match = false;
    for (let t = 0; t < 6 && !match; t++) match = await same(page, now, await pageJpgs(page, '/cv-builder-main.html'));
    expect(match, 'a main PDF with the same page images').toBe(true);
  });

  test('the page images stay at full size even when the preview re-scales during the capture', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    const ref = await pageJpgs(page, '/cv-builder.html');
    const hit = await pageJpgs(page, '/cv-builder.html', 'scalePreview()');           // a late re-scale (timer / font load) every 5ms
    expect(await same(page, ref, hit)).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('cvPreviewScale')!).transform)).not.toBe('matrix(1, 0, 0, 1, 0, 0)');   // preview zoom restored
  });

  test('non-Latin text (Bengali, Hindi, Arabic) is in the text layer; without the font it is left out gracefully', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfTextRuns === 'function');
    await fillCv(page, 'classic');
    await page.fill('#f-name', 'প্রিতম দাশ');
    await page.evaluate(() => { const el = document.getElementById('f-summary') as HTMLTextAreaElement; el.value = 'नमस्ते दुनिया — مرحبا بالعالم — Analyst who turns messy data into clear decisions.'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(300);
    const pdf = await readPdf(page, await cvPdfBuffer(page, page));
    const all = pdf.pages[0].items.join(' ');
    expect(all).toContain('প্রিতম');
    expect(all).toContain('नमस्ते');
    expect(all.normalize('NFKC').replace(/\s/g, '')).toContain('مرحبا');     // jsPDF shapes Arabic (presentation forms; NFKC gives the letters back)
    expect(all).toContain('Senior Data Analyst');
    expect(pdf.title).toBe('প্রিতম দাশ — CV');
    // the fonts can't load: still a PDF, the Latin text is still there, no error
    await page.context().route(/expo-google-fonts/, (r) => r.abort());
    await page.goto('/cv-builder.html');
    await page.waitForFunction(() => typeof (window as any).pfTextRuns === 'function');
    await fillCv(page, 'classic');
    await page.fill('#f-name', 'প্রিতম দাশ');
    await page.waitForTimeout(300);
    const pdf2 = await readPdf(page, await cvPdfBuffer(page, page));
    const all2 = pdf2.pages[0].items.join(' ');
    expect(all2).toContain('Senior Data Analyst');
    expect(all2).not.toContain('প্রিতম');
  });

  test('the one new line by the PDF button', async ({ page }) => {
    await setup(page);
    await page.goto('/cv-builder.html');
    await expect(page.locator('.cv-ats-note')).toHaveCount(1);
    await expect(page.locator('.cv-ats-note')).toHaveText('Text in your PDF is selectable and readable by applicant tracking systems.');
  });

  test('inside the homepage embed: the PDF has its text layer', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    const frame = await openCvTab(page);
    await fillCv(frame, 'modern-blue');
    await frame.waitForTimeout(300);
    const pdf = await readPdf(page, await cvPdfBuffer(page, frame));
    expect(pdf.pages[0].items.join(' ')).toContain('Built a churn dashboard used by 40 managers');
  });
});
