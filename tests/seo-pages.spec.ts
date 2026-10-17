// SEO additions — new landing pages, homepage section + FAQ + schema, CV builder section.
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk), so
// the live site is never touched. /api/process is MOCKED (never called for real) and
// google-analytics.com / googletagmanager.com / ads are BLOCKED.
// Run: npx playwright test tests/seo-pages.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.json': 'application/json',
};
const NEW_PAGES = [
  { file: 'paraphrase-word-document-keep-formatting.html', title: 'Paraphrase Word Document Without Losing Formatting — Free | ParaFree' },
  { file: 'paraphrase-document-online-keep-format.html', title: 'Paraphrase Documents Online — Upload & Download, Format Stays the Same | ParaFree' },
];
const NEW_FAQ = [
  'Will my fonts, headings, tables and bullet points stay the same?',
  'Can I paraphrase a PowerPoint without changing the design?',
  'Is ParaFree the best free paraphrasing tool with no word limit?',
  'Do I need to copy and paste, or can I just upload my file?',
];

async function serveLocal(page: Page) {
  const apiCalls: string[] = [];
  await page.route(BLOCKED, (route: Route) => route.abort());
  await page.route('https://parafree.app/**', async (route: Route) => {
    const url = new URL(route.request().url());
    // Homepage rating summary (GET) — covered by live-rating.spec.ts; not a tool call
    if (url.pathname === '/api/process' && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
    if (url.pathname === '/api/process') { apiCalls.push(url.pathname); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false}' }); }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return apiCalls;
}

const ldBlocks = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent || '')));

test.describe('SEO additions', () => {
  for (const { file, title } of NEW_PAGES) {
    test(`${file}: loads, one H1, meta, FAQ schema matches visible FAQ`, async ({ page }) => {
      await serveLocal(page);
      const res = await page.goto('/' + file);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page).toHaveTitle(title);
      const url = 'https://parafree.app/' + file;
      expect(await page.getAttribute('link[rel="canonical"]', 'href')).toBe(url);
      expect(await page.getAttribute('meta[property="og:url"]', 'content')).toBe(url);
      expect((await page.getAttribute('meta[name="description"]', 'content'))!.length).toBeGreaterThan(50);
      expect(await page.locator('script[src*="googletagmanager.com/gtag/js?id=G-0QEEGS0DZQ"]').count()).toBe(1);
      await expect(page.locator('main a[href="/"], .hero a[href="/"]').first()).toBeVisible();   // button to the tool

      const ld = await ldBlocks(page);
      expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|reviewCount|ratingValue/i);
      const faq = ld.find((b: any) => b['@type'] === 'FAQPage');
      const visibleQ = await page.locator('details summary').allInnerTexts();
      const visibleA = await page.locator('details p').allTextContents();
      expect(faq.mainEntity.map((q: any) => q.name)).toEqual(visibleQ.map(s => s.trim()));
      expect(faq.mainEntity.map((q: any) => q.acceptedAnswer.text)).toEqual(visibleA.map(s => s.trim()));
      expect(faq.mainEntity.length).toBeGreaterThanOrEqual(3);

      const words = (await page.evaluate(() => {
        const h = document.querySelector('.hero')!, f = document.querySelector('footer')!;
        const r = document.createRange(); r.setStartBefore(h); r.setEndBefore(f);
        return r.toString();
      })).split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(500);
      expect(words).toBeLessThanOrEqual(700);
    });
  }

  test('homepage: new section, FAQ items, schema, footer links', async ({ page }) => {
    const api = await serveLocal(page);
    await page.goto('/');
    const sec = page.locator('#keep-formatting');
    await expect(sec.locator('h2')).toHaveText('The Best Free Paraphrasing Tool That Keeps Your Formatting');
    await expect(sec.locator('ol li')).toHaveCount(3);
    for (const { file } of NEW_PAGES) {
      await expect(sec.locator(`a[href="/${file}"]`)).toHaveCount(1);
      await expect(page.locator(`footer a[href="/${file}"]`)).toHaveCount(1);
    }
    // the new section sits before the FAQ
    expect(await page.evaluate(() => !!(document.getElementById('keep-formatting')!.compareDocumentPosition(document.querySelector('.faq')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

    const q = (await page.locator('.faq .faq-q').allInnerTexts()).map(s => s.trim());
    expect(q.slice(-4)).toEqual(NEW_FAQ);                                    // appended at the end
    expect(q.filter(x => x === 'Can I paraphrase a Word document without losing formatting?')).toHaveLength(1); // no duplicate
    const ld = await ldBlocks(page);
    expect(ld.filter((b: any) => b['@type'] === 'FAQPage')).toHaveLength(1); // merged, not a second block
    const faq = ld.find((b: any) => b['@type'] === 'FAQPage');
    for (const question of NEW_FAQ) {
      const entry = faq.mainEntity.find((e: any) => e.name === question);
      const visible = await page.locator('.faq-item', { has: page.locator('.faq-q', { hasText: question }) }).locator('.faq-a').innerText();
      expect(entry.acceptedAnswer.text).toBe(visible.trim());
    }
    expect(api).toEqual([]);
  });

  test('CV builder: new section is visible after the existing content', async ({ page }) => {
    await serveLocal(page);
    await page.goto('/cv-builder.html');
    const sec = page.locator('#best-free-cv-builder');
    await expect(sec.locator('h2')).toHaveText('Best Free CV Builder — No Signup, No Watermark');
    await expect(sec).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('best-free-cv-builder')!.nextElementSibling!.tagName)).toBe('FOOTER');
  });

  test('sitemap lists both new pages', async () => {
    const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    for (const { file } of NEW_PAGES) expect(xml).toContain(`<loc>https://parafree.app/${file}</loc>`);
  });

  test('360px: new content causes no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await serveLocal(page);
    for (const { file } of NEW_PAGES) {
      await page.goto('/' + file);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), file).toBeLessThanOrEqual(360);
    }
    for (const [url, id] of [['/', 'keep-formatting'], ['/cv-builder.html', 'best-free-cv-builder']]) {
      await page.goto(url);
      const overflow = await page.evaluate((sid) => {
        const sec = document.getElementById(sid)!;
        return [sec, ...sec.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > 360.5 || r.left < -0.5); }).length;
      }, id);
      expect(overflow, `${url} #${id}`).toBe(0);
    }
  });
});
