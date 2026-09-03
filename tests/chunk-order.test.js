'use strict';
// Tests for chunk ordering and parseNumberedParagraphs correctness.
// Covers the root-cause bug: in-text citation patterns like "[1]" inside
// reference entries were misidentified as paragraph markers, causing
// reference text to overwrite body content at position 0 in the para map.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror parseNumberedParagraphs from index.html ──────────────────────────

function parseNumberedParagraphs(response, expectedCount) {
  const result = new Array(expectedCount).fill(null);
  const blocks = response.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^\[(\d+)\]\s*([\s\S]*)/);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < expectedCount) {
      result[idx] = m[2].replace(/\n/g, ' ').trim() || null;
    }
  }
  return result;
}

// ── parallelLimit (mirrored from api/process.js) — order verification ───────

async function parallelLimit(fns, limit) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

// ── TESTS: parseNumberedParagraphs ─────────────────────────────────────────

console.log('\n── Normal numbered paragraphs (basic) ──');
{
  const response = '[1] First paragraph text here.\n\n[2] Second paragraph text.\n\n[3] Third paragraph.';
  const r = parseNumberedParagraphs(response, 3);
  assert('result[0] correct', r[0] === 'First paragraph text here.', JSON.stringify(r[0]));
  assert('result[1] correct', r[1] === 'Second paragraph text.', JSON.stringify(r[1]));
  assert('result[2] correct', r[2] === 'Third paragraph.', JSON.stringify(r[2]));
}

console.log('\n── THE BUG: IEEE reference "[1] Smith, J." inside para 15 ──');
{
  // Para 15 is an IEEE reference whose text starts with "[1]".
  // Old regex would parse "[1]" as paragraph-marker 1 and overwrite result[0].
  // New split-first approach correctly stores it at result[14].
  const lines = [];
  for (let i = 1; i <= 14; i++) lines.push(`[${i}] Body paragraph ${i} text.`);
  lines.push('[15] [1] Smith, J. (2023). Title of paper. IEEE Journal.');
  lines.push('[16] [2] Jones, K. (2022). Another reference title. Conference.');
  const response = lines.join('\n\n');

  const r = parseNumberedParagraphs(response, 16);
  assert('result[0] = body para 1 (NOT overwritten by reference)', r[0] === 'Body paragraph 1 text.', JSON.stringify(r[0]));
  assert('result[1] = body para 2', r[1] === 'Body paragraph 2 text.', JSON.stringify(r[1]));
  assert('result[13] = body para 14', r[13] === 'Body paragraph 14 text.', JSON.stringify(r[13]));
  assert('result[14] preserves [1] reference number', r[14] === '[1] Smith, J. (2023). Title of paper. IEEE Journal.', JSON.stringify(r[14]));
  assert('result[15] preserves [2] reference number', r[15] === '[2] Jones, K. (2022). Another reference title. Conference.', JSON.stringify(r[15]));
}

console.log('\n── APA references (no in-text bracket numbers, but multi-part) ──');
{
  const response =
    '[1] This is the introduction paragraph with enough content.\n\n' +
    '[2] This is another body paragraph in section two.\n\n' +
    '[3] Smith, A., & Jones, B. (2023). Paper title. Journal of Science, 15(3), 45–67. https://doi.org/10.1234/xyz';
  const r = parseNumberedParagraphs(response, 3);
  assert('result[0] intro', r[0] === 'This is the introduction paragraph with enough content.', JSON.stringify(r[0]));
  assert('result[2] APA ref preserved', r[2].startsWith('Smith, A.,'), JSON.stringify(r[2]));
}

console.log('\n── Multiple in-text citation references: "[1, 2, 3]" style ──');
{
  // Some text has multi-citation format: see [1, 2] or [3-5]
  // These don't start with \[\d+\] exactly but let's test adjacent ones.
  // Use expectedCount=10 so result[4] is defined (null) when [5] is NOT parsed as a marker.
  const response =
    '[1] Introduction text.\n\n' +
    '[2] Methods paragraph with citation [5] embedded in middle of sentence.\n\n' +
    '[3] Results paragraph here.';
  const r = parseNumberedParagraphs(response, 10);
  assert('result[0] = intro', r[0] === 'Introduction text.', JSON.stringify(r[0]));
  assert('result[1] includes embedded [5]', r[1] === 'Methods paragraph with citation [5] embedded in middle of sentence.', JSON.stringify(r[1]));
  assert('result[2] = results', r[2] === 'Results paragraph here.', JSON.stringify(r[2]));
  // Confirm [5] was NOT parsed as a paragraph marker (result[4] stays null)
  assert('[5] not treated as paragraph marker', r[4] === null, JSON.stringify(r[4]));
}

console.log('\n── Missing paragraph markers → null (original text preserved) ──');
{
  const response = '[1] First paragraph.\n\n[3] Third paragraph (AI skipped 2).';
  const r = parseNumberedParagraphs(response, 3);
  assert('result[0] set', r[0] === 'First paragraph.');
  assert('result[1] null (missing [2])', r[1] === null);
  assert('result[2] set', r[2] === 'Third paragraph (AI skipped 2).');
}

console.log('\n── AI preamble before first marker is ignored ──');
{
  const response = 'Sure! Here is the paraphrased text:\n\n[1] First paragraph text.\n\n[2] Second paragraph.';
  const r = parseNumberedParagraphs(response, 2);
  assert('preamble ignored', r[0] === 'First paragraph text.', JSON.stringify(r[0]));
  assert('result[1] correct', r[1] === 'Second paragraph.', JSON.stringify(r[1]));
}

console.log('\n── Out-of-order markers (AI reorders) still land at right position ──');
{
  // Even if AI returns [3] before [1] (shouldn't happen but defensive)
  const response = '[3] Third.\n\n[1] First.\n\n[2] Second.';
  const r = parseNumberedParagraphs(response, 3);
  assert('result[0] = First', r[0] === 'First.', JSON.stringify(r[0]));
  assert('result[1] = Second', r[1] === 'Second.', JSON.stringify(r[1]));
  assert('result[2] = Third', r[2] === 'Third.', JSON.stringify(r[2]));
}

console.log('\n── Large document: 20 body + 10 IEEE references ──');
{
  const lines = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`[${i}] Body paragraph ${i} with enough words to be substantial content.`);
  }
  for (let i = 21; i <= 30; i++) {
    // IEEE references: para [21] = "[1] Smith...", para [22] = "[2] Jones..."
    const refNum = i - 20;
    lines.push(`[${i}] [${refNum}] Author${refNum}, F. (2023). Title ${refNum}. IEEE Trans., vol. ${refNum}.`);
  }
  const response = lines.join('\n\n');
  const r = parseNumberedParagraphs(response, 30);

  assert('body para 1 not overwritten', r[0] === 'Body paragraph 1 with enough words to be substantial content.', JSON.stringify(r[0]));
  assert('body para 20 correct', r[19] === 'Body paragraph 20 with enough words to be substantial content.', JSON.stringify(r[19]));
  assert('ref para 21 has [1] prefix', r[20] === '[1] Author1, F. (2023). Title 1. IEEE Trans., vol. 1.', JSON.stringify(r[20]));
  assert('ref para 30 has [10] prefix', r[29] === '[10] Author10, F. (2023). Title 10. IEEE Trans., vol. 10.', JSON.stringify(r[29]));
  // Confirm none of the ref numbers [1]-[10] overwrote body paras [1]-[10]
  for (let i = 0; i < 10; i++) {
    assert(`body para ${i+1} not overwritten by ref [${i+1}]`,
      r[i] === `Body paragraph ${i+1} with enough words to be substantial content.`);
  }
}

console.log('\n── Chunk join order (parallelLimit preserves position index) ──');
{
  // Simulate 5 chunks completing out of order
  const delays = [50, 10, 30, 5, 20]; // chunk 3 finishes first, etc.
  const fns = delays.map((d, i) => () => new Promise(resolve => setTimeout(() => resolve(`chunk${i}`), d)));
  parallelLimit(fns, 3).then(results => {
    assert('chunk 0 at index 0', results[0] === 'chunk0', JSON.stringify(results));
    assert('chunk 1 at index 1', results[1] === 'chunk1', JSON.stringify(results));
    assert('chunk 2 at index 2', results[2] === 'chunk2', JSON.stringify(results));
    assert('chunk 3 at index 3', results[3] === 'chunk3', JSON.stringify(results));
    assert('chunk 4 at index 4', results[4] === 'chunk4', JSON.stringify(results));

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
    else console.log('All tests passed ✅');
  });
}
