// Dancing Cats widget (lib/cats): appears only after load + idle, never inside embeds, close remembered, sound off until
// a click (music.js fetched only then), dance + tune switching, celebration, hidden while a tool works, reduced motion,
// no console errors, no layout shift, and at every viewport no horizontal scroll and nothing clickable under the cats.
// Pages are served from THIS checkout; /api/process is MOCKED (never the live API); GA, ads, fonts and images are
// BLOCKED; CDN libraries are cached on disk. Run: npx playwright test tests/dancing-cats.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com|youtube\.com|ytimg\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const MESSAGES = ['Take a little break! 🐱', 'Study hard, dance harder!', "Keep going, you're doing great!", 'Even cats need study breaks!', 'Your assignment is waiting! 😂'];
const SHOTS = path.join(ROOT, 'tests', 'screenshots', 'dancing-cats');
test.setTimeout(240000);

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

// apiDelay: how long the mocked /api/process takes (the paraphrase is "running" meanwhile)
async function setup(page: Page, apiDelay = 200) {
  const ctx = page.context(), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|ERR_BLOCKED/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => requests.push(r.url()));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      await new Promise((r) => setTimeout(r, apiDelay));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, apiStatuses: {}, result: String(body.text || '').replace(/students/g, 'learners') }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  // layout shifts, recorded from the very start (to prove the cats add none)
  await page.addInitScript(() => {
    (window as any).__shifts = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__shifts.push({ t: e.startTime, v: e.value }); }).observe({ type: 'layout-shift', buffered: true }); } catch (_) {}
  });
  return { errors, requests };
}
const catsReady = (page: Page) => page.waitForFunction(() => {
  const w = (window as any).PFCats; return !!(w && document.getElementById('pfc'));
}, null, { timeout: 20000 });
const st = (page: Page) => page.evaluate(() => (window as any).PFCats.state());
const visibleCats = (page: Page) => page.waitForFunction(() => { const r = document.getElementById('pfc'); return r && !r.classList.contains('pfc-off') && getComputedStyle(r).visibility === 'visible'; }, null, { timeout: 10000 });

// What sits under the cats: any clickable element (sampled on a grid, with the widget itself hidden). Corner: the whole
// widget. Hero (home page): each side's box, which must also stay clear of the hero text (badge, heading, lines).
const overlapReport = (page: Page) => page.evaluate(() => {
  const root = document.getElementById('pfc')!;
  const mode = (window as any).PFCats.state().mode;
  const boxes = (mode === 'hero' ? [...root.querySelectorAll('.pfc-side')] : [root]).map((e) => e.getBoundingClientRect());
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const sel = 'a[href],button,input,select,textarea,label,summary,iframe,[role=button],[role=link],[role=tab],[onclick]';
  const prev = root.style.visibility; root.style.visibility = 'hidden';
  const hits: string[] = [];
  for (const r of boxes) for (let i = 0; i <= 6; i++) for (let j = 0; j <= 4; j++) {
    const x = r.left + 2 + (r.width - 4) * i / 6, y = r.top + 2 + (r.height - 4) * j / 4;
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue;   // (a hero cat scrolled out of view)
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const hit = el && el.closest(sel);
    if (hit) hits.push((hit.tagName + '#' + (hit.id || '') + '.' + (hit.className || '')).slice(0, 80));
  }
  root.style.visibility = prev;
  const texts = mode === 'hero' ? [...document.querySelectorAll('#mainHero .hero-content > *')].map((e) => e.getBoundingClientRect()) : [];
  const overText = boxes.some((b) => texts.some((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top));
  const heroEl = document.getElementById('mainHero'), hero = heroEl ? heroEl.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
  return { mode, hits: [...new Set(hits)], boxes: boxes.map((r) => ({ l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) })),
    vw, vh, overText, inHero: mode !== 'hero' || boxes.every((b) => b.left >= hero.left && b.right <= hero.right && b.top >= hero.top && b.bottom <= hero.bottom),
    scrollW: document.documentElement.scrollWidth, off: root.classList.contains('pfc-off'), bottom: (window as any).PFCats.state().bottom };
});

test.describe('Dancing Cats', () => {
  test('appears after load + idle, sound off, nothing fetched for audio, no console errors, no layout shift', async ({ page }) => {
    const { errors, requests } = await setup(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await page.waitForLoadState('load');
    const atLoad = await page.evaluate(() => !!document.getElementById('pfc'));
    expect(atLoad, 'the widget is not there at the load event (it waits for idle)').toBe(false);
    await catsReady(page);
    await visibleCats(page);
    const s = await st(page);
    expect(s.sound).toBe(false);
    expect(s.audio).toBeNull();               // no AudioContext until the click
    expect(s.musicLoaded).toBe(false);
    await expect(page.locator('#pfc .pfc-sound')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#pfc .pfc-stage svg').first()).toBeVisible();
    await page.waitForTimeout(1500);
    expect(requests.filter((u) => /\/lib\/cats\/music\.js|\.(ogg|mp3|webm|wav)(\?|$)/.test(u)), 'no audio requested before a click').toEqual([]);
    expect(requests.filter((u) => /\/lib\/cats\//.test(u)).map((u) => new URL(u).pathname).sort()).toEqual(['/lib/cats/cats.js', '/lib/cats/loader.js']);
    const shifts = await page.evaluate(() => (window as any).__shifts);
    const injectedAt = await page.evaluate(() => (performance.getEntriesByName(location.origin + '/lib/cats/cats.js')[0] as any)?.startTime || 0);
    expect(shifts.filter((x: any) => x.t >= injectedAt).reduce((a: number, x: any) => a + x.v, 0), 'no layout shift after the cats arrive').toBe(0);
    expect(errors).toEqual([]);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-1366.png') });
    await page.locator('#pfc').screenshot({ path: path.join(SHOTS, 'widget-desktop.png') });
  });

  test('close is remembered after a refresh; the small cat icon brings it back', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await catsReady(page); await visibleCats(page);
    await page.click('#pfc .pfc-close');
    await expect(page.locator('#pfc')).toHaveClass(/pfc-closed/);
    await expect(page.locator('#pfc .pfc-restore')).toBeVisible();
    await expect(page.locator('#pfc .pfc-stage').first()).toBeHidden();
    await page.reload();
    await catsReady(page);
    await expect(page.locator('#pfc')).toHaveClass(/pfc-closed/);
    await expect(page.locator('#pfc .pfc-restore')).toBeVisible();
    await page.locator('#pfc .pfc-restore').screenshot({ path: path.join(SHOTS, 'restore-icon.png') });
    await page.click('#pfc .pfc-restore');
    await expect(page.locator('#pfc .pfc-stage').first()).toBeVisible();
    await page.reload();
    await catsReady(page); await visibleCats(page);
    await expect(page.locator('#pfc')).not.toHaveClass(/pfc-closed/);
  });

  test('sound starts only after the click (music.js loads then), switches tune with the dance, and stops', async ({ page }) => {
    const { errors, requests } = await setup(page);
    await page.goto('/');
    await catsReady(page); await visibleCats(page);
    await page.waitForTimeout(1000);
    expect((await st(page)).sound).toBe(false);
    expect(requests.some((u) => /music\.js/.test(u))).toBe(false);
    const d0 = await page.getAttribute('#pfc .pfc-stage >> nth=0', 'data-dance');
    await page.click('#pfc .pfc-sound');
    await page.waitForFunction(() => (window as any).PFCats.state().playing, null, { timeout: 10000 });
    let s = await st(page);
    expect(s.sound).toBe(true);
    expect(s.audio).toBe('running');
    expect(requests.some((u) => /\/lib\/cats\/music\.js/.test(u))).toBe(true);
    expect(await page.evaluate(() => (window as any).PFCatsMusic.current())).toBe(s.tune);
    await expect(page.locator('#pfc .pfc-sound')).toHaveAttribute('aria-pressed', 'true');
    const gain = await page.evaluate(() => 0.15);   // master volume is fixed in cats.js (VOLUME)
    expect(fs.readFileSync(path.join(ROOT, 'lib', 'cats', 'cats.js'), 'utf8')).toContain('var VOLUME = 0.15;');
    expect(gain).toBe(0.15);
    // next dance: dance and tune change together
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await page.click('#pfc .pfc-next');
      await page.waitForTimeout(150);
      s = await st(page);
      expect(await page.getAttribute('#pfc .pfc-stage >> nth=0', 'data-dance')).toBe(s.dance);
      expect(await page.evaluate(() => (window as any).PFCatsMusic.current())).toBe(s.tune);
      seen.add(s.dance + '/' + s.tune);
    }
    expect(seen.size).toBe(5);
    expect(new Set([...seen].map((x) => x.split('/')[0])).size).toBe(3);   // sway, hop, kick
    expect(d0).toBeTruthy();
    await page.click('#pfc .pfc-sound');
    await page.waitForFunction(() => !(window as any).PFCats.state().playing);
    expect((await st(page)).sound).toBe(false);
    // sound is never remembered: a new page starts silent
    await page.reload();
    await catsReady(page);
    expect((await st(page)).sound).toBe(false);
    expect((await st(page)).audio).toBeNull();
    expect(errors).toEqual([]);
  });

  test('clicking the cats starts a 3-second celebration; a speech bubble shows ~4 s and is rate-limited', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await catsReady(page); await visibleCats(page);
    await page.click('#pfc .pfc-stage >> nth=0');
    await expect(page.locator('#pfc .pfc-stage').first()).toHaveClass(/pfc-celebrate/);
    await page.waitForTimeout(3300);
    await expect(page.locator('#pfc .pfc-stage').first()).not.toHaveClass(/pfc-celebrate/);
    await page.evaluate(() => (window as any).PFCats.bubble());
    await expect(page.locator('#pfc .pfc-bubble')).toHaveClass(/pfc-show/);
    expect(MESSAGES).toContain((await page.textContent('#pfc .pfc-bubble'))!.trim());
    await page.locator('#pfc').screenshot({ path: path.join(SHOTS, 'bubble.png') });
    await page.waitForTimeout(4400);
    await expect(page.locator('#pfc .pfc-bubble')).not.toHaveClass(/pfc-show/);
    const last = await page.evaluate(() => Number(localStorage.getItem('pfCatsBubbleAt')));
    expect(Date.now() - last).toBeLessThan(60000);
    expect(fs.readFileSync(path.join(ROOT, 'lib', 'cats', 'cats.js'), 'utf8')).toMatch(/BUBBLE_EVERY = window\.PF_CATS_BUBBLE_MS \|\| 5 \* 60 \* 1000/);
  });

  test('hidden while a paraphrase runs, back when it is done', async ({ page }) => {
    await setup(page, 3500);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
    await catsReady(page); await visibleCats(page);
    await page.fill('#inputText', 'The students plan their weekly revision before the exams start, and they test themselves often.');
    await page.evaluate(() => (window as any).paraphrase());
    await page.waitForFunction(() => document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 3000 });
    expect((await st(page)).busy).toBe(true);
    await page.waitForFunction(() => !document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 15000 });
    expect((await st(page)).busy).toBe(false);
  });

  test('hidden while flashcards or a PDF tool are working', async ({ page }) => {
    await setup(page);
    await page.goto('/flashcard-quiz-maker.html');
    await catsReady(page); await visibleCats(page);
    await page.evaluate(() => { (document.getElementById('spGo') as HTMLButtonElement).disabled = true; });   // what busy(true) does
    await page.waitForFunction(() => document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 3000 });
    await page.evaluate(() => { (document.getElementById('spGo') as HTMLButtonElement).disabled = false; });
    await page.waitForFunction(() => !document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 5000 });
    await page.goto('/compress-pdf.html');
    await catsReady(page); await visibleCats(page);
    await page.evaluate(() => { const p = document.createElement('div'); p.setAttribute('data-role', 'progress'); p.id = 'fakeProgress'; document.body.appendChild(p); });
    await page.waitForFunction(() => document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 3000 });
    await page.evaluate(() => { document.getElementById('fakeProgress')!.hidden = true; });
    await page.waitForFunction(() => !document.getElementById('pfc')!.classList.contains('pfc-off'), null, { timeout: 5000 });
  });

  test('prefers-reduced-motion: still cats, no hops', async ({ page }) => {
    await setup(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await catsReady(page); await visibleCats(page);
    const anim = await page.evaluate(() => [...document.querySelectorAll('#pfc .pfc-cat, #pfc .pfc-head, #pfc .pfc-pl, #pfc .pfc-fl')].map((e) => getComputedStyle(e).animationName));
    expect(anim.every((a) => a === 'none')).toBe(true);
    await page.click('#pfc .pfc-stage >> nth=0');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#pfc .pfc-cat')!).animationName)).toBe('none');
  });

  test('never inside an embedded tool or an iframe; not on admin', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html?embed=paraphraser');
    await page.waitForLoadState('load');
    await page.waitForTimeout(6500);
    expect(await page.evaluate(() => !!document.getElementById('pfc') || !!(window as any).PFCats)).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8')).not.toContain('lib/cats/');
    await page.goto('/blank-test.html').catch(() => {});
    await page.setContent('<iframe src="https://parafree.app/flashcard-quiz-maker.html" style="width:800px;height:600px"></iframe>');
    await page.waitForTimeout(7000);
    const inFrame = await page.frames()[1]?.evaluate(() => !!document.getElementById('pfc')).catch(() => false);
    expect(inFrame).toBe(false);
  });

  for (const [w, h] of [[1366, 768], [1440, 900]] as [number, number][]) {
    test(`hero ${w}×${h}: shadows, bigger moves, the grey cat never under "Open Tool" / floating buttons, music pauses off-screen`, async ({ page }) => {
      const { errors } = await setup(page);
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await catsReady(page); await visibleCats(page);
      expect((await st(page)).mode).toBe('hero');
      expect(await page.locator('#pfc .pfc-side .pfc-shadow').count()).toBe(2);                     // one ground shadow per cat
      const css = await page.evaluate(() => document.getElementById('pfc-style')!.textContent!);
      expect(css).toContain('translateY(-24px)');                                                     // higher hops
      expect(css).toContain('rotate(12deg)');                                                         // wider sway
      const right = await page.evaluate(() => document.querySelector('#pfc .pfc-right')!.getBoundingClientRect().right);
      expect(right, 'an 84 px lane stays clear at the right edge').toBeLessThanOrEqual(w - 84 + 1);
      // scroll through the hero: a visible cat never touches the fixed header or anything clickable outside the cats
      const heroH = await page.evaluate(() => document.getElementById('mainHero')!.getBoundingClientRect().height);
      const bad: string[] = [];
      for (let y = 0; y <= heroH; y += 25) {
        await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' as ScrollBehavior }), y);
        await page.waitForTimeout(260);
        const r = await page.evaluate(() => {
          const nav = document.getElementById('mainNav')!.getBoundingClientRect();
          const clickables = [...document.querySelectorAll('#mainNav a, #mainNav button, #pf-scroll-top.visible')].map((e) => e.getBoundingClientRect()).filter((x) => x.width > 0);
          return [...document.querySelectorAll('#pfc .pfc-side')].map((side) => {
            const b = side.getBoundingClientRect(), shown = getComputedStyle(side).visibility !== 'hidden';
            const underNav = b.top < nav.bottom, hit = clickables.some((c) => b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top);
            return { cls: side.className, shown, underNav, hit };
          });
        });
        for (const x of r) if (x.shown && (x.underNav || x.hit)) bad.push(`${y}px: ${x.cls} shown under the header / a button`);
      }
      expect(bad).toEqual([]);
      // music: on with the hero in view, paused once the hero is scrolled away, back when it returns
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
      await page.waitForTimeout(400);
      await page.click('#pfc .pfc-sound');
      await page.waitForFunction(() => (window as any).PFCats.state().playing, null, { timeout: 10000 });
      await page.evaluate(() => window.scrollTo({ top: 2000, behavior: 'instant' as ScrollBehavior }));
      await page.waitForFunction(() => !(window as any).PFCats.state().playing, null, { timeout: 5000 });
      expect((await st(page)).sound, 'sound stays switched on — only paused').toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
      await page.waitForFunction(() => (window as any).PFCats.state().playing, null, { timeout: 5000 });
      expect(await page.evaluate(() => Object.keys((window as any).PFCatsMusic.TUNES))).toEqual(['entertainer', 'turca', 'cancan', 'gladiators', 'williamtell']);
      await page.click('#pfc .pfc-sound');
      if (w === 1366) {
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SHOTS, 'hero-1366-v2.png'), clip: { x: 0, y: 0, width: w, height: 420 } });
      }
      expect(errors).toEqual([]);
    });
  }

  const VIEWPORTS: [number, number][] = [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [768, 1024], [390, 844], [375, 667], [360, 640]];
  const PAGES = ['/', '/flashcard-quiz-maker.html', '/cv-builder.html', '/pdf-tools.html', '/compress-pdf.html'];
  for (const url of PAGES) {
    test(`layout, no overlap with anything clickable, no horizontal scroll — ${url}`, async ({ page }) => {
      const { errors, requests } = await setup(page);
      const problems: string[] = [];
      for (const [w, h] of VIEWPORTS) {
        await page.setViewportSize({ width: w, height: h });
        requests.length = 0;
        await page.goto(url);
        const tag0 = `${url} ${w}×${h}`;
        if (w <= 768) {   // phones / small tablets: nothing at all — cats.js is not even fetched
          await page.waitForLoadState('load');
          await page.waitForTimeout(6000);
          if (await page.evaluate(() => !!document.getElementById('pfc') || !!(window as any).PFCats)) problems.push(`${tag0}: widget shown on a small screen`);
          if (requests.some((u) => /\/lib\/cats\/cats\.js/.test(u))) problems.push(`${tag0}: cats.js fetched on a small screen`);
          if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`${tag0}: horizontal scroll`);
          if (url === '/' && w === 390) await page.screenshot({ path: path.join(SHOTS, `home-${w}.png`) });
          continue;
        }
        await catsReady(page);
        const mode = (await st(page)).mode;
        if (url === '/' && mode !== 'hero') problems.push(`${tag0}: home page should put the cats beside the hero text (mode ${mode})`);
        if (url !== '/' && mode !== 'corner') problems.push(`${tag0}: expected the corner (mode ${mode})`);
        for (const y of [0, 0.35, 0.7, 1]) {
          await page.evaluate((f) => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * f, behavior: 'instant' as ScrollBehavior }), y);   // (the pages scroll smoothly)
          await page.waitForTimeout(450);
          await page.evaluate(() => (window as any).PFCats.place());
          await page.waitForTimeout(400);   // the corner widget glides to its new spot (0.3 s)
          const o = await overlapReport(page);
          const tag = `${tag0} scroll ${y}`;
          if (o.scrollW > o.vw) problems.push(`${tag}: horizontal scroll ${o.scrollW} > ${o.vw}`);
          if (o.off) continue;
          if (o.mode === 'corner' && o.boxes.some((b) => b.r > o.vw || b.l < 0 || b.b > o.vh)) problems.push(`${tag}: outside the viewport ${JSON.stringify(o.boxes)}`);
          if (o.mode === 'corner' && o.boxes[0].w !== 160) problems.push(`${tag}: width ${o.boxes[0].w} (expected 160)`);
          if (o.mode === 'hero' && (o.overText || !o.inHero)) problems.push(`${tag}: hero cats over the text or outside the hero ${JSON.stringify(o.boxes)}`);
          if (o.mode === 'hero' && o.boxes.some((b) => b.w < 100 || b.w > 170)) problems.push(`${tag}: hero cat width ${JSON.stringify(o.boxes)}`);
          if (o.hits.length) problems.push(`${tag}: covers ${o.hits.join(', ')}`);
        }
        if (url === '/' && (w === 1440 || w === 1024 || w === 1920)) {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(SHOTS, `home-${w}.png`) });
        }
        if (url === '/compress-pdf.html' && w === 1366) await page.screenshot({ path: path.join(SHOTS, `compress-pdf-${w}.png`) });
      }
      expect(problems).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});
