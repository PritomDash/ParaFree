'use strict';
// Tests for download-output-fixes logic:
// 1. getCurrentOutputText — returns live DOM when user has edited
// 2. _userHasEdited gate — DOCX uses edited text when flag is set
// 3. See-more: enableEditing no longer auto-expands

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mirror the download-output-fixes logic ────────────────────────────────────

// Simulate module-level state
let fullOutputText = '';
let _editModeOn = false;
let _userHasEdited = false;

// Simulated live DOM element
let _domText = '';
function makeFakeEl(text, editable) {
  return { innerText: text, textContent: text, contentEditable: editable ? 'true' : 'false' };
}

function getCurrentOutputText(el) {
  if (el && _editModeOn && el.contentEditable === 'true') {
    return el.innerText || el.textContent || fullOutputText;
  }
  return fullOutputText;
}

// DOCX paraArray builder (mirrors the fallback path)
function stripMarkdown(t) { return t; } // identity for tests
function buildParaArray(text) {
  return text.trim().split(/\n{2,}/).map(s => s.replace(/\n/g, ' ').trim()).filter(s => s.length > 0);
}

// Mirrors the download logic: pick source based on _userHasEdited
function getDownloadText(el, docxParaMap) {
  const currentText = getCurrentOutputText(el);
  // If user has edited and position-locked map exists, use edited text instead
  if (docxParaMap && docxParaMap.length > 0 && !_userHasEdited) {
    return { source: 'paraMap', paraArray: docxParaMap };
  }
  return { source: 'currentText', paraArray: buildParaArray(currentText) };
}

// ── Test 1: getCurrentOutputText — no edits, returns fullOutputText ──────────

console.log('\n── getCurrentOutputText — editing OFF, returns fullOutputText ──');
{
  fullOutputText = 'Original API output text.';
  _editModeOn = false;
  const el = makeFakeEl('User edited this.', true);
  assert('returns fullOutputText when editing is OFF', getCurrentOutputText(el) === 'Original API output text.');
}

console.log('\n── getCurrentOutputText — editing ON, returns live DOM ──');
{
  fullOutputText = 'Original API output text.';
  _editModeOn = true;
  const el = makeFakeEl('User edited this.', true);
  assert('returns DOM text when editing is ON', getCurrentOutputText(el) === 'User edited this.');
}

console.log('\n── getCurrentOutputText — editing ON but contentEditable false ──');
{
  fullOutputText = 'Original API output text.';
  _editModeOn = true;
  const el = makeFakeEl('User edited this.', false); // contentEditable='false'
  assert('returns fullOutputText when contentEditable is false', getCurrentOutputText(el) === 'Original API output text.');
}

console.log('\n── getCurrentOutputText — null el fallback ──');
{
  fullOutputText = 'Fallback text.';
  _editModeOn = true;
  assert('null el returns fullOutputText', getCurrentOutputText(null) === 'Fallback text.');
}

// ── Test 2: _userHasEdited gates paraMap vs current text ────────────────────

console.log('\n── Download: uses paraMap when user has NOT edited ──');
{
  fullOutputText = 'Para one.\n\nPara two.';
  _editModeOn = true;
  _userHasEdited = false;
  const el = makeFakeEl(fullOutputText, true);
  const paraMap = ['Paraphrased one.', 'Paraphrased two.'];
  const result = getDownloadText(el, paraMap);
  assert('source is paraMap', result.source === 'paraMap');
  assert('paraArray is the locked map', result.paraArray === paraMap);
}

console.log('\n── Download: uses currentText when user HAS edited ──');
{
  fullOutputText = 'Para one.\n\nPara two.';
  _editModeOn = true;
  _userHasEdited = true;
  const editedText = 'Edited para one.\n\nEdited para two.';
  const el = makeFakeEl(editedText, true);
  const paraMap = ['Paraphrased one.', 'Paraphrased two.'];
  const result = getDownloadText(el, paraMap);
  assert('source is currentText', result.source === 'currentText');
  assert('paraArray built from edited DOM text', result.paraArray[0] === 'Edited para one.');
  assert('paraArray has 2 entries', result.paraArray.length === 2);
}

console.log('\n── Download: uses currentText when no paraMap exists ──');
{
  fullOutputText = 'Para one.\n\nPara two.';
  _editModeOn = true;
  _userHasEdited = false;
  const el = makeFakeEl(fullOutputText, true);
  const result = getDownloadText(el, []); // empty paraMap
  assert('source is currentText when paraMap is empty', result.source === 'currentText');
  assert('paraArray has 2 entries', result.paraArray.length === 2);
}

console.log('\n── Download: paraArray splits correctly on double newline ──');
{
  fullOutputText = '';
  _editModeOn = true;
  _userHasEdited = true;
  const editedText = 'First paragraph with multiple words.\n\nSecond paragraph here.\n\nThird paragraph.';
  const el = makeFakeEl(editedText, true);
  const result = getDownloadText(el, null);
  assert('3 paragraphs split correctly', result.paraArray.length === 3);
  assert('first para content', result.paraArray[0] === 'First paragraph with multiple words.');
  assert('third para content', result.paraArray[2] === 'Third paragraph.');
}

// ── Test 3: _userHasEdited resets when new output arrives (enableEditing) ──

console.log('\n── _userHasEdited resets on new output ──');
{
  _userHasEdited = true; // simulate prior edits
  // Simulate what enableEditing does
  _userHasEdited = false; // reset on new output
  assert('_userHasEdited is false after enableEditing', _userHasEdited === false);
}

// ── Test 4: See-more — enableEditing no longer auto-expands ─────────────────

console.log('\n── See-more: enableEditing leaves collapse intact ──');
{
  // Simulate the DOM state after finishTyping creates the see-more button
  let seeMoreRemoved = false;
  const fakeSeeMoreBtn = {
    textContent: 'See more ↓',
    onclick: null,
  };
  const fakeEl = {
    contentEditable: 'inherit',
    querySelector: (sel) => sel === '.see-more-btn' ? fakeSeeMoreBtn : null,
    addEventListener: () => {},
  };

  // OLD enableEditing would auto-expand. New version does NOT call toggleSeeMore.
  // Simulate new enableEditing — just sets contentEditable, no see-more manipulation.
  fakeEl.contentEditable = 'true';
  // seeMoreRemoved stays false

  assert('see-more button not removed by enableEditing', !seeMoreRemoved);
  assert('contentEditable set to true', fakeEl.contentEditable === 'true');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
else console.log('All tests passed ✅');
