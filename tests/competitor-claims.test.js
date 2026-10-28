'use strict';
// No undated specific claims about competitors (branch fix/competitor-claims).
// Rule: a competitor may be NAMED (e.g. "free QuillBot alternative" on SEO pages), but no sentence, table row or list
// item may pair a competitor with a specific figure — a price, a per-month/per-day rate, or a count of words /
// rewrites / requests / templates — and the old figures may not appear at all, even unnamed ("No 125-word cap").
// Checked: every page (visible copy, meta tags, JSON-LD, the homepage's embedded blog posts), the blog sources in
// blog-content/, and the support assistant's knowledge text in api/process.js. Static file checks only — no network.
// Run: node tests/competitor-claims.test.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); failed++; }
}

// Product names are proper nouns: matched case-sensitively, so CSS "cursor:" or "word document" are not names.
const COMP = new RegExp('\\b(Quill ?[Bb]ot|QUILLBOT|Paraphraser\\.io|Grammarly|ProWritingAid|ChatGPT(?: Plus)?|Wordtune|Spinbot|Editpad|' +
  'Scribbr|GPTZero|Turnitin|Copyleaks|Originality\\.ai|ZeroGPT|Undetectable(?:\\.ai)?|HIX(?: Bypass)?|Jasper|Writesonic|Rytr|' +
  'LanguageTool|Hemingway|Canva(?: Pro)?|Zety|Novoresume|Resume\\.io|Kickresume|Resume ?Genius|Enhancv|LiveCareer|FlowCV|Rezi|' +
  'Jobscan|Smallpdf|iLovePDF|Adobe(?: Acrobat)?|Sejda|PDF24|Perplexity|Consensus|Codeium|Tabnine|Aider|Windsurf|Cursor|' +
  '(?:GitHub )?Copilot|Replit|Quizlet|Chegg|Course Hero)\\b');
const FIGURE = /(\$\s?\d|£\s?\d|€\s?\d|\b\d[\d,.]*\s*(?:words?|characters?|rewrites?|requests?|templates?|credits?|uses?|downloads?)\b|\/\s?month\b|per month|a month\b|\/\s?day\b|per day|\/\s?year\b|per year)/i;
// figures that used to stand for a competitor's limits — not allowed even without the name
const OLD_FIGURES = /\b125[ -]words?\b|\b600[ -]words?\b|\b10 rewrites\b|\b10\/day\b|\b500 (?:fast |premium )?requests\b|\$19\.95|\$6\.95|\$29\/month|\$39\/month/i;

// Text units: one per table row, list item, sentence, JSON-LD string — so a name and a figure only count together
// when they make one claim. Styles are dropped (CSS is not copy); scripts stay (JSON-LD and the homepage blog posts).
function units(src) {
  let t = src.replace(/\r\n/g, '\n').replace(/<style[\s\S]*?<\/style>/g, ' ');
  t = t.replace(/<tr[\s\S]*?<\/tr>/g, (m) => ' ¶ ' + m.replace(/\s+/g, ' ') + ' ¶ ');
  t = t.replace(/<li[\s\S]*?<\/li>/g, (m) => ' ¶ ' + m.replace(/\s+/g, ' ') + ' ¶ ');
  t = t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  return t.split(/¶|\n|"\s*[,:}\]]\s*"?|(?<=[.!?])\s+(?=[A-Z])/).map((u) => u.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function offenders(file, { bare = true } = {}) {
  const out = [];
  for (const u of units(fs.readFileSync(file, 'utf8'))) {
    const name = u.match(COMP), fig = u.match(FIGURE), old = bare && u.match(OLD_FIGURES);
    if ((name && fig) || old) out.push(`${path.relative(ROOT, file)}: [${name ? name[0] : ''} + ${(fig || old)[0]}] ${u.slice(0, 160)}`);
  }
  return out;
}

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f));
const blogSrc = fs.readdirSync(path.join(ROOT, 'blog-content')).map((f) => path.join(ROOT, 'blog-content', f));

console.log('\n── 1. self-check: the rule catches what it should, and only that ──');
const probe = (html) => { const f = path.join(require('os').tmpdir(), 'pf-claims-probe.html'); fs.writeFileSync(f, html); const r = offenders(f); fs.unlinkSync(f); return r.length; };
assert('catches "QuillBot Free limits you to 125 words"', probe('<p>QuillBot Free limits you to 125 words.</p>') === 1);
assert('catches a price in a table row', probe('<table><tr><td>Grammarly</td><td>$30/month</td></tr></table>') === 1);
assert('catches a price in JSON-LD', probe('<script type="application/ld+json">{"text":"Unlike Cursor ($20/month), no cap."}</script>') === 1);
assert('catches the old figure even unnamed ("No 125-word cap")', probe('<p>No 125-word cap.</p>') === 1);
assert('allows naming a competitor without figures ("free QuillBot alternative")', probe('<h2>The Free QuillBot Alternative for US Students</h2><p>ParaFree has no word limit.</p>') === 0);
assert('allows ParaFree\'s own figures ("54 templates", "50 MB")', probe('<p>ParaFree: 54 templates, files up to 50 MB.</p>') === 0);
assert('ignores CSS (cursor: pointer; 500 requests in a style block)', probe('<style>.a{cursor:pointer}</style><p>Fast.</p>') === 0);

console.log('\n── 2. pages: no competitor + figure in copy, meta or structured data ──');
const pageHits = pages.flatMap((f) => offenders(f));
assert(`${pages.length} pages checked — no undated competitor prices / limits`, pageHits.length === 0, pageHits.join('\n'));

console.log('\n── 3. blog sources (blog-content/) ──');
const blogHits = blogSrc.flatMap((f) => offenders(f));
assert(`${blogSrc.length} blog sources checked`, blogHits.length === 0, blogHits.join('\n'));

console.log('\n── 4. support assistant knowledge (api/process.js) ──');
const proc = fs.readFileSync(path.join(ROOT, 'api', 'process.js'), 'utf8');
const kb = proc.slice(proc.indexOf('Q: Is there a word limit?'), proc.indexOf('Never make up answers.'));
assert('knowledge text found', kb.length > 1000);
const kbHits = kb.split('\n').filter((l) => COMP.test(l) && FIGURE.test(l));
assert('no competitor prices / limits in the support answers', kbHits.length === 0, kbHits.join('\n'));
assert('the assistant is told not to quote other tools\' prices or limits', /Do not quote other tools' prices or limits/.test(kb));

console.log('\n── 5. no "only / best tool" claims against named competitors in the comparisons ──');
const SUPER = /\b(?:only (?:major )?(?:tool|CV builder|one) (?:in this comparison|that)|the best tool available|doesn't have at any price tier|ParaFree wins|beats Quill[Bb]ot)\b/i;
const superHits = pages.flatMap((f) => units(fs.readFileSync(f, 'utf8')).filter((u) => SUPER.test(u)).map((u) => `${path.basename(f)}: ${u.slice(0, 140)}`));
assert('none left', superHits.length === 0, superHits.join('\n'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
