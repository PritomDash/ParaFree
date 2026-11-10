'use strict';
// The writing path (paraphrase / humanize / grammar / summarize) restored to the Nov-4 engine (a65c892), Nov 10.
// ALL providers are mocked via global.fetch; any URL not mocked throws, so nothing leaves this process.
// Run: node tests/nov4-restore.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

const fs = require('fs'), path = require('path');
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|^PF_MAX|^PROMPT_DIET|MODEL_BLOCKLIST|_PREFS$/.test(k)) delete process.env[k];
Object.assign(process.env, { PF_HEALTH_FAILS: '100000', GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GEMINI_KEY: 'gemini-key-1-xxxxxxxx',
  GEMINI_KEY_2: 'gemini-key-2-xxxxxxxx', GEMINI_KEY_3: 'gemini-key-3-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx' });

const { fakeAnswer, contentOf, textPart } = require('./_fake-answer');
const MD = require('../api/_model-discovery.js');

// ── fetch mock: behaviour[name | family | '*'](content) → { text?, finish?, status? }; in-flight calls are counted ──
let behaviour = {}, calls = [], inFlight = 0, maxInFlight = 0;
const respond = (status, json) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
const KEYNAME = { 'gemini-key-1-xxxxxxxx': 'gemini', 'gemini-key-2-xxxxxxxx': 'gemini-2', 'gemini-key-3-xxxxxxxx': 'gemini-3' };
function nameOf(url, body, opts) {
  if (url.startsWith('https://api.groq.com/')) return (String(opts.headers.Authorization).includes('key-2') ? 'groq-2/' : 'groq/') + body.model;
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return KEYNAME[(url.match(/key=([^&]+)/) || [])[1]] + '/' + url.match(/\/models\/([^:]+):/)[1];
  if (url.includes('/ai/run/')) return 'cloudflare';
  if (url.startsWith('https://integrate.api.nvidia.com/')) return 'nvidia/' + body.model;
  if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) return 'ovhcloud';
  if (url.startsWith('https://api.llm7.io/')) return 'llm7';
  return null;
}
global.fetch = async (url, opts = {}) => {
  if (opts.method === 'GET' && /\/models(\?|\/search|$)/.test(url)) return respond(503, { error: 'lists unavailable in this test' });
  let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
  const name = nameOf(url, body, opts);
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  const content = contentOf(body);
  calls.push({ name, body, words: (textPart(content).match(/\S+/g) || []).length });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 5));
    const fam = name.split('/')[0];
    const fn = behaviour[name] || behaviour[fam] || behaviour[fam.replace(/-\d+$/, '')] || behaviour['*'];   // groq-2 → groq
    const r = fn ? fn(content, body) : { status: 500 };
    if (r.status && r.status !== 200) return respond(r.status, r.body || { error: 'mock failure' });
    if (fam.startsWith('gemini')) return respond(200, { candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: r.finish || 'STOP' }] });
    if (fam === 'cloudflare') return respond(200, { success: true, result: { response: r.text, usage: { completion_tokens: r.finish === 'length' ? body.max_tokens : 10 } } });
    return respond(200, { choices: [{ message: { content: r.text }, finish_reason: r.finish || 'stop' }] });
  } finally { inFlight--; }
};
const realLog = console.log, realWarn = console.warn, realErr = console.error;
let logs = [];
const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };

let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
let ip = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.11.0.' + (++ip) }, body };
  let status = 0, payload = null; const lines = [];
  const res = { statusCode: 0, setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; }, write(s) { lines.push(s); } };
  calls = []; logs = []; maxInFlight = 0;
  handler._writingCooldowns.clear();
  quiet(); try { await handler(req, res); } finally { loud(); }
  return { status: status || res.statusCode, payload, calls: calls.slice(), logs: logs.slice(), lines };
}
const good = (c) => ({ text: fakeAnswer(c) });
const echo = (c) => ({ text: textPart(c) });   // the model hands the text back exactly as it was sent
const para = (i) => `Paragraph ${i} explains how students plan their weekly revision, test themselves with flashcards, take short breaks between sessions and review their mistakes before the final exam begins next month.`;
const blk = (i, n) => Array.from({ length: n }, (_, j) => para(i * 100 + j)).join(' ');   // one paragraph of n × 32 words

(async () => {
  console.log('\n── 1. Headings, short questions, short lines, citations, URLs, code + paragraphs: zero retries ──');
  const MIXED = [
    '# Week 1: Planning',
    'Why plan at all?',
    blk(1, 6),
    'Key terms',
    '- spaced repetition',
    'What is active recall?',
    blk(2, 6),
    'Smith, J. (2020). Learning how to learn. Oxford University Press.',
    'https://example.org/study-guide',
    'const plan = weeks.map(w => w.topics);',
    '2026 — 14 — 28',
    blk(3, 6),
    'Summary',
    blk(4, 8),
  ].join('\n\n');
  behaviour = { '*': good };
  let r = await call({ text: MIXED, mode: 'standard' });
  const chunks = (r.logs.find((l) => /writing: \d+ chunk/.test(l)) || '').match(/writing: (\d+) chunk/);
  const n = chunks ? Number(chunks[1]) : -1;
  assert('the mixed document completes (200, success, no failed parts)', r.status === 200 && r.payload.success && !r.payload.failedParts, JSON.stringify(r.payload).slice(0, 200));
  assert(`zero retries: exactly one provider call per chunk (${n} chunks, ${r.calls.length} calls)`, n >= 1 && r.calls.length === n, r.calls.map((c) => c.name).join(','));
  assert('~350-word chunks, never more than 4 per request', n >= 1 && n <= 4 && r.calls.every((c) => c.words <= 520), r.calls.map((c) => c.words).join(','));
  assert('chunks run one at a time (never two provider calls in flight)', maxInFlight === 1, String(maxInFlight));
  assert('every paragraph comes back, in order (headings and short lines included)', r.payload.result.split(/\n\s*\n/).length === MIXED.split(/\n\s*\n/).length, r.payload.result.split(/\n\s*\n/).length);

  behaviour = { '*': echo };   // the model leaves EVERYTHING unchanged — accepted, never "unparaphrased", never retried
  r = await call({ text: MIXED, mode: 'standard' });
  assert('an answer identical to the input is accepted from the first provider (no "unchanged" gate, no retry)', r.status === 200 && r.calls.length === n && !r.payload.failedParts && !r.logs.some((l) => /rejected/.test(l)), r.calls.map((c) => c.name).join(','));
  r = await call({ text: 'Why plan at all?\n\nKey terms\n\nhttps://example.org/a\n\nSmith, J. (2020). Learning. OUP.', mode: 'standard' });
  assert('a document of only headings / questions / links / citations: one call, accepted as it is', r.status === 200 && r.payload.success && r.calls.length === 1 && !r.payload.failedParts, r.calls.map((c) => c.name).join(','));

  console.log('\n── 2. Only empty, cut-off and wrong-language answers move on ──');
  const ONE = para(1) + ' ' + para(2);
  // (the first call goes to whichever Groq key the rotation picks, so behaviours key on the family and count calls)
  behaviour = { groq: () => ({ text: '**Here is the paraphrased text:**\n\n* ' + para(1) }), '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  assert('markdown / preamble / short answers are NOT rejected (first provider used)', r.status === 200 && r.calls.length === 1, r.calls.map((c) => c.name).join(','));
  let once = 0;
  behaviour = { groq: (c) => (once++ ? good(c) : { text: '   ' }), '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  assert('empty answer → next provider', r.status === 200 && r.calls.length === 2, r.calls.map((c) => c.name).join(','));
  once = 0;
  behaviour = { groq: (c) => (once++ ? good(c) : { text: fakeAnswer(c).slice(0, 60), finish: 'length' }), '*': good };
  r = await call({ text: ONE, mode: 'standard' });
  assert('finish_reason=length (cut off) → next provider', r.status === 200 && r.calls.length === 2 && !/^.{0,80}$/.test(r.payload.result), r.calls.map((c) => c.name).join(','));
  once = 0;
  behaviour = { groq: (c) => (once++ ? good(c) : { text: 'Los estudiantes planifican su repaso cada semana, se ponen a prueba con tarjetas y descansan entre sesiones antes del examen final del mes que viene, y repasan sus errores con calma.' }), '*': good };
  // (Spanish answer for an English text, then a proper one)
  r = await call({ text: ONE, mode: 'standard' });
  assert('wrong language (Spanish for English) → next provider', r.status === 200 && r.calls.length === 2 && r.logs.some((l) => /rejected \(script\)/.test(l)), r.calls.map((c) => c.name).join(','));
  behaviour = { '*': good };
  r = await call({ text: ONE, mode: 'standard', language: 'spanish' });
  assert('…but an English answer is fine when the page asked for no other script (Spanish is Latin script too)', r.status === 200 && r.calls.length === 1);

  console.log('\n── 3. No "max N providers", no split, no best-of ──');
  let k = 0;
  behaviour = { '*': (c) => (++k <= 6 ? { status: 500 } : good(c)) };
  r = await call({ text: ONE, mode: 'standard' });
  assert('six providers fail → the 7th answers the SAME chunk (no limit, no split)', r.status === 200 && r.calls.length === 7 && new Set(r.calls.map((c) => c.words)).size === 1 && !r.logs.some((l) => /split|stopping here|best one/.test(l)), r.calls.map((c) => c.name + ':' + c.words).join(','));
  const THREE = [blk(1, 12), blk(2, 12) + ' MARKER-FAIL', blk(3, 12), blk(4, 12)].join('\n\n');   // 4 chunks of ~384 words
  behaviour = { '*': (c) => (/MARKER-FAIL/.test(c) ? { status: 500 } : good(c)) };
  r = await call({ text: THREE, mode: 'standard' });
  const fp = (r.payload && r.payload.failedParts) || [];
  assert('a chunk no provider could do keeps its ORIGINAL text and is reported in failedParts (once, not split)', r.status === 200 && fp.length === 1 && /MARKER-FAIL/.test(fp[0].text) && r.payload.result.includes(fp[0].text), JSON.stringify(fp).slice(0, 200));
  assert('… the other chunks are paraphrased', r.payload.result.split(fp[0] ? fp[0].text : '§').join('').length > 200 && /edd?\b/.test(r.payload.result));
  behaviour = { '*': () => ({ status: 500 }) };
  r = await call({ text: ONE, mode: 'standard' });
  assert('nothing paraphrased at all → 503 (never a silent copy)', r.status === 503);

  console.log('\n── 4. Provider fixes (testKeys, Nov 10) ──');
  assert('gemini-3.7-flash is on the built-in blocklist (never resolved into the chain)', MD.blocklist({}).has('gemini:gemini-3.7-flash'));
  behaviour = { gemini: () => ({ status: 429, body: { error: { message: 'Quota exceeded for metric: generate_requests_per_model_per_day' } } }),
    groq: () => ({ status: 500 }), 'gemini-2/gemma-3-27b-it': good, 'gemini-3': () => ({ status: 500 }), 'gemini-2': (c, b) => ({ status: 500 }), '*': () => ({ status: 500 }) };
  behaviour['gemini-2/gemma-3-27b-it'] = good;
  r = await call({ text: ONE, mode: 'standard' });
  const names = r.calls.map((c) => c.name);
  // key-1 Gemma is no longer pinned off: health marking takes a model out only after 5 failures in a row on that key
  // (tests/model-health.test.js). Here key 1 answers 429 — rate limits never count — so it is still tried.
  assert('key-1 Gemma is still tried (no hard-coded skip; a 429 is not a health failure)', names.includes('gemini/gemma-3-27b-it'), names.join(','));
  assert('gemini-2 Gemma is kept and answers', r.status === 200 && names[names.length - 1] === 'gemini-2/gemma-3-27b-it', names.join(','));
  assert('GEMINI_KEY_3 is its own entry in the chain', names.some((x) => x.startsWith('gemini-3/')), names.join(','));

  console.log('\n── 5. Streaming still works on the Nov-4 chunks (display only) ──');
  behaviour = { '*': good };
  r = await call({ text: THREE.replace(' MARKER-FAIL', ''), mode: 'standard', stream: true });
  const msgs = r.lines.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const chunkMsgs = msgs.filter((m) => m.type === 'chunk'), done = msgs.find((m) => m.type === 'done');
  assert('one "chunk" line per chunk, in order, then "done" with the whole result', chunkMsgs.length >= 2 && chunkMsgs.every((m, i) => m.index === i) && done && done.success && done.result === chunkMsgs.map((m) => m.text + m.sep).join(''), JSON.stringify(msgs.map((m) => m.type)));

  console.log('\n── 6. Browser: one request at a time, nothing re-sent on its own ──');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const partial = fs.readFileSync(path.join(__dirname, '..', 'lib', 'partial.js'), 'utf8');
  assert('Nov-4 browser batches: split above 1,400 words into ~1,200-word requests', /BATCH_SPLIT_THRESHOLD = 1400;/.test(html) && /BATCH_TARGET_WORDS\s+= 1200;/.test(html));
  assert('no automatic re-submission: the "queued" auto re-send and the silent part retries are gone', !/_pfQueueTries/.test(html) && !/autoRetry\(/.test(html) && !/autoRetry|AUTO_WAITS|PF_AUTO_RETRY_WAITS/.test(partial));
  assert('one manual "Retry" button (not one per part), disabled while a retry runs', /b\.textContent = 'Retry';/.test(partial) && /if \(busy\) return;/.test(partial) && !/'Retry part '/.test(partial));
  assert('Ctrl+Enter ignores key auto-repeat and runs nothing while a request runs', /if \(e\.repeat \|\| isLoading\) return;/.test(html));
  assert('the same text that just finished is not sent again (paraphrase and humanize)', (html.match(/if \(pfIsRepeat\(/g) || []).length === 2 && /function pfRunDone\(\)/.test(html));
  assert('no concurrent requests from the page: no Promise.all anywhere in index.html', !/Promise\.all/.test(html));
  assert('the server chunks one at a time', /CHUNK_CONCURRENCY\s*=\s*1;/.test(fs.readFileSync(path.join(__dirname, '..', 'api', 'process.js'), 'utf8')));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
