'use strict';
// Phase 3 — stop all providers cooling down at once: api/_pacer.js (shared Upstash cooldowns + counters + headroom)
// and its wiring in api/process.js. Upstash is a FAKE in-memory store shared by two pacers ("two instances");
// providers are MOCKED via global.fetch (unknown URLs throw). Run: node tests/pacer.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
const { createPacer, durationMs, nextMidnight, limitsFor } = require('../api/_pacer.js');

// ── fake Upstash (hash commands used by the pacer and api/_usage.js), counts every command ──
function fakeRedis() {
  const h = new Map(); let commands = 0;
  const hash = (k) => { if (!h.has(k)) h.set(k, {}); return h.get(k); };
  return {
    get commands() { return commands; },
    async hgetall(k) { commands++; return Object.assign({}, h.get(k) || {}); },
    async hset(k, o) { commands++; Object.assign(hash(k), o); return 1; },
    async hdel(k, f) { commands++; delete hash(k)[f]; return 1; },
    async hincrby(k, f, n) { commands++; const o = hash(k); o[f] = (Number(o[f]) || 0) + n; return o[f]; },
    async expire() { commands++; return 1; },
    async get() { commands++; return null; }, async set() { commands++; return 'OK'; },
  };
}
let clock = Date.UTC(2026, 10, 5, 3, 0, 0);          // 03:00 UTC = 19:00 Pacific (PST)
const now = () => clock;
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('\n── 1. Cooldown kinds ──');
  const R = fakeRedis();
  let rnd = 0.5;
  const A = createPacer({ getRedis: () => R, now, random: () => rnd });
  let ms = A.note('groq/openai/gpt-oss-120b', 'minute', 30);
  assert('per-minute 429 with retry-after 30 → 30 s + jitter (0–3 s)', ms >= 30000 && ms <= 33000, ms);
  ms = A.note('groq-2/openai/gpt-oss-120b', 'minute', 0);
  assert('per-minute 429 without retry-after → 20 s + jitter', ms >= 20000 && ms <= 23000, ms);
  // HOTFIX contract: EVERY cooldown is capped at 120 s, including daily-quota 429s. Groq TPD is a rolling window,
  // so cooling until the daily reset locked providers for hours; a day 429 now cools ≤120 s and the probe retries.
  ms = A.note('gemini/gemini-3.5-flash-lite', 'day', 41);
  assert('Gemini per-day 429 → capped at 120 s (not midnight Pacific)', ms <= 120000, ms);
  ms = A.note('groq-3/openai/gpt-oss-120b', 'day', 7200);
  assert('Groq TPD 429 with retry-after 7200 → capped at 120 s (not 2 h)', ms <= 120000, ms);
  ms = A.note('groq-4/openai/gpt-oss-120b', 'day', 0);
  assert('Groq per-day 429 without retry-after → capped at 120 s (not next UTC midnight)', ms <= 120000, ms);
  A.noteHeaders('groq-2/openai/gpt-oss-20b', { remReq: 3, remTok: 500, resetReq: '2m59.56s', resetTok: '7.66s' });
  ms = A.note('groq-2/openai/gpt-oss-20b', 'day', 100);
  assert('Groq TPD 429 with retry-after 100 s + reset header → capped at 120 s', ms <= 120000, ms);
  ms = A.note('gemini-2/gemini-3.5-flash', 'day', 100);
  assert('Gemini RPD 429 with retryDelay 100 s → capped at 120 s', ms <= 120000, ms);
  ms = A.note('gemini/gemma-4-26b-it', 'overload');
  assert('Google 500/503 overload → a few seconds (8–10 s), not a quota cooldown', ms >= 8000 && ms <= 10000, ms);
  ms = A.note('nvidia/x', 'timeout');
  assert('timeout → 60 s (hard cap)', ms === 60000);
  rnd = 0; const j0 = A.note('llm7', 'minute', 10); rnd = 0.999; const j1 = A.note('ovhcloud', 'minute', 10);
  assert('jitter spreads retries (same retry-after → different cooldown ends)', j1 - j0 > 2500, `${j0} vs ${j1}`);
  assert('Groq reset strings parse ("2m59.56s", "7.66s", "1h2m3s")', durationMs('2m59.56s') === 179560 && durationMs('7.66s') === 7660 && durationMs('1h2m3s') === 3723000);

  console.log('\n── 2. Two instances share the state (Upstash) ──');
  const B = createPacer({ getRedis: () => R, now, random: () => 0.5 });
  await tick();
  await B.sync(true);
  assert('instance B sees the per-day cooldown instance A wrote', B.isCooling('gemini/gemini-3.5-flash-lite') && B.isCooling('groq-4/openai/gpt-oss-120b'));
  assert('… and the minute one', B.isCooling('groq/openai/gpt-oss-120b'));
  clock += 121 * 1000;                                  // just past the 120 s cap
  assert('every cooldown (incl. daily) is off after 120 s', !A.isCooling('gemini/gemini-3.5-flash-lite') && !B.isCooling('gemini/gemini-3.5-flash-lite') && !A.isCooling('groq-4/openai/gpt-oss-120b'));

  console.log('\n── 3. One probe after a cooldown ──');
  const name = 'gemini/gemini-3.5-flash-lite';
  assert('cooldown over → not cooling, and the first request may probe', !A.isCooling(name) && !A.probeBlocked(name));
  assert('instance A starts the probe', A.startProbe(name) === true);
  await tick();
  await B.sync(true);
  assert('while A probes, instance B holds back (shared probe flag)', B.probeBlocked(name));
  assert('… and so does a second request on A', A.probeBlocked(name));
  A.noteSuccess(name, 500, null);
  await tick(); await B.sync(true);
  assert('probe succeeded → full traffic again on both instances', !A.probeBlocked(name) && !A.isCooling(name));
  const C = createPacer({ getRedis: () => R, now, random: () => 0.5 });
  await C.sync(true);
  assert('a fresh instance does not see the cleared cooldown', !C.isCooling(name) && !C.probeBlocked(name));

  console.log('\n── 4. Headroom from rate-limit headers and counters ──');
  const H = createPacer({ getRedis: () => null, now, random: () => 0.5 });
  H.noteHeaders('groq/openai/gpt-oss-120b', { remReq: 50, remTok: 7000, resetReq: '2m59.56s', resetTok: '7.66s' });
  assert('Groq remaining 50 of 1,000 requests/day → headroom 0.05', Math.abs(H.headroom('groq/openai/gpt-oss-120b') - 0.05) < 1e-9, H.headroom('groq/openai/gpt-oss-120b'));
  assert('no data → headroom 1', H.headroom('groq-2/openai/gpt-oss-120b') === 1);
  for (let i = 0; i < 450; i++) H.noteSuccess('gemini/gemini-3.5-flash-lite', 0, null);
  assert('Flash-Lite: 450 of 500 requests today → headroom 0.10 (below the 15 % reserve)', Math.abs(H.headroom('gemini/gemini-3.5-flash-lite') - 0.1) < 1e-9);
  assert('free-tier limits table: gpt-oss 30 RPM / 1K RPD / 8K TPM / 200K TPD; Gemma 16K TPM', JSON.stringify(limitsFor('groq/openai/gpt-oss-20b')) === JSON.stringify({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }) && limitsFor('gemini/gemma-4-26b-it').tpm === 16000);

  console.log('\n── 5. Upstash commands stay well inside the free tier ──');
  const U = fakeRedis();
  let t = Date.UTC(2026, 10, 5, 0, 0, 0);
  const P = createPacer({ getRedis: () => U, now: () => t, random: () => 0.5 });
  // one simulated day like today's traffic: ~920 documents → ~2,400 chunks, ~1,000 requests, spread over 24 h,
  // with ~150 cooldown events (429/overload) — usage.record's own 1 command/chunk is counted on top
  const chunks = 2400, requests = 1000, events = 150;
  for (let i = 0; i < requests; i++) {
    t += Math.floor(86400000 / requests);
    await P.sync();
    for (let k = 0; k < Math.round(chunks / requests); k++) P.noteSuccess('groq-' + (k % 4 + 1) + '/openai/gpt-oss-120b', 1300, null);
    if (i % Math.round(requests / events) === 0) { P.note('gemini/gemini-3.5-flash-lite', 'overload'); }
    await tick();
  }
  const perDay = U.commands + chunks;                    // + api/_usage.js HINCRBY per chunk (already there today)
  const perMonth = perDay * 30;
  console.log(`   pacer commands/day ≈ ${U.commands} (+ ${chunks} usage counts) → ≈ ${Math.round(perMonth / 1000)}K/month`);
  assert('pacer + usage counts ≈ ' + Math.round(perMonth / 1000) + 'K commands/month — well inside 500K (with today\'s ~120K other use)', perMonth + 120000 < 400000, perMonth);

  // ── handler-level: max 3 providers, reserve for short requests, header spreading, queue ──
  for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|^PF_MAX/.test(k)) delete process.env[k];
  Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GEMINI_KEY: 'gemini-key-1-xxxxxxxx', GEMINI_KEY_3: 'gemini-key-3-xxxxxxxx',
    CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx' });
  const { fakeAnswer, contentOf } = require('./_fake-answer');
  const KEYN = { 'groq-key-1-xxxxxxxx': 'groq', 'groq-key-2-xxxxxxxx': 'groq-2' };
  let behaviour = () => 'ok', calls = [];
  const respond = (status, json, headers = {}) => ({ ok: status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => json, text: async () => JSON.stringify(json) });
  global.fetch = async (url, opts) => {
    if (opts && opts.method === 'GET') return respond(503, { error: 'lists unavailable in this test' });
    const body = JSON.parse(opts.body || '{}');
    let name;
    if (url.startsWith('https://api.groq.com/')) name = KEYN[(opts.headers.Authorization || '').slice(7)] + '/' + body.model;
    else if (url.startsWith('https://generativelanguage.googleapis.com/')) name = (url.includes('gemini-key-3') ? 'gemini-3' : 'gemini') + '/' + url.match(/\/models\/([^:]+):/)[1];
    else if (url.includes('/ai/run/')) name = 'cloudflare';
    else if (/nvidia|ovh|llm7/.test(url)) name = url.split('/')[2];
    else throw new Error('UNMOCKED URL — refusing live call: ' + url);
    calls.push(name);
    const b = behaviour(name);
    if (b === 'fail') return respond(500, { error: 'mock failure' });
    if (b && b.status) return respond(b.status, b.body || {}, b.headers);
    const text = fakeAnswer(contentOf(body));
    const headers = b && b.headers ? b.headers : {};
    if (name.startsWith('gemini')) return respond(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    if (name === 'cloudflare') return respond(200, { success: true, result: { response: text } });
    return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] }, headers);
  };
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  let logs = [];
  const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
  const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
  let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
  let ip = 0;
  async function call(body) {
    const req = { method: 'POST', headers: { 'x-forwarded-for': '10.5.0.' + (++ip) }, body };
    let status = 0, payload = null;
    const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; } };
    calls = []; logs = [];
    quiet(); try { await handler(req, res); } finally { loud(); }
    return { status, payload, calls: calls.slice(), logs: logs.slice() };
  }
  const SHORT = 'Short paragraph for the pacer test that a student wrote about their weekly study plan.';
  const LONGD = Array.from({ length: 4 }, (_, i) => `Section ${i}. ` + 'Learners revise each topic with patience and care every single day. '.repeat(10)).join('\n\n');

  console.log('\n── 6. Max 3 providers per chunk, then split / Retry part ──');
  handler._pacer._reset();
  behaviour = () => 'fail';
  let r = await call({ text: SHORT, mode: 'standard' });
  assert('a failing short chunk tries at most 3 providers (no splitting a single sentence)', r.calls.length <= 3 * 2 && r.logs.some((l) => /3 providers tried — stopping here/.test(l)), r.calls.join(','));
  assert('… and fails cleanly (503, never a silent copy)', r.status === 503);

  console.log('\n── 7. GEMINI_KEY_3 is its own quota pool ──');
  handler._pacer._reset();
  behaviour = (n) => (n.startsWith('groq') || n === 'gemini/gemini-3.5-flash-lite' ? { status: 429, body: { error: { message: 'Quota exceeded for metric: generate_requests_per_model_per_day (GenerateRequestsPerDayPerProjectPerModel)' } } } : 'ok');
  r = await call({ text: SHORT, mode: 'standard' });
  assert('gemini (key 1) at its daily quota → gemini-3 (key 3) answers', r.status === 200 && r.calls.includes('gemini-3/gemini-3.5-flash-lite'), r.calls.join(','));

  console.log('\n── 8. Fixed order: same first key regardless of headroom ──');
  handler._pacer._reset();
  behaviour = (n) => (n.startsWith('groq/') ? { headers: { 'x-ratelimit-remaining-requests': '20', 'x-ratelimit-remaining-tokens': '7900' } } : 'ok');
  r = await call({ text: SHORT, mode: 'standard' });
  const firstKey = r.calls[0];
  r = await call({ text: SHORT, mode: 'standard' });
  r = await call({ text: SHORT, mode: 'standard' });
  // One-provider-at-a-time: the chain is fixed order, so every request starts on the first key
  // (no headroom-based reshuffling). Low headroom no longer moves another key to the front.
  assert('fixed order: requests always start on the first key regardless of headroom', firstKey === 'groq/openai/gpt-oss-120b' && r.calls[0] === 'groq/openai/gpt-oss-120b', `${firstKey} then ${r.calls.join(',')}`);

  console.log('\n── 9. 15 % reserve for short requests ──');
  handler._pacer._reset();
  for (const n of ['groq/openai/gpt-oss-120b', 'groq-2/openai/gpt-oss-120b', 'gemini/gemini-3.5-flash-lite', 'gemini-3/gemini-3.5-flash-lite'])
    handler._pacer.noteHeaders(n, { remReq: 100 });                       // 10 % left on every Tier 1 key
  for (let i = 0; i < 460; i++) { handler._pacer.noteSuccess('gemini/gemini-3.5-flash-lite', 0); handler._pacer.noteSuccess('gemini-3/gemini-3.5-flash-lite', 0); }
  behaviour = () => 'ok';
  r = await call({ text: LONGD, mode: 'standard' });
  assert('a long document skips Tier 1 entries below 15 % headroom', r.status === 200 && !r.calls.some((n) => /gpt-oss-120b|flash-lite/.test(n)), r.calls.join(','));
  for (const n of ['groq/openai/gpt-oss-120b', 'groq-2/openai/gpt-oss-120b']) handler._pacer.noteHeaders(n, { remReq: 100 });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a short request (<300 words) still uses them', r.status === 200 && /gpt-oss-120b|flash-lite/.test(r.calls[0] || ''), r.calls.join(','));

  console.log('\n── 10. Long documents wait briefly instead of failing ──');
  handler._pacer._reset();
  for (const n of ['groq/openai/gpt-oss-120b', 'groq-2/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b', 'groq-2/openai/gpt-oss-20b', 'groq/llama-3.3-70b-versatile', 'groq-2/llama-3.3-70b-versatile',
    'gemini/gemini-3.5-flash-lite', 'gemini-3/gemini-3.5-flash-lite', 'gemini/gemini-3.1-flash-lite', 'gemini-3/gemini-3.1-flash-lite', 'gemini/gemma-3-27b-it', 'gemini-3/gemma-3-27b-it', 'ovhcloud', 'llm7'])
    handler._pacer.note(n, 'minute', 12);
  r = await call({ text: LONGD, mode: 'standard' });
  assert('every strong provider cooling for ~12 s → 503 "queued" with retryAfterS (the page waits and retries)', r.status === 503 && r.payload.error === 'queued' && r.payload.retryAfterS >= 12 && r.payload.retryAfterS <= 20 && /High demand — starting in ~\d+ s/.test(r.payload.message), JSON.stringify(r.payload));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a short request is not queued', r.payload.error !== 'queued');

  console.log('\n── 11. Chat / CV: one pass through the chain (no double chain) ──');
  handler._pacer._reset();
  behaviour = () => 'fail';
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('every provider failing → each tried at most once', new Set(r.calls).size === r.calls.length && r.status === 503, r.calls.join(','));

  console.log('\n── 12. Admin dashboard (behind the admin password) ──');
  process.env.ADMIN_PASSWORD = 'test-admin-pw';
  handler._pacer._reset();
  handler._pacer.note('gemini/gemini-3.5-flash-lite', 'day');
  r = await call({ type: 'adminDashboard', adminPassword: 'wrong' });
  assert('wrong password → 401', r.status === 401);
  r = await call({ type: 'adminDashboard' });
  assert('no password → 401', r.status === 401);
  r = await call({ type: 'adminDashboard', adminPassword: 'test-admin-pw' });
  const d = r.payload || {};
  assert('right password → today\'s sections: tools, providers, tokens, 429s by type, cooled, gate, gateway',
    r.status === 200 && ['requestsByTool', 'chunksByProvider', 'chatByProvider', 'tokensByProvider', 'cooldownsByType', 'cooled', 'gateRejections'].every((k) => k in d) && 'gateway' in d, JSON.stringify(d).slice(0, 300));
  assert('cooled providers listed with kind and until-time', d.cooled && d.cooled.some((c) => c.entry === 'gemini/gemini-3.5-flash-lite' && c.kind === 'day' && c.cooling && /T/.test(c.until)));
  assert('the dashboard never carries text or keys', !/Learners revise|Short paragraph|groq-key|gemini-key/.test(JSON.stringify(d)));
  const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin.html'), 'utf8');
  assert('admin.html: noindex, password field not stored (no localStorage), renders with textContent only', /<meta name="robots" content="noindex, nofollow">/.test(page) && !/localStorage|sessionStorage/.test(page) && !/innerHTML/.test(page));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
