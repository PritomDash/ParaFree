'use strict';
// DOCX "&" double-escaping (&amp;amp;) regression test.
// Runs the REAL index.html paraphrase() → downloadAsDOCX() path in a sandbox with
// /api/process MOCKED (no network). DOCX text is extracted still XML-escaped ("R&amp;D"),
// so the downloaded XML must contain a single &amp; per "&" — never &amp;amp;.
// Run: node tests/docx-amp.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); failed++; }
}

// ── Extract named functions from index.html (strings/templates/comments/regex skipped) ──
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  if (!m) throw new Error('function not found: ' + name);
  let i = HTML.indexOf('{', HTML.indexOf(')', m.index + m[0].length));
  let depth = 0, prevSig = '{';
  const skipTemplate = (start) => {
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
  };
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
}
const constVal = (name) => Number((HTML.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)')) || [])[1]);

const FUNCS = ['paraphrase', 'runAPIChain', 'buildFrontendBatches', 'processParaphraseOutput', 'parseStructuredOutput',
  'countWords', 'stripDocxRevisionMarks', 'extractBodyParasWithPos', 'docxSkip', 'isDocxHeading', 'isSubstantialPara',
  'docxReplaceParasAbsolute', 'downloadAsDOCX', 'stripMarkdown', 'pptxEncodeXml', 'pptxDecodeXml'];

// aiMode 'escaped': the model echoes the XML-escaped text it was sent ("R&amp;D").
// aiMode 'raw':     the model "helpfully" unescapes it ("R&D").
function makeSandbox(aiMode) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {} }, click() {} });
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    _requests: [], _savedXml: null,
    JSON, Math, Set, Map, Array, Object, String, Number, RegExp, Promise, parseInt,
    setTimeout: (fn) => { fn(); return 0; },
    document: { getElementById: el, createElement: () => el('_a' + Math.random()), body: { appendChild() {}, removeChild() {} } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    BACKEND_URL: '/api/process',
    BATCH_SPLIT_THRESHOLD: constVal('BATCH_SPLIT_THRESHOLD'), BATCH_TARGET_WORDS: constVal('BATCH_TARGET_WORDS'),
    MODE_PROMPTS: { standard: 'PARAPHRASE PROMPT' }, currentMode: 'standard', currentTool: 'paraphrase',
    isLoading: false, apiLabelLocked: false, _userHasEdited: false, fullOutputText: '',
    docxOriginalXml: '', docxZip: null, originalDocxName: 'amp.docx', pptxMode: false, pptxData: null,
    getLang: () => 'english',
    showStatus() {}, hideStatus() {}, setLoading() {}, resetApiDots() {}, applyApiStatuses() {},
    showDownloadBtn() {}, showHumanScore() {}, showDonateNote() {}, setDlBtnLoading() {}, restoreDlBtn() {},
    renderOutput(c) { ctx.fullOutputText = c; }, getCurrentOutputText: () => 'x',
    fetch: async (url, opts) => {
      if (url !== '/api/process') throw new Error('UNMOCKED URL — refusing network call: ' + url);
      const body = JSON.parse(opts.body);
      ctx._requests.push(body);
      // "Paraphrase": prefix each marker's paragraph with "Rewritten:" and keep the rest.
      let result = body.text.replace(/<<<(\d+)>>> /g, '<<<$1>>> Rewritten: ');
      if (aiMode === 'raw') result = result.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return { ok: true, status: 200, json: async () => ({ success: true, result, usedApi: 'mock' }) };
    },
  };
  ctx.window = ctx;
  ctx.inputEl = el('inputText');
  vm.createContext(ctx);
  vm.runInContext(FUNCS.map(extractFn).join('\n\n'), ctx);
  return ctx;
}

const P = (t) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const CASES = [
  ['R&D',          'Our R&amp;D team ships a new prototype every quarter for the clinic.', 'R&amp;D'],
  ['Q&A',          'The Q&amp;A session after the talk ran for almost a full hour today.', 'Q&amp;A'],
  ['a && b',       'The check passes only when a &amp;&amp; b are both true in the code.', 'a &amp;&amp; b'],
  ['URL ?a=1&b=2', 'Full results are at https://example.com/search?a=1&amp;b=2 for every reader.', 'https://example.com/search?a=1&amp;b=2'],
];
const XML = '<?xml version="1.0"?><w:document><w:body>' + CASES.map(c => P(c[1])).join('') + '<w:sectPr/></w:body></w:document>';
const paraList = (xml) => xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];

(async () => {
  for (const mode of ['escaped', 'raw']) {
    console.log(`\n── AI returns ${mode === 'escaped' ? 'the escaped text it was sent (&amp;)' : 'unescaped text (&)'} ──`);
    const ctx = makeSandbox(mode);
    ctx.docxOriginalXml = XML;
    ctx.docxZip = { file: (name, content) => { if (content !== undefined) ctx._savedXml = content; }, generateAsync: async () => 'blob' };
    ctx.inputEl.value = 'docx preview';
    await ctx.paraphrase();
    await ctx.downloadAsDOCX();
    const out = ctx._savedXml || '';
    const paras = paraList(out);
    assert('download produced document.xml', paras.length === CASES.length, paras.length);
    assert('no &amp;amp; anywhere in the XML', !out.includes('&amp;amp;'), out.match(/.{0,30}&amp;amp;.{0,30}/));
    CASES.forEach(([label, , expected], i) => {
      assert(`${label}: single &amp; ("${expected}") and paragraph was rewritten`,
        paras[i] && paras[i].includes(expected) && paras[i].includes('Rewritten:'), paras[i]);
    });
    assert('no bare "&" (XML stays well-formed)', !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(out));
    assert('run formatting kept (bold rPr)', paras.every(p => p.includes('<w:b/>')));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
