'use strict';
// SEO + GEO checks for every page (branch feat/seo-expansion). Static file checks only — no network.
// • every indexable page: a title and meta description, both unique; JSON-LD that parses; no duplicated schema
//   blocks (one FAQPage, one HowTo, one BreadcrumbList per page); the FAQPage questions are visible on the page
// • every tool page: SoftwareApplication (or WebApplication, a subtype) with price 0, and a one-sentence definition
// • the new landing pages: question-phrased H2s, FAQPage = visible FAQ, HowTo = visible steps, canonical, sitemap,
//   llms.txt, an internal link to their tool
// • no regressions: no "bypass / undetectable" wording, no "the best" in body copy of the new pages, llms.txt has
//   no stale file limits, 54 templates / 18 languages stay consistent (tests/consistency.test.js)
// Run: node tests/seo-expansion.test.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 900) : ''}`); failed++; }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const dec = (x) => x.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = (x) => dec(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
const indexable = pages.filter((f) => f !== '404.html' && !/<meta name="robots" content="[^"]*noindex/.test(read(f)));
function ld(s) {
  const out = [];
  for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const j = JSON.parse(m[1]);
    (Array.isArray(j) ? j : j['@graph'] || [j]).forEach((x) => out.push(x));
  }
  return out;
}
const visibleText = (s) => norm(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' '));

const NEW = ['flashcard-maker', 'notes-to-flashcards', 'pdf-to-flashcards', 'quiz-from-notes', 'quizlet-alternative', 'ai-study-tools',
  'ai-humanizer', 'ai-summarizer', 'grammar-checker', 'ai-detector', 'free-ai-chat', 'ilovepdf-alternative', 'smallpdf-alternative',
  'compress-pdf-to-500kb', 'cover-letter-generator'];
// the tool pages: one quotable definition near the top + app schema
const TOOL_PAGES = ['index', 'flashcard-quiz-maker', 'code', 'cv-builder', 'pdf-tools', 'pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'pdf-to-jpg',
  'compress-pdf', 'merge-pdf', 'compress-pdf-to-100kb', 'compress-pdf-to-200kb', 'jpg-to-pdf-for-assignment', 'ai-rephraser', 'paraphrase-essay',
  'paraphrase-pdf', 'paraphrase-powerpoint', 'paraphrase-word-document', 'paraphrasing-tool-no-word-limit', ...NEW];

console.log('\n── 1. titles and descriptions: present and unique on every indexable page ──');
const titles = new Map(), descs = new Map(), dupT = [], dupD = [], missing = [];
for (const f of indexable) {
  const s = read(f);
  const t = (s.match(/<title>([\s\S]*?)<\/title>/) || [])[1], d = (s.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!t || !d) { missing.push(f); continue; }
  if (titles.has(t)) dupT.push(`${f} = ${titles.get(t)}`); else titles.set(t, f);
  if (descs.has(d)) dupD.push(`${f} = ${descs.get(d)}`); else descs.set(d, f);
}
assert(`${indexable.length} pages have a title and a meta description`, missing.length === 0, missing.join(', '));
assert('titles are unique', dupT.length === 0, dupT.join('; '));
assert('meta descriptions are unique', dupD.length === 0, dupD.join('; '));

console.log('\n── 2. structured data: parses, no duplicate blocks, FAQPage questions visible ──');
const bad = [], dupes = [], hidden = [];
for (const f of pages) {
  const s = read(f);
  let items;
  try { items = ld(s); } catch (e) { bad.push(f + ': ' + e.message); continue; }
  const types = items.map((x) => x['@type']);
  for (const t of ['FAQPage', 'HowTo', 'BreadcrumbList']) if (types.filter((x) => x === t).length > 1) dupes.push(`${f}: ${t} ×${types.filter((x) => x === t).length}`);
  const body = visibleText(s);
  for (const q of items.filter((x) => x['@type'] === 'FAQPage').flatMap((x) => x.mainEntity || [])) {
    if (!body.includes(norm(q.name))) hidden.push(`${f}: «${q.name}»`);
  }
}
assert('every JSON-LD block parses', bad.length === 0, bad.join('\n'));
assert('no page has two FAQPage, HowTo or BreadcrumbList blocks', dupes.length === 0, dupes.join('\n'));
assert('every FAQPage question is visible on its page (no FAQ schema for hidden text)', hidden.length === 0, hidden.join('\n'));

console.log('\n── 3. tool pages: app schema (price 0) and a one-sentence definition ──');
const noApp = [], noDef = [];
for (const t of TOOL_PAGES) {
  const s = read(t + '.html'), items = ld(s);
  const app = items.find((x) => /^(SoftwareApplication|WebApplication)$/.test(x['@type']));
  if (!app || !app.offers || String(app.offers.price) !== '0') noApp.push(t);
  if (!/class="pf-define"|GEO: Direct answer|class="pf-entity"|class="pf-lead pf-define"/.test(s) && t !== 'index') noDef.push(t);
}
assert(`${TOOL_PAGES.length} tool pages have SoftwareApplication / WebApplication with price 0`, noApp.length === 0, noApp.join(', '));
assert('tool pages have a one-sentence definition near the top', noDef.length === 0, noDef.join(', '));
const home = read('index.html');
assert('homepage: the definition sentence is in its structured data description', ld(home).some((x) => /SoftwareApplication|WebApplication/.test(x['@type']) && /free/i.test(x.description || '')));

console.log('\n── 4. the new landing pages ──');
const sitemap = read('sitemap.xml'), llms = read('llms.txt');
for (const p of NEW) {
  const f = p + '.html', s = read(f), items = ld(s), url = `https://parafree.app/${f}`;
  const h2 = [...s.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => norm(m[1]));
  const flat = (x) => dec(x.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().toLowerCase();   // an answer's text as read
  const vq = [...s.matchAll(/<p class="faq-q">([\s\S]*?)<\/p><p class="faq-a">([\s\S]*?)<\/p>/g)].map((m) => [dec(m[1]), flat(m[2])]);
  const faq = items.find((x) => x['@type'] === 'FAQPage');
  const how = items.find((x) => x['@type'] === 'HowTo');
  const steps = (s.match(/<ol class="pf-steps">([\s\S]*?)<\/ol>/) || ['', ''])[1].match(/<li>/g) || [];
  const ok = [
    (s.match(/<h1[\s>]/g) || []).length === 1,
    h2.filter((x) => x.endsWith('?')).length >= 3,
    faq && JSON.stringify(faq.mainEntity.map((q) => [q.name, flat(q.acceptedAnswer.text)])) === JSON.stringify(vq),
    !how || how.step.length === steps.length,
    s.includes(`<link rel="canonical" href="${url}">`),
    sitemap.includes(`<loc>${url}</loc>`),
    llms.includes(url),
    /href="\/(flashcard-quiz-maker|code|pdf-tools|compress-pdf|cv-builder)?\.html"|href="\/"/.test(s),
    items.some((x) => x['@type'] === 'BreadcrumbList'),
  ];
  assert(`${f}: one H1, ≥3 question H2s, FAQPage = visible FAQ, HowTo = visible steps, canonical, sitemap, llms.txt, tool link, breadcrumb`,
    ok.every(Boolean), ok.map((x, i) => (x ? '' : ['h1', 'question h2s', 'faq', 'howto', 'canonical', 'sitemap', 'llms', 'tool link', 'breadcrumb'][i])).filter(Boolean).join(', '));
}
const embedHost = read('lib/embed-host.js');
assert('the flashcard embed on landing pages is sized by its own message (pf-fq-size)', /'pf-fq-size'/.test(embedHost));

console.log('\n── 5. no regressions ──');
const BYPASS = /\b(undetectable|bypass(?:es|ing)? (?:ai |the )?(?:detect\w*|checker\w*|turnitin|gptzero)|guaranteed to pass|100% human score)\b/i;
const bypass = pages.filter((f) => BYPASS.test(visibleText(read(f))) || ld(read(f)).some((x) => BYPASS.test(JSON.stringify(x)))).filter((f) => !/^blog-/.test(f));
assert('no "undetectable / bypass detectors / guaranteed to pass" wording on any tool or landing page', bypass.length === 0, bypass.join(', '));
const bestHits = [];
for (const p of NEW) {
  const s = read(p + '.html').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ');
  const body = s.split('<div class="article-body">')[1].split('<footer')[0];
  // questions people ask ("What is the best free flashcard maker?") are fine; claims are not
  const claims = body.replace(/<h2[^>]*>[^<]*\?<\/h2>|<p class="faq-q">[^<]*\?<\/p>/g, ' ');
  for (const m of norm(claims).matchAll(/[^.]*\b(the best|best free|#1|number one|the only|only free)\b[^.]*/g)) bestHits.push(`${p}: «${m[0].trim().slice(0, 120)}»`);
}
assert('new pages make no "best / only / #1" claims in their copy (questions excepted)', bestHits.length === 0, bestHits.join('\n'));
assert('llms.txt has no stale PDF limits (50 MB per file / 200 MB per task / 300 pages, 50 MB)', !/50 MB per file|200 MB per task|300 pages, 50 MB|up to 50 pages and 50 MB/.test(llms + read('llms-full.txt')));
assert('llms.txt lists the study tools, the writing tools and the flashcard maker', ['flashcard-quiz-maker.html', 'ai-humanizer.html', 'ai-summarizer.html', 'grammar-checker.html', 'ai-detector.html', 'free-ai-chat.html'].every((u) => llms.includes('https://parafree.app/' + u)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
