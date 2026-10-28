// The Humanizer's before / after "Naturalness (estimate)" (branch fix/humanizer-score). Both numbers come from the same
// check — estimateAIScore() in index.html — run on the text that was sent and on the text that came back; the "after"
// number used to be the "before" score × a random 10–30 %. The AI answer is mocked (no provider is called), GA and
// ads are blocked, CDN libraries come from the test cache. Run: npx playwright test tests/humanizer-score.spec.ts
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
test.setTimeout(120000);

// stiff, AI-sounding input: stock phrases and sentences of the same length
const INPUT = 'Furthermore, photosynthesis plays a crucial role in every plant on the planet. Moreover, it is important to note that light becomes chemical energy. ' +
  'Additionally, plants use carbon dioxide and water to make their sugar. In conclusion, this ensures that oxygen is released into the air. ' +
  'Therefore, scientists study this process closely in their many laboratories.';
// a plainer rewrite: no stock phrases, varied sentence length
const PLAIN = 'Plants turn light into food. Inside every leaf, sunlight drives a slow chain of reactions that splits water and pulls carbon dioxide from the air, building sugar the plant can store for later. ' +
  'Oxygen is what is left over. That is why scientists keep coming back to it: almost every food chain on Earth starts here, with a green leaf in the sun.';

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
// answer: what the mocked AI returns for the humanize request
async function setup(page: Page, answer: string, random?: number) {
  const ctx = page.context(), errors: string[] = [], calls: any[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.text ? { success: true, result: answer, usedApi: 'mock', apiStatuses: { groq: 'success' } } : { success: false }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  if (random !== undefined) await ctx.addInitScript((r) => { Math.random = () => r; }, random);
  return { errors, calls };
}
async function humanize(page: Page, input = INPUT) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).humanize === 'function' && document.readyState === 'complete');
  await page.locator('#tab-humanize').click();
  await page.locator('#inputText').fill(input);
  await page.locator('#humanizeBtn').click();
  await expect(page.locator('#scorePanel')).toHaveClass(/show/, { timeout: 30000 });
  const est = (t: string) => page.evaluate((x) => 100 - (window as any).estimateAIScore(x), t);
  return {
    before: +(await page.locator('#beforeNum').innerText()), after: +(await page.locator('#afterNum').innerText()),
    title: await page.locator('#scoreTitle').innerText(), status: await page.locator('#statusMsg').innerText(),
    panel: await page.locator('#scorePanel').innerText(), est,
  };
}

test.describe('Humanizer: the after-score is measured on the real output', () => {
  test('before = the estimate on the input, after = the same estimate on the text that came back', async ({ page }) => {
    const net = await setup(page, PLAIN);
    const r = await humanize(page);
    expect(r.before).toBe(await r.est(INPUT));
    expect(r.after).toBe(await r.est(PLAIN));
    expect(r.after).toBeGreaterThan(r.before);                    // the plain rewrite really does score better here
    expect(r.title).toContain('Reads More Naturally');
    expect(r.status).toBe(`✓ Done — naturalness estimate ${r.before} → ${r.after} / 100`);
    expect(net.calls.filter((c) => c.text)).toHaveLength(1);
    expect(net.errors).toEqual([]);
  });

  test('no random multiplier: Math.random forced to 0 and to 0.999 gives the same numbers', async ({ browser }) => {
    const out: number[][] = [];
    for (const rnd of [0, 0.999]) {
      const ctx = await browser.newContext({ baseURL: 'https://parafree.app' });
      const page = await ctx.newPage();
      await setup(page, PLAIN, rnd);
      const r = await humanize(page);
      out.push([r.before, r.after]);
      await ctx.close();
    }
    expect(out[0]).toEqual(out[1]);
  });

  test('an unchanged result scores the same as the input; a stiffer one scores lower (the old code always showed a big gain)', async ({ page }) => {
    await setup(page, INPUT);
    let r = await humanize(page);
    expect(r.after).toBe(r.before);
    expect(r.title).toContain('About the Same');
    const STIFFER = INPUT.replace('Therefore, scientists', 'It is worth noting that, due to the fact that it is pivotal, scientists consequently delve into it. Therefore, scientists');
    const page2 = await page.context().newPage();
    await setup(page2, STIFFER);
    r = await humanize(page2, PLAIN);
    expect(r.after).toBeLessThan(r.before);
    expect(r.title).toContain('Try Another Style');
  });

  test('wording: an estimate only — no "human", "undetectable" or "bypass", no detector promise', async ({ page }) => {
    await setup(page, PLAIN);
    const r = await humanize(page);
    for (const t of [r.status, r.panel]) expect(t).not.toMatch(/\bhuman\b|sounds human|undetectable|bypass|pass(es)? (ai )?detectors?/i);
    expect(r.panel).toContain('An estimate, not an AI-detector result.');
    expect(r.panel).toMatch(/Naturalness estimate: \d+ → \d+ \/ 100/);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toContain('sounds human now');
    expect(html).not.toMatch(/beforeScore \* \(0\.1 \+ Math\.random\(\)/);
    expect(html).not.toMatch(/<span class="score-pct">Human<\/span>|Humanization Complete|sound more human/);
  });
});
