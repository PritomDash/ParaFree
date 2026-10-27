'use strict';
// Provider tuning (Oct 2026) — api/process.js + api/_model-discovery.js + api/_usage.js:
//  - GROQ_KEY_4 / GEMINI_KEY_2 as separate rotated slots (groq-4, gemini-2)
//  - failing model IDs blocked → wildcard slots move to the next match, NVIDIA = ultra + lightning
//  - quality order after Groq/Gemini: Tier 3 nvidia ultra → nvidia lightning → ovhcloud → llm7
//    (fixed, not reordered by recent success), Cloudflare 8B last as the safety net
//  - per-chunk fair share of the request budget + time kept back for the safety net
//  - a timed-out model sits out 2 min; 429 bodies keep their daily marker / retry-after
//  - daily usage counter in Upstash (counts only, no text), shown in testKeys + PIN endpoint
// Everything is mocked: provider endpoints + model lists (global.fetch, unknown URLs throw),
// Upstash (fake @upstash/redis in the module cache) and the clock. No live API calls.
// Run: node tests/provider-tuning.test.js

const path = require('path');
const MD = require('../api/_model-discovery.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

// ── Env: the four Groq keys and both Gemini keys ──
const KEYS = {
  GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GROQ_KEY_3: 'groq-key-3-xxxxxxxx', GROQ_KEY_4: 'groq-key-4-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-1-xxxxxx', GEMINI_KEY_2: 'gemini-key-2-xxxxxx',
  CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx', NVIDIA_KEY: 'nvapi-xxxxxxxxxxxxx',
  ADMIN_PASSWORD: 'test-admin', FEEDBACK_PIN: 'test-pin-1234',
  KV_REST_API_URL: 'https://fake-upstash.example', KV_REST_API_TOKEN: 'fake-token-xxxxxxxx',
};
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|_PREFS$|^MODEL_BLOCKLIST$|^FALLBACK_ORDER$|_PIN$/.test(k)) delete process.env[k];
Object.assign(process.env, KEYS);

// ── Clock ──
const realNow = Date.now;
let clockShift = 0;
Date.now = () => realNow() + clockShift;
const advance = (ms) => { clockShift += ms; };

// ── Fake Upstash ──
const store = new Map();
const fakeRedis = {
  async get(k) { const e = store.get(k); return e ? JSON.parse(e) : null; },
  async set(k, v) { store.set(k, JSON.stringify(v)); return 'OK'; },
  async lpush() { return 1; }, async lrange() { return []; },
  async hset(k, obj) { const cur = store.has(k) ? JSON.parse(store.get(k)) : {}; Object.assign(cur, JSON.parse(JSON.stringify(obj))); store.set(k, JSON.stringify(cur)); return 1; },
  async hgetall(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
  async hdel(k, f) { const cur = store.has(k) ? JSON.parse(store.get(k)) : {}; delete cur[f]; store.set(k, JSON.stringify(cur)); return 1; },
  async hincrby(k, f, n) { const cur = store.has(k) ? JSON.parse(store.get(k)) : {}; cur[f] = (cur[f] || 0) + n; store.set(k, JSON.stringify(cur)); return cur[f]; },
  async expire() { return 1; },
};
const redisPath = require.resolve('@upstash/redis', { paths: [path.join(__dirname, '..', 'api')] });
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => fakeRedis } }, children: [] };

// ── Model lists (the live lists include the failing models, which must be passed over) ──
const GROQ_LIST = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.1-8b-instant'];
const GEMINI_LIST = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemma-4-31b-it', 'gemma-3-27b-it'];
const NVIDIA_LIST = ['nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash',
  'mistralai/mistral-large-2-instruct', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3-flash', 'nv-mistralai/mistral-nemo-12b-instruct'];
const CF_LIST = ['@cf/meta/llama-3.1-8b-instruct'];

// ── Fetch mock ──
const respond = (status, json, headers = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json),
  headers: { get: (h) => headers[String(h).toLowerCase()] ?? null },
});
const GROQS = ['groq', 'groq-2', 'groq-3', 'groq-4'];
const groqKeyOf = (auth) => GROQS.find((k, i) => auth.includes(KEYS[i === 0 ? 'GROQ_KEY' : 'GROQ_KEY_' + (i + 1)]));
let calls = [], listCalls = [];
let behaviour = {};
let lastTimeoutMs = null;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...rest) { lastTimeoutMs = ms; return realSetTimeout(fn, ms, ...rest); };

global.fetch = async (url, opts = {}) => {
  const auth = (opts.headers && opts.headers.Authorization) || '';
  if (opts.method === 'GET') {
    let list = null;
    if (url === 'https://api.groq.com/openai/v1/models') list = { data: GROQ_LIST.map(id => ({ id, active: true })) };
    else if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) list = { models: GEMINI_LIST.map(id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })) };
    else if (url.includes('/ai/models/search')) list = { success: true, result: CF_LIST.map(name => ({ name })) };
    else if (url === 'https://integrate.api.nvidia.com/v1/models') list = { data: NVIDIA_LIST.map(id => ({ id })) };
    if (!list) throw new Error('UNMOCKED URL — refusing live call: ' + url);
    listCalls.push(url.includes('generativelanguage') ? (url.includes(KEYS.GEMINI_KEY_2) ? 'gemini-2' : 'gemini') : url.includes('groq') ? groqKeyOf(auth) : url);
    return respond(200, list);
  }
  let body = {};
  try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
  let name = null;
  if (url.startsWith('https://api.groq.com/openai/v1/chat/completions')) name = groqKeyOf(auth) + '/' + body.model;
  else if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) name = (url.includes(KEYS.GEMINI_KEY_2) ? 'gemini-2/' : 'gemini/') + url.match(/\/models\/([^:]+):/)[1];
  else if (url.includes('/ai/run/')) name = 'cloudflare';
  else if (url === 'https://integrate.api.nvidia.com/v1/chat/completions') name = 'nvidia/' + body.model;
  else if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) name = 'ovhcloud';
  else if (url.startsWith('https://api.llm7.io/')) name = 'llm7';
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls.push({ name, timeoutMs: lastTimeoutMs, body });
  const b = behaviour[name] || behaviour[name.split('/')[0]] || 'fail';
  const text = `[${name}] paraphrased output text paraphrased output text`;
  if (b === 'ok') {
    if (name.startsWith('gemini')) return respond(200, { candidates: [{ content: { parts: [{ text }] } }] });
    if (name === 'cloudflare') return respond(200, { success: true, result: { response: text } });
    return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
  }
  if (b === 'timeout') { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; }
  if (b === 'daily') return respond(429, { error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199990' } });
  if (typeof b === 'object') return respond(b.status, b.body, b.headers);
  return respond(500, { error: 'mock failure' });
};

// ── Logs / handler ──
let logs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;
function quiet() { const cap = (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); console.log = cap; console.warn = cap; console.error = cap; }
function loud() { console.log = realLog; console.warn = realWarn; console.error = realErr; }
quiet();
const handler = require('../api/process.js');
loud();
let ipSeq = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': `10.2.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body };
  let status = 0, payload = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; } };
  calls = []; listCalls = [];
  const logStart = logs.length;
  quiet();
  try { await handler(req, res); await new Promise(r => realSetTimeout(r, 20)); } finally { loud(); }
  return { status, payload, calls: calls.map(c => c.name), rawCalls: calls.slice(), listCalls: listCalls.slice(), logs: logs.slice(logStart) };
}
const reset = (b = {}) => { behaviour = b; advance(61 * 60 * 1000); };   // expires cooldowns + recent-success ordering

const M120 = 'openai/gpt-oss-120b', M20 = 'openai/gpt-oss-20b';
const NV_U = 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', NV_L = 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b';
const SHORT = 'This is a short paragraph that needs paraphrasing for the test suite here.';
const LONG = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(100)).join('\n\n');
const SECRET_TEXT = 'Confidential thesis sentence about zebra migration patterns in 2026.';
const T12_FAIL = Object.fromEntries([...GROQS, 'gemini', 'gemini-2'].map(k => [k, 'fail']));   // Tiers 1–2 down

(async () => {
  // ── 1. GROQ_KEY_4 + GEMINI_KEY_2: separate slots, rotated with the others ──
  console.log('\n── 1. groq-4 and gemini-2 slots ──');
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', 'groq-4': 'ok' });
  let r = await call({ text: LONG, mode: 'standard' });
  assert('model lists fetched for groq-4 and gemini-2 too', ['groq-4', 'gemini-2'].every(k => r.listCalls.includes(k)), r.listCalls.join(','));
  assert('4 chunks → each of the four Groq keys serves one (rotation)', new Set(r.calls.map(n => n.split('/')[0])).size === 4 && r.calls.every(n => n.endsWith('/' + M120)), r.calls.join(','));
  reset({ ...Object.fromEntries(GROQS.map(k => [k, 'daily'])), gemini: 'ok', 'gemini-2': 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  const t1 = r.calls.slice(0, 6);
  assert('Tier 1 = groq ×4 (120b) then gemini + gemini-2 (Flash-Lite)', t1.slice(0, 4).every(n => n.endsWith('/' + M120)) && r.calls[4].endsWith('/gemini-3.5-flash-lite'), r.calls.join(','));
  const served = [];
  for (let i = 0; i < 4; i++) served.push((await call({ text: SHORT, mode: 'standard' })).calls.slice(-1)[0]);
  // The mock names a Gemini call "gemini-2/…" only when its URL carries GEMINI_KEY_2.
  assert('both Gemini keys serve requests (gemini and gemini-2 rotate; gemini-2 uses GEMINI_KEY_2)', served.some(n => n.startsWith('gemini/')) && served.some(n => n.startsWith('gemini-2/')), served.join(','));
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', 'groq-4': 'ok', gemini: 'ok', 'gemini-2': 'ok', nvidia: 'ok', ovhcloud: 'ok', llm7: 'ok', cloudflare: 'ok' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const rows = r.payload.results;
  assert('testKeys: separate groq-4 rows', rows[`groq-4/${M120}`] && rows[`groq-4/${M120}`].status === '✅ working' && rows[`groq-4/${M20}`], Object.keys(rows).join(', '));
  assert('testKeys: separate gemini-2 rows', rows['gemini-2/gemini-3.5-flash-lite'] && rows['gemini-2/gemini-3.5-flash-lite'].status === '✅ working', Object.keys(rows).join(', '));
  r = await call({ text: SHORT, mode: 'standard' });
  const kf = logs.find(l => l.startsWith('KEYS FOUND:'));
  assert('KEYS FOUND reports groq4 + gemini2 as present (booleans only)', /"groq4":true/.test(kf) && /"gemini2":true/.test(kf) && !kf.includes(KEYS.GROQ_KEY_4) && !kf.includes(KEYS.GEMINI_KEY_2), kf);

  // ── 2. Failing model IDs blocked; discovery picks the next valid match ──
  console.log('\n── 2. Failing model IDs ──');
  reset({});
  r = await call({ text: SHORT, mode: 'standard' });
  const BLOCKED = ['gemini-3.8-flash', 'gemma-4-31b-it', 'nvidia/llama-3.1-nemotron-70b-instruct', 'mistralai/mistral-large-2-instruct',
                   'nv-mistralai/mistral-nemo-12b-instruct', 'deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'];
  assert('none of the 7 failing models is ever called', !r.calls.some(n => BLOCKED.some(b => n.endsWith('/' + b))), r.calls.join(','));
  assert('Gemini Flash slot → gemini-3.5-flash (next newest), Gemma slot → gemma-3-27b-it', r.calls.includes('gemini/gemini-3.5-flash') && r.calls.includes('gemini/gemma-3-27b-it'), r.calls.join(','));
  assert('NVIDIA: exactly ultra then lightning', r.calls.filter(n => n.startsWith('nvidia/')).join(',') === `${NV_U},${NV_L}`, r.calls.filter(n => n.startsWith('nvidia/')).join(','));
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  assert('testKeys lists the blocked models', BLOCKED.every(b => r.payload.discovery.blockedModels.some(x => x.endsWith(':' + b))), JSON.stringify(r.payload.discovery.blockedModels));
  assert('testKeys has no rows for blocked models', !Object.keys(r.payload.results).some(n => BLOCKED.some(b => n.endsWith('/' + b))), Object.keys(r.payload.results).join(', '));
  assert('MODEL_BLOCKLIST env replaces the list; "none" empties it', MD.blocklist({ MODEL_BLOCKLIST: 'none' }).size === 0 && MD.blocklist({ MODEL_BLOCKLIST: 'gemini:x, nvidia:y' }).has('nvidia:y') && MD.blocklist({}).size === 7);

  // ── 3. Quality order after Groq/Gemini; Cloudflare last ──
  console.log('\n── 3. Fallback order ──');
  reset({ ...T12_FAIL });
  r = await call({ text: SHORT, mode: 'standard' });
  const tail = r.calls.slice(-5);
  assert('after Tiers 1–2: nvidia ultra → nvidia lightning → ovhcloud → llm7 → cloudflare (last)', JSON.stringify(tail) === JSON.stringify([NV_U, NV_L, 'ovhcloud', 'llm7', 'cloudflare']), r.calls.join(' → '));
  for (const body of [{ text: SHORT, type: 'code_assistant' }, { text: SHORT, type: 'cv_extract' }]) {
    reset({ ...T12_FAIL });
    r = await call(body);
    const first = r.calls.slice(0, r.calls.indexOf('cloudflare') + 1).slice(-5);
    assert(`${body.type}: same Tier 3 order, cloudflare last`, JSON.stringify(first) === JSON.stringify([NV_U, NV_L, 'ovhcloud', 'llm7', 'cloudflare']), r.calls.join(' → '));
  }
  reset({ ...T12_FAIL, llm7: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('llm7 serves when the stronger Tier 3 models fail', r.calls.slice(-1)[0] === 'llm7' && r.payload.success);
  behaviour = { ...T12_FAIL, llm7: 'ok', [NV_U]: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a recent llm7 success does NOT move it ahead of nvidia ultra (fixed quality order)', r.calls.slice(-1)[0] === NV_U && !r.calls.includes('llm7'), r.calls.join(','));
  reset({ ...T12_FAIL, cloudflare: 'ok' });
  await call({ text: SHORT, mode: 'standard' });
  behaviour = { ...T12_FAIL, cloudflare: 'ok', ovhcloud: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a recent Cloudflare success does NOT move it ahead of Tier 3', r.calls.slice(-1)[0] === 'ovhcloud' && !r.calls.includes('cloudflare'), r.calls.join(','));

  // ── 4. Per-attempt time caps ──
  console.log('\n── 4. Time caps ──');
  reset({ ...T12_FAIL, cloudflare: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  const tm = (rc, n) => (rc.find(c => c.name === n) || {}).timeoutMs;
  assert('single chunk: nvidia ultra keeps its 25 s slow-provider timeout', tm(r.rawCalls, NV_U) === 25000, String(tm(r.rawCalls, NV_U)));
  assert('single chunk: Groq keeps its 10 s timeout', r.rawCalls.filter(c => c.name.startsWith('groq')).every(c => c.timeoutMs > 9000 && c.timeoutMs <= 10000));
  reset({ ...T12_FAIL, cloudflare: 'ok' });
  r = await call({ text: LONG, mode: 'standard' });
  const firstUltra = tm(r.rawCalls, NV_U);
  assert('4 chunks: chunk 1 ultra capped to its share minus the safety-net reserve (~55/4 − 5 ≈ 8.75 s)', firstUltra >= 8000 && firstUltra <= 8800, String(firstUltra));
  assert('4 chunks: every chunk still reaches the safety net and succeeds', r.calls.filter(n => n === 'cloudflare').length === 4 && r.payload.success, r.calls.join(','));
  assert('no attempt longer than the 25 s slow cap or the 55 s budget', r.rawCalls.every(c => c.timeoutMs <= 25000));
  assert('chunk share logged', r.logs.some(l => /chunk seq=0: \d+ chars, 1[34]s share/.test(l)), r.logs.filter(l => l.includes('share')).slice(0, 2).join(' | '));

  // ── 5. A model that times out sits out 2 min ──
  console.log('\n── 5. Timeout cooldown ──');
  reset({ ...T12_FAIL, [NV_U]: 'timeout', [NV_L]: 'ok' });
  r = await call({ text: LONG, mode: 'standard' });
  assert('ultra timed out once, then skipped for the other chunks', r.calls.filter(n => n === NV_U).length === 1 && r.calls.filter(n => n === NV_L).length === 4, r.calls.join(','));
  assert('"timed out — skipping it for 120s" logged', r.logs.some(l => l.includes(`${NV_U} timed out — skipping it for 120s`)), r.logs.filter(l => l.includes('⏸')).join(' | '));
  advance(121 * 1000);
  behaviour = { ...T12_FAIL, [NV_U]: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('after 2 min ultra is tried again', r.calls.slice(-1)[0] === NV_U, r.calls.join(','));
  reset({ ...T12_FAIL, cloudflare: 'timeout', ovhcloud: 'ok' });
  await call({ text: SHORT, mode: 'standard' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  assert('the safety net never gets a timeout cooldown', !r.payload.results.cloudflare.cooldownSecondsLeft, JSON.stringify(r.payload.results.cloudflare));

  // ── 6. 429s: daily marker past 200 chars, retry-after ──
  console.log('\n── 6. 429 parsing ──');
  const GEM_DAILY = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } } };
  const GEM_MINUTE = JSON.parse(JSON.stringify(GEM_DAILY).replace('PerDay', 'PerMinute'));
  reset({ ...Object.fromEntries(GROQS.map(k => [k, 'fail'])), 'gemini/gemini-3.5-flash-lite': GEM_DAILY, 'gemini-2/gemini-3.5-flash-lite': GEM_MINUTE, ovhcloud: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Gemini per-day quota id beyond 200 chars → daily (900 s, not 41 s)', r.logs.some(l => l.includes('gemini/gemini-3.5-flash-lite daily quota — skipping it for 900s')), r.logs.filter(l => l.includes('⏸')).join(' | '));
  assert('Gemini per-minute → its retryDelay (41 s)', r.logs.some(l => l.includes('gemini-2/gemini-3.5-flash-lite rate-limited — skipping it for 41s')), r.logs.filter(l => l.includes('⏸')).join(' | '));
  reset({ groq: { status: 429, body: { error: { message: 'Rate limit reached for model on tokens per minute (TPM)' } }, headers: { 'retry-after': '30' } },
          'groq-2': { status: 429, body: { error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000' } }, headers: { 'retry-after': '7200' } },
          'groq-3': 'daily', 'groq-4': 'daily', gemini: 'ok', 'gemini-2': 'ok' });
  for (let i = 0; i < 4; i++) await call({ text: SHORT, mode: 'standard' });
  const allLogs = logs.join('\n');
  assert('Groq per-minute 429 with Retry-After 30 → 30 s', new RegExp(`groq/${M120} rate-limited — skipping it for 30s`).test(allLogs));
  assert('Groq TPD 429 with Retry-After 7200 → 7200 s (2 h)', new RegExp(`groq-2/${M120} daily quota — skipping it for 7200s`).test(allLogs));
  assert('Groq TPD 429 without Retry-After → 900 s', new RegExp(`groq-3/${M120} daily quota — skipping it for 900s`).test(allLogs));

  // ── 7. Daily usage counter (counts only) ──
  console.log('\n── 7. Usage counter ──');
  for (const k of [...store.keys()]) if (k.startsWith('pf_usage:')) store.delete(k);
  // the four calls below move the fake clock ~4 h: start at 01:00 UTC so they all count on the same UTC day
  // (they used to straddle midnight when the suite ran after ~05:00 UTC)
  { const now = Date.now(), dayStart = now - (now % 86400000); advance(dayStart + 86400000 + 3600000 - now); }
  reset({ ...T12_FAIL, [NV_L]: 'ok' });
  await call({ text: SECRET_TEXT, mode: 'standard' });
  reset({ ...T12_FAIL, cloudflare: 'ok' });
  await call({ text: LONG, mode: 'standard' });
  reset({});
  await call({ text: SECRET_TEXT, mode: 'standard' });                                   // every provider fails
  reset({ ...T12_FAIL, ovhcloud: 'ok' });
  await call({ text: SECRET_TEXT, type: 'code_assistant' });
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const h = JSON.parse(store.get('pf_usage:' + today) || '{}');
  assert('chunk served by nvidia lightning counted', h['chunk|' + NV_L] === 1, JSON.stringify(h));
  assert('4 chunks served by cloudflare counted', h['chunk|cloudflare'] === 4, JSON.stringify(h));
  assert('a chunk every provider failed counted as (none)', h['chunk|(none)'] === 1, JSON.stringify(h));
  assert('chat request counted separately', h['chat|ovhcloud'] === 1, JSON.stringify(h));
  const usageDump = [...store.entries()].filter(([k]) => k.startsWith('pf_usage:')).map(e => e.join('=')).join('\n');
  assert('no text stored in the usage hash (keys + values only names and counts)', !usageDump.includes('zebra') && !usageDump.includes('Paragraph') && !usageDump.includes('paraphras'), usageDump);
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const day = r.payload.usage && r.payload.usage.days && r.payload.usage.days[0];
  assert('testKeys shows today\'s usage (UTC)', day && day.date === today && r.payload.usage.timezone === 'UTC' && day.totalChunks >= 6, JSON.stringify(r.payload.usage).slice(0, 300));
  assert('…with per-provider totals and the Cloudflare (8B) share', day && day.chunksByProvider.cloudflare >= 4 && day.cloudflareChunks >= 4 && day.cloudflareShare > 0 && day.cloudflareShare <= 100, JSON.stringify(day));
  r = await call({ type: 'providerUsage', pin: 'wrong' });
  assert('providerUsage: wrong PIN → 403', r.status === 403);
  r = await call({ type: 'providerUsage', pin: KEYS.FEEDBACK_PIN, days: 3 });
  assert('providerUsage: right PIN → counts for 3 days', r.status === 200 && r.payload.ok && r.payload.days.length === 3 && r.payload.days[0].chunks.cloudflare >= 4, JSON.stringify(r.payload).slice(0, 300));
  r = await call({ type: 'providerUsage' });
  assert('providerUsage: no PIN → 403', r.status === 403);

  // ── 9. CV writing (cv-quality-fixes): one request, never chunked; strict system prompts ──
  console.log('\n── 9. cv_build / cover_letter: one request with the whole instruction + CV facts ──');
  for (const type of ['cv_build', 'cover_letter']) {
    reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', 'groq-4': 'ok' });
    r = await call({ type, text: 'Instruction line.\n\n' + LONG + '\n\nCandidate data: Telstra, 45 minutes to under 10' });
    const sent = r.rawCalls[0] && r.rawCalls[0].body.messages ? r.rawCalls[0].body.messages.map(m => m.content).join('\n') : '';
    assert(`${type}: a long request (>1,200 words) is ONE provider call, not chunked`, r.status === 200 && r.calls.length === 1, r.calls.join(','));
    assert(`${type}: that call carries the instruction and the CV facts together`, sent.includes('Instruction line.') && sent.includes('Telstra, 45 minutes to under 10'));
    assert(`${type}: system prompt forbids invented facts / figures and asks for placeholders`, /Never invent|never invent/.test(sent) && sent.includes('[X]%'), sent.slice(0, 200));
  }
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', 'groq-4': 'ok' });
  r = await call({ text: LONG, mode: 'standard' });
  assert('paraphraser unchanged: the same long text is still split into 4 chunks', r.calls.length === 4, r.calls.join(','));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { loud(); console.error(e); process.exit(1); });
