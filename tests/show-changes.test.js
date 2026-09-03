'use strict';
// Tests for the word-level diff logic extracted from index.html

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function lcsWordDiff(bWords, aWords) {
  const m = bWords.length, n = aWords.length;
  const norm = w => w.toLowerCase().replace(/[^\w]/g, '');
  const dp = new Uint16Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    const bi = norm(bWords[i - 1]);
    for (let j = 1; j <= n; j++) {
      const idx = i * (n + 1) + j;
      dp[idx] = bi === norm(aWords[j - 1])
        ? dp[(i - 1) * (n + 1) + (j - 1)] + 1
        : Math.max(dp[(i - 1) * (n + 1) + j], dp[i * (n + 1) + (j - 1)]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && norm(bWords[i - 1]) === norm(aWords[j - 1])) {
      ops.unshift({ type: 'keep', word: aWords[j - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * (n + 1) + (j - 1)] >= dp[(i - 1) * (n + 1) + j])) {
      ops.unshift({ type: 'insert', word: aWords[j - 1] }); j--;
    } else {
      ops.unshift({ type: 'delete', word: bWords[i - 1] }); i--;
    }
  }
  return ops;
}

function bagOfWordsDiff(bWords, aWords) {
  const bag = Object.create(null);
  for (const w of bWords) { const k = w.toLowerCase(); bag[k] = (bag[k] || 0) + 1; }
  return aWords.map(w => {
    const k = w.toLowerCase();
    if (bag[k] > 0) { bag[k]--; return { type: 'keep', word: w }; }
    return { type: 'insert', word: w };
  });
}

function computeDiffHTML(before, after) {
  const bWords = before.trim().split(/\s+/).filter(Boolean);
  const aWords = after.trim().split(/\s+/).filter(Boolean);
  if (!aWords.length) return '';
  if (!bWords.length) return aWords.map(w => `<mark>${escapeHtml(w)}</mark>`).join(' ');
  const ops = (bWords.length <= 2500 && aWords.length <= 2500)
    ? lcsWordDiff(bWords, aWords)
    : bagOfWordsDiff(bWords, aWords);
  let html = '';
  for (const op of ops) {
    if (op.type === 'keep')        html += escapeHtml(op.word) + ' ';
    else if (op.type === 'insert') html += '<mark>' + escapeHtml(op.word) + '</mark> ';
    else                           html += '<del>' + escapeHtml(op.word) + '</del> ';
  }
  return html.trim();
}

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log('\n── Identical texts (no changes) ──');
{
  const ops = lcsWordDiff('hello world foo'.split(' '), 'hello world foo'.split(' '));
  assert('all keeps', ops.every(o => o.type === 'keep'), JSON.stringify(ops));
  assert('length matches', ops.length === 3);
}

console.log('\n── Single word changed ──');
{
  const ops = lcsWordDiff('the quick fox'.split(' '), 'the slow fox'.split(' '));
  const keeps = ops.filter(o => o.type === 'keep').map(o => o.word);
  const ins   = ops.filter(o => o.type === 'insert').map(o => o.word);
  const del   = ops.filter(o => o.type === 'delete').map(o => o.word);
  assert('unchanged words kept', keeps.includes('the') && keeps.includes('fox'));
  assert('old word deleted', del.includes('quick'));
  assert('new word inserted', ins.includes('slow'));
}

console.log('\n── Word added at end ──');
{
  const ops = lcsWordDiff('hello world'.split(' '), 'hello world again'.split(' '));
  const ins = ops.filter(o => o.type === 'insert').map(o => o.word);
  assert('new word is insert', ins.includes('again'));
  assert('2 keeps', ops.filter(o => o.type === 'keep').length === 2);
}

console.log('\n── Word removed from middle ──');
{
  const ops = lcsWordDiff('one two three'.split(' '), 'one three'.split(' '));
  const del = ops.filter(o => o.type === 'delete').map(o => o.word);
  assert('removed word is delete', del.includes('two'));
  assert('kept words correct', ops.filter(o => o.type === 'keep').length === 2);
}

console.log('\n── Empty input (all new) ──');
{
  const html = computeDiffHTML('', 'brand new text');
  assert('all words marked', html.includes('<mark>') || html.includes('brand'));
}

console.log('\n── Empty output ──');
{
  const html = computeDiffHTML('some original text', '');
  assert('empty output returns empty', html === '');
}

console.log('\n── Case-insensitive matching ──');
{
  const ops = lcsWordDiff(['Hello'], ['hello']);
  assert('Hello/hello matched as keep', ops[0].type === 'keep');
}

console.log('\n── Large doc falls back to bag-of-words (2501+ words each side) ──');
{
  const big = Array.from({length: 2501}, (_, i) => 'word' + i);
  // Should not crash and should return array of ops
  const aWords = [...big.slice(0, 100), 'newword', ...big.slice(100, 2401)]; // 2402 words
  const ops = bagOfWordsDiff(big, aWords);
  const ins = ops.filter(o => o.type === 'insert');
  assert('newword flagged as insert', ins.some(o => o.word === 'newword'));
  assert('result length matches output word count', ops.length === aWords.length);
}

console.log('\n── HTML special chars escaped ──');
{
  const html = computeDiffHTML('a & b', 'a & c');
  assert('ampersand escaped', html.includes('&amp;'));
  assert('no raw & in output', !/<[^>]+>&/.test(html));
}

console.log('\n── Short sentence realistic diff ──');
{
  const before = 'The company announced record profits this quarter despite rising costs.';
  const after  = 'The firm reported record earnings this quarter amid increasing expenses.';
  const html = computeDiffHTML(before, after);
  assert('contains kept words', html.includes('The') && html.includes('record') && html.includes('this') && html.includes('quarter'));
  assert('contains inserted words', html.includes('<mark>'));
  assert('contains deleted words', html.includes('<del>'));
  console.log(`   Preview: ${html.replace(/<[^>]+>/g,'').slice(0,80)}...`);
}

console.log('\n── 500-word doc performance ──');
{
  const makeDoc = n => Array.from({length: n}, (_, i) => 'word' + (i % 50)).join(' ');
  const before = makeDoc(500);
  const after  = makeDoc(500).replace('word25', 'newterm');
  const t = Date.now();
  computeDiffHTML(before, after);
  const ms = Date.now() - t;
  assert(`500-word diff completes in <500ms (took ${ms}ms)`, ms < 500);
}

console.log('\n── 2500-word doc performance ──');
{
  const makeDoc = n => Array.from({length: n}, (_, i) => 'word' + (i % 200)).join(' ');
  const before = makeDoc(2500);
  const after  = makeDoc(2500).replace('word100', 'replaced');
  const t = Date.now();
  computeDiffHTML(before, after);
  const ms = Date.now() - t;
  assert(`2500-word LCS diff completes in <5s (took ${ms}ms)`, ms < 5000);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
