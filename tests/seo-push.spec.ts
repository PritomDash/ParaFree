// seo-push: three task pages with tool presets, contextual internal links, link-preview images, AI-style FAQs,
// "Last updated", llms and sitemap. Pages are served from THIS checkout; /api/* must never be called; GA, ads and
// fonts are BLOCKED; CDN libraries are cached on disk.
// Run (one file at a time): npx playwright test tests/seo-push.spec.ts --workers=1
import { test, expect, Page, Route, Locator } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdf-tools');
const fx = (n: string) => path.join(FIX, n);
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BASE = '288e751';                                              // the site before this round (v2.17 merge; main has this round since v2.18)
const before = (f: string) => { try { return execSync(`git show ${BASE}:${f}`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8'); } catch (e) { return ''; } };
const TOOL_PAGES = ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf', 'pdf-to-jpg'];
const TASK_PAGES = ['compress-pdf-to-100kb', 'compress-pdf-to-200kb', 'jpg-to-pdf-for-assignment'];
const GUIDES = ['blog-pdf-to-word-without-losing-formatting', 'blog-compress-pdf-upload-limits', 'blog-ats-friendly-cv-guide'];
const htmlPages = () => fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
const decode = (x: string) => x.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const links = (s: string) => [...s.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() }));
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
async function setup(page: Page) {
  const ctx = page.context();
  const net = { api: [] as string[], errors: [] as string[] };
  page.on('pageerror', (e) => net.errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      net.api.push(url.pathname + url.search);
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      return route.fulfill({ status: 500, body: '{"error":"api must not be called"}' });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return net;
}
const role = (p: Locator, r: string) => p.locator(`[data-role="${r}"]`);
async function ready(p: Locator) { await expect(role(p, 'lib-status')).toHaveText('Ready', { timeout: 60000 }); }
async function download(page: Page, button: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return fs.readFileSync((await d.path())!);
}

// ─────────────────────────────────────────────────────────────
test.describe('task pages open the tool with the right preset', () => {
  for (const [slug, target, label] of [['compress-pdf-to-100kb', '100000', '100 KB'], ['compress-pdf-to-200kb', '200000', '200 KB']]) {
    test(`${slug}: Target size preset to ${label}; compressing a photo PDF lands under it (or says it can't)`, async ({ page }) => {
      const net = await setup(page);
      await page.goto(`/${slug}.html`);
      const p = page.locator('#panel-compress-pdf');
      await expect(p).toBeVisible();
      await ready(p);
      await expect(p.locator('input[name="pf-compress-mode"][value="target"]')).toBeChecked();
      await expect(role(p, 'target-row')).toBeVisible();
      await expect(role(p, 'target')).toHaveValue(target);
      await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
      await role(p, 'go').click();
      await expect(role(p, 'result')).toBeVisible({ timeout: 200000 });
      const summary = (await role(p, 'summary').textContent()) || '';
      if (/— under /.test(summary)) {
        expect(summary).toContain(`under ${label}.`);
        expect((await download(page, role(p, 'dl-pdf'))).length).toBeLessThanOrEqual(+target);
      } else expect(summary).toContain(`Couldn’t get this PDF under ${label}.`);
      // the user can still change the preset
      await role(p, 'target').selectOption('1000000');
      await expect(role(p, 'target')).toHaveValue('1000000');
      expect(net.api).toEqual([]);
      expect(net.errors).toEqual([]);
    });
  }

  test('jpg-to-pdf-for-assignment: A4, portrait, small margins preset; the PDF has A4 portrait pages', async ({ page }) => {
    const net = await setup(page);
    await page.goto('/jpg-to-pdf-for-assignment.html');
    const p = page.locator('#panel-jpg-to-pdf');
    await ready(p);
    await expect(role(p, 'opt-size')).toHaveValue('a4');
    await expect(role(p, 'opt-orientation')).toHaveValue('portrait');
    await expect(role(p, 'opt-margin')).toHaveValue('small');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('shot.png')]);
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 90000 });
    const buf = await download(page, role(p, 'dl-pdf'));
    const sizes = await page.evaluate(async (b64) => {
      const L = await (window as any).PFLoad.pdfLib();
      const doc = await L.PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      return doc.getPages().map((pg: any) => [Math.round(pg.getWidth()), Math.round(pg.getHeight())]);
    }, buf.toString('base64'));
    expect(sizes).toEqual([[595, 842], [595, 842]]);
    expect(net.errors).toEqual([]);
  });

  test('the plain tool pages keep their own defaults (no preset)', async ({ page }) => {
    await setup(page);
    await page.goto('/compress-pdf.html');
    const p = page.locator('#panel-compress-pdf');
    await ready(p);
    await expect(p.locator('input[name="pf-compress-mode"][value="light"]')).toBeChecked();
    await expect(role(p, 'target-row')).toBeHidden();
    expect(read('compress-pdf.html')).not.toContain('data-pf-preset');
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('internal links', () => {
  // page → [target, anchor text] added in this round (anchor texts all different, descriptive)
  const ADDED: [string, string, string][] = [
    ['paraphrase-pdf.html', '/pdf-to-word.html', 'convert the PDF into an editable Word document'],
    ['paraphrase-pdf.html', '/word-to-pdf.html', 'save the Word file as a PDF again'],
    ['paraphrase-word-document.html', '/pdf-to-word.html', 'Turn the PDF into a Word file'],
    ['paraphrase-word-document.html', '/word-to-pdf.html', 'export the result as a PDF'],
    ['paraphrase-word-document-keep-formatting.html', '/pdf-to-word.html', 'Convert it to an editable .docx that keeps headings, fonts and tables'],
    ['paraphrase-document-online-keep-format.html', '/word-to-pdf.html', 'Convert the Word download to PDF'],
    ['paraphrase-document-online-keep-format.html', '/pdf-to-word.html', 'make a PDF editable in Word'],
    ['free-paraphrasing-tool-students.html', '/word-to-pdf.html', 'Convert your .docx to PDF for Moodle, Canvas or Turnitin'],
    ['free-paraphrasing-tool-south-africa.html', '/compress-pdf.html', 'compress it for the upload limit'],
    ['cv-builder.html', '/compress-pdf-to-200kb.html', 'Compress your CV PDF to under 200 KB'],
    ['cv-builder.html', '/compress-pdf.html', 'choose any other size'],
    ['ats-resume-builder.html', '/compress-pdf-to-200kb.html', 'Compress your CV to under 200 KB'],
    ['pdf-to-word.html', '/word-to-pdf.html', 'Turn the .docx back into a PDF'],
    ['pdf-to-word.html', '/compress-pdf.html', 'shrink the PDF to a target size'],
    ['word-to-pdf.html', '/merge-pdf.html', 'merge the PDFs in the right order'],
    ['word-to-pdf.html', '/compress-pdf.html', 'compress the PDF under that limit'],
    ['jpg-to-pdf.html', '/compress-pdf.html', 'compress the finished PDF to a target size'],
    ['jpg-to-pdf.html', '/merge-pdf.html', 'merge it with the photo PDF'],
    ['jpg-to-pdf.html', '/jpg-to-pdf-for-assignment.html', 'The assignment version of this tool'],
    ['compress-pdf.html', '/jpg-to-pdf.html', 'turn the photos into one PDF'],
    ['compress-pdf.html', '/merge-pdf.html', 'merged into a single PDF'],
    ['compress-pdf.html', '/compress-pdf-to-100kb.html', 'getting a scanned form under 100 KB'],
    ['compress-pdf.html', '/compress-pdf-to-200kb.html', 'getting a CV or application PDF under 200 KB'],
    ['merge-pdf.html', '/word-to-pdf.html', 'Convert the .docx to PDF'],
    ['merge-pdf.html', '/compress-pdf.html', 'compress it to the portal’s limit'],
    ['pdf-to-jpg.html', '/pdf-to-word.html', 'convert the PDF to an editable Word file'],
    ['pdf-to-jpg.html', '/jpg-to-pdf.html', 'Combine the images into a PDF'],
    ['blog-pdf-to-word-without-losing-formatting.html', '/blog-compress-pdf-upload-limits.html', 'how to compress a PDF for upload limits'],
    ['blog-pdf-to-word-without-losing-formatting.html', '/blog-ats-friendly-cv-guide.html', 'making a CV that applicant tracking systems can read'],
    ['blog-pdf-to-word-without-losing-formatting.html', '/pdf-to-jpg.html', 'Save PDF pages as JPG images'],
    ['blog-compress-pdf-upload-limits.html', '/compress-pdf-to-100kb.html', '100 KB compression page'],
    ['blog-compress-pdf-upload-limits.html', '/compress-pdf-to-200kb.html', '200 KB page for job portals'],
    ['blog-compress-pdf-upload-limits.html', '/blog-pdf-to-word-without-losing-formatting.html', 'how to convert a PDF to Word without losing formatting'],
    ['blog-compress-pdf-upload-limits.html', '/blog-ats-friendly-cv-guide.html', 'the ATS-friendly CV guide'],
    ['blog-ats-friendly-cv-guide.html', '/compress-pdf-to-200kb.html', 'compress the CV PDF to under 200 KB'],
    ['blog-ats-friendly-cv-guide.html', '/blog-compress-pdf-upload-limits.html', 'the guide to PDF upload limits'],
    ['blog-ats-friendly-cv-guide.html', '/blog-pdf-to-word-without-losing-formatting.html', 'Convert it to Word without losing the formatting'],
    ['index.html', '/pdf-to-word.html', 'Turn a PDF into an editable Word file'],
    ['index.html', '/compress-pdf.html', 'shrink a PDF for an upload limit'],
  ];

  test('every contextual link added in this round is there, in a sentence, with its own anchor text', () => {
    for (const [f, href, text] of ADDED) {
      const l = links(read(f)).find((x) => x.href === href && decode(x.text) === text);
      expect(l, `${f} → ${href} "${text}"`).toBeTruthy();
      expect(links(before(f)).some((x) => x.href === href && decode(x.text) === text), `${f}: new in this round`).toBe(false);
    }
    // each paraphraser page has one sentence to the PDF tools; each CV page one to the compressor
    const PARA = ['paraphrase-pdf', 'paraphrase-word-document', 'paraphrase-word-document-keep-formatting', 'paraphrase-document-online-keep-format',
      'free-paraphrasing-tool-students', 'free-paraphrasing-tool-australia', 'free-paraphrasing-tool-usa', 'free-paraphrasing-tool-bangladesh',
      'free-paraphrasing-tool-egypt', 'free-paraphrasing-tool-india', 'free-paraphrasing-tool-kenya', 'free-paraphrasing-tool-nigeria',
      'free-paraphrasing-tool-pakistan', 'free-paraphrasing-tool-philippines', 'free-paraphrasing-tool-south-africa'];
    const CV = ['cv-builder', 'ai-cv-builder', 'ats-resume-builder', 'cv-builder-no-signup', 'cv-maker-free-download', 'cv-templates', 'student-cv-builder',
      'free-cv-builder-australia', 'free-cv-builder-canada', 'free-cv-builder-international-students', 'free-cv-builder-uk', 'free-cv-builder-usa'];
    const anchors: string[] = [];
    for (const f of [...PARA, ...CV]) {
      const s = read(f + '.html'), m = s.match(/<p class="pf-xlink"[^>]*>([\s\S]*?)<\/p>/g);
      expect(m && m.length, f).toBe(1);
      const ls = links(m![0]);
      expect(ls.length, f).toBeGreaterThanOrEqual(1);
      for (const l of ls) expect(l.href, f).toMatch(PARA.includes(f) ? /^\/(pdf-to-word|word-to-pdf|compress-pdf)\.html$/ : /^\/compress-pdf(-to-200kb)?\.html$/);
      anchors.push(...ls.map((l) => l.text));
      expect(m![0].replace(/<[^>]+>/g, '').split(/\s+/).length, `${f}: a sentence, not a bare link`).toBeGreaterThan(10);
    }
    expect(new Set(anchors).size, 'anchor texts are varied').toBeGreaterThanOrEqual(20);
    // the 6 tool pages link at least two other tools inside their body text (not counting the related box)
    for (const t of TOOL_PAGES) {
      const body = read(t + '.html').split('<div class="pf-content">')[1].split('<section class="pf-section pf-related">')[0];
      const tools = new Set(links(body).map((l) => l.href).filter((h) => /^\/(pdf-to-word|word-to-pdf|jpg-to-pdf|compress-pdf|merge-pdf|pdf-to-jpg)\.html$/.test(h) && h !== `/${t}.html`));
      expect(tools.size, t).toBeGreaterThanOrEqual(2);
    }
  });

  test('every internal link on every page resolves to a file', () => {
    const bad: string[] = [];
    for (const f of htmlPages()) {
      for (const { href } of links(read(f))) {
        if (!href.startsWith('/') || href.startsWith('//')) continue;
        const p = href.split(/[?#]/)[0];
        const file = p === '/' ? 'index.html' : p.slice(1);
        if (!fs.existsSync(path.join(ROOT, file))) bad.push(`${f} → ${href}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('homepage: "Working with PDFs?" by the upload button (hidden in the embed); PDF tab links each tool’s own page', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    const hint = page.locator('.tool-container .pf-pdf-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Working with PDFs?');
    await page.locator('#tab-pdf').click();
    const own = page.locator('#pfHomePdf .pf-home-page');
    await expect(own).toHaveText('Guide & tips: PDF to Word →', { timeout: 60000 });
    await expect(own).toHaveAttribute('href', '/pdf-to-word.html');
    await page.locator('#pfHomePdf [data-pftab="compress-pdf"]').click();
    await expect(own).toHaveAttribute('href', '/compress-pdf.html');
    await expect(own).toHaveText('Guide & tips: Compress PDF →');
    await expect(page.locator('#pfHomePdf .pf-home-full')).toHaveAttribute('href', '/pdf-tools.html#compress-pdf');
    await page.goto('/?embed=paraphraser');
    await expect(page.locator('.tool-container')).toBeVisible();
    await expect(page.locator('.pf-pdf-hint')).toBeHidden();
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('structured data, titles, previews, freshness', () => {
  test('JSON-LD parses on every page; tool and task pages: FAQPage = visible FAQ; +3 AI-style questions on each tool page; no ratings', () => {
    for (const f of htmlPages()) for (const m of read(f).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(() => JSON.parse(m[1]), f).not.toThrow();
    for (const t of [...TOOL_PAGES, ...TASK_PAGES]) {
      const s = read(t + '.html');
      const ld = [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      expect(ld.map((x) => x['@type']), t).toEqual(['WebApplication', 'FAQPage', 'BreadcrumbList']);
      expect(ld[0].offers.price, t).toBe('0');
      expect(JSON.stringify(ld), t).not.toMatch(/aggregateRating|ratingValue|"@type":"Review"/);
      const vq = [...s.matchAll(/<p class="faq-q">([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]));
      const va = [...s.matchAll(/<p class="faq-a">([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]));
      expect(ld[1].mainEntity.map((q: any) => q.name), t).toEqual(vq);
      expect(ld[1].mainEntity.map((q: any) => q.acceptedAnswer.text), t).toEqual(va);
      expect(s, t).toContain(`<link rel="canonical" href="https://parafree.app/${t}.html">`);
      if (TOOL_PAGES.includes(t)) {
        const old = [...before(t + '.html').matchAll(/<p class="faq-q">/g)].length;
        expect(vq.length - old, `${t}: new questions`).toBeGreaterThanOrEqual(3);
        expect(vq.slice(-3).every((q) => /^(How|Can|Will|Should|Is|Does|Why|What)\b.*\?$/.test(q)), t).toBe(true);
      }
    }
  });

  test('titles and descriptions are unique; existing titles and H1s unchanged; honest copy on the new pages', () => {
    const titles = new Map<string, string>(), descs = new Map<string, string>();
    for (const f of htmlPages()) {
      const s = read(f);
      const t = s.match(/<title>([\s\S]*?)<\/title>/)?.[1], d = s.match(/<meta name="description" content="([^"]*)"/)?.[1];
      if (/noindex/.test(s.match(/<meta name="robots" content="([^"]*)"/)?.[1] || '')) continue;
      if (t) { expect(titles.get(t), `${f} title duplicates ${titles.get(t)}`).toBeUndefined(); titles.set(t, f); }
      if (d) { expect(descs.get(d), `${f} description duplicates ${descs.get(d)}`).toBeUndefined(); descs.set(d, f); }
      const old = before(f);
      if (old) {
        expect(s.match(/<title>([\s\S]*?)<\/title>/)?.[1], f).toBe(old.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
        const h1 = (x: string) => x.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/\sstyle="[^"]*"/g, '');   // text + tags (styles may change)
        expect(h1(s), f).toBe(h1(old));
      }
    }
    for (const t of TASK_PAGES) {
      const s = read(t + '.html');
      expect(s.match(/<h1[\s>]/g)!.length, t).toBe(1);
      const body = s.split('<main class="pf-tools">')[1].split('<footer')[0].replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ');
      expect(body.split(/\s+/).filter(Boolean).length, t).toBeGreaterThanOrEqual(800);
      for (const re of [/\bbest\b/i, /#1/, /\bonly\b/i, /guarantee/i, /quillbot|ilovepdf|smallpdf|adobe|sejda|zety|\bcanva\b|novoresume/i]) expect(body.match(re)?.[0], `${t} ${re}`).toBeUndefined();
    }
    // the three task pages are genuinely different: no long sentence is shared between them
    const sentences = (t: string) => new Set(read(t + '.html').split('<div class="pf-content">')[1].split('pf-related')[0].replace(/<[^>]+>/g, ' ').split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter((x) => x.length > 60 && x !== 'No upload, no waiting — your file is processed on your device.'));   // (the shared privacy line repeats on purpose)
    const [a, b, c] = TASK_PAGES.map(sentences);
    const shared = [...a].filter((x) => b.has(x) || c.has(x)).concat([...b].filter((x) => c.has(x)));
    expect(shared).toEqual([]);
  });

  test('link-preview images: 1200×630 PNGs, one per tool page, task page, CV builder and homepage, referenced by og:image and twitter:image', () => {
    const want: Record<string, string> = { 'index.html': 'home', 'cv-builder.html': 'cv-builder' };
    for (const t of [...TOOL_PAGES, ...TASK_PAGES]) want[t + '.html'] = t;
    for (const [f, img] of Object.entries(want)) {
      const file = path.join(ROOT, 'og', img + '.png');
      expect(fs.existsSync(file), img).toBe(true);
      const b = fs.readFileSync(file);
      expect(b.subarray(1, 4).toString(), img).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)], img).toEqual([1200, 630]);
      expect(b.length, img).toBeLessThan(200000);
      const s = read(f), url = `https://parafree.app/og/${img}.png`;
      expect(s, f).toContain(`<meta property="og:image" content="${url}">`);
      expect(s, f).toContain(`<meta name="twitter:image" content="${url}">`);
      expect(s, f).toContain('<meta property="og:image:width" content="1200">');
    }
  });

  test('"Last updated" is visible on tool pages and guides', async ({ page }) => {
    await setup(page);
    for (const t of [...TOOL_PAGES, ...TASK_PAGES]) {
      await page.goto(`/${t}.html`);
      await expect(page.locator('.pf-updated'), t).toHaveText('Last updated: October 22, 2026');
    }
    for (const g of GUIDES) {
      await page.goto(`/${g}.html`);
      await expect(page.locator('.article-meta'), g).toContainText('Last updated: October 22, 2026');
      const art = [...read(g + '.html').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'Article');
      expect(art.dateModified, g).toBe('2026-10-22');
    }
  });

  test('sitemap valid with the new pages; llms files list them and the concrete use cases', () => {
    const sm = read('sitemap.xml');
    expect((sm.match(/<url>/g) || []).length).toBe((sm.match(/<\/url>/g) || []).length);
    const locs = [...sm.matchAll(/<loc>https:\/\/parafree\.app\/([^<]*)<\/loc>/g)].map((m) => m[1] || 'index.html');
    expect(new Set(locs).size).toBe(locs.length);
    for (const l of locs) expect(fs.existsSync(path.join(ROOT, l)), l).toBe(true);
    for (const t of TASK_PAGES) expect(sm).toMatch(new RegExp(`<loc>https://parafree\\.app/${t}\\.html</loc>\\s*<lastmod>2026-10-22</lastmod>`));
    const llms = read('llms.txt'), full = read('llms-full.txt');
    for (const t of TASK_PAGES) { expect(llms, t).toContain(`https://parafree.app/${t}.html`); expect(full, t).toContain(`https://parafree.app/${t}.html`); }
    expect(llms).toContain('A student needs to compress a PDF under a portal\'s size limit');
    // (existing page titles such as "Best Free CV Builder 2026" are link names, not claims)
    for (const s of [llms, full]) expect(s.replace(/\[[^\]]*\]\(https:\/\/parafree\.app\/best-free[^)]*\)|https:\/\/parafree\.app\/best-free\S*/g, '')).not.toMatch(/\bonly free\b|\bthe only\b|\bbest\b|#1/i);
  });
});
