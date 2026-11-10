'use strict';
// seo-indexing round (feat/seo-indexing, Nov 10 2026): the technical layer Google indexes from, the 15 long-tail
// target pages, near-duplicates, thin pages, and the AI-search basics (llms.txt, IndexNow, quotable definitions).
// Read-only: reads the checkout, never the network. Run: node tests/seo-indexing.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { crawl, resolve } = require('../scripts/seo-crawl.js');
const TARGETS = require('../scripts/seo-targets.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); failed++; }
}
const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|\s+/g, ' ').trim();
const norm = (s) => strip(s).toLowerCase().replace(/(\d)\s*kb\b/g, '$1kb');

const { pages, locs, issues } = crawl();

console.log('\n── B1. Every sitemap URL, internal link, canonical, hreflang, og:url and JSON-LD URL is the final 200 URL ──');
assert('every sitemap URL is a final 200, self-canonical, indexable page (no redirects, 404s, noindex, ?/#)', issues.sitemap.length === 0, JSON.stringify(issues.sitemap));
assert('no internal link goes through a redirect or to a 404', issues.links.length === 0, JSON.stringify(issues.links.slice(0, 10)));
assert('every canonical is the page itself, a final 200 URL', issues.canonicals.length === 0, JSON.stringify(issues.canonicals));
assert('hreflang, og:url and JSON-LD URLs are final 200 URLs too (no /logo.png 404)', !issues.hreflang.length && !issues.og.length && !issues.ld.length, JSON.stringify([issues.hreflang, issues.og, issues.ld]));
assert('every indexable page is in the sitemap and linked from another page', !issues.notInSitemap.length && !issues.orphans.length, JSON.stringify([issues.notInSitemap, issues.orphans]));
assert('URL forms: .html and the root only — no clean URLs, trailing slashes, www or http in the sitemap', locs.every((u) => /^https:\/\/parafree\.app\/(?:[a-z0-9-]+\.html)?$/.test(u)), locs.filter((u) => !/^https:\/\/parafree\.app\/(?:[a-z0-9-]+\.html)?$/.test(u)).join(' '));
const vj = JSON.parse(read('vercel.json'));
assert('/index.html (and /index) 301 to / — the homepage has one URL', vj.routes.some((r) => r.status === 301 && r.headers && r.headers.Location === '/' && new RegExp('^' + r.src).test('/index.html') && new RegExp('^' + r.src).test('/index'))
  && resolve('https://parafree.app/index.html').final === 'https://parafree.app/' && resolve('/index.html').kind === 'redirect');
assert('the redirect rules the crawler models match vercel.json (clean URL → .html, /studypack → flashcards)', resolve('/cv-builder').final === 'https://parafree.app/cv-builder.html' && resolve('/studypack').final === 'https://parafree.app/flashcard-quiz-maker.html'
  && vj.routes.some((r) => /\$1\.html/.test((r.headers || {}).Location || '')) && vj.routes.some((r) => /studypack/.test(r.src)));

console.log('\n── B2. Near-duplicates, thin pages ──');
assert('no two indexable pages share ≥ 35 % of their text (5-word shingles)', issues.dupes.length === 0, JSON.stringify(issues.dupes));
assert('ilovepdf-alternative (58 % shared with smallpdf-alternative) is noindex, follow and out of the sitemap', /<meta name="robots" content="noindex, follow">/.test(read('ilovepdf-alternative.html')) && !locs.includes('https://parafree.app/ilovepdf-alternative.html') && locs.includes('https://parafree.app/smallpdf-alternative.html'));
const ADDED = ['blog-summarize-a-research-article', 'blog-how-to-rephrase-a-sentence', 'blog-proofread-before-submitting', 'blog-uk-cv-format', 'blog-handwritten-homework-pdf',
  'free-chinese-paraphrasing-tool', 'free-spanish-paraphrasing-tool', 'free-portuguese-paraphrasing-tool', 'free-filipino-paraphrasing-tool', 'compress-pdf-to-1mb', 'compress-pdf-to-500kb'];
const sections = ADDED.map((f) => (read(f + '.html').match(/<section data-round="seo-indexing">([\s\S]*?)<\/section>/) || [])[1] || '');
assert('the thinnest discovered-not-indexed pages each got one real section (with its own H2)', sections.every((s) => /<h2>/.test(s) && strip(s).length > 300), ADDED.filter((_, i) => !/<h2>/.test(sections[i])).join(','));
const BANNED = [/\bbest\b/i, /#1\b/, /\bonly\b/i, /guarantee/i, /undetectable|bypass|100% human/i, /quillbot|ilovepdf|smallpdf|grammarly|chegg|turnitin/i];
assert('the new sections make no superlative, guarantee, detector or competitor claims', sections.every((s) => BANNED.every((re) => !re.test(strip(s)))), sections.map((s) => BANNED.map((re) => (strip(s).match(re) || [])[0]).filter(Boolean)).flat().join(','));
for (const f of ['blog-summarize-a-research-article', 'blog-how-to-rephrase-a-sentence', 'blog-proofread-before-submitting', 'blog-uk-cv-format', 'blog-handwritten-homework-pdf'])
  assert(`${f}: now at least 550 words of main text`, pages[f + '.html'].words >= 550, pages[f + '.html'].words);

console.log('\n── B3. 15 non-brand long-tail targets: one strong page each ──');
assert('15 targets, 15 different pages, all in the sitemap', TARGETS.length === 15 && new Set(TARGETS.map((t) => t.page)).size === 15 && TARGETS.every((t) => locs.includes('https://parafree.app/' + t.page)));
for (const { q, page, also } of TARGETS) {
  const s = read(page);
  const title = (s.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const h1 = (s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  const after = s.slice(s.indexOf('</h1>'));
  const p1 = ([...after.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]).find((x) => strip(x).split(' ').length >= 12) || '');
  const n = norm(q);
  const tool = /data-pf-embed=|class="pf-try|lib\/pdf-tools\/|flashcard-quiz-maker\.html\?embed=1|id="pfTool|class="pf-tool/.test(s);
  assert(`"${q}" → ${page}: exact phrase in title, H1 and first paragraph${also ? ` (+ "${also}" in the first paragraph)` : ''}; FAQPage schema; the tool on the page`,
    norm(title).includes(n) && norm(h1).includes(n) && norm(p1).includes(n) && (!also || norm(p1).includes(norm(also))) && /"@type"\s*:\s*"FAQPage"/.test(s) && tool,
    JSON.stringify({ title: norm(title).includes(n), h1: norm(h1).includes(n), p1: norm(p1).includes(n), also: also ? norm(p1).includes(norm(also)) : null, faq: /"FAQPage"/.test(s), tool }));
}
const guides = ['blog-how-to-rephrase-a-sentence', 'blog-summarize-a-research-article', 'blog-proofread-before-submitting'].map((f) => read(f + '.html'));
assert('three guides embed their tool (paraphraser / summarizer / grammar checker) right after the quick answer — not inside it', guides.every((s) => {
  const box = s.indexOf('<div class="pf-faq"'), answer = s.indexOf('class="faq-a"', box), close = s.indexOf('</div>', answer), embed = s.indexOf('<!-- TRY THE TOOL HERE');
  return embed > close && (s.match(/<!-- TRY THE TOOL HERE/g) || []).length === 1 && (s.match(/class="pf-try pf-try-btn"/g) || []).length === 0;
}) && /tool=summarizer/.test(guides[1]) && /tool=grammar/.test(guides[2]));

console.log('\n── B4. Bing / ChatGPT: IndexNow, llms.txt, quotable definitions ──');
const wf = read('.github/workflows/indexnow.yml');
const key = fs.readdirSync(ROOT).find((n) => /^[0-9a-f]{32}\.txt$/.test(n));
assert('IndexNow fires after every successful production deploy with the changed pages; the key file is in the site root', /deployment_status/.test(wf) && /state == 'success'/.test(wf) && /environment == 'Production'/.test(wf) && /indexnow\.js --changed/.test(wf) && key && read(key).trim() === key.slice(0, -4));
const llms = read('llms.txt');
const TOOL_PAGES = ['cv-builder', 'pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf', 'pdf-to-jpg', 'pdf-tools', 'ai-humanizer', 'ai-summarizer', 'grammar-checker', 'ai-detector', 'flashcard-quiz-maker', 'free-ai-chat', 'ai-rephraser'];
assert('llms.txt is current (November 2026) and links every tool page and every target page', /Last updated: November 2026/.test(llms) && TOOL_PAGES.concat(TARGETS.map((t) => t.page.replace(/\.html$/, ''))).every((f) => llms.includes('https://parafree.app/' + f + '.html')),
  TOOL_PAGES.concat(TARGETS.map((t) => t.page.replace(/\.html$/, ''))).filter((f) => !llms.includes('https://parafree.app/' + f + '.html')).join(','));
assert('llms.txt no longer lists the noindexed ilovepdf-alternative page', !/ilovepdf-alternative/.test(llms) && !/ilovepdf-alternative/.test(read('llms-full.txt')));
for (const f of ['index', 'ai-rephraser', 'ai-humanizer', 'ai-summarizer', 'grammar-checker', 'ai-detector', 'cv-builder', 'cover-letter-generator', 'free-ai-chat', 'flashcard-quiz-maker',
  'pdf-tools', 'pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf', 'pdf-to-jpg', 'paraphrase-powerpoint', 'paraphrase-pdf', 'paraphrase-word-document']) {
  const s = read(f + '.html').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const ps = [...s.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => strip(m[1]));
  const pdf = /^(pdf-tools|pdf-to-word|word-to-pdf|jpg-to-pdf|compress-pdf|merge-pdf|pdf-to-jpg)$/.test(f);
  const para = ps.find((t) => (pdf ? /^ParaFree’s [\w\s-]{3,40} (is|are) (a )?free/ : /^ParaFree(’s|'s)? ?[\w\s-]{0,40} is (a|an) (free|in-browser)/).test(t));
  const def = para && para.split(/(?<=[.!?])\s/)[0];   // the first sentence is what gets quoted
  assert(`${f}: a crisp, quotable "what it is" sentence${pdf ? ' about this tool (not just the suite)' : ''}`, !!def && def.length <= 320, def || '(none)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
