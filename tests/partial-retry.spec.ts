// Page side of the Nov-4 restore (Nov 10): a part the AI couldn't paraphrase is never shown as if paraphrased. The
// API returns `failedParts` (that part's ORIGINAL text sits in the result); the page marks it, says "1 part couldn't
// be paraphrased", and ONE manual "Retry" button re-sends ONLY that part and splices the new text in. Nothing is ever
// re-sent on its own, the button is disabled while a request runs, a held Ctrl+Enter or a repeat click of the same
// finished text sends nothing, and the page never has two requests in flight (long documents go batch by batch).
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
// (Infinity = always fails). Every answer takes `delayMs`; `maxInFlight` is the most requests the page had open at once.
async function setup(page: Page, failRetries: number, delayMs = 150) {
  const ctx = page.context(), calls: any[] = [], errors: string[] = [], state = { inFlight: 0, maxInFlight: 0 };
  let retries = 0;
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      state.inFlight--;
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
  return { calls, errors, state };
}

async function open(page: Page, tool: 'paraphrase' | 'humanize') {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
  await page.evaluate((t) => { (window as any).switchTool(t); }, tool);
}
async function run(page: Page, tool: 'paraphrase' | 'humanize', text = [P1, BAD, P3].join('\n\n')) {
  await open(page, tool);
  await page.fill('#inputText', text);
  await page.evaluate((t) => (window as any)[t](), tool);
}

const outText = (page: Page) => page.evaluate(() => (window as any).getCurrentOutputText ? (window as any).getCurrentOutputText() : document.getElementById('outputText')!.innerText);
const skipTyping = (page: Page) => page.evaluate(() => (document.getElementById('outputText') as HTMLElement).click());
const idle = (page: Page) => page.waitForFunction(() => !(window as any).isLoading);

for (const tool of ['paraphrase', 'humanize'] as const) {
  test(`${tool}: a failed part keeps its original text, is marked, and is NOT re-sent on its own`, async ({ page }) => {
    const { calls, errors } = await setup(page, 0);
    await run(page, tool);
    await expect(page.locator('#pfPartialNotice')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#pfPartialNotice')).toContainText('1 part couldn’t be paraphrased');
    await expect(page.locator('#pfPartialNotice button')).toHaveCount(1);              // ONE manual button
    await skipTyping(page);
    await expect(page.locator('#outputText mark.pf-unchanged')).toContainText('The second paragraph is the part');
    await page.waitForTimeout(4000);                                                   // longer than the old 3 s auto-retry
    expect(calls.length).toBe(1);                                                      // nothing was sent again automatically
    expect(errors).toEqual([]);
  });

  test(`${tool}: "Retry" re-sends only that part and splices it in`, async ({ page }) => {
    const { calls, errors } = await setup(page, 0);
    await run(page, tool);
    await expect(page.locator('#pfPartialNotice')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#pfPartialNotice')).toHaveCount(0, { timeout: 15000 });
    expect(calls.length).toBe(2);
    expect(String(calls[1].text).trim()).toBe(BAD);
    await skipTyping(page);
    const out = await outText(page);
    expect(out.indexOf(rewrite(P1))).toBeLessThan(out.indexOf(rewrite(BAD)));
    expect(out.indexOf(rewrite(BAD))).toBeLessThan(out.indexOf(rewrite(P3)));
    await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('paraphrase: a manual retry that fails again keeps the mark, says so, and stops', async ({ page }) => {
  const { calls, errors } = await setup(page, Infinity);
  await run(page, 'paraphrase');
  await expect(page.locator('#pfPartialNotice')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#pfPartialNotice')).toContainText('Still couldn’t paraphrase this part', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await skipTyping(page);
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(1);
  await page.waitForTimeout(3000);
  expect(calls.length).toBe(2);                                                        // the run + the one click
  expect(errors).toEqual([]);
});

test('the Paraphrase button is disabled while a request runs; repeat clicks and a held Ctrl+Enter send ONE request', async ({ page }) => {
  const { calls, state } = await setup(page, 0, 1200);
  await open(page, 'paraphrase');
  await page.fill('#inputText', [P1, P3].join('\n\n'));
  await page.click('#paraphraseBtn');
  await expect(page.locator('#paraphraseBtn')).toBeDisabled();
  for (let i = 0; i < 5; i++) await page.evaluate(() => (window as any).paraphrase());   // the 6× in 15 s pattern
  await page.focus('#inputText');
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true })));
  await page.keyboard.up('Control');
  await idle(page);
  await expect(page.locator('#paraphraseBtn')).toBeEnabled();
  // a held key keeps sending repeat events after the answer arrived — still nothing new
  for (let i = 0; i < 3; i++) await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true })));
  // the same text again right after it finished: not re-sent, the page says why
  await page.evaluate(() => (window as any).paraphrase());
  await expect(page.locator('#statusMsg')).toContainText('Already done');
  await page.waitForTimeout(500);
  expect(calls.length).toBe(1);
  expect(state.maxInFlight).toBe(1);
  // a changed text runs normally
  await page.fill('#inputText', [P1, P3, 'One more sentence that makes this a different text for the test.'].join('\n\n'));
  await page.evaluate(() => (window as any).paraphrase());
  await expect.poll(() => calls.length, { timeout: 10000 }).toBe(2);
});

test('a long document (> 1,400 words) goes in ~1,200-word requests, strictly one at a time', async ({ page }) => {
  const { calls, state } = await setup(page, 0, 300);
  const long = Array.from({ length: 90 }, (_, i) => `Paragraph ${i} explains how students plan their weekly revision, test themselves with flashcards and take short breaks between sessions.`).join('\n\n');
  await open(page, 'paraphrase');
  await page.fill('#inputText', long);
  await page.evaluate(() => (window as any).paraphrase());
  await expect(page.locator('#outputText')).toContainText('learners', { timeout: 30000 });
  await idle(page);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.every((c) => String(c.text).split(/\s+/).length <= 1400)).toBe(true);
  expect(state.maxInFlight).toBe(1);                                                   // never two requests at once
});

test('a fully paraphrased result shows no notice, no mark and makes no extra calls', async ({ page }) => {
  const { calls } = await setup(page, 0);
  await run(page, 'paraphrase', [P1, P3].join('\n\n'));
  await expect(page.locator('#outputText')).toContainText('section', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('#pfPartialNotice')).toHaveCount(0);
  await expect(page.locator('#outputText mark.pf-unchanged')).toHaveCount(0);
  expect(calls.length).toBe(1);
});
