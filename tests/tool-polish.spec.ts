// Homepage tool polish (branch fix/tool-polish), from live QA:
// 1. the paraphraser's result notes (naturalness meter, preview note, partial-output tip) never show in ParaFree AI or
//    any other tool; 2. the tip's wording is generic ("run it again"); 3. no provider/model name in the chat meta
//    (homepage and /code.html); 4. honest humanizer wording (no "100% human", no "% Human" meter, no detector promises);
// 5. AI Detector metric colours mean the same thing for all four metrics (+ legend).
// Pages are served from THIS checkout; /api/process is MOCKED (never the live API); GA, ads, fonts and images are
// BLOCKED; CDN libraries are cached on disk. Run: npx playwright test tests/tool-polish.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
const MODEL = 'groq-4/qwen/qwen3.8-27b';                   // what the API reports as usedApi — must never be shown
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
const rewrite = (t: string) => String(t).replace(/\bimportant\b/g, 'essential').replace(/\bshows\b/g, 'reveals');
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
      const result = body.type === 'code_assistant' ? 'Here is a short answer about photosynthesis.' : rewrite(body.text || '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.text
        ? { success: true, result, usedApi: MODEL, apiStatuses: { groq: 'success' } } : { success: false }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { errors, calls };
}
async function open(page: Page, w = 1280) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).paraphrase === 'function' && document.readyState === 'complete');
}
const TEXT = 'Photosynthesis is an important process for plants. It shows how light becomes chemical energy in the leaves. ' +
  'Plants use carbon dioxide and water to make sugar, and they release oxygen as a result of the process. ' +
  'Scientists study it closely because it is an important part of every food chain on the planet today.';
const NOTES = ['#humanScoreBadge', '#previewNote', '#tryAgainNote'];
async function paraphraseOnce(page: Page) {
  await page.locator('#tab-paraphrase').click();
  await page.locator('#inputText').fill(TEXT);
  await page.locator('#paraphraseBtn').click();
  await expect(page.locator('#outputText')).toContainText('essential');
  for (const sel of NOTES) await expect(page.locator(sel), sel).toBeVisible();
}

// ─────────────────────────────────────────────────────────────
test.describe('1–2. result notes only with their own result; generic tip', () => {
  test('after a paraphrase the three notes show; switching to ParaFree AI hides all three', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await paraphraseOnce(page);
    await page.locator('#tab-ai').click();
    await expect(page.locator('#aiWrap')).toBeVisible();
    for (const sel of NOTES) await expect(page.locator(sel), sel).toBeHidden();
    // still hidden after a chat answer
    await page.locator('#homeChatInput').fill('Explain photosynthesis briefly');
    await page.locator('#homeChatInput').press('Enter');
    await expect(page.locator('#aiWrap')).toContainText('Here is a short answer about photosynthesis.');
    for (const sel of NOTES) await expect(page.locator(sel), sel).toBeHidden();
    expect(net.errors).toEqual([]);
  });

  test('they do not carry over to Humanizer / Summarizer / Grammar / AI Detector either; the paraphraser still shows them', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    for (const tab of ['#tab-humanize', '#tab-summarize', '#tab-grammar', '#tab-detect']) {
      await paraphraseOnce(page);
      await page.locator(tab).click();
      for (const sel of NOTES) await expect(page.locator(sel), tab + ' ' + sel).toBeHidden();
    }
    await paraphraseOnce(page);                                                  // unaffected: shown again for a new result
    expect(net.errors).toEqual([]);
  });

  test('the partial-output tip is tool-neutral', async ({ page }) => {
    await setup(page);
    await open(page);
    await paraphraseOnce(page);
    await expect(page.locator('#tryAgainNote')).toHaveText('💡 Large documents may occasionally come out partial — just run it again and it\'ll complete.');
    expect(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')).not.toContain('just hit paraphrase again');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('3. no provider / model name in the chat', () => {
  test('homepage ParaFree AI: the answer meta has the time and Copy, no "via …"', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#tab-ai').click();
    await page.locator('#homeChatInput').fill('Explain photosynthesis briefly');
    await page.locator('#homeChatInput').press('Enter');
    const ai = page.locator('#aiWrap');
    await expect(ai).toContainText('Here is a short answer about photosynthesis.');
    const text = await ai.innerText();
    expect(text).not.toContain(MODEL);
    expect(text).not.toMatch(/\bvia\b/);
    expect(text).toMatch(/\b\d{1,2}:\d{2}\b/);                                    // timestamp kept
    await expect(ai.getByText('Copy', { exact: false }).first()).toBeVisible();   // Copy kept
    expect(net.calls.some((c) => c.type === 'code_assistant')).toBe(true);
    expect(net.errors).toEqual([]);
  });

  test('/code.html (standalone ParaFree AI) shows no provider tag either', () => {
    const html = fs.readFileSync(path.join(ROOT, 'code.html'), 'utf8');
    expect(html).not.toMatch(/via \$\{escapeHtml\(usedApi\)\}/);
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(idx).not.toMatch(/via \$\{usedApi\}/);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('4. humanizer: honest wording', () => {
  test('subheading, meter, placeholder, homepage card and score texts make no "100% human" / detector promises', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#tab-humanize').click();
    await expect(page.locator('#humanizerInfo p')).toHaveText('Paste ChatGPT, Claude or any AI text → we rewrite it to read more naturally');
    expect(await page.locator('#inputText').getAttribute('placeholder')).toContain('rewrite it to read more naturally');
    // meter: "Naturalness (estimate)" and "NN / 100", not "% Human"
    await paraphraseOnce(page);
    await expect(page.locator('#humanScoreBadge')).toContainText('Naturalness (estimate):');
    await expect(page.locator('#humanScoreText')).toHaveText(/^\d{2,3} \/ 100$/);
    // humanizer score panel: estimate wording, no detector promise
    // (before, after): both naturalness estimates from the same check — fix/humanizer-score
    for (const [after, title] of [[90, 'Reads More Naturally'], [75, 'Try Another Style']] as [number, string][]) {
      await page.evaluate((a) => (window as any).showScorePanel(80, a), after);
      await expect(page.locator('#scoreTitle')).toContainText(title);
      const panel = await page.locator('#scorePanel').innerText();
      expect(panel).not.toMatch(/pass AI detectors|% human|Highly Human|Low AI Score/i);
    }
    await expect(page.locator('#scoreDesc')).toContainText('/ 100');
    // the whole homepage
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/100% human|% Human'|Beat AI Detection|very likely to pass AI detectors|significantly reduces AI detection scores/i);
    await expect(page.locator('h3', { hasText: 'Make AI Text Read Naturally' })).toHaveCount(1);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('5. AI Detector metric colours', () => {
  const RED = 'rgb(230, 57, 70)', AMBER = 'rgb(244, 162, 97)', GREEN = 'rgb(45, 106, 79)';
  test('high vocabulary richness is green (natural), not red; the other three keep "higher = more AI-like"; legend shown', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#tab-detect').click();
    // short, varied, plain human text: every word different → vocabulary richness 100%
    await page.locator('#inputText').fill('My grandmother grew tomatoes behind her small brick house near the river. Every summer we picked them together, laughing whenever bees chased us around wooden fences.');
    await page.locator('#detectBtn').click();
    const rows = page.locator('.det-metric');
    await expect(rows).toHaveCount(4);
    const read = async () => rows.evaluateAll((els) => els.map((e) => [e.querySelector('.det-metric-label span')!.textContent, e.querySelector('.det-metric-pct')!.textContent, getComputedStyle(e.querySelector('.det-metric-pct')!).color]));
    const r = await read();
    const vocab = r.find((x) => x[0] === 'Vocabulary Richness')!;
    expect(vocab[1]).toBe('100%');
    expect(vocab[2]).toBe(GREEN);
    await expect(page.locator('.det-legend')).toContainText('natural');
    await expect(page.locator('.det-legend')).toContainText('AI-like');
    await expect(page.locator('.det-legend')).toContainText('for vocabulary richness, higher is more natural');
    // the rule for every metric, straight from calculateMetrics: colour by AI-likeness
    const cases = await page.evaluate(() => {
      const m = (window as any).calculateMetrics;
      const repetitive = 'It is important to note that the system works. Furthermore the system works. Moreover the system works. Additionally the system works. In conclusion the system works. Therefore the system works.';
      return m(repetitive).map((x: any) => [x.label, x.value, x.color]);
    });
    const colourOf = (v: number) => (v >= 65 ? '#e63946' : v >= 35 ? '#f4a261' : '#2d6a4f');
    for (const [label, value, color] of cases) {
      const aiLike = label === 'Vocabulary Richness' ? 100 - value : value;
      expect(color, label).toBe(colourOf(aiLike));
    }
    expect(cases.find((c: any) => c[0] === 'AI Phrases Detected')[2]).toBe('#e63946');   // lots of AI phrases → red
    expect([RED, AMBER, GREEN]).toContain(r[0][2]);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// fix/humanizer-consistency: the humanizer guide's comparison table names no competitor and makes no detection-evasion
// claim; the remaining "sound naturally human" wording is gone (homepage, about, QuillBot-alternative page).
test.describe('6. humanizer consistency', () => {
  test('humanizer guide: a ParaFree-only facts table — no competitor names or prices, detector results "not guaranteed"', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.evaluate(() => (window as any).showBlog('b2'));
    const post = page.locator('#blogContent');
    await expect(post).toBeVisible();
    await expect(post.locator('h2', { hasText: 'What the ParaFree AI Humanizer Offers' })).toHaveCount(1);
    const rows = await post.locator('table').last().locator('tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent!.trim())));
    expect(rows).toEqual([
      ['Price', 'Free'],
      ['Sign-up', 'Not needed'],
      ['Word limit', 'No word limit'],
      ['Writing styles', 'Natural, Student, Professional, Casual'],
      ['AI-detector results', 'Not guaranteed — results vary by detector, so always review the text'],
    ]);
    const text = await post.innerText();
    expect(text).not.toMatch(/Undetectable|HIX|Bypass|\$\d|vs Paid Alternatives|naturally human|real person|Why AI Detectors Flag|AI detection score/i);
    await expect(post.locator('h2', { hasText: 'Why AI Text Can Sound Robotic' })).toHaveCount(1);
    expect(text).toContain('it is not a way to hide that AI was used');
    expect(net.errors).toEqual([]);
  });

  test('no "sound naturally human" / "Natural Human Text" wording left on the homepage, About or the QuillBot-alternative page', async ({ page }) => {
    for (const f of ['index.html', 'about.html', 'quillbot-alternative.html']) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(html, f).not.toMatch(/naturally human|Natural Human Text|human-sounding|Undetectable\.ai|HIX Bypass/i);
    }
    await setup(page);
    await open(page);
    await expect(page.locator('#tab-humanize')).toHaveAttribute('title', 'Free AI Humanizer — Make ChatGPT and AI text read more naturally');
    await expect(page.locator('#tab-humanize')).toHaveAttribute('aria-label', 'Free AI Humanizer - Make AI Text Read More Naturally');
    const ld = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' '));
    expect(ld).not.toMatch(/naturally human|Natural Human|human-sounding/i);
    expect(ld).toContain('AI Humanizer - Make AI Text Read More Naturally');
  });
});
