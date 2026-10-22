'use strict';
// Automatic model discovery — api/_model-discovery.js + its wiring in api/process.js.
// Everything is mocked: provider model lists and chat endpoints (global.fetch, unknown URLs
// throw), Upstash (fake @upstash/redis injected into the module cache) and the clock.
// "Cold starts" re-require api/process.js so in-memory state resets while Upstash persists.
// Run: node tests/model-discovery.test.js

const path = require('path');
const MD = require('../api/_model-discovery.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

// ── Env ──
const KEYS = {
  GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GROQ_KEY_3: 'groq-key-3-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx',
  NVIDIA_KEY: 'nvapi-xxxxxxxxxxxxx', ADMIN_PASSWORD: 'test-admin',
  KV_REST_API_URL: 'https://fake-upstash.example', KV_REST_API_TOKEN: 'fake-token-xxxxxxxx',
};
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|_PREFS$/.test(k)) delete process.env[k];
Object.assign(process.env, KEYS);

// ── Clock ──
const realNow = Date.now;
let clockShift = 0;
Date.now = () => realNow() + clockShift;
const advance = (ms) => { clockShift += ms; };
const HOUR = 3600 * 1000;

// ── Fake Upstash (persists across "cold starts") ──
const store = new Map();          // key → { value(json), exAt }
const setLog = [];                // [{ key, ex }]
const fakeRedis = {
  async get(k) { const e = store.get(k); if (!e) return null; if (e.exAt && e.exAt <= Date.now()) { store.delete(k); return null; } return JSON.parse(e.value); },
  async set(k, v, opts = {}) { store.set(k, { value: JSON.stringify(v), exAt: opts.ex ? Date.now() + opts.ex * 1000 : 0 }); setLog.push({ key: k, ex: opts.ex }); return 'OK'; },
  async lpush() { return 1; }, async lrange() { return []; },
  // HSET/HDEL are atomic per field in Upstash — modify synchronously so parallel writes don't clobber each other.
  async hset(k, obj) { const e = store.get(k); const cur = e ? JSON.parse(e.value) : {}; Object.assign(cur, JSON.parse(JSON.stringify(obj))); store.set(k, { value: JSON.stringify(cur), exAt: 0 }); setLog.push({ key: k, hset: Object.keys(obj) }); return 1; },
  async hgetall(k) { return (await fakeRedis.get(k)) || null; },
  async hdel(k, f) { const e = store.get(k); const cur = e ? JSON.parse(e.value) : {}; delete cur[f]; store.set(k, { value: JSON.stringify(cur), exAt: 0 }); return 1; },
  async expire() { return 1; },
};
const redisPath = require.resolve('@upstash/redis', { paths: [path.join(__dirname, '..', 'api')] });
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => fakeRedis } }, children: [] };

// ── Provider model lists ──
const g = (id, created = 0) => ({ id, created });
let GROQ_LIST = [
  g('openai/gpt-oss-120b', 1754000000), g('openai/gpt-oss-20b', 1754000000), g('llama-3.3-70b-versatile', 1733000000),
  g('llama-3.1-8b-instant', 1722000000), g('meta-llama/llama-guard-4-12b', 1745000000), g('whisper-large-v3', 1700000000),
  g('playai-tts', 1740000000), g('meta-llama/llama-4-scout-17b-16e-instruct', 1744000000), g('llama-3.2-90b-vision-preview', 1730000000),
];
let GEMINI_LIST = [
  ['gemini-3.5-flash-lite', ['generateContent']], ['gemini-3.1-flash-lite', ['generateContent']], ['gemini-2.5-flash-lite', ['generateContent']],
  ['gemini-3.5-flash-lite-preview-09-2026', ['generateContent']], ['gemini-3.5-flash', ['generateContent']],
  ['gemma-3-27b-it', ['generateContent']], ['gemma-3-12b-it', ['generateContent']], ['gemma-3n-e4b-it', ['generateContent']],
  ['text-embedding-004', ['embedContent']], ['gemini-embedding-001', ['embedContent']], ['imagen-4.0-generate-001', ['predict']],
];
let CF_LIST = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3-8b-instruct', '@cf/meta/llama-3.1-8b-instruct-fast', '@cf/meta/llama-guard-3-8b'];
let NVIDIA_LIST = ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash', 'mistralai/mistral-large-2-instruct',
  'nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3-flash', 'nv-mistralai/mistral-nemo-12b-instruct', 'nvidia/nv-embedqa-e5-v5'];
const BASE = { GROQ_LIST: GROQ_LIST.slice(), GEMINI_LIST: GEMINI_LIST.slice(), CF_LIST: CF_LIST.slice(), NVIDIA_LIST: NVIDIA_LIST.slice() };
function resetLists() { GROQ_LIST = BASE.GROQ_LIST.slice(); GEMINI_LIST = BASE.GEMINI_LIST.slice(); CF_LIST = BASE.CF_LIST.slice(); NVIDIA_LIST = BASE.NVIDIA_LIST.slice(); }

// ── Fetch mock ──
let listMode = 'ok';            // 'ok' | 'fail' | 'slow'
let listCalls = [];             // GET model-list URLs
let calls = [];                 // chat calls: { name, body, t }
let behaviour = {};             // entry name / key / provider → 'ok' | 'fail' | 'dead' | { status, body }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const respond = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
const keyOfAuth = (auth) => auth.includes(KEYS.GROQ_KEY_3) ? 'groq-3' : auth.includes(KEYS.GROQ_KEY_2) ? 'groq-2' : 'groq';

global.fetch = async (url, opts = {}) => {
  const auth = (opts.headers && opts.headers.Authorization) || '';
  if (opts.method === 'GET') {
    let list = null;
    if (url === 'https://api.groq.com/openai/v1/models') list = { data: GROQ_LIST.map(m => ({ ...m, object: 'model', active: true })) };
    else if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) list = { models: GEMINI_LIST.map(([id, methods]) => ({ name: 'models/' + id, supportedGenerationMethods: methods })) };
    else if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/') && url.includes('/ai/models/search')) list = { success: true, result: CF_LIST.map(name => ({ name, created_at: '2025-01-01 00:00:00' })) };
    else if (url === 'https://integrate.api.nvidia.com/v1/models') list = { data: NVIDIA_LIST.map(id => ({ id, created: 0 })) };
    if (!list) throw new Error('UNMOCKED URL — refusing live call: ' + url);
    listCalls.push(url.replace(/key=[^&]+/, 'key=***'));
    if (listMode === 'fail') return respond(503, { error: 'unavailable' });
    if (listMode === 'slow') await sleep(3000);
    return respond(200, list);
  }
  let body = {};
  try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
  let name = null;
  if (url.startsWith('https://api.groq.com/openai/v1/chat/completions')) name = keyOfAuth(auth) + '/' + body.model;
  else if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) name = 'gemini/' + url.match(/\/models\/([^:]+):/)[1];
  else if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/') && url.includes('/ai/run/')) name = 'cloudflare/' + url.split('/ai/run/')[1];
  else if (url === 'https://integrate.api.nvidia.com/v1/chat/completions') name = 'nvidia/' + body.model;
  else if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) name = 'ovhcloud';
  else if (url.startsWith('https://api.llm7.io/')) name = 'llm7';
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls.push({ name, body, t: Date.now() });
  const b = behaviour[name] || behaviour[name.split('/')[0]] || 'fail';
  const text = `[${name}] paraphrased output text paraphrased output text`;
  if (b === 'ok') {
    if (name.startsWith('gemini/')) return respond(200, { candidates: [{ content: { parts: [{ text }] } }] });
    if (name.startsWith('cloudflare/')) return respond(200, { success: true, result: { response: text } });
    return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
  }
  if (b === 'timeout') { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; }
  if (b === 'quota') return respond(429, { error: { message: 'Rate limit reached for model on tokens per minute (TPM): Limit 8000, Used 7990' } });
  if (b === 'dead') return respond(404, { error: { message: `The model \`${body.model || name}\` has been decommissioned and is no longer supported`, code: 'model_decommissioned' } });
  if (typeof b === 'object') return respond(b.status, b.body);
  return respond(500, { error: 'mock failure' });
};

// ── Logs ──
let logs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;
function quiet() { const cap = (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); console.log = cap; console.warn = cap; console.error = cap; }
function loud() { console.log = realLog; console.warn = realWarn; console.error = realErr; }

// ── Handler instances ("cold starts") ──
let handler;
function coldStart() {
  for (const f of ['../api/process.js', '../api/_model-discovery.js']) delete require.cache[require.resolve(f)];
  quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
}
let ipSeq = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': `10.1.0.${++ipSeq}` }, body };
  let status = 0, payload = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; } };
  calls = []; listCalls = [];
  const logStart = logs.length;
  const t0 = Date.now();
  quiet();
  try { await handler(req, res); } finally { loud(); }
  return { status, payload, calls: calls.map(c => c.name), rawCalls: calls.slice(), listCalls: listCalls.slice(), logs: logs.slice(logStart), t0 };
}
async function settle(ms = 50) { quiet(); try { await sleep(ms); } finally { loud(); } }

const M120 = 'openai/gpt-oss-120b', M20 = 'openai/gpt-oss-20b', LLAMA = 'llama-3.3-70b-versatile';
const GROQS = ['groq', 'groq-2', 'groq-3'];
const rot = (arr, i) => [...arr.slice(i), ...arr.slice(0, i)];
const keyOf = (n) => n.split('/')[0];
// v2.4 chain (as the chat-call names this mock records)
function v24Chain(firstKey, geminiT2 = 'gemini-3.1-flash-lite') {
  const ks = rot(GROQS, GROQS.indexOf(firstKey));
  return [...ks.map(k => k + '/' + M120), 'gemini/gemini-3.5-flash-lite',                                   // Tier 1
          ...ks.map(k => k + '/' + M20), ...ks.map(k => k + '/' + LLAMA), 'gemini/' + geminiT2, 'gemini/gemma-3-27b-it',   // Tier 2
          'ovhcloud', 'llm7',                                                                            // Tier 3 (NVIDIA filtered out here)
          'cloudflare/@cf/meta/llama-3.1-8b-instruct'];                                                  // Tier 4 (safety net)
}
const SHORT = 'This is a short paragraph that needs paraphrasing for the test suite here.';
const firstNonNvidia = (names) => names.filter(n => !n.startsWith('nvidia/'));

(async () => {
  // ── 1. Pure matching / resolution ──
  console.log('\n── 1. Matching & resolution (pure) ──');
  const re = MD.patternRe('llama-*-versatile');
  assert('wildcard matches', re.test('llama-3.3-70b-versatile') && re.test('LLAMA-4-70b-versatile'));
  assert('wildcard anchored (no prefix/suffix match)', !re.test('meta-llama/llama-3.3-70b-versatile') && !re.test('llama-3.3-70b-versatile-x'));
  for (const w of MD.EXCLUDE_WORDS) assert(`excluded unless named: ${w}`, !MD.isTextModel(`model-${w}-1`, 'model-*') && MD.isTextModel(`model-${w}-1`, `model-*${w}*`));
  const gemList = GEMINI_LIST.filter(([, m]) => m.includes('generateContent')).map(([id]) => g(id));
  const r1 = MD.resolveSlots(['gemini-*-flash-lite', 'gemini-*-flash-lite', 'gemma-*-it'], gemList, () => false, []);
  assert('newest-first + no duplicates: 3.5-flash-lite, 3.1-flash-lite, gemma-3-27b-it',
    r1.map(s => s.model).join(',') === 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-3-27b-it', JSON.stringify(r1));
  assert('preview model not picked by a pattern that does not name it', !r1.some(s => /preview/.test(s.model)));
  const r2 = MD.resolveSlots(['gemma-*-it'], [...gemList, g('gemma-4-31b-it')], () => false, []);
  assert('a newer generation wins (gemma-4-31b-it)', r2[0].model === 'gemma-4-31b-it');
  const r3 = MD.resolveSlots(['llama-*'], GROQ_LIST, () => false, []);
  assert('"llama-*" skips guard / vision / instant? newest text model', r3[0].model === 'llama-3.3-70b-versatile' || r3[0].model === 'llama-3.1-8b-instant', r3[0].model);
  assert('"llama-*" never picks guard or vision-preview', !/guard|vision/.test(r3[0].model));
  const r4 = MD.resolveSlots(['openai/gpt-oss-120b'], GROQ_LIST, (m) => m === M120, [], [], { sort: 'largest' });
  assert('dead model excluded → slot auto-picks the best other text model (never empty)', r4[0].model === LLAMA && r4[0].from === 'auto', JSON.stringify(r4));
  const r5 = MD.resolveSlots(['openai/gpt-oss-120b', 'llama-*-versatile'], null, () => false, ['x', 'llama-3.3-70b-versatile']);
  assert('no list → literal patterns as-is, wildcards → defaults', r5.map(s => s.model).join(',') === `${M120},llama-3.3-70b-versatile`);
  const r6 = MD.resolveSlots(['@cf/meta/llama-*-8b-instruct'], CF_LIST.map(n => g(n)), () => false, []);
  assert('CF: llama-3.1-8b-instruct beats llama-3-8b-instruct; -fast suffix not matched', r6[0].model === '@cf/meta/llama-3.1-8b-instruct');
  const rExp = MD.resolveSlots(['gemini-*', 'gemini-*-exp*'], [g('gemini-9.9-flash-exp-0901'), g('gemini-8.0-pro-experimental'), g('gemini-3.5-flash')], () => false, []);
  assert('exp / experimental models skipped unless the pattern names them', rExp[0].model === 'gemini-3.5-flash' && rExp[1].model === 'gemini-9.9-flash-exp-0901', JSON.stringify(rExp));
  const rLearn = MD.resolveSlots(['*flash*', 'learnlm-*'], [g('learnlm-9.0-flash'), g('gemini-3.5-flash')], () => false, []);
  assert('learnlm skipped unless the pattern names it', rLearn[0].model === 'gemini-3.5-flash' && rLearn[1].model === 'learnlm-9.0-flash', JSON.stringify(rLearn));
  for (const m of ['Groq/x:404 not found', 'NVIDIA:410 gone', 'Gemini/x:404 models/x is not found', 'Cloudflare:410 gone',
                   'model_decommissioned', 'The model has been retired', 'Groq/x:400 The model `x` is deprecated'])
    assert(`dead-model error: "${m}"`, MD.isDeadModelError(m));
  for (const m of ['Groq/x:429 rate limit', 'Gemini/x:500 internal', 'TIMEOUT', 'Groq/x:4040 weird',
                   'Cloudflare: [{"code":7003,"message":"route not found"}]', 'Groq/x:400 account not found', 'resource not found'])
    assert(`not a dead-model error: "${m}"`, !MD.isDeadModelError(m));
  const dp = MD.defaultPrefs({});
  assert('default prefs: groq', dp.groq.join(', ') === 'openai/gpt-oss-120b, openai/gpt-oss-20b, llama-*|qwen*|meta-llama/*|moonshotai/*|*-instruct', dp.groq.join(', '));
  assert('default prefs: gemini', dp.gemini.join(', ') === 'gemini-*-flash-lite, gemini-*-flash, gemma-*-it', dp.gemini.join(', '));
  assert('default prefs: cloudflare', dp.cloudflare.join(', ') === '@cf/*instruct*', dp.cloudflare.join(', '));
  assert('old GROQ_MODEL / GEMMA_MODEL env still honoured', MD.defaultPrefs({ GROQ_MODEL: 'x-model', GEMMA_MODEL: 'gemma-y' }).groq[0] === 'x-model' && MD.defaultPrefs({ GEMMA_MODEL: 'gemma-y' }).gemini[2] === 'gemma-y');
  assert('*_MODEL_PREFS parsed (comma-separated, trimmed)', MD.prefsFor('groq', { GROQ_MODEL_PREFS: ' a , b* ,, c ' }).join('|') === 'a|b*|c');

  // ── 2. Cold start: live discovery → same chain as v2.4, cached in Upstash ──
  console.log('\n── 2. Cold start with live lists ──');
  coldStart();
  let r = await call({ text: SHORT, mode: 'standard' });
  const seq = firstNonNvidia(r.calls);
  assert('6 model lists fetched (3 Groq keys, Gemini, Cloudflare, NVIDIA)', r.listCalls.length === 6, r.listCalls.join(' | '));
  assert('resolved chain = v2.4 shape, Gemini Tier 2 now gemini-*-flash → gemini-3.5-flash', JSON.stringify(seq) === JSON.stringify(v24Chain(keyOf(seq[0]), 'gemini-3.5-flash')), seq.join(' → '));
  assert('NVIDIA: the two working models, ultra then lightning (failing IDs no longer in the chain)',
    r.calls.filter(n => n.startsWith('nvidia/')).join(',') === 'nvidia/nvidia/nemotron-3-ultra-550b-a55b,nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', r.calls.filter(n => n.startsWith('nvidia/')).join(','));
  assert('lists cached in Upstash', ['groq', 'groq-2', 'groq-3', 'gemini', 'cloudflare', 'nvidia'].every(pk => store.has('pf_models:' + pk)));
  assert('Upstash list entries carry fetchedAt (6h freshness) and are kept as fallback', setLog.filter(s => s.key.startsWith('pf_models:')).every(s => s.ex >= 6 * 3600));
  assert('no key material in cache keys', [...store.keys()].every(k => !Object.values(KEYS).some(v => k.includes(v))));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('warm instance: no list fetch while fresh', r.listCalls.length === 0);

  // ── 3. Upstash cache on a new instance; refresh after 6 h; swap logged ──
  console.log('\n── 3. Cache, 6 h refresh, swap log ──');
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('new instance uses the fresh Upstash list (no live fetch)', r.listCalls.length === 0);
  GROQ_LIST.push(g('llama-4.1-70b-versatile', 1760000000));
  advance(6 * HOUR + 60 * 1000);
  r = await call({ text: SHORT, mode: 'standard' });
  assert('stale after 6 h → refresh started (request did not wait for it)', r.listCalls.length === 6);
  await settle();
  const swapLines = logs.filter(l => l.includes('model swap: groq tier2 llama-3.3-70b-versatile → llama-4.1-70b-versatile'));
  assert('swap logged: "model swap: groq tier2 llama-3.3-70b-versatile → llama-4.1-70b-versatile"', swapLines.length >= 1, logs.filter(l => l.includes('model swap')).join(' | '));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('next request uses the newer model in Tier 2', r.calls.some(n => n.endsWith('/llama-4.1-70b-versatile')) && !r.calls.some(n => n.endsWith('/' + LLAMA)), r.calls.join(','));

  // ── 4. Live fetch fails → last cached list; no cache → defaults ──
  console.log('\n── 4. Fallbacks ──');
  advance(7 * HOUR);
  listMode = 'fail';
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('live fails + stale Upstash list → stale list still used (llama-4.1 present)', r.calls.some(n => n.endsWith('/llama-4.1-70b-versatile')), r.calls.join(','));
  store.clear();
  resetLists();
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  const seqDef = firstNonNvidia(r.calls);
  assert('live fails + no cache → defaults (v2.4 chain)', JSON.stringify(seqDef) === JSON.stringify(v24Chain(keyOf(seqDef[0]))), seqDef.join(' → '));
  assert('NVIDIA defaults start at the first default preference (no list to skip retired ones)', r.calls.find(n => n.startsWith('nvidia/')) === 'nvidia/' + MD.defaultPrefs({}).nvidia[0], r.calls.filter(n => n.startsWith('nvidia/')).join(','));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('failed refresh is not retried on every request (5-min backoff)', r.listCalls.length === 0);

  // ── 5. Never block a request on discovery for more than ~1 s ──
  console.log('\n── 5. 1-second cap ──');
  listMode = 'slow';            // lists take 3 s
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  const firstCallDelay = r.rawCalls.length ? r.rawCalls[0].t - r.t0 : Infinity;
  assert('first provider call within ~1.3 s even though lists take 3 s', firstCallDelay < 1300, firstCallDelay + 'ms');
  assert('meanwhile the chain runs on defaults', firstNonNvidia(r.calls).length === 15);
  await settle(3200);
  r = await call({ text: SHORT, mode: 'standard' });
  assert('background refresh finished → lists loaded, no new fetch', r.listCalls.length === 0 && store.has('pf_models:groq'));
  listMode = 'ok';

  // ── 6. Self-healing: retired model → dead 24 h, next model immediately ──
  console.log('\n── 6. Self-healing ──');
  store.clear();
  advance(7 * HOUR);
  coldStart();
  behaviour = { ...Object.fromEntries(GROQS.map(k => [`${k}/${M120}`, 'dead'])), groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  const K = keyOf(r.calls[0]);
  // Slot 0's exact pattern is now dead and its default is the same model, so the slot auto-picks
  // the largest live text model on the key (llama-3.3-70b-versatile) — immediately, same entry.
  assert('120b → 404 decommissioned → same entry retries at once with the slot\'s new model', r.calls.join(',') === `${K}/${M120},${K}/${LLAMA}` && r.payload.success, r.calls.join(','));
  assert('"model dead" logged', r.logs.some(l => l.includes(`model dead: groq/${M120}`)));
  assert(`swap logged: "model swap: ${K} tier1 ${M120} → ${LLAMA}"`, r.logs.some(l => l.includes(`model swap: ${K} tier1 ${M120} → ${LLAMA}`)), r.logs.filter(l => l.includes('swap')).join(' | '));
  assert('handled-by log names the replacement', r.logs.some(l => l.includes(`handled by ${K}/${LLAMA}`)));
  const deadRec = store.get('pf_dead_models');
  assert('dead mark stored in Upstash for 24 h', deadRec && JSON.parse(deadRec.value)[`groq:${M120}`] > Date.now() && setLog.some(s => s.key === 'pf_dead_models' && s.ex === 24 * 3600));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('dead for every Groq key: 120b not tried again', !r.calls.some(n => n.endsWith('/' + M120)), r.calls.join(','));
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('new instance reads the dead mark from Upstash', !r.calls.some(n => n.endsWith('/' + M120)), r.calls.join(','));
  advance(25 * HOUR);
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  await settle();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('after 24 h the model is eligible again', r.calls[0].endsWith('/' + M120), r.calls.join(','));

  // Gemini HTTP 404 + NVIDIA 410
  behaviour = { 'gemini/gemini-3.5-flash-lite': { status: 404, body: { error: { code: 404, message: 'models/gemini-3.5-flash-lite is not found for API version v1beta', status: 'NOT_FOUND' } } },
                'gemini/gemini-3.1-flash-lite': 'ok' };
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('Gemini HTTP 404 → swapped to the next resolved Gemini model at once', r.calls.includes('gemini/gemini-3.5-flash-lite') && r.payload.success && r.logs.some(l => l.includes('model swap: gemini tier1 gemini-3.5-flash-lite → gemini-3.1-flash-lite')), r.calls.join(','));
  behaviour = { 'nvidia/nvidia/nemotron-3-ultra-550b-a55b': { status: 410, body: { error: 'model has reached end of life' } }, 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  const nv = r.calls.filter(n => n.startsWith('nvidia/'));
  assert('NVIDIA 410 → dead + the same entry retries at once with the next model (never a blocked one)', nv.join(',') === 'nvidia/nvidia/nemotron-3-ultra-550b-a55b,nvidia/nvidia/nemotron-3.5-lightning-30b-a3b' && r.payload.success, nv.join(','));
  assert('NVIDIA dead mark + swap logged', r.logs.some(l => l.includes('model dead: nvidia/nvidia/nemotron-3-ultra-550b-a55b')) && r.logs.some(l => l.includes('model swap: nvidia tier3 #1 nvidia/nemotron-3-ultra-550b-a55b → nvidia/nemotron-3.5-lightning-30b-a3b')), r.logs.filter(l => l.includes('swap') || l.includes('dead')).join(' | '));
  assert('a 429 is NOT treated as retired', !MD.isDeadModelError('Groq/openai/gpt-oss-20b:429 Rate limit reached'));

  // ── 7. Env preference lists ──
  console.log('\n── 7. *_MODEL_PREFS ──');
  advance(25 * HOUR);
  process.env.GEMINI_MODEL_PREFS = 'gemini-*-flash, gemma-*-it';
  process.env.GROQ_MODEL_PREFS = 'llama-*-versatile, openai/gpt-oss-*';
  behaviour = {};
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  const s7 = firstNonNvidia(r.calls);
  const K7 = keyOf(s7[0]);
  assert('Tier 1 Groq = first resolved pref (llama-*-versatile)', s7[0] === `${K7}/${LLAMA}`, s7.join(' → '));
  assert('Tier 1 Gemini = gemini-*-flash → gemini-3.5-flash', s7.includes('gemini/gemini-3.5-flash') && s7.indexOf('gemini/gemini-3.5-flash') === 3, s7.join(' → '));
  assert('Tier 2 Groq = openai/gpt-oss-* → newest (120b)', s7.slice(4, 7).every(n => n.endsWith('/' + M120)), s7.join(' → '));
  assert('Tier 2 Gemini = gemma-3-27b-it; no extra slots', s7.includes('gemini/gemma-3-27b-it') && !s7.includes('gemini/gemini-3.1-flash-lite'));
  process.env.GROQ_MODEL_PREFS = 'llama-*';
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('"llama-*" never resolves to guard / vision / preview models', !r.calls.some(n => /guard|vision|preview/.test(n)), r.calls.join(','));
  delete process.env.GROQ_MODEL_PREFS; delete process.env.GEMINI_MODEL_PREFS;

  // ── 8. Health check ──
  console.log('\n── 8. Health check: slots + discovery ──');
  process.env.CF_MODEL_PREFS = '@cf/meta/llama-*-8b-instruct, @cf/nonexistent-*';
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', gemini: 'ok', cloudflare: 'ok', nvidia: 'ok' };
  coldStart();
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const res = r.payload.results, disc = r.payload.discovery;
  const row = res[`groq-2/${M20}`];
  assert('slot row shows pattern, resolved model, tier and status', row && row.pattern === 'openai/gpt-oss-20b' && row.model === M20 && row.tier === 'tier2' && row.status === '✅ working', JSON.stringify(row));
  const gRow = res['gemini/gemma-3-27b-it'];
  assert('wildcard slot shows its pattern (gemma-*-it → gemma-3-27b-it)', gRow && gRow.pattern === 'gemma-*-it' && gRow.tier === 'tier2', JSON.stringify(gRow));
  assert('Cloudflare row is Tier 4 (safety net)', res.cloudflare && res.cloudflare.tier === 'tier4' && res.cloudflare.model === '@cf/meta/llama-3.1-8b-instruct', JSON.stringify(res.cloudflare));
  const auto = Object.entries(res).find(([, v]) => v.pattern === '@cf/nonexistent-*');
  assert('unmatched pattern auto-picks a model and the row says so (pickedBy "auto")', auto && auto[1].pickedBy === 'auto' && auto[1].autoPicked === true && auto[1].model && !/guard/.test(auto[1].model), JSON.stringify(auto));
  assert('no slot is left empty', !Object.keys(res).some(k => k.includes('(no match)')), Object.keys(res).filter(k => k.includes('no match')).join(', '));
  assert('every slot row says how it was picked', Object.values(res).filter(v => v.pattern).every(v => ['match', 'previous', 'literal', 'last-good', 'default', 'auto'].includes(v.pickedBy)));
  assert('NVIDIA rows: one per preference (2), none empty', Object.entries(res).filter(([k, v]) => k.startsWith('nvidia/') && v.model).length === 2, Object.keys(res).filter(k => k.startsWith('nvidia')).join(', '));
  assert('discovery section: per-list source + last refresh time', ['groq', 'groq-2', 'groq-3', 'gemini', 'cloudflare', 'nvidia'].every(pk => disc.lists[pk] && disc.lists[pk].refreshedAt && disc.lists[pk].modelCount > 0), JSON.stringify(disc.lists));
  assert('discovery section: lastFullRefresh + preference lists', disc.lastFullRefresh && disc.prefs.cloudflare[1] === '@cf/nonexistent-*');
  delete process.env.CF_MODEL_PREFS;
  behaviour = { [`groq/${M120}`]: 'dead' };
  await call({ text: SHORT, mode: 'standard' });
  await call({ text: SHORT, mode: 'standard' });
  await call({ text: SHORT, mode: 'standard' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  assert('dead models listed in the discovery section', r.payload.discovery.deadModels.some(d => d.provider === 'groq' && d.model === M120), JSON.stringify(r.payload.discovery.deadModels));

  const CF_OLD = '@cf/meta/llama-3.1-8b-instruct', CF_1B = '@cf/meta/llama-3.2-1b-instruct';
  const fresh = () => { store.clear(); setLog.length = 0; advance(25 * HOUR); resetLists(); behaviour = {}; listMode = 'ok';
                        for (const k of ['GROQ_MODEL_PREFS', 'GEMINI_MODEL_PREFS', 'CF_MODEL_PREFS']) delete process.env[k]; coldStart(); };
  const hget = (k, f) => { const e = store.get(k); return e ? JSON.parse(e.value)[f] : undefined; };

  // ── 9. A slot never goes empty; Cloudflare keeps its previous working model ──
  console.log('\n── 9. Slot fallbacks (regression fix) ──');
  fresh();
  CF_LIST = [CF_1B, '@cf/qwen/qwen1.5-14b-chat-awq', '@cf/meta/llama-guard-3-8b'];      // the model in use is missing from the list
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Cloudflare uses its previous working model even though the list lacks it', r.calls.includes('cloudflare/' + CF_OLD) && !r.calls.includes('cloudflare/' + CF_1B), r.calls.filter(n => n.startsWith('cloudflare')).join(','));
  process.env.CF_MODEL_PREFS = CF_1B;
  behaviour = { ['cloudflare/' + CF_1B]: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  await settle();
  assert('a success stores the slot\'s last good model in Upstash', (hget('pf_last_good', 'cloudflare:0') || {}).model === CF_1B, JSON.stringify(hget('pf_last_good', 'cloudflare:0')));
  process.env.CF_MODEL_PREFS = '@cf/nothing-matches-*';
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('pattern matches nothing → last model that worked for the slot (read from Upstash on a new instance)', r.calls.includes('cloudflare/' + CF_1B), r.calls.filter(n => n.startsWith('cloudflare')).join(','));
  for (const k of [...store.keys()]) if (k.startsWith('pf_models:')) store.delete(k);
  listMode = 'fail';
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('list fetch fails + no cached list → still the last good model', r.calls.includes('cloudflare/' + CF_1B), r.calls.filter(n => n.startsWith('cloudflare')).join(','));
  listMode = 'ok';
  delete process.env.CF_MODEL_PREFS;
  process.env.GROQ_MODEL_PREFS = 'nonexistent-*, openai/gpt-oss-20b';
  store.delete('pf_last_good');
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  const g9 = r.calls.filter(n => n.startsWith('groq')).slice(0, 3);
  assert('Groq slot with no match and no last good → old hard-coded default (120b) in Tier 1', g9.length === 3 && g9.every(n => n.endsWith('/' + M120)), r.calls.slice(0, 5).join(','));
  delete process.env.GROQ_MODEL_PREFS;

  // ── 10. Last known good ordering — within a tier only, shared across instances ──
  console.log('\n── 10. Most recently successful first (within each tier) ──');
  fresh();
  const G1 = 'gemini/gemini-3.5-flash-lite', CFN = 'cloudflare/' + CF_OLD;
  const T1 = (names) => names.filter(n => n.endsWith('/' + M120) || n === G1);
  behaviour = { [G1]: 'ok' };                                         // only Tier-1 Gemini works
  r = await call({ text: SHORT, mode: 'standard' });
  assert('baseline: Gemini is the last Tier 1 entry and handles it', r.calls[r.calls.length - 1] === G1 && r.calls.length === 4, r.calls.join(','));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('next request: the most recently successful Tier 1 entry (Gemini) is tried first', r.calls.join(',') === G1, r.calls.join(','));
  const G3 = 'gemini/gemma-3-27b-it';                                 // a Tier 2 entry (one key, so no group rotation)
  behaviour = { [G3]: 'ok' };                                         // Gemini stops working; only one Tier-2 entry works
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Tier 2 succeeds only after every Tier 1 entry was tried', T1(r.calls.slice(0, 4)).length === 4 && T1(r.calls.slice(4)).length === 0 && r.calls[r.calls.length - 1] === G3, r.calls.join(','));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Tier 1 still fully before Tier 2 (never reordered across tiers)', T1(r.calls.slice(0, 4)).length === 4 && r.calls[4] === G3, r.calls.join(','));
  assert('within Tier 2 the recent winner goes first', r.calls.length === 5, r.calls.join(','));
  assert('within Tier 1 Gemini (recent) still first', r.calls[0] === G1);
  behaviour = { [CFN]: 'ok' };                                        // only the Cloudflare safety net works
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Cloudflare (Tier 4) succeeds only after Tiers 1–3 (incl. NVIDIA, ovhcloud, llm7)', r.calls[r.calls.length - 1] === CFN && r.calls.includes('ovhcloud') && r.calls.includes('llm7') && r.calls.includes('nvidia/nvidia/nemotron-3-ultra-550b-a55b'), r.calls.join(','));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a recent Cloudflare success never moves it ahead of Tiers 1–3', r.calls[r.calls.length - 1] === CFN && r.calls.length > 5, r.calls.join(','));
  await settle();
  assert('success times stored in Upstash (shared hash)', hget('pf_last_success', 'cloudflare') > 0 && hget('pf_last_success', G1) > 0);
  coldStart();
  behaviour = { [G3]: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a new instance uses the shared order (Gemini first in Tier 1, recent Tier 2 winner first in Tier 2)', r.calls[0] === G1 && r.calls[4] === G3, r.calls.join(','));
  advance(61 * 60 * 1000);
  r = await call({ text: SHORT, mode: 'standard' });
  assert('successes older than 1 h no longer reorder (back to Groq rotation)', r.calls[0].endsWith('/' + M120), r.calls.join(','));
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  const usedKeys = new Set();
  for (let i = 0; i < 6; i++) usedKeys.add(keyOf((await call({ text: SHORT, mode: 'standard' })).calls[0]));
  assert('Groq keys that all succeed keep rotating (rotation is the tiebreaker)', usedKeys.size === 3, [...usedKeys].join(','));

  // ── 11. Health check: only auth / retired failures go on the skip list ──
  console.log('\n── 11. Health-check skip list (401/403/404/410/retired only) ──');
  fresh();
  const H = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', gemini: 'ok', cloudflare: 'ok', nvidia: 'ok', ovhcloud: 'ok', llm7: 'ok' };
  const AUTH = { status: 401, body: { error: { message: 'Invalid API Key', code: 'invalid_api_key' } } };
  const FORBID = { status: 403, body: { error: { message: 'Forbidden' } } };
  behaviour = { ...H, [`groq-3/${M120}`]: 'timeout', [`groq-2/${M20}`]: 'dead', [`groq/${M20}`]: 'quota',
                [`groq/${LLAMA}`]: AUTH, [`groq-3/${LLAMA}`]: FORBID, [`groq-2/${LLAMA}`]: 'fail',
                ovhcloud: 'timeout', llm7: 'timeout', 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b': 'timeout' };
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const hk = r.payload.results;
  const skippedNames = r.payload.discovery.skippedEntries.map(s => s.entry);
  assert('timeout row → ❌ failed but NOT skipped', hk[`groq-3/${M120}`].status === '❌ failed' && !hk[`groq-3/${M120}`].skippedForMinutes && !skippedNames.includes(`groq-3/${M120}`), JSON.stringify(hk[`groq-3/${M120}`]));
  assert('slow providers timing out (ovhcloud, llm7, nvidia model) → NOT skipped',
    ['ovhcloud', 'llm7', 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b'].every(n => hk[n] && hk[n].status === '❌ failed' && !hk[n].skippedForMinutes && !skippedNames.includes(n)),
    JSON.stringify(['ovhcloud', 'llm7', 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b'].map(n => hk[n])));
  assert('5xx row → NOT skipped', hk[`groq-2/${LLAMA}`].status === '❌ failed' && !hk[`groq-2/${LLAMA}`].skippedForMinutes, JSON.stringify(hk[`groq-2/${LLAMA}`]));
  assert('401 row → skipped for 15 min', hk[`groq/${LLAMA}`].skippedForMinutes === 15 && skippedNames.includes(`groq/${LLAMA}`), JSON.stringify(hk[`groq/${LLAMA}`]));
  assert('403 row → skipped for 15 min', hk[`groq-3/${LLAMA}`].skippedForMinutes === 15, JSON.stringify(hk[`groq-3/${LLAMA}`]));
  assert('404 row → marked dead (24 h) and skipped', hk[`groq-2/${M20}`].markedDead === true && hk[`groq-2/${M20}`].skippedForMinutes === 15 && r.payload.discovery.deadModels.some(d => d.model === M20), JSON.stringify(hk[`groq-2/${M20}`]));
  assert('429 row → NOT skipped (rate limits use cooldowns)', hk[`groq/${M20}`].status === '⏳ rate-limited' && !hk[`groq/${M20}`].skippedForMinutes, JSON.stringify(hk[`groq/${M20}`]));

  // Real requests: the timed-out entry is still used; the 401 entry is skipped (also on a new instance).
  behaviour = { [`groq-3/${M120}`]: 'ok', [`groq/${LLAMA}`]: 'ok', ovhcloud: 'ok' };
  const seen11 = [];
  for (let i = 0; i < 3; i++) seen11.push(...(await call({ text: SHORT, mode: 'standard' })).calls);
  assert('real requests still use the entry that only timed out in the health check', seen11.includes(`groq-3/${M120}`), seen11.join(','));
  behaviour = { ovhcloud: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('real requests skip the 401 entry; slow ovhcloud is still tried', !r.calls.includes(`groq/${LLAMA}`) && r.calls.includes('ovhcloud') && r.payload.success, r.calls.join(','));
  await settle();
  coldStart();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('the 401 skip is shared across instances (Upstash)', !r.calls.includes(`groq/${LLAMA}`) && r.calls.includes(`groq-2/${LLAMA}`), r.calls.join(','));
  behaviour = { ...H };
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  assert('health-check success clears the skip', r.payload.results[`groq/${LLAMA}`].status === '✅ working' && !r.payload.discovery.skippedEntries.some(s => s.entry === `groq/${LLAMA}`));
  behaviour = { ...H, [`groq/${LLAMA}`]: AUTH };
  await call({ type: 'testKeys', adminPassword: 'test-admin' });
  advance(16 * 60 * 1000);
  behaviour = { [`groq/${LLAMA}`]: 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('a skip expires after 15 min', r.calls.includes(`groq/${LLAMA}`), r.calls.join(','));

  // ── 12. Broader automatic patterns ──
  console.log('\n── 12. Broader patterns + auto-pick ──');
  assert('"|" alternatives', MD.patternRe('llama-*|qwen*|meta-llama/*').test('qwen/qwen3-32b') && MD.patternRe('llama-*|qwen*').test('llama-3.3-70b-versatile') && !MD.patternRe('llama-*|qwen*').test('mistral-7b'));
  assert('size parsing', MD.sizeOf('llama-3.3-70b-versatile') === 70 && MD.sizeOf('meta-llama/llama-4-maverick-17b-128e-instruct') === 17 && MD.sizeOf('gemma-3n-e4b-it') === 4 && MD.sizeOf('moonshotai/kimi-k2-instruct') === 0);
  const groqNew = [g(M120), g(M20), g('qwen/qwen3-32b'), g('moonshotai/kimi-k2-instruct'), g('meta-llama/llama-4-maverick-17b-128e-instruct'),
                   g('llama-3.1-8b-instant'), g('meta-llama/llama-guard-4-12b'), g('whisper-large-v3'), g('playai-tts')];
  const rg = MD.resolveSlots(MD.defaultPrefs({}).groq, groqNew, () => false, MD.defaultModels({}).groq, [], { sort: 'largest' });
  assert('Groq Tier 2 broad slot: llama-3.3-70b gone → largest other chat model (qwen3-32b)', rg[2].model === 'qwen/qwen3-32b' && rg[2].from === 'match', JSON.stringify(rg));
  const rg2 = MD.resolveSlots(MD.defaultPrefs({}).groq, GROQ_LIST, () => false, MD.defaultModels({}).groq, [], { sort: 'largest' });
  assert('…and with today\'s list it is still llama-3.3-70b-versatile', rg2[2].model === LLAMA);
  const rgm = MD.resolveSlots(MD.defaultPrefs({}).gemini, gemList, () => false, MD.defaultModels({}).gemini, [], { sort: 'newest' });
  assert('Gemini defaults → gemini-3.5-flash-lite, gemini-3.5-flash, gemma-3-27b-it', rgm.map(s => s.model).join(',') === 'gemini-3.5-flash-lite,gemini-3.5-flash,gemma-3-27b-it', JSON.stringify(rgm));
  const cfList = [CF_OLD, CF_1B, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistral/mistral-7b-instruct-v0.1', '@cf/meta/llama-guard-3-8b'].map(n => g(n));
  const cfOpts = { sort: MD.PROVIDER_SORT.cloudflare, preferPrevious: true, minSizeB: MD.MIN_SIZE_B.cloudflare };   // the provider's real settings
  assert('Cloudflare: previous model kept first', MD.resolveSlots(MD.defaultPrefs({}).cloudflare, cfList, () => false, [CF_OLD], [], cfOpts)[0].model === CF_OLD);
  assert('Cloudflare: last good preferred over the default', MD.resolveSlots(MD.defaultPrefs({}).cloudflare, cfList, () => false, [CF_OLD], ['@cf/mistral/mistral-7b-instruct-v0.1'], cfOpts)[0].model === '@cf/mistral/mistral-7b-instruct-v0.1');
  const cfDead = MD.resolveSlots(MD.defaultPrefs({}).cloudflare, cfList, (m) => m === CF_OLD, [CF_OLD], [], cfOpts)[0];
  assert('Cloudflare: previous model retired → ~7-8B instruct model (mistral-7b), not 1B, not guard', cfDead.model === '@cf/mistral/mistral-7b-instruct-v0.1' && cfDead.from === 'match', JSON.stringify(cfDead));
  const cfBig = MD.resolveSlots(MD.defaultPrefs({}).cloudflare, [CF_1B, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-3.2-3b-instruct'].map(n => g(n)), (m) => m === CF_OLD, [CF_OLD], [], cfOpts)[0];
  assert('Cloudflare: no 7-8B → next larger, smallest of those (24B before 70B)', cfBig.model === '@cf/mistralai/mistral-small-3.1-24b-instruct', JSON.stringify(cfBig));
  const cf3 = MD.resolveSlots(MD.defaultPrefs({}).cloudflare, [CF_1B, '@cf/qwen/qwen1.5-0.5b-chat-instruct', '@cf/meta/llama-3.2-3b-instruct'].map(n => g(n)), (m) => m === CF_OLD, [CF_OLD], [], cfOpts)[0];
  assert('Cloudflare: only small models → 3B allowed, never 1B / 0.5B', cf3.model === '@cf/meta/llama-3.2-3b-instruct', JSON.stringify(cf3));
  const cfTiny = MD.resolveSlots(MD.defaultPrefs({}).cloudflare, [CF_1B, '@cf/qwen/qwen1.5-0.5b-chat-instruct'].map(n => g(n)), (m) => m === CF_OLD, [CF_OLD], [], cfOpts)[0];
  assert('Cloudflare: never auto-picks a model under 3B (slot left without one)', cfTiny.model === null, JSON.stringify(cfTiny));
  const cfExact = MD.resolveSlots([CF_1B], [CF_1B].map(n => g(n)), () => false, [CF_OLD], [], cfOpts)[0];
  assert('Cloudflare: an exact name you set yourself is still allowed (even 1B)', cfExact.model === CF_1B, JSON.stringify(cfExact));
  const ra = MD.resolveSlots(['nothing-*'], [g('whisper-large-v3'), g('playai-tts'), g('meta-llama/llama-guard-4-12b'), g('llama-3.1-8b-instant')], () => false, [], [], { sort: 'largest' });
  assert('no match, no default → auto-pick the best text model with the same exclusions', ra[0].model === 'llama-3.1-8b-instant' && ra[0].from === 'auto', JSON.stringify(ra));
  // Larger reward / reranker / classifier models must lose to a smaller real chat model.
  const rr = MD.resolveSlots(['nothing-*'], [g('nvidia/llama-3.1-nemotron-70b-reward'), g('nvidia/llama-3.2-nv-reranker-30b'),
    g('meta/llama-3.1-40b-classifier'), g('meta/llama-3.1-8b-instruct')], () => false, [], [], { sort: 'largest' });
  assert('auto-pick skips reward, reranker and classifier models', rr[0].model === 'meta/llama-3.1-8b-instruct' && rr[0].from === 'auto', JSON.stringify(rr));
  for (const w of ['reward', 'reranker', 'classifier']) assert(`"${w}" is an excluded word`, MD.EXCLUDE_WORDS.includes(w));
  fresh();
  GROQ_LIST = groqNew;
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', gemini: 'ok', cloudflare: 'ok', nvidia: 'ok' };
  coldStart();
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const q = r.payload.results['groq/qwen/qwen3-32b'];
  assert('health check shows the auto-matched Tier 2 model and how it was picked', q && q.pattern.startsWith('llama-*|qwen*') && q.pickedBy === 'match' && q.tier === 'tier2', JSON.stringify(q));
  assert('health check shows Cloudflare\'s pick', r.payload.results.cloudflare.model === CF_OLD && r.payload.results.cloudflare.pickedBy === 'previous', JSON.stringify(r.payload.results.cloudflare));
  resetLists();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { loud(); console.error(e); process.exit(1); });
