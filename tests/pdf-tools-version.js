'use strict';
// Version stamp for lib/pdf-tools (served with "Cache-Control: immutable" — see vercel.json).
// The version is a short hash of every file in lib/pdf-tools; each reference to those files in
// index.html and pdf-tools.html carries it as ?v=<hash>, and window.PFV holds it for the files
// that load others. Change anything in lib/pdf-tools → run this → new URLs, so no stale cache.
//   node tests/pdf-tools-version.js           # print the current hash and whether pages are up to date
//   node tests/pdf-tools-version.js --write   # update index.html, pdf-tools.html and the five tool pages
// tests/pdf-tools-version.test.js fails while any reference is out of date.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'lib', 'pdf-tools');
const PAGES = ['index.html', 'pdf-tools.html', 'pdf-to-word.html', 'word-to-pdf.html', 'jpg-to-pdf.html', 'compress-pdf.html', 'merge-pdf.html', 'pdf-to-jpg.html', 'compress-pdf-to-100kb.html', 'compress-pdf-to-200kb.html', 'jpg-to-pdf-for-assignment.html'];

function version() {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(DIR).filter((n) => /\.(js|css)$/.test(n)).sort()) {
    h.update(f + '\0');
    h.update(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'));   // git / deployed copy
  }
  return h.digest('hex').slice(0, 10);
}

const REF = /(\/lib\/pdf-tools\/[\w.-]+\?v=)([\w]+)/g;
const PFV = /(window\.PFV\s*=\s*')([^']*)(')/g;

function stamp(text, v) {
  return text.replace(REF, (m, a) => a + v).replace(PFV, (m, a, _, c) => a + v + c);
}

function check(v = version()) {
  const problems = [];
  for (const p of PAGES) {
    const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const m of text.matchAll(REF)) if (m[2] !== v) problems.push(`${p}: ${m[0]} (expected ?v=${v})`);
    for (const m of text.matchAll(PFV)) if (m[2] !== v) problems.push(`${p}: window.PFV = '${m[2]}' (expected '${v}')`);
    // every reference to a lib/pdf-tools file must carry a version
    for (const m of text.matchAll(/\/lib\/pdf-tools\/[\w.-]+\.(?:js|css)(?!\?v=)/g)) problems.push(`${p}: unversioned ${m[0]}`);
  }
  return problems;
}

if (require.main === module) {
  const v = version();
  if (process.argv.includes('--write')) {
    for (const p of PAGES) {
      const file = path.join(ROOT, p);
      const before = fs.readFileSync(file, 'utf8');
      const after = stamp(before, v);
      if (after !== before) { fs.writeFileSync(file, after); console.log('updated', p); }
    }
  }
  const problems = check(v);
  console.log('lib/pdf-tools version', v, problems.length ? '— out of date:\n  ' + problems.join('\n  ') : '— all references up to date');
  process.exit(problems.length ? 1 : 0);
}

module.exports = { version, check, stamp };
