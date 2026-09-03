'use strict';
// Tests for the typing animation timing logic extracted from renderOutput.

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Mirror the animation parameters from renderOutput
function animParams(content) {
  const words = content.split(' ');
  const total = words.length;
  if (total <= 6) return { skipped: true, total };
  const STEPS = Math.min(60, total);
  const wordsPerStep = Math.ceil(total / STEPS);
  const stepMs = Math.max(10, Math.round(700 / STEPS));
  const estimatedMs = STEPS * stepMs;
  return { skipped: false, total, STEPS, wordsPerStep, stepMs, estimatedMs };
}

console.log('\n── Very short text (≤6 words) — no animation ──');
{
  const p = animParams('Hello world');
  assert('2-word text skipped', p.skipped === true);
  const p2 = animParams('One two three four five six');
  assert('6-word text skipped', p2.skipped === true);
  const p3 = animParams('One two three four five six seven');
  assert('7-word text NOT skipped', p3.skipped === false);
}

console.log('\n── Short text (~30 words) ──');
{
  const text = Array(30).fill('word').join(' ');
  const p = animParams(text);
  assert('STEPS = min(60, 30) = 30', p.STEPS === 30, `got ${p.STEPS}`);
  assert('wordsPerStep = 1', p.wordsPerStep === 1, `got ${p.wordsPerStep}`);
  assert('stepMs ≥ 10', p.stepMs >= 10, `got ${p.stepMs}`);
  assert('total time ≤ 800ms', p.estimatedMs <= 800, `got ${p.estimatedMs}ms`);
}

console.log('\n── Medium text (~200 words) ──');
{
  const text = Array(200).fill('word').join(' ');
  const p = animParams(text);
  assert('STEPS capped at 60', p.STEPS === 60, `got ${p.STEPS}`);
  assert('wordsPerStep ≥ 3', p.wordsPerStep >= 3, `got ${p.wordsPerStep}`);
  assert('total time ~700ms', p.estimatedMs <= 750, `got ${p.estimatedMs}ms`);
  // Verify coverage: all words revealed
  const totalRevealed = p.STEPS * p.wordsPerStep;
  assert('all words covered (wordsPerStep*STEPS ≥ total)', totalRevealed >= 200,
    `${p.STEPS}×${p.wordsPerStep}=${totalRevealed} vs total=200`);
}

console.log('\n── Long text (~1000 words) ──');
{
  const text = Array(1000).fill('word').join(' ');
  const p = animParams(text);
  assert('STEPS capped at 60', p.STEPS === 60, `got ${p.STEPS}`);
  assert('wordsPerStep = ceil(1000/60) = 17', p.wordsPerStep === 17, `got ${p.wordsPerStep}`);
  assert('stepMs ≥ 10', p.stepMs >= 10, `got ${p.stepMs}`);
  assert('total time ~700ms', p.estimatedMs <= 750, `got ${p.estimatedMs}ms`);
}

console.log('\n── Very long text (~5000 words) ──');
{
  const text = Array(5000).fill('word').join(' ');
  const p = animParams(text);
  assert('STEPS still 60', p.STEPS === 60, `got ${p.STEPS}`);
  assert('stepMs ≥ 10', p.stepMs >= 10, `got ${p.stepMs}`);
  assert('total time ~700ms regardless of length', p.estimatedMs <= 750, `got ${p.estimatedMs}ms`);
  const totalRevealed = p.STEPS * p.wordsPerStep;
  assert('all 5000 words covered', totalRevealed >= 5000,
    `${p.STEPS}×${p.wordsPerStep}=${totalRevealed}`);
}

console.log('\n── stepMs is always ≥ 10ms (minimum tick) ──');
{
  [7, 10, 30, 60, 100, 500].forEach(n => {
    const p = animParams(Array(n).fill('w').join(' '));
    if (!p.skipped) {
      assert(`${n}-word text: stepMs ≥ 10`, p.stepMs >= 10, `got ${p.stepMs}`);
    }
  });
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
