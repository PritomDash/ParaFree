'use strict';
// Provider-chain tests for api/process.js — tiered key+model chain, Groq rotation per
// model group, disabled providers, per key+model cooldowns (60s per-minute / 15 min daily,
// soonest-expiry fallback when all are cooling), slow-provider timeouts, per-chunk
// logging, testKeys per key+model, KEYS FOUND log without key material.
// ALL providers are mocked via global.fetch. No live API calls: any URL not in the
// mock map throws, so a real request can never leave this process.
// Run: node tests/provider-chain.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

// ── Env: every key set (including disabled providers) so only DISABLED_PROVIDERS keeps them out ──
const KEYS = {
  GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GROQ_KEY_3: 'groq-key-3-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx',
  NVIDIA_KEY: 'nvapi-xxxxxxxxxxxxx', OPENROUTER_KEY: 'openrouter-xxxxxxxx', MISTRAL_KEY: 'mistral-1-xxxxxxxx',
  MISTRAL_KEY_2: 'mistral-2-xxxxxxxx', SAMBANOVA_KEY: 'sambanova-xxxxxxxx', DEEPSEEK_KEY: 'deepseek-xxxxxxxxx',
  SCW_KEY: 'scaleway-xxxxxxxxx', HF_KEY: 'hf-xxxxxxxxxxxxxxx', CHUTES_KEY: 'chutes-xxxxxxxxxxx',
  EXTRA1_KEY: 'extra1-xxxxxxxxxxx', EXTRA2_KEY: 'extra2-xxxxxxxxxxx', EXTRA3_KEY: 'extra3-xxxxxxxxxxx',
  EXTRA4_KEY: 'extra4-xxxxxxxxxxx', EXTRA5_KEY: 'extra5-xxxxxxxxxxx', EXTRA6_KEY: 'extra6-xxxxxxxxxxx',
  ADMIN_PASSWORD: 'test-admin',
};
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$/.test(k)) delete process.env[k];
Object.assign(process.env, KEYS);

// ── Chain vocabulary ──
const M120 = 'openai/gpt-oss-120b', M20 = 'openai/gpt-oss-20b', LLAMA = 'llama-3.3-70b-versatile';
const G1 = 'gemini/gemini-3.5-flash-lite', GLITE = 'gemini/gemini-3.1-flash-lite', GEMMA = 'gemini/gemma-3-27b-it';
const GROQS = ['groq', 'groq-2', 'groq-3'];
const rot = (arr, i) => [...arr.slice(i), ...arr.slice(0, i)];
const keyOf = (name) => name.split('/')[0];
// Full expected order for a given starting Groq key (all three Groq model groups share the offset).
function expectedChain(firstKey) {
  const ks = rot(GROQS, GROQS.indexOf(firstKey));
  return [...ks.map(k => k + '/' + M120), G1, 'cloudflare',
          ...ks.map(k => k + '/' + M20), ...ks.map(k => k + '/' + LLAMA), GLITE, GEMMA,
          'ovhcloud', 'llm7', 'nvidia'];
}
const CHAIN_LEN = 16;

// ── Fetch mock ──
// Names a request exactly like the chain entry: "<groq key>/<model>", "gemini/<model>", or the provider.
function providerOf(url, opts, body) {
  const auth = (opts && opts.headers && opts.headers.Authorization) || '';
  if (url.startsWith('https://api.groq.com/')) {
    const k = auth.includes(KEYS.GROQ_KEY_3) ? 'groq-3' : auth.includes(KEYS.GROQ_KEY_2) ? 'groq-2' : 'groq';
    return k + '/' + body.model;
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'gemini/' + (url.match(/\/models\/([^:]+):/) || [])[1];
  if (url.startsWith('https://api.cloudflare.com/')) return 'cloudflare';
  if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) return 'ovhcloud';
  if (url.startsWith('https://api.llm7.io/')) return 'llm7';
  if (url.startsWith('https://integrate.api.nvidia.com/')) return 'nvidia';
  if (url.startsWith('https://openrouter.ai/')) return 'openrouter';
  if (url.startsWith('https://api.mistral.ai/')) return 'mistral';
  if (url.startsWith('https://api.sambanova.ai/')) return 'sambanova';
  if (url.startsWith('https://api.deepseek.com/')) return 'deepseek';
  if (url.startsWith('https://api.scaleway.ai/')) return 'scaleway';
  if (url.startsWith('https://router.huggingface.co/')) return 'huggingface';
  if (url.startsWith('https://api.chutes.ai/')) return 'chutes';
  return null;
}
const DISABLED_HOST_NAMES = ['openrouter', 'mistral', 'sambanova', 'deepseek', 'scaleway', 'huggingface', 'chutes'];

function okBody(name) {
  const text = `[${name}] ${'paraphrased output text '.repeat(3)}`;
  if (name.startsWith('gemini/')) return { candidates: [{ content: { parts: [{ text }] } }] };
  if (name === 'cloudflare') return { success: true, result: { response: text } };
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
}
function respond(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

let calls = [];          // [{ name, body, timeoutMs }]
// Exact entry name (e.g. "groq-2/openai/gpt-oss-20b") is checked first, then its key/provider
// ("groq-2", "gemini") → 'ok' | 'fail' | 'quota' (per-minute) | 'daily' | { status, body }
let behaviour = {};
let lastTimeoutMs = null;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...rest) { lastTimeoutMs = ms; return realSetTimeout(fn, ms, ...rest); };

global.fetch = async (url, opts) => {
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch (_) {}
  const name = providerOf(url, opts, body);
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls.push({ name, body, timeoutMs: lastTimeoutMs });
  const b = behaviour[name] || behaviour[keyOf(name)] || 'fail';
  if (b === 'ok') return respond(200, okBody(name));
  if (typeof b === 'object') return respond(b.status, b.body);
  // Real-world message shapes (Groq): per-minute TPM vs daily RPD
  if (b === 'quota') return respond(429, { error: { message: 'Rate limit reached for model on tokens per minute (TPM): Limit 8000, Used 7990' } });
  if (b === 'daily') return respond(429, { error: { message: 'Rate limit reached for model on requests per day (RPD): Limit 1000, Used 1000' } });
  return respond(500, { error: 'mock failure' });
};

// Clock control for cooldown expiry (timers stay real).
const realNow = Date.now;
let clockShift = 0;
Date.now = () => realNow() + clockShift;
const advance = (ms) => { clockShift += ms; };

// Capture logs (joined strings + raw argument lists)
let logs = [], rawLogs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;
function quiet() {
  const cap = (...a) => { logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); rawLogs.push(a); };
  console.log = cap; console.warn = cap; console.error = cap;
}
function loud() { console.log = realLog; console.warn = realWarn; console.error = realErr; }

const handler = require('../api/process.js');

let ipSeq = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${++ipSeq}` }, body };
  let status = 0, payload = null;
  const res = {
    setHeader() {}, status(s) { status = s; return this; },
    json(j) { payload = j; return this; }, end() { return this; },
  };
  calls = []; logs = []; rawLogs = [];
  quiet();
  try { await handler(req, res); } finally { loud(); }
  return { status, payload, calls: calls.map(c => c.name), rawCalls: calls.slice(), logs: logs.slice(), rawLogs: rawLogs.slice() };
}
function reset(b = {}) { behaviour = b; advance(16 * 60 * 1000); } // also expires any cooldowns (daily = 15 min)

const SHORT = 'This is a short paragraph that needs paraphrasing for the test suite here.';
const LONG = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(100)).join('\n\n');
const groqCalls = (names, model) => names.filter(n => n.startsWith('groq') && (!model || n.endsWith('/' + model)));

(async () => {
  // ── 1. Every tool uses the same tiered chain; disabled providers never called ──
  console.log('\n── 1. Same tiered chain for every tool, all providers failing ──');
  const tools = [
    ['paraphrase', { text: SHORT, mode: 'standard' }],
    ['humanize',   { text: SHORT, mode: 'natural' }],
    ['summarize',  { text: SHORT, type: 'summarize' }],
    ['grammar',    { text: SHORT, type: 'grammar' }],
    ['detector',   { text: SHORT, type: 'detector' }],
    ['cv_build',   { text: SHORT, type: 'cv_build' }],
    ['cv_extract', { text: SHORT, type: 'cv_extract' }],
    ['code_assistant', { text: SHORT, type: 'code_assistant' }],
    ['code_project',   { text: SHORT, type: 'code_project' }],
  ];
  let r;
  for (const [tool, body] of tools) {
    reset({});
    r = await call(body);
    const firstPass = r.calls.slice(0, CHAIN_LEN);           // chat/CV paths retry once — first pass only
    const want = expectedChain(keyOf(firstPass[0]));
    assert(`${tool}: Tier 1 → Tier 2 → Tier 3 in order`, JSON.stringify(firstPass) === JSON.stringify(want), firstPass.join(' → '));
    const bad = r.calls.filter(n => DISABLED_HOST_NAMES.includes(n));
    assert(`${tool}: no disabled provider called`, bad.length === 0, bad.join(','));
  }

  // ── 2. Per-chunk Groq rotation spreads load over 3 keys ──
  console.log('\n── 2. Groq rotation across chunks ──');
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  r = await call({ text: LONG, mode: 'standard' });
  assert('multi-chunk request succeeded', r.status === 200 && r.payload.success, String(r.status));
  assert('4 chunks → 4 calls, all gpt-oss-120b (Tier 1)', r.calls.length === 4 && r.calls.every(n => n.endsWith('/' + M120)), r.calls.join(','));
  assert('all three Groq keys used', new Set(r.calls.map(keyOf)).size === 3, r.calls.join(','));
  assert('consecutive chunks use different keys', r.calls.every((n, i) => i === 0 || keyOf(n) !== keyOf(r.calls[i - 1])), r.calls.join(','));

  // ── 3. Per-chunk logging names key+model ──
  console.log('\n── 3. Logs which key+model handled each chunk ──');
  for (let s = 0; s < 4; s++) {
    assert(`chunk seq=${s} logged with key+model`, r.logs.some(l => new RegExp(`chunk seq=${s} handled by groq(-[23])?/openai/gpt-oss-120b`).test(l)));
  }
  reset({ [`groq-2/${M120}`]: 'fail', groq: 'fail', 'groq-3': 'fail', gemini: 'fail', cloudflare: 'fail', [`groq-2/${M20}`]: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Tier 2 handler logged as key+model', r.logs.some(l => l.includes(`handled by groq-2/${M20}`)), r.logs.filter(l => l.includes('handled')).join(' | '));
  reset({ [`groq-2/${M120}`]: 'ok' });
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('chat path logs key+model', r.logs.some(l => l.includes(`AI request handled by groq-2/${M120}`)));

  // ── 4a. Per-minute rate limit → 60 s cooldown, per key+model ──
  console.log('\n── 4a. Per-minute 429 → 60s cooldown (per key+model) ──');
  reset({ ...Object.fromEntries(GROQS.map(k => [`${k}/${M120}`, 'quota'])), gemini: 'ok' });
  let cooldownStart = Date.now();
  r = await call({ text: LONG, mode: 'standard' });
  assert('each 120b entry called once across 4 chunks', groqCalls(r.calls, M120).length === 3, r.calls.join(','));
  assert('then Tier 1 gemini handles every chunk (no Tier 2 needed)', r.calls.filter(n => n === G1).length === 4 && groqCalls(r.calls, M20).length === 0, r.calls.join(','));
  assert('60s cooldown logged per key+model', r.logs.some(l => /groq(-[23])?\/openai\/gpt-oss-120b rate-limited — skipping it for 60s/.test(l)));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('next request skips the cooled 120b entries', r.calls.join(',') === G1, r.calls.join(','));
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('cooldown applies to chat path too', r.calls.join(',') === G1, r.calls.join(','));
  advance(59 * 1000 - (Date.now() - cooldownStart));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('still cooling at 0:59', groqCalls(r.calls).length === 0, r.calls.join(','));
  advance(2 * 1000);
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('120b tried again after 60s', r.calls.length === 1 && r.calls[0].endsWith('/' + M120), r.calls.join(','));

  // ── 4b. Daily quota → 15 min cooldown ──
  console.log('\n── 4b. Daily quota → 15 min cooldown ──');
  reset({ groq: 'daily', 'groq-2': 'daily', 'groq-3': 'daily', gemini: 'ok' });
  cooldownStart = Date.now();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('900s (15 min) cooldown logged', r.logs.some(l => /groq.* daily quota — skipping it for 900s/.test(l)));
  advance(121 * 1000 - (Date.now() - cooldownStart));                      // 2:01 — past the OLD 2-min cooldown
  r = await call({ text: SHORT, mode: 'standard' });
  assert('still cooling at 2:01 (the old 2-min cooldown would have expired)', groqCalls(r.calls).length === 0, r.calls.join(','));
  advance(899 * 1000 - (Date.now() - cooldownStart));                      // 14:59
  r = await call({ text: SHORT, mode: 'standard' });
  assert('still cooling at 14:59', groqCalls(r.calls).length === 0, r.calls.join(','));
  advance(2 * 1000);
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Groq tried again after 15 min', r.calls.length === 1 && r.calls[0].startsWith('groq'), r.calls.join(','));

  reset({
    [G1]:       { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_requests_per_model_per_day (GenerateRequestsPerDayPerProjectPerModel)' } } },
    cloudflare: { status: 429, body: { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] } },
    ovhcloud:   { status: 429, body: { error: 'Too Many Requests' } },
  });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Gemini per-day quota → 900s', r.logs.some(l => l.includes(`${G1} daily quota — skipping it for 900s`)));
  assert('Cloudflare daily allocation → 900s', r.logs.some(l => /cloudflare daily quota — skipping it for 900s/.test(l)));
  assert('plain 429 → 60s', r.logs.some(l => /ovhcloud rate-limited — skipping it for 60s/.test(l)));

  // ── 4c. Every entry cooling → try the one whose cooldown ends soonest ──
  console.log('\n── 4c. All cooling → soonest-expiring entry tried ──');
  const FAMILIES = ['groq', 'groq-2', 'groq-3', 'gemini', 'cloudflare', 'ovhcloud', 'llm7', 'nvidia'];
  for (const [label, body] of [['writing', { text: SHORT, mode: 'standard' }], ['chat', { text: SHORT, type: 'code_assistant' }]]) {
    // Everything hits a daily quota (15 min) except llm7, which hits a per-minute limit (60s).
    reset(Object.fromEntries(FAMILIES.map(n => [n, n === 'llm7' ? 'quota' : 'daily'])));
    r = await call(body);
    assert(`${label}: first request cools all ${CHAIN_LEN} entries`, new Set(r.calls).size === CHAIN_LEN, r.calls.join(','));
    behaviour = Object.fromEntries(FAMILIES.map(n => [n, 'ok']));
    r = await call(body);
    assert(`${label}: only llm7 (soonest expiry) tried`, r.calls.join(',') === 'llm7', r.calls.join(','));
    assert(`${label}: request still succeeds`, r.status === 200 && r.payload.success, String(r.status));
    assert(`${label}: fallback logged`, r.logs.some(l => /all providers cooling down — trying llm7/.test(l)));
  }

  // ── 5. Timeouts ──
  console.log('\n── 5. Provider timeouts ──');
  reset({});
  r = await call({ text: SHORT, mode: 'standard' });
  const t = Object.fromEntries(r.rawCalls.map(c => [c.name, c.timeoutMs]));
  for (const slow of ['ovhcloud', 'llm7', 'nvidia']) assert(`${slow} gets ≥20s`, t[slow] >= 20000, String(t[slow]));
  for (const fast of [`groq/${M120}`, `groq-2/${M20}`, `groq-3/${LLAMA}`, G1, GLITE, GEMMA, 'cloudflare'])
    assert(`${fast} gets 10s`, t[fast] > 9000 && t[fast] <= 10000, String(t[fast]));
  assert('no timeout exceeds the 55s request budget', r.rawCalls.every(c => c.timeoutMs <= 55000));

  // ── 6. Tiers: key+model entries are independent ──
  console.log('\n── 6. Tier 2 + per key+model cooldowns ──');
  reset({ ...Object.fromEntries(GROQS.map(k => [`${k}/${M120}`, 'daily'])), gemini: 'fail', cloudflare: 'fail', groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  const firstTier2 = r.calls[r.calls.length - 1];
  assert('Tier 1 exhausted (3×120b → gemini → cloudflare) before any Tier 2 entry',
    JSON.stringify(r.calls.slice(0, 5).map(n => n.endsWith(M120) ? '120b' : n)) === JSON.stringify(['120b', '120b', '120b', G1, 'cloudflare']), r.calls.join(','));
  assert('Tier 2 gpt-oss-20b handles it', firstTier2.endsWith('/' + M20), r.calls.join(','));
  r = await call({ text: SHORT, mode: 'standard' });
  assert('120b entries now cooling, 20b entries still available', groqCalls(r.calls, M120).length === 0 && r.calls[r.calls.length - 1].endsWith('/' + M20), r.calls.join(','));
  // One key's 20b hits a limit — the other keys' 20b and the same key's llama are unaffected.
  reset({ ...Object.fromEntries(GROQS.map(k => [`${k}/${M120}`, 'daily'])), gemini: 'fail', cloudflare: 'fail',
          [`groq/${M20}`]: 'quota', [`groq-2/${M20}`]: 'quota', [`groq-3/${M20}`]: 'quota', groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('all 20b limited → llama-3.3-70b on the next Tier 2 step', r.calls[r.calls.length - 1].endsWith('/' + LLAMA) && groqCalls(r.calls, M20).length === 3, r.calls.join(','));
  // groq/120b rate-limited: over 6 rotating requests it is called once, groq-2/120b and groq-3/120b keep serving.
  reset({ [`groq/${M120}`]: 'quota', groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  const seen6 = [];
  for (let i = 0; i < 6; i++) seen6.push(...(await call({ text: SHORT, mode: 'standard' })).calls);
  assert('groq/120b called once, then skipped (its own cooldown)', seen6.filter(n => n === `groq/${M120}`).length === 1, seen6.join(','));
  assert('groq-2/120b and groq-3/120b unaffected', seen6.includes(`groq-2/${M120}`) && seen6.includes(`groq-3/${M120}`), seen6.join(','));
  assert('groq/20b is NOT used while Tier 1 still has working entries', !seen6.includes(`groq/${M20}`), seen6.join(','));

  // ── 7. reasoning_effort only for gpt-oss ──
  console.log('\n── 7. reasoning_effort ──');
  reset({});
  r = await call({ text: SHORT, mode: 'standard' });
  const bodyOf = (n) => r.rawCalls.find(c => c.name === n).body;
  assert('writing: gpt-oss-120b sends reasoning_effort "low"', GROQS.every(k => bodyOf(`${k}/${M120}`).reasoning_effort === 'low'));
  assert('writing: gpt-oss-20b sends reasoning_effort "low"', GROQS.every(k => bodyOf(`${k}/${M20}`).reasoning_effort === 'low'));
  assert('writing: llama sends no reasoning_effort', GROQS.every(k => !('reasoning_effort' in bodyOf(`${k}/${LLAMA}`))), JSON.stringify(bodyOf(`groq/${LLAMA}`)));
  reset({});
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('chat: Groq calls unchanged (never sent reasoning_effort)', r.rawCalls.filter(c => c.name.startsWith('groq')).every(c => !('reasoning_effort' in c.body)));
  assert('chat: llama entries present', groqCalls(r.calls, LLAMA).length >= 3);

  // ── 8. Gemini key: three models, three quotas ──
  console.log('\n── 8. Gemini key models ──');
  reset({ [G1]: 'daily', [GLITE]: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('gemini current model limited → Flash-Lite (Tier 2) after the Groq Tier 2 entries', r.calls[r.calls.length - 1] === GLITE && groqCalls(r.calls, LLAMA).length === 3, r.calls.join(','));
  reset({ gemini: 'daily', [GEMMA]: 'ok' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('both Flash-Lite models limited → Gemma', r.calls[r.calls.length - 1] === GEMMA && r.logs.some(l => l.includes(`handled by ${GEMMA}`)), r.calls.join(','));
  assert('Gemma URL uses gemma-3-27b-it with the Gemini key', r.rawCalls.some(c => c.name === GEMMA));

  // ── 9. testKeys: per key+model ──
  console.log('\n── 9. testKeys per key+model ──');
  // Three rotating requests: one of them starts on groq-2, so groq-2/120b hits its daily limit.
  reset({ [`groq-2/${M120}`]: 'daily', groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok', gemini: 'ok' });
  for (let i = 0; i < 3; i++) await call({ text: SHORT, mode: 'standard' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const res9 = r.payload.results;
  const rows = [M120, M20, LLAMA].flatMap(m => GROQS.map(k => `${k}/${m}`)).concat([G1, GLITE, GEMMA]);
  assert('one row per key+model (9 Groq + 3 Gemini-key)', rows.every(n => res9[n]), Object.keys(res9).join(', '));
  assert('working rows report ✅ and their model', res9[`groq-3/${LLAMA}`].status === '✅ working' && res9[`groq-3/${LLAMA}`].model === LLAMA);
  assert('daily-limited row reports ⏳ daily limit', res9[`groq-2/${M120}`].status === '⏳ daily limit', JSON.stringify(res9[`groq-2/${M120}`]));
  assert('active cooldown shown on that key+model', res9[`groq-2/${M120}`].cooldownSecondsLeft > 0, JSON.stringify(res9[`groq-2/${M120}`]));
  assert('other keys\' 120b unaffected', !res9[`groq/${M120}`].cooldownSecondsLeft && res9[`groq/${M120}`].status === '✅ working');
  for (const d of ['openrouter', 'mistral', 'mistral-2', 'sambanova', 'deepseek', 'scaleway', 'huggingface', 'chutes']) {
    assert(`${d} reported disabled`, res9[d] && /disabled/.test(res9[d].status), JSON.stringify(res9[d]));
  }
  assert('testKeys made no disabled-provider calls', !r.calls.some(n => DISABLED_HOST_NAMES.includes(n)), r.calls.join(','));

  // ── 10. KEYS FOUND startup log: booleans only, no key material ──
  console.log('\n── 10. KEYS FOUND log ──');
  r = await call({ text: SHORT, mode: 'standard' });
  const kf = r.rawLogs.find(a => a[0] === 'KEYS FOUND:');
  assert('KEYS FOUND logged', !!kf);
  const vals = kf ? Object.values(kf[1]) : [];
  assert('every value is true/false', vals.length > 0 && vals.every(v => typeof v === 'boolean'), JSON.stringify(kf && kf[1]));
  const allLogText = r.logs.join('\n');
  // Test keys start with their provider's name (e.g. "openrouter-…"), which legitimately appears as a
  // field name — so check for the old "<8-char prefix>..." format and for any full key.
  const secrets = Object.entries(KEYS).filter(([k]) => k !== 'ADMIN_PASSWORD').map(([, v]) => v);
  assert('no "<prefix>..." key fragments in the logs', secrets.every(v => !allLogText.includes(v.slice(0, 8) + '...')));
  assert('no full key anywhere in the logs', secrets.every(v => !allLogText.includes(v)));
  assert('groq/groq2/groq3/gemini/cloudflare/nvidia reported present', kf && ['groq', 'groq2', 'groq3', 'gemini', 'cloudflare', 'nvidia'].every(k => kf[1][k] === true));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { loud(); console.error(e); process.exit(1); });
