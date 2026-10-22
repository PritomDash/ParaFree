// Landing-page embeds: the real paraphraser (index.html?embed=paraphraser) and CV builder (cv-builder.html?embed=1)
// inside landing pages, in lazy iframes (lib/embed-host.js).
// Pages are served from THIS checkout (requests to parafree.app are fulfilled from disk); /api/process is MOCKED
// (never the live API, never Jooble); GA, ads and fonts are BLOCKED; CDN libraries are cached on disk.
// Run: npx playwright test tests/landing-embeds.spec.ts
import { test, expect, Page, Route, Frame } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { BASE, lf, indexWithoutEmbed, cvBuilderWithoutEmbedChanges, pageWithoutEmbed } from './embed-original';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
};
test.setTimeout(180000);

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

const LANDING_EMBEDS = '0a0daee';                                   // the last landing-embeds commit
const atBase = (f: string, rev = BASE) => lf(execSync(`git show ${rev}:${f}`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8'));
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// every page with a "try it here" block, and what it embeds
const TOUCHED = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && read(f).includes('<!-- TRY THE TOOL HERE'));
const embedSrc = (f: string) => [...read(f).matchAll(/data-pf-embed="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const dataLayer = (f: Page | Frame) => f.evaluate(() => ((window as any).dataLayer || []).map((a: any) => JSON.parse(JSON.stringify(Array.from(a)))));
const RESULT = 'A freshly reworded version of the paragraph, long enough to count as a real answer from the tool.';

type Api = (body: any) => any;
async function setup(page: Page, api: Api = () => ({ success: false })) {
  const ctx = page.context();
  const requests: { url: string; bytes: number }[] = [], apiCalls: any[] = [], errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  ctx.on('request', (r) => requests.push({ url: r.url(), bytes: 0 }));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') { apiCalls.push({ type: 'GET ' + url.search }); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' }); }
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api(body)) });
    }
    // the same page as it was before this round (git, commit BASE): /__base/<file>
    // the homepage: today's index.html minus the embed code (so later, unrelated homepage changes don't count)
    if (url.pathname === '/__base/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: indexWithoutEmbed() });
    if (url.pathname.startsWith('/__base/')) return route.fulfill({ status: 200, contentType: 'text/html', body: atBase(url.pathname.slice(8)) });
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { requests, apiCalls, errors };
}

async function embedFrame(page: Page, re: RegExp): Promise<Frame> {
  await page.locator('[data-pf-embed]').first().scrollIntoViewIfNeeded();
  await expect(page.locator('[data-pf-embed] iframe')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('.pf-embed-loading')).toHaveCount(0, { timeout: 60000 });
  const f = page.frames().find((x) => re.test(x.url()))!;
  expect(f, 'embed frame').toBeTruthy();
  return f;
}


// visible top-level parts of the embedded homepage
const visibleParts = (f: Frame) => f.evaluate(() => [...document.body.children].filter((el) => {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return !/^(SCRIPT|STYLE|NOSCRIPT|LINK)$/.test(el.tagName) && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width * r.height > 0;
}).map((el) => el.id || '.' + el.className));

// ─────────────────────────────────────────────────────────────
test.describe('paraphraser embed (index.html?embed=paraphraser)', () => {
  test('embed mode shows only the tool card; noindex + canonical; no ads, no rating call, no second page view', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/free-bengali-paraphrasing-tool.html');
    await page.waitForLoadState('load');
    const f = await embedFrame(page, /embed=paraphraser/);
    expect(new URL(f.url()).search).toBe('?embed=paraphraser&tool=paraphraser&lang=bengali');
    await expect(page.locator('.pf-try .pf-try-full')).toHaveText('Open full tool ↗');
    await expect(page.locator('.pf-try .pf-try-full')).toHaveAttribute('href', '/?lang=bengali');
    // "Open full tool" sits above the embed
    expect(await page.evaluate(() => {
      const a = document.querySelector('.pf-try-full')!, e = document.querySelector('[data-pf-embed]')!;
      return a.getBoundingClientRect().bottom <= e.getBoundingClientRect().top;
    })).toBe(true);
    expect(await visibleParts(f)).toEqual(['langBar', 'paraphraseModes', '.tool-container', 'paraphraseWrap'])   // (the status bar has no height while empty);
    const t = await f.evaluate(() => {
      const vis = (sel: string) => { const el = document.querySelector(sel) as HTMLElement; return !!el && el.offsetParent !== null; };
      return {
        upload: vis('label[for=fileUpload]'), txt: vis('#downloadBtn'), docx: vis('#downloadDOCXBtn'), copy: vis('#copyBtn'),
        nav: vis('#mainNav'), hero: vis('#mainHero'), tabs: vis('.tool-tabs-wrap'), footer: vis('footer'), toTop: vis('#pf-scroll-top'),
        robots: [...document.querySelectorAll('meta[name=robots]')].map((m) => m.getAttribute('content')),
        canonical: document.querySelector('link[rel=canonical]')!.getAttribute('href'),
        adsPaused: ((window as any).adsbygoogle || {}).pauseAdRequests, embed: (window as any).PF_EMBED,
        htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      };
    });
    expect(t).toEqual({ upload: true, txt: true, docx: true, copy: true, nav: false, hero: false, tabs: false, footer: false, toTop: false,
      robots: ['index, follow', 'noindex, follow'], canonical: 'https://parafree.app/', adsPaused: 1, embed: 'paraphraser', htmlOverflow: 'hidden' });
    // the embedded homepage does not ask for the rating summary, and the 3 s PDF prefetch does not run
    await page.waitForTimeout(4500);
    expect(net.apiCalls).toEqual([]);
    expect(net.requests.map((r) => r.url).filter((u) => /\/lib\/pdf-tools\//.test(u))).toEqual([]);
    // GA: the landing page sent its page view; the embed sends none and tags its events with the landing page
    expect((await dataLayer(page)).filter((a) => a[0] === 'config')).toEqual([['config', 'G-0QEEGS0DZQ']]);
    const inner = await dataLayer(f);
    expect(inner.filter((a) => a[0] === 'config')).toEqual([['config', 'G-0QEEGS0DZQ', { send_page_view: false }]]);
    expect(inner.filter((a) => a[0] === 'set')).toEqual([['set', { embed_page: '/free-bengali-paraphrasing-tool.html' }]]);
    expect(net.errors).toEqual([]);
  });

  test('presets: language pages open in their language, the humanizer / detector posts open those tools, modes', async ({ page }) => {
    await setup(page);
    const open = async (file: string) => { await page.goto('/' + file); await page.waitForLoadState('load'); return embedFrame(page, /embed=paraphraser/); };
    let f = await open('free-bengali-paraphrasing-tool.html');
    expect(await f.inputValue('#langSelect')).toBe('bengali');
    f = await open('free-urdu-paraphrasing-tool.html');
    expect(await f.inputValue('#langSelect')).toBe('urdu');
    expect(await f.getAttribute('#outputText', 'dir')).toBe('rtl');
    f = await open('free-french-paraphrasing-tool.html');
    expect(await f.inputValue('#langSelect')).toBe('french');
    f = await open('free-paraphrasing-tool-philippines.html');
    expect(await f.inputValue('#langSelect')).toBe('tagalog');
    f = await open('blog-problem-with-ai-humanizers.html');
    expect(await visibleParts(f)).toEqual(['langBar', 'humanizeModes', '.tool-container', 'humanizeWrap']);
    expect(await f.locator('.panel-label').first().textContent()).toBe('AI Text Input');
    expect(await f.evaluate('currentTool')).toBe('humanize');
    f = await open('blog-truth-about-ai-detectors.html');
    expect(await visibleParts(f)).toEqual(['.tool-container', 'detectWrap']);
    f = await open('paraphrase-essay.html');
    await expect(f.locator('#paraphraseModes .mode-btn.active')).toHaveText('Formal');
    expect(await f.evaluate('currentMode')).toBe('formal');
    f = await open('blog-paraphrasing-for-esl-students.html');
    await expect(f.locator('#paraphraseModes .mode-btn.active')).toHaveText('Simplify');
    f = await open('paraphrase-word-document.html');
    expect(await f.inputValue('#langSelect')).toBe('english');
    await expect(f.locator('#paraphraseModes .mode-btn.active')).toHaveText('Standard');
    // summarizer and grammar (no landing page uses them yet): the URL presets work too
    for (const [tool, wrap] of [['summarizer', 'summarizeWrap'], ['grammar', 'grammarWrap'], ['humanizer', 'humanizeWrap']]) {
      await page.goto(`/?embed=paraphraser&tool=${tool}&mode=student`);
      await expect(page.locator('#' + wrap)).toBeVisible();
      await expect(page.locator('#paraphraseWrap')).toBeHidden();
      await expect(page.locator('#mainHero')).toBeHidden();
    }
    await expect(page.locator('[data-hmode=student]')).toHaveClass(/active/);
  });

  test('a paraphrase works inside the embed (mocked API), in the preset language; TXT download; GA events fire as normal', async ({ page }) => {
    const net = await setup(page, () => ({ success: true, result: RESULT, usedApi: 'mock' }));
    await page.goto('/free-bengali-paraphrasing-tool.html');
    await page.waitForLoadState('load');
    const f = await embedFrame(page, /embed=paraphraser/);
    await f.fill('#inputText', 'Renewable energy comes from sources that are naturally replenished, such as sunlight and wind.');
    await f.click('#paraphraseBtn');
    await expect(f.locator('#outputText')).toContainText('freshly reworded', { timeout: 30000 });
    const posts = net.apiCalls.filter((c) => !String(c.type || '').startsWith('GET'));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].language).toBe('bengali');
    const dl = page.waitForEvent('download');
    await f.click('#downloadBtn');
    expect((await dl).suggestedFilename()).toMatch(/\.txt$/);
    const ev = (await dataLayer(f)).filter((a) => a[0] === 'event').map((a) => [a[1], a[2]]);
    expect(ev).toEqual(expect.arrayContaining([
      ['tool_used', { tool: 'paraphrase', input_type: 'text', word_bucket: '<300' }],
      ['result_download', { tool: 'paraphrase', format: 'txt' }],
    ]));
    // the frame grew with the result and still has no inner scrollbar
    await expect.poll(() => f.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('CV builder embed on the CV landing pages (cv-builder.html?embed=1)', () => {
  test('the builder loads on ai-cv-builder.html, a CV can be filled and downloaded as PDF; one page view', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/ai-cv-builder.html');
    await page.waitForLoadState('load');
    await expect(page.locator('.pf-try .pf-try-full')).toHaveAttribute('href', '/cv-builder.html');
    const f = await embedFrame(page, /cv-builder\.html\?embed=1/);
    await f.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
    const shown = await f.evaluate(() => {
      const vis = (sel: string) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; };
      return { embed: document.documentElement.classList.contains('pf-embed'), nav: vis('body > nav'), hero: vis('.cv-hero'), footer: vis('body > footer'), builder: vis('#cvFormPanel') };
    });
    expect(shown).toEqual({ embed: true, nav: false, hero: false, footer: false, builder: true });
    await f.fill('#f-name', 'Alice Landing');
    await expect(f.locator('#cvPreviewPanel')).toContainText('Alice Landing');
    const dl = page.waitForEvent('download', { timeout: 90000 });
    await f.evaluate(() => (window as any).downloadPDF());
    const pdf = await dl;
    expect(pdf.suggestedFilename()).toMatch(/\.pdf$/i);
    expect(fs.readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await dataLayer(page)).filter((a) => a[0] === 'config')).toEqual([['config', 'G-0QEEGS0DZQ']]);
    const inner = await dataLayer(f);
    expect(inner.filter((a) => a[0] === 'config')).toEqual([['config', 'G-0QEEGS0DZQ', { send_page_view: false }]]);
    expect(inner.filter((a) => a[0] === 'set')).toEqual([['set', { embed_page: '/ai-cv-builder.html' }]]);
    expect(inner.filter((a) => a[0] === 'event').map((a) => a[1])).toContain('cv_download');
    expect(net.apiCalls.filter((c) => c.type === 'jobSearch')).toEqual([]);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('no double scrollbars', () => {
  for (const [w, h] of [[1280, 800], [360, 740]]) {
    for (const file of ['free-hindi-paraphrasing-tool.html', 'blog-common-mistakes.html', 'quillbot-alternative.html', 'student-cv-builder.html']) {
      test(`${w}px ${file}: one page scrollbar, the frame fits its content, nothing wider than the screen`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await setup(page);
        await page.goto('/' + file);
        await page.waitForLoadState('load');
        const cv = file.includes('cv');
        const f = await embedFrame(page, cv ? /cv-builder\.html\?embed=1/ : /embed=paraphraser/);
        if (cv) await f.waitForFunction(() => document.readyState === 'complete');
        await page.waitForTimeout(800);
        const outer = await page.evaluate(() => {
          const i = document.querySelector('[data-pf-embed] iframe') as HTMLIFrameElement, n = document.querySelector('body > nav') as HTMLElement;
          return { pageW: document.documentElement.scrollWidth, vw: innerWidth, frameH: i.offsetHeight, frameW: i.offsetWidth, vh: innerHeight,
            nav: n && /sticky|fixed/.test(getComputedStyle(n).position) ? n.offsetHeight : 0 };
        });
        const inner = await f.evaluate(() => ({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight,
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(outer.pageW, 'no horizontal page scroll').toBeLessThanOrEqual(outer.vw);
        expect(inner.sw, 'nothing wider than the frame').toBeLessThanOrEqual(inner.cw);
        expect(inner.sh - inner.ch, 'no inner page scrollbar').toBeLessThanOrEqual(1);
        if (cv && w <= 900) expect(outer.frameH, 'app mode: one screen under the nav').toBe(Math.max(320, outer.vh - outer.nav));
        else expect(Math.abs(outer.frameH - inner.sh), 'frame as tall as its content').toBeLessThanOrEqual(2);
        if (w === 360) expect(outer.frameW).toBeGreaterThanOrEqual(cv ? 320 : 300);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────
test.describe('without ?embed nothing changed', () => {
  test('index.html and cv-builder.html minus the embed additions are byte-for-byte the files before this round', () => {
    // index.html as this round left it (later rounds changed it on purpose: pdf-to-jpg); today's still has the one embed block
    expect(indexWithoutEmbed(atBase('index.html', LANDING_EMBEDS)) === atBase('index.html'), 'index.html').toBe(true);
    expect(() => indexWithoutEmbed()).not.toThrow();
    // cv-builder.html as this round left it (later rounds changed it on purpose: cv-conversion)
    expect(cvBuilderWithoutEmbedChanges(atBase('cv-builder.html', LANDING_EMBEDS)) === atBase('cv-builder.html'), 'cv-builder.html').toBe(true);
  });

  test('homepage without ?embed: same layout, GA calls and requests as before', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const net = await setup(page);
    const snapshot = async (url: string) => {
      const from = net.requests.length;
      await page.goto(url);
      await page.waitForLoadState('load');
      await page.waitForTimeout(4500);                                // past the 3 s idle prefetch
      const s = await page.evaluate(() => ({
        cls: document.documentElement.className,
        robots: [...document.querySelectorAll('meta[name=robots]')].map((m) => m.getAttribute('content')),
        layout: [...document.body.children].filter((el) => !/^(SCRIPT|STYLE)$/.test(el.tagName)).map((el) => {
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          return `${el.tagName}#${el.id}.${el.className} ${cs.display} ${cs.visibility} ${Math.round(r.height)}`;
        }),
        height: document.documentElement.scrollHeight,
        ga: ((window as any).dataLayer || []).map((a: any) => JSON.stringify(Array.from(a))).filter((a: string) => !a.includes('"js"')),
        ads: (window as any).adsbygoogle && (window as any).adsbygoogle.pauseAdRequests, embed: (window as any).PF_EMBED,
        lang: (document.getElementById('langSelect') as HTMLSelectElement).value,
      }));
      const reqs = net.requests.slice(from).map((r) => new URL(r.url)).filter((u) => u.hostname === 'parafree.app').map((u) => u.pathname + u.search).sort();
      return { ...s, reqs };
    };
    const now = await snapshot('/');
    const before = await snapshot('/__base/index.html');
    expect(now.reqs).toEqual(before.reqs.map((r) => r.replace('/__base/index.html', '/')).sort());
    expect({ ...now, reqs: 0 }).toEqual({ ...before, reqs: 0 });
    expect(now.reqs.filter((r) => r.includes('embed'))).toEqual([]);
    expect(now.reqs).toContain('/api/process?type=ratingSummary');
    expect(now.ga).toEqual(['["config","G-0QEEGS0DZQ"]']);
    // the one intended change: ?lang= now selects the language (it used to be ignored)
    expect((await snapshot('/__base/index.html?lang=bengali')).lang).toBe('english');
    expect((await snapshot('/?lang=bengali')).lang).toBe('bengali');
  });

  test('/?lang= selects the language: Bengali, Hindi, Urdu and Arabic (RTL output for Urdu and Arabic)', async ({ page }) => {
    const net = await setup(page);
    for (const [lang, dir] of [['bengali', 'ltr'], ['hindi', 'ltr'], ['urdu', 'rtl'], ['arabic', 'rtl']]) {
      await page.goto('/?lang=' + lang);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('#langSelect')).toHaveValue(lang);
      await expect(page.locator('#outputText')).toHaveAttribute('dir', dir);
      await expect(page.locator('#mainHero')).toBeVisible();                     // the normal homepage, not embed mode
    }
    await page.goto('/?lang=klingon');
    await expect(page.locator('#langSelect')).toHaveValue('english');
    await page.goto('/');
    await expect(page.locator('#langSelect')).toHaveValue('english');
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('touched pages: additive only', () => {
  test(`${TOUCHED.length} pages: removing the one embed block gives back the page as it was (title, H1, meta, JSON-LD, canonical, content)`, () => {
    expect(TOUCHED.length).toBe(74);
    for (const f of TOUCHED) {
      // as this round left the page (later rounds changed some footers on purpose); today's page still has the same block
      expect(pageWithoutEmbed(f, atBase(f, LANDING_EMBEDS)) === atBase(f), f).toBe(true);
      const blk = (x: string) => x.slice(x.indexOf('<!-- TRY THE TOOL HERE'), x.indexOf('<!-- /TRY THE TOOL HERE -->'));
      expect(blk(lf(read(f))) === blk(atBase(f, LANDING_EMBEDS)), f).toBe(true);
      const s = lf(read(f)), block = s.slice(s.indexOf('<!-- TRY THE TOOL HERE'), s.indexOf('<!-- /TRY THE TOOL HERE -->'));
      expect(block, f).not.toMatch(/ld\+json|rel="canonical"|<meta|<title|<h1|<h2/);
      for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(() => JSON.parse(m[1]), f).not.toThrow();
    }
  });

  test('each embed has "Open full tool ↗" above it; srcs and presets are what each page needs', () => {
    const want: Record<string, string> = {
      'free-bengali-paraphrasing-tool.html': '/?embed=paraphraser&tool=paraphraser&lang=bengali',
      'free-paraphrasing-tool-bangladesh.html': '/?embed=paraphraser&tool=paraphraser&lang=bengali',
      'free-arabic-paraphrasing-tool.html': '/?embed=paraphraser&tool=paraphraser&lang=arabic',
      'free-paraphrasing-tool-pakistan.html': '/?embed=paraphraser&tool=paraphraser&lang=urdu',
      'paraphrase-essay.html': '/?embed=paraphraser&tool=paraphraser&mode=formal',
      'blog-problem-with-ai-humanizers.html': '/?embed=paraphraser&tool=humanizer&size=compact',
      'blog-truth-about-ai-detectors.html': '/?embed=paraphraser&tool=detector&size=compact',
      'quillbot-alternative.html': '/?embed=paraphraser&tool=paraphraser&size=compact',
      'free-cv-builder-uk.html': '/cv-builder.html?embed=1',
    };
    for (const [f, src] of Object.entries(want)) expect(embedSrc(f), f).toEqual([src]);
    let embeds = 0, buttons = 0;
    for (const f of TOUCHED) {
      const s = read(f), srcs = embedSrc(f);
      if (!srcs.length) { buttons++; expect(s, f).toMatch(/class="pf-try pf-try-btn"/); continue; }
      embeds++;
      expect(srcs.length, f).toBe(1);
      const a = s.indexOf('Open full tool ↗'), e = s.indexOf('data-pf-embed=');
      expect(a > 0 && a < e, `${f}: "Open full tool ↗" before the embed`).toBe(true);
      expect(s, f).toContain('<script src="/lib/embed-host.js" defer></script>');
    }
    expect([embeds, buttons]).toEqual([56, 18]);
  });
});

// ─────────────────────────────────────────────────────────────
// Bytes are response bodies as served here (uncompressed; GA, ads and fonts are blocked so they are not counted).
const TOOL_CODE = /parafree\.app\/(\?|index\.html|cv-builder\.html|lib\/embed-paraphraser\.js|lib\/tool-events\.js|lib\/protect\.js|lib\/docx)|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net/;
test.describe('performance: no tool code before the embed is near view', () => {
  test('initial bytes before / after for 3 sample pages; the tool loads only near view', async ({ page }) => {
    const rows: string[] = [];
    const bytes: { url: string; n: number; initial: boolean }[] = [];
    let loaded = false;
    const started = new Map<any, boolean>();
    await setup(page);
    page.on('load', () => { loaded = true; });
    page.context().on('request', (r) => started.set(r, !loaded));            // initial load = requests started before the load event
    page.context().on('requestfinished', async (r) => { try { const b = await (await r.response())!.body(); bytes.push({ url: r.url(), n: b.length, initial: !!started.get(r) }); } catch (e) {} });
    const measure = async (url: string) => {
      bytes.length = 0; loaded = false;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const at = bytes.filter((b) => b.initial);
      return { total: at.reduce((a, b) => a + b.n, 0), tool: at.filter((b) => TOOL_CODE.test(b.url)).map((b) => b.url) };
    };
    for (const [w, h] of [[1280, 800], [360, 740]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const f of ['free-bengali-paraphrasing-tool.html', 'quillbot-alternative.html', 'ai-cv-builder.html']) {
        const before = await measure('/__base/' + f);
        const after = await measure('/' + f);
        expect(after.tool, `${f}: tool code during the initial load`).toEqual([]);
        expect(after.total - before.total, `${f}: added bytes`).toBeLessThan(7000);
        // then the embed: once near view (after load), the real tool loads
        await page.locator('[data-pf-embed]').scrollIntoViewIfNeeded();
        await expect(page.locator('.pf-embed-loading')).toHaveCount(0, { timeout: 60000 });
        await page.waitForTimeout(1500);
        const withTool = bytes.reduce((a, b) => a + b.n, 0);
        rows.push(`${w}px ${f}: before ${before.total} B, after ${after.total} B (+${after.total - before.total}), with the tool loaded ${withTool} B`);
      }
    }
    // a phone that has not scrolled: the embed below the first screen stays unloaded
    await page.setViewportSize({ width: 360, height: 520 });                 // embed top ≈ 925px: more than 300px below the screen
    await page.goto('/free-bengali-paraphrasing-tool.html', { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-pf-embed] iframe')).toHaveCount(0);
    await page.locator('[data-pf-embed]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-pf-embed] iframe')).toHaveCount(1);
    console.log('\n' + rows.join('\n'));
    fs.mkdirSync(path.join(ROOT, 'tests', 'results'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'results', 'landing-embeds-bytes.txt'), rows.join('\n') + '\n');
  });
});

// ─────────────────────────────────────────────────────────────
// cv_download must be sent after every successful CV PDF download: full page, homepage tab, CV landing page.
test.describe('cv_download after a successful PDF download', () => {
  for (const [where, url, embedPage] of [['full page', '/cv-builder.html', null], ['homepage tab', '/', '/'], ['CV landing page', '/free-cv-builder-australia.html', '/free-cv-builder-australia.html']] as const) {
    test(where, async ({ page }) => {
      const net = await setup(page);
      await page.goto(url);
      await page.waitForLoadState('load');
      let f: Page | Frame = page;
      if (url === '/') {
        await page.locator('#tab-cv').click();
        await expect(page.locator('#pfCvLoading')).toHaveCount(0, { timeout: 60000 });
        f = page.frame({ url: /cv-builder\.html\?embed=1/ })!;
      } else if (url !== '/cv-builder.html') f = await embedFrame(page, /cv-builder\.html\?embed=1/);
      await f.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
      await f.fill('#f-name', 'Alice Download');
      expect((await dataLayer(f)).filter((a) => a[1] === 'cv_download')).toEqual([]);
      const dl = page.waitForEvent('download', { timeout: 90000 });
      await f.locator('button[onclick^="downloadPDF("]').first().click();
      const pdf = await dl;
      expect(fs.readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
      await expect.poll(async () => (await dataLayer(f)).filter((a) => a[1] === 'cv_download')).toEqual([['event', 'cv_download', { template: 'classic', format: 'pdf', sample: 'false' }]]);
      const set = (await dataLayer(f)).filter((a) => a[0] === 'set');
      expect(set).toEqual(embedPage ? [['set', { embed_page: embedPage }]] : []);
      expect(net.errors).toEqual([]);
    });
  }
});
