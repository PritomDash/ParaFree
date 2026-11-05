#!/usr/bin/env node
'use strict';
// SEO phase 4 — Core Web Vitals fixes from Lighthouse mobile (home + top 5 landing pages), idempotent:
//   1. Google Fonts no longer block the first paint on any page (preload + swap to stylesheet on load; the CSS already
//      uses display=swap, so text shows in the fallback font first). <noscript> keeps it for no-JS visitors.
//   2. Home: pdf.js (≈1.2 s render-blocking) is deferred; its worker is set up on DOMContentLoaded, before any upload.
//      Also fixes `addEventListener('load', …)();`, which threw a TypeError on every home page load.
//   3. Home: the LCP hero photo gets srcset/sizes, so phones download a 600–1000 px image instead of 1400 px.
// Run: node scripts/seo-perf.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
function edit(f, fn) {
  const p = path.join(ROOT, f), raw = fs.readFileSync(p, 'utf8'), crlf = raw.includes('\r\n'), s0 = raw.replace(/\r\n/g, '\n');
  const s = fn(s0);
  if (s !== s0) { fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s); return true; }
  return false;
}

let fonts = 0;
// (not the home page: its tool card sits right under the fold line and moved when the font arrived — CLS 0.26)
for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html') && x !== 'index.html')) {
  // (a link already inside <noscript> is the fallback written by an earlier run — left alone, so reruns change nothing)
  if (edit(f, (s) => s.replace(/(?<!<noscript>)<link href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)" rel="stylesheet">/g,
    (m, href) => `<link rel="preload" as="style" href="${href}" onload="this.onload=null;this.rel='stylesheet'"><noscript><link href="${href}" rel="stylesheet"></noscript>`))) fonts++;
}
console.log(`fonts made non-blocking on ${fonts} pages`);

edit('index.html', (s) => s
  .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"></script>',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js" defer></script>')
  .replace(`<script>
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =`, `<script>
// pdf.js is deferred (it blocked the first paint): set its worker up once it has run, before anyone can upload a PDF
document.addEventListener('DOMContentLoaded', function () {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =`)
  .replace(`    console.log('PDF.js loaded:', pdfjsLib.version);
  } else {
    console.error('PDF.js failed to load');
  }
</script>`, `    console.log('PDF.js loaded:', pdfjsLib.version);
  } else {
    console.error('PDF.js failed to load');
  }
});
</script>`)
  .replace(`    console.error('❌ PDF.js NOT loaded');
  }
})();`, `    console.error('❌ PDF.js NOT loaded');
  }
});`)
  .replace('<img src="https://images.unsplash.com/photo-1455390582262-044cdead277a?w=1400&q=80" alt="Writing and AI" style=',
    '<img src="https://images.unsplash.com/photo-1455390582262-044cdead277a?w=1400&q=80" srcset="https://images.unsplash.com/photo-1455390582262-044cdead277a?w=600&q=75 600w, https://images.unsplash.com/photo-1455390582262-044cdead277a?w=1000&q=80 1000w, https://images.unsplash.com/photo-1455390582262-044cdead277a?w=1400&q=80 1400w" sizes="100vw" alt="Writing and AI" style='));
// home: with pdf.js no longer blocking, the page paints before the web fonts arrive and the swap moved the tool card
// (CLS 0.26) — display=optional keeps the fallback font unless the web font is ready in time: no shift
edit('index.html', (s) => s.replace(/(<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*)&display=swap(" rel="stylesheet">)/, '$1&display=optional$2'));
console.log('home: pdf.js deferred, load handler fixed, hero srcset, fonts display=optional');
