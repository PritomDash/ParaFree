// honesty-cleanup — real rating, no keyword footer line, accurate Word FAQ, .doc message,
// job_search / Jooble firing once per search.
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk), so
// the live site is never touched. /api/process (providers AND the Jooble job search) is MOCKED
// and google-analytics.com / googletagmanager.com / ads are BLOCKED.
// Run: npx playwright test tests/honesty-cleanup.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|jooble\.org/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const DOC_MSG = "Old .doc files aren't supported — please save as .docx in Word (File → Save As) and upload again.";
const JOBS = [{ title: 'Nurse', company: 'Acme Health', location: 'Sydney', link: 'https://example.com/j/1', snippet: 'Ward role' }];

async function serveLocal(page: Page) {
  const apiCalls: any[] = [];
  await page.route(BLOCKED, (route: Route) => route.abort());
  await page.route('https://parafree.app/**', async (route: Route) => {
    const url = new URL(route.request().url());
    // Homepage rating summary (GET) — covered by live-rating.spec.ts; not a tool call
    if (url.pathname === '/api/process' && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
    if (url.pathname === '/api/process') {
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push(body);
      const json = body.type === 'jobSearch' ? { jobs: JOBS, source: 'live' } : { success: false };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return apiCalls;
}

async function mockGtag(page: Page) {
  await page.evaluate(() => { (window as any).__ev = []; (window as any).gtag = (...a: any[]) => (window as any).__ev.push(a); });
}
const jobEvents = (page: Page) => page.evaluate(() => (window as any).__ev.filter((e: any[]) => e[0] === 'event' && e[1] === 'job_search').length);
const ldBlocks = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent || '')));

// A file that is NOT a zip, like a real binary Word 97-2003 .doc
const DOC_FILE = { name: 'essay.doc', mimeType: 'application/msword', buffer: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]) };

test.describe('honesty cleanup', () => {
  test('homepage: .doc shows the save-as-.docx message and is not read', async ({ page }) => {
    const api = await serveLocal(page);
    await page.goto('/');
    await mockGtag(page);
    await page.evaluate(() => {
      (window as any).__read = 0;
      const m = (window as any).mammoth; if (m) m.extractRawText = async () => { (window as any).__read++; return { value: 'x' }; };
      const z = (window as any).JSZip; if (z) z.loadAsync = async () => { (window as any).__read++; throw new Error('no'); };
    });
    await page.setInputFiles('#fileUpload', DOC_FILE);
    await expect(page.locator('#statusMsg')).toHaveClass(/show error/);
    await expect(page.locator('#statusMsg')).toContainText(DOC_MSG);
    expect(await page.evaluate(() => (window as any).__read)).toBe(0);
    expect(await page.inputValue('#inputText')).toBe('');
    expect(await page.evaluate(() => (window as any).__ev.filter((e: any[]) => e[1] === 'tool_error').map((e: any[]) => e[2].error_type)))
      .toEqual(['file_error']);
    expect(api).toEqual([]);
  });

  test('CV import: .doc shows the same message as a toast and calls no AI', async ({ page }) => {
    const api = await serveLocal(page);
    await page.goto('/cv-builder.html');
    await page.setInputFiles('#cvImportFile', DOC_FILE);
    await expect(page.locator('#cv-toast')).toContainText(DOC_MSG);
    expect(api).toEqual([]);
  });

  test('job search: typing title + location fires one search and one job_search event', async ({ page }) => {
    const api = await serveLocal(page);
    await page.goto('/cv-builder.html');
    await mockGtag(page);
    await page.locator('#f-jobtitle').pressSequentially('Nurse', { delay: 30 });       // debounced — no search per key
    await page.locator('#f-location').pressSequentially('Sydney', { delay: 30 });
    await expect(page.locator('#jobListingsArea')).toContainText('Acme Health');
    expect(api.filter(c => c.type === 'jobSearch')).toHaveLength(1);
    expect(await jobEvents(page)).toBe(1);

    // Typing in other CV fields, switching template and scrolling re-render the preview many times
    await page.locator('#f-name').pressSequentially('Sam Lee', { delay: 20 });
    await page.waitForTimeout(1500);
    await page.locator('#f-summary').pressSequentially('Caring nurse with five years of ward experience.', { delay: 5 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { (window as any).setTemplate('minimal'); (window as any).updatePreview(); (window as any).updatePreview(); });
    await page.mouse.wheel(0, 3000);
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(1600);
    expect(api.filter(c => c.type === 'jobSearch')).toHaveLength(1);
    expect(await jobEvents(page)).toBe(1);
    await expect(page.locator('#jobListingsArea')).toContainText('Acme Health');            // results not wiped

    // Clicking the button is one more user search → exactly one more call and event
    await page.evaluate(() => (window as any).runJobSearch());
    await expect.poll(() => jobEvents(page)).toBe(2);
    expect(api.filter(c => c.type === 'jobSearch')).toHaveLength(2);

    // Changing the location is a new search → one more
    await page.fill('#f-location', 'Melbourne');
    await expect.poll(() => jobEvents(page), { timeout: 5000 }).toBe(3);
    await page.waitForTimeout(1600);
    expect(api.filter(c => c.type === 'jobSearch')).toHaveLength(3);
    expect(api.every(c => c.type === 'jobSearch')).toBe(true);
  });

  test('job search: overlapping calls send only one request', async ({ page }) => {
    const api = await serveLocal(page);
    await page.goto('/cv-builder.html');
    await mockGtag(page);
    await page.fill('#f-jobtitle', 'Nurse');
    await page.evaluate(() => { const w = window as any; w.runJobSearch(); w.runJobSearch(true); w.runJobSearch(true); });
    await expect.poll(() => jobEvents(page)).toBe(1);
    await page.waitForTimeout(500);
    expect(api.filter(c => c.type === 'jobSearch')).toHaveLength(1);
  });

  test('homepage: Word FAQ is accurate, keyword footer line gone, rating is real and visible', async ({ page }) => {
    await serveLocal(page);
    await page.goto('/');
    const q = 'Can I paraphrase a Word document without losing formatting?';
    const answer = (await page.locator('.faq-item', { has: page.locator('.faq-q', { hasText: q }) }).locator('.faq-a').innerText()).trim();
    expect(answer).toContain('Styles, bullet and numbered lists, images, headers and footers are kept.');
    expect(answer).toContain('Headings, tables, paragraphs with links and reference lists are not rewritten');
    expect(answer).toContain("takes the paragraph's first style");
    expect(answer).not.toMatch(/every formatting detail|looks identical/);
    const ld = await ldBlocks(page);
    const faq = ld.find((b: any) => b['@type'] === 'FAQPage');
    expect(faq.mainEntity.find((e: any) => e.name === q).acceptedAnswer.text).toBe(answer);

    const footer = page.locator('footer').last();
    await expect(footer).not.toContainText('quillbot alternative free');
    await expect(footer).not.toContainText('humanize AI text free');
    expect(await footer.locator('a').count()).toBeGreaterThan(10);                 // navigation links kept

    await expect(page.locator('#pfUserRating')).toBeVisible();
    await expect(page.locator('#pfUserRating')).toHaveText('★ 4.7 from 21 user ratings');
    const ratings = ld.filter((b: any) => b.aggregateRating).map((b: any) => b.aggregateRating);
    expect(ratings.length).toBe(2);
    for (const r of ratings) expect([r.ratingValue, r.ratingCount]).toEqual(['4.7', '21']);
  });

  test('no made-up ratings or absolute claims left in the edited comparison spots', async () => {
    for (const f of ['cv-builder.html', 'ai-cv-builder.html', 'ats-resume-builder.html', 'cv-builder-no-signup.html',
                     'cv-maker-free-download.html', 'student-cv-builder.html', 'best-free-cv-builder.html']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/aggregateRating/);
    }
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(idx).not.toContain('only free tool with this feature');
    const cv = fs.readFileSync(path.join(ROOT, 'cv-builder.html'), 'utf8');
    expect(cv).not.toContain('✓ Only one');
    expect(cv).not.toContain('The Only Free CV Builder With a Built-In Job Search');
    expect((cv.match(/Checked October 2026/g) || []).length).toBe(2);
    expect(fs.readFileSync(path.join(ROOT, 'paraphrase-word-document.html'), 'utf8')).toContain('Checked October 2026');
    expect(fs.readFileSync(path.join(ROOT, 'best-free-cv-builder.html'), 'utf8')).toContain('checked October 2026');
  });
});
