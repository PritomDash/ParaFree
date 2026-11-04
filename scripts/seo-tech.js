#!/usr/bin/env node
'use strict';
// SEO phase 4 (idempotent):
//   1. images: explicit width + height on the logo / icon images (no layout shift), lazy-loading for the footer icon,
//      an alt on the CV builder's photo images
//   2. sitemap.xml lastmod = the date of the last commit that changed that page (working-tree changes = today)
//   3. orphans: the two indexable pages nothing linked to get a link from their natural hub
// Run: node scripts/seo-tech.js
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
function edit(f, fn) {
  const p = path.join(ROOT, f), raw = fs.readFileSync(p, 'utf8'), crlf = raw.includes('\r\n'), s0 = raw.replace(/\r\n/g, '\n');
  const s = fn(s0);
  if (s !== s0) { fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s); return true; }
  return false;
}

// 1. images — logo.svg / logo-dark.svg are 200×48, favicon.svg is square
let imgPages = 0;
for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
  if (edit(f, (s) => s
    .replace(/<img src="\/(logo|logo-dark)\.svg" alt="([^"]*)" height="(\d+)"(?![^>]*\bwidth=)/g, (m, n, alt, h) => `<img src="/${n}.svg" alt="${alt}" width="${Math.round(h * 200 / 48)}" height="${h}"`)
    .replace(/<img src="\/favicon\.svg" alt="([^"]*)" height="(\d+)"(?![^>]*\bwidth=)/g, (m, alt, h) => `<img src="/favicon.svg" alt="${alt}" width="${h}" height="${h}"` + (h === '20' ? ' loading="lazy"' : ''))
    .replace(/<img src="\$\{(cvPhotoData|photo)\}"(?![^>]*\balt=)/g, '<img src="${$1}" alt="Profile photo"'))) imgPages++;
}
console.log(`images fixed on ${imgPages} pages`);

// 2. lastmod from git
const today = new Date().toISOString().slice(0, 10);
const dirty = new Set(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((l) => l.slice(3).trim()).filter(Boolean));
let n = 0;
edit('sitemap.xml', (s) => s.replace(/<loc>https:\/\/parafree\.app\/([^<]*)<\/loc>(\s*)<lastmod>[^<]*<\/lastmod>/g, (m, p, ws) => {
  const file = p || 'index.html';
  let d = dirty.has(file) ? today : '';
  if (!d) { try { d = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) {} }
  n++;
  return `<loc>https://parafree.app/${p}</loc>${ws}<lastmod>${d || today}</lastmod>`;
}));
console.log(`lastmod set for ${n} sitemap URLs`);

// 3. orphans → linked from their hub
const li = (h, t, d) => `\n    <li><a href="${h}">${t}<span>${d}</span></a></li>`;
for (const f of ['ai-study-tools.html', 'flashcard-maker.html']) edit(f, (s) => (s.includes('href="/quizlet-alternative.html"') || !s.includes('<ul class="pf-related">')) ? s
  : s.replace('<ul class="pf-related">', '<ul class="pf-related">' + li('/quizlet-alternative.html', 'Quizlet alternative', 'What ParaFree does for flashcards (and what it doesn’t)')));
edit('cv-builder.html', (s) => s.includes('href="/cv-templates.html"') ? s
  : s.replace('<!-- SEO: FAQ section -->', '<p style="max-width:900px;margin:16px auto 0;padding:0 4px;font-size:14px;color:#4a4540;font-family:\'DM Sans\',sans-serif;">Browse all 54 designs on the <a href="/cv-templates.html" style="color:#2d6a4f;font-weight:600;">free CV templates</a> page.</p>\n\n<!-- SEO: FAQ section -->'));
