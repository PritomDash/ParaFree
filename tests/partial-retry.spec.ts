// Phase 1, page side: a part the AI couldn't paraphrase is never shown as if paraphrased. The API returns
// `failedParts` (that part's ORIGINAL text sits in the result); the page marks it, says "1 part couldn't be
// paraphrased", and "Retry this part" re-sends ONLY that part and splices the new text in.
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

// mode 'retry-ok': first call fails BAD, the retry of BAD alone succeeds; 'retry-fails': BAD always fails
async function setup(page: Page, mode: 'retry-ok' | 'retry-fails') {
  const ctx = page.context(), calls: any[] = [], errors: string[] = [];
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
        return mode === 'retry-ok' ? json({ success: true, result: rewrite(BAD), apiStatuses: {} }) : json({ success: false, error: 'high_demand' }, 503);
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
  await expect(page.locator('#pfPartialNotice')).toBeVisible();
}

for (const tool of ['paraphrase', 'humanize'] as const) {
  test(`${tool}: a failed part is marked, announced and retried on its own`, async ({ page }) => {
    const { calls, errors } = await setup(page, 'retry-ok');
    await run(page, tool);
    await expect(page.locator('#pfPartialNotice')).toContainText('1 part couldn’t be paraphrased');
    await page.evaluate(() => (document.getElementById('outputText') as HTMLElement).click());   // skip the typing animation
    const mark = page.locator('#outputText mark.pf-unchanged');
    await expect(mark).toHaveCount(1);
    await expect(mark).toContainText('The second paragraph is the part');
    await expect(page.locator('#statusMsg, .status, [id*=status]').first()).toBeAttached();
    const before = calls.length;
    await page.getByRole('button', { name: 'Retry this part' }).click();
    await expect(page.locator('#pfPartialNotice')).toHaveCount(0);
    expect(calls.length).toBe(before + 1);
    expect(String(calls[calls.length - 1].text).trim()).toBe(BAD);                  // only that part was sent again
    await page.evaluate(() => (document.getElementById('outputText') as HTMLElement).click());
    const out = await page.evaluate(() => (window as any).getCurrentOutputText ? (window as any).getCurrentOutputText() : document.getElementById('outputText')!.innerText);
    expect(out).toContain(rewrite(BAD));
    expect(out).toContain(rewrite(P1));
    expect(out).toContain(rewrite(P3));
    expect(out.indexOf(rewrite(P1))).toBeLessThan(out.indexOf(rewrite(BAD)));
    expect(out.indexOf(rewrite(BAD))).toBeLessThan(out.indexOf(rewrite(P3)));
    await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('paraphrase: a retry that fails again keeps the mark and says so', async ({ page }) => {
  const { errors } = await setup(page, 'retry-fails');
  await run(page, 'paraphrase');
  await page.getByRole('button', { name: 'Retry this part' }).click();
  await expect(page.locator('#pfPartialNotice')).toContainText('Still couldn’t paraphrase this part');
  await expect(page.getByRole('button', { name: 'Retry this part' })).toBeEnabled();
  await page.evaluate(() => (document.getElementById('outputText') as HTMLElement).click());
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a fully paraphrased result shows no notice and no mark', async ({ page }) => {
  await setup(page, 'retry-ok');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
  await page.fill('#inputText', [P1, P3].join('\n\n'));
  await page.evaluate(() => (window as any).paraphrase());
  await expect(page.locator('#outputText')).toContainText('section', { timeout: 15000 });
  await expect(page.locator('#pfPartialNotice')).toHaveCount(0);
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
});
