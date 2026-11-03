'use strict';
// Phase 2 — fewer, bigger chunks: ~1,000-word chunks ("try big, split on failure"), up to 3 in flight on different
// keys, an 80 s budget under maxDuration 90, per-provider timeouts scaled to the chunk, NDJSON streaming in document
// order, 3,000-word browser batches. Providers are MOCKED (global.fetch; unknown URLs throw) with realistic,
// size-dependent latency, against the real handler. Run: node tests/long-docs.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
const fs = require('fs'), path = require('path'), vm = require('vm');
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$/.test(k)) delete process.env[k];
Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GROQ_KEY_3: 'groq-key-3-xxxxxxxx', GROQ_KEY_4: 'groq-key-4-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx' });
const { fakeAnswer, contentOf, textPart } = require('./_fake-answer');
const Q = require('../api/_quality.js');

const KEYNAME = { 'groq-key-1-xxxxxxxx': 'groq', 'groq-key-2-xxxxxxxx': 'groq-2', 'groq-key-3-xxxxxxxx': 'groq-3', 'groq-key-4-xxxxxxxx': 'groq-4' };
let calls = [], inFlight = {}, maxInFlight = {}, behaviour = null, msPerWord = 2;
const respond = (status, json) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
global.fetch = async (url, opts) => {
  if (opts && opts.method === 'GET') return respond(503, { error: 'lists unavailable in this test' });
  const body = JSON.parse(opts.body || '{}');
  let key;
  if (url.startsWith('https://api.groq.com/')) key = KEYNAME[(opts.headers.Authorization || '').slice(7)] + '/' + body.model;
  else if (url.startsWith('https://generativelanguage.googleapis.com/')) key = 'gemini';
  else if (url.includes('/ai/run/')) key = 'cloudflare';
  else if (/nvidia|ovh|llm7/.test(url)) key = url.split('/')[2];
  else throw new Error('UNMOCKED URL — refusing live call: ' + url);
  const words = (textPart(contentOf(body)).match(/\S+/g) || []).length;
  const pool = key.split('/')[0];
  inFlight[pool] = (inFlight[pool] || 0) + 1; maxInFlight[pool] = Math.max(maxInFlight[pool] || 0, inFlight[pool]);
  calls.push({ key, words, t: Date.now(), maxTokens: body.max_tokens || (body.generationConfig || {}).maxOutputTokens });
  try {
    const b = behaviour ? behaviour(key, words) : 'ok';
    // honours the abort signal like real fetch, so a provider timeout really ends the call
    await new Promise((r, rej) => {
      const t = setTimeout(r, typeof b === 'object' && b.delay != null ? b.delay : 300 + words * msPerWord);
      if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('This operation was aborted'); e.name = 'AbortError'; rej(e); });
    });
    if (b === 'fail' || (b && b.fail)) return respond(500, { error: 'mock failure' });
    const text = fakeAnswer(contentOf(body));
    if (key === 'gemini') return respond(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    if (key === 'cloudflare') return respond(200, { success: true, result: { response: text } });
    return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
  } finally { inFlight[pool]--; }
};
const realLog = console.log, realWarn = console.warn, realErr = console.error;
let logs = [];
const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }

let ip = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.7.0.' + (++ip) }, body };
  let status = 0, payload = null; const lines = []; const t0 = Date.now(); let buf = '';
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(s) { status = s; return this; }, json(j) { payload = j; return this; },
    write(s) { buf += s; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push({ at: Date.now() - t0, msg: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); } return true; },
    end() { return this; } };
  calls = []; inFlight = {}; maxInFlight = {}; logs = [];
  quiet(); try { await handler(req, res); } finally { loud(); }
  return { status: status || res.statusCode, payload, lines, calls: calls.slice(), logs: logs.slice(), ms: Date.now() - t0, headers: res.headers };
}
const para = (i, n) => `Paragraph ${i} begins here. ` + Array.from({ length: Math.ceil(n / 10) }, (_, k) => `Learners revise topic ${k} with care and patience daily.`).join(' ');
const doc = (paras, n) => Array.from({ length: paras }, (_, i) => para(i, n)).join('\n\n');

(async () => {
  console.log('\n── 1. 3,000-word document on a good day ──');
  const D3K = doc(15, 200);                                   // 15 paragraphs × ~200 words ≈ 3,000 words
  let r = await call({ text: D3K, mode: 'standard' });
  assert('success, complete, 15 paragraphs in order', r.status === 200 && r.payload.success && r.payload.result.split(/\n\s*\n/).length === 15
    && r.payload.result.search(/Paragraph(ed)? 0\b/) === 0 && r.payload.result.search(/Paragraph(ed)? 0\b/) < r.payload.result.search(/Paragraph(ed)? 14\b/),r.status + ' ' + JSON.stringify(r.payload).slice(0, 120));
  assert('≤3 provider calls for ~3,000 words', r.calls.length <= 3, r.calls.map((c) => c.key + ':' + c.words).join(' '));
  assert('chunks of ~1,000 words, run in parallel (total time ≈ one chunk, not three)', r.calls.every((c) => c.words >= 600 && c.words <= 1100) && r.ms < (300 + 1100 * msPerWord) * 2, r.ms + ' ms');
  assert('big chunks on DIFFERENT keys at the same time (never two on one key)', Object.values(maxInFlight).every((n) => n <= 1), JSON.stringify(maxInFlight));
  assert('output cap fits a 1,000-word chunk (2,200 tokens)', r.calls.every((c) => c.maxTokens === Q.outputCap(c.words)));

  console.log('\n── 2. Try big, split on failure ──');
  behaviour = (key, words) => (words > 600 ? 'fail' : 'ok');
  r = await call({ text: D3K, mode: 'standard' });
  assert('a 1,000-word chunk that fails everywhere is split in two; the halves succeed', r.status === 200 && !r.payload.failedParts && r.logs.some((l) => /split in two/.test(l)), JSON.stringify(r.payload).slice(0, 200));
  assert('merge order kept after splitting', r.payload.result.split(/\n\s*\n/).map((p) => (p.match(/Paragraph(?:ed)? (\d+)/) || [])[1]).join(',') === Array.from({ length: 15 }, (_, i) => i).join(','));
  behaviour = (key, words) => (words > 600 ? { delay: 31000 } : 'ok');
  msPerWord = 2;
  console.log('   (timeout case: a mocked 31 s hang on big chunks — takes ~30 s)');
  r = await call({ text: doc(5, 200), mode: 'standard' });
  assert('a big chunk that times out is split and the halves succeed (no hang past the per-provider cap)', r.status === 200 && r.ms < 80000 && r.logs.some((l) => /split in two/.test(l)), r.ms + ' ms ' + JSON.stringify(r.payload).slice(0, 120));
  behaviour = null;

  console.log('\n── 3. Per-provider timeouts scaled to the chunk ──');
  r = await call({ text: D3K, mode: 'standard' });
  const tmo = r.logs.filter((l) => /chunk seq=\d+: \d+ chars, \d+s share/.test(l));
  assert('chunk share reported against the 80 s budget', tmo.some((l) => /(39|40|79|80)s share/.test(l)), tmo.slice(0, 2).join(' | '));
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert('vercel.json: maxDuration 90 for api/process.js', vj.functions['api/process.js'].maxDuration === 90);
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'process.js'), 'utf8');
  assert('REQUEST_BUDGET 80 s, timeout = min(30 s, max(base, words × 15 ms))', /const REQUEST_BUDGET = 80000;/.test(src) && /Math\.min\(PROVIDER_TIMEOUT_CAP, Math\.max\(base, words \* 15\)\)/.test(src) && /PROVIDER_TIMEOUT_CAP = 30000/.test(src));

  console.log('\n── 4. Streaming: NDJSON per finished part, in document order ──');
  // later chunks finish FIRST (the first chunk is slow): lines must still come out 0, 1, 2, …
  behaviour = (key, words) => ({ delay: words < 400 ? 2500 : 300 });
  r = await call({ text: D3K, mode: 'standard', stream: true });
  const chunkLines = r.lines.filter((l) => l.msg.type === 'chunk');
  const done = r.lines.find((l) => l.msg.type === 'done');
  assert('NDJSON content type', /ndjson/.test(r.headers['content-type'] || ''), r.headers['content-type']);
  assert('chunk lines come in index order even when later chunks finish first', chunkLines.length >= 2 && chunkLines.every((l, i) => l.msg.index === i), chunkLines.map((l) => l.msg.index).join(','));
  assert('a final "done" line with the whole result', done && done.msg.success && done.msg.result.split(/\n\s*\n/).length === 15);
  assert('the streamed parts + separators add up to exactly the final result', chunkLines.map((l) => l.msg.text + (l.msg.sep || '')).join('') === done.msg.result);
  behaviour = null;
  r = await call({ text: D3K, mode: 'standard', stream: true });
  const first = r.lines.find((l) => l.msg.type === 'chunk'), fin = r.lines.find((l) => l.msg.type === 'done');
  assert('streaming: a small first part (~250 words) so the first text shows early', r.calls.length && Math.min(...r.calls.map((c) => c.words)) <= 400, r.calls.map((c) => c.words).join(','));
  assert('first text arrives well before the end (mocked ~2 ms/word latency)', first && fin && first.at < fin.at && first.at <= 2000, `${first && first.at} ms vs ${fin && fin.at} ms`);
  behaviour = () => 'fail';
  r = await call({ text: doc(3, 100), mode: 'standard', stream: true });
  const dn = r.lines.find((l) => l.msg.type === 'done');
  assert('streaming + nothing paraphrased → done line success:false, error high_demand, status 503 (never a copy)', dn && dn.msg.success === false && dn.msg.error === 'high_demand' && dn.msg.status === 503);
  behaviour = null;

  console.log('\n── 5. Browser batches (index.html) ──');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const grab = (re) => (html.match(re) || [''])[0];
  const ctx = { countWords: (t) => t.trim().split(/\s+/).filter(Boolean).length };
  vm.createContext(ctx);
  const fnSrc = (() => { const i = html.indexOf('function buildFrontendBatches('); let d = 0, j = html.indexOf('{', i); for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); } } })();
  vm.runInContext(grab(/const BATCH_SPLIT_THRESHOLD = \d+;/).replace('const', 'var') + '\n' + grab(/const BATCH_TARGET_WORDS\s*= \d+;/).replace('const', 'var') + '\n' + fnSrc, ctx);
  assert('a ~3,000-word document is ONE request', ctx.buildFrontendBatches(D3K, null).length === 1);
  const D7K = doc(35, 200);
  const b7 = ctx.buildFrontendBatches(D7K, null);
  assert('a ~7,000-word document → 3 requests of ≤ ~3,200 words', b7.length === 3 && b7.every((b) => ctx.countWords(b.text) <= 3300), b7.map((b) => ctx.countWords(b.text)).join(','));
  assert('each request body stays far below Vercel\'s 4.5 MB limit', b7.every((b) => Buffer.byteLength(JSON.stringify({ text: b.text })) < 100 * 1024));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
