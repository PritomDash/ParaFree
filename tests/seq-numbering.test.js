'use strict';
// Tests for explicit sequence-number chunk reassembly (api/process.js).
// Verifies that chunks completing in any order are always reassembled in
// their original sequence (0, 1, 2, ...) before joining into the final output.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror parallelLimit from api/process.js ─────────────────────────────────

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

// ── Mirror the sequence-numbered dispatch from runChain ──────────────────────

// Simulates the updated chunk processing: assigns seq numbers, dispatches in
// parallel, sorts by seq, verifies completeness, assembles in order.
async function processChunksWithSeq(chunks, processFn, concurrency = 4) {
  const indexedChunks = chunks.map((text, seq) => ({ seq, text }));

  const rawResults = await parallelLimit(
    indexedChunks.map(({ seq, text }) => async () => {
      const result = await processFn(seq, text);
      return { seq, result };
    }),
    concurrency
  );

  // Sort by sequence number
  rawResults.sort((a, b) => a.seq - b.seq);

  // Verify completeness: every seq 0..N-1 present with non-null result
  for (let i = 0; i < indexedChunks.length; i++) {
    if (!rawResults[i] || rawResults[i].seq !== i) return { ok: false, reason: `gap at index ${i}` };
    if (rawResults[i].result === null) return { ok: false, reason: `null result at seq=${i}` };
  }

  return { ok: true, assembled: rawResults.map(r => r.result).join('\n\n'), seqs: rawResults.map(r => r.seq) };
}

// ── TEST 1: Chunks completing in reverse order ────────────────────────────────

console.log('\n── Chunks completing in reverse order still assemble in original order ──');
{
  const chunks = ['CHUNK_0', 'CHUNK_1', 'CHUNK_2', 'CHUNK_3', 'CHUNK_4'];
  // Each chunk completes after (chunks.length - seq) * 10ms — last chunk finishes first
  const processFn = (seq, text) => new Promise(resolve =>
    setTimeout(() => resolve(text + '_done'), (chunks.length - seq) * 10)
  );

  processChunksWithSeq(chunks, processFn, 5).then(res => {
    assert('all chunks succeeded', res.ok, res.reason);
    const parts = res.assembled.split('\n\n');
    assert('5 parts in assembled output', parts.length === 5);
    assert('part 0 = chunk 0', parts[0] === 'CHUNK_0_done');
    assert('part 1 = chunk 1', parts[1] === 'CHUNK_1_done');
    assert('part 2 = chunk 2', parts[2] === 'CHUNK_2_done');
    assert('part 3 = chunk 3', parts[3] === 'CHUNK_3_done');
    assert('part 4 = chunk 4', parts[4] === 'CHUNK_4_done');
    assert('seqs in ascending order', JSON.stringify(res.seqs) === '[0,1,2,3,4]');

    // ── TEST 2: Random completion order ──────────────────────────────────────

    console.log('\n── Chunks completing in random order still assemble correctly ──');
    const delays = [80, 10, 50, 5, 30, 70, 20, 60, 40, 15]; // 10 chunks, random order
    const chunks2 = delays.map((_, i) => `section_${i}`);
    const processFn2 = (seq, text) => new Promise(resolve =>
      setTimeout(() => resolve(text + `_processed`), delays[seq])
    );

    return processChunksWithSeq(chunks2, processFn2, 4).then(res2 => {
      assert('10-chunk random-order success', res2.ok, res2.reason);
      const parts2 = res2.assembled.split('\n\n');
      assert('10 parts total', parts2.length === 10);
      for (let i = 0; i < 10; i++) {
        assert(`section_${i} at position ${i}`, parts2[i] === `section_${i}_processed`);
      }
      assert('seqs strictly ascending', res2.seqs.join(',') === '0,1,2,3,4,5,6,7,8,9');

      // ── TEST 3: Multi-section document order ────────────────────────────────

      console.log('\n── Multi-section document: headings + body + references stay in order ──');
      const docSections = [
        '[1] Introduction body paragraph with enough words to be processed.',
        '[2] Methods section body text describing the experimental setup used.',
        '[3] Results paragraph showing the key outcomes of the study experiment.',
        '[4] Discussion of findings in context of prior work in the literature.',
        '[5] Conclusion summarizing the main contributions of this research study.',
        '[6] [1] Smith, J. (2023). Title. IEEE Trans. vol. 1.\n[6] [2] Jones, K. (2022). Another paper. Journal vol. 2.',
      ];
      // Simulate chunks completing: section 5 (refs) finishes first, section 0 (intro) last
      const sectionDelays = [60, 30, 10, 40, 20, 5];
      const processFn3 = (seq, text) => new Promise(resolve =>
        setTimeout(() => resolve(text), sectionDelays[seq]) // pass-through (no paraphrase)
      );

      return processChunksWithSeq(docSections, processFn3, 3).then(res3 => {
        assert('document sections all present', res3.ok, res3.reason);
        const parts3 = res3.assembled.split('\n\n');
        assert('intro at position 0', parts3[0].startsWith('[1] Introduction'));
        assert('methods at position 1', parts3[1].startsWith('[2] Methods'));
        assert('results at position 2', parts3[2].startsWith('[3] Results'));
        assert('discussion at position 3', parts3[3].startsWith('[4] Discussion'));
        assert('conclusion at position 4', parts3[4].startsWith('[5] Conclusion'));
        assert('references at position 5 (bottom)', parts3[5].startsWith('[6] [1] Smith'));
        assert('seqs ascending (no reordering)', res3.seqs.join(',') === '0,1,2,3,4,5');

        // ── TEST 4: Failed chunk detected, not silently skipped ──────────────

        console.log('\n── Failed chunk returns error, not a partial/scrambled document ──');
        const chunks4 = ['A', 'B', 'C'];
        const processFn4 = (seq) => Promise.resolve(seq === 1 ? null : `chunk${seq}`);

        return processChunksWithSeq(chunks4, processFn4, 3).then(res4 => {
          assert('null result chunk detected as failure', !res4.ok, JSON.stringify(res4));
          assert('failure reason mentions seq=1', res4.reason && res4.reason.includes('seq=1'));

          // ── TEST 5: Single chunk (no parallelism needed) ─────────────────

          console.log('\n── Single chunk: no concurrency, assembles trivially ──');
          const chunks5 = ['Only paragraph of a short document.'];
          const processFn5 = (seq, text) => Promise.resolve(text + ' (paraphrased)');

          return processChunksWithSeq(chunks5, processFn5, 4).then(res5 => {
            assert('single chunk succeeds', res5.ok, res5.reason);
            assert('assembled = single result', res5.assembled === 'Only paragraph of a short document. (paraphrased)');
            assert('seq = [0]', res5.seqs.join(',') === '0');

            // ── TEST 6: Sequence sort is correct after out-of-order push ────

            console.log('\n── Sort-by-seq is correct for arbitrary completion order ──');
            // Manually simulate rawResults arriving out of order
            const rawResults = [
              { seq: 3, result: 'D' },
              { seq: 0, result: 'A' },
              { seq: 2, result: 'C' },
              { seq: 1, result: 'B' },
            ];
            rawResults.sort((a, b) => a.seq - b.seq);
            assert('seq 0 first after sort', rawResults[0].seq === 0 && rawResults[0].result === 'A');
            assert('seq 1 second after sort', rawResults[1].seq === 1 && rawResults[1].result === 'B');
            assert('seq 2 third after sort', rawResults[2].seq === 2 && rawResults[2].result === 'C');
            assert('seq 3 last after sort', rawResults[3].seq === 3 && rawResults[3].result === 'D');

            console.log(`\n${'─'.repeat(50)}`);
            console.log(`Results: ${passed} passed, ${failed} failed`);
            if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
            else console.log('All tests passed ✅');
          });
        });
      });
    });
  });
}
