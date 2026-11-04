#!/usr/bin/env node
'use strict';
// SEO phase 3/4 (idempotent): wire the new pages in — sitemap, llms.txt / llms-full.txt, and links from the pages
// that naturally lead to them (topic clusters), so none is an orphan. Run: node scripts/seo-links.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function edit(f, fn) {
  const raw = read(f), crlf = raw.includes('\r\n');
  const s = fn(raw.replace(/\r\n/g, '\n'));
  if (s !== raw.replace(/\r\n/g, '\n')) { fs.writeFileSync(path.join(ROOT, f), crlf ? s.replace(/\n/g, '\r\n') : s); console.log('updated ' + f); }
}
const once = (s, needle, anchor, insert, after = true) => (s.includes(needle) ? s : s.replace(anchor, after ? anchor + insert : insert + anchor));

const NEW = ['lecture-to-flashcards.html', 'youtube-to-flashcards.html', 'compress-pdf-to-1mb.html', 'free-spanish-paraphrasing-tool.html',
  'free-portuguese-paraphrasing-tool.html', 'free-chinese-paraphrasing-tool.html', 'free-filipino-paraphrasing-tool.html'];

// sitemap (lastmod is set from git by scripts/sitemap-lastmod.js)
edit('sitemap.xml', (s) => {
  for (const f of NEW) if (!s.includes(`https://parafree.app/${f}<`)) {
    s = s.replace('</urlset>', `  <url>\n    <loc>https://parafree.app/${f}</loc>\n    <lastmod>2026-11-04</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n</urlset>`);
  }
  return s;
});

// llms.txt + llms-full.txt: one quotable line per new page
const LLM_FLASH = `
- [Lecture to Flashcards](https://parafree.app/lecture-to-flashcards.html): flashcards, a quiz and key points from lecture slides (.pptx/PDF), a recording (up to 50 MB / 60 minutes, 5 recording packs a day) or lecture notes. Free, no signup.
- [YouTube to Flashcards](https://parafree.app/youtube-to-flashcards.html): paste a YouTube video's transcript (or its link — captions are read automatically when YouTube allows it) and get flashcards, a quiz and key points from what is said. Free, no signup.`;
const LLM_PDF = `
- [Compress PDF to 1 MB](https://parafree.app/compress-pdf-to-1mb.html): Compress PDF opened with a 1 MB target, for email and application portals; Light compression first so text stays selectable; says so when 1 MB can't be reached.`;
const LLM_LANG = `
- Paraphraser pages in other languages (copy in that language, tool preset to it): [Spanish](https://parafree.app/free-spanish-paraphrasing-tool.html), [Portuguese](https://parafree.app/free-portuguese-paraphrasing-tool.html), [Chinese](https://parafree.app/free-chinese-paraphrasing-tool.html), [Filipino/Tagalog](https://parafree.app/free-filipino-paraphrasing-tool.html), [French](https://parafree.app/free-french-paraphrasing-tool.html), [Arabic](https://parafree.app/free-arabic-paraphrasing-tool.html), [Hindi](https://parafree.app/free-hindi-paraphrasing-tool.html), [Bengali](https://parafree.app/free-bengali-paraphrasing-tool.html), [Urdu](https://parafree.app/free-urdu-paraphrasing-tool.html).`;
for (const f of ['llms.txt', 'llms-full.txt']) edit(f, (s) => {
  const quiz = (s.match(/\n- \[Quiz from Notes\]\([^\n]*/) || [])[0];
  const kb200 = (s.match(/\n- \[Compress PDF to 200 KB\]\([^\n]*/) || [])[0];
  if (quiz) s = once(s, 'lecture-to-flashcards.html', quiz, LLM_FLASH);
  if (kb200) s = once(s, 'compress-pdf-to-1mb.html', kb200, LLM_PDF);
  if (quiz) s = once(s, 'free-spanish-paraphrasing-tool.html', quiz + (s.includes(LLM_FLASH) ? LLM_FLASH : ''), LLM_LANG);
  return s;
});

// links from the pages that lead to them
const li = (h, t, d) => `\n    <li><a href="${h}">${t}<span>${d}</span></a></li>`;
for (const f of ['ai-study-tools.html', 'notes-to-flashcards.html', 'pdf-to-flashcards.html', 'flashcard-maker.html', 'quiz-from-notes.html']) edit(f, (s) => {
  if (!/<ul class="pf-related">/.test(s)) return s;
  s = once(s, 'href="/lecture-to-flashcards.html"', '<ul class="pf-related">', li('/lecture-to-flashcards.html', 'Lecture to flashcards', 'Cards from slides or a recording'));
  s = once(s, 'href="/youtube-to-flashcards.html"', '<ul class="pf-related">', li('/youtube-to-flashcards.html', 'YouTube to flashcards', 'Cards from a video’s transcript'));
  return s;
});
edit('compress-pdf.html', (s) => once(s, 'href="/compress-pdf-to-1mb.html"', ' and <a href="/compress-pdf-to-500kb.html">making a PDF fit a 500 KB upload limit</a>',
  ', <a href="/compress-pdf-to-500kb.html">making a PDF fit a 500 KB upload limit</a> and <a href="/compress-pdf-to-1mb.html">getting a PDF under 1 MB for email or a portal</a>', false)
  .replace(', <a href="/compress-pdf-to-500kb.html">making a PDF fit a 500 KB upload limit</a> and <a href="/compress-pdf-to-1mb.html">getting a PDF under 1 MB for email or a portal</a> and <a href="/compress-pdf-to-500kb.html">making a PDF fit a 500 KB upload limit</a>',
    ', <a href="/compress-pdf-to-500kb.html">making a PDF fit a 500 KB upload limit</a> and <a href="/compress-pdf-to-1mb.html">getting a PDF under 1 MB for email or a portal</a>'));
for (const f of ['compress-pdf-to-500kb.html', 'compress-pdf-to-200kb.html', 'compress-pdf-to-100kb.html']) edit(f, (s) =>
  /<ul class="pf-related">/.test(s) ? once(s, 'href="/compress-pdf-to-1mb.html"', '<ul class="pf-related">', li('/compress-pdf-to-1mb.html', 'Compress PDF to 1 MB', 'For email and application portals')) : s);

// home: the language grid gets the four new language pages
const card = (href, flag, name, sub) => `\n      <a href="${href}" style="background:white;border:1px solid #d8f3dc;border-radius:12px;padding:18px;text-decoration:none;display:block;">\n        <div style="font-size:24px;margin-bottom:8px;">${flag}</div>\n        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:15px;color:#1a1814;margin-bottom:4px;">${name}</div>\n        <div style="font-size:13px;color:#6b6660;">${sub}</div>\n      </a>`;
edit('index.html', (s) => {
  const end = s.indexOf('</a>', s.indexOf('<a href="/free-french-paraphrasing-tool.html" style="background:white')) + 4;
  if (end < 4 || s.includes('href="/free-spanish-paraphrasing-tool.html"')) return s;
  return s.slice(0, end) + card('/free-spanish-paraphrasing-tool.html', '🌎', 'Español', 'Parafraseador gratis, sin límite de palabras')
    + card('/free-portuguese-paraphrasing-tool.html', '🌍', 'Português', 'Parafraseador grátis, sem limite de palavras')
    + card('/free-chinese-paraphrasing-tool.html', '🌏', '中文', '免费改写工具，不限字数')
    + card('/free-filipino-paraphrasing-tool.html', '🇵🇭', 'Filipino', 'Libreng paraphraser, walang word limit') + s.slice(end);
});
edit('free-paraphrasing-tool-philippines.html', (s) => once(s, 'href="/free-filipino-paraphrasing-tool.html"', '</h1>',
  '\n<p style="margin:10px auto 0;font-size:14px;"><a href="/free-filipino-paraphrasing-tool.html" style="color:inherit;">Basahin sa Filipino →</a></p>'));
