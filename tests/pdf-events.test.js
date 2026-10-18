'use strict';
// GA allow-list for the PDF tools page — lib/pdf-tools/pdf-events.js. No network: gtag is a stub.
// Run: node tests/pdf-events.test.js

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}

const sent = [];
global.gtag = (kind, name, params) => sent.push([kind, name, params]);
const store = new Map();
global.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
global.fetch = async () => { throw new Error('network blocked in test'); };

const E = require('../lib/pdf-tools/pdf-events.js');
const last = () => sent[sent.length - 1];

console.log('\n── allowed events ──');
for (const tool of ['pdf_to_word', 'word_to_pdf', 'jpg_to_pdf', 'compress_pdf', 'merge_pdf']) {
  const input = { pdf_to_word: 'pdf', word_to_pdf: 'docx', jpg_to_pdf: 'image', compress_pdf: 'pdf', merge_pdf: 'pdf' }[tool];
  E.toolUsed(tool, input);
  assert(`tool_used ${tool}`, JSON.stringify(last()) === JSON.stringify(['event', 'tool_used', { tool, input_type: input }]), JSON.stringify(last()));
}
E.resultDownload('pdf_to_word', 'docx');
assert('result_download docx', JSON.stringify(last()) === JSON.stringify(['event', 'result_download', { tool: 'pdf_to_word', format: 'docx' }]));
for (const t of ['encrypted', 'too_large', 'too_many_pages', 'unsupported', 'file_error', 'other']) {
  E.toolError('merge_pdf', t);
  assert(`tool_error ${t}`, last()[2].error_type === t);
}
E.toolError('merge_pdf', 'something odd');
assert('unknown error types are sent as "other"', last()[2].error_type === 'other');

console.log('\n── nothing else gets through ──');
let n = sent.length;
E.send('tool_used', { tool: 'pdf_to_word', input_type: 'pdf', file_name: 'my essay.pdf', size: 12345 });
assert('extra params (file name, size) are dropped', JSON.stringify(last()[2]) === '{"tool":"pdf_to_word","input_type":"pdf"}', JSON.stringify(last()));
n = sent.length;
E.toolUsed('paraphrase', 'pdf');
E.toolUsed('pdf_to_word', 'my essay.pdf');
E.resultDownload('merge_pdf', 'zip');
E.send('file_uploaded', { tool: 'merge_pdf' });
E.send('tool_used', null);
assert('unknown tools / values / events are not sent', sent.length === n, sent.length - n);

console.log('\n── pdf_edit_used once per tool per session ──');
n = sent.length;
E.editUsed('pdf_to_word'); E.editUsed('pdf_to_word'); E.editUsed('pdf_to_word');
assert('first edit sends, later edits do not', sent.length === n + 1 && last()[1] === 'pdf_edit_used' && last()[2].tool === 'pdf_to_word');
E.editUsed('word_to_pdf');
assert('a different tool sends its own event', sent.length === n + 2 && last()[2].tool === 'word_to_pdf');
delete require.cache[require.resolve('../lib/pdf-tools/pdf-events.js')];
const E2 = require('../lib/pdf-tools/pdf-events.js');
n = sent.length;
E2.editUsed('pdf_to_word');
assert('still once after a reload in the same session (sessionStorage)', sent.length === n);
E2.editUsed('bogus_tool');
assert('edit event for an unknown tool is not sent', sent.length === n);

console.log('\n── GA failures never break a tool ──');
global.gtag = () => { throw new Error('blocked'); };
let threw = false;
try { E.toolUsed('merge_pdf', 'pdf'); } catch (e) { threw = true; }
assert('gtag throwing is swallowed', !threw);
delete global.gtag;
assert('no gtag → returns null quietly', E.toolUsed('merge_pdf', 'pdf') === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
