// GA4 custom events in the browser — index.html, cv-builder.html and code.html.
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk), so
// the live site is never touched. /api/process is MOCKED per test. google-analytics.com,
// googletagmanager.com and ad requests are BLOCKED so test runs never pollute GA.
// window.gtag is replaced by a recorder after load (same approach as donate.spec.ts).
// Run: npx playwright test tests/ga-events.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECRET = 'SECRET-PHRASE alice@example.com Alice Smith';

type Api = (body: any) => { status?: number; json?: any; body?: string };

async function serveLocal(page: Page, api: Api) {
  const blocked: string[] = [];
  const apiCalls: any[] = [];
  await page.route(BLOCKED, (route: Route) => { blocked.push(route.request().url()); return route.abort(); });
  await page.route('https://parafree.app/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push(body);
      const r = api(body);
      return route.fulfill({ status: r.status || 200, contentType: r.body !== undefined ? 'text/html' : 'application/json',
        body: r.body !== undefined ? r.body : JSON.stringify(r.json) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { blocked, apiCalls };
}

async function mockGtag(page: Page) {
  await page.evaluate(() => { (window as any).__ev = []; (window as any).gtag = (...a: any[]) => (window as any).__ev.push(a); });
}
const events = (page: Page) => page.evaluate(() => (window as any).__ev.filter((e: any[]) => e[0] === 'event' && e[1] !== 'donate_click').map((e: any[]) => [e[1], e[2]]));

// Never send user text/keywords/names to GA, whatever the test did.
async function expectNoPersonalData(page: Page) {
  const all = JSON.stringify(await page.evaluate(() => (window as any).__ev));
  expect(all).not.toMatch(/SECRET|alice|Smith|Hobart|Underwater Basket/i);
}

test.describe('GA4 events', () => {
  test('paraphrase success → tool_used; TXT download → result_download', async ({ page }) => {
    const net = await serveLocal(page, (b) => ({ json: { success: true, result: 'A freshly reworded version of the text that is long enough.', usedApi: 'mock' } }));
    await page.goto('/');
    await mockGtag(page);
    await page.fill('#inputText', SECRET + ' wrote this short paragraph about renewable energy and its many uses today.');
    expect(await events(page)).toEqual([]);
    await page.click('#paraphraseBtn');
    await expect.poll(() => events(page)).toEqual([['tool_used', { tool: 'paraphrase', input_type: 'text', word_bucket: '<300' }]]);
    const dl = page.waitForEvent('download');
    await page.click('#downloadBtn');
    await dl;
    await expect.poll(() => events(page)).toEqual([
      ['tool_used', { tool: 'paraphrase', input_type: 'text', word_bucket: '<300' }],
      ['result_download', { tool: 'paraphrase', format: 'txt' }],
    ]);
    expect(net.apiCalls.length).toBe(1);
    await expectNoPersonalData(page);
  });

  test('"All AI engines busy" → tool_error all_busy; Vercel timeout → timeout', async ({ page }) => {
    let mode = 'busy';
    await serveLocal(page, () => mode === 'busy'
      ? { status: 503, json: { success: false, error: 'high_demand', message: 'Our AI is at high demand right now.' } }
      : { status: 504, body: 'An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT' });
    await page.goto('/');
    await mockGtag(page);
    await page.fill('#inputText', SECRET + ' needs a rewrite of this paragraph about the ocean and its tides.');
    await page.click('#paraphraseBtn');
    await expect(page.locator('#statusMsg')).toContainText('All AI engines are busy');
    await expect.poll(() => events(page)).toEqual([['tool_error', { tool: 'paraphrase', error_type: 'all_busy' }]]);
    mode = 'timeout';
    await page.evaluate(() => (window as any).switchTool('summarize'));
    await page.fill('#inputText', SECRET + ' a long article to summarize about tides and the moon.');
    await page.click('#summarizeBtn');
    await expect.poll(() => events(page)).toEqual([
      ['tool_error', { tool: 'paraphrase', error_type: 'all_busy' }],
      ['tool_error', { tool: 'summarize', error_type: 'timeout' }],
    ]);
    await expectNoPersonalData(page);
  });

  test('ParaFree AI chat → tool_used ai_chat / tool_error', async ({ page }) => {
    let fail = false;
    await serveLocal(page, () => fail ? { status: 504, body: 'timeout' } : { json: { result: 'Here is a plain answer for you.', usedApi: 'mock' } });
    await page.goto('/');
    await mockGtag(page);
    await page.evaluate(() => (window as any).switchTool('ai'));
    await page.fill('#homeChatInput', SECRET + ' asks a question');
    await page.click('#homeSendBtn');
    await expect.poll(() => events(page)).toEqual([['tool_used', { tool: 'ai_chat', input_type: 'text', word_bucket: '<300' }]]);
    fail = true;
    await page.fill('#homeChatInput', SECRET + ' asks again');
    await page.click('#homeSendBtn');
    await expect.poll(() => events(page)).toEqual([
      ['tool_used', { tool: 'ai_chat', input_type: 'text', word_bucket: '<300' }],
      ['tool_error', { tool: 'ai_chat', error_type: 'timeout' }],
    ]);
    await expectNoPersonalData(page);
  });

  test('code.html → tool_used ai_code; empty/busy response → tool_error all_busy', async ({ page }) => {
    let busy = false;
    await serveLocal(page, () => busy
      ? { status: 503, json: { success: false, error: 'high_demand', message: 'busy' } }
      : { json: { result: 'Sure, here is how a for loop works in Python.', usedApi: 'mock' } });
    await page.goto('/code.html');
    await mockGtag(page);
    await page.fill('#chatInput', SECRET + ' explain loops');
    await page.click('#sendBtn');
    await expect.poll(() => events(page)).toEqual([['tool_used', { tool: 'ai_code', input_type: 'text', word_bucket: '<300' }]]);
    busy = true;
    await page.fill('#chatInput', SECRET + ' again');
    await page.click('#sendBtn');
    await expect.poll(() => events(page)).toEqual([
      ['tool_used', { tool: 'ai_code', input_type: 'text', word_bucket: '<300' }],
      ['tool_error', { tool: 'ai_code', error_type: 'all_busy' }],
    ]);
    await expectNoPersonalData(page);
  });

  test('cv-builder: job_search has_results true/false (no keywords), cv_download template+format', async ({ page }) => {
    let jobs: any[] = [{ title: 'Basket Weaver', company: 'Acme', location: 'Hobart', link: 'https://example.com/j/1', snippet: 'x' }];
    const net = await serveLocal(page, (b) => b.type === 'jobSearch' ? { json: { jobs, source: 'live' } } : { json: { success: false } });
    await page.goto('/cv-builder.html');
    await mockGtag(page);
    await page.evaluate(() => { clearTimeout((window as any)._jobAutoTimer); });
    await page.fill('#f-jobtitle', 'Underwater Basket Weaver');
    await page.evaluate(() => (window as any).runJobSearch());
    await expect.poll(() => events(page)).toContainEqual(['job_search', { has_results: true }]);
    jobs = [];
    await page.evaluate(() => (window as any).runJobSearch());
    await expect.poll(async () => (await events(page)).filter((e: any) => e[0] === 'job_search')).toEqual([
      ['job_search', { has_results: true }], ['job_search', { has_results: false }],
    ]);
    expect(net.apiCalls.every(c => c.type === 'jobSearch')).toBe(true);

    await page.evaluate(() => (window as any).setTemplate('modern-blue'));
    await page.fill('#f-name', 'Alice Smith');
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.evaluate(() => (window as any).downloadPDF());
    await dl;
    await expect.poll(async () => (await events(page)).filter((e: any) => e[0] === 'cv_download'))
      .toEqual([['cv_download', { template: 'modern-blue', format: 'pdf' }]]);
    await expectNoPersonalData(page);
  });

  test('GA blocked: tools still work, no page errors, no request reaches GA', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    const net = await serveLocal(page, () => ({ json: { success: true, result: 'Reworded output text for the reader here.', usedApi: 'mock' } }));
    await page.goto('/');
    await page.evaluate(() => { delete (window as any).gtag; });
    await page.fill('#inputText', 'A plain paragraph that should be paraphrased without analytics loaded at all.');
    await page.click('#paraphraseBtn');
    await expect(page.locator('#outputText')).toContainText('Reworded', { timeout: 15000 });
    expect(errors).toEqual([]);
    expect(net.blocked.some(u => /googletagmanager\.com/.test(u))).toBe(true);  // gtag.js was requested and aborted
  });
});
