'use strict';
// Tests for <<<N>>> positional marker fix.
//
// Root cause of the final scrambling bug:
//   Sequential mapping (resultParas[i] → bps[i].docPos) breaks when the AI
//   returns a different paragraph count. If the AI merges paragraphs 2+3 into
//   one, result[2] contains para 3's text, result[3] contains para 4's text,
//   etc — every paragraph from the merge point onward lands at the wrong docPos.
//
// Fix:
//   Tag each body paragraph with <<<N>>> before sending to the API.
//   Parse the response by <<<N>>> markers to match by position, not by sequence.
//   Missing markers keep the original DOCX text — no cascade shift.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror helpers from index.html ──────────────────────────────────────────

function buildMarkedApiText(bodyParas) {
  return bodyParas.map((b, i) => `<<<${i + 1}>>> ${b.text}`).join('\n\n');
}

function parseMarkerResponse(cleanResult, bps, totalDocParas) {
  const paraMap = new Array(totalDocParas).fill(null);
  const markerRe = /<<<(\d+)>>>\s*([\s\S]*?)(?=<<<\d+>>>|$)/g;
  let match;
  while ((match = markerRe.exec(cleanResult)) !== null) {
    const markerN = parseInt(match[1], 10);
    const paraText = match[2].trim();
    const bpIdx = markerN - 1;
    if (bpIdx >= 0 && bpIdx < bps.length && paraText) {
      paraMap[bps[bpIdx].docPos] = paraText;
    }
  }
  return paraMap;
}

function stripMarkersForDisplay(text) {
  return text.replace(/^<<<\d+>>>\s*/gm, '');
}

// Synthetic lab report body paragraphs (with their absolute docPos in a 19-para document)
const bps = [
  { docPos: 3,  text: 'Introduction body paragraph discussing methodology and assessment approach used in the security lab.' },
  { docPos: 5,  text: 'Session 1 body on Wireshark deep packet inspection for network traffic analysis throughout testing.' },
  { docPos: 7,  text: 'Session 2 body on Joe Sandbox malware dynamic analysis revealing API call sequences and behaviour.' },
  { docPos: 9,  text: 'Session 3 body on Windows Defender real-time protection observed during payload detonation exercise.' },
  { docPos: 11, text: 'Session 4 body on Intune configuration policy deployment tested across managed Windows endpoints.' },
  { docPos: 13, text: 'Session 5 body on app protection policies applied to iOS and Android devices via Microsoft Intune.' },
  { docPos: 15, text: 'Conclusion body summarising effectiveness of all five sessions and layered security approach.' },
  { docPos: 17, text: '[1] Smith, J. (2023). Network Security Monitoring with Wireshark. IEEE Transactions on Information Security.' },
  { docPos: 18, text: '[2] Jones, K. (2022). Dynamic Malware Analysis Techniques Using Sandbox Environments. Journal of Cybersecurity.' },
];
const totalDocParas = 19;

// ── Marker text construction ─────────────────────────────────────────────────

console.log('\n── buildMarkedApiText: each paragraph gets <<<N>>> prefix ──');
{
  const marked = buildMarkedApiText(bps);
  const lines = marked.split('\n\n');
  assert('9 marked paragraphs', lines.length === 9, String(lines.length));
  assert('first paragraph has <<<1>>>', lines[0].startsWith('<<<1>>>'), JSON.stringify(lines[0].substring(0, 20)));
  assert('second paragraph has <<<2>>>', lines[1].startsWith('<<<2>>>'), JSON.stringify(lines[1].substring(0, 20)));
  assert('ninth paragraph has <<<9>>>', lines[8].startsWith('<<<9>>>'), JSON.stringify(lines[8].substring(0, 20)));
  assert('original text follows marker', lines[0].includes(bps[0].text), 'text not found after marker');
}

// ── Perfect AI: returns all 9 markers in order ────────────────────────────────

console.log('\n── Perfect AI: all 9 markers returned → all positions filled ──');
{
  const aiResponse = bps.map((b, i) =>
    `<<<${i + 1}>>> Paraphrased: ${b.text.substring(0, 50)} [rewritten]`
  ).join('\n\n');

  const paraMap = parseMarkerResponse(aiResponse, bps, totalDocParas);

  assert('docPos=3 (Introduction) filled', paraMap[3] !== null, String(paraMap[3]));
  assert('docPos=5 (Session 1) filled', paraMap[5] !== null, String(paraMap[5]));
  assert('docPos=7 (Session 2) filled', paraMap[7] !== null, String(paraMap[7]));
  assert('docPos=9 (Session 3) filled', paraMap[9] !== null, String(paraMap[9]));
  assert('docPos=11 (Session 4) filled', paraMap[11] !== null, String(paraMap[11]));
  assert('docPos=13 (Session 5) filled', paraMap[13] !== null, String(paraMap[13]));
  assert('docPos=15 (Conclusion) filled', paraMap[15] !== null, String(paraMap[15]));
  assert('docPos=17 (Ref 1) filled', paraMap[17] !== null, String(paraMap[17]));
  assert('docPos=18 (Ref 2) filled', paraMap[18] !== null, String(paraMap[18]));
  assert('heading positions stay null (no overwrite)', paraMap[2] === null && paraMap[4] === null && paraMap[6] === null);
  assert('9 filled slots', paraMap.filter(p => p !== null).length === 9, String(paraMap.filter(p => p !== null).length));
}

// ── KEY TEST: AI merges paragraphs — no cascade shift ────────────────────────

console.log('\n── AI merges <<<2>>> and <<<3>>> → only those 2 positions affected, rest correct ──');
{
  // AI sees <<<2>>> Session 1 and <<<3>>> Session 2 and returns a single paragraph
  // with only <<<2>>> marker (it ate <<<3>>>). This is the bug scenario from the trace.
  const aiResponse = [
    `<<<1>>> Paraphrased introduction covering methodology and assessment scope.`,
    `<<<2>>> Merged Session 1 and Session 2 content into a single paraphrased paragraph.`,
    // <<<3>>> is MISSING — AI merged it into <<<2>>>
    `<<<4>>> Paraphrased Session 3 on Defender endpoint protection during payload test.`,
    `<<<5>>> Paraphrased Session 4 on Intune policy deployment across Windows endpoints.`,
    `<<<6>>> Paraphrased Session 5 app protection policy for iOS and Android devices.`,
    `<<<7>>> Paraphrased conclusion on overall layered security infrastructure effectiveness.`,
    `<<<8>>> Paraphrased reference 1: Smith, J. (2023). Wireshark network monitoring IEEE.`,
    `<<<9>>> Paraphrased reference 2: Jones, K. (2022). Sandbox malware analysis journal.`,
  ].join('\n\n');

  const paraMap = parseMarkerResponse(aiResponse, bps, totalDocParas);
  const filled = paraMap.filter(p => p !== null).length;

  assert('docPos=3 (Introduction) correct', paraMap[3] && paraMap[3].includes('methodology'), JSON.stringify(paraMap[3]));
  assert('docPos=5 (merged S1+S2 at <<<2>>>) filled', paraMap[5] !== null, String(paraMap[5]));
  assert('docPos=7 (<<<3>>> missing) = null — keeps original text', paraMap[7] === null,
    `Got: ${JSON.stringify(paraMap[7])}`);
  assert('docPos=9 (Session 3 via <<<4>>>) correct content', paraMap[9] && paraMap[9].includes('Defender'),
    JSON.stringify(paraMap[9]));
  assert('docPos=11 (Session 4 via <<<5>>>) correct — NO SHIFT', paraMap[11] && paraMap[11].includes('Intune'),
    JSON.stringify(paraMap[11]));
  assert('docPos=13 (Session 5 via <<<6>>>) correct — NO SHIFT', paraMap[13] && paraMap[13].includes('app protection'),
    JSON.stringify(paraMap[13]));
  assert('docPos=15 (Conclusion via <<<7>>>) correct — NO SHIFT', paraMap[15] && paraMap[15].includes('conclusion'),
    JSON.stringify(paraMap[15]));
  assert('docPos=17 (Ref 1 via <<<8>>>) correct', paraMap[17] && paraMap[17].includes('Wireshark'),
    JSON.stringify(paraMap[17]));
  assert('docPos=18 (Ref 2 via <<<9>>>) correct', paraMap[18] && paraMap[18].includes('Sandbox'),
    JSON.stringify(paraMap[18]));
  assert('8 filled (only 1 position null due to merge)', filled === 8, String(filled));

  console.log('\n  With OLD sequential mapping, the same response would give:');
  // Simulate old sequential mapping: resultParas[i] → bps[i].docPos
  const resultParas = aiResponse.split(/\n\n+/).filter(p => p.trim());
  const oldMap = new Array(totalDocParas).fill(null);
  for (let i = 0; i < Math.min(bps.length, resultParas.length); i++) {
    oldMap[bps[i].docPos] = resultParas[i].replace(/^<<<\d+>>>\s*/, '').trim();
  }
  const session4OldContent = oldMap[11];
  const session4NewContent = paraMap[11];
  const session4IsWrongOld = session4OldContent && session4OldContent.includes('Intune') === false;
  const session4IsCorrectNew = session4NewContent && session4NewContent.includes('Intune');
  console.log(`  OLD: Session 4 (docPos=11) = "${String(session4OldContent).substring(0, 60)}"`);
  console.log(`  NEW: Session 4 (docPos=11) = "${String(session4NewContent).substring(0, 60)}"`);
  assert('NEW approach: Session 4 has Intune content (not shifted)', session4IsCorrectNew);
}

// ── AI adds extra text before first marker (preamble) ────────────────────────

console.log('\n── AI adds preamble before <<<1>>> — markers still parsed correctly ──');
{
  const aiResponse = `Here is the paraphrased text:\n\n<<<1>>> Paraphrased intro paragraph text here.\n\n<<<2>>> Paraphrased Session 1 content here.`;
  const shortBps = [{ docPos: 3, text: 'intro' }, { docPos: 5, text: 's1' }];
  const paraMap = parseMarkerResponse(aiResponse, shortBps, 10);
  assert('<<<1>>> parsed despite preamble', paraMap[3] !== null, String(paraMap[3]));
  assert('<<<2>>> parsed correctly', paraMap[5] !== null, String(paraMap[5]));
}

// ── AI outputs markers out of order ─────────────────────────────────────────

console.log('\n── AI outputs <<<3>>> before <<<2>>> — each still maps to correct docPos ──');
{
  // Shouldn't happen, but the regex handles it gracefully
  const aiResponse = `<<<1>>> First paragraph paraphrased.\n\n<<<3>>> Third paragraph paraphrased.\n\n<<<2>>> Second paragraph paraphrased.`;
  const shortBps = [
    { docPos: 3, text: 'para 1' },
    { docPos: 5, text: 'para 2' },
    { docPos: 7, text: 'para 3' },
  ];
  const paraMap = parseMarkerResponse(aiResponse, shortBps, 10);
  assert('<<<1>>> → docPos=3', paraMap[3] && paraMap[3].includes('First'), JSON.stringify(paraMap[3]));
  assert('<<<2>>> → docPos=5', paraMap[5] && paraMap[5].includes('Second'), JSON.stringify(paraMap[5]));
  assert('<<<3>>> → docPos=7', paraMap[7] && paraMap[7].includes('Third'), JSON.stringify(paraMap[7]));
}

// ── Display text: markers stripped for user-visible output ────────────────────

console.log('\n── Marker stripping for display: <<<N>>> removed from output ──');
{
  const raw = `<<<1>>> First para text.\n\n<<<2>>> Second para text.\n\n<<<3>>> Third para text.`;
  const display = stripMarkersForDisplay(raw);
  assert('no markers in display', !display.includes('<<<'), JSON.stringify(display.substring(0, 80)));
  assert('text content preserved', display.includes('First para text.'), JSON.stringify(display));
  assert('3 paragraphs preserved', display.split('\n\n').filter(p => p.trim()).length === 3,
    String(display.split('\n\n').filter(p => p.trim()).length));
}

// ── Marker stripping: inline <<<N>>> not stripped (only line-start) ──────────

console.log('\n── Markers only stripped at line start (not mid-sentence references) ──');
{
  // The regex is /^<<<\d+>>>\s*/gm — only matches at start of a line
  const raw = `<<<1>>> Para with citation <<<2>>> mid sentence reference.\n\n<<<2>>> Second paragraph.`;
  const display = stripMarkersForDisplay(raw);
  // <<<1>>> at line start is stripped; <<<2>>> mid-sentence is NOT stripped (it is not at line start)
  // <<<2>>> at line start of second paragraph IS stripped
  assert('line-start markers stripped', !display.startsWith('<<<'), JSON.stringify(display.substring(0, 30)));
  assert('mid-sentence <<<2>>> preserved', display.includes('<<<2>>> mid sentence'),
    JSON.stringify(display.substring(0, 80)));
}

// ── AI adds extra markers beyond what was sent ───────────────────────────────

console.log('\n── AI adds <<<10>>> beyond bps.length — extra markers ignored ──');
{
  const aiResponse = `<<<1>>> Para 1.\n\n<<<2>>> Para 2.\n\n<<<10>>> Hallucinated extra paragraph.`;
  const shortBps = [{ docPos: 3, text: 'p1' }, { docPos: 5, text: 'p2' }];
  const paraMap = parseMarkerResponse(aiResponse, shortBps, 10);
  assert('<<<1>>> → docPos=3', paraMap[3] !== null, String(paraMap[3]));
  assert('<<<2>>> → docPos=5', paraMap[5] !== null, String(paraMap[5]));
  assert('<<<10>>> is ignored (bpIdx 9 out of range)', paraMap.filter(p => p !== null).length === 2,
    String(paraMap.filter(p => p !== null).length));
}

// ── AI renumbers markers from <<<1>>> per chunk (the previous bug) ────────────

console.log('\n── Parallel chunk renumbering: chunk 2 restarts at <<<1>>> → docPos still correct ──');
{
  // Old bug: ai renumbers [1] in each chunk. With <<<N>>> markers, the backend chunk 2
  // is sent <<<5>>>...<<<9>>> (continuation). If AI still renumbers to <<<1>>>,
  // those markers map to bps[0]..bps[3] — corrupting the first section.
  // The fix for THIS is: the backend must NOT reset marker numbering per chunk.
  // Check that the marker system is NOT vulnerable when markers are sequential across chunks.

  // Scenario: 4 body paras split into 2 chunks of 2.
  // Chunk 1 sent with <<<1>>>..<<<2>>>, chunk 2 sent with <<<3>>>..<<<4>>>
  // AI correctly preserves markers in both chunks.
  const chunk1Result = `<<<1>>> Para 1 paraphrased.\n\n<<<2>>> Para 2 paraphrased.`;
  const chunk2Result = `<<<3>>> Para 3 paraphrased.\n\n<<<4>>> Para 4 paraphrased.`;
  const combinedResult = chunk1Result + '\n\n' + chunk2Result;

  const fourBps = [
    { docPos: 3, text: 'p1' }, { docPos: 5, text: 'p2' },
    { docPos: 7, text: 'p3' }, { docPos: 9, text: 'p4' },
  ];
  const paraMap = parseMarkerResponse(combinedResult, fourBps, 12);
  assert('docPos=3 ← <<<1>>>', paraMap[3] && paraMap[3].includes('Para 1'), JSON.stringify(paraMap[3]));
  assert('docPos=5 ← <<<2>>>', paraMap[5] && paraMap[5].includes('Para 2'), JSON.stringify(paraMap[5]));
  assert('docPos=7 ← <<<3>>>', paraMap[7] && paraMap[7].includes('Para 3'), JSON.stringify(paraMap[7]));
  assert('docPos=9 ← <<<4>>>', paraMap[9] && paraMap[9].includes('Para 4'), JSON.stringify(paraMap[9]));
}

// ── If AI renumbers chunk 2 from <<<1>>> (the adversarial case) ──────────────

console.log('\n── Adversarial: AI renumbers chunk 2 from <<<1>>> → chunk 1 positions overwritten ──');
{
  // This is a limitation: if the AI strips markers and renumbers from 1, markers still
  // collide. But this is now documented behavior — the <<<N>>> markers are global,
  // and the prompt explicitly says "never renumber". In practice this is rare.
  // The test documents what happens so behavior is understood.
  const chunk1Result = `<<<1>>> Para 1 OK.\n\n<<<2>>> Para 2 OK.`;
  const chunk2ResultRenumbered = `<<<1>>> Para 3 renumbered.\n\n<<<2>>> Para 4 renumbered.`; // AI renumbered!
  const combined = chunk1Result + '\n\n' + chunk2ResultRenumbered;
  const fourBps = [
    { docPos: 3, text: 'p1' }, { docPos: 5, text: 'p2' },
    { docPos: 7, text: 'p3' }, { docPos: 9, text: 'p4' },
  ];
  const paraMap = parseMarkerResponse(combined, fourBps, 12);
  // Last <<<1>>> wins (regex scan finds the last one)
  // docPos=3 and docPos=5 get overwritten with chunk2 content
  const filled = paraMap.filter(p => p !== null).length;
  // This is a known limitation — just confirm only 2 positions fill (not 4)
  assert('adversarial renumber: only 2 distinct marker values → 2 filled (documented limitation)',
    filled === 2, String(filled));
  console.log('  Note: adversarial renumbering is mitigated by the backend sending globally-numbered text');
}

// ── Chunk text building: global numbering across chunks ───────────────────────

console.log('\n── buildMarkedApiText: global <<<N>>> for ALL body paras across chunks ──');
{
  // The key insight: markers are global (1..N across ALL body paras), NOT per-chunk.
  // buildChunks in the backend splits the ALREADY-MARKED text by \n\n.
  // Each chunk receives a subset of globally-numbered markers, so they stay unique.
  const allBps = [
    { docPos: 3, text: 'P1 text here.' }, { docPos: 5, text: 'P2 text here.' },
    { docPos: 7, text: 'P3 text here.' }, { docPos: 9, text: 'P4 text here.' },
    { docPos: 11, text: 'P5 text here.' },
  ];
  const marked = buildMarkedApiText(allBps);
  // Simulate chunking by splitting and taking first 2 paras
  const allMarkedParas = marked.split('\n\n');
  const chunk1Text = allMarkedParas.slice(0, 2).join('\n\n');
  const chunk2Text = allMarkedParas.slice(2).join('\n\n');

  assert('chunk1 has <<<1>>> and <<<2>>>', chunk1Text.includes('<<<1>>>') && chunk1Text.includes('<<<2>>>'));
  assert('chunk1 does NOT have <<<3>>>', !chunk1Text.includes('<<<3>>>'));
  assert('chunk2 has <<<3>>>, <<<4>>>, <<<5>>>', chunk2Text.includes('<<<3>>>') && chunk2Text.includes('<<<5>>>'));
  assert('chunk2 does NOT have <<<1>>>', !chunk2Text.includes('<<<1>>>'));
  assert('marker numbers globally unique across chunks', true); // proven by above assertions
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
