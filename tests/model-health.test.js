'use strict';
// Health-based dead marking in api/_model-discovery.js (+ its wiring in api/process.js): a listed-but-broken model
// is taken out after 5 failures in a row (timeout / 5xx / 404 / empty — never 429s), for every key or for one key,
// for 6 h; then one probe call restores it or marks it dead again. Everything is mocked: model lists, provider calls
// and Upstash live in this process; any unmocked URL throws. Run: node tests/model-health.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|_PREFS$|^MODEL_BLOCKLIST$|^PF_HEALTH_FAILS$|^ADMIN_PASSWORD$/.test(k)) delete process.env[k];

const MD = require('../api/_model-discovery.js');
const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
const HOUR = 3600 * 1000;
const quietLog = { log() {}, warn() {}, error() {} };

// ── a discovery instance over fake model lists and a fake Upstash ──
const respond = (status, json) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
const GEMINI_LIST = { models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemma-3-27b-it', 'gemma-3-12b-it']
  .map((id) => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })) };
const NVIDIA_LIST = { data: ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-2-ultra-253b', 'nvidia/nemotron-3-nano-9b', 'meta/llama-3.3-70b-instruct'].map((id) => ({ id })) };
function makeStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: async (k, v) => { m.set(k, JSON.stringify(v)); return 'OK'; },
    hgetall: async () => null, hset: async () => 1, hdel: async () => 1, expire: async () => 1 };
}
async function makeDiscovery(env, store) {
  const fetchWithTimeout = async (url) => {
    if (url.includes('generativelanguage.googleapis.com/v1beta/models?')) return respond(200, GEMINI_LIST);
    if (url.startsWith('https://integrate.api.nvidia.com/v1/models')) return respond(200, NVIDIA_LIST);
    throw new Error('UNMOCKED URL — refusing live call: ' + url);
  };
  const d = MD.createModelDiscovery({ fetchWithTimeout, getRedis: () => store, env, log: quietLog });
  await d.refresh({ force: true });
  return d;
}
const flashSlot = (d, pk) => d.slots(pk)[1].model;   // gemini prefs: [flash-lite, flash, gemma]
const gemmaSlot = (d, pk) => d.slots(pk)[2].model;

(async () => {
  const ENV = { GEMINI_KEY: 'gemini-key-1-xxxxxxxx', GEMINI_KEY_2: 'gemini-key-2-xxxxxxxx', NVIDIA_KEY: 'nvidia-key-xxxxxxxx', MODEL_BLOCKLIST: 'none' };

  console.log('\n── 1. 5 timeouts in a row → dead (every key) → the next model of the same pattern ──');
  let store = makeStore();
  let d = await makeDiscovery(ENV, store);
  assert('baseline: gemini-*-flash → gemini-3.7-flash (newest listed) on both keys', flashSlot(d, 'gemini') === 'gemini-3.7-flash' && flashSlot(d, 'gemini-2') === 'gemini-3.7-flash', flashSlot(d, 'gemini'));
  const abort = 'Gemini/gemini-3.7-flash:The operation was aborted due to timeout';
  for (let i = 0; i < 4; i++) d.noteFailure(i % 2 ? 'gemini-2' : 'gemini', 'gemini-3.7-flash', abort, true);
  assert('4 aborts: still in the chain', flashSlot(d, 'gemini') === 'gemini-3.7-flash');
  const scope = d.noteFailure('gemini', 'gemini-3.7-flash', abort, true);
  assert('5th abort in a row (both keys) → dead for the whole model', scope === 'model' && d.isDead('gemini', 'gemini-3.7-flash'), scope);
  assert('… the flash slot now resolves to the next matching model (gemini-3.5-flash) on both keys', flashSlot(d, 'gemini') === 'gemini-3.5-flash' && flashSlot(d, 'gemini-2') === 'gemini-3.5-flash', flashSlot(d, 'gemini') + ' / ' + flashSlot(d, 'gemini-2'));
  const st = d.status().deadModels.find((x) => x.model === 'gemini-3.7-flash');
  assert('status shows it with kind, reason, since and until (≈ 6 h)', st && st.kind === 'health' && st.key === null && /5× in a row \(timeout\)/.test(st.reason) && st.since && Math.abs(Date.parse(st.until) - Date.now() - 6 * HOUR) < 60000, JSON.stringify(st));
  await new Promise((res) => setTimeout(res, 20));   // the Upstash write is not awaited by the request
  const saved = await store.get('pf_dead_models');
  assert('stored in Upstash pf_dead_models with reason and time', saved && saved['gemini:gemini-3.7-flash'] && saved['gemini:gemini-3.7-flash'].kind === 'health' && /in a row/.test(saved['gemini:gemini-3.7-flash'].reason), JSON.stringify(saved));
  const d2 = await makeDiscovery(ENV, store);
  assert('another instance loads the dead mark and skips the model too', d2.isDead('gemini', 'gemini-3.7-flash') && flashSlot(d2, 'gemini') === 'gemini-3.5-flash');

  console.log('\n── 2. What counts, and what never does ──');
  store = makeStore(); d = await makeDiscovery(ENV, store);
  for (let i = 0; i < 20; i++) d.noteFailure('gemini', 'gemini-3.5-flash-lite', 'Gemini/gemini-3.5-flash-lite:429 {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded per day"}}');
  assert('20 × 429 (rate limit / quota) → never dead', !d.isDead('gemini', 'gemini-3.5-flash-lite') && d.status().deadModels.length === 0);
  for (let i = 0; i < 10; i++) d.noteFailure('gemini', 'gemini-3.5-flash-lite', 'Gemini/gemini-3.5-flash-lite:401 API key not valid');
  assert('auth / 400-type errors never count either', !d.isDead('gemini', 'gemini-3.5-flash-lite'));
  assert('counted kinds: timeout, 5xx, 404, empty answer / null content', d.healthKind('x', true) === 'timeout' && d.healthKind('NVIDIA/m:503 down') === '5xx'
    && d.healthKind('Groq/m:404 not found') === '404' && d.healthKind('Gemini/m:empty no text') === 'empty' && d.healthKind('NVIDIA/m: null content (finish_reason=length)') === 'empty' && d.healthKind('Groq/m:429 rate limit') === null);
  for (let i = 0; i < 4; i++) d.noteFailure('gemini', 'gemini-3.1-flash-lite', 'Gemini/gemini-3.1-flash-lite:500 internal');
  d.noteSuccess('gemini/gemini-3.1-flash-lite', 'gemini', 0, 'gemini-3.1-flash-lite');
  for (let i = 0; i < 4; i++) d.noteFailure('gemini', 'gemini-3.1-flash-lite', 'Gemini/gemini-3.1-flash-lite:500 internal');
  assert('"in a row": a success in between starts the count again (4 + ok + 4 → not dead)', !d.isDead('gemini', 'gemini-3.1-flash-lite'));

  console.log('\n── 3. Fails on one key only → dead for that key only ──');
  store = makeStore(); d = await makeDiscovery(ENV, store);
  assert('baseline: Gemma slot → gemma-3-27b-it on both keys', gemmaSlot(d, 'gemini') === 'gemma-3-27b-it' && gemmaSlot(d, 'gemini-2') === 'gemma-3-27b-it');
  let s = null;
  for (let i = 0; i < 5; i++) {
    s = d.noteFailure('gemini', 'gemma-3-27b-it', 'Gemini/gemma-3-27b-it:500 {"error":{"code":500,"status":"INTERNAL"}}') || s;
    d.noteSuccess('gemini-2/gemma-3-27b-it', 'gemini-2', 2, 'gemma-3-27b-it');   // key 2 keeps working (rotation)
  }
  assert('key-1 Gemma 500 × 5 while gemini-2 Gemma works → dead for key 1 only', s === 'key' && d.isDead('gemini', 'gemma-3-27b-it', 'gemini') && !d.isDead('gemini', 'gemma-3-27b-it', 'gemini-2') && !d.isDead('gemini', 'gemma-3-27b-it'), s);
  assert('… key 1\'s Gemma slot moves to the next gemma (gemma-3-12b-it); gemini-2 keeps gemma-3-27b-it', gemmaSlot(d, 'gemini') === 'gemma-3-12b-it' && gemmaSlot(d, 'gemini-2') === 'gemma-3-27b-it', gemmaSlot(d, 'gemini') + ' / ' + gemmaSlot(d, 'gemini-2'));
  const kd = d.status().deadModels.find((x) => x.model === 'gemma-3-27b-it');
  assert('status shows key = "gemini" (one key only), with the 500 as the reason', kd && kd.key === 'gemini' && /5xx/.test(kd.reason) && /:500/.test(kd.reason), JSON.stringify(kd));
  const solo = await makeDiscovery({ GEMINI_KEY: 'gemini-key-1-xxxxxxxx', MODEL_BLOCKLIST: 'none' }, makeStore());
  for (let i = 0; i < 5; i++) s = solo.noteFailure('gemini', 'gemma-3-27b-it', 'Gemini/gemma-3-27b-it:500 internal');
  assert('with a single key the same failures mark the whole model dead', s === 'model' && solo.isDead('gemini', 'gemma-3-27b-it'), s);

  console.log('\n── 4. After 6 h: one probe call — success restores, failure = dead again ──');
  store = makeStore(); d = await makeDiscovery(ENV, store);
  for (let i = 0; i < 5; i++) d.noteFailure(i % 2 ? 'gemini' : 'gemini-2', 'gemini-3.7-flash', abort, true);
  assert('dead', d.isDead('gemini', 'gemini-3.7-flash'));
  shift += 6 * HOUR + 60000;
  assert('6 h later: back in the chain for one probe', !d.isDead('gemini', 'gemini-3.7-flash') && flashSlot(d, 'gemini') === 'gemini-3.7-flash' && d.status().probingModels.includes('gemini:gemini-3.7-flash'), JSON.stringify(d.status().probingModels));
  d.noteSuccess('gemini/gemini-3.7-flash', 'gemini', 1, 'gemini-3.7-flash');
  assert('the probe works → restored (not probing, not dead)', !d.isDead('gemini', 'gemini-3.7-flash') && !d.status().probingModels.length);
  for (let i = 0; i < 5; i++) d.noteFailure(i % 2 ? 'gemini' : 'gemini-2', 'gemini-3.7-flash', abort, true);
  shift += 6 * HOUR + 60000;
  d.isDead('gemini', 'gemini-3.7-flash');                                   // the slot resolves → probe pending
  const again = d.noteFailure('gemini-2', 'gemini-3.7-flash', 'Gemini/gemini-3.7-flash:503 unavailable');
  assert('a failed probe → dead again at once (one failure, not five), for another 6 h', again === 'model' && d.isDead('gemini', 'gemini-3.7-flash')
    && /probe failed/.test(d.status().deadModels.find((x) => x.model === 'gemini-3.7-flash').reason), again);

  console.log('\n── 5. NVIDIA: patterns that prefer today\'s models, then auto-replace ──');
  store = makeStore(); d = await makeDiscovery(ENV, store);
  const nv = () => d.slots('nvidia').map((x) => x.model);
  assert('today\'s models first: ultra-550b, then lightning-30b', JSON.stringify(nv()) === JSON.stringify(['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b']), nv().join(','));
  assert('both prefs are patterns now (nvidia/nemotron-*)', MD.defaultPrefs({}).nvidia.every((p) => /nvidia\/nemotron-\*/.test(p)));
  for (let i = 0; i < 5; i++) d.noteFailure('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'NVIDIA/nvidia/nemotron-3-ultra-550b-a55b: null content (finish_reason=length)');
  assert('ultra dead (empty answers ×5) → slot 1 takes the next Nemotron ultra (nemotron-2-ultra-253b), lightning stays', JSON.stringify(nv()) === JSON.stringify(['nvidia/nemotron-2-ultra-253b', 'nvidia/nemotron-3.5-lightning-30b-a3b']), nv().join(','));
  for (let i = 0; i < 5; i++) d.noteFailure('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'NVIDIA/x:502 bad gateway');
  assert('lightning dead → slot 2 takes the nano Nemotron', nv()[1] === 'nvidia/nemotron-3-nano-9b', nv().join(','));

  console.log('\n── 6. Wiring: the chain reports failures, dead models show in testKeys and the admin dashboard ──');
  shift = 0;
  Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GEMINI_KEY: 'gemini-key-1-xxxxxxxx', NVIDIA_KEY: 'nvidia-key-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx', ADMIN_PASSWORD: 'test-admin' });
  const { contentOf, fakeAnswer } = require('./_fake-answer');
  let calls = [];
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'GET') return respond(503, { error: 'lists unavailable in this test' });
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
    let name = null;
    if (url.startsWith('https://api.groq.com/')) name = 'groq/' + body.model;
    else if (url.startsWith('https://generativelanguage.googleapis.com/')) name = 'gemini/' + url.match(/\/models\/([^:]+):/)[1];
    else if (url.startsWith('https://integrate.api.nvidia.com/')) name = 'nvidia/' + body.model;
    else if (url.includes('/ai/run/')) name = 'cloudflare';
    else if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/') || url.startsWith('https://api.llm7.io/')) name = 'other';
    if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
    calls.push(name);
    if (name === 'cloudflare') return respond(200, { success: true, result: { response: fakeAnswer(contentOf(body)), usage: { completion_tokens: 10 } } });
    if (name === 'groq/openai/gpt-oss-120b') return respond(429, { error: { message: 'Rate limit reached for model on tokens per day (TPD)' } });
    return respond(500, { error: { message: 'mock outage' } });
  };
  const logs = [];
  const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
  let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
  let ip = 0;
  async function call(body) {
    const req = { method: 'POST', headers: { 'x-forwarded-for': '10.12.0.' + (++ip) }, body };
    let status = 0, payload = null;
    const res = { setHeader() {}, status(x) { status = x; return this; }, json(j) { payload = j; return this; }, end() { return this; }, write() {} };
    calls = [];
    quiet(); try { await handler(req, res); } finally { loud(); }
    return { status, payload, calls: calls.slice() };
  }
  const TXT = 'Students who plan their revision week by week remember much more of what they read before the exam.';
  let r;
  for (let i = 0; i < 5; i++) { handler._writingCooldowns.clear(); r = await call({ text: TXT, mode: 'standard' }); }
  assert('5 requests in which ultra answered 500 → it is dead (all handled by the Cloudflare safety net)', r.status === 200 && logs.some((l) => /model dead: nvidia\/nvidia\/nemotron-3-ultra-550b-a55b — 5× in a row \(5xx\)/.test(l)), logs.filter((l) => /model dead/.test(l)).join(' | '));
  handler._writingCooldowns.clear();
  r = await call({ text: TXT, mode: 'standard' });
  assert('the next request no longer calls it', !r.calls.includes('nvidia/nvidia/nemotron-3-ultra-550b-a55b'), r.calls.join(','));
  assert('the 429-ing gpt-oss-120b (5 × daily quota) is NOT dead', !logs.some((l) => /model dead: groq\/openai\/gpt-oss-120b/.test(l)) && r.calls.includes('groq/openai/gpt-oss-120b'), r.calls.join(','));
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const tk = (r.payload && r.payload.discovery && r.payload.discovery.deadModels) || [];
  assert('testKeys lists the dead model with kind, reason and time', tk.some((x) => x.model === 'nvidia/nemotron-3-ultra-550b-a55b' && x.kind === 'health' && /5xx/.test(x.reason) && x.since && x.until), JSON.stringify(tk).slice(0, 300));
  r = await call({ type: 'adminDashboard', adminPassword: 'test-admin' });
  assert('the admin dashboard lists it too', r.status === 200 && (r.payload.deadModels || []).some((x) => x.model === 'nvidia/nemotron-3-ultra-550b-a55b' && /in a row/.test(x.reason)), JSON.stringify(r.payload && r.payload.deadModels).slice(0, 300));
  const admin = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin.html'), 'utf8');
  assert('admin.html renders a "Dead models (automatic)" table from deadModels / probingModels', /Dead models \(automatic\)/.test(admin) && /d\.deadModels/.test(admin) && /d\.probingModels/.test(admin));
  assert('no key or user text in the dead-model records', !JSON.stringify(tk).includes('nvidia-key') && !JSON.stringify(tk).includes('Students who plan'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log = console.log; console.error(e); process.exit(1); });
