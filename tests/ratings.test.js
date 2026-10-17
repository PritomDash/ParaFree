'use strict';
// Live user rating — api/_ratings.js + its wiring in api/process.js.
// Everything is mocked: Upstash (fake @upstash/redis injected into the module cache) and
// global.fetch (any network call fails the test). No live /api/process, no real Upstash.
// Run: node tests/ratings.test.js

const path = require('path');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|^FEEDBACK_PIN$/.test(k)) delete process.env[k];
Object.assign(process.env, { KV_REST_API_URL: 'https://fake-upstash.example', KV_REST_API_TOKEN: 'fake-token-xxxxxxxx', FEEDBACK_PIN: 'test-pin-123' });

// ── Fake Upstash: lists + hashes ──
const lists = new Map(), hashes = new Map();
const fakeRedis = {
  async get() { return null; }, async set() { return 'OK'; }, async expire() { return 1; },
  async lpush(k, v) { const l = lists.get(k) || []; l.unshift(v); lists.set(k, l); return l.length; },
  async lrange(k, a, b) { const l = lists.get(k) || []; return l.slice(a, b === -1 ? undefined : b + 1); },
  async hincrby(k, f, n) { const h = hashes.get(k) || {}; h[f] = (Number(h[f]) || 0) + n; hashes.set(k, h); return h[f]; },
  async hset(k, obj) { hashes.set(k, Object.assign(hashes.get(k) || {}, obj)); return 1; },
  async hgetall(k) { return hashes.has(k) ? Object.assign({}, hashes.get(k)) : null; },
  async hdel() { return 1; },
};
const redisPath = require.resolve('@upstash/redis', { paths: [path.join(__dirname, '..', 'api')] });
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => fakeRedis } }, children: [] };

let netCalls = 0;
global.fetch = async (url) => { netCalls++; throw new Error('network blocked in test: ' + url); };

const R = require('../api/_ratings.js');
const handler = require('../api/process.js');

function call({ method = 'POST', body, query, headers = {} }) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, headers: this.headers, json: d }); return this; },
      end() { resolve({ status: this.statusCode, headers: this.headers }); return this; },
    };
    handler({ method, body, query: query || {}, headers }, res);
  });
}
const SITE = { origin: 'https://parafree.app' };

(async () => {
  console.log('\n── unit ──');
  assert('parafree.app counts', R.isCountedOrigin('https://parafree.app') && R.isCountedOrigin('https://www.parafree.app/'));
  assert('previews / localhost / empty do not count',
    !R.isCountedOrigin('https://parafree-git-live-rating-pritomdash.vercel.app') && !R.isCountedOrigin('http://localhost:3000') && !R.isCountedOrigin(''));
  assert('legacy test-looking entries are spotted', R.looksLikeTest({ comment: 'just testing' }) && R.looksLikeTest({ tool: 'test' }) && R.looksLikeTest({ comment: 'asdf' }));
  assert('real comments are not', !R.looksLikeTest({ comment: 'Great tool, saved my essay' }) && !R.looksLikeTest({ comment: '', tool: 'paraphrase' }));
  const t = R.computeTotals([
    JSON.stringify({ rating: 5, ts: 1 }), JSON.stringify({ rating: 4, ts: 2 }),
    JSON.stringify({ rating: 1, ts: 3, comment: 'test' }), JSON.stringify({ rating: 2, ts: 4, counted: false }),
    JSON.stringify({ rating: 5, ts: 5, counted: true }), 'not json', JSON.stringify({ rating: 9, ts: 6 }),
  ], new Set(['2']));
  assert('computeTotals counts legacy + counted:true, skips test/not-counted/excluded/invalid', t.sum === 10 && t.count === 2, JSON.stringify(t));

  console.log('\n── submit ──');
  let r = await call({ body: { type: 'submitFeedback', rating: 5, comment: 'Love it', tool: 'paraphrase' }, headers: SITE });
  assert('rating from parafree.app → 200', r.status === 200 && r.json.ok === true);
  await call({ body: { type: 'submitFeedback', rating: 4, tool: 'humanize' }, headers: { referer: 'https://parafree.app/#tools' } });
  await call({ body: { type: 'submitFeedback', rating: 1, comment: 'preview check' }, headers: { origin: 'https://parafree-abc123.vercel.app' } });
  await call({ body: { type: 'submitFeedback', rating: 1, comment: 'owner', test: true }, headers: SITE });
  await call({ body: { type: 'submitFeedback', rating: 2 }, headers: {} });
  r = await call({ body: { type: 'submitFeedback', rating: 7 }, headers: SITE });
  assert('invalid rating rejected', r.status === 400);
  const stored = (lists.get('pf_feedback') || []).map(JSON.parse);
  assert('every valid rating is still stored in the list', stored.length === 5, stored.length);
  assert('stored entries carry counted flag', stored.filter(e => e.counted).length === 2 && stored.filter(e => e.counted === false).length === 3);
  assert('totals only count parafree.app (origin or referer), not preview/test/unknown',
    hashes.get('pf_rating').sum === 9 && hashes.get('pf_rating').count === 2, JSON.stringify(hashes.get('pf_rating')));

  console.log('\n── public summary ──');
  R._resetMemo();
  r = await call({ method: 'GET', query: { type: 'ratingSummary' } });
  assert('GET summary → average + count', r.status === 200 && r.json.ok === true && r.json.average === 4.5 && r.json.count === 2, JSON.stringify(r.json));
  assert('only ok/average/count are public (no comments, tools, timestamps)', JSON.stringify(Object.keys(r.json).sort()) === '["average","count","ok"]');
  assert('CDN cache 1 h', /s-maxage=3600/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
  await call({ body: { type: 'submitFeedback', rating: 1 }, headers: SITE });
  r = await call({ method: 'GET', query: { type: 'ratingSummary' } });
  assert('summary is memoised for an hour per instance', r.json.count === 2);
  R._resetMemo();
  r = await call({ method: 'GET', query: { type: 'ratingSummary' } });
  assert('after the cache expires the new rating shows', r.json.count === 3 && r.json.average === 3.3, JSON.stringify(r.json));
  r = await call({ method: 'GET', query: {} });
  assert('other GETs still 405', r.status === 405);

  console.log('\n── one-time backfill ──');
  // Simulate the real situation: old entries without a counted flag and an empty total.
  lists.set('pf_feedback', [
    { rating: 5, ts: 101, comment: 'Brilliant', tool: 'paraphrase' }, { rating: 5, ts: 102, comment: '' },
    { rating: 4, ts: 103, comment: 'good' }, { rating: 1, ts: 104, comment: 'testing the form' },
    { rating: 3, ts: 105, comment: 'ok', counted: false }, { rating: 2, ts: 106, comment: 'meh' },
  ].map(e => JSON.stringify(e)));
  hashes.delete('pf_rating');
  r = await call({ body: { type: 'rebuildRatings', pin: 'wrong', dryRun: false } });
  assert('wrong PIN → 403, nothing written', r.status === 403 && !hashes.has('pf_rating'));
  r = await call({ body: { type: 'rebuildRatings', pin: 'test-pin-123' } });
  assert('dry run by default: reports, writes nothing', r.json.dryRun === true && r.json.count === 4 && r.json.sum === 16 && !hashes.has('pf_rating'), JSON.stringify(r.json));
  assert('dry run lists excluded entries for review', r.json.excluded.map(e => e.ts).sort().join() === '104,105');
  r = await call({ body: { type: 'rebuildRatings', pin: 'test-pin-123', dryRun: false, excludeTs: [106], includeTs: [104] } });
  assert('write with owner exclude/include lists', r.json.count === 4 && r.json.sum === 15 && hashes.get('pf_rating').count === 4 && hashes.get('pf_rating').sum === 15, JSON.stringify(r.json));
  r = await call({ method: 'GET', query: { type: 'ratingSummary' } });
  assert('summary reflects the rebuild immediately', r.json.count === 4 && r.json.average === 3.8, JSON.stringify(r.json));
  r = await call({ body: { type: 'rebuildRatings', pin: 'test-pin-123', dryRun: false, excludeTs: [106], includeTs: [104] } });
  assert('re-running the rebuild is safe (same totals)', hashes.get('pf_rating').count === 4 && hashes.get('pf_rating').sum === 15);

  console.log('\n── no FEEDBACK_PIN configured ──');
  delete process.env.FEEDBACK_PIN;
  for (const type of ['getFeedback', 'rebuildRatings']) {
    for (const pin of ['pf2024', undefined, '']) {
      r = await call({ body: { type, pin, dryRun: false } });
      assert(`${type} refuses when FEEDBACK_PIN is missing (pin=${JSON.stringify(pin)})`, r.status === 503 && !!r.json.error && !r.json.feedback, JSON.stringify(r));
    }
  }
  assert('nothing rewritten without a PIN', hashes.get('pf_rating').count === 4 && hashes.get('pf_rating').sum === 15);
  process.env.FEEDBACK_PIN = 'test-pin-123';

  assert('no network calls were made', netCalls === 0, netCalls);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
