// Homepage UX fixes (branch home-ux-fixes): the paraphraser right under a slim hero, 160+ countries everywhere,
// no named AI providers, one ParaFree AI promo, one "Paraphrase Now", lighter headline green, NEW only on PDF Tools,
// "Open Tool →" — and the paraphraser (5 modes), uploads (TXT/PDF/DOCX/DOC/PPTX), keeps-format Word/PPTX exports,
// tool tabs, FAQ, language selector and SEO content still work / are still there.
// Pages are served from THIS checkout; /api/process is MOCKED (never the live API); GA, ads, fonts and images are
// BLOCKED; CDN libraries are cached on disk. Run: npx playwright test tests/home-ux.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const BASE = 'ca69a8f';                                   // main before this round (cv-quality-fixes merge)
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
const FX = (f: string) => path.join(ROOT, 'tests', 'fixtures', f);
const PROVIDERS = /\b(Gemini|Groq|Cerebras|OpenRouter|Mistral|Cloudflare|NVIDIA|OVHcloud|SambaNova|DeepSeek|Llama|GLM)\b/;
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
// mocked AI: a few words swapped (so a "paraphrase" is visible in the output and the exported files), markers untouched
const SWAP: Record<string, string> = { produced: 'yielded', important: 'essential', grew: 'rose', fell: 'dropped', fox: 'wolf', jumps: 'leaps' };
const fakeParaphrase = (t: string) => String(t).replace(/\b(produced|important|grew|fell|fox|jumps)\b/g, (w) => SWAP[w]);
async function setup(page: Page) {
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.text
        ? { success: true, result: fakeParaphrase(body.text), usedApi: 'groq/openai/gpt-oss-120b', apiStatuses: { groq: 'success' } } : { success: false }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { errors, calls };
}
async function open(page: Page, w = 1280, h = 800) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
}
const lf = (s: string) => s.split('\r\n').join('\n');
const NOW = () => lf(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
const BEFORE = () => lf(execSync(`git show ${BASE}:index.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8'));
const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────
test.describe('1. tool first', () => {
  for (const [w, h] of [[1528, 730], [1280, 800], [1024, 700], [768, 900], [390, 844], [360, 780]]) {
    test(`${w}×${h}: mode selector, input box and the start of the output panel are on the first screen`, async ({ page }) => {
      const net = await setup(page);
      await open(page, w, h);
      const r = await page.evaluate(() => {
        const top = (s: string) => document.querySelector(s)!.getBoundingClientRect().top;
        return { modes: top('#paraphraseModes'), input: top('#inputText'), heroBottom: document.getElementById('mainHero')!.getBoundingClientRect().bottom,
          sw: document.documentElement.scrollWidth };
      });
      expect(r.modes, 'mode selector').toBeLessThan(h - 60);
      expect(r.input, 'input box starts on the first screen').toBeLessThan(h - 80);
      expect(r.heroBottom, 'slim hero').toBeLessThan(Math.max(480, h * 0.6));
      expect(r.sw, 'no horizontal scroll').toBeLessThanOrEqual(w);
      // the input box is usable straight away
      await page.locator('#inputText').fill('Type here right away.');
      await expect(page.locator('#inputCount')).toHaveText('4 words');
      expect(net.errors).toEqual([]);
    });
  }

  test('hero keeps headline + rating; the intro, trust points, CV link, stats, promos and features are below the tool', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await expect(page.locator('#mainHero h1')).toHaveText('ParaFreeParaphrase DocumentsWithout Losing Formatting');
    await expect(page.locator('#pfHeroRating')).toBeVisible();
    await expect(page.locator('#mainHero .cta-buttons, #heroScrollIndicator')).toHaveCount(0);
    const order = await page.evaluate(() => {
      const y = (s: string) => document.querySelector(s)!.getBoundingClientRect().top + scrollY;
      return ['#mainHero', '#tools', '#paraphraseModes', '.tool-container', '#paraphraseBtn', '#heroMore', '#statsStrip', '#promoBar', '#pfPdfPromo', '.features', '#keep-formatting'].map(y);
    });
    for (let i = 1; i < order.length; i++) expect(order[i], `section ${i} below section ${i - 1}`).toBeGreaterThan(order[i - 1]);
    await expect(page.locator('#heroMore')).toContainText('We paraphrase only the text — your colors, fonts, tables and design stay exactly the same.');
    await expect(page.locator('#heroMore a[href="/cv-builder.html"]')).toHaveText('Build Your CV');
    await expect(page.locator('#heroMore a[href="/best-free-paraphrasing-tool.html"]')).toHaveCount(1);
    expect(net.errors).toEqual([]);
  });

  test('SEO content kept: every heading, link, FAQ entry and structured-data block from before is still on the page', () => {
    const before = BEFORE(), now = NOW();
    const heads = (s: string) => [...s.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => textOf(m[2]).trim()).filter(Boolean);
    const hrefs = (s: string) => new Set([...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
    const missingHeads = heads(before).filter((h) => !heads(now).includes(h));
    expect(missingHeads).toEqual([]);
    const missingLinks = [...hrefs(before)].filter((h) => !hrefs(now).has(h));
    expect(missingLinks).toEqual([]);
    const count = (s: string, re: RegExp) => (s.match(re) || []).length;
    expect(count(now, /class="faq-item"/g)).toBe(count(before, /class="faq-item"/g));
    expect(count(now, /<details class="seo-section/g)).toBe(count(before, /<details class="seo-section/g));
    const types = (s: string) => jsonLd(s).map((j) => JSON.parse(j)['@type'] || JSON.parse(j)['@graph']?.length);
    expect(types(now)).toEqual(types(before));
    // the visible text is almost all still there (only the duplicated promo / repeated "free" lines went)
    expect(textOf(now).length).toBeGreaterThan(textOf(before).length * 0.97);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('2–6. stats, providers, promos, buttons, polish', () => {
  test('2. "160+ Countries" in the stats band, FAQ (+ its structured data), CTA and footer; no 8+ / 50+ countries left', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const stats = await page.locator('#statsStrip .stats-strip-inner > div').allInnerTexts();
    expect(stats.map((s) => s.replace(/\s+/g, ' ').trim())).toEqual(['50K+ Documents Paraphrased', '160+ Countries', '18 Languages Supported', '100% Free — No Paywall, Ever']);
    await expect(page.locator('.faq-a', { hasText: 'Used by students in 160+ countries.' })).toHaveCount(1);
    await expect(page.locator('text=Join students and professionals from 160+ countries using ParaFree.')).toHaveCount(1);
    await expect(page.locator('footer')).toContainText('Used by students in 160+ countries');
    const now = NOW();
    expect(now).not.toMatch(/\b(8|50)\+\s*countries/i);
    expect(now).not.toMatch(/>8\+</);
    expect(jsonLd(now).join('\n')).toContain('Used by students in 160+ countries.');
    expect(net.errors).toEqual([]);
  });

  test('3. no AI provider is named on the page (text, modals, structured data); the status bar says "multiple AI engines with automatic fallback"', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const html = NOW();
    // "ChatGPT, Claude, Gemini" = examples of AI text the humanizer rewrites, not engines ParaFree uses
    const scrub = (s: string) => s.replace(/ChatGPT, Claude,? Gemini/g, '');   // (also in the humanizer placeholder)
    expect(scrub(textOf(html)).match(PROVIDERS)).toBeNull();
    expect(scrub(jsonLd(html).join('\n')).match(PROVIDERS)).toBeNull();
    await expect(page.locator('.api-status')).toContainText('Multiple AI engines with automatic fallback');
    await expect(page.locator('.feature-card', { hasText: 'Multiple AI Engines' })).toContainText('Multiple AI engines with automatic fallback, so you always get results.');
    // after a paraphrase the label says "Done", not the engine that answered
    await page.locator('#inputText').fill('The quick brown fox jumps over the lazy dog near the river bank today.');
    await page.locator('#paraphraseBtn').click();
    await expect(page.locator('#outputText')).toContainText('wolf leaps');
    await expect(page.locator('#activeApiLabel')).toHaveText('Done');
    expect(scrub(await page.evaluate(() => document.body.innerText))).not.toMatch(PROVIDERS);
    expect(net.errors).toEqual([]);
  });

  test('4. one ParaFree AI promo (below the tool): no "Did you know?" card, no banner after a result; "free" lines thinned', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await expect(page.locator('#pfaiBanner, #aiPromoBanner')).toHaveCount(0);
    expect(NOW()).not.toMatch(/Did you know\?/);
    await expect(page.locator('#promoBar')).toContainText('ParaFree AI — create PPT, Word docs, PDFs, websites and more.');
    await page.locator('#inputText').fill('The quick brown fox jumps over the lazy dog near the river bank today.');
    await page.locator('#paraphraseBtn').click();
    await expect(page.locator('#outputText')).toContainText('wolf leaps');
    await page.waitForTimeout(3500);                                        // the old card appeared after 3 s
    expect(await page.locator('text=Your paraphraser has a powerful sibling').count()).toBe(0);
    // "free forever / no word limit / no signup": in the hero badge, the feature cards and the footer — not repeated around the tool
    await expect(page.locator('#mainHero')).toContainText('100% Free Forever · No Signup · No Watermark · No Word Limit');
    await expect(page.locator('.features')).toContainText('No Word Limit');
    await expect(page.locator('.features')).toContainText('Always Free');
    await expect(page.locator('footer')).toContainText('always free');
    for (const sel of ['#humanizerInfo', '#heroMore', '#promoBar']) expect(await page.locator(sel).innerText(), sel).not.toMatch(/free forever|no word limit|no signup|no paywall/i);
    expect(net.errors).toEqual([]);
  });

  test('5. one "Paraphrase Now" button, directly under the tool', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const btns = await page.evaluate(() => [...document.querySelectorAll('a,button')].filter((e) => /paraphrase now|start writing free/i.test(e.textContent || '')).map((e) => e.id));
    expect(btns).toEqual(['paraphraseBtn']);
    const gap = await page.evaluate(() => document.getElementById('paraphraseBtn')!.getBoundingClientRect().top - document.querySelector('.tool-container')!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(200);
    expect(net.errors).toEqual([]);
  });

  test('6. headline green meets AA (large text) on the hero; NEW only on PDF Tools; nav "Open Tool →" goes to the tool', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const color = await page.locator('#mainHero h1 span').last().evaluate((e) => getComputedStyle(e).color);
    expect(color).toBe('rgb(216, 243, 220)');
    // contrast against the hero overlay, even over a white image pixel (the overlay's lightest possible result)
    const L = (c: number[]) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: number[], b: number[]) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const over = (c: number[], a: number) => c.map((v) => v * a + 255 * (1 - a));
    for (const [c, a] of [[[10, 28, 20], 0.92], [[26, 58, 42], 0.88], [[45, 106, 79], 0.82]] as [number[], number][])
      expect(ratio([216, 243, 220], over(c, a))).toBeGreaterThanOrEqual(3);
    expect(ratio([216, 243, 220], over([26, 58, 42], 0.88))).toBeGreaterThanOrEqual(4.5);   // behind the centred headline
    expect(await page.locator('.tool-tabs .tab-new').evaluateAll((els) => els.map((e) => e.closest('.tool-tab')!.id))).toEqual(['tab-pdf']);
    await expect(page.locator('#navCta')).toHaveText('Open Tool →');
    await expect(page.locator('#navCta')).toHaveAttribute('href', '#tools');
    await page.locator('#navCta').click();
    await expect.poll(() => page.evaluate(() => Math.abs(document.getElementById('tools')!.getBoundingClientRect().top) < 120)).toBe(true);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('still working', () => {
  test('paraphraser: all 5 modes send their mode and show the result; language selector is sent', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const modes = await page.locator('#paraphraseModes .mode-btn').evaluateAll((b) => b.map((x) => [x.textContent, (x as HTMLElement).dataset.mode]));
    expect(modes).toEqual([['Standard', 'standard'], ['Fluency', 'fluency'], ['Creative', 'creative'], ['Formal', 'formal'], ['Simplify', 'simple']]);
    await page.locator('#langSelect').selectOption('spanish');
    for (const [label, mode] of modes as [string, string][]) {
      await page.locator('#paraphraseModes .mode-btn', { hasText: label }).click();
      await page.locator('#inputText').fill(`The ${label} fox jumps over the lazy dog near the river bank today.`);
      const n = net.calls.length;
      await page.locator('#paraphraseBtn').click();
      await expect(page.locator('#outputText')).toContainText(`The ${label} wolf leaps`);
      const sent = net.calls.slice(n).find((c) => c.text && c.text.includes(label));
      expect(sent, label).toBeTruthy();
      expect(sent.mode, label).toBe(mode);
      expect(sent.language, label).toBe('spanish');
    }
    expect(net.errors).toEqual([]);
  });

  test('uploads: TXT, PDF and DOCX fill the input; old .doc gets the "save as .docx" message; PPTX loads its slides', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const up = page.locator('#fileUpload');
    await up.setInputFiles(FX('pdf-tools/three-columns.txt'));
    await expect(page.locator('#inputText')).toHaveValue(/Science Fact Sheet/);
    await up.setInputFiles(FX('pdf-tools/text.pdf'));
    await expect.poll(() => page.locator('#inputText').inputValue(), { timeout: 60000 }).not.toMatch(/Science Fact Sheet/);
    expect((await page.locator('#inputText').inputValue()).trim().length).toBeGreaterThan(20);
    await up.setInputFiles(FX('pdf-tools/sample.docx'));
    await expect(page.locator('#inputText')).toHaveValue(/The experiment produced an important result/, { timeout: 30000 });
    await up.setInputFiles(FX('pdf-tools/old-format.doc'));
    await expect(page.locator('#statusMsg')).toContainText("Old .doc files aren't supported");
    await up.setInputFiles(FX('keep-unchanged.pptx'));
    await expect(page.locator('#statusMsg')).toContainText('PPTX loaded', { timeout: 30000 });
    expect(net.errors).toEqual([]);
  });

  test('keeps-format exports: DOCX upload → paraphrase → Word download has the new wording in the original document', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#fileUpload').setInputFiles(FX('pdf-tools/sample.docx'));
    await expect(page.locator('#inputText')).toHaveValue(/The experiment produced an important result/, { timeout: 30000 });
    await page.locator('#paraphraseBtn').click();
    await expect(page.locator('#outputText')).toContainText('yielded an essential result', { timeout: 60000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#downloadDOCXBtn').click()]);
    expect(dl.suggestedFilename()).toMatch(/\.docx$/i);
    const zip = await JSZip.loadAsync(fs.readFileSync((await dl.path())!));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('yielded an essential result');
    const orig = await (await JSZip.loadAsync(fs.readFileSync(FX('pdf-tools/sample.docx')))).file('word/document.xml')!.async('string');
    for (const tag of ['<w:pStyle', '<w:b/>', '<w:tbl>']) expect((xml.match(new RegExp(tag, 'g')) || []).length, tag).toBe((orig.match(new RegExp(tag, 'g')) || []).length);
    expect(net.errors).toEqual([]);
  });

  test('keeps-format exports: PPTX upload → paraphrase → PowerPoint download keeps every slide with the new wording', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#fileUpload').setInputFiles(FX('keep-unchanged.pptx'));
    await expect(page.locator('#statusMsg')).toContainText('PPTX loaded', { timeout: 30000 });
    await page.locator('#paraphraseBtn').click();
    await expect(page.locator('#outputText')).toContainText('rose strongly', { timeout: 90000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#downloadPPTXBtn').click()]);
    expect(dl.suggestedFilename()).toMatch(/\.pptx$/i);
    const zip = await JSZip.loadAsync(fs.readFileSync((await dl.path())!));
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort();
    expect(slides.length).toBe(3);
    const s1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(s1).toContain('rose strongly');
    expect(s1).toContain('dropped in every region');
    expect(await zip.file('ppt/slides/slide3.xml')!.async('string')).toContain('https://doi.org/10.1234/wt.2021');   // references untouched
    expect(net.errors).toEqual([]);
  });

  test('tool tabs, FAQ and TXT download still work', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    for (const [tab, wrap] of [['#tab-humanize', '#humanizeWrap'], ['#tab-summarize', '#summarizeWrap'], ['#tab-grammar', '#grammarWrap'], ['#tab-detect', '#detectWrap'], ['#tab-ai', '#aiWrap'], ['#tab-paraphrase', '#paraphraseWrap']]) {
      await page.locator(tab).click();
      await expect(page.locator(tab)).toHaveClass(/active/);
      await expect(page.locator(wrap)).toBeVisible();
    }
    await page.locator('#tab-pdf').click();
    await expect(page.locator('#pfHomePdf')).toBeVisible();
    await expect(page.locator('.tool-container')).toBeHidden();
    await page.locator('#tab-paraphrase').click();
    await expect(page.locator('.tool-container')).toBeVisible();
    // FAQ: an answer opens on click
    const q = page.locator('.faq-item').first();
    await q.locator('.faq-q').click();
    await expect(q.locator('.faq-a')).toBeVisible();
    // TXT download of a result
    await page.locator('#inputText').fill('The quick brown fox jumps over the lazy dog near the river bank today.');
    await page.locator('#paraphraseBtn').click();
    await expect(page.locator('#outputText')).toContainText('wolf leaps');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('#downloadBtn').click()]);
    expect(fs.readFileSync((await dl.path())!, 'utf8')).toContain('wolf leaps');
    expect(net.errors).toEqual([]);
  });
});
