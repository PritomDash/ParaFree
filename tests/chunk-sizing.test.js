// tests/chunk-sizing.test.js
// Validates the dynamic chunk-sizing logic from api/process.js.
// Run with: node tests/chunk-sizing.test.js

'use strict';

// ── Mirror the exact logic from api/process.js ──────────────────────────────
const CHUNK_TARGET_WORDS = 400;
const CHUNK_MAX_COUNT    = 12;

function countWordsApprox(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildChunks(text) {
  const words = countWordsApprox(text);
  const chunkCount = Math.max(1, Math.min(CHUNK_MAX_COUNT, Math.ceil(words / CHUNK_TARGET_WORDS)));
  if (chunkCount === 1) return [text];

  const targetWords = Math.ceil(words / chunkCount);
  const paras = text.split(/\n\n+/).filter(p => p.trim());

  const chunks = [];
  let cur = [], curWords = 0;
  for (const para of paras) {
    const pw = countWordsApprox(para);
    if (curWords >= targetWords && chunks.length < chunkCount - 1) {
      chunks.push(cur.join('\n\n'));
      cur = [];
      curWords = 0;
    }
    cur.push(para);
    curWords += pw;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

// ── Test helpers ─────────────────────────────────────────────────────────────
function makeText(wordCount, paragraphSize = 60) {
  // Build realistic paragraph-separated text
  const word = 'lorem';
  const paras = [];
  let remaining = wordCount;
  while (remaining > 0) {
    const size = Math.min(paragraphSize, remaining);
    paras.push(Array(size).fill(word).join(' '));
    remaining -= size;
  }
  return paras.join('\n\n');
}

let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function runTest(label, text, expectedChunks, opts = {}) {
  const chunks = buildChunks(text);
  const totalWords = countWordsApprox(text);
  const chunkWords = chunks.map(countWordsApprox);
  const reassembled = chunks.join('\n\n');
  const maxChunkWords = Math.max(...chunkWords);
  // Paragraph-boundary splitting can leave a small last chunk (1 para = paragraphSize words).
  // We only guard that no single chunk is oversized (quality), not that each is large.
  const minChunkWords = Math.min(...chunkWords);

  console.log(`\n── ${label} ──`);
  console.log(`   input: ${totalWords} words → ${chunks.length} chunk(s) [${chunkWords.join(', ')} words]`);

  assert(`chunk count = ${expectedChunks}`, chunks.length === expectedChunks,
    `got ${chunks.length}`);
  // Quality guard: each chunk should be paraphraseable — well under 1000 words
  assert('no chunk > 900 words (quality guard)', maxChunkWords <= 900,
    `max=${maxChunkWords}`);
  // Rate-limit guard
  assert('chunk count ≤ 12 (rate-limit guard)', chunks.length <= 12);
  assert('text fully preserved (no content loss)',
    reassembled.replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim(),
    'content mismatch');

  if (opts.checkOrder && chunks.length > 1) {
    // Verify the original text is rebuilt in order
    let pos = 0;
    let ordered = true;
    for (const chunk of chunks) {
      const idx = text.indexOf(chunk.trim().slice(0, 30), pos);
      if (idx < pos) { ordered = false; break; }
      pos = idx;
    }
    assert('chunks are in original order', ordered);
  }
}

// ── Test cases ───────────────────────────────────────────────────────────────

// 1. Very short (≤ 400 words) → always 1 chunk
runTest('300-word doc', makeText(300), 1, { checkOrder: true });
runTest('150-word doc', makeText(150), 1, { checkOrder: true });
runTest('400-word doc (boundary)', makeText(400), 1, { checkOrder: true });

// 2. Medium docs
runTest('800-word doc',  makeText(800),  2, { checkOrder: true });
runTest('1200-word doc', makeText(1200), 3, { checkOrder: true });
runTest('2000-word doc', makeText(2000), 5, { checkOrder: true });
runTest('3000-word doc', makeText(3000), 8, { checkOrder: true }); // ceil(3000/400)=8 — wait, actually ceil(3000/400) = ceil(7.5) = 8

// 3. Large docs — chunk count caps at 12
runTest('5000-word doc',  makeText(5000),  12, { checkOrder: true }); // ceil(5000/400)=13 → cap 12
runTest('10000-word doc', makeText(10000), 12, { checkOrder: true }); // ceil(10000/400)=25 → cap 12

// 4. Edge cases
runTest('1-word doc', makeText(1), 1);
runTest('401-word doc (just over boundary)', makeText(401), 2, { checkOrder: true });
runTest('4400-word doc (exact 11 chunks)', makeText(4400), 11, { checkOrder: true }); // ceil(4400/400)=11

// 5. Long paragraphs (won't split mid-para)
{
  const longPara = Array(500).fill('word').join(' ');
  const text = [longPara, longPara, longPara].join('\n\n'); // 1500 words, 3 paragraphs
  const chunks = buildChunks(text);
  const words = countWordsApprox(text);
  console.log(`\n── Long-paragraph doc (1500 words, 3 paras × 500 words each) ──`);
  console.log(`   input: ${words} words → ${chunks.length} chunk(s) [${chunks.map(countWordsApprox).join(', ')} words]`);
  // ceil(1500/400)=4, but only 3 paragraphs → can only make 3 chunks max
  assert('chunks ≤ paragraph count (no mid-para split)', chunks.length <= 3);
  assert('chunk count ≤ 12', chunks.length <= 12);
}

// 6. Single very long paragraph (can't split — should stay as 1 chunk)
{
  const singlePara = Array(2000).fill('word').join(' ');
  const chunks = buildChunks(singlePara);
  console.log(`\n── Single 2000-word paragraph (unsplittable) ──`);
  console.log(`   → ${chunks.length} chunk(s) [${chunks.map(countWordsApprox).join(', ')} words]`);
  assert('unsplittable single paragraph stays as 1 chunk', chunks.length === 1);
}

// 7. Formula table — print for inspection
console.log('\n── Formula table (for review) ──');
[100, 200, 300, 400, 500, 800, 1000, 1500, 2000, 3000, 4000, 4800, 5000, 8000, 10000, 15000].forEach(w => {
  const raw = Math.ceil(w / CHUNK_TARGET_WORDS);
  const clamped = Math.max(1, Math.min(CHUNK_MAX_COUNT, raw));
  const perChunk = Math.ceil(w / clamped);
  console.log(`   ${String(w).padStart(6)} words → ${String(clamped).padStart(2)} chunk(s) × ~${perChunk} words/chunk`);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('All tests passed ✅');
}
