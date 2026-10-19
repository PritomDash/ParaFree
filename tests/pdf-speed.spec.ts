// PDF Tools loading speed (homepage tab + pdf-tools.html), under "Fast 3G" with 300 ms latency.
// Playwright's request interception turns the browser cache off, so this spec uses a small real
// HTTP server that behaves like Vercel: gzip, ETag revalidation for normal files, and the
// vercel.json header (Cache-Control: immutable, 1 year) for /lib/pdf-tools/*. /api/process is
// mocked by the server; GA, ads, fonts and photos are blocked at DNS level (no interception).
// PF_SPEED_ROOT=<checkout> measures another checkout (e.g. main, for "before" numbers) — the
// timing targets are only asserted for this checkout.
// Run: npx playwright test tests/pdf-speed.spec.ts
import { test, expect, Page, BrowserContext } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { AddressInfo } from 'net';

const ROOT = process.env.PF_SPEED_ROOT || process.cwd();
const CHECK_TARGETS = !process.env.PF_SPEED_ROOT;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
const BLOCK = ['www.googletagmanager.com', 'www.google-analytics.com', 'region1.google-analytics.com', 'pagead2.googlesyndication.com',
  'googleads.g.doubleclick.net', 'images.unsplash.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
test.use({ launchOptions: { args: ['--host-resolver-rules=' + BLOCK.map((h) => `MAP ${h} 0.0.0.0`).join(', ')] } });
test.setTimeout(240000);

// Fast 3G (DevTools preset throughput) with 300 ms latency
const FAST_3G = { offline: false, latency: 300, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };

let server: http.Server;
let base = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/api/process') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(req.method === 'GET' ? '{"ok":false}' : '{"success":true,"result":"ok","usedApi":"mock"}');
    }
    let file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const body = fs.readFileSync(file);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
    const headers: Record<string, string> = {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream', etag,
      'cache-control': url.pathname.startsWith('/lib/pdf-tools/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    if (/gzip/.test(String(req.headers['accept-encoding'])) && /text|javascript|json|svg/.test(headers['content-type'])) {
      headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function throttle(page: Page, on: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', on ? FAST_3G : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return cdp;
}

// Click the homepage PDF tab and time (ms) until the panel shows, and until PDF to Word can take a file.
async function timeHomeClick(page: Page) {
  return page.evaluate(() => new Promise<{ shell: number; ready: number }>((resolve, reject) => {
    const t0 = performance.now();
    let shell = -1;
    (document.getElementById('tab-pdf') as HTMLElement).click();
    const tick = () => {
      const now = performance.now() - t0;
      const host = document.getElementById('pfHomePdf');
      if (shell < 0 && host && !host.hidden && host.querySelectorAll('.pf-subtab').length === 5 && host.getBoundingClientRect().height > 0) shell = now;
      const panel = host && host.querySelector('#panel-pdf-to-word');
      const status = panel && panel.querySelector('[data-role="lib-status"]');
      const tools = (window as any).PFTools;
      if (shell >= 0 && panel && !(panel as HTMLElement).hidden && tools && tools['pdf-to-word'] && status && status.textContent) return resolve({ shell: Math.round(shell), ready: Math.round(now) });
      if (now > 60000) return reject(new Error('PDF tab never became ready'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function homepage(ctx: BrowserContext) {
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  return page;
}

const results: Record<string, number> = {};
const label = CHECK_TARGETS ? 'this branch' : 'PF_SPEED_ROOT';

test.describe(`PDF Tools speed (${label})`, () => {
  test('homepage: cold first click (no prefetch yet)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await homepage(ctx);
    await throttle(page, true);
    const t = await timeHomeClick(page);                       // well before the 3 s idle prefetch
    results.coldShell = t.shell; results.coldReady = t.ready;
    console.log(`[${label}] homepage cold: panel ${t.shell} ms, PDF to Word ready ${t.ready} ms`);
    // a file can actually be converted afterwards
    await page.locator('#panel-pdf-to-word input[type=file]').setInputFiles(path.join(process.cwd(), 'tests/fixtures/pdf-tools/text.pdf'));
    await throttle(page, false);
    await expect(page.locator('#panel-pdf-to-word [data-role="output"] h1')).toBeVisible({ timeout: 120000 });
    if (CHECK_TARGETS) {
      expect(t.shell, 'panel visible').toBeLessThan(300);
      expect(t.ready, 'PDF to Word ready (cold)').toBeLessThan(1500);
    }
    await ctx.close();
  });

  test('homepage: repeat visit (files cached)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const first = await homepage(ctx);
    await timeHomeClick(first);                                 // fills the cache
    await first.close();
    const page = await homepage(ctx);                           // repeat visit, same browser
    await throttle(page, true);
    const t = await timeHomeClick(page);
    results.repeatShell = t.shell; results.repeatReady = t.ready;
    console.log(`[${label}] homepage repeat visit: panel ${t.shell} ms, PDF to Word ready ${t.ready} ms`);
    if (CHECK_TARGETS) {
      expect(t.shell).toBeLessThan(300);
      expect(t.ready, 'PDF to Word ready (repeat visit)').toBeLessThan(300);
    }
    await ctx.close();
  });

  test('homepage: first click after the idle prefetch', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await homepage(ctx);
    const reqs: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/lib/pdf-tools/')) reqs.push(r.url()); });
    await page.waitForTimeout(2000);
    const early = reqs.length;
    await page.waitForTimeout(4500);                            // 3 s after load + idle
    const prefetched = reqs.length;
    await throttle(page, true);
    const t = await timeHomeClick(page);
    results.prefetchedReady = t.ready;
    console.log(`[${label}] homepage after prefetch: panel ${t.shell} ms, PDF to Word ready ${t.ready} ms (lib/pdf-tools requests before 2 s: ${early}, after idle: ${prefetched})`);
    if (CHECK_TARGETS) {
      expect(early, 'nothing PDF-related during page load').toBe(0);
      expect(prefetched, 'idle prefetch happened').toBeGreaterThan(0);
      expect(t.ready).toBeLessThan(600);
    }
    await ctx.close();
  });

  test('homepage: no prefetch with Save-Data or on 2G', async ({ browser }) => {
    test.skip(!CHECK_TARGETS, 'new behaviour only');
    for (const conn of [{ saveData: true, effectiveType: '4g' }, { saveData: false, effectiveType: '2g' }, { saveData: false, effectiveType: 'slow-2g' }]) {
      const ctx = await browser.newContext();
      await ctx.addInitScript((c) => { Object.defineProperty(navigator, 'connection', { get: () => c }); }, conn);
      const page = await ctx.newPage();
      const reqs: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/lib/pdf-tools/')) reqs.push(r.url()); });
      await page.goto(base + '/', { waitUntil: 'load' });
      await page.waitForTimeout(5500);
      expect(reqs, JSON.stringify(conn)).toEqual([]);
      await ctx.close();
    }
  });

  test('pdf-tools.html: cold load until PDF to Word can take a file', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await throttle(page, true);
    const t0 = Date.now();
    await page.goto(base + '/pdf-tools.html', { waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const panel = document.getElementById('panel-pdf-to-word');
      const s = panel && panel.querySelector('[data-role="lib-status"]');
      const tools = (window as any).PFTools;
      return panel && !panel.hidden && tools && tools['pdf-to-word'] && s && s.textContent;
    }, null, { timeout: 120000, polling: 'raf' });
    results.pageReady = Date.now() - t0;
    console.log(`[${label}] pdf-tools.html cold: PDF to Word ready ${results.pageReady} ms after navigation`);
    await ctx.close();
  });

  test.afterAll(() => {
    fs.mkdirSync(path.join(process.cwd(), 'tests', 'results'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'tests', 'results', `pdf-speed-${CHECK_TARGETS ? 'branch' : 'other'}.json`), JSON.stringify(results, null, 2));
  });
});
