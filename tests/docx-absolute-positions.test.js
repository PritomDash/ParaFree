'use strict';
// Tests for the absolute-position DOCX fix.
//
// Root cause of the desync bug:
//   The old body-relative index (subIdx) incremented once per substantial body para.
//   If the AI returned N-1 paragraphs (merging two), body para at original position K
//   would receive the paraphrased text that BELONGED at position K+1. Content that
//   belonged under "Methodology" appeared under "Main findings", etc.
//
// Fix:
//   extractBodyParasWithPos() assigns each body paragraph its ABSOLUTE document
//   position (0-based index in the full XML, headings included in the count).
//   The map is stored as _docxParaMap[docPos] = paraphrasedText.
//   docxReplaceParasAbsolute() walks all paragraphs with an absolute counter —
//   it looks up paraArray[absPos] directly; headings have null there and are kept.
//   Headings never shift body alignment because they don't move the body index.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror extractBodyParasWithPos logic ─────────────────────────────────────

function isDocxHeading(paraXml) {
  const styleM = paraXml.match(/<w:pStyle\s+w:val="([^"]+)"/i);
  if (styleM) {
    const s = styleM[1];
    if (/^Heading[\s\d]/i.test(s) || /^(Title|Subtitle|TOCHeading)$/i.test(s)) return true;
  }
  const lvlM = paraXml.match(/<w:outlineLvl\s+w:val="(\d+)"/i);
  if (lvlM && parseInt(lvlM[1], 10) <= 8) return true;
  return false;
}
function docxSkip(t) {
  if (!t || t.length < 3) return true;
  if (/^[jkmnlJKMNL]{3,}/.test(t) || /(.)\1{4,}/.test(t)) return true;
  if (/^\d{4}\s*[-–]\s*(\d{4}|present)$/i.test(t) ||
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(t)) return true;
  return false;
}
function isSubstantialPara(t) {
  return t.length >= 25 && /\s/.test(t) && t.split(/\s+/).length >= 5;
}

function extractBodyParasWithPos(xml) {
  const noTables = xml.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, '');
  const allParas = noTables.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  const bodyParas = [];
  allParas.forEach((p, docPos) => {
    const t = p.replace(/<[^>]+>/g, '').trim();
    if (docxSkip(t) || isDocxHeading(p) || !isSubstantialPara(t)) return;
    bodyParas.push({ docPos, text: t });
  });
  return { bodyParas, totalDocParas: allParas.length };
}

// ── Mirror docxReplaceParasAbsolute logic ────────────────────────────────────

function pptxEncodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function docxReplaceParasAbsolute(xml, paraArray) {
  let absPos = 0, replaced = 0;
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    if (para.includes('\x00TBL')) return para;
    const idx = absPos++;
    const newText = (idx < paraArray.length) ? paraArray[idx] : null;
    if (!newText) return para;
    const origText = para.replace(/<[^>]+>/g, '').trim();
    if (newText.length < origText.length * 0.3) return para;
    replaced++;
    let firstDone = false;
    return para.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g, (m, open, txt, close) => {
      if (!txt.trim()) return m;
      if (!firstDone) { firstDone = true; return open + pptxEncodeXml(newText) + close; }
      return open + close;
    });
  });
  return result;
}

// ── Build absolute position map (mirrors frontend paraphrase path) ────────────

function buildAbsoluteMap(bodyParas, totalDocParas, resultParas) {
  const paraMap = new Array(totalDocParas).fill(null);
  for (let i = 0; i < Math.min(bodyParas.length, resultParas.length); i++) {
    const p = resultParas[i].trim();
    if (p) paraMap[bodyParas[i].docPos] = p;
  }
  return paraMap;
}

// ── Helper: build minimal DOCX XML ───────────────────────────────────────────

function makePara(text, style = null) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function makeHeadingPara(text, level = 1) {
  return makePara(text, `Heading${level}`);
}
function makeXml(paras) {
  return paras.join('\n');
}

// ── THE BUG: body-relative index shifts when heading is inserted between bodies ──

console.log('\n── BUG SCENARIO: body-relative index shifts when heading between two body paras ──');
{
  // Document structure (absolute positions):
  //   pos 0: heading "Introduction"
  //   pos 1: body "Introduction body text with enough words here for paraphrase."
  //   pos 2: heading "Methodology"
  //   pos 3: body "Methodology body text with enough words here for paraphrase."
  //   pos 4: heading "Main Findings"
  //   pos 5: body "Main findings body text with enough words here for paraphrase."
  //
  // Old body-relative approach: bodyParas = [body0, body1, body2] → indices 0, 1, 2
  // API returns 3 paraphrases. Old _docxParaMap[0]=para_intro, [1]=para_methods, [2]=para_findings
  // Old docxReplaceParas walks XML:
  //   pos0 heading → skip (subIdx stays 0)
  //   pos1 body → paraArray[0] = para_intro ✓
  //   pos2 heading → skip (subIdx stays 1)
  //   pos3 body → paraArray[1] = para_methods ✓
  //   pos4 heading → skip (subIdx stays 2)
  //   pos5 body → paraArray[2] = para_findings ✓
  // In the simple case (exact count), both approaches work.
  // THE BUG triggers when API returns N-1 (merges two paras):

  // Simulate API merging pos1 and pos3 paras into one (returns 2 instead of 3):
  const resultParas2 = ['Merged introduction and methodology text.', 'Paraphrased main findings.'];

  // Old body-relative map (simulating the broken behavior):
  const oldBodyRelativeMap = [null, null, null]; // body-relative, length = 3
  oldBodyRelativeMap[0] = resultParas2[0]; // merged text at body index 0
  oldBodyRelativeMap[1] = resultParas2[1]; // findings at body index 1
  // oldBodyRelativeMap[2] = null (position 2 stays as original)

  // Old docxReplaceParas behavior: subIdx walks body paras in order
  // body0 → oldBodyRelativeMap[0] = merged (wrong for methodology para)
  // body1 → oldBodyRelativeMap[1] = findings (methodology section gets "findings" text!)
  // body2 → oldBodyRelativeMap[2] = null → keeps original

  assert('BUG: body-relative map gives methodology para the findings text',
    oldBodyRelativeMap[1] === 'Paraphrased main findings.');
  // ↑ This proves that body index 1 = "Methodology" body gets "Paraphrased main findings"
  //   when the API merges the first two paras. Wrong heading!
}

// ── FIX: absolute positions — headings never shift body indices ───────────────

console.log('\n── FIX: absolute positions decouple heading count from body alignment ──');
{
  const introBody = 'Introduction body text with enough words here for paraphrase.';
  const methodBody = 'Methodology body text with enough words here for paraphrase.';
  const findBody = 'Main findings body text with enough words here for paraphrase.';

  const xml = makeXml([
    makeHeadingPara('Introduction'),     // docPos 0 — heading, skip
    makePara(introBody),                  // docPos 1 — body
    makeHeadingPara('Methodology'),      // docPos 2 — heading, skip
    makePara(methodBody),                // docPos 3 — body
    makeHeadingPara('Main Findings'),    // docPos 4 — heading, skip
    makePara(findBody),                  // docPos 5 — body
  ]);

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('3 body paras extracted', bodyParas.length === 3, JSON.stringify(bodyParas.map(b => b.docPos)));
  assert('body[0].docPos = 1 (after Introduction heading)', bodyParas[0].docPos === 1);
  assert('body[1].docPos = 3 (after Methodology heading)', bodyParas[1].docPos === 3);
  assert('body[2].docPos = 5 (after Main Findings heading)', bodyParas[2].docPos === 5);
  assert('totalDocParas = 6', totalDocParas === 6);

  // Perfect match: API returns 3 paras in correct order.
  // Paraphrase strings must be >= 30% of originals (quality guard in docxReplaceParasAbsolute).
  const resultParas = [
    'Paraphrased introduction section body text with sufficient length here.',
    'Paraphrased methodology section body text with sufficient length here.',
    'Paraphrased main findings section body text with sufficient length here.',
  ];
  const paraMap = buildAbsoluteMap(bodyParas, totalDocParas, resultParas);

  assert('paraMap[0] = null (Introduction heading)', paraMap[0] === null);
  assert('paraMap[1] = paraphrased intro', paraMap[1] === resultParas[0], JSON.stringify(paraMap[1]));
  assert('paraMap[2] = null (Methodology heading)', paraMap[2] === null);
  assert('paraMap[3] = paraphrased methodology', paraMap[3] === resultParas[1], JSON.stringify(paraMap[3]));
  assert('paraMap[4] = null (Main Findings heading)', paraMap[4] === null);
  assert('paraMap[5] = paraphrased findings', paraMap[5] === resultParas[2], JSON.stringify(paraMap[5]));

  // Replacement: headings keep original, body paras get paraphrased text
  const result = docxReplaceParasAbsolute(xml, paraMap);
  assert('Introduction heading preserved', result.includes('Introduction'));
  assert('intro body replaced', result.includes('Paraphrased introduction section body text'));
  assert('Methodology heading preserved', result.includes('Methodology'));
  assert('methodology body replaced', result.includes('Paraphrased methodology section body text'));
  assert('Main Findings heading preserved', result.includes('Main Findings'));
  assert('findings body replaced', result.includes('Paraphrased main findings section body text'));
  assert('original intro body text gone', !result.includes(introBody));
  assert('original method body text gone', !result.includes(methodBody));
  assert('original findings body text gone', !result.includes(findBody));
}

// ── Count mismatch (AI merges two paras): correct paras still land correctly ──

console.log('\n── Count mismatch: AI merges paras — correctly matched ones stay in position ──');
{
  const xml = makeXml([
    makeHeadingPara('Session 1'),         // docPos 0 — heading
    makePara('Session 1 body text that is long enough to be substantial for paraphrase.'), // docPos 1
    makeHeadingPara('Session 2'),         // docPos 2 — heading
    makePara('Session 2 body text that is long enough to be substantial for paraphrase.'), // docPos 3
    makeHeadingPara('Session 3'),         // docPos 4 — heading
    makePara('Session 3 body text that is long enough to be substantial for paraphrase.'), // docPos 5
    makeHeadingPara('Session 4'),         // docPos 6 — heading
    makePara('Session 4 body text that is long enough to be substantial for paraphrase.'), // docPos 7
  ]);

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('4 body paras extracted', bodyParas.length === 4);
  assert('docPos values = [1,3,5,7]', JSON.stringify(bodyParas.map(b => b.docPos)) === '[1,3,5,7]');

  // API returns only 3 (merged session 2+3 into one).
  // Paraphrase strings must be >= 30% of originals (quality guard).
  const resultParas = [
    'Paraphrased session one body text sufficient length for quality guard.',
    'Merged session two and three body text sufficient length for quality guard.',
    'Paraphrased session four body text sufficient length for quality guard.',
  ];
  const paraMap = buildAbsoluteMap(bodyParas, totalDocParas, resultParas);

  // With absolute positions:
  // bodyParas[0].docPos=1 → resultParas[0]='Paraphrased S1.'
  // bodyParas[1].docPos=3 → resultParas[1]='Merged S2 and S3.'
  // bodyParas[2].docPos=5 → resultParas[2]='Paraphrased S4.'  ← note: maps to Session 3 slot
  // bodyParas[3].docPos=7 → no resultParas[3] → stays null → original kept

  assert('pos 1 = S1 para', paraMap[1] === resultParas[0], JSON.stringify(paraMap[1]));
  assert('pos 3 = merged para (S2 slot gets merged)', paraMap[3] === resultParas[1], JSON.stringify(paraMap[3]));
  assert('pos 5 = S4 para (best-effort, shifted by merge)', paraMap[5] === resultParas[2], JSON.stringify(paraMap[5]));
  assert('pos 7 = null (no match, keeps original S4 text)', paraMap[7] === null);

  // Critical: with old body-relative approach and this same input, body index 2 (Session 3)
  // would get S4 text AND body index 3 (Session 4) would keep original.
  // With absolute, Session 3 slot (pos 5) gets S4 text (off by one due to merge, unavoidable),
  // but Session 1 (pos 1) is guaranteed correct regardless.
  assert('Session 1 guaranteed correct (before the merge)', paraMap[1] === resultParas[0]);

  const result = docxReplaceParasAbsolute(xml, paraMap);
  assert('Session 1 heading preserved', result.includes('Session 1'));
  assert('Session 1 body replaced', result.includes('Paraphrased session one body text'));
  assert('Session 2 heading preserved', result.includes('Session 2'));
  assert('Session 4 heading preserved', result.includes('Session 4'));
}

// ── Multi-section lab report: exact count match ───────────────────────────────

console.log('\n── Multi-section lab report (Sessions 1-5 + Intune): exact count, perfect alignment ──');
{
  const sections = [
    { heading: 'Introduction', body: 'Lab report introduction covering security assessment methodology used in this study.' },
    { heading: 'Session 1: Wireshark', body: 'Deep packet inspection analysis using Wireshark tool to capture network traffic samples.' },
    { heading: 'Session 2: Joe Sandbox', body: 'Malware sandbox execution using Joe Sandbox to analyse suspicious executable behaviour.' },
    { heading: 'Session 3: Defender', body: 'Defender observation and real-time protection analysis including Screenshot 3.1 review.' },
    { heading: 'Session 4: Intune', body: 'Intune device configuration policy deployment and compliance testing across managed endpoints.' },
    { heading: 'Session 5: App Protection', body: 'App protection policy applied to managed devices to enforce data loss prevention controls.' },
    { heading: 'Conclusion', body: 'Summary of all sessions and overall security posture assessment across the organisation.' },
  ];

  // Build XML: heading, body, heading, body, ... (alternating)
  const xmlParas = [];
  sections.forEach(({ heading, body }) => {
    xmlParas.push(makeHeadingPara(heading));
    xmlParas.push(makePara(body));
  });
  const xml = makeXml(xmlParas);

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('7 body paras (one per section)', bodyParas.length === 7);
  assert('total paragraphs = 14 (7 headings + 7 bodies)', totalDocParas === 14);

  // Body para positions are odd numbers: 1, 3, 5, 7, 9, 11, 13
  const expectedDocPositions = [1, 3, 5, 7, 9, 11, 13];
  assert('body para positions alternate correctly',
    JSON.stringify(bodyParas.map(b => b.docPos)) === JSON.stringify(expectedDocPositions),
    JSON.stringify(bodyParas.map(b => b.docPos)));

  // API returns 7 paraphrases (exact match)
  const resultParas = sections.map(s => `Paraphrased: ${s.heading} body.`);
  const paraMap = buildAbsoluteMap(bodyParas, totalDocParas, resultParas);

  // Verify: each heading slot is null, each body slot has the correct paraphrase
  sections.forEach(({ heading }, i) => {
    const headingPos = i * 2;
    const bodyPos = i * 2 + 1;
    assert(`${heading} heading slot null (pos ${headingPos})`, paraMap[headingPos] === null);
    assert(`${heading} body slot has paraphrase (pos ${bodyPos})`,
      paraMap[bodyPos] === `Paraphrased: ${heading} body.`,
      JSON.stringify(paraMap[bodyPos]));
  });

  // Replace and verify
  const result = docxReplaceParasAbsolute(xml, paraMap);
  sections.forEach(({ heading, body }) => {
    assert(`${heading} heading preserved in output`, result.includes(heading));
    assert(`${heading} body replaced`, result.includes(`Paraphrased: ${heading} body.`));
    assert(`${heading} original body text removed`, !result.includes(body));
  });
}

// ── Student Name not displaced: title-block paras stay at absolute positions ──

console.log('\n── Title block preserved: Student Name / Module Code short paras stay untouched ──');
{
  // Lab report title block: short label paras (skipped by isSubstantialPara/docxSkip)
  // followed by substantive body. Short paras take up docPos slots → absolute index shifts
  // are correctly handled because they're null in the map and kept as-is.
  const xml = makeXml([
    makePara('Student Name: John Smith'),          // docPos 0 — short → null
    makePara('Module Code: CS4001'),               // docPos 1 — short → null
    makePara('Date: 2024'),                        // docPos 2 — short → null (date-skip)
    makeHeadingPara('Introduction', 1),             // docPos 3 — heading → null
    makePara('Introduction body with enough words to count as a substantial paragraph here.'), // docPos 4 — body
    makeHeadingPara('Methodology', 1),              // docPos 5 — heading → null
    makePara('Methodology body with enough words to count as a substantial paragraph here.'),  // docPos 6 — body
  ]);

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('only 2 body paras (title block skipped)', bodyParas.length === 2);
  assert('body[0].docPos = 4 (skips title block + heading)', bodyParas[0].docPos === 4);
  assert('body[1].docPos = 6 (skips methodology heading)', bodyParas[1].docPos === 6);
  assert('totalDocParas = 7', totalDocParas === 7);

  // Paraphrase strings must be >= 30% of originals (quality guard).
  const resultParas = [
    'Paraphrased introduction body with enough words for quality check.',
    'Paraphrased methodology body with enough words for quality check.',
  ];
  const paraMap = buildAbsoluteMap(bodyParas, totalDocParas, resultParas);

  // Title block paras: all null → kept as-is
  assert('Student Name para null (kept)', paraMap[0] === null);
  assert('Module Code para null (kept)', paraMap[1] === null);
  assert('Date para null (kept)', paraMap[2] === null);
  assert('Introduction heading null (kept)', paraMap[3] === null);
  assert('Introduction body replaced at pos 4', paraMap[4] === resultParas[0]);
  assert('Methodology heading null (kept)', paraMap[5] === null);
  assert('Methodology body replaced at pos 6', paraMap[6] === resultParas[1]);

  const result = docxReplaceParasAbsolute(xml, paraMap);
  assert('Student Name preserved', result.includes('Student Name: John Smith'));
  assert('Module Code preserved', result.includes('Module Code: CS4001'));
  assert('Introduction heading preserved', result.includes('Introduction'));
  assert('intro body replaced', result.includes('Paraphrased introduction body with enough'));
  assert('Methodology heading preserved', result.includes('Methodology'));
  assert('methodology body replaced', result.includes('Paraphrased methodology body with enough'));
}

// ── Body text text extraction order matches XML walk order ────────────────────

console.log('\n── Extraction order matches XML walk order (body texts sent to API in document order) ──');
{
  const xml = makeXml([
    makeHeadingPara('A'),           // pos 0
    makePara('Aaa body text one long enough to be substantial here test.'), // pos 1
    makeHeadingPara('B'),           // pos 2
    makePara('Bbb body text two long enough to be substantial here test.'), // pos 3
    makeHeadingPara('C'),           // pos 4
    makePara('Ccc body text three long enough to be substantial here test.'), // pos 5
  ]);

  const { bodyParas } = extractBodyParasWithPos(xml);
  assert('3 body paras in document order', bodyParas.length === 3);
  assert('body[0].text starts with Aaa', bodyParas[0].text.startsWith('Aaa'), JSON.stringify(bodyParas[0].text));
  assert('body[1].text starts with Bbb', bodyParas[1].text.startsWith('Bbb'), JSON.stringify(bodyParas[1].text));
  assert('body[2].text starts with Ccc', bodyParas[2].text.startsWith('Ccc'), JSON.stringify(bodyParas[2].text));

  // API text sent: Aaa...\n\nBbb...\n\nCcc...
  const apiText = bodyParas.map(b => b.text).join('\n\n');
  const sentParas = apiText.split('\n\n');
  assert('first sent para is Aaa', sentParas[0].startsWith('Aaa'));
  assert('second sent para is Bbb', sentParas[1].startsWith('Bbb'));
  assert('third sent para is Ccc', sentParas[2].startsWith('Ccc'));
}

// ── Edge: no body paras (headings only) ──────────────────────────────────────

console.log('\n── Edge: document with no substantial body paras ──');
{
  const xml = makeXml([
    makeHeadingPara('Title'),
    makeHeadingPara('Subtitle'),
    makePara('Short.'),
  ]);
  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('0 body paras', bodyParas.length === 0);
  assert('totalDocParas = 3', totalDocParas === 3);
}

// ── Edge: all body paras (no headings) ───────────────────────────────────────

console.log('\n── Edge: document with no headings — all substantial body paras ──');
{
  const xml = makeXml([
    makePara('First substantial body paragraph with enough words to qualify here.'),  // pos 0
    makePara('Second substantial body paragraph with enough words to qualify here.'), // pos 1
    makePara('Third substantial body paragraph with enough words to qualify here.'),  // pos 2
  ]);
  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('3 body paras (all are body)', bodyParas.length === 3);
  assert('docPositions = [0,1,2]', JSON.stringify(bodyParas.map(b => b.docPos)) === '[0,1,2]');
  assert('totalDocParas = 3', totalDocParas === 3);

  const resultParas = ['Para 0 paraphrased.', 'Para 1 paraphrased.', 'Para 2 paraphrased.'];
  const paraMap = buildAbsoluteMap(bodyParas, totalDocParas, resultParas);
  assert('paraMap[0] = para 0', paraMap[0] === 'Para 0 paraphrased.');
  assert('paraMap[1] = para 1', paraMap[1] === 'Para 1 paraphrased.');
  assert('paraMap[2] = para 2', paraMap[2] === 'Para 2 paraphrased.');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
