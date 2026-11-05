'use strict';
// SEO + AI-search push, round 2 (branch feat/seo-push): every page added or retitled in this round — titles/meta
// lengths, canonical, hreflang cluster, JSON-LD parses (FAQPage = visible FAQ, one block per type), the real tool
// embedded or linked above the fold, inbound links (no orphans), sitemap, llms.txt, honest copy, the IndexNow key
// and the deploy ping. Static file checks only — no network. Run: node tests/seo-push-round2.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); failed++; }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const dec = (x) => x.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (h) => dec(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const lds = (s) => [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const allHtml = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

const NEW = ['lecture-to-flashcards.html', 'youtube-to-flashcards.html', 'compress-pdf-to-1mb.html', 'free-spanish-paraphrasing-tool.html',
  'free-portuguese-paraphrasing-tool.html', 'free-chinese-paraphrasing-tool.html', 'free-filipino-paraphrasing-tool.html'];
const BLOG = allHtml.filter((f) => /^blog-/.test(f) && read(f).includes('data-round="seo-push-2"'));
const RETITLED = ['ai-rephraser.html', 'paraphrase-powerpoint.html', 'paraphrase-pdf.html', 'paraphrasing-tool-no-word-limit.html', 'free-cv-builder-uk.html'];
const LANG = { 'free-spanish-paraphrasing-tool.html': ['es', 'spanish'], 'free-portuguese-paraphrasing-tool.html': ['pt', 'portuguese'],
  'free-chinese-paraphrasing-tool.html': ['zh-Hans', 'chinese'], 'free-filipino-paraphrasing-tool.html': ['fil', 'tagalog'] };
const CLUSTER = ['free-spanish-paraphrasing-tool.html', 'free-portuguese-paraphrasing-tool.html', 'free-chinese-paraphrasing-tool.html', 'free-filipino-paraphrasing-tool.html',
  'free-french-paraphrasing-tool.html', 'free-arabic-paraphrasing-tool.html', 'free-hindi-paraphrasing-tool.html', 'free-bengali-paraphrasing-tool.html', 'free-urdu-paraphrasing-tool.html'];
// honest copy: no superlative / ranking / detector-evasion claims
const BANNED = /\b(the best|best (?:free )?(?:tool|paraphras|cv|flashcard)|#1|number one|only (?:free )?tool|undetectable|bypass|100% human|guaranteed|fastest)\b/i;
const sitemap = read('sitemap.xml'), llms = read('llms.txt'), llmsFull = read('llms-full.txt');

console.log(`\n── 1. new pages (${NEW.length}) and new guides (${BLOG.length}) ──`);
for (const f of NEW.concat(BLOG)) {
  const s = read(f);
  const title = dec((s.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]), desc = dec((s.match(/<meta name="description" content="([^"]*)"/) || [, ''])[1]);
  assert(`${f}: title 30–60 chars (${title.length}), description 70–160 (${desc.length})`, title.length >= 20 && title.length <= 60 && desc.length >= 70 && desc.length <= 160, title + ' | ' + desc);
  assert(`${f}: self canonical, index,follow, OG + Twitter card`, s.includes(`<link rel="canonical" href="https://parafree.app/${f}">`) && /<meta name="robots" content="index, follow">/.test(s)
    && s.includes(`<meta property="og:url" content="https://parafree.app/${f}">`) && /twitter:card/.test(s));
  let blocks = [];
  try { blocks = lds(s); } catch (e) { blocks = null; }
  assert(`${f}: JSON-LD parses`, Array.isArray(blocks));
  if (!blocks) continue;
  const types = blocks.map((b) => b['@type']);
  for (const t of ['BreadcrumbList', 'FAQPage']) assert(`${f}: exactly one ${t}`, types.filter((x) => x === t).length === 1, types.join(','));
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  const vis = text(s);
  // the page's own copy: hero through the article (the shared nav/footer link to older guides)
  const own = text(s.slice(s.indexOf('<div class="hero') > 0 ? s.indexOf('<div class="hero') : s.indexOf('<h1'), s.indexOf('<footer') > 0 ? s.indexOf('<footer') : undefined));
  assert(`${f}: every FAQPage question and answer is visible on the page`, faq && faq.mainEntity.every((q) => vis.includes(q.name) && vis.includes(q.acceptedAnswer.text.slice(0, 40))));
  const how = blocks.find((b) => b['@type'] === 'HowTo');
  if (how) assert(`${f}: HowTo steps are the visible steps`, how.step.every((st) => vis.includes(st.text.slice(0, 30))));
  const bc = blocks.find((b) => b['@type'] === 'BreadcrumbList');
  assert(`${f}: breadcrumb ends on this page and is visible`, bc.itemListElement.slice(-1)[0].item === `https://parafree.app/${f}` && /<nav class="pf-crumbs" aria-label="Breadcrumb"/.test(s));
  const h2q = [...s.matchAll(/<h2[^>]*>([^<]*[?？])<\/h2>/g)].length;
  assert(`${f}: at least one question-phrased H2 (${h2q})`, h2q >= 1);
  assert(`${f}: honest copy (no best / #1 / only / undetectable / bypass claims)`, !BANNED.test(own + ' ' + title + ' ' + desc), (own.match(BANNED) || [])[0]);
  const inbound = allHtml.filter((x) => x !== f && read(x).includes(`href="/${f}"`));
  assert(`${f}: linked from at least one other page (${inbound.length})`, inbound.length >= 1);
  assert(`${f}: in sitemap.xml`, sitemap.includes(`<loc>https://parafree.app/${f}</loc>`));
  for (const m of s.matchAll(/href="(\/[^"#?]*)"/g)) { const p = m[1] === '/' ? 'index.html' : m[1].slice(1); if (!fs.existsSync(path.join(ROOT, p))) assert(`${f}: link ${m[1]} resolves`, false); }
}
for (const f of NEW) {
  const s = read(f);
  const fold = s.indexOf('<div class="article-body">');
  const embedOrLink = s.search(/data-pf-embed="|class="btn-hero"/);
  assert(`${f}: the real tool is embedded or linked above the fold (before the article)`, embedOrLink > 0 && embedOrLink < fold);
  assert(`${f}: in llms.txt and llms-full.txt`, llms.includes(f) && llmsFull.includes(f));
}

console.log('\n── 2. language pages: copy in that language, tool preset, hreflang cluster ──');
for (const [f, [lang, tool]] of Object.entries(LANG)) {
  const s = read(f);
  assert(`${f}: <html lang="${lang}">, tool preset to ${tool}`, s.includes(`<html lang="${lang}">`) && s.includes(`lang=${tool}"`) && s.includes(`href="/?lang=${tool}"`));
}
const esWords = text(read('free-spanish-paraphrasing-tool.html')).match(/\b(el|la|de|que|y|en|los|las|para|sin)\b/gi) || [];
assert('Spanish page is written in Spanish (common words)', esWords.length > 60, esWords.length);
assert('Chinese page is written in Chinese (Han characters)', (text(read('free-chinese-paraphrasing-tool.html')).match(/\p{Script=Han}/gu) || []).length > 400);
for (const f of CLUSTER) {
  const s = read(f);
  const missing = CLUSTER.filter((o) => !new RegExp(`<link rel="alternate" hreflang="[^"]+" href="https://parafree.app/${o}">`).test(s));
  assert(`${f}: hreflang lists the whole language cluster + en + x-default`, !missing.length && /hreflang="x-default" href="https:\/\/parafree\.app\/"/.test(s), missing.join(', '));
}

console.log('\n── 3. retitled quick-win pages ──');
for (const f of RETITLED) {
  const s = read(f), t = dec((s.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]), d = dec((s.match(/<meta name="description" content="([^"]*)"/) || [, ''])[1]);
  assert(`${f}: title ≤60 (${t.length}), description ≤155 (${d.length}), a 40–70-word direct answer`, t.length <= 60 && d.length <= 155
    && [...s.matchAll(/<p class="pf-answer">([\s\S]*?)<\/p>/g)].some((m) => { const n = text(m[1]).trim().split(' ').length; return n >= 40 && n <= 70; }));
}

console.log('\n── 4. technical ──');
const key = allHtml.length && fs.readdirSync(ROOT).find((n) => /^[0-9a-f]{32}\.txt$/.test(n));
assert('IndexNow key file at the root contains its own key', key && read(key).trim() === key.slice(0, -4));
const wf = read('.github/workflows/indexnow.yml');
assert('IndexNow ping runs after a successful Production deployment, for the changed pages only', /deployment_status/.test(wf) && /state == 'success'/.test(wf) && /environment == 'Production'/.test(wf) && /--changed/.test(wf));
const { changedUrls } = require('../scripts/indexnow.js');
assert('indexnow --changed maps changed files to sitemap URLs', typeof changedUrls === 'function');
assert('404.html is not in the sitemap', !sitemap.includes('/404.html'));
const locs = [...sitemap.matchAll(/<loc>https:\/\/parafree\.app\/([^<]*)<\/loc>/g)].map((m) => m[1] || 'index.html');
assert('every sitemap URL exists', locs.every((l) => fs.existsSync(path.join(ROOT, l))), locs.filter((l) => !fs.existsSync(path.join(ROOT, l))).join(', '));
const indexable = allHtml.filter((f) => !/^(404|admin)\.html$|^google[0-9a-f]+\.html$/.test(f) && !/<meta name="robots" content="[^"]*noindex/.test(read(f)));
assert('every indexable page is in the sitemap', indexable.every((f) => locs.includes(f)), indexable.filter((f) => !locs.includes(f)).join(', '));
assert('every indexable page except home has a BreadcrumbList', indexable.filter((f) => f !== 'index.html').every((f) => /BreadcrumbList/.test(read(f))), indexable.filter((f) => f !== 'index.html' && !/BreadcrumbList/.test(read(f))).join(', '));
assert('one Organization entity: url "https://parafree.app/" everywhere', !allHtml.some((f) => /"@type":\s*"Organization",\s*"name":\s*"ParaFree",\s*"url":\s*"https:\/\/parafree\.app"/.test(read(f))));
assert('robots.txt still allows the AI crawlers', ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Bingbot'].every((b) => new RegExp(`User-agent: ${b}\\s*\\nAllow: /`).test(read('robots.txt').replace(/\r\n/g, '\n'))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
