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
function v24Chain(firstKey) {
  const ks = rot(GROQS, GROQS.indexOf(firstKey));
  return [...ks.map(k => k + '/' + M120), 'gemini/gemini-3.5-flash-lite', 'cloudflare/@cf/meta/llama-3.1-8b-instruct',
          ...ks.map(k => k + '/' + M20), ...ks.map(k => k + '/' + LLAMA), 'gemini/gemini-3.1-flash-lite', 'gemini/gemma-3-27b-it',
          'ovhcloud', 'llm7'];
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
  const r4 = MD.resolveSlots(['openai/gpt-oss-120b'], GROQ_LIST, (m) => m === M120, []);
  assert('dead model excluded → slot unresolved', r4[0].model === null);
  const r5 = MD.resolveSlots(['openai/gpt-oss-120b', 'llama-*-versatile'], null, () => false, ['x', 'llama-3.3-70b-versatile']);
  assert('no list → literal patterns as-is, wildcards → defaults', r5.map(s => s.model).join(',') === `${M120},llama-3.3-70b-versatile`);
  const r6 = MD.resolveSlots(['@cf/meta/llama-*-8b-instruct'], CF_LIST.map(n => g(n)), () => false, []);
  assert('CF: llama-3.1-8b-instruct beats llama-3-8b-instruct; -fast suffix not matched', r6[0].model === '@cf/meta/llama-3.1-8b-instruct');
  for (const m of ['Groq/x:404 not found', 'NVIDIA:410 gone', 'model_decommissioned', 'The model has been retired', 'Gemini/x:404 models/x is not found'])
    assert(`dead-model error: "${m}"`, MD.isDeadModelError(m));
  for (const m of ['Groq/x:429 rate limit', 'Gemini/x:500 internal', 'TIMEOUT'])
    assert(`not a dead-model error: "${m}"`, !MD.isDeadModelError(m));
  const dp = MD.defaultPrefs({});
  assert('default prefs: groq', dp.groq.join(', ') === 'openai/gpt-oss-120b, openai/gpt-oss-20b, llama-*-versatile', dp.groq.join(', '));
  assert('default prefs: gemini', dp.gemini.join(', ') === 'gemini-*-flash-lite, gemini-*-flash-lite, gemma-*-it', dp.gemini.join(', '));
  assert('default prefs: cloudflare', dp.cloudflare.join(', ') === '@cf/meta/llama-*-8b-instruct');
  assert('old GROQ_MODEL / GEMMA_MODEL env still honoured', MD.defaultPrefs({ GROQ_MODEL: 'x-model', GEMMA_MODEL: 'gemma-y' }).groq[0] === 'x-model' && MD.defaultPrefs({ GEMMA_MODEL: 'gemma-y' }).gemini[2] === 'gemma-y');
  assert('*_MODEL_PREFS parsed (comma-separated, trimmed)', MD.prefsFor('groq', { GROQ_MODEL_PREFS: ' a , b* ,, c ' }).join('|') === 'a|b*|c');

  // ── 2. Cold start: live discovery → same chain as v2.4, cached in Upstash ──
  console.log('\n── 2. Cold start with live lists ──');
  coldStart();
  let r = await call({ text: SHORT, mode: 'standard' });
  const seq = firstNonNvidia(r.calls);
  assert('6 model lists fetched (3 Groq keys, Gemini, Cloudflare, NVIDIA)', r.listCalls.length === 6, r.listCalls.join(' | '));
  assert('resolved chain is identical to v2.4 (Tier 1 → Tier 2 → Tier 3)', JSON.stringify(seq) === JSON.stringify(v24Chain(keyOf(seq[0]))), seq.join(' → '));
  assert('NVIDIA walks only models present in its list (retired one skipped)', r.calls.filter(n => n.startsWith('nvidia/'))[0] === 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', r.calls.filter(n => n.startsWith('nvidia/')).join(','));
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
  assert('120b → 404 decommissioned → same entry retries at once with 20b', r.calls.join(',') === `${K}/${M120},${K}/${M20}` && r.payload.success, r.calls.join(','));
  assert('"model dead" logged', r.logs.some(l => l.includes(`model dead: groq/${M120}`)));
  assert(`swap logged: "model swap: ${K} tier1 ${M120} → ${M20}"`, r.logs.some(l => l.includes(`model swap: ${K} tier1 ${M120} → ${M20}`)), r.logs.filter(l => l.includes('swap')).join(' | '));
  assert('handled-by log names the replacement', r.logs.some(l => l.includes(`handled by ${K}/${M20}`)));
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

  // Gemini "not found" + NVIDIA 410
  behaviour = { 'gemini/gemini-3.5-flash-lite': { status: 404, body: { error: { code: 404, message: 'models/gemini-3.5-flash-lite is not found for API version v1beta', status: 'NOT_FOUND' } } },
                'gemini/gemini-3.1-flash-lite': 'ok' };
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('Gemini "not found" → swapped to the next resolved Gemini model at once', r.calls.includes('gemini/gemini-3.5-flash-lite') && r.payload.success && r.logs.some(l => l.includes('model swap: gemini tier1 gemini-3.5-flash-lite → gemini-3.1-flash-lite')), r.calls.join(','));
  behaviour = { 'nvidia/nvidia/nemotron-3-ultra-550b-a55b': { status: 410, body: { error: 'model has reached end of life' } }, 'nvidia/deepseek-ai/deepseek-v4.1-flash': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  const nv = r.calls.filter(n => n.startsWith('nvidia/'));
  assert('NVIDIA 410 → dead + next model in the same call', nv.join(',') === 'nvidia/nvidia/nemotron-3-ultra-550b-a55b,nvidia/deepseek-ai/deepseek-v4.1-flash' && r.payload.success, nv.join(','));
  assert('NVIDIA swap logged', r.logs.some(l => l.includes('model swap: nvidia tier3 #1 nvidia/nemotron-3-ultra-550b-a55b → deepseek-ai/deepseek-v4.1-flash')), r.logs.filter(l => l.includes('swap')).join(' | '));
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
  assert('Tier 2 Groq = openai/gpt-oss-* → newest (120b)', s7.slice(5, 8).every(n => n.endsWith('/' + M120)), s7.join(' → '));
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
  assert('Tier 1 Cloudflare row', res.cloudflare && res.cloudflare.tier === 'tier1' && res.cloudflare.model === '@cf/meta/llama-3.1-8b-instruct');
  const nm = Object.entries(res).find(([k]) => k.includes('(no match)'));
  assert('unmatched pattern gets its own "no match" row', nm && nm[1].status === '⚠️ no match' && nm[1].pattern === '@cf/nonexistent-*', JSON.stringify(nm));
  assert('NVIDIA rows per resolved model (6) + a no-match row for the retired preference', Object.entries(res).filter(([k, v]) => k.startsWith('nvidia/') && v.model).length === 6 && Object.keys(res).some(k => k.startsWith('nvidia/(no match)')), Object.keys(res).filter(k => k.startsWith('nvidia')).join(', '));
  assert('discovery section: per-list source + last refresh time', ['groq', 'groq-2', 'groq-3', 'gemini', 'cloudflare', 'nvidia'].every(pk => disc.lists[pk] && disc.lists[pk].refreshedAt && disc.lists[pk].modelCount > 0), JSON.stringify(disc.lists));
  assert('discovery section: lastFullRefresh + preference lists', disc.lastFullRefresh && disc.prefs.cloudflare[1] === '@cf/nonexistent-*');
  delete process.env.CF_MODEL_PREFS;
  behaviour = { [`groq/${M120}`]: 'dead' };
  await call({ text: SHORT, mode: 'standard' });
  await call({ text: SHORT, mode: 'standard' });
  await call({ text: SHORT, mode: 'standard' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  assert('dead models listed in the discovery section', r.payload.discovery.deadModels.some(d => d.provider === 'groq' && d.model === M120), JSON.stringify(r.payload.discovery.deadModels));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { loud(); console.error(e); process.exit(1); });
