#!/usr/bin/env node
// ParaFree — local indexing crawl (scripts/seo-crawl.js). Read-only: reads the checkout, never the network.
// Resolves every URL the way Vercel serves this repo (vercel.json routes + the parafree.app domain rules) and reports:
//   • sitemap URLs that are not a final 200 self-canonical page (redirect, 404, noindex, canonical elsewhere)
//   • internal links / canonicals / hreflang / og:url / JSON-LD URLs that point at a redirect or a 404
//   • pages whose canonical points at another page, and pages that are neither in the sitemap nor linked
//   • thin pages (main-text words) and near-duplicate pages (shingle overlap)
// Usage: node scripts/seo-crawl.js [--json out.json]
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const HOST = 'https://parafree.app';
const SKIP_FILES = new Set(['404.html', 'admin.html']);   // never indexable

// ── URL → how Vercel answers it ──
// Domain: http:// and www. → 308 to https://parafree.app (Vercel domain settings). Routes: /studypack(.html)(/) → 301
// /flashcard-quiz-maker.html; /<slug> (no extension) → 301 /<slug>.html; then the filesystem; else 404.
// trailingSlash:false → "/x/" → 308 "/x".
function resolve(raw) {
  let u;
  try { u = new URL(raw, HOST + '/'); } catch (_) { return { kind: 'bad', final: null }; }
  if (!/^(www\.)?parafree\.app$/.test(u.hostname)) return { kind: 'external' };
  const hops = [];
  if (u.protocol !== 'https:' || u.hostname !== 'parafree.app') { hops.push('domain'); u.protocol = 'https:'; u.hostname = 'parafree.app'; }
  let p = decodeURIComponent(u.pathname);
  if (p.length > 1 && p.endsWith('/')) { hops.push('trailing-slash'); p = p.replace(/\/+$/, ''); }
  if (/^\/studypack(?:\.html)?$/.test(p)) { hops.push('studypack'); p = '/flashcard-quiz-maker.html'; }
  else if (/^\/[a-z0-9][a-z0-9-]*$/.test(p)) { hops.push('clean-url'); p = p + '.html'; }
  const file = p === '/' ? 'index.html' : p.slice(1);
  const exists = fs.existsSync(path.join(ROOT, file)) && fs.statSync(path.join(ROOT, file)).isFile();
  const final = HOST + p;
  if (!exists) return { kind: '404', final, hops, file };
  return { kind: hops.length ? 'redirect' : '200', final, hops, file, query: u.search, hash: u.hash };
}

const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ');
function mainText(html) {
  let body = (html.match(/<body[\s\S]*<\/body>/i) || [html])[0];
  body = strip(body).replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ');
  return body.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
const words = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
function shingles(t, k = 5) {
  const w = words(t.toLowerCase()), s = new Set();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '));
  return s;
}
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };
const attr = (tag, name) => { const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i')) || tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i')); return m ? m[1] : null; };

function pageUrl(file) { return file === 'index.html' ? HOST + '/' : HOST + '/' + file; }

function crawl() {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const pages = {};
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0];
    const canon = [...head.matchAll(/<link[^>]+rel=["']canonical["'][^>]*>/gi)].map((m) => attr(m[0], 'href'));
    const robots = [...head.matchAll(/<meta[^>]+name=["']robots["'][^>]*>/gi)].map((m) => attr(m[0], 'content') || '').join(',');
    const hreflang = [...head.matchAll(/<link[^>]+hreflang=[^>]*>/gi)].map((m) => attr(m[0], 'href'));
    const og = [...head.matchAll(/<meta[^>]+property=["']og:url["'][^>]*>/gi)].map((m) => attr(m[0], 'content'));
    const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => [...m[1].matchAll(/"(?:url|@id|item)"\s*:\s*"(https?:\/\/[^"#]*)[^"]*"/g)].map((x) => x[1]));
    const body = strip(html);
    const links = [...body.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
      .filter((h) => !/^(mailto:|tel:|javascript:|#|data:)/i.test(h));
    const text = mainText(html);
    const title = ((head.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    const h1 = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    pages[f] = { url: pageUrl(f), canon, robots, hreflang, og, ld, links, words: words(text).length, text, title, h1, noindex: /noindex/i.test(robots) };
  }

  const issues = { sitemap: [], links: [], canonicals: [], hreflang: [], og: [], ld: [], orphans: [], notInSitemap: [], thin: [], dupes: [] };
  const locSet = new Set(locs);
  // sitemap entries
  for (const loc of locs) {
    const r = resolve(loc);
    const f = r.file, pg = f && pages[f];
    let why = null;
    if (r.kind === '404') why = '404';
    else if (r.kind === 'redirect') why = 'redirects (' + r.hops.join('+') + ') → ' + r.final;
    else if (pg && pg.noindex) why = 'noindex';
    else if (pg && pg.canon.length && resolve(pg.canon[0]).final !== r.final) why = 'canonical → ' + pg.canon[0];
    else if (pg && !pg.canon.length) why = 'no canonical';
    if (loc.includes('#') || loc.includes('?')) why = (why ? why + '; ' : '') + 'has ?/#';
    if (why) issues.sitemap.push({ loc, why });
  }
  const dupLocs = locs.filter((l, i) => locs.indexOf(l) !== i);
  dupLocs.forEach((l) => issues.sitemap.push({ loc: l, why: 'listed twice' }));

  const inbound = {};
  for (const [f, pg] of Object.entries(pages)) {
    const self = pg.url;
    if (pg.canon.length > 1) issues.canonicals.push({ page: f, why: pg.canon.length + ' canonical tags' });
    for (const c of pg.canon) {
      const r = resolve(c);
      if (r.kind !== '200') issues.canonicals.push({ page: f, href: c, why: r.kind + (r.hops ? ' ' + r.hops.join('+') : '') });
      else if (r.final !== self && !SKIP_FILES.has(f)) issues.canonicals.push({ page: f, href: c, why: 'points at another page' });
      if (/[?#]/.test(c)) issues.canonicals.push({ page: f, href: c, why: 'has ?/#' });
    }
    if (!pg.canon.length && !SKIP_FILES.has(f) && !pg.noindex) issues.canonicals.push({ page: f, why: 'no canonical' });
    for (const h of pg.hreflang) { const r = resolve(h); if (r.kind !== '200' && r.kind !== 'external') issues.hreflang.push({ page: f, href: h, why: r.kind }); }
    for (const h of pg.og) { const r = resolve(h); if (r.kind !== '200' && r.kind !== 'external') issues.og.push({ page: f, href: h, why: r.kind }); }
    for (const h of pg.ld) { const r = resolve(h); if (r.kind !== '200' && r.kind !== 'external' && !/\.(png|jpe?g|svg|webp|ico)$/i.test(h)) issues.ld.push({ page: f, href: h, why: r.kind + (r.hops ? ' ' + r.hops.join('+') : '') }); }
    for (const h of pg.links) {
      const r = resolve(h);
      if (r.kind === 'external' || r.kind === 'bad') continue;
      if (/\.(pdf|png|jpe?g|svg|webp|txt|xml|zip|docx|pptx|json|js|css)(\?|#|$)/i.test(h)) continue;
      if (r.kind !== '200') issues.links.push({ page: f, href: h, why: r.kind + (r.hops ? ' ' + r.hops.join('+') : ''), final: r.final });
      if (r.file && r.file !== f) (inbound[r.file] = inbound[r.file] || new Set()).add(f);
    }
  }
  for (const [f, pg] of Object.entries(pages)) {
    if (SKIP_FILES.has(f) || pg.noindex) continue;
    if (!locSet.has(pg.url)) issues.notInSitemap.push(f);
    if (f !== 'index.html' && !(inbound[f] && inbound[f].size)) issues.orphans.push(f);
    if (pg.words < 600) issues.thin.push({ page: f, words: pg.words });
  }
  // near-duplicates among indexable pages
  const idx = Object.entries(pages).filter(([f, pg]) => !SKIP_FILES.has(f) && !pg.noindex).map(([f, pg]) => [f, shingles(pg.text)]);
  for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++) {
    const s = jaccard(idx[i][1], idx[j][1]);
    if (s >= 0.35) issues.dupes.push({ a: idx[i][0], b: idx[j][0], overlap: +s.toFixed(2) });
  }
  issues.thin.sort((a, b) => a.words - b.words);
  issues.dupes.sort((a, b) => b.overlap - a.overlap);
  const inboundCount = Object.fromEntries(Object.entries(inbound).map(([k, v]) => [k, v.size]));
  return { pages, locs, issues, inboundCount };
}

module.exports = { resolve, crawl };

if (require.main === module) {
  const { pages, locs, issues, inboundCount } = crawl();
  const out = process.argv.indexOf('--json');
  const summary = Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length]));
  console.log(`pages: ${Object.keys(pages).length}, sitemap URLs: ${locs.length}`);
  console.log('issues:', JSON.stringify(summary));
  for (const [k, v] of Object.entries(issues)) {
    if (!v.length) continue;
    console.log(`\n── ${k} (${v.length}) ──`);
    for (const x of v.slice(0, 400)) console.log('  ' + (typeof x === 'string' ? x + (k === 'orphans' ? '' : '') : JSON.stringify(x)));
  }
  if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify({ issues, inboundCount, pages: Object.fromEntries(Object.entries(pages).map(([f, p]) => [f, { url: p.url, words: p.words, title: p.title, h1: p.h1, canon: p.canon, noindex: p.noindex }])) }, null, 2));
}
