'use strict';
// GA4 custom events — lib/tool-events.js + the REAL index.html tool functions (summarize,
// checkGrammar, humanize, paraphrase, detectAI, handleFileUpload, downloadOutput) extracted
// from the page source and run in a sandbox. window.gtag is MOCKED (records every call) and
// /api/process is MOCKED (success, 503 all-busy, 504 timeout, 500, 429, network error).
// No network access at all. Browser-level flows (cv-builder, code.html) are in ga-events.spec.ts.
// Run: node tests/ga-events.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PFProtect = require('../lib/protect.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = path.join(__dirname, '..');
const LIB = fs.readFileSync(path.join(ROOT, 'lib', 'tool-events.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── Extract named functions from index.html (same scanner as protect-links.test.js) ──
function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  if (!m) throw new Error('function not found: ' + name);
  let i = HTML.indexOf('{', HTML.indexOf(')', m.index + m[0].length));
  let depth = 0, prevSig = '{';
  for (; i < HTML.length; i++) {
    const c = HTML[i], n = HTML[i + 1];
    if (c === '/' && n === '/') { i = HTML.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = HTML.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") { for (i++; HTML[i] !== c; i++) if (HTML[i] === '\\') i++; prevSig = c; continue; }
    if (c === '`') { i = skipTemplate(i); prevSig = '`'; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig)) {
      let inClass = false;
      for (i++; ; i++) {
        const ch = HTML[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') inClass = true; else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      prevSig = '/'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return HTML.slice(m.index, i + 1); }
    if (!/\s/.test(c)) prevSig = c;
  }
  throw new Error('unbalanced: ' + name);
  function skipTemplate(start) {
    for (let j = start + 1; j < HTML.length; j++) {
      if (HTML[j] === '\\') { j++; continue; }
      if (HTML[j] === '`') return j;
      if (HTML[j] === '$' && HTML[j + 1] === '{') {
        let d = 1; j += 2;
        for (; d > 0; j++) {
          if (HTML[j] === '`') j = skipTemplate(j);
          else if (HTML[j] === '{') d++;
          else if (HTML[j] === '}') d--;
        }
        j--;
      }
    }
    throw new Error('unterminated template');
  }
}
const constVal = (name) => Number((HTML.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)')) || [])[1]);

const FUNCS = [
  'runAPIChain', 'gaInputType', 'gaToolUsed', 'gaToolError', 'gaDownload',
  'summarize', 'checkGrammar', 'renderGrammarOutput', 'humanize', 'paraphrase', 'detectAI',
  'calculateAIScore', 'calculateMetrics', 'handleFileUpload', 'downloadOutput',
  'buildFrontendBatches', 'processParaphraseOutput', 'parseStructuredOutput', 'countWords', 'cleanMarkdown',
  'escapeHtml', 'stripMarkdown',
];

// ── Mocked /api/process ──
const RESPONSES = {
  ok:        (body) => ({ ok: true, status: 200, json: async () => ({ success: true, result: 'Rewritten: ' + body.text, usedApi: 'mock' }) }),
  busy:      () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'high_demand', message: 'Our AI is at high demand right now.' }) }),
  timeout:   () => ({ ok: false, status: 504, json: async () => { throw new SyntaxError('Unexpected token A in JSON'); } }),
  server:    () => ({ ok: false, status: 500, json: async () => ({ error: 'Server error', message: 'boom' }) }),
  ratelimit: () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many requests', message: 'Rate limit reached.' }) }),
  network:   () => { throw new TypeError('Failed to fetch'); },
};

function makeSandbox(apiMode = 'ok', opts = {}) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, className: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, click() {},
  });
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    _gtag: [], _requests: [], _statuses: [],
    PFProtect, JSON, Math, Set, Map, Array, Object, String, Number, RegExp, Promise, parseInt, Date, Error, TypeError, SyntaxError,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    document: {
      getElementById: el, createElement: () => el('_a' + Math.random()),
      body: { appendChild() {}, removeChild() {} }, querySelectorAll: () => [],
    },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    BACKEND_URL: '/api/process', PREVIEW_CHARS: 1e9,
    BATCH_SPLIT_THRESHOLD: constVal('BATCH_SPLIT_THRESHOLD'), BATCH_TARGET_WORDS: constVal('BATCH_TARGET_WORDS'),
    MODE_PROMPTS: { standard: 'PARAPHRASE PROMPT' }, HUMANIZE_PROMPTS: { natural: 'HUMANIZE PROMPT' },
    currentMode: 'standard', currentHMode: 'natural', currentTool: 'paraphrase',
    isLoading: false, apiLabelLocked: false, _userHasEdited: false, showChangesActive: false,
    fullOutputText: '', fullOutputHTML: '',
    docxOriginalXml: '', docxZip: null, originalDocxName: '', pptxMode: false, pptxData: null,
    _pfLastApiError: 'other', _pfInputType: 'text',
    getLang: () => 'english', langSuffix: () => '',
    showStatus: (m, t) => ctx._statuses.push([t, m]), hideStatus() {}, setLoading() {}, setToolLoading() {},
    resetApiDots() {}, applyApiStatuses() {}, showDownloadBtn() {}, showHumanScore() {}, showDonateNote() {},
    enableEditing() {}, showScorePanel() {}, estimateAIScore: () => 50, renderDetectorResult() {}, showAIBanner() {},
    renderOutput: (content) => { ctx.fullOutputText = content; },
    handlePPTXUpload: async () => {},
    fetch: async (url, o) => {
      if (url !== '/api/process') throw new Error('UNMOCKED URL — refusing network call: ' + url);
      const body = JSON.parse(o.body);
      ctx._requests.push(body);
      return RESPONSES[apiMode](body);
    },
  };
  if (!opts.noGtag) ctx.gtag = (...a) => { if (opts.throwingGtag) throw new Error('GA blew up'); ctx._gtag.push(a); };
  ctx.window = ctx;
  ctx.inputEl = el('inputText');
  vm.createContext(ctx);
  vm.runInContext(LIB, ctx);
  vm.runInContext(FUNCS.map(extractFn).join('\n\n'), ctx);
  return ctx;
}
const events = (ctx) => ctx._gtag.map(a => [a[0], a[1], a[2]]);
const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => w + i).join(' ');

(async () => {
  console.log('\n── 1. lib/tool-events.js: whitelist, buckets, guards ──');
  {
    const ctx = makeSandbox();
    const E = ctx.PFEvents;
    for (const [n, b] of [[0, '<300'], [299, '<300'], [300, '300-1000'], [999, '300-1000'], [1000, '1000-3000'], [2999, '1000-3000'], [3000, '3000+'], [50000, '3000+']])
      assert(`wordBucket(${n}) = ${b}`, E.wordBucket(n) === b, E.wordBucket(n));
    assert('toolName maps detect → ai_detect', E.toolName('detect') === 'ai_detect');
    assert('toolName rejects unknown ids (the AI tab "ai")', E.toolName('ai') === null);
    assert('errorTypeFromStatus: 503 → all_busy, 504 → timeout, 500/429/0 → other',
      E.errorTypeFromStatus(503) === 'all_busy' && E.errorTypeFromStatus(504) === 'timeout' &&
      ['other', 'other', 'other'].every((v, i) => E.errorTypeFromStatus([500, 429, 0][i]) === v));

    ctx._gtag.length = 0;
    E.send('tool_used', { tool: 'paraphrase', input_type: 'text', word_bucket: '<300', text: 'SECRET user text', file_name: 'me.docx' });
    assert('extra params (text, file_name) are stripped', eq(events(ctx), [['event', 'tool_used', { tool: 'paraphrase', input_type: 'text', word_bucket: '<300' }]]), JSON.stringify(events(ctx)));

    ctx._gtag.length = 0;
    E.send('tool_used', { tool: 'Paraphrase this: my essay', input_type: 'text', word_bucket: '<300' });
    E.toolError('paraphrase', 'Rate limit reached for user@example.com');
    E.resultDownload('paraphrase', 'my-thesis.docx');
    E.cvDownload('John Smith', 'pdf');
    E.cvDownload('classic', 'png');
    E.send('page_text', { text: 'hello' });
    assert('values outside the fixed lists are never sent (whole event dropped)', ctx._gtag.length === 0, JSON.stringify(events(ctx)));

    ctx._gtag.length = 0;
    E.cvDownload('modern-blue', 'pdf'); E.jobSearch(1); E.jobSearch(0);
    assert('cv_download sends a slug template id; job_search sends only has_results (boolean)',
      eq(events(ctx), [['event', 'cv_download', { template: 'modern-blue', format: 'pdf' }],
                       ['event', 'job_search', { has_results: true }], ['event', 'job_search', { has_results: false }]]), JSON.stringify(events(ctx)));

    const noGa = makeSandbox('ok', { noGtag: true });
    let threw = null; try { noGa.PFEvents.toolUsed('paraphrase', 'text', 10); } catch (e) { threw = e; }
    assert('no gtag (GA blocked) → no error', threw === null, threw);
    const badGa = makeSandbox('ok', { throwingGtag: true });
    threw = null; try { badGa.PFEvents.toolUsed('paraphrase', 'text', 10); } catch (e) { threw = e; }
    assert('gtag that throws → swallowed', threw === null, threw);
  }

  console.log('\n── 2. tool_used on SUCCESSFUL results (not on click) ──');
  {
    const text = 'SECRET-PHRASE alice@example.com ' + words(40);
    const cases = [
      ['summarize', 'summarize', 'summarize', ctx => ctx.summarize()],
      ['grammar', 'checkGrammar', 'grammar', ctx => ctx.checkGrammar()],
      ['humanize', 'humanize', 'humanize', ctx => ctx.humanize()],
      ['paraphrase', 'paraphrase', 'paraphrase', ctx => ctx.paraphrase()],
    ];
    for (const [tool, fn, cur, run] of cases) {
      const ctx = makeSandbox('ok');
      ctx.currentTool = cur;
      ctx.inputEl.value = text;
      await run(ctx);
      assert(`${fn}() success → tool_used {tool:${tool}, input_type:text, word_bucket:<300}`,
        eq(events(ctx), [['event', 'tool_used', { tool, input_type: 'text', word_bucket: '<300' }]]), JSON.stringify(events(ctx)));
    }
    const ctx = makeSandbox('ok');
    ctx.currentTool = 'detect'; ctx.inputEl.value = text;
    ctx.detectAI();
    assert('detectAI() (local) → tool_used {tool:ai_detect}', eq(events(ctx), [['event', 'tool_used', { tool: 'ai_detect', input_type: 'text', word_bucket: '<300' }]]), JSON.stringify(events(ctx)));

    const big = makeSandbox('ok');
    big.inputEl.value = words(1200);
    await big.paraphrase();
    assert('1200-word paraphrase → word_bucket 1000-3000', big._gtag.length === 1 && big._gtag[0][2].word_bucket === '1000-3000', JSON.stringify(events(big)));

    const nothing = makeSandbox('ok');
    nothing.inputEl.value = '';
    await nothing.paraphrase(); await nothing.summarize();
    assert('empty input (validation message) → no event', nothing._gtag.length === 0, JSON.stringify(events(nothing)));
  }

  console.log('\n── 3. tool_error with error_type ──');
  for (const [mode, type] of [['busy', 'all_busy'], ['timeout', 'timeout'], ['server', 'other'], ['ratelimit', 'other'], ['network', 'other']]) {
    for (const [tool, cur, call] of [['paraphrase', 'paraphrase', 'paraphrase'], ['summarize', 'summarize', 'summarize'],
                                     ['grammar', 'grammar', 'checkGrammar'], ['humanize', 'humanize', 'humanize']]) {
      const ctx = makeSandbox(mode);
      ctx.currentTool = cur; ctx.inputEl.value = words(30);
      await ctx[call]();
      assert(`${call}() with ${mode} response → tool_error {tool:${tool}, error_type:${type}}`,
        eq(events(ctx), [['event', 'tool_error', { tool, error_type: type }]]), JSON.stringify(events(ctx)));
    }
  }
  {
    const ctx = makeSandbox('busy');
    ctx.inputEl.value = words(30);
    await ctx.paraphrase();
    const shown = ctx._statuses.filter(s => s[0] === 'error').map(s => s[1]).pop();
    assert('"All AI engines are busy" message ↔ error_type all_busy', /All AI engines are busy/.test(shown) && ctx._gtag[0][2].error_type === 'all_busy', shown);
  }

  console.log('\n── 4. input_type + file_error from uploads ──');
  {
    const ctx = makeSandbox('ok');
    ctx.currentTool = 'summarize';
    const secretName = 'Alice-Private-Thesis.txt';
    await ctx.handleFileUpload({ target: { files: [{ name: secretName, text: async () => words(350) }] } });
    assert('.txt upload records input_type txt', ctx._pfInputType === 'txt');
    await ctx.summarize();
    assert('summarize after .txt upload → input_type txt, word_bucket 300-1000',
      eq(events(ctx), [['event', 'tool_used', { tool: 'summarize', input_type: 'txt', word_bucket: '300-1000' }]]), JSON.stringify(events(ctx)));

    ctx._gtag.length = 0;
    await ctx.handleFileUpload({ target: { files: [{ name: 'Alice-Private-Notes.xyz', text: async () => 'x' }] } });
    assert('unsupported file → tool_error {tool:summarize, error_type:file_error}',
      eq(events(ctx), [['event', 'tool_error', { tool: 'summarize', error_type: 'file_error' }]]), JSON.stringify(events(ctx)));

    ctx._gtag.length = 0; ctx.currentTool = 'detect';
    await ctx.handleFileUpload({ target: { files: [{ name: 'broken.pdf', arrayBuffer: async () => { throw new Error('bad'); } }] } });
    assert('unreadable PDF → tool_error {tool:ai_detect, error_type:file_error}',
      ctx._gtag.length >= 1 && eq(ctx._gtag[ctx._gtag.length - 1][2], { tool: 'ai_detect', error_type: 'file_error' }), JSON.stringify(events(ctx)));

    const t = makeSandbox('ok');
    assert('gaInputType: pptxMode → pptx', (t.pptxMode = true, t.pptxData = {}, t.gaInputType()) === 'pptx');
    t.pptxMode = false; t.docxOriginalXml = '<w:document/>';
    assert('gaInputType: DOCX loaded → docx', t.gaInputType() === 'docx');
    t.docxOriginalXml = ''; t._pfInputType = 'pdf';
    assert('gaInputType: otherwise the recorded upload type', t.gaInputType() === 'pdf');
  }

  console.log('\n── 5. result_download ──');
  {
    const ctx = makeSandbox('ok');
    ctx.currentTool = 'humanize'; ctx.fullOutputText = 'Some humanized result.';
    ctx.document.getElementById('outputText').contentEditable = 'false';
    await ctx.downloadOutput();
    assert('downloadOutput() → result_download {tool:humanize, format:txt}',
      eq(events(ctx), [['event', 'result_download', { tool: 'humanize', format: 'txt' }]]), JSON.stringify(events(ctx)));
    ctx._gtag.length = 0; ctx.fullOutputText = '';
    await ctx.downloadOutput();
    assert('nothing to download → no event', ctx._gtag.length === 0);
    ctx.currentTool = 'grammar';
    ctx.gaDownload('pdf'); ctx.gaDownload('pptx', 'ai_chat');
    assert('gaDownload uses the current tool unless one is given',
      eq(events(ctx), [['event', 'result_download', { tool: 'grammar', format: 'pdf' }], ['event', 'result_download', { tool: 'ai_chat', format: 'pptx' }]]), JSON.stringify(events(ctx)));
  }

  console.log('\n── 6. Privacy: nothing user-supplied ever reaches gtag ──');
  {
    const all = [];
    const secret = 'SECRET-PHRASE alice@example.com Alice Smith';
    for (const mode of Object.keys(RESPONSES)) {
      for (const call of ['paraphrase', 'summarize', 'checkGrammar', 'humanize']) {
        const ctx = makeSandbox(mode);
        ctx.inputEl.value = secret + ' ' + words(25);
        await ctx[call]();
        all.push(...ctx._gtag);
      }
    }
    const blob = JSON.stringify(all);
    assert(`no user text / email / name in ${all.length} recorded gtag calls`, !/SECRET|alice|Smith|word\d/i.test(blob), blob.slice(0, 300));
    const allowed = { tool_used: ['tool', 'input_type', 'word_bucket'], tool_error: ['tool', 'error_type'] };
    assert('every call carries exactly the allowed keys', all.every(a => a[0] === 'event' && eq(Object.keys(a[2]), allowed[a[1]])), blob.slice(0, 300));
  }

  console.log('\n── 7. Pages: script included, donate_click untouched, no raw gtag events ──');
  {
    for (const f of ['index.html', 'cv-builder.html', 'code.html']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert(`${f} loads /lib/tool-events.js`, src.includes('<script src="/lib/tool-events.js"></script>'));
      const raw = [...src.matchAll(/gtag\('event',\s*'([a-z_]+)'/g)].map(m => m[1]);
      assert(`${f}: the only direct gtag('event') calls are donate_click`, raw.every(n => n === 'donate_click'), raw.join(','));
      const lines = src.split('\n').filter(l => /PFEvents\.\w+\(/.test(l));
      const unguarded = lines.filter(l => !/window\.PFEvents\)/.test(l));
      assert(`${f}: every line calling PFEvents is guarded by window.PFEvents (${lines.length} lines)`, lines.length > 0 && unguarded.length === 0, unguarded.join('\n'));
    }
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert('index.html still has all 4 donate_click links', (idx.match(/gtag\('event','donate_click'/g) || []).length === 4);
    const cv = fs.readFileSync(path.join(ROOT, 'cv-builder.html'), 'utf8');
    const js = cv.slice(cv.indexOf('async function runJobSearch('), cv.indexOf('function _cleanSnippet('));
    assert('job_search never passes the title/location', !/jobSearch\([^)]*(jobTitle|location)/.test(js) && (js.match(/PFEvents\.jobSearch\((true|false)\)/g) || []).length === 3);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
