'use strict';
// PPTX: a text box whose text comes back unchanged must keep its XML byte-identical.
// Uses the fixture tests/fixtures/keep-unchanged.pptx and the REAL index.html functions
// (handlePPTXUpload → paraphrasePPTX → downloadPPTX → modifyTextBox) in a sandbox.
// /api/process is MOCKED: the fake AI rewrites slide 1's body box only and returns the
// other boxes unchanged. No network access.
// Run: node tests/pptx-keep-unchanged.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JSZip = require('jszip');

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

const FUNCS = ['handlePPTXUpload', 'extractSpTextBoxes', 'isPptxTitlePlaceholder', 'pptxDecodeXml', 'pptxEncodeXml',
  'paraphrasePPTX', 'stripMarkdown', 'downloadPPTX', 'modifyTextBox', 'runAPIChain', 'countWords'];

const FIXTURE = path.join(__dirname, 'fixtures', 'keep-unchanged.pptx');

function makeSandbox() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {} }, click() {} });
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx._errors.push(a.join(' ')) },
    _errors: [], _alerts: [], _requests: [], _download: null,
    JSZip, JSON, Math, Set, Map, Array, Object, String, Number, RegExp, Promise, parseInt,
    setTimeout: (fn) => { fn(); return 0; },
    alert: (m) => ctx._alerts.push(m),
    document: { getElementById: el, createElement: () => el('_a' + Math.random()), body: { appendChild() {}, removeChild() {} } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    BACKEND_URL: '/api/process', MODE_PROMPTS: { standard: 'PARAPHRASE PROMPT' },
    currentMode: 'standard', currentTool: 'paraphrase', apiLabelLocked: false, pptxMode: false, pptxData: null,
    getLang: () => 'english',
    showStatus() {}, hideStatus() {}, setLoading() {}, resetApiDots() {}, applyApiStatuses() {}, renderOutput() {},
    showDownloadBtn() {}, showPptxOverlay() {}, hidePptxOverlay() {}, setDlBtnLoading() {}, restoreDlBtn() {},
    fetch: async (url, opts) => {
      if (url !== '/api/process') throw new Error('UNMOCKED URL — refusing network call: ' + url);
      const body = JSON.parse(opts.body);
      ctx._requests.push(body);
      // Rewrite SLIDE1's body box only; every other tagged box comes back exactly as sent.
      const result = body.text.replace(/\[(SLIDE1_BOX2)\]([\s\S]*?)\[\/\1\]/, (m, tag, t) => `[${tag}]${t.toUpperCase()}[/${tag}]`);
      return { ok: true, status: 200, json: async () => ({ success: true, result, usedApi: 'mock' }) };
    },
  };
  ctx.window = ctx;
  ctx.inputEl = el('inputText');
  vm.createContext(ctx);
  vm.runInContext(FUNCS.map(extractFn).join('\n\n'), ctx);
  return ctx;
}

const spList = (xml) => xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g) || [];

(async () => {
  const fixtureBuf = fs.readFileSync(FIXTURE);
  const orig = await JSZip.loadAsync(fixtureBuf);
  const origSlide = async (n) => orig.file(`ppt/slides/slide${n}.xml`).async('string');

  const ctx = makeSandbox();
  await ctx.handlePPTXUpload({ arrayBuffer: async () => fixtureBuf });
  assert('fixture loaded into pptxData (3 slides)', ctx.pptxMode && ctx.pptxData && ctx.pptxData.slides.length === 3);

  await ctx.paraphrasePPTX();
  assert('mock AI was called (no network)', ctx._requests.length === 1);

  // downloadPPTX asks JSZip for a browser Blob — produce a node Buffer instead and keep it.
  const zip = ctx.pptxData.zip;
  const gen = zip.generateAsync.bind(zip);
  zip.generateAsync = async (opts) => (ctx._download = await gen({ ...opts, type: 'nodebuffer' }));
  await ctx.downloadPPTX();
  assert('download succeeded', ctx._download && ctx._alerts.length === 0, ctx._alerts.join(' | '));

  const out = await JSZip.loadAsync(ctx._download);
  const outSlide = async (n) => out.file(`ppt/slides/slide${n}.xml`).async('string');

  console.log('\n── Unchanged boxes keep their XML ──');
  assert('slide 2 (formatting + hyperlink, text unchanged) byte-identical', await outSlide(2) === await origSlide(2));
  assert('slide 3 (references, text unchanged) byte-identical', await outSlide(3) === await origSlide(3));
  const s2 = await outSlide(2);
  assert('slide 2 hyperlink run + colours intact', s2.includes('<a:hlinkClick r:id="rId2"/>') && s2.includes('C00000') && s2.includes('<a:noAutofit/>'));
  assert('slide 2 rels (hyperlink target) byte-identical',
    await out.file('ppt/slides/_rels/slide2.xml.rels').async('string') === await orig.file('ppt/slides/_rels/slide2.xml.rels').async('string'));

  console.log('\n── Changed boxes are still rewritten ──');
  const [o1, n1] = [spList(await origSlide(1)), spList(await outSlide(1))];
  assert('slide 1 title box untouched', n1[0] === o1[0]);
  assert('slide 1 body box rewritten with the new text', n1[1] !== o1[1] && n1[1].includes('REVENUE GREW STRONGLY'), n1[1]);
  assert('slide 1 body keeps first run formatting (bold rPr)', /<a:rPr lang="en-GB" b="1"\/>/.test(n1[1]));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
