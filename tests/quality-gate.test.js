'use strict';
// Phase 1 — never return unfinished or unparaphrased text (api/_quality.js + its wiring in api/process.js,
// lib/partial.js). ALL providers are mocked via global.fetch; any URL not mocked throws, so nothing leaves
// this process. Run: node tests/quality-gate.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$/.test(k)) delete process.env[k];
Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GEMINI_KEY: 'gemini-key-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx' });

const Q = require('../api/_quality.js');
const P = require('../lib/partial.js');
const { fakeAnswer, contentOf, textPart } = require('./_fake-answer');

// ── fetch mock: each provider answers with behaviour[name](content) → { text?, finish?, status?, body? } ──
let behaviour = {}, calls = [];
const respond = (status, json) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) });
function nameOf(url, body) {
  if (url.startsWith('https://api.groq.com/')) return 'groq/' + body.model;
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'gemini/' + url.match(/\/models\/([^:]+):/)[1];
  if (url.includes('/ai/run/')) return 'cloudflare';
  if (url.startsWith('https://integrate.api.nvidia.com/')) return 'nvidia/' + body.model;
  if (url.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net/')) return 'ovhcloud';
  if (url.startsWith('https://api.llm7.io/')) return 'llm7';
  return null;
}
global.fetch = async (url, opts) => {
  if (opts && opts.method === 'GET' && /\/models(\?|\/search|$)/.test(url)) return respond(503, { error: 'lists unavailable in this test' });
  let body = {}; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (_) {}
  const name = nameOf(url, body);
  if (!name) throw new Error('UNMOCKED URL — refusing live call: ' + url);
  const content = contentOf(body);
  calls.push({ name, body, words: (textPart(content).match(/\S+/g) || []).length });
  const fam = name.split('/')[0];
  const fn = behaviour[name] || behaviour[fam] || behaviour['*'];
  const r = fn ? fn(content, body) : { status: 500 };
  if (r.status && r.status !== 200) return respond(r.status, r.body || { error: 'mock failure' });
  const text = r.text;
  if (fam === 'gemini') return respond(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: r.finish || 'STOP' }] });
  if (fam === 'cloudflare') return respond(200, { success: true, result: { response: text, usage: { completion_tokens: r.finish === 'length' ? body.max_tokens : 10 } } });
  return respond(200, { choices: [{ message: { content: text }, finish_reason: r.finish || 'stop' }] });
};
const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
const realLog = console.log, realWarn = console.warn, realErr = console.error;
let logs = [];
const quiet = () => { const c = (...a) => logs.push(a.join(' ')); console.log = c; console.warn = c; console.error = c; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };

let handler; quiet(); try { handler = require('../api/process.js'); } finally { loud(); }
let ip = 0;
async function call(body) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.9.0.' + (++ip) }, body };
  let status = 0, payload = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { payload = j; return this; }, end() { return this; }, write() {} };
  calls = []; logs = [];
  quiet(); try { await handler(req, res); } finally { loud(); }
  return { status, payload, calls: calls.slice(), logs: logs.slice() };
}
const fresh = (b) => { behaviour = b; shift += 61 * 60 * 1000; };   // expire cooldowns between cases
const good = (content) => ({ text: fakeAnswer(content) });
const words = (n, seed = 'alpha') => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? 'end.' : seed + (i % 50))).join(' ');
const sentencePara = (n) => Array.from({ length: Math.ceil(n / 12) }, (_, i) => `Sentence number ${i} explains a different idea about learning and memory today.`).join(' ');

(async () => {
  console.log('\n── 1. Segmenting: long paragraphs split by sentence, paragraphs kept ──');
  const P1744 = sentencePara(1744);
  const units = Q.segment(P1744);
  assert('1,744-word single paragraph → ≥5 sentence pieces of ≤350 words', units.length >= 5 && units.every(u => Q.countWords(u.text) <= 350), units.map(u => Q.countWords(u.text)).join(','));
  assert('pieces of one paragraph rejoin with a space (paragraph count unchanged)', Q.rebuild(units, units.map(u => u.text)) === P1744.replace(/\s+/g, ' ').trim());
  const doc = 'Heading one\n\nFirst paragraph with some words in it here.\n\n• A list item that stays\n\n42\n\nLast paragraph of the document is this one.';
  const du = Q.segment(doc);
  assert('paragraphs, headings and list items stay separate units', du.length === 5 && du[3].send === false, JSON.stringify(du.map(u => [u.text.slice(0, 10), u.send])));
  assert('rebuild with the same texts gives the document back exactly', Q.rebuild(du, du.map(u => u.text)) === doc);
  const docx = '<<<1>>> ' + sentencePara(700) + '\n\n<<<2>>> Short second paragraph stays whole.';
  const xu = Q.segment(docx);
  assert('DOCX: a long marked paragraph is split; only its first piece keeps <<<1>>>', xu[0].text.startsWith('<<<1>>>') && !xu[1].text.startsWith('<<<') && xu[xu.length - 1].text.startsWith('<<<2>>>'));
  const pptx = '[SLIDE1_BOX1]Title text here[/SLIDE1_BOX1]\n[SLIDE1_BOX2]Body text of the slide goes here today.[/SLIDE1_BOX2]';
  const pu = Q.segment(pptx);
  assert('PPTX: each [SLIDEn_BOXm] box is one unit, never split', pu.length === 2 && pu.every(u => u.box));
  assert('PPTX: rebuild keeps the boxes and the newline between them', Q.rebuild(pu, pu.map(u => u.text)) === pptx);

  console.log('\n── 2. The gate ──');
  const IN = 'The students in the first group studied every evening for two weeks before the final exam, and their scores improved a lot.';
  const OUT = 'Every evening for a fortnight before the final test, students from the first group revised, and their marks rose considerably.';
  assert('a real paraphrase passes', Q.gate(IN, OUT, { kind: 'paraphrase', mode: 'standard' }) === null, Q.gate(IN, OUT, { kind: 'paraphrase', mode: 'standard' }));
  assert('near-identical answer → unchanged', Q.gate(IN, IN.replace('a lot', 'greatly'), { kind: 'paraphrase', mode: 'standard' }) === 'unchanged');
  assert('too short (<0.6×) → length_ratio', Q.gate(IN, 'Students studied and improved.', { kind: 'paraphrase' }) === 'length_ratio');
  assert('too long (>1.6×) → length_ratio', Q.gate(IN, OUT + ' ' + OUT + ' Extra words added here.', { kind: 'paraphrase' }) === 'length_ratio');
  assert('"Here is the paraphrased text:" → preamble', Q.gate(IN, 'Here is the paraphrased text:\n\n' + OUT, { kind: 'paraphrase' }) === 'preamble');
  assert('markdown the input did not have → markdown', Q.gate(IN, '**Every evening** for a fortnight before the final test, students from the first group revised, and their marks rose.', { kind: 'paraphrase' }) === 'markdown');
  assert('wrong script (asked for Bengali, got English) → script', Q.gate(IN, OUT, { kind: 'paraphrase', language: 'bengali' }) === 'script');
  assert('English input, Spanish answer → script', Q.gate(IN, 'Cada tarde durante dos semanas antes del examen final, los estudiantes del primer grupo repasaron y sus notas subieron mucho.', { kind: 'paraphrase' }) === 'script');
  const loop = 'The study shows a clear result for every student in the group. '.repeat(4);
  assert('repetition loop → repetition', Q.gate(IN, loop, { kind: 'paraphrase' }) === 'repetition');
  assert('DOCX marker dropped → markers', Q.gate('<<<1>>> ' + IN + '\n\n<<<2>>> ' + IN, '<<<1>>> ' + OUT + '\n\n' + OUT, { kind: 'paraphrase' }) === 'markers');
  assert('Formal mode threshold (12 %) lower than Standard (15 %)', Q.MIN_CHANGE.formal < Q.MIN_CHANGE.standard && Q.MIN_CHANGE.creative > Q.MIN_CHANGE.standard);
  assert('grammar: answer without "CORRECTED TEXT:" → format', Q.gate(IN, OUT, { kind: 'grammar' }) === 'format');
  assert('grammar: a near-identical correction is fine (no change minimum)', Q.gate(IN, 'CORRECTED TEXT:\n' + IN + '\n\nERRORS FOUND:\nNo errors found! Your text looks great.', { kind: 'grammar' }) === null);
  assert('summarize: bullets are allowed, but a "summary" as long as the input is not', Q.gate(sentencePara(120), '• One point\n• Two points here', { kind: 'summarize' }) === null && Q.gate(sentencePara(120), sentencePara(120), { kind: 'summarize' }) === 'length_ratio');
  assert('output cap = clamp(words × 2.2, 600, 3000)', Q.outputCap(100) === 600 && Q.outputCap(1000) === 2200 && Q.outputCap(5000) === 3000);
  assert('finish reasons: OpenAI "length", Gemini MAX_TOKENS/SAFETY are problems; STOP is not',
    Q.finishProblem({ choices: [{ finish_reason: 'length' }] }) === 'length' && Q.finishProblem({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'gemini') === 'length'
    && Q.finishProblem({ candidates: [{ finishReason: 'SAFETY' }] }, 'gemini') === 'safety' && Q.finishProblem({ candidates: [{ finishReason: 'STOP' }] }, 'gemini') === null);

  // Sections 3–6 and 8–10 (handler: gate rejections, split on failure, best-of-gated, auto-retry, 20b routing) were
  // removed with the Nov-4 restore of the writing path — tests/nov4-restore.test.js covers the engine as it is now.
  const BAD = 'Paragraph two is the one that never works with any provider at all today, sadly for everyone here.';

  console.log('\n── 7. lib/partial.js (page side) ──');
  P.reset();
  P.add([{ text: BAD }]);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc('Paragraph one changed.\n\n' + BAD + '\n\nParagraph three changed.');
  assert('the unchanged paragraph is wrapped in <mark class="pf-unchanged">', /<mark class="pf-unchanged"[^>]*>Paragraph two is the one/.test(P.markHtml(html, esc)));
  assert('splice replaces exactly that part', P.splice('A\n\n' + BAD + '\n\nC', BAD, 'New two') === 'A\n\nNew two\n\nC' && P.splice('A', BAD, 'x') === null);
  P.remove(0);
  assert('after a successful retry nothing is marked', P.markHtml(html, esc) === html);


  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
