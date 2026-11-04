#!/usr/bin/env node
'use strict';
// SEO phase 2/4 (idempotent): structured data that matches what the page shows.
//   1. BreadcrumbList + a visible breadcrumb trail on every indexable page that has none (not the home page)
//   2. HowTo built from the page's own visible "How to use it" step list (pages without visible steps get none)
//   3. Organization: one entity — the same name and url ("https://parafree.app/") everywhere
// Run: node scripts/seo-schema.js [--dry-run]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const SITE = 'https://parafree.app/';

const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;|’/g, '’').replace(/\s+/g, ' ').trim();
const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const labelOf = (s) => {
  const h1 = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  let t = h1 ? strip(h1[1]) : strip((s.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]);
  t = t.split(/ — | \| | – /)[0].replace(/:.*$/, '').trim();
  return t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, '') + '…' : t;
};
function parentOf(file) {
  if (file === 'blog.html') return null;
  if (/^blog-/.test(file)) return { name: 'Blog', url: SITE + 'blog.html' };
  if (/^free-cv-builder-|cv-/.test(file)) return { name: 'CV Builder', url: SITE + 'cv-builder.html' };
  if (/flashcard|quiz|study/.test(file)) return { name: 'Study tools', url: SITE + 'ai-study-tools.html' };
  if (/pdf|jpg|word-to/.test(file) && file !== 'pdf-tools.html') return { name: 'PDF Tools', url: SITE + 'pdf-tools.html' };
  return null;
}
const ld = (o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>\n`;

const report = { crumbs: [], howto: [], org: 0 };
for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
  const f = path.join(ROOT, file);
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n');
  const before = s;
  const noindex = /<meta name="robots" content="[^"]*noindex/.test(s);
  if (noindex || file === '404.html' || /^google[0-9a-f]+\.html$/.test(file)) continue;

  // 3. one Organization entity
  s = s.replace(/("@type"\s*:\s*"Organization"\s*,\s*"name"\s*:\s*"ParaFree"\s*,\s*"url"\s*:\s*)"https:\/\/parafree\.app"/g, `$1"${SITE}"`);

  // 1. breadcrumbs
  if (file !== 'index.html' && !/BreadcrumbList/.test(s) && /<h1[\s>]/.test(s)) {
    const label = labelOf(s), parent = parentOf(file);
    const items = [{ name: 'Home', url: SITE }].concat(parent ? [parent] : [], [{ name: label, url: SITE + file }]);
    const json = { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })) };
    s = s.replace('</head>', ld(json) + '</head>');
    const nav = '<nav class="pf-crumbs" aria-label="Breadcrumb" style="font-size:13px;opacity:.78;margin:0 0 12px;">'
      + items.slice(0, -1).map((it) => `<a href="${it.url.replace(SITE, '/')}" style="color:inherit;">${escHtml(it.name)}</a> <span aria-hidden="true">›</span> `).join('')
      + `<span aria-current="page">${escHtml(label)}</span></nav>\n`;
    s = s.replace(/(\n[ \t]*)(<h1[\s>])/, (m, ws, h) => ws + nav + ws.replace('\n', '') + h);
    report.crumbs.push(file);
  }

  // 2. HowTo from the visible "How to use it" steps
  if (!/"HowTo"/.test(s)) {
    const m = s.match(/<h[23][^>]*>([^<]*How to use it[^<]*)<\/h[23]>[\s\S]{0,600}?<ol[^>]*>([\s\S]*?)<\/ol>/i);
    if (m) {
      const steps = [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x) => strip(x[1])).filter(Boolean);
      if (steps.length >= 3) {
        const name = 'How to use ' + labelOf(s);
        const json = { '@context': 'https://schema.org', '@type': 'HowTo', name, totalTime: 'PT2M',
          estimatedCost: { '@type': 'MonetaryAmount', currency: 'USD', value: '0' },
          step: steps.map((t, i) => ({ '@type': 'HowToStep', position: i + 1, name: t.split(/[.:—]/)[0].slice(0, 80), text: t })) };
        s = s.replace('</head>', ld(json) + '</head>');
        report.howto.push(file + ' (' + steps.length + ' steps)');
      }
    }
  }
  if (s !== before) {
    if ((before.match(/"https:\/\/parafree\.app"/g) || []).length !== (s.match(/"https:\/\/parafree\.app"/g) || []).length) report.org++;
    if (!DRY) fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  }
}
console.log(`breadcrumbs added: ${report.crumbs.length}\nHowTo added: ${report.howto.join(', ') || 'none'}\nOrganization url normalised on ${report.org} pages${DRY ? ' (dry run)' : ''}`);
