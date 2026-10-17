// ═══════════════════════════════════════════════════
// ParaFree — GA4 events for the PDF tools page (lib/pdf-tools/pdf-events.js)
// Same pattern as lib/tool-events.js, with its own allow-list. Loaded by pdf-tools.html
// (window.PFPdfEvents) and by node tests (module.exports). Uses the page's gtag (G-0QEEGS0DZQ).
//
// PRIVACY: only the parameters below are ever sent, and only with values from fixed lists.
// File names, sizes, page counts and file content are never passed in — anything unexpected
// is dropped. Every call is guarded: nothing breaks if GA is blocked or this file fails to load.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';

  const TOOLS = ['pdf_to_word', 'word_to_pdf', 'jpg_to_pdf', 'compress_pdf', 'merge_pdf'];
  const VALUES = {
    tool:       TOOLS,
    input_type: ['pdf', 'docx', 'image'],
    format:     ['docx', 'pdf'],
    error_type: ['encrypted', 'too_large', 'too_many_pages', 'unsupported', 'file_error', 'other'],
  };

  const EVENTS = {
    tool_used:       ['tool', 'input_type'],
    result_download: ['tool', 'format'],
    tool_error:      ['tool', 'error_type'],
    pdf_edit_used:   ['tool'],
  };

  // Sends `name` with only its allowed params. Returns the params sent (null if not sent).
  function send(name, params) {
    const keys = EVENTS[name];
    if (!keys) return null;
    const out = {};
    for (const k of keys) {
      if (!params || !VALUES[k].includes(params[k])) return null;  // never send a partial/odd event
      out[k] = params[k];
    }
    try {
      if (typeof gtag === 'function') { gtag('event', name, out); return out; }
    } catch (e) { /* analytics must never break a tool */ }
    return null;
  }

  // pdf_edit_used fires once per tool per browser session.
  const editedThisSession = new Set();
  function editUsed(tool) {
    if (editedThisSession.has(tool)) return null;
    let key = 'pf_pdf_edit_' + tool, seen = false;
    try { seen = sessionStorage.getItem(key) === '1'; } catch (e) { /* storage blocked */ }
    editedThisSession.add(tool);
    if (seen) return null;
    try { sessionStorage.setItem(key, '1'); } catch (e) { /* storage blocked */ }
    return send('pdf_edit_used', { tool });
  }

  const api = {
    EVENTS, VALUES, send, editUsed,
    toolUsed:       (tool, inputType) => send('tool_used', { tool, input_type: inputType }),
    resultDownload: (tool, format) => send('result_download', { tool, format }),
    toolError:      (tool, errorType) => send('tool_error', { tool, error_type: VALUES.error_type.includes(errorType) ? errorType : 'other' }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PFPdfEvents = api;
})(typeof window !== 'undefined' ? window : null);
