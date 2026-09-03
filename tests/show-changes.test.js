'use strict';
// Tests for the word-level diff logic extracted from index.html

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Mirror functions from index.html ─────────────────────────────────────────

// push+reverse traceback: O(n) instead of O(n²) with unshift
function lcsWordDiff(bWords, aWords) {
  if (!bWords.length) return aWords.map(w => ({ type: 'insert', word: w }));
  if (!aWords.length) return bWords.map(w => ({ type: 'delete', word: w }));
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
      ops.push({ type: 'keep',   word: aWords[j - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * (n + 1) + (j - 1)] >= dp[(i - 1) * (n + 1) + j])) {
      ops.push({ type: 'insert', word: aWords[j - 1] }); j--;
    } else {
      ops.push({ type: 'delete', word: bWords[i - 1] }); i--;
    }
  }
  return ops.reverse();
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

function _renderDiffOps(ops) {
  let h = '';
  for (const op of ops) {
    if (op.type === 'keep')        h += escapeHtml(op.word) + ' ';
    else if (op.type === 'insert') h += '<mark>' + escapeHtml(op.word) + '</mark> ';
    else                           h += '<del>' + escapeHtml(op.word) + '</del> ';
  }
  return h.trim();
}

let _diffCache = { key: null, html: null };

function computeDiffHTML(before, after) {
  const cacheKey = before.length + ':' + after.length + ':' + before.slice(0, 80) + ':' + after.slice(0, 80);
  if (_diffCache.key === cacheKey) return _diffCache.html;

  const bWords = before.trim().split(/\s+/).filter(Boolean);
  const aWords = after.trim().split(/\s+/).filter(Boolean);
  if (!aWords.length) { _diffCache = { key: cacheKey, html: '' }; return ''; }
  if (!bWords.length) {
    const h = aWords.map(w => '<mark>' + escapeHtml(w) + '</mark>').join(' ');
    _diffCache = { key: cacheKey, html: h }; return h;
  }

  const bParas = before.trim().split(/\n\n+/).filter(p => p.trim());
  const aParas = after.trim().split(/\n\n+/).filter(p => p.trim());

  let html;
  if (aParas.length > 1) {
    const parts = aParas.map((aPara, i) => {
      const bPara = (bParas[i] || '').trim();
      const bW = bPara.split(/\s+/).filter(Boolean);
      const aW = aPara.trim().split(/\s+/).filter(Boolean);
      return '<p>' + _renderDiffOps(lcsWordDiff(bW, aW)) + '</p>';
    });
    html = parts.join('');
  } else if (bWords.length <= 800 && aWords.length <= 800) {
    html = _renderDiffOps(lcsWordDiff(bWords, aWords));
  } else {
    html = _renderDiffOps(bagOfWordsDiff(bWords, aWords));
  }

  _diffCache = { key: cacheKey, html };
  return html;
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── lcsWordDiff ──────────────────────────────────────────────────────────────

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

console.log('\n── Empty arrays handled gracefully ──');
{
  const ins = lcsWordDiff([], ['a', 'b']);
  assert('empty before: all inserts', ins.every(o => o.type === 'insert'));
  const del = lcsWordDiff(['a', 'b'], []);
  assert('empty after: all deletes', del.every(o => o.type === 'delete'));
}

console.log('\n── Case-insensitive matching ──');
{
  const ops = lcsWordDiff(['Hello'], ['hello']);
  assert('Hello/hello matched as keep', ops[0].type === 'keep');
}

console.log('\n── push+reverse preserves correct forward order ──');
{
  const ops = lcsWordDiff(['a','b','c','d'], ['a','x','c','d']);
  assert('first op is keep "a"',  ops[0].type === 'keep'   && ops[0].word === 'a');
  assert('second is del "b"',     ops[1].type === 'delete' && ops[1].word === 'b');
  assert('third is insert "x"',   ops[2].type === 'insert' && ops[2].word === 'x');
  assert('last two keep c,d',     ops[3].type === 'keep' && ops[3].word === 'c');
}

// ── computeDiffHTML ──────────────────────────────────────────────────────────

console.log('\n── Empty input (all new) ──');
{
  const html = computeDiffHTML('', 'brand new text');
  assert('all words marked', html.includes('<mark>'));
}

console.log('\n── Empty output ──');
{
  const html = computeDiffHTML('some original text', '');
  assert('empty output returns empty', html === '');
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
  assert('contains kept words', html.includes('The') && html.includes('record') && html.includes('quarter'));
  assert('contains inserted words', html.includes('<mark>'));
  assert('contains deleted words', html.includes('<del>'));
  console.log(`   Preview: ${html.replace(/<[^>]+>/g,'').slice(0,80)}...`);
}

console.log('\n── Multi-paragraph diff uses paragraph-level LCS ──');
{
  const before = 'The cat sat on the mat.\n\nThe dog ran in the park.';
  const after  = 'The feline rested on the rug.\n\nThe hound sprinted through the garden.';
  const html = computeDiffHTML(before, after);
  assert('contains <p> tags (paragraph mode)', html.includes('<p>'));
  assert('marks changes in both paragraphs', html.includes('<mark>'));
}

console.log('\n── Diff cache: second call returns same result instantly ──');
{
  _diffCache = { key: null, html: null }; // reset
  const before = 'The quick brown fox jumps over the lazy dog.';
  const after  = 'The fast brown fox leaps over the sleepy dog.';
  const t1 = Date.now(); const r1 = computeDiffHTML(before, after); const ms1 = Date.now() - t1;
  const t2 = Date.now(); const r2 = computeDiffHTML(before, after); const ms2 = Date.now() - t2;
  assert('both calls return same result', r1 === r2);
  assert('cached call is near-instant (<5ms)', ms2 < 5, `took ${ms2}ms`);
}

console.log('\n── Large single-block (>800 words) uses bag-of-words ──');
{
  const big = Array.from({length: 2501}, (_, i) => 'word' + i);
  const aWords = [...big.slice(0, 100), 'newword', ...big.slice(100, 2401)];
  const ops = bagOfWordsDiff(big, aWords);
  const ins = ops.filter(o => o.type === 'insert');
  assert('newword flagged as insert', ins.some(o => o.word === 'newword'));
  assert('result length matches output word count', ops.length === aWords.length);
}

console.log('\n── 500-word single block performance ──');
{
  const makeDoc = n => Array.from({length: n}, (_, i) => 'word' + (i % 50)).join(' ');
  const before = makeDoc(500);
  const after  = makeDoc(500).replace('word25', 'newterm');
  _diffCache = { key: null, html: null };
  const t = Date.now();
  computeDiffHTML(before, after);
  const ms = Date.now() - t;
  assert(`500-word diff completes in <500ms (took ${ms}ms)`, ms < 500);
}

console.log('\n── 2500-word multi-paragraph performance (<1s via para-level LCS) ──');
{
  // Build a realistic multi-paragraph document: 25 paragraphs × 100 words
  const makePara = (n, seed) => Array.from({length: n}, (_, i) => 'word' + ((i + seed) % 80)).join(' ');
  const paras = Array.from({length: 25}, (_, i) => makePara(100, i * 3));
  const before = paras.join('\n\n');
  const after  = paras.map((p, i) => i % 3 === 0 ? p.replace('word3', 'replaced') : p).join('\n\n');
  _diffCache = { key: null, html: null };
  const t = Date.now();
  computeDiffHTML(before, after);
  const ms = Date.now() - t;
  assert(`2500-word para-level diff completes in <1s (took ${ms}ms)`, ms < 1000, `${ms}ms`);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
