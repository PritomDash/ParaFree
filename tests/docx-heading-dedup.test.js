'use strict';
// Diagnostic tests for two remaining DOCX bugs:
//   1. HEADING/BODY OFFSET — heading appears after the paragraph it should introduce
//   2. DUPLICATED PARAGRAPHS — same content appears twice (once paraphrased, once original)
//
// Goal: reproduce each bug in a unit test, then verify the fix.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror helpers (must stay in sync with index.html) ───────────────────────

function isDocxHeading(paraXml) {
  const styleM = paraXml.match(/<w:pStyle\s+w:val="([^"]+)"/i);
  if (styleM) {
    const s = styleM[1];
    // Covers: Heading1, Heading 2, Heading_3, heading4, Title, Subtitle, TOCHeading
    if (/^Heading[\s_\d]/i.test(s) || /^(Title|Subtitle|TOCHeading)$/i.test(s)) return true;
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
function stripDocxRevisionMarks(xml) {
  return xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');
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

// Simplified replacement (mirrors docxReplaceParasAbsolute logic)
function replaceAbsolute(xml, paraArray) {
  let absPos = 0;
  const output = []; // collect [absPos, original, replacement|null]
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    if (para.includes('\x00TBL')) return para;
    const idx = absPos++;
    const newText = (idx < paraArray.length) ? paraArray[idx] : null;
    const origText = para.replace(/<[^>]+>/g, '').trim();
    output.push({ absPos: idx, orig: origText, replacement: newText || null });
    if (!newText) return para;
    if (newText.length < origText.length * 0.3) return para;
    let firstDone = false;
    return para.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g, (m, open, txt, close) => {
      if (!txt.trim()) return m;
      if (!firstDone) { firstDone = true; return open + pptxEncodeXml(newText) + close; }
      return open + close;
    });
  });
  return { result, log: output };
}

// Count <w:p> elements in xml
function countParas(xml) {
  return (xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []).length;
}

// Stash tables (mirror of downloadAsDOCX)
function stashTables(xml) {
  const stash = [];
  const stashed = xml.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, match => {
    stash.push(match);
    return '\x00TBL' + (stash.length - 1) + '\x00';
  });
  return { stashed, stash };
}

// ── XML builders ──────────────────────────────────────────────────────────────

function h1(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function h2(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function body(text) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function shortPara(text) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 1: COUNT CONSISTENCY (extraction vs replacement para counts)
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 1: Count consistency — extraction vs replacement ══════');

{
  // Simple: no tables, 3 headings + 3 bodies
  const xml = [
    h1('Introduction'), body('Introduction body about the lab report methodology and sessions overview.'),
    h1('Session 1'), body('Session 1 body about Wireshark deep packet inspection analysis procedures.'),
    h1('Conclusion'), body('Conclusion body about effectiveness of all five security assessment sessions.'),
  ].join('\n');

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  const { stashed } = stashTables(xml);
  const stashedCount = countParas(stashed);

  assert('Group1: extraction count = stashed count (no tables)', totalDocParas === stashedCount,
    `extraction=${totalDocParas}, stashed=${stashedCount}`);
  assert('Group1: 3 body paras extracted', bodyParas.length === 3, String(bodyParas.length));
  assert('Group1: body docPos values skip heading positions',
    bodyParas[0].docPos === 1 && bodyParas[1].docPos === 3 && bodyParas[2].docPos === 5,
    bodyParas.map(b => b.docPos).join(','));
}

{
  // With a table in the middle
  const table = `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const xml = [
    h1('Introduction'), body('Introduction body about the lab report and methodology.'),
    table,
    h1('Session 1'), body('Session 1 body about Wireshark deep packet inspection.'),
  ].join('\n');

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  const { stashed } = stashTables(xml);
  const stashedCount = countParas(stashed);

  assert('Group1: extraction count = stashed count (with table)', totalDocParas === stashedCount,
    `extraction=${totalDocParas}, stashed=${stashedCount}`);
  assert('Group1: table-internal paras NOT counted in either path', bodyParas.length === 2,
    `got ${bodyParas.length} body paras`);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 2: HEADING/BODY ORDERING — headings appear BEFORE their body
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 2: Heading/body ordering in replacement output ══════');

{
  // Lab report with 7 sections — simulate the user's actual document
  const bodyTexts = [
    'This security lab report documents five assessment sessions covering network analysis and detection.',
    'Deep packet inspection was performed using Wireshark to capture and examine network traffic patterns.',
    'Malware sandbox execution was conducted in Joe Sandbox to dynamically analyse suspicious executables.',
    'Windows Defender real-time protection was observed during a controlled payload detonation exercise.',
    'Intune device configuration policy deployment was tested across a fleet of managed Windows endpoints.',
    'App protection policies were applied to managed iOS and Android devices through Microsoft Intune.',
    'The five sessions collectively demonstrated the effectiveness of a layered security approach.',
  ];
  const headings = ['Introduction', 'Session 1: Wireshark', 'Session 2: Joe Sandbox',
    'Session 3: Windows Defender', 'Session 4: Intune', 'Session 5: App Protection', 'Conclusion'];

  const xmlParas = [];
  headings.forEach((h, i) => {
    xmlParas.push(h1(h));
    xmlParas.push(body(bodyTexts[i]));
  });
  const xml = xmlParas.join('\n');

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('Group2: 7 body paras extracted', bodyParas.length === 7, String(bodyParas.length));
  assert('Group2: totalDocParas = 14', totalDocParas === 14, String(totalDocParas));

  // Simulate perfect AI paraphrase
  const aiResponse = bodyParas.map((bp, i) =>
    `<<<${i + 1}>>> PARAPHRASED[${i + 1}]: ${bp.text.substring(0, 40)}`
  ).join('\n\n');

  const paraMap = parseMarkerResponse(aiResponse, bodyParas, totalDocParas);

  // Verify: each heading at docPos=even has null (kept); each body at docPos=odd has replacement
  for (let i = 0; i < headings.length; i++) {
    const headingDocPos = i * 2;
    const bodyDocPos = i * 2 + 1;
    assert(`Group2: ${headings[i]} heading (docPos=${headingDocPos}) = null`,
      paraMap[headingDocPos] === null, String(paraMap[headingDocPos]));
    assert(`Group2: body (docPos=${bodyDocPos}) has replacement`,
      paraMap[bodyDocPos] !== null && paraMap[bodyDocPos].includes(`PARAPHRASED[${i + 1}]`),
      String(paraMap[bodyDocPos]));
  }

  // Verify document order in replacement output
  const { stashed } = stashTables(xml);
  const { log } = replaceAbsolute(stashed, paraMap);

  // Check: heading always has absPos BEFORE its following body paragraph
  for (let i = 0; i < headings.length; i++) {
    const headingEntry = log[i * 2];
    const bodyEntry = log[i * 2 + 1];
    const headingIsKept = headingEntry.replacement === null;
    const bodyIsReplaced = bodyEntry.replacement !== null && bodyEntry.replacement.includes(`PARAPHRASED[${i + 1}]`);
    assert(`Group2: heading '${headings[i]}' kept (no replacement)`, headingIsKept,
      `got replacement: ${headingEntry.replacement}`);
    assert(`Group2: body after '${headings[i]}' is replaced with correct content`, bodyIsReplaced,
      `got: ${bodyEntry.replacement ? bodyEntry.replacement.substring(0, 40) : 'null'}`);
    assert(`Group2: heading absPos (${headingEntry.absPos}) < body absPos (${bodyEntry.absPos})`,
      headingEntry.absPos < bodyEntry.absPos);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 3: SUB-HEADINGS — H1 → H2 → body nesting
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 3: Sub-headings (H1 → H2 → body) ══════');

{
  // Section with H1, then H2 sub-sections, each with body
  const xml = [
    h1('Session 3: Windows Defender Observation'),
    h2('Observation'),
    body('Windows Defender real-time protection was observed during payload detonation with Screenshot 3.1.'),
    h2('Comparison with Joe Sandbox'),
    body('Comparison between Joe Sandbox and Windows Defender shows both tools identify the same malware.'),
    h2('Relationship between the four policies'),
    body('The four policies form an interconnected system where violations in one can trigger responses in others.'),
  ].join('\n');

  const { bodyParas, totalDocParas } = extractBodyParasWithPos(xml);
  assert('Group3: 3 body paras extracted (headings H1+H2 all skipped)', bodyParas.length === 3,
    String(bodyParas.length));
  assert('Group3: totalDocParas = 7', totalDocParas === 7, String(totalDocParas));

  // docPos assignments: H1=0, H2=1, body=2, H2=3, body=4, H2=5, body=6
  assert('Group3: body[0] docPos=2', bodyParas[0].docPos === 2, String(bodyParas[0].docPos));
  assert('Group3: body[1] docPos=4 ("Comparison" body)', bodyParas[1].docPos === 4, String(bodyParas[1].docPos));
  assert('Group3: body[2] docPos=6 ("Relationship" body)', bodyParas[2].docPos === 6, String(bodyParas[2].docPos));

  // Verify the sub-heading texts ARE the heading texts (to see if they could look like duplication)
  const compWithJoeHeading = xml.match(/<w:p><w:pPr><w:pStyle w:val="Heading2".*?<\/w:p>/gs)
    ?.[1]?.replace(/<[^>]+>/g, '').trim();
  const compWithJoeBody = bodyParas[1].text;
  console.log(`  H2 heading: "${compWithJoeHeading}"`);
  console.log(`  Body below: "${compWithJoeBody.substring(0, 60)}…"`);

  // The H2 heading "Comparison with Joe Sandbox" is SHORT (< 25 chars but > 5 words)
  // Actually let's check: "Comparison with Joe Sandbox" = 31 chars, 4 words
  const headingText = 'Comparison with Joe Sandbox';
  assert('Group3: heading text isSubstantialPara check (< 5 words → skipped as heading anyway)',
    !isSubstantialPara(headingText) || isDocxHeading(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${headingText}</w:t></w:r></w:p>`
    ));

  // Simulate: AI sees 3 body paras (NOT the headings) and returns 3 paraphrases
  const aiResponse = bodyParas.map((bp, i) =>
    `<<<${i + 1}>>> Paraphrased: ${bp.text.substring(0, 45)}`
  ).join('\n\n');
  const paraMap = parseMarkerResponse(aiResponse, bodyParas, totalDocParas);

  // Check that headings stay null (kept) and bodies are paraphrased
  assert('Group3: H1 (docPos=0) = null', paraMap[0] === null);
  assert('Group3: H2 "Observation" (docPos=1) = null', paraMap[1] === null);
  assert('Group3: body[0] (docPos=2) filled', paraMap[2] !== null);
  assert('Group3: H2 "Comparison" (docPos=3) = null', paraMap[3] === null);
  assert('Group3: body[1] "Comparison body" (docPos=4) filled', paraMap[4] !== null);
  assert('Group3: H2 "Relationship" (docPos=5) = null', paraMap[5] === null);
  assert('Group3: body[2] "Relationship body" (docPos=6) filled', paraMap[6] !== null);

  // Run replacement and verify order
  const { stashed } = stashTables(xml);
  const { result, log } = replaceAbsolute(stashed, paraMap);

  // Verify: no content appears twice in the replacement output
  const bodyResults = log.filter(e => e.replacement !== null).map(e => e.replacement);
  const origResults = log.filter(e => e.replacement === null).map(e => e.orig);

  for (const r of bodyResults) {
    const dupeInBody = bodyResults.filter(x => x === r).length > 1;
    assert(`Group3: replacement "${r.substring(0, 30)}" not duplicated in body results`, !dupeInBody);
  }

  // Specifically check: "Comparison with Joe Sandbox" heading text does NOT appear in body results
  const compHeadingInBodyResults = bodyResults.some(r => r.includes('Comparison with Joe Sandbox'));
  assert('Group3: "Comparison with Joe Sandbox" heading NOT paraphrased (is heading → null)', !compHeadingInBodyResults);

  // Verify headings appear BEFORE their respective body paragraphs
  const h2CompEntry = log[3]; // docPos=3 = H2 "Comparison..."
  const bodyCompEntry = log[4]; // docPos=4 = body below "Comparison..."
  assert('Group3: "Comparison" heading (absPos=3) < body (absPos=4)',
    h2CompEntry.absPos < bodyCompEntry.absPos && h2CompEntry.replacement === null);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 4: TRACK CHANGES — <w:del> text causes apparent duplication
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 4: Track Changes / revision marks (duplication source) ══════');

{
  // Word documents with Track Changes have <w:del> and <w:ins> elements.
  // <w:delText> is the OLD text. <w:t> is the NEW (inserted) text.
  // Our replacement only replaces <w:t>, so <w:delText> stays → looks like duplication.

  // Para with tracked change: deletion of old text, insertion of new text
  const trackChangesPara = `<w:p><w:r><w:ins w:id="1"><w:t>Observation of Windows Defender protection mechanisms during payload execution revealed clear detection signatures.</w:t></w:ins></w:r><w:r><w:del w:id="2"><w:delText>Windows Defender observed during payload test showed protection triggered.</w:delText></w:del></w:r></w:p>`;

  const t = trackChangesPara.replace(/<[^>]+>/g, '').trim();
  const isSubstantial = isSubstantialPara(t);
  const isHeading = isDocxHeading(trackChangesPara);
  console.log(`  Track changes para text (stripped): "${t.substring(0, 80)}"`);
  console.log(`  isSubstantial=${isSubstantial}, isHeading=${isHeading}`);
  assert('Group4: track-changes para appears substantial (combined del+ins text)', isSubstantial);
  assert('Group4: track-changes para NOT identified as heading', !isHeading);

  // This para WOULD be extracted as a body para and get a <<<N>>> marker
  const paraWithTrackChanges = trackChangesPara;
  const simpleXml = [h1('Session 3: Windows Defender'), paraWithTrackChanges].join('\n');
  const { bodyParas, totalDocParas } = extractBodyParasWithPos(simpleXml);
  assert('Group4: track-changes para extracted as body para', bodyParas.length === 1, String(bodyParas.length));

  if (bodyParas.length > 0) {
    // The extracted text includes BOTH del and ins text (all tags stripped)
    console.log(`  Extracted body text: "${bodyParas[0].text.substring(0, 80)}"`);
    const includesBothTexts = bodyParas[0].text.includes('Observation') && bodyParas[0].text.includes('observed during payload');
    assert('Group4: extracted text contains BOTH <w:t> and <w:delText> content (bug: text is combined)', includesBothTexts);

    // Simulate paraphrase
    const paraMap = new Array(totalDocParas).fill(null);
    paraMap[bodyParas[0].docPos] = 'Paraphrased observation: Defender detected the test payload successfully.';

    // Run replacement (only replaces <w:t>, leaves <w:delText> unchanged)
    const { stashed } = stashTables(simpleXml);
    const { result } = replaceAbsolute(stashed, paraMap);

    // Check the result XML
    const hasDelText = result.includes('<w:delText>Windows Defender observed during payload test showed protection triggered.</w:delText>');
    const hasNewText = result.includes('Paraphrased observation');
    assert('Group4: <w:delText> (original deleted text) STILL PRESENT after replacement',
      hasDelText, 'delText was incorrectly removed or was missing');
    assert('Group4: <w:t> has been replaced with paraphrased text', hasNewText);
    if (hasDelText && hasNewText) {
      console.log('\n  ⚠️  DUPLICATION BUG CONFIRMED:');
      console.log('     The output XML has BOTH the paraphrased text (in <w:t>)');
      console.log('     AND the original deleted text (in <w:delText>).');
      console.log('     Word will show both when Track Changes is visible.');
      console.log('     FIX: strip <w:del>...</w:del> blocks before replacement,');
      console.log('     or remove <w:delText> elements during replacement.');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 5: CUSTOM HEADING STYLES — isDocxHeading false negatives
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 5: Custom heading styles — isDocxHeading coverage ══════');

{
  // Word documents often use custom styles with non-standard names
  const customHeadingStyles = [
    'Heading1',      // ✅ should match
    'Heading 1',     // ✅ should match (space variant)
    'Heading_1',     // ❌ may not match — underscore not in regex
    'heading1',      // ✅ should match (case-insensitive)
    'Title',         // ✅ should match
    'Subtitle',      // ✅ should match
    'CustomHeader',  // ❌ should NOT match — not a heading style
  ];

  // After fix: Heading_1 now recognized ([\s_\d] regex catches underscore variant)
  const expectedResults = [true, true, true, true, true, true, false];

  customHeadingStyles.forEach((style, i) => {
    const para = `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>Section heading text here that is quite long</w:t></w:r></w:p>`;
    const result = isDocxHeading(para);
    assert(`Group5: style "${style}" → isDocxHeading=${expectedResults[i]}`, result === expectedResults[i],
      `got ${result}`);
  });

  // Test with outlineLvl (used for custom heading styles that set outline level)
  const paraWithOutlineLevel = `<w:p><w:pPr><w:pStyle w:val="CustomStyle"/><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Custom outline heading</w:t></w:r></w:p>`;
  assert('Group5: outlineLvl=1 → isDocxHeading=true (catches custom styles)', isDocxHeading(paraWithOutlineLevel));
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 6: FIX VERIFICATION — after stripping <w:del> blocks
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 6: Fix — strip <w:del> before replacement to prevent duplication ══════');

{
  // The fix: remove <w:del>...</w:del> blocks from XML before extraction and replacement.
  // This prevents delText from appearing in the output (Word already hides it if changes are accepted).

  const trackChangesPara = `<w:p><w:r><w:ins w:id="1"><w:t>Observation of Windows Defender protection mechanisms during payload execution revealed detection.</w:t></w:ins></w:r><w:r><w:del w:id="2"><w:delText>Windows Defender observed during payload test showed protection triggered.</w:delText></w:del></w:r></w:p>`;
  const xml = [h1('Session 3: Windows Defender'), trackChangesPara].join('\n');

  // Apply fix before extraction
  const cleanXml = stripDocxRevisionMarks(xml);
  const { bodyParas, totalDocParas } = extractBodyParasWithPos(cleanXml);

  assert('Group6: after stripping del blocks, body para extracted', bodyParas.length === 1);
  if (bodyParas.length > 0) {
    const hasDelText = bodyParas[0].text.includes('observed during payload test');
    assert('Group6: extracted text does NOT include <w:delText> content', !hasDelText,
      JSON.stringify(bodyParas[0].text.substring(0, 80)));
    assert('Group6: extracted text has only the <w:ins> content (current version)',
      bodyParas[0].text.includes('Observation of Windows Defender'), JSON.stringify(bodyParas[0].text.substring(0, 80)));
  }

  // Apply fix before replacement too (use cleanXml for replacement)
  const paraMap = new Array(totalDocParas).fill(null);
  if (bodyParas.length > 0) {
    paraMap[bodyParas[0].docPos] = 'Paraphrased: Defender protection mechanisms identified the payload during detonation.';
  }
  const { stashed } = stashTables(cleanXml);
  const { result } = replaceAbsolute(stashed, paraMap);

  const hasDelText = result.includes('<w:delText>');
  const hasParaphrase = result.includes('Paraphrased: Defender protection');
  assert('Group6: FIX — no <w:delText> in output', !hasDelText);
  assert('Group6: FIX — paraphrase text is in output', hasParaphrase);
  assert('Group6: FIX — no duplication (deleted text gone)', !hasDelText && hasParaphrase);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST GROUP 7: END-TO-END — realistic lab report, no duplication, correct order
// ═══════════════════════════════════════════════════════════════════════

console.log('\n══════ GROUP 7: End-to-end — multi-section lab report ══════');

{
  function stripDeletedRuns(xml) {
    return xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');
  }

  const xml = [
    shortPara('Student Name: John Smith'),
    shortPara('Module: CS4001'),
    h1('Introduction'),
    body('This security lab documents five assessment sessions covering network analysis and detection.'),
    h1('Session 3: Windows Defender Observation'),
    h2('Observation'),
    body('Windows Defender protection was observed during controlled payload detonation exercise Screenshot 3.1.'),
    h2('Comparison with Joe Sandbox'),
    body('Comparison between Joe Sandbox and Windows Defender shows both tools detect the same malware signatures.'),
    h2('Relationship between the four policies'),
    body('The four policies form an interconnected system where violations in one policy trigger responses across others.'),
    h1('Conclusion'),
    body('All five sessions collectively demonstrated the effectiveness of layered security infrastructure approach.'),
    h1('References'),
    body('[1] Smith, J. (2023). Network Security Monitoring with Wireshark. IEEE Transactions on Information Security, 15(3).'),
  ].join('\n');

  const cleanXml = stripDocxRevisionMarks(xml);
  const { bodyParas, totalDocParas } = extractBodyParasWithPos(cleanXml);

  console.log(`  Document: ${totalDocParas} total paras, ${bodyParas.length} body paras`);
  bodyParas.forEach((bp, i) => {
    console.log(`  body[${i}] docPos=${bp.docPos}: "${bp.text.substring(0, 55)}…"`);
  });

  // Perfect AI response
  const aiResponse = bodyParas.map((bp, i) =>
    `<<<${i + 1}>>> Paraphrased body ${i + 1}: ${bp.text.substring(0, 40)}`
  ).join('\n\n');
  const paraMap = parseMarkerResponse(aiResponse, bodyParas, totalDocParas);

  const { stashed } = stashTables(cleanXml);
  const stashedCount = countParas(stashed);
  assert('Group7: extraction count = stashed count', totalDocParas === stashedCount,
    `extraction=${totalDocParas}, stashed=${stashedCount}`);

  const { result, log } = replaceAbsolute(stashed, paraMap);

  // Check order: for each heading, verify it appears BEFORE any body after it
  const allEntries = log;

  // Find "Comparison with Joe Sandbox" heading (absPos=7 in this XML)
  const compHeadingEntry = allEntries.find(e => e.orig === 'Comparison with Joe Sandbox');
  const compBodyEntry = allEntries.find(e => e.orig && e.orig.includes('Comparison between Joe Sandbox'));
  if (compHeadingEntry && compBodyEntry) {
    assert('Group7: "Comparison" heading absPos < body absPos',
      compHeadingEntry.absPos < compBodyEntry.absPos,
      `heading at ${compHeadingEntry.absPos}, body at ${compBodyEntry.absPos}`);
    assert('Group7: "Comparison" heading kept (null)', compHeadingEntry.replacement === null);
    assert('Group7: "Comparison" body replaced', compBodyEntry.replacement !== null);
  }

  // Check for duplication: count how many times each replacement text appears
  const bodyReplacements = log.filter(e => e.replacement !== null).map(e => e.replacement);
  assert('Group7: no duplicate replacement texts', new Set(bodyReplacements).size === bodyReplacements.length,
    `${bodyReplacements.length} replacements, ${new Set(bodyReplacements).size} unique`);

  // Check for null-covered positions (headings, short paras) — none should have content from another position
  const nullPositions = log.filter(e => e.replacement === null);
  assert('Group7: null positions keep ORIGINAL text (not paraphrase text)',
    nullPositions.every(e => !e.orig.includes('Paraphrased body')));

  const filled = paraMap.filter(p => p !== null).length;
  assert(`Group7: all ${bodyParas.length} body positions filled`, filled === bodyParas.length,
    `filled=${filled}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
