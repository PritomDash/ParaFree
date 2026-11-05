# Lighthouse (mobile, simulated throttling), local copy of the site — 2026-11-04

Served from this branch on localhost (no brotli, so "text compression" findings are ignored: Vercel compresses).
Lab numbers vary run to run on this machine (TBT especially); the home page was measured twice after the fix.

| Page | Before: perf / LCP / CLS / TBT | After: perf / LCP / CLS / TBT | Worst issue → fix |
|---|---|---|---|
| / | 26 / 10.7 s / 0 / 6.1 s | 36 / 9.5–9.6 s / 0 / 3.3–3.5 s | pdf.js (1.3 s) blocked the first paint → deferred; hero photo 1400 px on phones → srcset 600/1000/1400; fonts display=optional (the faster paint otherwise moved the tool card: CLS 0.26) |
| /pdf-to-word.html | 47 / 5.2 s / 0 / 1.7 s | 55 / 4.8 s / 0.03 / 1.2 s | Google Fonts CSS blocked render (0.9 s) → loaded without blocking |
| /compress-pdf.html | 51 / 4.5 s / 0.01 / 1.5 s | 60 / 4.2 s / 0.01 / 1.2 s | same |
| /free-paraphrasing-tool-students.html | 49 / 3.6 s / 0.09 / 5.3 s | 64 / 1.7 s / 0.09 / 4.2 s | same; the remaining cost is the embedded paraphraser (the tool itself), already loaded only after the page |
| /pdf-to-jpg.html | 47 / 6.8 s / 0 / 1.0 s | 61 / 4.1 s / 0.003 / 1.1 s | same |
| /paraphrase-word-document-keep-formatting.html | 30 / 8.4 s / 0 / 5.9 s | 51 / 3.7 s / 0.08 / 5.0 s | same; embedded tool as above |

SEO 100 and best-practices 100 on every page except the home page (75 — AdSense's third-party cookie and the local
/api 404; AdSense was not touched). Accessibility 92–96. Raw reports: `*.json` (before), `*-after3.json` (after).
Also fixed: `window.addEventListener('load', …)();` on the home page threw a TypeError on every load.
