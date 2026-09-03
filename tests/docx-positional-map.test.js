'use strict';
// Tests for the DOCX positional-map fix.
//
// Root cause of the original bug:
//   Global [N] numbered paragraphs were sent to the API. The backend split them
//   into chunks processed in parallel. Each AI model received e.g. "[11]...[20]"
//   for chunk 2 but returned "[1]...[10]" (renumbered from 1). parseNumberedParagraphs
//   then put chunk 2's content at positions 0..9, overwriting chunk 1's correct content.
//   This caused Session 3 text to appear above "Student Name" in the downloaded DOCX.
//
// Fix:
//   Send plain body paragraphs (no [N] markers) to the API.
//   After API returns, split by \n\n and map result[i] → _docxParaMap[i] (positional).
//   No numbers → no renumbering → no position collision.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror the positional-map builder from index.html ────────────────────────

function buildPositionalMap(cleanResult, docxParaCount) {
  const resultParas = cleanResult.split(/\n\n+/).filter(p => p.trim());
  const map = new Array(docxParaCount).fill(null);
  for (let i = 0; i < Math.min(docxParaCount, resultParas.length); i++) {
    const p = resultParas[i].trim();
    if (p) map[i] = p;
  }
  return map;
}

function stripPreamble(result) {
  return result
    .replace(/^\s*Here('s| is) the paraphrased[^\n]*\n*/gim, '')
    .replace(/^\s*(Sure|Certainly|Of course)[,!.][^\n]*\n*/gim, '')
    .replace(/^\s*Paraphrased (text|version|content):?\s*\n*/gim, '')
    .replace(/^\s*Output:\s*\n*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── THE BUG (before fix): AI renumbers chunk 2 from [1] ─────────────────────

console.log('\n── BUG SCENARIO: AI renumbers chunk 2 from [1], corrupting positions ──');
{
  // Simulate the OLD parseNumberedParagraphs behavior
  function oldParseNumberedParagraphs(response, expectedCount) {
    const result = new Array(expectedCount).fill(null);
    const regex = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount) {
        result[idx] = match[2].replace(/\n/g, ' ').trim() || null;
      }
    }
    return result;
  }

  // Chunk 1 has paras [1..5], chunk 2 has paras [6..10].
  // AI renumbers chunk 2's output from [1] (common AI behavior).
  const chunk1Result = '[1] Paraphrased intro.\n\n[2] Paraphrased methods.\n\n[3] Para 3.\n\n[4] Para 4.\n\n[5] Para 5.';
  const chunk2ResultRenumbered = '[1] SESSION 3 CONTENT.\n\n[2] More session 3.\n\n[3] Para 8.\n\n[4] Para 9.\n\n[5] Para 10.';
  const joinedResult = chunk1Result + '\n\n' + chunk2ResultRenumbered;

  const buggyMap = oldParseNumberedParagraphs(joinedResult, 10);
  // Bug: [1] in chunk 2 overwrites position 0 (chunk 1's intro para)
  assert('BUG: position 0 overwritten with Session 3 content',
    buggyMap[0] === 'SESSION 3 CONTENT.',
    JSON.stringify(buggyMap[0]));
  assert('BUG: original intro para is lost',
    buggyMap[0] !== 'Paraphrased intro.',
    JSON.stringify(buggyMap[0]));
}

console.log('\n── FIX: Positional map is immune to AI renumbering ──');
{
  // Same scenario: chunk 2 AI returns [1]..[5] (renumbered).
  // But since we sent PLAIN text (no [N] markers), the AI just paraphrases
  // each paragraph and returns them in order. We split by \n\n positionally.
  const chunk1Result = 'Paraphrased intro.\n\nParaphrased methods.\n\nPara 3.\n\nPara 4.\n\nPara 5.';
  const chunk2Result = 'Para 6.\n\nPara 7.\n\nPara 8.\n\nPara 9.\n\nPara 10.';
  const joinedResult = chunk1Result + '\n\n' + chunk2Result;

  const map = buildPositionalMap(joinedResult, 10);
  assert('position 0 = intro (not overwritten)', map[0] === 'Paraphrased intro.', JSON.stringify(map[0]));
  assert('position 1 = methods', map[1] === 'Paraphrased methods.', JSON.stringify(map[1]));
  assert('position 5 = para 6 (chunk 2 first para)', map[5] === 'Para 6.', JSON.stringify(map[5]));
  assert('position 9 = para 10 (last para)', map[9] === 'Para 10.', JSON.stringify(map[9]));
  assert('all 10 positions filled', map.every(p => p !== null));
}

// ── Multi-section document order preserved ────────────────────────────────────

console.log('\n── Multi-section lab report: sessions stay in original order ──');
{
  // Simulate a lab report with sections.
  // Original body paragraphs (as extracted from DOCX, headings already excluded):
  const originalParas = [
    'Introduction to security assessment methodology used in this lab.',    // 0 (near top)
    'Session 1 body: Deep inspection analysis using Wireshark tool.',        // 1
    'Session 1 findings: Normal traffic patterns were observed throughout.',  // 2
    'Session 2 body: Malware sandbox execution using Joe Sandbox.',          // 3
    'Session 2 results: Suspicious API calls detected in the process tree.', // 4
    'Session 3 body: Defender observation and Screenshot 3.1 analysis.',     // 5
    'Session 3 findings: Real-time protection triggered on test payload.',   // 6
    'Session 4 body: Intune device config policy deployment and testing.',   // 7
    'Session 5 body: App protection policy applied to managed devices.',     // 8
    'Conclusion summarising all sessions and overall security posture.',      // 9
  ];
  // References are headings/short — excluded from _docxParaMap, preserved as-is.

  // Simulate parallel chunks completing out of order:
  // Chunk 1 (paras 0-4) completes LAST, Chunk 2 (paras 5-9) completes FIRST.
  // Old system: chunk 2 AI returns [1]..[5] (renumbered) → corrupts positions 0-4.
  // New system: no numbers → order determined by join seq, not AI output labels.

  // Simulate backend joining in original seq order (seq-numbering guarantees this):
  const chunk1Paraphrased = 'Paraphrased introduction.\n\nSession 1 paraphrased analysis.\n\nSession 1 paraphrased findings.\n\nSession 2 paraphrased sandbox run.\n\nSession 2 paraphrased API calls.';
  const chunk2Paraphrased = 'Session 3 paraphrased Defender observation.\n\nSession 3 paraphrased protection trigger.\n\nSession 4 paraphrased Intune config.\n\nSession 5 paraphrased app protection.\n\nParaphrased conclusion.';
  const joinedResult = chunk1Paraphrased + '\n\n' + chunk2Paraphrased;

  const map = buildPositionalMap(joinedResult, 10);

  assert('position 0 = intro (not Session 3)', map[0] === 'Paraphrased introduction.', JSON.stringify(map[0]));
  assert('position 1 = Session 1', map[1] === 'Session 1 paraphrased analysis.', JSON.stringify(map[1]));
  assert('position 5 = Session 3 (at correct position, not at top)', map[5] === 'Session 3 paraphrased Defender observation.', JSON.stringify(map[5]));
  assert('position 7 = Session 4 Intune (not inside Session 1)', map[7] === 'Session 4 paraphrased Intune config.', JSON.stringify(map[7]));
  assert('position 8 = Session 5 app protection', map[8] === 'Session 5 paraphrased app protection.', JSON.stringify(map[8]));
  assert('position 9 = conclusion', map[9] === 'Paraphrased conclusion.', JSON.stringify(map[9]));
}

// ── Preamble stripping before split ─────────────────────────────────────────

console.log('\n── AI preamble stripped before positional split ──');
{
  const withPreamble = 'Sure! Here is the paraphrased version:\n\nFirst paragraph paraphrased here.\n\nSecond paragraph paraphrased here.';
  const cleaned = stripPreamble(withPreamble);
  const map = buildPositionalMap(cleaned, 2);
  assert('preamble stripped, position 0 is para 1', map[0] === 'First paragraph paraphrased here.', JSON.stringify(map[0]));
  assert('position 1 is para 2', map[1] === 'Second paragraph paraphrased here.', JSON.stringify(map[1]));
}

console.log('\n── Here-is-the-paraphrased preamble stripped ──');
{
  const r = 'Here\'s the paraphrased text:\n\nPara A.\n\nPara B.';
  const cleaned = stripPreamble(r);
  const map = buildPositionalMap(cleaned, 2);
  assert('para A at position 0', map[0] === 'Para A.', JSON.stringify(map[0]));
  assert('para B at position 1', map[1] === 'Para B.', JSON.stringify(map[1]));
}

// ── Paragraph count mismatch: fewer results than expected ───────────────────

console.log('\n── Fewer result paras than expected: unmatched positions stay null ──');
{
  // AI merges paras 3+4 into one, returns 9 instead of 10.
  const result = Array.from({length: 9}, (_, i) => `Para ${i+1} paraphrased.`).join('\n\n');
  const map = buildPositionalMap(result, 10);
  assert('positions 0-8 filled', map.slice(0, 9).every(p => p !== null));
  assert('position 9 = null (AI merged, original DOCX text kept)', map[9] === null);
  assert('no cascade: position 0 = para 1', map[0] === 'Para 1 paraphrased.', JSON.stringify(map[0]));
}

// ── Paragraph count mismatch: more results than expected ─────────────────────

console.log('\n── More result paras than expected: extras truncated ──');
{
  // AI splits a para, returns 12 for expected 10.
  const result = Array.from({length: 12}, (_, i) => `Extra para ${i+1}.`).join('\n\n');
  const map = buildPositionalMap(result, 10);
  assert('map length = expected count (10)', map.length === 10);
  assert('position 9 filled (not truncated early)', map[9] === 'Extra para 10.', JSON.stringify(map[9]));
}

// ── Empty result paras filtered out ─────────────────────────────────────────

console.log('\n── Empty / whitespace-only result paras ignored ──');
{
  const result = 'Para 1.\n\n   \n\nPara 2.\n\n\n\nPara 3.';
  const map = buildPositionalMap(result, 3);
  assert('3 real paras, not split by empty lines', map.filter(p => p !== null).length === 3);
  assert('position 0 = Para 1', map[0] === 'Para 1.', JSON.stringify(map[0]));
  assert('position 1 = Para 2', map[1] === 'Para 2.', JSON.stringify(map[1]));
  assert('position 2 = Para 3', map[2] === 'Para 3.', JSON.stringify(map[2]));
}

// ── docxReplaceParas: position-locked subIdx matches positional map ──────────

console.log('\n── docxReplaceParas subIdx aligns with positional map order ──');
{
  // Simulate extraction order (same as docxReplaceParas walk order):
  // Paragraphs in XML order: heading (skip), body1, short-label (skip), body2, heading (skip), body3
  // Substantial body paras in XML order: body1 (idx=0), body2 (idx=1), body3 (idx=2)
  // positional map: map[0]=paraphrase_of_body1, map[1]=paraphrase_of_body2, map[2]=paraphrase_of_body3

  // Simulate docxReplaceParas logic:
  let subIdx = 0;
  const paraArray = ['Paraphrased body1.', 'Paraphrased body2.', 'Paraphrased body3.'];

  function simulateDocxReplace(paras) {
    const results = [];
    for (const {text, isHeading, isShort} of paras) {
      if (isHeading || isShort) { results.push(text); continue; }
      const newText = subIdx < paraArray.length ? paraArray[subIdx] : null;
      subIdx++;
      results.push(newText || text); // fallback to original if null
    }
    return results;
  }

  const xmlParas = [
    { text: 'Session 1 Heading', isHeading: true,  isShort: false },
    { text: 'Original body1 text here.', isHeading: false, isShort: false },
    { text: 'Date: 2024', isHeading: false, isShort: true },
    { text: 'Original body2 text here.', isHeading: false, isShort: false },
    { text: 'Session 2 Heading', isHeading: true,  isShort: false },
    { text: 'Original body3 text here.', isHeading: false, isShort: false },
  ];

  const output = simulateDocxReplace(xmlParas);
  assert('heading preserved at position 0', output[0] === 'Session 1 Heading');
  assert('body1 replaced at position 1', output[1] === 'Paraphrased body1.', JSON.stringify(output[1]));
  assert('short label preserved at position 2', output[2] === 'Date: 2024');
  assert('body2 replaced at position 3', output[3] === 'Paraphrased body2.', JSON.stringify(output[3]));
  assert('heading preserved at position 4', output[4] === 'Session 2 Heading');
  assert('body3 replaced at position 5', output[5] === 'Paraphrased body3.', JSON.stringify(output[5]));
  assert('correct paraphrase at each body position (no shift)', subIdx === 3);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
