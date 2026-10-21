// PDF tool landing pages, guides, CV copy, llms.txt / robots.txt / IndexNow, site-wide SEO checks.
// Pages are served from THIS checkout; /api/* is answered locally (never the live API); GA and ads are
// blocked; CDN libraries are cached on disk. IndexNow is only ever run with --dry-run.
// Run: npx playwright test tests/pdf-seo.spec.ts
import { test, expect, Page, Route, Locator } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import JSZip from 'jszip';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdf-tools');
const fx = (name: string) => path.join(FIX, name);
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
test.setTimeout(240000);

const TOOLS = ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf'];
const TITLES: Record<string, string> = {
  'pdf-to-word': 'Free PDF to Word Converter — Editable, Keeps Fonts & Columns | No Signup',
  'word-to-pdf': 'Free Word to PDF Converter — DOCX to PDF for Assignment Submission',
  'jpg-to-pdf': 'Free JPG to PDF — Combine Photos of Notes into One PDF',
  'compress-pdf': 'Compress PDF to 100KB, 200KB, 500KB or 1MB — Free, No Signup',
  'merge-pdf': 'Merge PDF Files Free — Combine Assignment, Cover Sheet & Appendix',
};
const GUIDES = ['blog-pdf-to-word-without-losing-formatting.html', 'blog-compress-pdf-upload-limits.html', 'blog-ats-friendly-cv-guide.html'];
const ENTITY = 'ParaFree is a free AI writing suite with a document paraphraser that keeps formatting, a CV builder with ATS-readable PDFs, and in-browser PDF tools (PDF to Word, Word to PDF, JPG to PDF, compress and merge).';
const SPEED = 'No upload, no waiting — your file is processed on your device.';
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const htmlPages = () => fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
const ldBlocks = (s: string) => [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const flat = (x: any): any[] => (Array.isArray(x) ? x.flatMap(flat) : x && x['@graph'] ? x['@graph'].flatMap(flat) : [x]);

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
  const apiCalls: string[] = [], errors: string[] = [], gaHits: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => { gaHits.push(r.request().url()); return r.abort(); });
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) { apiCalls.push(url.pathname); return route.fulfill({ status: 500, body: '{"error":"api must not be called"}' }); }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { apiCalls, errors, gaHits };
}
const panel = (page: Page, id: string) => page.locator('#panel-' + id);
const role = (p: Locator, r: string) => p.locator(`[data-role="${r}"]`);
async function download(page: Page, button: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync((await d.path())!) };
}
async function pdfPages(page: Page, buf: Buffer) {
  return page.evaluate(async (b64) => {
    const L = await (window as any).PFLoad.pdfLib();
    return (await L.PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).getPageCount();
  }, buf.toString('base64'));
}

// run each tool on its own landing page, the way a visitor would
const RUN: Record<string, (page: Page) => Promise<void>> = {
  'pdf-to-word': async (page) => {
    const p = panel(page, 'pdf-to-word');
    await p.locator('input[type=file]').setInputFiles(fx('text.pdf'));
    await expect(role(p, 'output').locator('h1')).toBeVisible({ timeout: 90000 });
    const d = await download(page, role(p, 'dl-docx'));
    expect(d.name).toBe('text-converted.docx');
    expect(await (await JSZip.loadAsync(d.buf)).file('word/document.xml')!.async('string')).toContain('Photosynthesis');
  },
  'word-to-pdf': async (page) => {
    const p = panel(page, 'word-to-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('sample.docx'));
    await expect(role(p, 'output')).toContainText('Lab Report Heading', { timeout: 90000 });
    const d = await download(page, role(p, 'dl-pdf'));
    expect(d.name).toBe('sample-converted.pdf');
    expect(await pdfPages(page, d.buf)).toBeGreaterThan(0);
  },
  'jpg-to-pdf': async (page) => {
    const p = panel(page, 'jpg-to-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('photo.jpg'), fx('shot.png')]);
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 90000 });
    const d = await download(page, role(p, 'dl-pdf'));
    expect(await pdfPages(page, d.buf)).toBe(2);
  },
  'compress-pdf': async (page) => {
    const p = panel(page, 'compress-pdf');
    await p.locator('input[type=file]').setInputFiles(fx('images.pdf'));
    await p.locator('input[name="pf-compress-mode"][value="target"]').check();
    await role(p, 'target').selectOption('500000');
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 120000 });
    const d = await download(page, role(p, 'dl-pdf'));
    expect(d.buf.length).toBeLessThanOrEqual(500000);
  },
  'merge-pdf': async (page) => {
    const p = panel(page, 'merge-pdf');
    await p.locator('input[type=file]').setInputFiles([fx('two-pages.pdf'), fx('three-pages.pdf')]);
    await expect(role(p, 'go')).toBeEnabled({ timeout: 90000 });
    await role(p, 'go').click();
    await expect(role(p, 'result')).toBeVisible({ timeout: 90000 });
    const d = await download(page, role(p, 'dl-pdf'));
    expect(await pdfPages(page, d.buf)).toBe(5);
  },
};

test.describe('PDF tool landing pages', () => {
  for (const slug of TOOLS) {
    test(`${slug}.html: loads, opens its own tool, and the tool works`, async ({ page }) => {
      const net = await setup(page);
      await page.goto(`/${slug}.html`);
      await expect(page).toHaveTitle(TITLES[slug]);
      await expect(panel(page, slug)).toBeVisible();
      for (const other of TOOLS.filter((t) => t !== slug)) await expect(panel(page, other)).toBeHidden();
      await expect(role(panel(page, slug), 'lib-status')).toHaveText('Ready', { timeout: 90000 });
      await RUN[slug](page);
      expect(net.apiCalls).toEqual([]);
      expect(net.errors).toEqual([]);
      expect(net.gaHits.length, 'GA was requested and blocked').toBeGreaterThan(0);
    });

    test(`${slug}.html: structure — H1, breadcrumb, quick facts, how-to, FAQ, related links, entity sentence, length`, async ({ page }) => {
      await setup(page);
      await page.goto(`/${slug}.html`);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('.pf-crumbs')).toContainText('Home › PDF Tools ›');
      const facts = await page.locator('.pf-facts th').allTextContents();
      expect(facts).toEqual(['Price', 'Signup', 'Watermark', 'File limits', 'Where files are processed', 'Works on phone']);
      const steps = await page.locator('.pf-steps li').count();
      expect(steps).toBeGreaterThanOrEqual(3);
      expect(steps).toBeLessThanOrEqual(4);
      const rel = await page.locator('.pf-related-links a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const t of TOOLS.filter((x) => x !== slug)) expect(rel).toContain(`/${t}.html`);
      expect(rel).toContain('/');
      expect(rel).toContain('/cv-builder.html');
      await expect(page.locator('.pf-entity')).toHaveText(ENTITY);
      await expect(page.locator('.pf-privacy')).toContainText(SPEED);
      const words = await page.evaluate(() => {
        const t = [...document.querySelectorAll('header.pf-hero, .pf-content')].map((e) => (e as HTMLElement).innerText).join(' ');
        return t.split(/\s+/).filter(Boolean).length;
      });
      expect(words, 'about 900–1,300 words').toBeGreaterThanOrEqual(900);
      expect(words).toBeLessThanOrEqual(1400);
      // FAQ JSON-LD = the visible FAQ; WebApplication free; BreadcrumbList; no aggregateRating
      const ld = ldBlocks(read(`${slug}.html`)).map((b) => JSON.parse(b));
      const types = ld.map((x) => x['@type']);
      expect(types.sort()).toEqual(['BreadcrumbList', 'FAQPage', 'WebApplication']);
      const app = ld.find((x) => x['@type'] === 'WebApplication');
      expect(app.offers.price).toBe('0');
      expect(JSON.stringify(ld)).not.toContain('aggregateRating');
      const faq = ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q: any) => q.name);
      expect(await page.locator('.faq-q').allTextContents()).toEqual(faq);
      const crumbs = ld.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.map((i: any) => i.item);
      expect(crumbs).toEqual(['https://parafree.app/', 'https://parafree.app/pdf-tools.html', `https://parafree.app/${slug}.html`]);
      // og tags
      for (const p of ['og:title', 'og:description', 'og:url']) await expect(page.locator(`meta[property="${p}"]`)).toHaveCount(1);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', `https://parafree.app/${slug}.html`);
    });
  }

  test('honest copy on the new pages and guides: no "best", "only", "#1", "exact formatting" or competitor names', () => {
    for (const f of [...TOOLS.map((t) => `${t}.html`), ...GUIDES]) {
      const text = read(f).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ');
      for (const re of [/\bbest\b/i, /#1/, /\bonly\b/i, /100% formatting/i, /\bexact (copy|formatting|layout|match)\b/i, /quillbot|ilovepdf|smallpdf|adobe|sejda|zety|\bcanva\b|novoresume/i])
        expect(text.match(re)?.[0], `${f} ${re}`).toBeUndefined();
    }
  });

  test('pdf-tools.html keeps its tool and links to the five pages; footers point to the landing pages', async ({ page }) => {
    await setup(page);
    await page.goto('/pdf-tools.html');
    await expect(page.locator('.tool-tabs .tool-tab')).toHaveCount(6);                  // + PDF to JPG (pdf-to-jpg round)
    await expect(panel(page, 'pdf-to-word')).toBeVisible();
    const hub = await page.locator('.pf-hub-links a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hub).toEqual([...TOOLS, 'pdf-to-jpg'].map((t) => `/${t}.html`));
    for (const f of ['index.html', 'pdf-tools.html', ...TOOLS.map((t) => `${t}.html`), 'cv-builder.html', 'paraphrase-document-online-keep-format.html', 'paraphrase-pdf.html',
      'paraphrase-powerpoint.html', 'paraphrase-word-document-keep-formatting.html', 'paraphrase-word-document.html', 'quillbot-alternative.html']) {
      const s = read(f);
      expect(s, f).toContain('PDF Tools:');
      for (const t of TOOLS) expect(s, `${f} → /${t}.html`).toContain(`href="/${t}.html"`);
      expect(s, f).not.toMatch(/href="\/pdf-tools\.html#(pdf-to-word|word-to-pdf|jpg-to-pdf|compress-pdf|merge-pdf)"[^>]*>(PDF to Word|Word to PDF|JPG to PDF|Compress PDF|Merge PDF)</);
    }
  });

  test('homepage PDF tab at 360px: the tool card lines up with the sub-tabs', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await setup(page);
    await page.goto('/#compress-pdf');
    await expect(page.locator('.pf-home-pdf .pf-subtabs')).toBeVisible({ timeout: 60000 });
    const r = await page.evaluate(() => {
      const L = (s: string) => Math.round((document.querySelector(s) as HTMLElement).getBoundingClientRect().left);
      const R = (s: string) => Math.round((document.querySelector(s) as HTMLElement).getBoundingClientRect().right);
      return { tabsL: L('.pf-home-pdf .pf-subtabs'), cardL: L('.pf-home-pdf .pf-tool-panel:not([hidden]) .panel'), tabsR: R('.pf-home-pdf .pf-subtabs'), cardR: R('.pf-home-pdf .pf-tool-panel:not([hidden]) .panel'), w: document.documentElement.scrollWidth };
    });
    expect(r.cardL).toBe(r.tabsL);
    expect(r.cardR).toBe(r.tabsR);
    expect(r.w).toBe(360);
  });
});

test.describe('site-wide SEO', () => {
  test('JSON-LD parses on every page; canonicals are self-referencing; titles and meta descriptions are unique', () => {
    const titles = new Map<string, string>(), descs = new Map<string, string>(), problems: string[] = [];
    for (const f of htmlPages().filter((f) => f !== '404.html')) {
      const s = read(f);
      for (const b of ldBlocks(s)) { try { JSON.parse(b); } catch (e) { problems.push(`${f}: bad JSON-LD`); } }
      const canon = (s.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
      const want = f === 'index.html' ? 'https://parafree.app/' : `https://parafree.app/${f}`;
      if (canon !== want) problems.push(`${f}: canonical ${canon}`);
      const t = (s.match(/<title>([^<]*)<\/title>/) || [])[1], d = (s.match(/<meta name="description" content="([^"]*)"/) || [])[1];
      if (!t || !d) problems.push(`${f}: missing title/description`);
      if (titles.has(t!)) problems.push(`${f}: same title as ${titles.get(t!)}`); else titles.set(t!, f);
      if (descs.has(d!)) problems.push(`${f}: same description as ${descs.get(d!)}`); else descs.set(d!, f);
    }
    expect(problems).toEqual([]);
  });

  test('internal links resolve (no 404) on every page', () => {
    const missing: string[] = [];
    for (const f of htmlPages()) {
      for (const m of read(f).matchAll(/href="(\/[^"#?]*)(?:[?#][^"]*)?"/g)) {
        const p = m[1] === '/' ? 'index.html' : decodeURIComponent(m[1]).slice(1);
        if (!p || p.startsWith('api/')) continue;
        const file = path.join(ROOT, p);
        if (!fs.existsSync(file) || (fs.statSync(file).isDirectory() && !fs.existsSync(path.join(file, 'index.html')))) missing.push(`${f} → ${m[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  test('sitemap.xml is valid XML, every URL exists, and the new pages are listed with lastmod', async ({ page }) => {
    await setup(page);
    await page.goto('/sitemap.xml');
    const xml = read('sitemap.xml');
    const r = await page.evaluate((x) => {
      const d = new DOMParser().parseFromString(x, 'application/xml');
      return { err: d.getElementsByTagName('parsererror').length, urls: [...d.getElementsByTagName('url')].map((u) => ({ loc: u.getElementsByTagName('loc')[0]?.textContent, lastmod: u.getElementsByTagName('lastmod')[0]?.textContent })) };
    }, xml);
    expect(r.err).toBe(0);
    const locs = r.urls.map((u) => u.loc!);
    expect(new Set(locs).size).toBe(locs.length);
    for (const u of r.urls) {
      const p = new URL(u.loc!).pathname;
      expect(fs.existsSync(path.join(ROOT, p === '/' ? 'index.html' : p.slice(1))), u.loc!).toBe(true);
    }
    for (const f of [...TOOLS.map((t) => `${t}.html`), ...GUIDES]) {
      const u = r.urls.find((x) => x.loc === `https://parafree.app/${f}`);
      expect(u, f).toBeTruthy();
      expect(u!.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('llms.txt, llms-full.txt and the IndexNow key are reachable; IndexNow dry run builds the right request', async ({ page }) => {
    await setup(page);
    const llms = await (await page.goto('/llms.txt'))!.text();
    const full = await (await page.goto('/llms-full.txt'))!.text();
    for (const t of TOOLS) { expect(llms).toContain(`https://parafree.app/${t}.html`); expect(full).toContain(`https://parafree.app/${t}.html`); }
    for (const s of ['https://parafree.app/cv-builder.html', 'https://parafree.app/pdf-tools.html', ENTITY, 'CV download: PDF only. Cover letter: PDF or Word.', 'never below 9.5 pt', 'no HEIC', '.docx only']) expect(llms).toContain(s);
    const keyFile = fs.readdirSync(ROOT).find((n) => /^[0-9a-f]{32}\.txt$/.test(n))!;
    expect(keyFile).toBeTruthy();
    const res = await page.goto('/' + keyFile);
    expect(res!.status()).toBe(200);
    expect((await res!.text()).trim()).toBe(keyFile.replace('.txt', ''));
    const out = JSON.parse(execSync('node scripts/indexnow.js --dry-run', { cwd: ROOT, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString());
    expect(out.endpoint).toBe('https://api.indexnow.org/indexnow');
    expect(out.host).toBe('parafree.app');
    expect(out.keyLocation).toBe(`https://parafree.app/${keyFile}`);
    expect(out.urlList.length).toBe((read('sitemap.xml').match(/<loc>/g) || []).length);
    expect(out.urlList).toContain('https://parafree.app/compress-pdf.html');
    expect(read('.vercelignore')).toMatch(/^scripts\/$/m);
  });

  test('robots.txt allows the AI and search crawlers', () => {
    const groups = read('robots.txt').replace(/\r/g, '').split(/\n\s*\n/);
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot', 'Google-Extended', 'Bingbot']) {
      const g = groups.find((x) => new RegExp(`^User-agent:\\s*${bot}\\s*$`, 'mi').test(x));
      expect(g, bot).toBeTruthy();
      expect(g!).toMatch(/^Allow:\s*\/\s*$/m);
      expect(g!).not.toMatch(/^Disallow:\s*\/\s*$/m);
    }
    expect(read('robots.txt')).toContain('Sitemap: https://parafree.app/sitemap.xml');
  });

  test('homepage: title, H1 and meta description unchanged; JSON-LD lists the PDF tools; guide cards link to the guides', () => {
    const now = read('index.html'), before = execSync('git show main:index.html', { cwd: ROOT, maxBuffer: 64 << 20 }).toString();
    const pick = (s: string) => ({ title: (s.match(/<title>[\s\S]*?<\/title>/) || [])[0], h1: (s.match(/<h1[\s\S]*?<\/h1>/) || [])[0], desc: (s.match(/<meta name="description"[^>]*>/) || [])[0] });
    expect(pick(now)).toEqual(pick(before));
    const ld = ldBlocks(now).flatMap((b) => flat(JSON.parse(b)));
    expect(ld.find((x) => x['@type'] === 'Organization')).toBeTruthy();
    expect(ld.find((x) => x['@type'] === 'WebSite')).toBeTruthy();
    const feat = JSON.stringify(ld.find((x) => x['@type'] === 'WebApplication').featureList);
    for (const t of TOOLS) expect(feat).toContain(`https://parafree.app/${t}.html`);
    expect(ld.find((x) => x['@type'] === 'Organization').serviceType).toContain('PDF Compressor');
    for (const g of GUIDES) { expect(now).toContain(`href="/${g}"`); expect(read('blog.html')).toContain(`href="/${g}"`); }
  });

  test('guides: blog style, Article JSON-LD, honest CV claims, links to the tools', () => {
    for (const g of GUIDES) {
      const s = read(g);
      const ld = ldBlocks(s).map((b) => JSON.parse(b));
      expect(ld.map((x) => x['@type'])).toEqual(['Article', 'BreadcrumbList']);
      expect(s).toContain('class="article-meta"');
      expect(s).toContain(ENTITY);
      const words = s.split('<article>')[1].split('</article>')[0].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      expect(words, g).toBeGreaterThanOrEqual(750);
    }
    const ats = read('blog-ats-friendly-cv-guide.html');
    for (const s of ['image PDF', 'Text PDF', 'Ctrl+A', 'One page or two?', 'href="/cv-builder.html"']) expect(ats).toContain(s);
    expect(ats).toContain('ParaFree CVs download as PDF; cover letters download as PDF or Word.');
    expect(read('blog-compress-pdf-upload-limits.html')).toContain('href="/compress-pdf.html"');
    expect(read('blog-pdf-to-word-without-losing-formatting.html')).toContain('href="/pdf-to-word.html"');
  });

  test('CV pages: new honest facts added, titles and H1s unchanged, no Word CV claim', () => {
    const CV = ['ai-cv-builder.html', 'best-free-cv-builder.html', 'cv-builder-no-signup.html', 'ats-resume-builder.html', 'student-cv-builder.html', 'cv-maker-free-download.html',
      'cv-templates.html', 'free-cv-builder-australia.html', 'free-cv-builder-canada.html', 'free-cv-builder-international-students.html', 'free-cv-builder-uk.html', 'free-cv-builder-usa.html'];
    for (const f of [...CV, 'cv-builder.html']) {
      const now = read(f), before = execSync(`git show main:${f}`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString();
      const pick = (s: string) => [(s.match(/<title>[\s\S]*?<\/title>/) || [])[0], (s.match(/<h1[\s\S]*?<\/h1>/) || [])[0]];
      expect(pick(now), f).toEqual(pick(before));
    }
    for (const f of CV) {
      const s = read(f);
      const block = s.split('class="pf-cv-facts"')[1].split('</section>')[0];
      for (const t of ['ATS-readable PDF', '1, 2 or 3 pages — you choose.', 'Fit to 1 page', '54 templates', 'Your CV downloads as a PDF; cover letters download as PDF or Word.']) expect(block, f).toContain(t);
    }
    const cvb = read('cv-builder.html');
    expect(cvb).toContain('ATS-readable PDF</td>');
    expect(cvb).toContain('1, 2 or 3 — you choose; Fit to 1 page in one click');
  });
});
