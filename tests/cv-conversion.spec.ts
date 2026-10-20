// CV builder: what happens when "PDF" is clicked but can't download yet (sample showing, empty, overflow, failure),
// the PDF button label before a name is typed, and the GA events cv_download_blocked / cv_started.
// Pages are served from THIS checkout; /api/process is MOCKED; GA, ads and fonts are BLOCKED; CDN libraries are
// cached on disk. Run: npx playwright test tests/cv-conversion.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
test.setTimeout(90000);

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
async function setup(page: Page, opts: { failPdfLibs?: boolean } = {}) {
  const ctx = page.context(), errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, (r) =>
    opts.failPdfLibs && /html2canvas|jspdf/.test(r.request().url()) ? r.abort() : cdnRoute(r));
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false,"ok":false}' });
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { errors };
}
async function open(page: Page) {
  await page.goto('/cv-builder.html');
  await page.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
}
const cvEvents = (page: Page) => page.evaluate(() => ((window as any).dataLayer || []).map((a: any) => Array.from(a))
  .filter((a: any[]) => a[0] === 'event' && /^cv_/.test(a[1]) && a[1] !== 'cv_tab_click').map((a: any[]) => JSON.parse(JSON.stringify([a[1], a[2]]))));
const prompt = (page: Page) => page.locator('#cvDlPrompt');
const isPdf = async (d: any) => fs.readFileSync((await d.path())!).subarray(0, 5).toString() === '%PDF-';
const noDownload = (page: Page, ms = 2500) => page.waitForEvent('download', { timeout: ms }).then(() => true, () => false);
// enough text that the CV runs a few lines over one page
const LONG = Array.from({ length: 4 }, (_, i) => `Led project ${i + 1}, coordinating a cross-functional team, reporting weekly to stakeholders and improving delivery times across several regions.`).join(' ');
async function overflowOnePage(page: Page, typeName = true) {
  if (typeName) await page.fill('#f-name', 'Olivia Overflow');
  for (let n = 1; n < 12; n++) {                                     // (the summary section is collapsed: set it like an import would)
    const st = await page.evaluate((text) => {
      const el = document.getElementById('f-summary') as HTMLTextAreaElement;
      el.value = text; el.dispatchEvent(new Event('input', { bubbles: true }));
      (window as any).scalePreview(); const p = (0, eval)('pfPages'); return { nat: p.natural, ch: p.chosen, over: p.overLines };
    }, Array.from({ length: n }, () => LONG).join('\n\n'));
    if (st.nat > st.ch && st.over <= 40) return st;
  }
  throw new Error('could not make the CV overflow a little');
}

// ─────────────────────────────────────────────────────────────
test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }); });

  test('sample showing: PDF click → inline prompt, cv_download_blocked sample_showing; "Add your details" focuses Full name; label until a name is typed', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await expect(page.locator('#cvPdfTop')).toHaveText('⬇ PDF (add your name first)');
    await expect(page.locator('#cvPdfFoot')).toHaveText('⬇ PDF (add your name first)');
    const dl = noDownload(page);
    await page.locator('#cvPdfTop').click();
    expect(await dl).toBe(false);
    await expect(prompt(page)).toBeVisible();
    await expect(prompt(page)).toContainText('This is a sample — add your details to download your CV');
    await expect(prompt(page).locator('.pri')).toHaveText('Add your details');
    await expect(prompt(page).locator('.sec')).toHaveText('Download this sample as PDF');
    // right under the button that was clicked (the form header), not a toast
    expect(await page.evaluate(() => !!document.querySelector('#cvFormPanel #cvDlPrompt'))).toBe(true);
    expect(await cvEvents(page)).toEqual([['cv_download_blocked', { reason: 'sample_showing' }]]);
    await prompt(page).locator('.pri').click();
    await expect(prompt(page)).toHaveCount(0);
    await expect(page.locator('#f-name')).toBeFocused();
    await page.keyboard.type('Alice Ready');
    await expect(page.locator('#cvPdfTop')).toHaveText('⬇ PDF');
    await expect(page.locator('#cvPdfFoot')).toHaveText('⬇ PDF');
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.locator('#cvPdfTop').click()]);
    expect(d.suggestedFilename()).toBe('Alice-Ready-CV.pdf');
    expect(await isPdf(d)).toBe(true);
    expect(await cvEvents(page)).toEqual([
      ['cv_download_blocked', { reason: 'sample_showing' }],
      ['cv_started', { field: 'name' }],
      ['cv_download', { template: 'classic', format: 'pdf', sample: 'false' }],
    ]);
    await expect(prompt(page)).toHaveCount(0);
    expect(net.errors).toEqual([]);
  });

  test('"Download this sample as PDF" downloads the sample (no "Sample data" badge in it), the carousel stays', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#cvPdfTop').click();          // (while the sample shows, the template bar covers the footer button)
    await expect(prompt(page)).toBeVisible();
    let badgeDuringCapture: boolean | null = null;
    await page.exposeFunction('__badge', (v: boolean) => { badgeDuringCapture = v; });
    await page.evaluate(() => { const h = (window as any).html2canvas; if (h) (window as any).html2canvas = (...a: any[]) => { (window as any).__badge(!!document.getElementById('carBadge')); return h(...a); }; });
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), prompt(page).locator('.sec').click()]);
    expect(d.suggestedFilename()).toBe('Sample-CV.pdf');
    expect(await isPdf(d)).toBe(true);
    if (badgeDuringCapture !== null) expect(badgeDuringCapture).toBe(false);
    await expect(page.locator('#carBadge')).toBeVisible();                                                                // the sample is showing again
    await expect(page.locator('#carouselControls')).toBeVisible();
    const ev = await cvEvents(page);
    expect(ev[0]).toEqual(['cv_download_blocked', { reason: 'sample_showing' }]);
    expect(ev[1]).toEqual(['cv_download', { template: await page.evaluate('Object.keys(RENDER_MAP)[carouselIndex]'), format: 'pdf', sample: 'true' }]);
    expect(ev.length).toBe(2);
    expect(net.errors).toEqual([]);
  });

  test('empty CV (details typed, then cleared): prompt + cv_download_blocked empty', async ({ page }) => {
    await setup(page);
    await open(page);
    await page.fill('#f-name', 'X');
    await page.fill('#f-name', '');
    await expect(page.locator('#cvPdfTop')).toHaveText('⬇ PDF (add your name first)');
    const dl = noDownload(page);
    await page.locator('#cvPdfTop').click();
    expect(await dl).toBe(false);
    await expect(prompt(page)).toContainText('Your CV is empty — add your details to download it');
    await prompt(page).locator('.pri').click();
    await expect(page.locator('#f-name')).toBeFocused();
    expect(await cvEvents(page)).toEqual([['cv_started', { field: 'name' }], ['cv_download_blocked', { reason: 'empty' }]]);
  });

  test('overflow: the prompt has Fit / Add page right there; Fit → "fits now" → Download PDF', async ({ page }) => {
    await setup(page);
    await open(page);
    const st = await overflowOnePage(page);
    const dl = noDownload(page);
    await page.locator('#cvPdfFoot').click();
    expect(await dl).toBe(false);
    expect(await page.evaluate(() => document.getElementById('cvDlPrompt')!.nextElementSibling!.id)).toBe('dlGrid');      // right above the footer button
    await expect(prompt(page)).toContainText(`Your CV is ${st.over} line${st.over === 1 ? '' : 's'} over 1 page`);
    await expect(prompt(page).locator('[data-act=fit]')).toHaveText('✨ Fit to 1 page');
    await expect(prompt(page).locator('[data-act=add]')).toHaveText('+ Add page 2');
    await prompt(page).locator('[data-act=fit]').click();
    const r = await page.evaluate(() => document.getElementById('cvDlPrompt')!.dataset.reason);
    if (r === 'ready') {
      await expect(prompt(page)).toContainText('✓ Your CV fits on 1 page now');
    } else {                                                           // could not fit without going below 9.5pt: add a page instead
      await expect(prompt(page)).toContainText('without going below 9.5pt');
      await prompt(page).locator('[data-act=add]').click();
      await expect(prompt(page)).toContainText('✓ Your CV fits on 2 pages now');
    }
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), prompt(page).locator('[data-act=download]').click()]);
    expect(await isPdf(d)).toBe(true);
    await expect(prompt(page)).toHaveCount(0);
    const ev = await cvEvents(page);
    expect(ev).toEqual([['cv_started', { field: 'name' }], ['cv_download_blocked', { reason: 'overflow' }], ['cv_download', { template: 'classic', format: 'pdf', sample: 'false' }]]);
  });

  test('overflow: "+ Add page 2" in the prompt, then download', async ({ page }) => {
    await setup(page);
    await open(page);
    await overflowOnePage(page);
    await page.locator('#cvPdfTop').click();
    await prompt(page).locator('[data-act=add]').click();
    await expect(prompt(page)).toContainText('✓ Your CV fits on 2 pages now');
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), prompt(page).locator('[data-act=download]').click()]);
    expect(await isPdf(d)).toBe(true);
  });

  test('PDF libraries fail to load and the print fallback is blocked: prompt + cv_download_blocked other', async ({ page }) => {
    await setup(page, { failPdfLibs: true });
    await open(page);
    expect(await page.evaluate(() => typeof (window as any).html2canvas === 'undefined' || typeof (window as any).jspdf === 'undefined')).toBe(true);
    await page.evaluate(() => { window.open = () => null; });         // popup blocker: the print fallback can't open either
    await page.fill('#f-name', 'Nora Network');
    await page.locator('#cvPdfTop').click();
    await expect(prompt(page)).toContainText('Couldn’t create the PDF', { timeout: 30000 });
    await expect(prompt(page).locator('.pri')).toHaveText('Try again');
    expect(await cvEvents(page)).toEqual([['cv_started', { field: 'name' }], ['cv_download_blocked', { reason: 'other' }]]);
  });

  test('cv_started fires once, for the first CV field (not the job match box), with the field name only', async ({ page }) => {
    await setup(page);
    await open(page);
    await page.fill('#f-jobtitle', 'Data Analyst');
    await page.fill('#f-name', 'Second Field');
    await page.fill('#f-email', 'a@example.com');
    expect(await cvEvents(page)).toEqual([['cv_started', { field: 'jobtitle' }]]);
    expect(JSON.stringify(await cvEvents(page))).not.toMatch(/Data Analyst|example\.com|Second/);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('mobile (Save sheet)', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: ANDROID, hasTouch: true, isMobile: true });
  const saveSheet = async (page: Page) => {
    await page.locator('#ctb-download').click();
    await expect(page.locator('#bottomSheet')).toHaveClass(/open/);
    return page.locator('#cvPdfSheet');
  };

  test('sample showing: the prompt opens in the sheet (sheet stays open); "Add your details" opens Edit with Full name focused', async ({ page }) => {
    await setup(page);
    await open(page);
    const btn = await saveSheet(page);
    await expect(btn).toHaveText('⬇️ Download PDF (add your name first)');
    const dl = noDownload(page);
    await btn.click();
    expect(await dl).toBe(false);
    await expect(page.locator('#sheetContent #cvDlPrompt')).toContainText('This is a sample — add your details to download your CV');
    await expect(page.locator('#bottomSheet')).toHaveClass(/open/);
    expect(await cvEvents(page)).toEqual([['cv_download_blocked', { reason: 'sample_showing' }]]);
    await page.locator('#cvDlPrompt .pri').click();
    await expect(page.locator('#sheetTitle')).toHaveText('Edit CV');
    await expect(page.locator('#sheetContent #f-name')).toBeFocused({ timeout: 5000 });
  });

  test('details typed in the Edit sheet: Save → Download PDF downloads (before: blocked as "sample")', async ({ page }) => {
    await setup(page);
    await open(page);
    await page.locator('#ctb-edit, .ctb-btn[onclick*="edit"]').first().click();
    await expect(page.locator('#sheetContent #f-name')).toBeVisible();
    await page.locator('#sheetContent #f-name').fill('Mia Mobile');
    await page.evaluate(() => (window as any).closeSheet());
    await page.waitForTimeout(400);
    const btn = await saveSheet(page);
    await expect(btn).toHaveText('⬇️ Download PDF');
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), btn.click()]);
    expect(d.suggestedFilename()).toBe('Mia-Mobile-CV.pdf');
    expect(await isPdf(d)).toBe(true);
    await expect(page.locator('#cvDlPrompt')).toHaveCount(0);
    expect(await cvEvents(page)).toEqual([['cv_started', { field: 'name' }], ['cv_download', { template: 'classic', format: 'pdf', sample: 'false' }]]);
  });

  test('sample download from the sheet; overflow prompt in the sheet with Fit / Add page', async ({ page }) => {
    await setup(page);
    await open(page);
    let btn = await saveSheet(page);
    await btn.click();
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.locator('#cvDlPrompt .sec').click()]);
    expect(d.suggestedFilename()).toBe('Sample-CV.pdf');
    await page.evaluate(() => (window as any).closeSheet());
    await page.waitForTimeout(400);
    await page.locator('#ctb-edit, .ctb-btn[onclick*="edit"]').first().click();      // type the name where a phone user would
    await page.locator('#sheetContent #f-name').fill('Olivia Overflow');
    await page.evaluate(() => (window as any).closeSheet());
    await page.waitForTimeout(400);
    await overflowOnePage(page, false);
    btn = await saveSheet(page);
    const dl = noDownload(page);
    await btn.click();
    expect(await dl).toBe(false);
    await expect(page.locator('#sheetContent #cvDlPrompt [data-act=fit]')).toBeVisible();
    await expect(page.locator('#sheetContent #cvDlPrompt [data-act=add]')).toBeVisible();
    await page.locator('#cvDlPrompt [data-act=add]').click();
    const [d2] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.locator('#cvDlPrompt [data-act=download]').click()]);
    expect(await isPdf(d2)).toBe(true);
    const ev = (await cvEvents(page)).map((e) => e[0] + (e[1].reason ? ':' + e[1].reason : ''));
    expect(ev).toEqual(['cv_download_blocked:sample_showing', 'cv_download', 'cv_started', 'cv_download_blocked:overflow', 'cv_download']);
    expect((await cvEvents(page)).filter((e) => e[0] === 'cv_download').map((e) => e[1].sample)).toEqual(['true', 'false']);
  });
});

