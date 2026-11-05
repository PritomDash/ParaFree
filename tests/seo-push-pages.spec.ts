// SEO round 2, in the browser: the new pages render without page errors, the real tool is embedded (iframe appears when
// scrolled near), the breadcrumb is visible, nothing overflows at 360 px, and the breadcrumb added to an existing page
// doesn't break its hero. Pages are served from THIS checkout; /api/* must not be called; GA, ads, fonts and images are
// BLOCKED; CDN libraries cached on disk. Run: npx playwright test tests/seo-push-pages.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
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
  const ctx = page.context(), net = { api: [] as string[], errors: [] as string[] };
  page.on('pageerror', (e) => net.errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      net.api.push(url.pathname);
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      return route.fulfill({ status: 500, body: '{"error":"api must not be called"}' });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return net;
}

const NEW = ['lecture-to-flashcards', 'youtube-to-flashcards', 'compress-pdf-to-1mb', 'free-spanish-paraphrasing-tool', 'free-portuguese-paraphrasing-tool',
  'free-chinese-paraphrasing-tool', 'free-filipino-paraphrasing-tool'];

for (const slug of NEW) {
  test(`${slug}: renders, breadcrumb visible, tool embedded or linked, no overflow at 360 px`, async ({ page }) => {
    const net = await setup(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/${slug}.html`);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('nav.pf-crumbs')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'horizontal overflow at 360px').toBeLessThanOrEqual(1);
    const embed = page.locator('[data-pf-embed]');
    if (await embed.count()) {
      await embed.scrollIntoViewIfNeeded();
      await expect(page.locator('[data-pf-embed] iframe')).toHaveCount(1, { timeout: 20000 });
    } else {
      await expect(page.locator('a.btn-hero')).toHaveAttribute('href', /\/compress-pdf\.html/);
    }
    expect(net.errors).toEqual([]);
    expect(net.api.filter((a) => a !== '/api/process')).toEqual([]);
  });
}

test('a breadcrumb added to an existing page sits above its H1 and does not overflow (UK CV page)', async ({ page }) => {
  const net = await setup(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/free-cv-builder-uk.html');
  const crumbs = page.locator('nav.pf-crumbs').first(), h1 = page.locator('h1').first();
  await expect(crumbs).toBeVisible();
  expect((await crumbs.boundingBox())!.y).toBeLessThan((await h1.boundingBox())!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator('#uk-cv-length')).toBeVisible();
  expect(net.errors).toEqual([]);
});
