'use strict';
// Provider-chain tests for api/process.js — order, Groq rotation, disabled providers,
// rate-limit cooldown (60s per-minute / 2 min daily, soonest-expiry fallback when all
// are cooling), slow-provider timeouts, per-chunk logging, testKeys.
// ALL providers are mocked via global.fetch. No live API calls: any URL not in the
// mock map throws, so a real request can never leave this process.
// Run: node tests/provider-chain.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
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
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_/.test(k)) delete process.env[k];
Object.assign(process.env, KEYS);

// ── Fetch mock ──
// Maps a request to a provider name; `behaviour[name]` decides the response.
function providerOf(url, opts) {
  const auth = (opts && opts.headers && opts.headers.Authorization) || '';
  if (url.startsWith('https://api.groq.com/')) {
    if (auth.includes(KEYS.GROQ_KEY_3)) return 'groq-3';
    if (auth.includes(KEYS.GROQ_KEY_2)) return 'groq-2';
    return 'groq';
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'gemini';
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

function okBody(name, body) {
  const text = `[${name}] ${'paraphrased output text '.repeat(3)}`;
  if (name === 'gemini') return { candidates: [{ content: { parts: [{ text }] } }] };
  if (name === 'cloudflare') return { success: true, result: { response: text } };
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
}
function respond(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

let calls = [];          // [{ name, timeoutMs }]
let behaviour = {};      // name → 'ok' | 'fail' | 'quota' (per-minute) | 'daily' | { status, body }
let lastTimeoutMs = null;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...rest) { lastTimeoutMs = ms; return realSetTimeout(fn, ms, ...rest); };

global.fetch = async (url, opts) => {
  const name = providerOf(url, opts);
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls.push({ name, timeoutMs: lastTimeoutMs });
  const b = behaviour[name] || 'fail';
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

// Capture logs
let logs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;
function quiet() {
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
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
  calls = []; logs = [];
  quiet();
  try { await handler(req, res); } finally { loud(); }
  return { status, payload, calls: calls.map(c => c.name), rawCalls: calls.slice(), logs: logs.slice() };
}
function reset(b = {}) { behaviour = b; advance(3 * 60 * 1000); } // also expires any cooldowns

const ACTIVE = ['groq', 'groq-2', 'groq-3', 'gemini', 'cloudflare', 'ovhcloud', 'llm7', 'nvidia'];
const TAIL = ['gemini', 'cloudflare', 'ovhcloud', 'llm7', 'nvidia'];
const GROQS = ['groq', 'groq-2', 'groq-3'];
function isGroqRotation(seq) {
  const i = GROQS.indexOf(seq[0]);
  return i !== -1 && JSON.stringify(seq) === JSON.stringify([...GROQS.slice(i), ...GROQS.slice(0, i)]);
}
// NVIDIA advances through its model list only on 404/410; a 500 throws once → one call.
function chainOf(names) { return names.filter((n, i) => n !== 'nvidia' || names.indexOf('nvidia') === i); }

const SHORT = 'This is a short paragraph that needs paraphrasing for the test suite here.';
const LONG = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(100)).join('\n\n');

(async () => {
  // ── 1. Every tool uses the same order; disabled providers never called ──
  console.log('\n── 1. Same chain for every tool, all providers failing ──');
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
  for (const [tool, body] of tools) {
    reset({});
    const r = await call(body);
    // Chat/CV paths retry once — check the first pass only.
    const firstPass = chainOf(r.calls).slice(0, ACTIVE.length);
    assert(`${tool}: groq keys lead in rotation order`, isGroqRotation(firstPass.slice(0, 3)), firstPass.join(','));
    assert(`${tool}: then gemini → cloudflare → ovhcloud → llm7 → nvidia`,
      JSON.stringify(firstPass.slice(3)) === JSON.stringify(TAIL), firstPass.join(','));
    const bad = r.calls.filter(n => DISABLED_HOST_NAMES.includes(n));
    assert(`${tool}: no disabled provider called`, bad.length === 0, bad.join(','));
  }

  // ── 2. Per-chunk Groq rotation spreads load over 3 keys ──
  console.log('\n── 2. Groq rotation across chunks ──');
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  let r = await call({ text: LONG, mode: 'standard' });
  assert('multi-chunk request succeeded', r.status === 200 && r.payload.success, String(r.status));
  assert('4 chunks → 4 calls', r.calls.length === 4, r.calls.join(','));
  const used = new Set(r.calls);
  assert('all three Groq keys used', used.size === 3 && GROQS.every(g => used.has(g)), r.calls.join(','));
  assert('consecutive chunks use different keys', r.calls.every((n, i) => i === 0 || n !== r.calls[i - 1]), r.calls.join(','));

  // ── 3. Per-chunk logging ──
  console.log('\n── 3. Logs which provider handled each chunk ──');
  for (let s = 0; s < 4; s++) {
    assert(`log for chunk seq=${s}`, r.logs.some(l => new RegExp(`chunk seq=${s} handled by groq`).test(l)));
  }
  reset({ 'groq-2': 'ok' });
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('chat path logs handler', r.logs.some(l => /AI request handled by groq-2/.test(l)));

  // ── 4a. Per-minute rate limit → 60 s cooldown ──
  console.log('\n── 4a. Per-minute 429 → 60s cooldown ──');
  reset({ groq: 'quota', 'groq-2': 'quota', 'groq-3': 'quota', gemini: 'ok' });
  let cooldownStart = Date.now(); // cooldowns are set during chunk 0, just after this
  r = await call({ text: LONG, mode: 'standard' });
  const groqCalls = r.calls.filter(n => n.startsWith('groq'));
  assert('each 429 Groq key called once across 4 chunks', groqCalls.length === 3, r.calls.join(','));
  assert('remaining chunks go straight to gemini', r.calls.filter(n => n === 'gemini').length === 4, r.calls.join(','));
  assert('60s cooldown logged', r.logs.some(l => /groq.* rate-limited — skipping it for 60s/.test(l)));

  r = await call({ text: SHORT, mode: 'standard' });
  assert('next request skips cooled keys', r.calls.join(',') === 'gemini', r.calls.join(','));
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('cooldown applies to chat path too', r.calls.join(',') === 'gemini', r.calls.join(','));

  advance(59 * 1000 - (Date.now() - cooldownStart)); // 0:59 after the cooldown began
  r = await call({ text: SHORT, mode: 'standard' });
  assert('still cooling at 0:59', !r.calls.some(n => n.startsWith('groq')), r.calls.join(','));
  advance(2 * 1000);
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Groq tried again after 60s', r.calls.length === 1 && r.calls[0].startsWith('groq'), r.calls.join(','));

  // ── 4b. Daily quota → 2 min cooldown ──
  console.log('\n── 4b. Daily quota → 2 min cooldown ──');
  reset({ groq: 'daily', 'groq-2': 'daily', 'groq-3': 'daily', gemini: 'ok' });
  cooldownStart = Date.now();
  r = await call({ text: SHORT, mode: 'standard' });
  assert('120s cooldown logged', r.logs.some(l => /groq.* daily quota — skipping it for 120s/.test(l)));
  advance(119 * 1000 - (Date.now() - cooldownStart)); // 1:59
  r = await call({ text: SHORT, mode: 'standard' });
  assert('still cooling at 1:59', !r.calls.some(n => n.startsWith('groq')), r.calls.join(','));
  advance(2 * 1000);
  behaviour = { groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' };
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Groq tried again after 2 min', r.calls.length === 1 && r.calls[0].startsWith('groq'), r.calls.join(','));

  // Daily message shapes from other providers
  reset({
    gemini:     { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_requests_per_model_per_day (GenerateRequestsPerDayPerProjectPerModel)' } } },
    cloudflare: { status: 429, body: { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] } },
    ovhcloud:   { status: 429, body: { error: 'Too Many Requests' } },
  });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Gemini per-day quota → 120s', r.logs.some(l => /gemini daily quota — skipping it for 120s/.test(l)));
  assert('Cloudflare daily allocation → 120s', r.logs.some(l => /cloudflare daily quota — skipping it for 120s/.test(l)));
  assert('plain 429 → 60s', r.logs.some(l => /ovhcloud rate-limited — skipping it for 60s/.test(l)));

  // ── 4c. Every provider cooling → try the one whose cooldown ends soonest ──
  console.log('\n── 4c. All cooling → soonest-expiring provider tried ──');
  for (const [label, body] of [['writing', { text: SHORT, mode: 'standard' }], ['chat', { text: SHORT, type: 'code_assistant' }]]) {
    // Everyone hits a daily quota (120s) except llm7, which hits a per-minute limit (60s).
    reset(Object.fromEntries(ACTIVE.map(n => [n, n === 'llm7' ? 'quota' : 'daily'])));
    r = await call(body);
    assert(`${label}: first request cools every provider`, ACTIVE.every(n => r.calls.includes(n)), r.calls.join(','));
    behaviour = Object.fromEntries(ACTIVE.map(n => [n, 'ok']));
    r = await call(body);
    assert(`${label}: only llm7 (soonest expiry) tried`, r.calls.join(',') === 'llm7', r.calls.join(','));
    assert(`${label}: request still succeeds`, r.status === 200 && r.payload.success, String(r.status));
    assert(`${label}: fallback logged`, r.logs.some(l => /all providers cooling down — trying llm7/.test(l)));
  }

  reset({ groq: 'fail', 'groq-2': 'fail', 'groq-3': 'fail', gemini: 'ok' });
  await call({ text: SHORT, mode: 'standard' });
  r = await call({ text: SHORT, mode: 'standard' });
  assert('non-quota errors (500) do NOT trigger cooldown', r.calls.filter(n => n.startsWith('groq')).length === 3, r.calls.join(','));

  // ── 5. Timeouts ──
  console.log('\n── 5. Provider timeouts ──');
  reset({});
  r = await call({ text: SHORT, mode: 'standard' });
  const t = Object.fromEntries(r.rawCalls.map(c => [c.name, c.timeoutMs]));
  for (const slow of ['ovhcloud', 'llm7', 'nvidia']) {
    assert(`${slow} gets ≥20s`, t[slow] >= 20000, String(t[slow]));
  }
  for (const fast of ['groq', 'gemini', 'cloudflare']) {
    assert(`${fast} gets 10s`, t[fast] > 9000 && t[fast] <= 10000, String(t[fast]));
  }
  assert('no timeout exceeds the 55s request budget', r.rawCalls.every(c => c.timeoutMs <= 55000));

  // ── 6. testKeys health check ──
  console.log('\n── 6. testKeys ──');
  reset({ groq: 'ok', 'groq-2': 'ok', 'groq-3': 'ok' });
  r = await call({ type: 'testKeys', adminPassword: 'test-admin' });
  const res6 = r.payload.results;
  assert('groq-3 reported', res6['groq-3'] && res6['groq-3'].status === '✅ working', JSON.stringify(res6['groq-3']));
  for (const d of ['openrouter', 'mistral', 'mistral-2', 'sambanova', 'deepseek', 'scaleway', 'huggingface', 'chutes']) {
    assert(`${d} reported disabled`, res6[d] && /disabled/.test(res6[d].status), JSON.stringify(res6[d]));
  }
  assert('testKeys made no disabled-provider calls', !r.calls.some(n => DISABLED_HOST_NAMES.includes(n)), r.calls.join(','));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { loud(); console.error(e); process.exit(1); });
