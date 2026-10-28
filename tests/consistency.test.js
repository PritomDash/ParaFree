'use strict';
// One number for each fact, on every page (branch fix/consistency-polish).
// Templates: the CV builder has 54 (its Surprise Me pool); languages: the paraphraser offers 18 (its dropdown).
// Every page, its meta tags, JSON-LD and the homepage's embedded blog posts, plus blog-content/ and the support
// assistant's knowledge in api/process.js, must state those numbers — never 50+, 36, 18 templates or 10 languages.
// "X, Y and N other languages" must add up to 18. Static file checks only — no network.
// Run: node tests/consistency.test.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 800) : ''}`); failed++; }
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))
  .concat(fs.readdirSync(path.join(ROOT, 'blog-content')).map((f) => 'blog-content/' + f), ['api/process.js']);
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// "54 templates", "54 ATS-friendly templates", "All 18 Templates", "36 free professional CV templates"
const TPL = /(\d+)\+?\s+(?:(?:free|professional|ATS[- ](?:friendly|optimi[sz]ed)|CV|resume|modern)\s+){0,4}templates?\b/gi;
// "18 languages", "10 Languages" — but not "16 other languages" (checked separately)
const LANG = /(\d+)\+?\s+(?:supported\s+|different\s+)?languages?\b/gi;
const OTHER = /([^.<>"]{0,160}?)\band\s+(\d+)\s+other\s+languages\b/gi;
const NAMES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Arabic', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Bengali',
  'Urdu', 'Persian', 'Thai', 'Vietnamese', 'Tamil', 'Telugu', 'Filipino'];

function hits(re, want) {
  const out = [];
  for (const f of files) {
    const t = text(read(f));
    for (const m of t.matchAll(re)) if (+m[1] !== want) out.push(`${f}: «${t.slice(Math.max(0, m.index - 50), m.index + m[0].length + 20).trim()}»`);
  }
  return out;
}

console.log('\n── 1. the true numbers, from the code ──');
const cv = read('cv-builder.html');
const pool = (cv.match(/function surpriseMe\(\) \{\s*const all = \[([^\]]*)\]/) || [])[1] || '';
const tplCount = (pool.match(/'[\w-]+'/g) || []).length;
assert(`CV builder Surprise Me pool has 54 templates (found ${tplCount})`, tplCount === 54);
const sel = read('index.html').match(/<option value="english">English<\/option>[\s\S]*?<\/select>/);
const langCount = sel ? (sel[0].match(/<option value=/g) || []).length : 0;
assert(`paraphraser language dropdown has 18 languages (found ${langCount})`, langCount === 18);

console.log('\n── 2. self-check ──');
const probe = (re, s, want) => [...text(s).matchAll(re)].filter((m) => +m[1] !== want).length;
assert('catches "36 professional templates", "50+ Templates", "All 18 Templates"', probe(TPL, '36 professional templates. 50+ Templates. All 18 Templates.', 54) === 3);
assert('allows "54 ATS-friendly templates"', probe(TPL, 'It has 54 ATS-friendly templates.', 54) === 0);
assert('catches "10 languages", ignores "16 other languages"', probe(LANG, 'Supports 10 languages. Also English and 16 other languages.', 18) === 1);

console.log('\n── 3. every page states the same numbers ──');
const tplHits = hits(TPL, 54);
assert(`${files.length} files — every template count is 54`, tplHits.length === 0, tplHits.join('\n'));
const langHits = hits(LANG, 18);
assert(`${files.length} files — every language count is 18`, langHits.length === 0, langHits.join('\n'));

const otherBad = [];
for (const f of files) {
  for (const m of text(read(f)).matchAll(OTHER)) {
    // "Also supports Urdu, English and 15 other languages" on the Arabic page: the page's own language counts too
    const named = NAMES.filter((n) => new RegExp('\\b' + n + '\\b').test(m[1])).length + (/\balso\b/i.test(m[1]) ? 1 : 0);
    if (named + +m[2] !== 18) otherBad.push(`${f}: «${m[0].trim()}» (${named} counted + ${m[2]})`);
  }
}
assert('"X, Y and N other languages" always adds up to 18', otherBad.length === 0, otherBad.join('\n'));

const unsupported = files.filter((f) => /supports? [^.]{0,40}languages?[^.]{0,200}\b(Italian|Dutch|Polish|Turkish|Indonesian|Russian)\b/.test(text(read(f))));
assert('no language list names a language the dropdown does not offer', unsupported.length === 0, unsupported.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
