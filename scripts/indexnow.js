#!/usr/bin/env node
'use strict';
// Tell IndexNow search engines (Bing, Yandex, Seznam, Naver…) that pages changed.
// The key file /<key>.txt (repo root, deployed with the site) proves we own parafree.app.
//
//   node scripts/indexnow.js                      # every URL in sitemap.xml
//   node scripts/indexnow.js /compress-pdf.html https://parafree.app/pdf-to-word.html
//   node scripts/indexnow.js --dry-run [urls…]    # print the request, send nothing
//
// Run it AFTER the pages are live on production (IndexNow fetches the key file to verify).
// Tests only ever use --dry-run.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const HOST = 'parafree.app';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function keyFile() {
  const f = fs.readdirSync(ROOT).find((n) => /^[0-9a-f]{32}\.txt$/.test(n));
  if (!f) throw new Error('No IndexNow key file (<32 hex chars>.txt) in the repo root');
  const key = f.slice(0, -4);
  if (fs.readFileSync(path.join(ROOT, f), 'utf8').trim() !== key) throw new Error(`${f} must contain exactly its own key`);
  return key;
}

function sitemapUrls() {
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function normalise(u) {
  const url = new URL(u, `https://${HOST}/`);
  if (url.host !== HOST) throw new Error(`Not a ${HOST} URL: ${u}`);
  return url.href;
}

function payload(urls) {
  const key = keyFile();
  return { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: [...new Set(urls.map(normalise))] };
}

function send(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main(argv) {
  const dry = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--dry-run');
  const body = payload(args.length ? args : sitemapUrls());
  if (dry) { console.log(JSON.stringify({ endpoint: ENDPOINT, ...body }, null, 2)); return 0; }
  const res = await send(body);
  // 200 OK, 202 Accepted (key check pending); 400/403/422/429 are errors
  console.log(`IndexNow: HTTP ${res.status} for ${body.urlList.length} URL(s)${res.text ? ' — ' + res.text : ''}`);
  return res.status === 200 || res.status === 202 ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
module.exports = { payload, sitemapUrls, keyFile };
