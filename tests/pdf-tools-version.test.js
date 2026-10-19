'use strict';
// lib/pdf-tools is served "immutable" for a year (vercel.json), so every page reference must carry
// the current version (?v=<hash of lib/pdf-tools>) — otherwise visitors could keep stale files.
// Run: node tests/pdf-tools-version.test.js   (fix with: node tests/pdf-tools-version.js --write)

const fs = require('fs');
const path = require('path');
const { version, check } = require('./pdf-tools-version.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); failed++; }
}
const ROOT = path.join(__dirname, '..');

console.log('\n── version references ──');
const v = version();
assert('version is a 10-character hash', /^[0-9a-f]{10}$/.test(v), v);
const problems = check(v);
assert('index.html and pdf-tools.html reference lib/pdf-tools with the current ?v= (run: node tests/pdf-tools-version.js --write)', problems.length === 0, problems.join('; '));
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'pdf-tools.html'), 'utf8');
assert('homepage sets window.PFV', index.includes(`window.PFV='${v}'`));
assert('pdf-tools.html sets window.PFV', page.includes(`window.PFV = '${v}'`));

console.log('\n── files that load other files use the version ──');
for (const f of fs.readdirSync(path.join(ROOT, 'lib', 'pdf-tools')).filter((n) => n.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'pdf-tools', f), 'utf8');
  const literal = src.match(/['"`]\/lib\/pdf-tools\/[^'"`]*['"`]/g) || [];
  if (!literal.length) continue;
  assert(`${f}: builds lib/pdf-tools URLs with window.PFV`, /PFV/.test(src), literal.join(' '));
}

console.log('\n── cache header: only lib/pdf-tools ──');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const withCache = cfg.routes.filter((r) => r.headers && Object.keys(r.headers).some((k) => k.toLowerCase() === 'cache-control'));
assert('exactly one route sets Cache-Control', withCache.length === 1, JSON.stringify(withCache));
const r = withCache[0] || {};
assert('it matches /lib/pdf-tools/ only', r.src === '/lib/pdf-tools/(.*)', r.src);
assert('immutable for a year', r.headers && r.headers['Cache-Control'] === 'public, max-age=31536000, immutable');
assert('continues to the filesystem (no other change to routing)', r.continue === true && !r.dest && !r.status);
assert('it comes before "handle: filesystem"', cfg.routes.indexOf(r) < cfg.routes.findIndex((x) => x.handle === 'filesystem'));
const other = ['/index.html', '/pdf-tools.html', '/lib/tool-events.js', '/api/process', '/pdf-tools.css', '/lib/pdf-toolsx/a.js'];
assert('other paths are not matched', other.every((p) => !new RegExp('^' + r.src + '$').test(p)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
