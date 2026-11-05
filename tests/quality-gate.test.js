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

  console.log('\n── 3. Handler: 1,744-word single paragraph ──');
  fresh({ '*': good });
  let r = await call({ text: P1744, mode: 'standard', type: 'paraphrase' });
  const groqCalls = r.calls.filter(c => c.name.startsWith('groq'));
  assert('success', r.status === 200 && r.payload.success, JSON.stringify(r.payload).slice(0, 200));
  // Phase 2 groups the sentence pieces into ~1,000-word chunks: never one 1,744-word chunk, every chunk ≤ 1,000 words
  assert('never sent as one 1,744-word chunk: ≥2 chunks, each ≤ 1,000 words', r.calls.length >= 2 && r.calls.every(c => c.words <= 1000), r.calls.map(c => c.words).join(','));
  assert('complete: the answer has about as many words as the input', Math.abs(Q.countWords(r.payload.result) - 1744) < 60, Q.countWords(r.payload.result));
  assert('still ONE paragraph (pieces rejoined with spaces)', !/\n\s*\n/.test(r.payload.result));
  assert('no failed parts', !r.payload.failedParts);
  assert('max_tokens sized to the chunk (clamp(words × 2.2, 600, 3000))', groqCalls.every(c => c.body.max_tokens === Q.outputCap(c.words)), groqCalls.map(c => c.words + ':' + c.body.max_tokens).join(' '));

  console.log('\n── 4. Cut-off and gated answers fall through to the next provider ──');
  const LONG = Array.from({ length: 4 }, (_, i) => `Paragraph ${i}: ` + sentencePara(60)).join('\n\n');
  fresh({ groq: (c) => ({ text: fakeAnswer(c).slice(0, 80), finish: 'length' }), gemini: good });
  r = await call({ text: LONG, mode: 'standard' });
  assert('OpenAI-style finish_reason "length" → next provider (Gemini) answers', r.status === 200 && r.calls.some(c => c.name.startsWith('gemini')) && r.payload.result.split(/\n\s*\n/).length === 4, r.calls.map(c => c.name).join(','));
  assert('the cut answer is not in the result', !r.payload.failedParts && Q.countWords(r.payload.result) > 200);
  // groq 120b down, Gemini cut off → the third provider tried (groq gpt-oss-20b) answers
  for (const fr of ['MAX_TOKENS', 'SAFETY']) {
    fresh({ 'groq/openai/gpt-oss-120b': () => ({ status: 500 }), gemini: (c) => ({ text: fakeAnswer(c), finish: fr }), '*': good });
    r = await call({ text: LONG, mode: 'standard' });
    const names = r.calls.map(c => c.name);
    assert(`Gemini ${fr} → next provider`, r.status === 200 && names.includes('gemini/gemini-3.5-flash-lite') && names[names.length - 1] === 'groq/openai/gpt-oss-20b' && !r.payload.failedParts, names.join(','));
  }
  fresh({ groq: (c) => ({ text: textPart(c) }), gemini: good });
  r = await call({ text: LONG, mode: 'standard' });
  assert('near-identical (unparaphrased) answer rejected → next provider', r.status === 200 && r.calls.some(c => c.name.startsWith('gemini')) && r.logs.some(l => /quality gate \(unchanged\)/.test(l)));
  fresh({ groq: (c) => ({ text: 'Here is the paraphrased text:\n\n' + fakeAnswer(c) }), gemini: good });
  r = await call({ text: LONG, mode: 'standard' });
  assert('preamble answer rejected → next provider', r.logs.some(l => /quality gate \(preamble\)/.test(l)) && r.status === 200);
  fresh({ groq: (c) => ({ text: fakeAnswer(c).split(/\n\s*\n/).slice(0, 1).join('') + ' ' + fakeAnswer(c).split(/\n\s*\n/).slice(1).join(' ') }), gemini: good });
  r = await call({ text: LONG, mode: 'standard' });
  assert('merged paragraphs (count mismatch) are re-aligned, not rejected: the first answer is used, 4 paragraphs again', r.status === 200 && r.calls.length === 1 && !r.logs.some(l => /quality gate \(paragraphs\)/.test(l)) && r.payload.result.split(/\n\s*\n/).length === 4, r.calls.map(c => c.name).join(','));
  assert('per-chunk log line has provider, finish, words, change, gate — and no text', r.logs.some(l => /chunk-log \{"seq":\d+,"provider":"[^"]+","ms":\d+,"finish":/.test(l) && /"gate":"ok"/.test(l)) && !r.logs.some(l => /chunk-log.*Sentence number/.test(l)));

  console.log('\n── 5. Split on failure, then a clearly reported failed part ──');
  // every provider fails chunks above 300 words, succeeds on smaller ones → split in half, both halves pass
  const big = Array.from({ length: 2 }, (_, i) => `Part ${i}: ` + sentencePara(300)).join('\n\n');
  fresh({ '*': (c) => ((textPart(c).match(/\S+/g) || []).length > 400 ? { status: 500 } : good(c)) });
  r = await call({ text: big, mode: 'standard' });
  assert('a chunk that fails at full size is split in two and both halves succeed', r.status === 200 && !r.payload.failedParts && r.logs.some(l => /split in two/.test(l)), JSON.stringify(r.payload).slice(0, 160));
  // paragraph 2 always fails everywhere → it keeps its original text AND is reported
  const BAD = 'Paragraph two is the one that never works with any provider at all today, sadly for everyone here.';
  const three = 'Paragraph one is a normal paragraph with enough words to be paraphrased by the model here.\n\n' + BAD + '\n\nParagraph three is also normal and has plenty of words for the paraphrase to work.';
  fresh({ '*': (c) => (c.includes('never works') ? { status: 500 } : good(c)) });
  r = await call({ text: three, mode: 'standard' });
  assert('partial success: 200 with failedParts', r.status === 200 && Array.isArray(r.payload.failedParts) && r.payload.failedParts.length === 1, JSON.stringify(r.payload).slice(0, 300));
  const fp = r.payload.failedParts && r.payload.failedParts[0].text;
  assert('the failed part is the ORIGINAL text of the half that failed twice (incl. the bad paragraph), exactly as it sits in the result',
    fp && fp.includes(BAD) && r.payload.result.includes(fp) && fp.length < three.length, fp);
  assert('the rest is paraphrased; paragraph count and order kept', r.payload.result.split(/\n\s*\n/).length === 3
    && r.payload.result.indexOf(BAD) < r.payload.result.lastIndexOf('three')
    && !r.payload.result.endsWith('Paragraph three is also normal and has plenty of words for the paraphrase to work.'));
  fresh({ '*': () => ({ status: 500 }) });
  r = await call({ text: three, mode: 'standard' });
  assert('nothing paraphrased at all → 503, never the original text as "success"', r.status === 503 && r.payload.success === false);

  console.log('\n── 6. DOCX / PPTX markers survive ──');
  const dx = '<<<1>>> ' + sentencePara(40) + '\n\n<<<2>>> ' + sentencePara(500) + '\n\n<<<3>>> ' + sentencePara(30);
  fresh({ '*': good });
  r = await call({ text: dx, mode: 'standard', prompt: 'Paraphrase each paragraph. POSITION MARKERS: keep every <<<N>>> marker. Text:' });
  const marks = (r.payload.result.match(/<<<\d+>>>/g) || []).join(',');
  assert('DOCX: every marker once, in order; long paragraph 2 rejoined (3 paragraphs)', marks === '<<<1>>>,<<<2>>>,<<<3>>>' && r.payload.result.split(/\n\s*\n/).length === 3, marks + ' / ' + r.payload.result.split(/\n\s*\n/).length);
  assert('DOCX: the continuation note is added only to chunks with an unmarked piece', r.calls.some(c => /continues the marked paragraph/.test(contentOf(c.body))));
  const px = Array.from({ length: 6 }, (_, i) => `[SLIDE${i + 1}_BOX1]` + sentencePara(24) + `[/SLIDE${i + 1}_BOX1]`).join('\n');
  fresh({ '*': good });
  r = await call({ text: px, mode: 'standard', prompt: 'Paraphrase the text inside each tag. Text:' });
  assert('PPTX: every box tag back, in order', (r.payload.result.match(/\[SLIDE\d+_BOX1\]/g) || []).length === 6 && /SLIDE1_BOX1[\s\S]*SLIDE6_BOX1/.test(r.payload.result));
  fresh({ '*': (c) => ({ text: fakeAnswer(c).replace(/\[\/?SLIDE3_BOX1\]/g, '') }) });
  r = await call({ text: px, mode: 'standard', prompt: 'Paraphrase the text inside each tag. Text:' });
  assert('PPTX: an answer that dropped a tag is rejected everywhere → 503 (never a broken deck)', r.status === 503 || (r.payload.failedParts && r.payload.failedParts.length > 0));

  console.log('\n── 7. lib/partial.js (page side) ──');
  P.reset();
  P.add([{ text: BAD }]);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc('Paragraph one changed.\n\n' + BAD + '\n\nParagraph three changed.');
  assert('the unchanged paragraph is wrapped in <mark class="pf-unchanged">', /<mark class="pf-unchanged"[^>]*>Paragraph two is the one/.test(P.markHtml(html, esc)));
  assert('splice replaces exactly that part', P.splice('A\n\n' + BAD + '\n\nC', BAD, 'New two') === 'A\n\nNew two\n\nC' && P.splice('A', BAD, 'x') === null);
  P.remove(0);
  assert('after a successful retry nothing is marked', P.markHtml(html, esc) === html);

  console.log('\n── 8. Hotfix: a different paragraph count is re-aligned, gated answers are not failures ──');
  // the production case: finish=STOP, length ratio ~0.9–1, ~33 % changed — but the model broke/merged paragraphs
  const splitEach = (c) => fakeAnswer(c).split(/\n\s*\n/).map((p) => { const ss = Q.sentences(p); return ss.slice(0, 2).join(' ') + '\n\n' + ss.slice(2).join(' '); }).join('\n\n');
  fresh({ '*': (c) => ({ text: splitEach(c) }) });
  r = await call({ text: LONG, mode: 'standard' });
  let paras = String(r.payload.result || '').split(/\n\s*\n/);
  assert('production case: 4 paragraphs answered as 8 → ACCEPTED from the first provider (no "paragraphs" rejection)', r.status === 200 && r.calls.length === 1 && !r.logs.some(l => /quality gate \(paragraphs\)/.test(l)) && !r.payload.failedParts, r.calls.map(c => c.name).join(','));
  assert('… and re-aligned onto the input: 4 paragraphs, in order', paras.length === 4 && paras.every((p, i) => new RegExp('^(\\[[^\\]]*\\]\\s*)?Paragraph\\w* ' + i + ':').test(p)), paras.map(p => p.slice(0, 24)).join(' | '));
  const merge23 = (c) => { const ps = fakeAnswer(c).split(/\n\s*\n/); return [ps[0], ps[1] + ' ' + ps[2], ps[3]].join('\n\n'); };
  fresh({ '*': (c) => ({ text: merge23(c) }) });
  r = await call({ text: LONG, mode: 'standard' });
  paras = String(r.payload.result || '').split(/\n\s*\n/);
  assert('4 paragraphs answered as 3 (two merged) → accepted and re-aligned to 4', r.status === 200 && r.calls.length === 1 && paras.length === 4 && /^Paragraph\w* 2:/.test(paras[2]), paras.map(p => p.slice(0, 24)).join(' | '));

  // gated answers don't use up the 3-provider limit: 4 unchanged answers, then a good one from the 5th provider
  let n = 0;
  fresh({ '*': (c) => (++n <= 4 ? { text: textPart(c) } : good(c)) });
  r = await call({ text: LONG, mode: 'standard' });
  assert('4 gated answers then a good one → the 5th provider\'s answer is used (gate rejections don\'t count toward the 3)', r.status === 200 && r.calls.length === 5 && !r.payload.failedParts && !r.logs.some(l => /providers tried — stopping/.test(l)), r.calls.map(c => c.name).join(','));
  n = 0;
  fresh({ '*': (c) => (++n <= 3 ? { status: 500 } : good(c)) });
  r = await call({ text: LONG, mode: 'standard' });
  assert('… while 3 real errors still stop the chunk ("3 providers tried — stopping")', r.logs.some(l => /3 providers tried — stopping/.test(l)));

  // every answer gated → the best one (most change, right length and language) instead of the original
  const light = (c, every) => { let k = 0; return textPart(c).replace(/[A-Za-z]{3,}/g, (w) => (k++ % every === 0 ? w + 'ed' : w)); };
  n = 0;
  fresh({ '*': (c) => ({ text: light(c, ++n === 2 ? 8 : 30) }) });
  r = await call({ text: LONG, mode: 'standard' });
  const ch = Q.changeShare(LONG, r.payload.result || '');
  assert('every provider\'s answer gated (too little change) → the best one is returned, not the original', r.status === 200 && !r.payload.failedParts && r.logs.some(l => /every answer was gated — using the best one/.test(l)) && ch > 0.06 && ch < 0.15, ch.toFixed(3));
  assert('… and it is re-aligned to the input\'s 4 paragraphs', String(r.payload.result).split(/\n\s*\n/).length === 4);
  fresh({ '*': () => ({ text: 'Привет, это совсем другой язык и другой текст. '.repeat(30) }) });
  r = await call({ text: LONG, mode: 'standard' });
  assert('no usable answer at all (wrong language everywhere) → the original is kept and reported as a failed part', (r.status !== 200 || (r.payload.failedParts && r.payload.failedParts.length > 0)) && !r.logs.some(l => /using the best one/.test(l)), r.status);

  // re-alignment units
  const DOCX3 = '<<<1>>> ' + sentencePara(36) + '\n\n<<<2>>> ' + sentencePara(36) + '\n\n<<<3>>> ' + sentencePara(36);
  const du3 = Q.segment(DOCX3);
  const docxOut = '<<<1>>> One a. One b. One c.\n\n<<<2>>> Two a. Two b.\n\nTwo c.\n\n<<<3>>> Three a. Three b. Three c.';
  const al = Q.alignOutput(du3, docxOut);
  assert('DOCX: a marked paragraph answered as two paragraphs → re-aligned by marker, each text keeps its <<<N>>>', al && al.length === 3 && al.every((t, i) => t.startsWith('<<<' + (i + 1) + '>>>')) && /Two c\./.test(al[1]), JSON.stringify(al));
  const longMarked = '<<<7>>> ' + sentencePara(800);
  const lu = Q.segment(longMarked);
  const lal = Q.alignOutput(lu, '<<<7>>> ' + sentencePara(800).replace(/explains/g, 'describes'));
  assert('DOCX: a long marked paragraph (split into pieces) answered as one block → spread over its pieces; only the first has the marker', lu.length >= 3 && lal && lal.length === lu.length && lal[0].startsWith('<<<7>>>') && lal.slice(1).every(t => t && !/<<<\d+>>>/.test(t)), lu.length + ' / ' + (lal && lal.length));
  const four = Q.segment([sentencePara(36), sentencePara(36), sentencePara(36), sentencePara(36)].join('\n\n'));
  assert('a real collapse (4 paragraphs → one sentence, nothing to re-align) is still rejected', Q.structure(four, 'one long run on answer with no full stops at all '.repeat(12)).collapsed === true);
  assert('2 of 4 paragraphs, one sentence each (can\'t re-align, but not a collapse) → used as it is', Q.structure(four, 'First half of it all\n\nSecond half of it all').whole === true);
  const pptxIn = '[SLIDE1_BOX1]Title text here[/SLIDE1_BOX1]\n[SLIDE1_BOX2]Body text here[/SLIDE1_BOX2]';
  assert('PPTX: a lost box tag is still a "markers" rejection', Q.gate(pptxIn, '[SLIDE1_BOX1]Heading words[/SLIDE1_BOX1] Body words', { kind: 'paraphrase' }) === 'markers' && Q.structure(Q.segment(pptxIn), '[SLIDE1_BOX1]x[/SLIDE1_BOX1]').collapsed === true);

  console.log('\n── 9. Hotfix: the page retries a failed part silently (3 s, then 8 s) before showing the button ──');
  const waited = [];
  const sleep = async (ms) => { waited.push(ms); };
  P.reset(); P.add([{ text: 'Part A text' }, { text: 'Part B text' }]);
  let tries = [];
  await P.autoRetry(async (i) => { tries.push(P.list()[i].text); return false; }, { sleep });
  assert('default waits are 3 s then 8 s, every failed part tried twice, all still listed after', JSON.stringify(P.AUTO_WAITS) === '[3000,8000]' && JSON.stringify(waited) === '[3000,3000,8000,8000]' && tries.length === 4 && P.list().length === 2 && P.autoRan(), JSON.stringify(waited));
  P.reset(); P.add([{ text: 'Part A text' }, { text: 'Part B text' }]);
  tries = []; waited.length = 0;
  const status = [];
  await P.autoRetry(async (i) => { const t = P.list()[i].text; tries.push(t); if (t === 'Part B text' || tries.length > 2) { P.remove(i); return true; } return false; }, { sleep, onStatus: (k, tot) => status.push(k + '/' + tot) });
  assert('a part that fails its 1st automatic try succeeds on the 2nd; the other on its 1st; nothing left (no button)', P.list().length === 0 && tries.join(',') === 'Part A text,Part B text,Part A text', tries.join(','));
  assert('"Finishing part n…" status for each try', status.join(' ') === '1/2 2/2 1/1', status.join(' '));
  P.reset(); P.add([{ text: 'x y z' }]);
  assert('a new run (reset) makes the automatic tries run again for it', !P.autoRan());
  P.reset();

  console.log('\n── 10. Follow-ups: list/heading markers in the input; gpt-oss-20b only for small chunks ──');
  const item = (i) => `item ${i} explains how learners plan their revision and test themselves every week`;
  const dashIn = 'Revision plan for the term:\n- ' + item(1) + '\n- ' + item(2) + '\n- ' + item(3);
  const starOut = 'Revision plans for this term:\n* ' + item(1).replace(/learners/, 'students').replace(/plan/, 'organise') + '\n* ' + item(2).replace(/revision/, 'study').replace(/every/, 'each') + '\n* ' + item(3).replace(/test/, 'quiz').replace(/week/, 'weekend');
  assert('input with "-" bullets, answer with "*" bullets → not a markdown rejection', Q.gate(dashIn, starOut, { kind: 'paraphrase', mode: 'standard' }) === null, Q.gate(dashIn, starOut, { kind: 'paraphrase', mode: 'standard' }));
  const numIn = '<<<4>>> Steps to follow:\n1. ' + item(1) + '\n2. ' + item(2);
  const numOut = '<<<4>>> Steps worth following:\n* ' + item(1).replace(/learners/, 'students').replace(/plan/, 'map out').replace(/every/, 'each') + '\n* ' + item(2).replace(/revision/, 'study').replace(/test/, 'quiz').replace(/week/, 'weekend');
  assert('DOCX: "<<<4>>> … 1. 2." numbered input, answer with "*" bullets → not rejected (markers are ignored when looking for a list)', Q.gate(numIn, numOut, { kind: 'paraphrase', mode: 'standard' }) === null, Q.gate(numIn, numOut, { kind: 'paraphrase', mode: 'standard' }));
  const headIn = '# Week one\n' + item(1) + '. ' + item(2) + '.';
  assert('input with a "#" heading, answer keeps a "##" heading → not rejected', Q.gate(headIn, '## Week one\n' + starOut.split('\n').slice(1).join(' ').replace(/\* /g, ''), { kind: 'paraphrase', mode: 'standard' }) === null);
  const proseIn = item(1) + '. ' + item(2) + '. ' + item(3) + '.';
  assert('plain prose input, answer adds "*" bullets or a "##" heading → still a markdown rejection', Q.gate(proseIn, starOut, { kind: 'paraphrase', mode: 'standard' }) === 'markdown' && Q.gate(proseIn, '## Plan\n' + starOut.split('\n').slice(1).join(' '), { kind: 'paraphrase', mode: 'standard' }) === 'markdown');
  assert('a list input still rejects **bold** the input didn\'t have', Q.gate(dashIn, starOut.replace('Revision plans', '**Revision plans**'), { kind: 'paraphrase', mode: 'standard' }) === 'markdown');

  // the production shape (request 49wld…, 940 words through gpt-oss-120b): bulleted lists in the input, the model
  // answers with its own "*" bullets → accepted from the first provider
  const listPara = (k) => `Section ${k} has these points:\n` + Array.from({ length: 6 }, (_, i) => `- Point ${k}.${i} covers a separate idea about learning, memory and planning for exams.`).join('\n');
  const LIST940 = Array.from({ length: 12 }, (_, k) => (k % 2 ? listPara(k) : `Paragraph ${k}: ` + sentencePara(60))).join('\n\n');
  const toStars = (c) => fakeAnswer(c).replace(/^- /gm, '* ');
  fresh({ '*': (c) => ({ text: toStars(c) }) });
  r = await call({ text: LIST940, mode: 'standard' });
  assert(`~940-word input with "-" lists (${Q.countWords(LIST940)} words), the model answers with "*" bullets → the first answer is accepted, no markdown rejection`, r.status === 200 && r.calls.length === 1 && !r.logs.some(l => /quality gate \(markdown\)/.test(l)) && !r.payload.failedParts && /^\* Point/m.test(r.payload.result), r.calls.map(c => c.name).join(','));

  // gpt-oss-20b gets no chunk over 400 words, but still takes small ones
  fresh({ 'groq/openai/gpt-oss-120b': () => ({ status: 500 }), gemini: () => ({ status: 500 }), '*': good });
  r = await call({ text: LIST940, mode: 'standard' });
  assert('a chunk over 400 words is never sent to gpt-oss-20b (skipped with a log line)', r.status === 200 && !r.calls.some(c => /gpt-oss-20b/.test(c.name) && c.words > 400) && r.logs.some(l => /gpt-oss-20b \[small chunks only/.test(l)), r.calls.map(c => c.name + ':' + c.words).join(','));
  fresh({ 'groq/openai/gpt-oss-20b': good, '*': () => ({ status: 429, body: { error: { message: 'rate limit (test)' } } }) });
  r = await call({ text: sentencePara(200), mode: 'standard' });
  assert('… while a 200-word chunk still goes to gpt-oss-20b when the providers before it are rate-limited', r.status === 200 && r.calls.some(c => /gpt-oss-20b/.test(c.name)) && !r.payload.failedParts, r.calls.map(c => c.name).join(','));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
