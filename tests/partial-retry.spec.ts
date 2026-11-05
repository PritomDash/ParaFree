// Phase 1, page side: a part the AI couldn't paraphrase is never shown as if paraphrased. The API returns
// `failedParts` (that part's ORIGINAL text sits in the result); the page marks it, says "1 part couldn't be
// paraphrased", and "Retry this part" re-sends ONLY that part and splices the new text in.
// Hotfix: before the button ever shows, the page retries that part silently twice ("Finishing part 1…"; 3 s then 8 s —
// shortened here with window.PF_AUTO_RETRY_WAITS); the button appears only when both automatic tries fail.
// Pages are served from THIS checkout; /api/process is MOCKED (never the live API); GA, ads, fonts and images are
// BLOCKED; CDN libraries are cached on disk. Run: npx playwright test tests/partial-retry.spec.ts --workers=1
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

const P1 = 'The first paragraph talks about how students plan their weekly revision before the exams start.';
const BAD = 'The second paragraph is the part that the mocked AI refuses to paraphrase on the first try.';
const P3 = 'The third paragraph explains why short breaks help students remember what they have read.';
const rewrite = (t: string) => t.replace(/\bparagraph\b/g, 'section').replace(/\bstudents\b/g, 'learners').replace(/\bThe\b/g, 'This');

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

// The first call leaves BAD unparaphrased; a retry of BAD alone fails the first `failRetries` times, then succeeds
// (Infinity = always fails). Automatic waits are shortened to 600 ms / 600 ms.
async function setup(page: Page, failRetries: number) {
  const ctx = page.context(), calls: any[] = [], errors: string[] = [];
  let retries = 0;
  await page.addInitScript(() => { (window as any).PF_AUTO_RETRY_WAITS = [600, 600]; });
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const text = String(body.text || '');
      const json = (o: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
      if (text.trim() === BAD) {   // a retry of just that part
        return ++retries > failRetries ? json({ success: true, result: rewrite(BAD), apiStatuses: {} }) : json({ success: false, error: 'high_demand' }, 503);
      }
      const paras = text.split(/\n\s*\n/);
      return json({ success: true, apiStatuses: {}, result: paras.map((p) => (p.trim() === BAD ? p : rewrite(p))).join('\n\n'),
        failedParts: paras.some((p) => p.trim() === BAD) ? [{ text: BAD, words: 16 }] : undefined });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { calls, errors };
}

async function run(page: Page, tool: 'paraphrase' | 'humanize') {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
  await page.evaluate((t) => { (window as any).switchTool(t); }, tool);
  await page.fill('#inputText', [P1, BAD, P3].join('\n\n'));
  await page.evaluate((t) => (window as any)[t](), tool);
}

const outText = (page: Page) => page.evaluate(() => (window as any).getCurrentOutputText ? (window as any).getCurrentOutputText() : document.getElementById('outputText')!.innerText);
const skipTyping = (page: Page) => page.evaluate(() => (document.getElementById('outputText') as HTMLElement).click());

for (const tool of ['paraphrase', 'humanize'] as const) {
  test(`${tool}: a failed part is retried automatically — no button when that works`, async ({ page }) => {
    const { calls, errors } = await setup(page, 0);
    await run(page, tool);
    await expect(page.locator('#statusMsg')).toContainText('Finishing part 1', { timeout: 15000 });
    await expect.poll(() => calls.length, { timeout: 15000 }).toBe(2);
    expect(String(calls[1].text).trim()).toBe(BAD);                                  // only that part was sent again
    await skipTyping(page);
    await expect.poll(async () => (await outText(page)).includes(rewrite(BAD)), { timeout: 15000 }).toBe(true);
    const out = await outText(page);
    expect(out.indexOf(rewrite(P1))).toBeLessThan(out.indexOf(rewrite(BAD)));
    expect(out.indexOf(rewrite(BAD))).toBeLessThan(out.indexOf(rewrite(P3)));
    await page.waitForTimeout(1500);
    await expect(page.locator('#pfPartialNotice')).toHaveCount(0);                  // the button never showed
    await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
    expect(calls.length).toBe(2);
    expect(errors).toEqual([]);
  });

  test(`${tool}: two failed automatic tries → marked, announced, and "Retry this part" re-sends only that part`, async ({ page }) => {
    const { calls, errors } = await setup(page, 2);
    await run(page, tool);
    await expect(page.locator('#pfPartialNotice')).toBeVisible({ timeout: 20000 });
    expect(calls.length).toBe(3);                                                    // the run + 2 automatic tries
    expect(calls.slice(1).every((c) => String(c.text).trim() === BAD)).toBe(true);
    await expect(page.locator('#pfPartialNotice')).toContainText('1 part couldn’t be paraphrased');
    await skipTyping(page);
    const mark = page.locator('#outputText mark.pf-unchanged');
    await expect(mark).toHaveCount(1);
    await expect(mark).toContainText('The second paragraph is the part');
    await page.getByRole('button', { name: 'Retry this part' }).click();
    await expect(page.locator('#pfPartialNotice')).toHaveCount(0);
    expect(calls.length).toBe(4);
    expect(String(calls[3].text).trim()).toBe(BAD);
    await skipTyping(page);
    const out = await outText(page);
    expect(out).toContain(rewrite(BAD));
    expect(out).toContain(rewrite(P1));
    expect(out).toContain(rewrite(P3));
    await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('paraphrase: a manual retry that fails again keeps the mark and says so', async ({ page }) => {
  const { calls, errors } = await setup(page, Infinity);
  await run(page, 'paraphrase');
  await expect(page.locator('#pfPartialNotice')).toBeVisible({ timeout: 20000 });
  expect(calls.length).toBe(3);
  await page.getByRole('button', { name: 'Retry this part' }).click();
  await expect(page.locator('#pfPartialNotice')).toContainText('Still couldn’t paraphrase this part');
  await expect(page.getByRole('button', { name: 'Retry this part' })).toBeEnabled();
  await skipTyping(page);
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(1);
  await page.waitForTimeout(2000);
  expect(calls.length).toBe(4);                                                      // no more automatic tries after a click
  expect(errors).toEqual([]);
});

test('a fully paraphrased result shows no notice, no mark and makes no extra calls', async ({ page }) => {
  const { calls } = await setup(page, 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
  await page.fill('#inputText', [P1, P3].join('\n\n'));
  await page.evaluate(() => (window as any).paraphrase());
  await expect(page.locator('#outputText')).toContainText('section', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('#pfPartialNotice')).toHaveCount(0);
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
  expect(calls.length).toBe(1);
});
