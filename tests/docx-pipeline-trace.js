'use strict';
// Full pipeline trace for the DOCX paraphrase + reassembly path.
// Shows EXACTLY where scrambling happens when the AI changes paragraph count.
// Uses the same logic as index.html + api/process.js.

// ─── Mirror helpers from index.html ──────────────────────────────────────────

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
function pptxEncodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// From api/process.js
function countWordsApprox(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
function buildChunks(text, targetWords = 400, maxChunks = 12) {
  const words = countWordsApprox(text);
  const chunkCount = Math.max(1, Math.min(maxChunks, Math.ceil(words / targetWords)));
  if (chunkCount === 1) return [text];
  const target = Math.ceil(words / chunkCount);
  const paras = text.split(/\n\n+/).filter(p => p.trim());
  const chunks = [];
  let cur = [], curWords = 0;
  for (const para of paras) {
    const pw = countWordsApprox(para);
    if (curWords >= target && chunks.length < chunkCount - 1) {
      chunks.push(cur.join('\n\n'));
      cur = []; curWords = 0;
    }
    cur.push(para); curWords += pw;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

function docxReplaceParasAbsolute(xml, paraArray) {
  let absPos = 0;
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    const idx = absPos++;
    const newText = (idx < paraArray.length) ? paraArray[idx] : null;
    if (!newText) return para;
    const origText = para.replace(/<[^>]+>/g, '').trim();
    if (newText.length < origText.length * 0.3) return para;
    let firstDone = false;
    return para.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g, (m, open, txt, close) => {
      if (!txt.trim()) return m;
      if (!firstDone) { firstDone = true; return open + pptxEncodeXml(newText) + close; }
      return open + close;
    });
  });
}

// ─── Build synthetic multi-section lab report XML ─────────────────────────────

function h(style, text) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function p(text) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

// Lab report: title block, 7 sections each with a heading + one body para, references
const sections = [
  'Introduction',
  'Session 1: Wireshark Deep Packet Inspection',
  'Session 2: Joe Sandbox Malware Analysis',
  'Session 3: Windows Defender Observation',
  'Session 4: Intune Configuration Policy',
  'Session 5: App Protection Policy',
  'Conclusion',
];
const bodyTexts = [
  'This security lab report documents five assessment sessions covering network analysis, malware detection, endpoint protection, and mobile device management using industry-standard tools and platforms throughout the semester.',
  'Deep packet inspection analysis was performed using Wireshark to capture and examine network traffic between the host machine and external endpoints, identifying normal communication patterns and flagging anomalous packet sequences for further review.',
  'Malware sandbox execution was conducted in Joe Sandbox to dynamically analyse a suspicious executable sample, revealing API call sequences, registry modifications, and network connections consistent with spyware behaviour in a controlled isolated environment.',
  'Windows Defender real-time protection was observed during a controlled payload detonation exercise using Screenshot 3.1, confirming that the endpoint detection and response module triggered successfully upon detecting the simulated ransomware execution attempt.',
  'Intune device configuration policy deployment was tested across a fleet of managed Windows endpoints, verifying that compliance rules for BitLocker encryption, firewall state, and automatic update settings were enforced within the expected policy sync interval.',
  'App protection policies were applied to managed iOS and Android devices through Microsoft Intune to enforce data loss prevention controls, restricting copy-paste operations and requiring PIN authentication before accessing corporate application data on personal devices.',
  'The five sessions collectively demonstrated the effectiveness of a layered security approach combining network-level visibility, behavioural malware analysis, host-based endpoint detection, and mobile device management policies across the organisations security infrastructure.',
];

const xmlParas = [
  p('Student Name: John Smith'),     // short → skip
  p('Module: CS4001 Cyber Security'), // short → skip (only 5 words but < 25 chars... actually let me count)
  h('Heading1', 'Introduction'),     // heading → skip
  p(bodyTexts[0]),                   // body[0]
  h('Heading1', 'Session 1: Wireshark Deep Packet Inspection'), // heading → skip
  p(bodyTexts[1]),                   // body[1]
  h('Heading1', 'Session 2: Joe Sandbox Malware Analysis'),     // heading → skip
  p(bodyTexts[2]),                   // body[2]
  h('Heading1', 'Session 3: Windows Defender Observation'),     // heading → skip
  p(bodyTexts[3]),                   // body[3]
  h('Heading1', 'Session 4: Intune Configuration Policy'),      // heading → skip
  p(bodyTexts[4]),                   // body[4]
  h('Heading1', 'Session 5: App Protection Policy'),            // heading → skip
  p(bodyTexts[5]),                   // body[5]
  h('Heading1', 'Conclusion'),       // heading → skip
  p(bodyTexts[6]),                   // body[6]
  h('Heading1', 'References'),       // heading → skip
  p('[1] Smith, J. (2023). Network Security Monitoring with Wireshark. IEEE Transactions on Information Security, 15(3), 45-67.'),   // body[7] — substantial reference
  p('[2] Jones, K. (2022). Dynamic Malware Analysis Techniques Using Sandbox Environments. Journal of Cybersecurity Research, 8(1), 12-34.'), // body[8]
];
const docXml = xmlParas.join('\n');

// ─── STEP 1: Extraction ───────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('STEP 1: EXTRACTION — original paragraph inventory');
console.log('══════════════════════════════════════════════════════');

const { bodyParas, totalDocParas } = extractBodyParasWithPos(docXml);

// Log all paragraphs
const allParas = docXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
allParas.forEach((para, docPos) => {
  const t = para.replace(/<[^>]+>/g, '').trim();
  const isH = isDocxHeading(para);
  const isSkip = docxSkip(t);
  const isSub = isSubstantialPara(t);
  const kind = isH ? 'HEADING' : (!isSub || isSkip) ? 'SKIP   ' : 'BODY   ';
  const bodyIdx = bodyParas.findIndex(b => b.docPos === docPos);
  const bodyTag = bodyIdx >= 0 ? ` [body[${bodyIdx}]]` : '';
  console.log(`  docPos=${String(docPos).padStart(2)} ${kind}${bodyTag}: "${t.substring(0, 55)}${t.length > 55 ? '…' : ''}"`);
});

console.log(`\n→ ${totalDocParas} total paras, ${bodyParas.length} body paras (sent to API)`);
console.log(`→ Body para docPositions: [${bodyParas.map(b => b.docPos).join(', ')}]`);

// ─── STEP 2: Chunking ─────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('STEP 2: CHUNKING — how body text is split for parallel API calls');
console.log('══════════════════════════════════════════════════════');

const apiText = bodyParas.map(b => b.text).join('\n\n');
const chunks = buildChunks(apiText);
let chunkBodyMap = []; // chunkBodyMap[chunkIdx] = [bodyIdx, ...]

let bi = 0;
chunks.forEach((chunk, ci) => {
  const chunkParas = chunk.split(/\n\n+/).filter(p => p.trim());
  const bodyIndices = [];
  chunkParas.forEach(() => { bodyIndices.push(bi++); });
  chunkBodyMap.push(bodyIndices);
  console.log(`\n  Chunk ${ci} (${chunkParas.length} body paras, ${countWordsApprox(chunk)} words):`);
  bodyIndices.forEach(bIdx => {
    const bp = bodyParas[bIdx];
    console.log(`    body[${bIdx}] docPos=${bp.docPos}: "${bp.text.substring(0, 55)}…"`);
  });
});

// ─── STEP 3: SCENARIO A — AI maintains paragraph count (ideal) ───────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('STEP 3A: SCENARIO — AI returns EXACT count (ideal)');
console.log('══════════════════════════════════════════════════════');

function simulatePerfectAI(bodyParasSlice) {
  return bodyParasSlice.map(bp => `Paraphrased: ${bp.text.substring(0, 40)}… [rewritten]`);
}

const perfectChunkResults = chunks.map((_, ci) => {
  return simulatePerfectAI(chunkBodyMap[ci].map(bIdx => bodyParas[bIdx]));
});
const perfectAssembled = perfectChunkResults.map(r => r.join('\n\n')).join('\n\n');
const perfectResultParas = perfectAssembled.split(/\n\n+/).filter(p => p.trim());

console.log(`\n  AI returned ${perfectResultParas.length} paras (expected ${bodyParas.length}) — ${perfectResultParas.length === bodyParas.length ? '✅ COUNT MATCHES' : '❌ MISMATCH'}`);

const perfectMap = new Array(totalDocParas).fill(null);
for (let i = 0; i < Math.min(bodyParas.length, perfectResultParas.length); i++) {
  perfectMap[bodyParas[i].docPos] = perfectResultParas[i];
  console.log(`  body[${i}] docPos=${bodyParas[i].docPos} ← "${perfectResultParas[i].substring(0, 50)}"`);
}

// Verify: check which section each result ended up under
console.log('\n  FINAL DOCUMENT ORDER (perfect AI):');
allParas.forEach((para, docPos) => {
  const t = para.replace(/<[^>]+>/g, '').trim();
  const content = perfectMap[docPos] || t;
  const marker = perfectMap[docPos] ? '✅ REPLACED' : (isDocxHeading(para) ? '   heading' : '   kept   ');
  console.log(`  pos${String(docPos).padStart(2)} ${marker}: "${content.substring(0, 60)}${content.length > 60 ? '…' : ''}"`);
});

// ─── STEP 4: SCENARIO B — AI MERGES paragraphs (the real-world bug) ──────────

console.log('\n══════════════════════════════════════════════════════');
console.log('STEP 3B: SCENARIO — AI MERGES body[1] and body[2] in chunk 0 → COUNT MISMATCH');
console.log('══════════════════════════════════════════════════════');

// Simulate: chunk 0 AI merges body[1] (Session 1) and body[2] (Session 2) into one paragraph
// This is exactly the kind of thing that causes scrambling in practice
const mergedChunkResults = chunks.map((_, ci) => {
  const bodySlice = chunkBodyMap[ci].map(bIdx => bodyParas[bIdx]);
  if (ci === 0 && bodySlice.length >= 3) {
    // AI merges body[1] and body[2]
    const merged = [
      `Paraphrased: ${bodySlice[0].text.substring(0, 40)}… [rewritten]`,
      `MERGED_S1_S2: ${bodySlice[1].text.substring(0, 20)}… + ${bodySlice[2].text.substring(0, 20)}…`,
      // body[3] and beyond shift up by 1
      ...bodySlice.slice(3).map(bp => `Paraphrased: ${bp.text.substring(0, 40)}… [rewritten]`),
    ];
    console.log(`\n  Chunk 0 ORIGINALLY had ${bodySlice.length} body paras, AI returned ${merged.length}:`);
    merged.forEach((r, i) => console.log(`    result[${i}]: "${r.substring(0, 65)}"`));
    return merged;
  }
  return simulatePerfectAI(bodySlice);
});

const mergedAssembled = mergedChunkResults.map(r => r.join('\n\n')).join('\n\n');
const mergedResultParas = mergedAssembled.split(/\n\n+/).filter(p => p.trim());

console.log(`\n  AI returned ${mergedResultParas.length} total paras (expected ${bodyParas.length}) — ${mergedResultParas.length === bodyParas.length ? '✅ COUNT MATCHES' : '❌ COUNT MISMATCH — SCRAMBLING AHEAD'}`);

const mergedMap = new Array(totalDocParas).fill(null);
for (let i = 0; i < Math.min(bodyParas.length, mergedResultParas.length); i++) {
  mergedMap[bodyParas[i].docPos] = mergedResultParas[i];
}

console.log('\n  SEQUENTIAL MAPPING (current code — shows the bug):');
for (let i = 0; i < Math.min(bodyParas.length, mergedResultParas.length); i++) {
  const bp = bodyParas[i];
  const got = mergedResultParas[i];
  const expected = `Paraphrased: ${bp.text.substring(0, 40)}… [rewritten]`;
  const isWrong = !got.includes(bp.text.substring(0, 20)) && i > 0 && mergedResultParas.length < bodyParas.length;
  console.log(`  body[${i}] docPos=${bp.docPos} ← "${got.substring(0, 55)}" ${isWrong ? '⚠️ WRONG CONTENT' : ''}`);
}
if (mergedResultParas.length < bodyParas.length) {
  const missing = bodyParas.slice(mergedResultParas.length);
  missing.forEach(bp => console.log(`  body[?] docPos=${bp.docPos} ← NULL (keeps original) — body para was lost`));
}

console.log('\n  FINAL DOCUMENT ORDER (merged AI — SCRAMBLED):');
allParas.forEach((para, docPos) => {
  const t = para.replace(/<[^>]+>/g, '').trim();
  const content = mergedMap[docPos] || t;
  const isH = isDocxHeading(para);
  if (isH) {
    console.log(`  pos${String(docPos).padStart(2)}    heading: "${t}"`);
  } else if (mergedMap[docPos]) {
    // Check if content belongs here
    const bodyIdx = bodyParas.findIndex(b => b.docPos === docPos);
    const originalText = bodyIdx >= 0 ? bodyParas[bodyIdx].text : '';
    const contentBelongsHere = content.includes(originalText.substring(0, 15));
    console.log(`  pos${String(docPos).padStart(2)} ${contentBelongsHere ? '✅ correct' : '❌ WRONG  '}: "${content.substring(0, 60)}…"`);
  } else {
    console.log(`  pos${String(docPos).padStart(2)}    kept   : "${t.substring(0, 60)}${t.length > 60 ? '…' : ''}"`);
  }
});

// ─── STEP 5: Show what the fix must look like ────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('STEP 4: ROOT CAUSE IDENTIFIED');
console.log('══════════════════════════════════════════════════════');
console.log(`
  The absolute-position map correctly handles heading-vs-body alignment.
  It does NOT handle AI paragraph count changes.

  Proof:
  • Body paras sent:    ${bodyParas.length}
  • API returned:       ${mergedResultParas.length} (AI merged 2 paras in chunk 0)
  • Mapping loop runs: Math.min(${bodyParas.length}, ${mergedResultParas.length}) = ${Math.min(bodyParas.length, mergedResultParas.length)} iterations
  • result[i] → bodyParas[i].docPos is SEQUENTIAL
  • After the merge point, result[i] contains the WRONG paragraph's text
  • One body paragraph is lost (null) and keeps its original text

  Sequential mapping after a count mismatch:
  body[0] docPos=${bodyParas[0]?.docPos} ← result[0]  (correct: Introduction body)
  body[1] docPos=${bodyParas[1]?.docPos} ← result[1]  (correct: Session 1 body — if merge didn't affect it)
  body[2] docPos=${bodyParas[2]?.docPos} ← result[2]  MERGED S1+S2 content written here (should be S2 body only)
  body[3] docPos=${bodyParas[3]?.docPos} ← result[3]  S2 paraphrase written here (should be S3 body!)  ← SCRAMBLED
  body[4] docPos=${bodyParas[4]?.docPos} ← result[4]  S3 paraphrase written here (should be S4 body!)  ← SCRAMBLED
  ...every para from the merge point onward is off by 1

  FIX: tag each body para with its body index so the AI returns position-keyed output.
  Use <<<N>>> delimiters (not [N] — avoids renumbering; not whitespace — avoids merging).
`);

console.log('══════════════════════════════════════════════════════');
console.log('STEP 5: PROPOSED FIX — <<<N>>> positional markers');
console.log('══════════════════════════════════════════════════════');
console.log(`
  Send body paragraphs to the API tagged with <<<N>>> markers:

    <<<1>>> Introduction body text here...
    <<<2>>> Session 1 Wireshark body text...
    <<<3>>> Session 2 Joe Sandbox body text...
    ...

  Prompt addition: "Lines starting with <<<N>>> are position markers.
  Keep them EXACTLY as-is. Only paraphrase the text on the same line."

  Parse result by finding <<<N>>> occurrences:
    <<<1>>> found → write text to bodyParas[0].docPos
    <<<2>>> found → write text to bodyParas[1].docPos
    <<<3>>> MISSING (AI merged) → bodyParas[2] keeps original text ✓
    <<<4>>> found → write text to bodyParas[3].docPos ✓ (Session 3 lands correctly)

  With markers, a merge doesn't cascade. Each <<<N>>> is self-contained.
  Position is determined by the marker, NOT by sequential order.
`);
