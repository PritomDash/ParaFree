'use strict';
// Link / citation / reference protection — lib/protect.js + the REAL index.html
// functions (runAPIChain, paraphrase, humanize, checkGrammar, DOCX extract/replace/
// download, paraphrasePPTX) extracted from the page source and run in a sandbox.
// /api/process is MOCKED: a fake AI that rewrites words (UPPERCASES them) but keeps
// placeholders, and a fake AI that drops a placeholder. No network access at all.
// Run: node tests/protect-links.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PFProtect = require('../lib/protect.js');

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

// ── Extract named functions from index.html (small JS scanner: strings, templates,
//    comments and regex literals are skipped so braces inside them don't count) ──
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  if (!m) throw new Error('function not found: ' + name);
  let i = HTML.indexOf(')', m.index + m[0].length) ;
  i = HTML.indexOf('{', i);
  let depth = 0, prevSig = '{';
  const tplStack = [];
  for (; i < HTML.length; i++) {
    const c = HTML[i], n = HTML[i + 1];
    if (c === '/' && n === '/') { i = HTML.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = HTML.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") {
      for (i++; HTML[i] !== c; i++) if (HTML[i] === '\\') i++;
      prevSig = c; continue;
    }
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
  'runAPIChain', 'paraphrase', 'humanize', 'checkGrammar', 'renderGrammarOutput', 'escapeHtml',
  'buildFrontendBatches', 'processParaphraseOutput', 'parseStructuredOutput', 'countWords', 'cleanMarkdown',
  'stripDocxRevisionMarks', 'extractBodyParasWithPos', 'docxSkip', 'isDocxHeading', 'isSubstantialPara',
  'docxReplaceParasAbsolute', 'downloadAsDOCX', 'stripMarkdown', 'pptxEncodeXml', 'pptxDecodeXml',
  'paraphrasePPTX', 'extractSpTextBoxes', 'isPptxTitlePlaceholder',
];

// ── Sandbox ──
function makeSandbox(aiMode) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, className: '', style: {},
    classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {}, click() {},
  });
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx._errors.push(a.join(' ')) },
    _errors: [], _requests: [], _statuses: [], _rendered: null, _savedXml: null,
    PFProtect, JSON, Math, Set, Map, Array, Object, String, Number, RegExp, Promise, parseInt, Date,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    document: {
      getElementById: el, createElement: () => el('_a' + Math.random()),
      body: { appendChild() {}, removeChild() {} }, querySelectorAll: () => [],
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    BACKEND_URL: '/api/process', PREVIEW_CHARS: 1e9,
    BATCH_SPLIT_THRESHOLD: constVal('BATCH_SPLIT_THRESHOLD'), BATCH_TARGET_WORDS: constVal('BATCH_TARGET_WORDS'),
    MODE_PROMPTS: { standard: 'PARAPHRASE PROMPT' }, HUMANIZE_PROMPTS: { natural: 'HUMANIZE PROMPT' },
    currentMode: 'standard', currentHMode: 'natural', currentTool: 'paraphrase',
    isLoading: false, apiLabelLocked: false, _userHasEdited: false,
    fullOutputText: '', fullOutputHTML: '',
    docxOriginalXml: '', docxZip: null, originalDocxName: 'test.docx', pptxMode: false, pptxData: null,
    getLang: () => 'english', langSuffix: () => '',
    showStatus: (m, t) => ctx._statuses.push([t, m]), hideStatus() {}, setLoading() {}, setToolLoading() {},
    resetApiDots() {}, applyApiStatuses() {}, showDownloadBtn() {}, showHumanScore() {}, showDonateNote() {},
    enableEditing() {}, showScorePanel() {}, estimateAIScore: () => 50, naturalnessOf: () => ({ value: 50, level: 'some', label: 'Some AI-style patterns', detail: '' }), setDlBtnLoading() {}, restoreDlBtn() {},
    getCurrentOutputText: () => 'x',
    renderOutput: (content) => { ctx._rendered = content; ctx.fullOutputText = content; },
    fetch: async (url, opts) => {
      if (url !== '/api/process') throw new Error('UNMOCKED URL — refusing network call: ' + url);
      const body = JSON.parse(opts.body);
      ctx._requests.push(body);
      return { ok: true, status: 200, json: async () => ({ success: true, result: fakeAI(body, aiMode), usedApi: 'mock' }) };
    },
  };
  ctx.window = ctx;
  // GA4 events are stubbed here — they're covered by tests/ga-events.test.js and ga-events.spec.ts
  Object.assign(ctx, { gaToolUsed() {}, gaToolError() {}, gaDownload() {}, _pfLastApiError: 'other' });
  ctx.inputEl = el('inputText');
  vm.createContext(ctx);
  vm.runInContext(FUNCS.map(extractFn).join('\n\n'), ctx);
  return ctx;
}

// Fake AI. 'rewrite': UPPERCASES every word but keeps ⟦L#⟧, <<<N>>> and [SLIDE…] tags.
// 'drop': same, but deletes the first placeholder it sees (⟦L1⟧ → "").
// grammar requests get wrapped in the CORRECTED TEXT / ERRORS FOUND format.
const KEEP = /(⟦L\d+⟧|<<<\d+>>>|\[\/?SLIDE\d+_BOX\d+\])|([A-Za-z]+)/g;
function fakeAI(body, mode) {
  let out = body.text.replace(KEEP, (m, keep, w) => keep || w.toUpperCase());
  if (mode === 'drop') out = out.replace('⟦L1⟧', '');
  if (body.type === 'grammar') out = 'CORRECTED TEXT:\n' + out + '\n\nERRORS FOUND:\n1. ⟦L1⟧ → fixed spacing';
  return out;
}

const URL1 = 'https://example.com/path_(x)?q=1&r=2';
const EMAIL = 'jo.doe@uni.ac.uk';
const DOI1 = 'doi:10.1000/xyz123';
const DOI2 = 'https://doi.org/10.5555/abc.def';
const WWW = 'www.parafree.app/tools';
const P1 = `Our survey is online at ${URL1}. Contact ${EMAIL} for access to the raw dataset files.`;
const P2 = `Earlier work (Smith et al., 2019, p. 4) and (Smith & Jones, 2020; Lee, 2021) showed this, as did Brown (2018) [3, 5] and [7], see ${DOI1} and ${DOI2}.`;
const P3 = `This middle paragraph has no links at all and should simply be rewritten by the model.`;
const P4 = `[4] Lee, K. Orphan numbered entry without any heading above it, 2021.`;
const P5 = `More details live on ${WWW} for anyone who wants to read about the methodology.`;
const REFS = `References\nSmith, J., Brown, A., & Lee, K. (2019). Paraphrasing at scale. Journal of Text, 12(3), 45–67. https://doi.org/10.1234/jt.2019.003\nJones, M. 2020, Writing tools, viewed 3 May 2021, <https://example.org/tools>.\n[12] R. Roe, "Numbered style," IEEE Trans., vol. 1, 2018.`;
const BODY = [P1, P2, P3, P4, P5].join('\n\n');
const DOC = BODY + '\n\n' + REFS;
const LINKS = [URL1, EMAIL, DOI1, DOI2, WWW, '(Smith et al., 2019, p. 4)', '(Smith & Jones, 2020; Lee, 2021)', '(2018)', '[3, 5]', '[7]'];
const sentText = (ctx) => ctx._requests.map(r => r.text).join('\n');

(async () => {
  // ── 1. lib/protect.js unit checks ──
  console.log('\n── 1. Detection & masking ──');
  for (const h of ['References', 'Reference List', 'BIBLIOGRAPHY', 'Works Cited:', 'Sources', 'Citations', '7. References', 'IV. Bibliography'])
    assert(`heading: "${h}"`, PFProtect.isRefHeading(h));
  for (const h of ['Sources of renewable energy', 'References are listed below in full', 'Our references'])
    assert(`not a heading: "${h}"`, !PFProtect.isRefHeading(h));
  for (const e of ['[1] A. Author, "T," 2020.', '[12] Foo, bar.', 'Smith, J. (2020). Title. Journal.', 'Smith, J., & Lee, K. (2019a). T.', 'Smith 2020, Title of book, Publisher.', 'Smith, J. 2020, Title.', 'Smith and Jones 2019, Title.'])
    assert(`entry: "${e}"`, PFProtect.isReferenceEntry(e));
  for (const e of [P1, P2, P3, 'Smith argued in 2020 that tools matter.'])
    assert(`not an entry: "${e.slice(0, 40)}…"`, !PFProtect.isReferenceEntry(e));
  const prep = PFProtect.prepare(BODY, 'P', { tool: 'paraphrase' });
  for (const l of LINKS) assert(`masked: ${l}`, !prep.sendText.includes(l));
  assert('prompt gets the placeholder line', prep.prompt === 'P\n\n' + PFProtect.PROMPT_LINE);
  assert('restore(identity) is byte-identical', prep.restore(prep.sendText) === BODY.split(/\n\n/).join('\n\n'));
  const plain = PFProtect.prepare(P3, 'P', { tool: 'paraphrase' });
  assert('no links → passthrough (text and prompt unchanged)', !plain.changed && plain.sendText === P3 && plain.prompt === 'P');
  const sp = PFProtect.splitReferences(DOC);
  assert('splitReferences: body + gap + tail === input', sp.body + sp.gap + sp.tail === DOC && sp.tail === REFS);
  const toc = 'Contents\nIntroduction\nReferences\n\nIntroduction\n\nBody text here.\n\nReferences\nSmith, J. (2020). T.';
  assert('splitReferences uses the LAST heading (table of contents safe)', PFProtect.splitReferences(toc).body.endsWith('Body text here.'));

  // ── 1b. Heading rule: ≤5 words AND in the last 40% of the document ──
  console.log('\n── 1b. Mid-document "Sources" heading must NOT cut off the text ──');
  const LONG_P = (i) => `Section ${i} body text that discusses energy systems in enough detail to matter for the reader here.`;
  const MID = [LONG_P(1), 'Sources', LONG_P(2), LONG_P(3), LONG_P(4), LONG_P(5), LONG_P(6)].join('\n\n');
  assert('mid-document "Sources": nothing split off', PFProtect.splitReferences(MID).tail === '');
  const LATE = [LONG_P(1), LONG_P(2), LONG_P(3), LONG_P(4), 'Sources', 'Smith, J. (2020). Energy. Journal.'].join('\n\n');
  assert('late "Sources" (last 40%) still splits', PFProtect.splitReferences(LATE).tail.startsWith('Sources'));
  {
    const c = makeSandbox('rewrite');
    c.inputEl.value = MID;
    await c.paraphrase();
    const sent = sentText(c), outMid = c._rendered || '';
    assert('paraphrase: every paragraph after mid "Sources" was sent', [2, 3, 4, 5, 6].every(i => sent.includes(`Section ${i} body`)), sent);
    assert('paraphrase: text after mid "Sources" was paraphrased', [2, 6].every(i => outMid.includes(`SECTION ${i} BODY`)), outMid);
    const midXml = '<w:body>' + [
      `<w:p><w:r><w:t>${LONG_P(1)}</w:t></w:r></w:p>`,
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sources</w:t></w:r></w:p>',
      ...[2, 3, 4, 5, 6].map(i => `<w:p><w:r><w:t>${LONG_P(i)}</w:t></w:r></w:p>`),
    ].join('') + '</w:body>';
    assert('DOCX: mid-document "Sources" heading keeps nothing original', PFProtect.docxKeepOriginalPositions(midXml).size === 0);
    const midSlides = [1, 2, 3, 4, 5].map(n => ({ num: n, textBoxItems: [
      { text: n === 1 ? 'Sources' : 'Slide ' + n, isTitle: true }, { text: LONG_P(n), isTitle: false }] }));
    assert('PPTX: "Sources" title on slide 1 of 5 skips nothing', PFProtect.pptxSkipTags(midSlides).size === 0);
  }

  // ── 2. Pasted text / PDF paraphrase ──
  console.log('\n── 2. Paraphrase (pasted text / PDF) — rewrite AI ──');
  let ctx = makeSandbox('rewrite');
  ctx.inputEl.value = DOC;
  await ctx.paraphrase();
  let out = ctx._rendered || '';
  assert('request never contains a link, email, DOI or citation', LINKS.every(l => !sentText(ctx).includes(l)), sentText(ctx));
  assert('reference section never sent', !sentText(ctx).includes('Paraphrasing at scale') && !/References/i.test(sentText(ctx)));
  assert('orphan [4] entry never sent', !sentText(ctx).includes('Orphan numbered entry'));
  assert('prompt carries the placeholder line', ctx._requests.every(r => r.prompt.includes(PFProtect.PROMPT_LINE)));
  assert('all links/citations restored exactly', LINKS.every(l => out.includes(l)), out);
  assert('body was paraphrased', out.includes('SURVEY IS ONLINE') && out.includes('MIDDLE PARAGRAPH'));
  assert('orphan entry kept verbatim', out.includes(P4));
  assert('references section byte-identical at the end', out.endsWith('\n\n' + REFS), JSON.stringify(out.slice(-80)));
  assert('no placeholder left in output', !/[⟦⟧]/.test(out));

  console.log('\n── 3. Paraphrase — AI drops a placeholder ──');
  ctx = makeSandbox('drop');
  ctx.inputEl.value = DOC;
  await ctx.paraphrase();
  out = ctx._rendered || '';
  const paras = out.split('\n\n');
  const p1Token = PFProtect.prepare(BODY, 'P', { tool: 'paraphrase' }).sendText.split('\n\n')[0];
  assert('dropped placeholder belonged to paragraph 1', p1Token.includes('⟦L1⟧'));
  assert('paragraph 1 falls back to the ORIGINAL text', paras[0] === P1, paras[0]);
  assert('other paragraphs still paraphrased', out.includes('MIDDLE PARAGRAPH') && out.includes('EARLIER WORK'));
  assert('links in other paragraphs restored', [DOI1, DOI2, WWW].every(l => out.includes(l)));
  assert('references still byte-identical', out.endsWith('\n\n' + REFS));

  // ── 4. Humanize & grammar ──
  console.log('\n── 4. Humanize & grammar ──');
  ctx = makeSandbox('rewrite');
  ctx.inputEl.value = DOC;
  await ctx.humanize();
  out = ctx._rendered || '';
  assert('humanize: nothing protected was sent', LINKS.every(l => !sentText(ctx).includes(l)) && !sentText(ctx).includes('Paraphrasing at scale'));
  assert('humanize: links restored, references byte-identical', LINKS.every(l => out.includes(l)) && out.endsWith('\n\n' + REFS));
  ctx = makeSandbox('rewrite');
  ctx.currentTool = 'grammar';
  ctx.document.getElementById('inputText').value = DOC;
  await ctx.checkGrammar();
  out = ctx.fullOutputText;
  assert('grammar: nothing protected was sent', LINKS.every(l => !sentText(ctx).includes(l)) && !sentText(ctx).includes('Paraphrasing at scale'));
  assert('grammar: corrected text has links + references byte-identical', LINKS.every(l => out.includes(l)) && out.endsWith('\n\n' + REFS), out.slice(-120));
  assert('grammar: error list placeholders restored', ctx.document.getElementById('grammarErrorsPanel').innerHTML.includes('https://example.com'));
  ctx = makeSandbox('drop');
  ctx.currentTool = 'grammar';
  ctx.document.getElementById('inputText').value = DOC;
  await ctx.checkGrammar();
  assert('grammar + dropped placeholder: paragraph 1 is original', ctx.fullOutputText.split('\n\n')[0] === P1, ctx.fullOutputText.split('\n\n')[0]);

  // ── 5. Behaviour unchanged when there is nothing to protect ──
  console.log('\n── 5. No links → request identical to before ──');
  ctx = makeSandbox('rewrite');
  ctx.inputEl.value = P3 + '\n\n' + P3;
  await ctx.paraphrase();
  assert('text sent unchanged', ctx._requests[0].text === P3 + '\n\n' + P3);
  assert('prompt unchanged', ctx._requests[0].prompt === 'PARAPHRASE PROMPT');

  // ── 6. DOCX ──
  console.log('\n── 6. DOCX: hyperlinks + references byte-identical ──');
  const W = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;
  const R = (t, rpr = '') => `<w:r>${rpr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const xP0 = W(R('Introduction'), 'Heading1');
  // URL WITH '&': in document.xml it is stored as &amp;, and the download must write it back
  // with a single &amp; (no &amp;amp;) — covered by the decode-then-encode DOCX fix.
  const DOCX_URL = 'https://example.com/path_(x)?a=1&b=2';
  const DOCX_URL_XML = DOCX_URL.replace(/&/g, '&amp;');
  const xP1 = W(R('The study is hosted at ') + R(DOCX_URL_XML, '<w:rPr><w:b/></w:rPr>') + R(' and was cited (Smith et al., 2019, p. 4) by many groups worldwide.'));
  const xP2 = W(R('Please read the guidance on ') + '<w:hyperlink r:id="rId9" w:history="1">' + R('the official project website', '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>') + '</w:hyperlink>' + R(' before you submit any of your files.'));
  const xP3 = W(R('A plain body paragraph with enough words to be sent to the model for rewriting.'));
  const xP4 = W(R('[9] Orphan numbered reference entry in the body text, 2020, Publisher.'));
  const xP5 = W(R('References'), 'Heading1');
  const xP6 = W(R('Smith, J., Brown, A., &amp; Lee, K. (2019). ') + R('Paraphrasing at scale', '<w:rPr><w:i/></w:rPr>') + R('. Journal of Text, 12(3), 45–67.'));
  const xP7 = W(R('Jones, M. 2020, Writing tools for students and staff, viewed 3 May 2021, ') + '<w:hyperlink r:id="rId10">' + R('https://example.org/tools') + '</w:hyperlink>' + R('.'));
  const xTbl = '<w:tbl><w:tr><w:tc>' + W(R('Table cell text that is long enough to count here ok')) + '</w:tc></w:tr></w:tbl>';
  const DOCX_PARAS = [xP0, xP1, xP2, xP3, xP4, xTbl, xP5, xP6, xP7];
  const DOCX_XML = '<?xml version="1.0"?><w:document><w:body>' + DOCX_PARAS.join('') + '<w:sectPr/></w:body></w:document>';
  const paraList = (xml) => xml.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, '').match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];

  for (const mode of ['rewrite', 'drop']) {
    ctx = makeSandbox(mode);
    ctx.docxOriginalXml = DOCX_XML;
    ctx.docxZip = { file: (name, content) => { if (content !== undefined) ctx._savedXml = content; }, generateAsync: async () => 'blob' };
    ctx.inputEl.value = 'docx preview text';
    await ctx.paraphrase();
    await ctx.downloadAsDOCX();
    const outXml = ctx._savedXml || '';
    const outP = paraList(outXml), inP = paraList(DOCX_XML);
    const sent = sentText(ctx);
    console.log(`  (AI mode: ${mode})`);
    assert('download produced document.xml with same paragraph count', outP.length === inP.length, outP.length + ' vs ' + inP.length);
    assert('hyperlink paragraph byte-identical (target r:id + display text + runs)', outP[2] === inP[2], outP[2]);
    assert('hyperlink paragraph never sent', !sent.includes('official project website'));
    assert('References heading byte-identical', outP[5] === inP[5]);
    assert('reference entries byte-identical (incl. italic run + hyperlink)', outP[6] === inP[6] && outP[7] === inP[7]);
    assert('reference entries never sent', !sent.includes('Paraphrasing at scale') && !sent.includes('Writing tools for students'));
    assert('orphan [9] entry byte-identical and not sent', outP[4] === inP[4] && !sent.includes('Orphan numbered'));
    assert('table untouched', outXml.includes(xTbl));
    assert('URL and citation in P1 never sent raw', !sent.includes('example.com') && !sent.includes('Smith et al.'));
    assert('<<<N>>> markers still used', /<<<\d+>>>/.test(sent));
    if (mode === 'rewrite') {
      assert('P1 paraphrased with exact URL + citation restored', outP[1] !== inP[1] && outP[1].includes(DOCX_URL_XML + ' ') && !outP[1].includes('&amp;amp;') && outP[1].includes('(Smith et al., 2019, p. 4)') && outP[1].includes('STUDY'), outP[1]);
      assert('P3 paraphrased', outP[3].includes('PLAIN BODY PARAGRAPH'));
    } else {
      assert('P1 (placeholder dropped) falls back to original XML byte-identical', outP[1] === inP[1], outP[1]);
      assert('P3 still paraphrased', outP[3].includes('PLAIN BODY PARAGRAPH'));
    }
  }

  // ── 7. PPTX (paraphrasePPTX itself is unmodified) ──
  console.log('\n── 7. PPTX ──');
  ctx = makeSandbox('rewrite');
  ctx.pptxMode = true;
  const box = (t, isTitle = false, spIdx = 0) => ({ spIdx, text: t, isTitle });
  ctx.pptxData = { slides: [
    { num: 1, textBoxItems: [box('Project overview', true), box(`Read the full results at ${URL1} or email ${EMAIL} for questions.`, false, 1)] },
    { num: 2, textBoxItems: [box('Findings', true), box('Students saved hours every week (Smith, 2020) using the tool.', false, 1)] },
    { num: 3, textBoxItems: [box('References', true), box('Smith, J. (2020). Paraphrasing at scale. Journal of Text, 12(3), 45–67.', false, 1)] },
  ] };
  await ctx.paraphrasePPTX();
  const items = ctx.pptxData.slides.map(s => s.textBoxItems[1]);
  assert('PPTX: references slide box never sent', !sentText(ctx).includes('Paraphrasing at scale'));
  assert('PPTX: references box text unchanged', items[2].paraphrased === items[2].text, items[2].paraphrased);
  assert('PPTX: URL + email restored exactly', items[0].paraphrased.includes(URL1) && items[0].paraphrased.includes(EMAIL) && items[0].paraphrased.includes('FULL RESULTS'), items[0].paraphrased);
  assert('PPTX: citation restored exactly', items[1].paraphrased.includes('(Smith, 2020)') && items[1].paraphrased.includes('STUDENTS'));
  ctx = makeSandbox('drop');
  ctx.pptxMode = true;
  ctx.pptxData = { slides: [{ num: 1, textBoxItems: [box(`Read the full results at ${URL1} today please.`, false, 0)] }] };
  await ctx.paraphrasePPTX();
  const it0 = ctx.pptxData.slides[0].textBoxItems[0];
  assert('PPTX: dropped placeholder → box keeps original text', it0.paraphrased === it0.text, it0.paraphrased);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
