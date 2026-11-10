'use strict';
// Phase 4 — token diet + no hidden reasoning. Request-body snapshots (reasoning / thinking fields), the fallback
// when a model rejects the field, the shortened prompts (lib/prompts-v2.js: rules kept, sizes, OFF by default).
// Providers MOCKED via global.fetch (unknown URLs throw). Run: node tests/token-diet.test.js
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
const fs = require('fs'), path = require('path');
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|^PF_MAX|^PROMPT_DIET/.test(k)) delete process.env[k];
Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GEMINI_KEY: 'gemini-key-xxxxxxxx', GEMINI_LITE_MODEL: 'gemini-3.8-flash', MODEL_BLOCKLIST: 'none', PF_MAX_PROVIDERS: '99' });   // blocklist off: 3.8 Flash is on the built-in known-bad list
const { fakeAnswer, contentOf } = require('./_fake-answer');
const V2 = require('../lib/prompts-v2.js');

let behaviour = () => 'ok', calls = [];
const respond = (status, json) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
global.fetch = async (url, opts) => {
  if (opts && opts.method === 'GET') return respond(503, { error: 'lists unavailable in this test' });
  const body = JSON.parse(opts.body || '{}');
  let name;
  if (url.startsWith('https://api.groq.com/')) name = 'groq/' + body.model;
  else if (url.startsWith('https://generativelanguage.googleapis.com/')) name = 'gemini/' + url.match(/\/models\/([^:]+):/)[1];
  else if (/cloudflare|nvidia|ovh|llm7/.test(url)) name = url.split('/')[2];
  else throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls.push({ name, body });
  const b = behaviour(name, body);
  if (b === 'fail') return respond(500, { error: 'mock failure' });
  if (b && b.status) return respond(b.status, b.body || {});
  const text = fakeAnswer(contentOf(body));
  if (name.startsWith('gemini')) return respond(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
  return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
};
const realLog = console.log, realWarn = console.warn, realErr = console.error;
let logs = [];
const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
let ip = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.4.0.' + (++ip) }, body };
  let status = 0, payload = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; } };
  calls = []; logs = []; handler._pacer._reset();
  quiet(); try { await handler(req, res); } finally { loud(); }
  return { status, payload, calls: calls.slice(), logs: logs.slice() };
}
const SHORT = 'Students who plan their revision week by week remember much more of what they read before the exam.';
const by = (r, re) => r.calls.find((c) => re.test(c.name));
const tc = (c) => c && c.body.generationConfig && c.body.generationConfig.thinkingConfig;

(async () => {
  console.log('\n── 1. Groq gpt-oss: reasoning_effort "low" on every path ──');
  behaviour = (n) => (n === 'groq/openai/gpt-oss-120b' ? 'fail' : n.startsWith('groq/') ? 'ok' : 'fail');
  let r = await call({ text: SHORT, mode: 'standard' });
  assert('writing: gpt-oss-120b body has reasoning_effort "low"', by(r, /gpt-oss-120b/).body.reasoning_effort === 'low');
  assert('writing: gpt-oss-20b body has reasoning_effort "low"', by(r, /gpt-oss-20b/).body.reasoning_effort === 'low');
  behaviour = (n) => (n.startsWith('groq/openai/gpt-oss') ? 'fail' : 'fail');
  r = await call({ text: SHORT, type: 'code_assistant' });
  const chatOss = r.calls.filter((c) => /gpt-oss/.test(c.name)), chatOther = r.calls.filter((c) => c.name.startsWith('groq/') && !/gpt-oss/.test(c.name));
  assert('chat (callGroqModel): gpt-oss bodies have reasoning_effort "low"', chatOss.length && chatOss.every((c) => c.body.reasoning_effort === 'low'));
  assert('chat: llama/qwen bodies never get the field (they reject it)', chatOther.length && chatOther.every((c) => !('reasoning_effort' in c.body)));

  console.log('\n── 2. Gemini: lowest thinking setting per model (writing + flashcards) ──');
  behaviour = (n) => (n.startsWith('gemini') ? 'fail' : 'fail');
  r = await call({ text: SHORT, mode: 'standard' });
  assert('Flash-Lite → thinkingLevel "minimal"', JSON.stringify(tc(by(r, /gemini-3\.5-flash-lite/))) === '{"thinkingLevel":"minimal"}', JSON.stringify(tc(by(r, /gemini-3\.5-flash-lite/))));
  assert('3.8 Flash → thinkingLevel "low" (it has no "minimal")', JSON.stringify(tc(by(r, /gemini-3\.8-flash$/))) === '{"thinkingLevel":"low"}', JSON.stringify(tc(by(r, /gemini-3\.8-flash$/))));
  // only GEMINI_KEY here, and key-1 Gemma is skipped since Nov 10 (HTTP 500) — gemini-2 Gemma keeps no thinkingConfig
  assert('key-1 Gemma is not called; no Gemma call ever carries a thinkingConfig', r.calls.filter((c) => /gemma/.test(c.name)).every((c) => !tc(c)) && !by(r, /gemma/));
  r = await call({ text: SHORT, type: 'code_assistant' });
  assert('ParaFree AI chat keeps the model\'s default thinking (not a writing/flashcards path)', r.calls.filter((c) => c.name.startsWith('gemini')).every((c) => !tc(c)));

  console.log('\n── 3. A model that rejects the field: retried at once without it, then remembered ──');
  behaviour = (n, body) => (n === 'gemini/gemini-3.5-flash-lite' && tc({ body }) && tc({ body }).thinkingLevel === 'minimal'
    ? { status: 400, body: { error: { code: 400, message: 'Thinking level "minimal" is not supported for this model.', status: 'INVALID_ARGUMENT' } } }
    : n === 'gemini/gemini-3.5-flash-lite' ? 'ok' : 'fail');
  r = await call({ text: SHORT, mode: 'standard' });
  const lite = r.calls.filter((c) => c.name === 'gemini/gemini-3.5-flash-lite');
  assert('400 on "minimal" → the same call retried with "low" → success', r.status === 200 && lite.length === 2 && tc(lite[1]).thinkingLevel === 'low', JSON.stringify(lite.map(tc)));
  r = await call({ text: SHORT, mode: 'standard' });
  const lite2 = r.calls.filter((c) => c.name === 'gemini/gemini-3.5-flash-lite');
  assert('next request goes straight to "low" (remembered, no wasted call)', lite2.length === 1 && tc(lite2[0]).thinkingLevel === 'low', JSON.stringify(lite2.map(tc)));
  behaviour = (n, body) => (n === 'gemini/gemini-3.8-flash' && tc({ body }) ? { status: 400, body: { error: { message: 'thinking is not supported' } } } : n === 'gemini/gemini-3.8-flash' ? 'ok' : 'fail');
  r = await call({ text: SHORT, mode: 'standard' });
  const fl = r.calls.filter((c) => c.name === 'gemini/gemini-3.8-flash');
  assert('400 on "low" → retried without thinkingConfig → success', r.status === 200 && fl.length === 2 && !tc(fl[1]));
  behaviour = (n) => (n === 'gemini/gemini-3.5-flash-lite' ? { status: 400, body: { error: { message: 'Invalid JSON payload' } } } : 'fail');
  r = await call({ text: SHORT, mode: 'standard' });
  assert('another 400 is NOT retried (only thinking-field rejections are)', r.calls.filter((c) => c.name === 'gemini/gemini-3.5-flash-lite').length === 1);

  console.log('\n── 4. Shortened prompts: rules kept, smaller, OFF by default ──');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const tok = (s) => Math.ceil(String(s).length / 4);                 // chars ÷ 4 (o200k counts are in the efficiency audit)
  const oldPara = (html.match(/const _PARA_RULES = `([\s\S]*?)`;/) || [])[1] || '';
  for (const [m, p] of Object.entries(V2.paraphrase)) {
    assert(`v2 paraphrase/${m}: keeps paragraph count, plain text, names/numbers, meaning, no preamble`,
      /same number of paragraphs/i.test(p) && /plain text/i.test(p) && /names, numbers/i.test(p) && /keep the meaning/i.test(p) && /preamble/i.test(p));
  }
  for (const [m, p] of Object.entries(V2.humanize)) assert(`v2 humanize/${m}: keeps meaning, facts, paragraph count, plain text; returns only the text`, /meaning, facts and paragraph count/.test(p) && /plain text/i.test(p) && /return only/i.test(p));
  assert('v2 grammar keeps the exact answer format the page parses', /CORRECTED TEXT:/.test(V2.grammar) && /ERRORS FOUND:/.test(V2.grammar) && /No errors found! Your text looks great\./.test(V2.grammar));
  const sizes = { paraphrase: tok(V2.paraphrase.standard), oldParaphrase: tok(oldPara), code: tok(V2.code_assistant) };
  console.log('   token snapshot (≈ chars/4):', JSON.stringify(sizes));
  assert('v2 paraphrase ≈ ≤ 160 tokens (old rules ≈ 300+)', sizes.paraphrase <= 160 && sizes.oldParaphrase > 250, JSON.stringify(sizes));
  const srcProc = fs.readFileSync(path.join(__dirname, '..', 'api', 'process.js'), 'utf8');
  const oldCode = (srcProc.match(/code_assistant: `([\s\S]*?)`,\n/) || srcProc.match(/code_assistant: `([\s\S]*?)`,\r\n/) || [])[1] || '';
  assert('v2 code_assistant is under 60 % of the current one', sizes.code < 0.6 * tok(oldCode), `${sizes.code} vs ${tok(oldCode)}`);
  for (const fact of ['54 ATS-friendly templates', '18 languages', 'no word limit', 'Jooble', 'faq.html', 'contact.html', 'never quote other tools']) assert(`v2 code_assistant keeps the fact: ${fact}`, V2.code_assistant.toLowerCase().includes(fact.toLowerCase()));
  assert('v2 code_assistant does not pretend to switch AI models', !/Switching to \[model/i.test(V2.code_assistant) && /can't switch models/.test(V2.code_assistant));
  assert('flag OFF by default (page and module)', V2.PROMPT_DIET_DEFAULT === false && V2.enabled === false && /PFPromptsV2\.enabled\) \{ Object\.assign\(MODE_PROMPTS/.test(html));
  behaviour = (n) => (n.startsWith('groq/') ? 'ok' : 'fail');
  r = await call({ text: SHORT, mode: 'standard' });
  assert('server default (PROMPT_DIET unset) sends the current prompt', /STRICT RULES/.test(contentOf(r.calls[0].body)));
  process.env.PROMPT_DIET = 'on';
  r = await call({ text: SHORT, mode: 'standard' });
  assert('PROMPT_DIET=on sends the shortened prompt', contentOf(r.calls[0].body).startsWith('Paraphrase the text below. Rules:') && !/STRICT RULES/.test(contentOf(r.calls[0].body)));
  delete process.env.PROMPT_DIET;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
