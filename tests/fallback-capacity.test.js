'use strict';
// Overnight capacity fixes (Nov 11): the fallback tier absorbs overflow (NVIDIA Nemotron reasoning off + headroom,
// OVHcloud 10 s, Cerebras as Tier 2 unless its key is the leaked one), reasoning_effort=low on every gpt-oss call,
// and a request that finds no capacity anywhere fails fast with error "capacity".
// ALL providers are mocked via global.fetch; any URL not mocked throws, so nothing leaves this process.
// Run: node tests/fallback-capacity.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

const fs = require('fs'), path = require('path');
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|^PF_MAX|^PROMPT_DIET|MODEL_BLOCKLIST|_PREFS$|^ADMIN_PASSWORD$|^FALLBACK_ORDER$/.test(k)) delete process.env[k];
Object.assign(process.env, { PF_HEALTH_FAILS: '100000', ADMIN_PASSWORD: 'test-admin-pw', GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-1-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx',
  NVIDIA_KEY: 'nvapi-test-xxxxxxxxxxxx', CEREBRAS_KEY: 'csk-test-key-xxxxxxxxxxxx' });

const { fakeAnswer, contentOf } = require('./_fake-answer');

// ── fetch mock: behaviour[name | family | '*'](content, body) → { text?, finish?, status?, body?, usage? } ──
let behaviour = {}, calls = [];
const respond = (status, json) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
function nameOf(url, body, opts) {
  if (url.startsWith('https://api.groq.com/')) return (String(opts.headers.Authorization).includes('key-2') ? 'groq-2/' : 'groq/') + body.model;
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'gemini/' + url.match(/\/models\/([^:]+):/)[1];
  if (url.includes('/ai/run/')) return 'cloudflare';
  if (url.startsWith('https://integrate.api.nvidia.com/')) return 'nvidia/' + body.model;
  if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) return 'ovhcloud';
  if (url.startsWith('https://api.llm7.io/')) return 'llm7';
  if (url.startsWith('https://api.cerebras.ai/')) return 'cerebras';
  return null;
}
global.fetch = async (url, opts = {}) => {
  if (opts.method === 'GET' && /\/models(\?|\/search|$)/.test(url)) return respond(503, { error: 'lists unavailable in this test' });
  let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
  const name = nameOf(url, body, opts);
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  const content = contentOf(body);
  calls.push({ name, body });
  await new Promise((r) => setTimeout(r, 2));
  const fam = name.split('/')[0];
  const fn = behaviour[name] || behaviour[fam] || behaviour[fam.replace(/-\d+$/, '')] || behaviour['*'];
  const r = fn ? fn(content, body) : { status: 500 };
  if (r.status && r.status !== 200) return respond(r.status, r.body || { error: 'mock failure' });
  if (fam.startsWith('gemini')) return respond(200, { candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: r.finish || 'STOP' }], usageMetadata: { totalTokenCount: 900 } });
  if (fam === 'cloudflare') return respond(200, { success: true, result: { response: r.text, usage: { completion_tokens: r.finish === 'length' ? body.max_tokens : 10, total_tokens: 800 } } });
  return respond(200, { choices: [{ message: { content: r.text === undefined ? null : r.text }, finish_reason: r.finish || 'stop' }], usage: { total_tokens: r.tokens || 1000 } });
};
const realLog = console.log, realWarn = console.warn, realErr = console.error;
let logs = [];
const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };

let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
let ip = 0;
async function call(body, { keepCooldowns = false } = {}) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.12.0.' + (++ip) }, body };
  let status = 0, payload = null; const lines = [];
  const res = { statusCode: 0, setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; }, write(s) { lines.push(s); } };
  calls = []; logs = [];
  if (!keepCooldowns) handler._writingCooldowns.clear();
  quiet(); try { await handler(req, res); } finally { loud(); }
  return { status: status || res.statusCode, payload, calls: calls.slice(), logs: logs.slice(), lines };
}
const good = (c) => ({ text: fakeAnswer(c) });
const Q429 = () => ({ status: 429, body: { error: { message: 'Rate limit reached for tokens per day (TPD)' } } });
const para = (i) => `Paragraph ${i} explains how students plan their weekly revision, test themselves with flashcards, take short breaks between sessions and review their mistakes before the final exam begins next month.`;
const blk = (i, n) => Array.from({ length: n }, (_, j) => para(i * 100 + j)).join(' ');
const ONE = blk(1, 10);                                                         // one ~320-word chunk
const FOUR = [blk(1, 12), blk(2, 12), blk(3, 12), blk(4, 12)].join('\n\n');    // four chunks
const NV_U = 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', NV_L = 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b';

(async () => {
  console.log('\n── 1. NVIDIA Nemotron: reasoning off, room for the answer ──');
  behaviour = { groq: Q429, gemini: Q429, cerebras: Q429, '*': good };
  let r = await call({ text: ONE, mode: 'standard' });
  let nv = r.calls.find((c) => c.name === NV_U);
  assert('the request reaches NVIDIA once Groq / Gemini / Cerebras are out of quota, and NVIDIA answers', r.status === 200 && r.payload.success && nv && r.calls[r.calls.length - 1].name === NV_U, r.calls.map((c) => c.name).join(','));
  assert('Nemotron is asked with thinking off (chat_template_kwargs.enable_thinking = false)', nv && nv.body.chat_template_kwargs && nv.body.chat_template_kwargs.enable_thinking === false, JSON.stringify(nv && nv.body.chat_template_kwargs));
  const groqCap = r.calls.find((c) => c.name.startsWith('groq')).body.max_tokens;
  assert(`Nemotron gets the chunk cap + 1,024 tokens of headroom (${groqCap} → ${nv && nv.body.max_tokens})`, nv && nv.body.max_tokens === groqCap + 1024, String(nv && nv.body.max_tokens));

  behaviour = { groq: Q429, gemini: Q429, cerebras: Q429, [NV_U]: () => ({ text: undefined, finish: 'length' }), '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  assert('a null answer with finish_reason=length still moves on to the next model (no copy, no hang)', r.status === 200 && r.calls.map((c) => c.name).join(',').includes(NV_U + ',' + NV_L) && r.calls[r.calls.length - 1].name === NV_L, r.calls.map((c) => c.name).join(','));

  behaviour = { groq: Q429, gemini: Q429, cerebras: Q429,
    [NV_L]: (c, b) => (b.chat_template_kwargs ? { status: 400, body: { error: { message: 'Unsupported parameter: chat_template_kwargs' } } } : good(c)),
    [NV_U]: () => ({ status: 503 }), '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  const nvl = r.calls.filter((c) => c.name === NV_L);
  assert('a model that rejects the field (400) is retried at once without it and answers', r.status === 200 && nvl.length === 2 && !nvl[1].body.chat_template_kwargs && r.calls[r.calls.length - 1].name === NV_L, r.calls.map((c) => c.name).join(','));
  r = await call({ text: ONE, mode: 'standard' });
  assert('… and is remembered: the next request sends it without the field straight away', r.calls.filter((c) => c.name === NV_L).length === 1 && !r.calls.find((c) => c.name === NV_L).body.chat_template_kwargs, r.calls.map((c) => c.name).join(','));

  console.log('\n── 2. Cerebras: Tier 2, gpt-oss with reasoning_effort=low, never with the leaked key ──');
  behaviour = { groq: Q429, gemini: Q429, '*': good };   // (Gemini Flash-Lite is Tier 1 — out of quota too)
  r = await call({ text: ONE, mode: 'standard' });
  let names = r.calls.map((c) => c.name);
  const cb = r.calls.find((c) => c.name === 'cerebras');
  assert('with Groq and Gemini Flash-Lite out of quota, Cerebras answers (before Gemini Flash, Gemma, NVIDIA, OVH, Cloudflare)', r.status === 200 && names[names.length - 1] === 'cerebras' && names.filter((n) => n.startsWith('gemini')).every((n) => /flash-lite/.test(n)) && !names.some((n) => /^(nvidia|ovhcloud|llm7|cloudflare)/.test(n)), names.join(','));
  assert('Cerebras comes after all the Groq slots', names.indexOf('cerebras') > Math.max(...names.map((n, i) => (n.startsWith('groq') ? i : -1))), names.join(','));
  assert('Cerebras is called with gpt-oss-120b and reasoning_effort "low"', cb && cb.body.model === 'gpt-oss-120b' && cb.body.reasoning_effort === 'low', JSON.stringify(cb && { model: cb.body.model, re: cb.body.reasoning_effort }));
  behaviour = { groq: Q429, gemini: Q429, '*': (c) => ({ status: 500 }) };
  r = await call({ text: ONE, mode: 'standard' });
  const oss = r.calls.filter((c) => /gpt-oss/.test(c.body.model || ''));
  assert(`reasoning_effort=low on EVERY gpt-oss call of the writing path (${oss.length} calls: Groq ×keys ×2 models + Cerebras)`, oss.length >= 5 && oss.every((c) => c.body.reasoning_effort === 'low'), oss.map((c) => c.name + ':' + c.body.reasoning_effort).join(','));

  behaviour = { groq: Q429, gemini: Q429, cerebras: () => ({ status: 402, body: { error: { message: 'Payment required — add a card' } } }), '*': good };
  r = await call({ text: ONE, mode: 'standard' }, { keepCooldowns: true });
  assert('Cerebras refusing the key (401/402/403) → the next provider answers', r.status === 200 && r.calls.some((c) => c.name === 'cerebras') && r.calls[r.calls.length - 1].name !== 'cerebras');
  const refusedLog = r.logs.some((l) => /cerebras refused the key — skipping it for 21600s/.test(l));
  r = await call({ text: ONE, mode: 'standard' }, { keepCooldowns: true });
  assert('… and Cerebras sits out 6 h on this instance (not called again)', refusedLog && !r.calls.some((c) => c.name === 'cerebras'), r.calls.map((c) => c.name).join(','));
  handler._writingCooldowns.clear();

  handler._leakedKeyFps.add(handler._keyFingerprint(process.env.CEREBRAS_KEY));
  behaviour = { groq: Q429, '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  assert('a CEREBRAS_KEY with a leaked fingerprint is never used by the chain', r.status === 200 && !r.calls.some((c) => c.name === 'cerebras'), r.calls.map((c) => c.name).join(','));
  r = await call({ type: 'testKeys', adminPassword: 'test-admin-pw' });
  assert('testKeys flags it: keyLeaked=true, inWritingChain=false', r.payload.results.cerebras && r.payload.results.cerebras.keyLeaked === true && r.payload.results.cerebras.inWritingChain === false, JSON.stringify(r.payload.results.cerebras));
  handler._leakedKeyFps.delete(handler._keyFingerprint(process.env.CEREBRAS_KEY));
  assert('the real leaked key is kept only as an 8-character sha256 fingerprint', [...handler._leakedKeyFps].every((f) => /^[0-9a-f]{8}$/.test(f)) && !/csk-[A-Za-z0-9]{20,}/.test(fs.readFileSync(path.join(__dirname, '..', 'api', 'process.js'), 'utf8')));

  console.log('\n── 3. No capacity anywhere → fail fast, clear message, error "capacity" ──');
  behaviour = { '*': Q429 };
  const t0 = Date.now();
  r = await call({ text: FOUR, mode: 'standard' });
  const ms = Date.now() - t0;
  const firstChunkCalls = r.calls.length;
  assert('every provider out of quota → 503 with error "capacity"', r.status === 503 && r.payload.error === 'capacity', JSON.stringify(r.payload));
  assert('… and the message "ParaFree is very busy right now — please try again in a few minutes."', r.payload.message === 'ParaFree is very busy right now — please try again in a few minutes.', r.payload.message);
  assert('one full pass only: the later chunks are not tried after the first exhausted every provider', r.logs.some((l) => /found no capacity anywhere — not trying the 3 later chunk/.test(l)) && new Set(r.calls.map((c) => c.name)).size === firstChunkCalls, r.calls.length + ' calls');
  assert(`fails in seconds, not 105 s (${ms} ms)`, ms < 10000, String(ms));

  behaviour = { '*': Q429 };
  r = await call({ text: FOUR, mode: 'standard', stream: true });
  const done = r.lines.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'done');
  assert('streaming: the "done" line carries error "capacity" and the same message', done && done.success === false && done.error === 'capacity' && /very busy right now/.test(done.message), JSON.stringify(done));

  let n = 0;
  behaviour = { '*': (c) => (n++ < 1 ? good(c) : Q429()) };
  r = await call({ text: FOUR, mode: 'standard' });
  assert('capacity runs out after chunk 1: chunk 1 is kept, chunks 2–4 come back as failedParts at once (no second pass)', r.status === 200 && r.payload.success && r.payload.failedParts && r.payload.failedParts.length === 3 && r.logs.some((l) => /not trying the 2 later chunk/.test(l)), JSON.stringify(r.payload && r.payload.failedParts && r.payload.failedParts.length));

  behaviour = { '*': () => ({ text: 'Cut', finish: 'length' }) };
  r = await call({ text: ONE, mode: 'standard' });
  assert('a failure that is NOT capacity (every answer cut off) stays "high_demand" — bugs are counted apart', r.status === 503 && r.payload.error === 'high_demand', JSON.stringify(r.payload));

  console.log('\n── 4. OVHcloud 10 s, token counter, page + GA ──');
  behaviour = { groq: Q429, gemini: Q429, cerebras: Q429, nvidia: () => ({ status: 503 }), ovhcloud: good, '*': () => ({ status: 503 }) };
  r = await call({ text: blk(1, 16), mode: 'standard' });   // a ~510-word chunk: chunk scaling would give 7.7 s+, the cap holds 10 s
  assert('OVHcloud answers when it can (kept in the chain)', r.status === 200 && r.calls[r.calls.length - 1].name === 'ovhcloud', r.calls.map((c) => c.name).join(','));
  const usage = require('../api/_usage.js');
  const got = [];
  usage.record({ hincrby: async (k, f, v) => got.push([f, v]), expire: async () => {} }, 'tok', 'groq/openai/gpt-oss-120b', 1234.4);
  usage.record({ hincrby: async (k, f, v) => got.push([f, v]) }, 'chunk', 'groq/openai/gpt-oss-120b');
  assert('usage.record counts tokens per entry ("tok|<entry>" += n) and chunks by 1', JSON.stringify(got) === JSON.stringify([['tok|groq/openai/gpt-oss-120b', 1234], ['chunk|groq/openai/gpt-oss-120b', 1]]), JSON.stringify(got));
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'process.js'), 'utf8');
  assert('a served chunk records its tokens for the admin dashboard', /if \(info\.tokens\) usage\.record\(redis, 'tok', c\.name, info\.tokens\)/.test(src));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ev = require('../lib/tool-events.js');
  assert('the page shows the "very busy" message for error "capacity"', /data\.error === 'capacity'\) \{\s*showStatus\("⏳ ParaFree is very busy right now — please try again in a few minutes\."/.test(html));
  assert('GA: error_type=capacity is an allowed value and the page sends it', ev.VALUES.error_type.includes('capacity') && /_pfLastApiError = data\.error === 'capacity' \? 'capacity'/.test(html));

  console.log('\n── 5. testKeys fallback probe: one real-sized call per fallback provider ──');
  behaviour = { [NV_U]: (c) => ({ text: fakeAnswer(c), tokens: 1400 }), [NV_L]: () => ({ text: undefined, finish: 'length' }), ovhcloud: () => ({ status: 504 }), '*': good };
  r = await call({ type: 'testKeys', adminPassword: 'test-admin-pw', probe: 'fallback' });
  const pr = r.payload.probe;
  const probeCalls = r.calls.filter((c) => /Paragraph 1 explains/.test(contentOf(c.body)));
  assert('the probe sends one ~350-word chunk to each NVIDIA slot, ovhcloud, llm7, cerebras and cloudflare',
    pr && [NV_U, NV_L, 'ovhcloud', 'llm7', 'cerebras', 'cloudflare'].every((k) => pr.results[k]) && probeCalls.length === 6 + 0 && pr.words > 300, JSON.stringify(pr && Object.keys(pr.results)) + ' ' + probeCalls.map((c) => c.name).join(','));
  assert('it reports answered / ms / finish / tokens per provider', pr.results[NV_U].answered === true && pr.results[NV_U].tokens === 1400 && pr.results[NV_L].answered === false && /null content/.test(pr.results[NV_L].error) && pr.results.ovhcloud.answered === false && pr.results.ovhcloud.timeoutMs === 10000, JSON.stringify(pr.results));
  assert('the probe never returns any text', !JSON.stringify(pr).includes('Paragraph') && !JSON.stringify(pr).includes('explain'));
  r = await call({ type: 'testKeys', adminPassword: 'wrong', probe: 'fallback' });
  assert('the probe needs the admin password', r.status === 401 && !r.calls.length);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
