// Live user rating on the homepage + claim cleanup.
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk), so
// the live site is never touched. /api/process (rating summary, feedback, providers) is MOCKED
// and google-analytics.com / googletagmanager.com / ads are BLOCKED.
// Run: npx playwright test tests/live-rating.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|jooble\.org/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

type Summary = { status?: number; json?: any };
async function serveLocal(page: Page, summary: Summary) {
  const posts: any[] = [];
  const gets: string[] = [];
  await page.route(BLOCKED, (route: Route) => route.abort());
  await page.route('https://parafree.app/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') {
        gets.push(url.search);
        return route.fulfill({ status: summary.status || 200, contentType: 'application/json', body: JSON.stringify(summary.json || {}) });
      }
      posts.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { posts, gets };
}
const ratingsInSchema = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent || ''))
    .filter((b: any) => b.aggregateRating).map((b: any) => [b.aggregateRating.ratingValue, b.aggregateRating.ratingCount]));

test.describe('live rating', () => {
  test('live summary updates the hero line, Quick Facts and both schemas (identical numbers)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    const net = await serveLocal(page, { json: { ok: true, average: 4.62, count: 23 } });
    await page.goto('/');
    await expect(page.locator('#pfHeroRating')).toHaveText('★ 4.6 · 23 user ratings');
    await expect(page.locator('#pfUserRating')).toHaveText('★ 4.6 from 23 user ratings');
    expect(await ratingsInSchema(page)).toEqual([['4.6', '23'], ['4.6', '23']]);
    expect(net.gets).toEqual(['?type=ratingSummary']);                      // one request per page view
    // the rating line sits right under the homepage title
    expect(await page.evaluate(() => document.querySelector('h1.hero-title')!.nextElementSibling!.id)).toBe('pfHeroRating');
    await expect(page.locator('#pfHeroRating')).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const [label, summary] of [
    ['server error', { status: 500, json: { error: 'x' } }],
    ['no ratings yet', { json: { ok: false } }],
    ['garbage numbers', { json: { ok: true, average: 9, count: -1 } }],
  ] as [string, Summary][]) {
    test(`fallback numbers stay when the summary fails (${label})`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(String(e)));
      const net = await serveLocal(page, summary);
      await page.goto('/');
      await expect.poll(() => net.gets.length).toBe(1);
      await page.waitForTimeout(300);
      await expect(page.locator('#pfHeroRating')).toHaveText('★ 4.7 · 21 user ratings');
      await expect(page.locator('#pfUserRating')).toHaveText('★ 4.7 from 21 user ratings');
      expect(await ratingsInSchema(page)).toEqual([['4.7', '21'], ['4.7', '21']]);
      expect(errors).toEqual([]);
    });
  }

  test('singular wording for one rating', async ({ page }) => {
    await serveLocal(page, { json: { ok: true, average: 5, count: 1 } });
    await page.goto('/');
    await expect(page.locator('#pfHeroRating')).toHaveText('★ 5.0 · 1 user rating');
  });

  test('feedback form still submits; owner browsers (pf_admin) are flagged as test', async ({ page }) => {
    const net = await serveLocal(page, { json: { ok: false } });
    await page.goto('/');
    const submit = async () => {
      await page.evaluate(() => { (document.querySelector('#pf-stars-row [data-v="5"]') as HTMLElement).click(); (window as any).pfSubmitFeedback(); });
    };
    await submit();
    await expect.poll(() => net.posts.filter(p => p.type === 'submitFeedback').length).toBe(1);
    expect(net.posts[0]).toMatchObject({ type: 'submitFeedback', rating: 5, test: false });

    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('pf_admin', '1'); });
    await page.reload();
    await submit();
    await expect.poll(() => net.posts.filter(p => p.type === 'submitFeedback').length).toBe(2);
    expect(net.posts[1]).toMatchObject({ type: 'submitFeedback', rating: 5, test: true });
  });

  test('360px: rating line does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await serveLocal(page, { json: { ok: true, average: 4.7, count: 1234 } });
    await page.goto('/');
    await expect(page.locator('#pfHeroRating')).toHaveText('★ 4.7 · 1234 user ratings');
    const r = await page.locator('#pfHeroRating').boundingBox();
    expect(r!.x).toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});

test.describe('claim cleanup', () => {
  const PAGES = ['index.html', 'cv-builder.html', 'about.html', 'student-cv-builder.html', 'free-cv-builder-international-students.html',
    'blog-cv-builder-that-finds-jobs-for-you.html', 'paraphrase-powerpoint.html', 'quillbot-alternative.html',
    'paraphrasing-tool-no-word-limit.html', 'best-free-paraphrasing-tool.html', 'paraphrase-word-document.html'];
  const BANNED = [
    /only free (tool|pptx|cv builder|paraphras)/i, /the only (free|online|cv builder|one in any)/i, /only one in any free/i,
    /no other free (cv builder|tool|paraphrasing tool)/i, /unique to parafree/i, /\(unique\)/i, /unique feature/i, /— uniquely —/i,
    /The Only Free/, /identical (styling|formatting)/i, /looks identical/i, /preserving all formatting/i, /preserves all docx formatting/i,
  ];
  test('no absolute PowerPoint / job-search / "identical" claims left on the edited pages', () => {
    for (const f of PAGES) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const re of BANNED) expect(s.match(re)?.[0], `${f} ${re}`).toBeUndefined();
    }
  });

  test('edited FAQ answers: schema copy identical to the visible copy', async ({ page }) => {
    await serveLocal(page, { json: { ok: false } });
    const CHECK: [string, string[]][] = [
      ['/', ['Can I paraphrase a Word document without losing formatting?', 'Can I paraphrase a PowerPoint presentation?', 'Does ParaFree work for students?']],
      ['/paraphrase-powerpoint.html', ['Can I paraphrase a PowerPoint online free?', "Will my slides' design change?"]],
      ['/paraphrase-word-document.html', ['Can I paraphrase a Word document without losing formatting?']],
      ['/best-free-paraphrasing-tool.html', ['Which paraphrasing tool keeps formatting?']],
    ];
    for (const [url, qs] of CHECK) {
      await page.goto(url);
      for (const q of qs) {
        const [schema, visible] = await page.evaluate((name) => {
          const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
          let schema = '';
          for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
            const d = JSON.parse(el.textContent || '');
            if (d['@type'] === 'FAQPage') schema = d.mainEntity.find((e: any) => e.name === name)?.acceptedAnswer.text || schema;
          }
          const qel = [...document.querySelectorAll('summary, .faq-q')].find(e => norm(e.textContent || '') === name)!;
          const visible = qel.tagName === 'SUMMARY' ? qel.nextElementSibling!.textContent! : qel.nextElementSibling!.textContent!;
          return [norm(schema), norm(visible)];
        }, q);
        expect(schema, `${url} ${q}`).not.toBe('');
        expect(schema, `${url} ${q}`).toBe(visible);
      }
    }
  });

  test('Word page uses the accurate formatting wording', () => {
    const s = fs.readFileSync(path.join(ROOT, 'paraphrase-word-document.html'), 'utf8');
    expect(s).toContain('Styles, bullet and numbered lists, images, headers and footers are kept.');
    expect(s).toContain("takes the paragraph's first style");
  });

  test('backups/ is kept out of Vercel deployments', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map(l => l.trim());
    expect(ignore).toContain('backups/');
  });
});
