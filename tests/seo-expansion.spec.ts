// The feat/seo-expansion landing pages in a browser: each loads with no script errors, one H1, its definition and FAQ
// visible, nothing wider than a 360px screen, and its tool embed (where it has one) loads only near view and is sized
// by the tool. Pages are served from this checkout; /api/process is mocked (nothing calls it here), GA and ads are
// blocked, CDN libraries come from the test cache. Run: npx playwright test tests/seo-expansion.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml' };
test.setTimeout(180000);

const PAGES: [string, string | null][] = [
  ['flashcard-maker', '/flashcard-quiz-maker.html?embed=1'], ['notes-to-flashcards', '/flashcard-quiz-maker.html?embed=1'],
  ['pdf-to-flashcards', '/flashcard-quiz-maker.html?embed=1'], ['quiz-from-notes', '/flashcard-quiz-maker.html?embed=1'],
  ['quizlet-alternative', '/flashcard-quiz-maker.html?embed=1'], ['ai-study-tools', null],
  ['ai-humanizer', '/?embed=paraphraser&tool=humanizer'], ['ai-summarizer', '/?embed=paraphraser&tool=summarizer'],
  ['grammar-checker', '/?embed=paraphraser&tool=grammar'], ['ai-detector', '/?embed=paraphraser&tool=detector'],
  ['free-ai-chat', null], ['ilovepdf-alternative', null], ['smallpdf-alternative', null], ['compress-pdf-to-500kb', null],
  ['cover-letter-generator', '/cv-builder.html?embed=1'],
];

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
  const ctx = page.context(), errors: string[] = [], api: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route(/^https:\/\/(www\.)?youtube\.com\//, (r) => r.abort());
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      api.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, audio: { enabled: false } }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { errors, api };
}

test.describe('new landing pages', () => {
  for (const [slug, embed] of PAGES) {
    test(`${slug}.html: loads, one H1, definition + FAQ visible, fits 360px${embed ? ', tool embed loads near view and is sized' : ''}`, async ({ page }) => {
      const net = await setup(page);
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto(`/${slug}.html`);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('.pf-define')).toBeVisible();
      await expect(page.locator('.pf-updated')).toHaveText('Last updated: October 29, 2026');
      expect(await page.locator('.faq-item').count()).toBeGreaterThanOrEqual(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      if (embed) {
        // (the box sits right under the hero, so it is near view on load; lib/embed-host.js laziness is covered by landing-embeds)
        await page.locator('[data-pf-embed]').scrollIntoViewIfNeeded();
        await expect(page.locator(`iframe[src="${embed}"]`)).toHaveCount(1, { timeout: 30000 });
        const frame = page.locator(`iframe[src="${embed}"]`);
        await expect.poll(async () => (await frame.boundingBox())!.height, { timeout: 60000 }).toBeGreaterThan(300);
        await expect(page.locator('.pf-try-full')).toHaveText('Open full tool ↗');
      }
      expect(net.errors).toEqual([]);
    });
  }

  test('the flashcard embed is sized by the tool itself (pf-fq-size), not left at the loading height', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/flashcard-maker.html');
    await page.locator('[data-pf-embed]').scrollIntoViewIfNeeded();
    const frame = page.locator('iframe[src="/flashcard-quiz-maker.html?embed=1"]');
    await expect(frame).toHaveCount(1, { timeout: 30000 });
    const inner = page.frameLocator('iframe[src="/flashcard-quiz-maker.html?embed=1"]');
    await expect(inner.locator('#spGo')).toBeVisible({ timeout: 60000 });
    await expect(inner.locator('.pf-hero')).toBeHidden();                    // embed mode: the tool only
    await expect.poll(async () => {
      const h = (await frame.boundingBox())!.height;
      const content = await page.frames().find((f) => f.url().includes('flashcard-quiz-maker.html?embed=1'))!.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      return Math.abs(h - content);
    }, { timeout: 30000 }).toBeLessThan(40);
  });

  test('internal links on the new pages resolve; every new page is linked from at least one existing page', () => {
    const all = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
    for (const [slug] of PAGES) {
      const s = fs.readFileSync(path.join(ROOT, slug + '.html'), 'utf8');
      for (const m of s.matchAll(/href="(\/[^"#?]*)"/g)) {
        const p = m[1] === '/' ? 'index.html' : m[1].slice(1);
        expect(fs.existsSync(path.join(ROOT, p)), `${slug} → ${m[1]}`).toBe(true);
      }
      const from = all.filter((f) => !PAGES.some(([x]) => x + '.html' === f) && fs.readFileSync(path.join(ROOT, f), 'utf8').includes(`href="/${slug}.html"`));
      expect(from.length + (fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8').includes(`/${slug}.html`) ? 0 : -99), `${slug}: linked from an existing page or the sitemap`).toBeGreaterThanOrEqual(0);
    }
  });
});
