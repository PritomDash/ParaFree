'use strict';
// Hotfix regression tests (cooldown cap, key-prefix bump, invalid-cooldown, all-cooling safety net,
// sequential chunks, budget/duration). Run: node tests/hotfix.test.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); failed++; }
}

const { createPacer, COOL_KEY } = require('../api/_pacer.js');
let clock = Date.UTC(2026, 10, 5, 3, 0, 0);
const now = () => clock;

function fakeRedis() {
  const h = new Map();
  const hash = (k) => { if (!h.has(k)) h.set(k, {}); return h.get(k); };
  return {
    _h: h,
    async hgetall(k) { return Object.assign({}, h.get(k) || {}); },
    async hset(k, o) { Object.assign(hash(k), o); return 1; },
    async hdel(k, f) { delete hash(k)[f]; return 1; },
    async hincrby(k, f, n) { const o = hash(k); o[f] = (Number(o[f]) || 0) + n; return o[f]; },
  };
}

(async () => {
  console.log('\n── 1. daily-quota 429 → cooldown ≤ 120 s (never until daily reset) ──');
  const R = fakeRedis();
  const A = createPacer({ getRedis: () => R, now, random: () => 0.99 });
  // retryAfter huge (would be a daily reset many hours away)
  let ms = A.note('groq/openai/gpt-oss-120b', 'day', 36000);
  assert('day 429 with huge retry-after capped at 120 s', ms <= 120000, ms);
  ms = A.note('gemini/gemini-3.5-flash', 'day', 0);  // would be next Pacific midnight
  assert('day 429 with no retry-after capped at 120 s', ms <= 120000, ms);
  ms = A.note('groq-2/x', 'minute', 9999);
  assert('minute 429 with huge retry-after capped at 120 s', ms <= 120000, ms);
  ms = A.note('groq-3/x', 'timeout');
  assert('timeout cooldown ≤ 120 s', ms <= 120000, ms);

  console.log('\n── 2. old cooldown-key prefix is discarded on deploy ──');
  assert("COOL_KEY bumped to 'pf_cool_v2'", COOL_KEY === 'pf_cool_v2', COOL_KEY);
  const R2 = fakeRedis();
  R2._h.set('pf_cool', { 'groq/x': JSON.stringify({ until: clock + 9e9, kind: 'day', at: clock }) }); // old key, long cooldown
  const B = createPacer({ getRedis: () => R2, now, random: () => 0.5 });
  await B.sync(true);
  assert('long cooldown under OLD key pf_cool is ignored', B.isCooling('groq/x') === false);

  console.log('\n── 3. negative / invalid cooldown value = available (not cooling) ──');
  const R3 = fakeRedis();
  const C = createPacer({ getRedis: () => R3, now, random: () => 0.5 });
  const bad = [
    ['neg', { until: -1793915656, kind: 'day', at: clock }],
    ['zero', { until: 0, kind: 'day', at: clock }],
    ['seconds-not-ms', { until: Math.floor(clock / 1000), kind: 'day', at: clock }],
    ['NaN', { until: 'oops', kind: 'day', at: clock }],
    ['far-future', { until: clock + 9e12, kind: 'day', at: clock }],
  ];
  R3._h.set(COOL_KEY, Object.fromEntries(bad.map(([n, v]) => ['p-' + n, JSON.stringify(v)])));
  await C.sync(true);
  for (const [n] of bad) assert(`invalid cooldown (${n}) → not cooling`, C.isCooling('p-' + n) === false);

  console.log('\n── 4/5/6. source invariants (process.js / vercel.json) ──');
  const proc = fs.readFileSync(path.join(__dirname, '../api/process.js'), 'utf8');
  assert('chunks run sequentially (CHUNK_CONCURRENCY = 1)', /CHUNK_CONCURRENCY\s*=\s*1\b/.test(proc));
  assert('REQUEST_BUDGET raised to 110000', /REQUEST_BUDGET\s*=\s*110000\b/.test(proc));
  // all-cooling safety net: cooldown-skip is gated by !forced in BOTH loops (so all-cooling tries the chain in order)
  const skipGuards = (proc.match(/if \(!forced && isCoolingDown\(c\.name\)\)/g) || []).length;
  assert('both chain loops skip-on-cooldown only when NOT all-cooling (≥3 attempts safety net)', skipGuards === 2, skipGuards);
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert('vercel maxDuration = 120', vj.functions['api/process.js'].maxDuration === 120, vj.functions['api/process.js'].maxDuration);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
