'use strict';
// Tests for heading/title detection and preservation logic.
// Run with: node tests/heading-preservation.test.js

// ── Mirror functions from index.html ─────────────────────────────────────────

function isSubstantialPara(t) {
  return t.length >= 25 && /\s/.test(t) && t.split(/\s+/).length >= 5;
}

function docxSkip(t) {
  if (!t || t.length < 3) return true;
  if (/^[jkmnlJKMNL]{3,}/.test(t) || /(.)\1{4,}/.test(t)) return true;
  if (/^\d{4}\s*[-–]\s*(\d{4}|present)$/i.test(t) ||
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(t)) return true;
  return false;
}

function isDocxHeading(paraXml) {
  // Primary: named paragraph style
  const styleM = paraXml.match(/<w:pStyle\s+w:val="([^"]+)"/i);
  if (styleM) {
    const s = styleM[1];
    if (/^Heading[\s\d]/i.test(s) || /^(Title|Subtitle|TOCHeading)$/i.test(s)) return true;
  }
  // Secondary: explicit outline level 0–8 (9 = body text, not a heading)
  const lvlM = paraXml.match(/<w:outlineLvl\s+w:val="(\d+)"/i);
  if (lvlM && parseInt(lvlM[1], 10) <= 8) return true;
  return false;
}

function isPptxTitlePlaceholder(spXml) {
  const typeM = spXml.match(/<p:ph\b[^>]*\btype="([^"]+)"/i);
  if (!typeM) return false;
  const t = typeM[1].toLowerCase();
  return t === 'title' || t === 'ctrtitle' || t === 'subtitle';
}

// ── Synthetic XML helpers ─────────────────────────────────────────────────────

function docxPara(style, text, outlineLevel) {
  const stylePr = style ? `<w:pStyle w:val="${style}"/>` : '';
  const lvlPr = outlineLevel != null ? `<w:outlineLvl w:val="${outlineLevel}"/>` : '';
  return `<w:p><w:pPr>${stylePr}${lvlPr}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function pptxShape(phType, text) {
  const ph = phType ? `<p:ph type="${phType}"/>` : '';
  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="1" name="Shape"/>
      <p:cNvSpPr/>
      <p:nvPr>${ph}</p:nvPr>
    </p:nvSpPr>
    <p:txBody>
      <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>`;
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── DOCX: isDocxHeading ───────────────────────────────────────────────────────

console.log('\n── isDocxHeading: named styles ──');
assert('Heading1 → heading', isDocxHeading(docxPara('Heading1', 'Heading text here')));
assert('Heading2 → heading', isDocxHeading(docxPara('Heading2', 'Some heading')));
assert('Heading 3 (with space) → heading', isDocxHeading(docxPara('Heading 3', 'Section')));
assert('Heading9 → heading', isDocxHeading(docxPara('Heading9', 'Deep heading')));
assert('Title → heading', isDocxHeading(docxPara('Title', 'Document Title')));
assert('Subtitle → heading', isDocxHeading(docxPara('Subtitle', 'A subtitle line')));
assert('TOCHeading → heading', isDocxHeading(docxPara('TOCHeading', 'Table of Contents')));
assert('Normal → NOT heading', !isDocxHeading(docxPara('Normal', 'Body paragraph text here')));
assert('BodyText → NOT heading', !isDocxHeading(docxPara('BodyText', 'Just some body text')));
assert('Quote → NOT heading', !isDocxHeading(docxPara('Quote', 'A quoted passage')));
assert('ListParagraph → NOT heading', !isDocxHeading(docxPara('ListParagraph', 'List item here')));

console.log('\n── isDocxHeading: outline levels ──');
assert('outlineLvl 0 → heading', isDocxHeading(docxPara(null, 'Heading via outline', 0)));
assert('outlineLvl 1 → heading', isDocxHeading(docxPara(null, 'Heading via outline', 1)));
assert('outlineLvl 8 → heading', isDocxHeading(docxPara(null, 'Heading via outline', 8)));
assert('outlineLvl 9 → NOT heading (body)', !isDocxHeading(docxPara(null, 'Body text via outline', 9)));
assert('no outlineLvl, no style → NOT heading', !isDocxHeading(docxPara(null, 'Plain paragraph')));

console.log('\n── DOCX: heading with substantial text is still skipped ──');
{
  const xml = docxPara('Heading1', 'Chapter 1: Introduction to Machine Learning and AI Systems');
  const text = xml.replace(/<[^>]+>/g, '').trim();
  assert('heading text would pass isSubstantialPara alone', isSubstantialPara(text)); // 10 words
  assert('but isDocxHeading correctly identifies it as heading', isDocxHeading(xml));
  // Combined check as used in pipeline:
  const shouldSkip = docxSkip(text) || isDocxHeading(xml) || !isSubstantialPara(text);
  assert('pipeline correctly skips this heading paragraph', shouldSkip);
}

console.log('\n── DOCX: body paragraph is NOT skipped ──');
{
  const xml = docxPara('Normal', 'This is a regular body paragraph with enough words to qualify for paraphrasing.');
  const text = xml.replace(/<[^>]+>/g, '').trim();
  const shouldSkip = docxSkip(text) || isDocxHeading(xml) || !isSubstantialPara(text);
  assert('body paragraph passes through (not skipped)', !shouldSkip);
}

console.log('\n── DOCX: short body paragraph is skipped by isSubstantialPara ──');
{
  const xml = docxPara('Normal', 'Short line');
  const text = xml.replace(/<[^>]+>/g, '').trim();
  assert('short line skipped', docxSkip(text) || !isSubstantialPara(text));
}

// ── PPTX: isPptxTitlePlaceholder ─────────────────────────────────────────────

console.log('\n── isPptxTitlePlaceholder ──');
assert('type="title" → title placeholder',
  isPptxTitlePlaceholder(pptxShape('title', 'Slide Title')));
assert('type="ctrTitle" → title placeholder',
  isPptxTitlePlaceholder(pptxShape('ctrTitle', 'Center Title')));
assert('type="subTitle" → title placeholder',
  isPptxTitlePlaceholder(pptxShape('subTitle', 'Subtitle text')));
assert('no ph at all → NOT title placeholder',
  !isPptxTitlePlaceholder(pptxShape(null, 'Regular text box')));
assert('body placeholder (no type in <p:ph>) → NOT title (relies on type attr)',
  !isPptxTitlePlaceholder(`<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>body</a:t></a:r></a:p></p:txBody></p:sp>`));

console.log('\n── PPTX: case-insensitivity ──');
// Technically type attributes should be lowercase in OOXML, but be defensive
assert('Title (capitalized) → title',
  isPptxTitlePlaceholder(`<p:sp><p:nvPr><p:ph type="Title"/></p:nvPr><p:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`));

// ── Integration: extractSpTextBoxes equivalent ────────────────────────────────

console.log('\n── PPTX: slide with title + body ──');
{
  const slideXml = `
    <p:sld>
      ${pptxShape('title', 'Annual Report 2026')}
      ${pptxShape('subTitle', 'Financial Overview')}
      ${pptxShape(null, 'This is body content that should be paraphrased and contains enough text.')}
    </p:sld>`;

  // Simulate extractSpTextBoxes logic
  const items = [];
  let spIdx = 0;
  slideXml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, function(spXml) {
    if (spXml.includes('<p:txBody')) {
      const parts = [];
      spXml.replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g, (m, t) => parts.push(t));
      const text = parts.join('').trim();
      if (text.length >= 10) {
        const isTitle = isPptxTitlePlaceholder(spXml);
        items.push({ spIdx, text, isTitle });
      }
    }
    spIdx++;
  });

  assert('extracts 3 items total', items.length === 3,
    `got ${items.length}: ${JSON.stringify(items.map(i => ({text:i.text.slice(0,20), isTitle:i.isTitle})))}`);
  assert('title item has isTitle=true', items[0].isTitle === true, JSON.stringify(items[0]));
  assert('subtitle item has isTitle=true', items[1].isTitle === true, JSON.stringify(items[1]));
  assert('body item has isTitle=false', items[2].isTitle === false, JSON.stringify(items[2]));

  // Simulate paraphrasePPTX allItems building (skip titles)
  const allItems = items.filter(it => !it.isTitle);
  assert('only 1 item sent to API (body only)', allItems.length === 1);
  assert('API item is body text', allItems[0].text.includes('body content'));
}

// ── End ───────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
