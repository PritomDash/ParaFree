// ═══════════════════════════════════════════════════
// ParaFree — GA4 custom events (lib/tool-events.js)
// Loaded by index.html, cv-builder.html and code.html (window.PFEvents) and by node
// tests (module.exports). Uses the page's existing gtag setup (G-0QEEGS0DZQ).
//
// PRIVACY: only the parameters below are ever sent, and only with values from fixed
// lists (template ids must look like a slug). User text, file names, CV content, names,
// emails and job-search keywords are never passed in — anything unexpected is dropped.
// Every call is guarded: nothing breaks if GA is blocked or this file fails to load.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';

  const TOOLS = ['paraphrase', 'humanize', 'summarize', 'grammar', 'ai_detect', 'ai_chat', 'ai_code'];
  const VALUES = {
    tool:        TOOLS,
    input_type:  ['text', 'txt', 'pdf', 'docx', 'doc', 'pptx'],
    word_bucket: ['<300', '300-1000', '1000-3000', '3000+'],
    error_type:  ['all_busy', 'timeout', 'file_error', 'other'],
    format:      ['docx', 'pptx', 'pdf', 'txt', 'code'],
    has_results: [true, false],
    sample:      ['true', 'false'],      // cv_download: the sample CV ("Download this sample as PDF") vs the user's own CV
    reason:      ['sample_showing', 'overflow', 'empty', 'other'],
    field:       ['name', 'jobtitle', 'email', 'phone', 'location', 'linkedin', 'summary', 'skills', 'certs', 'experience', 'education', 'other'],
  };
  const TEMPLATE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

  const EVENTS = {
    tool_used:       ['tool', 'input_type', 'word_bucket'],
    tool_error:      ['tool', 'error_type'],
    result_download: ['tool', 'format'],
    cv_download:     ['template', 'format', 'sample'],
    cover_letter_download: ['format'],
    job_search:      ['has_results'],
    cv_download_blocked: ['reason'],      // CV PDF clicked but nothing downloaded, and why
    cv_started:      ['field'],           // first CV field typed in (once per page load); field = which section, never its text
  };

  function validValue(key, v) {
    if (key === 'template') return typeof v === 'string' && TEMPLATE_RE.test(v);
    return VALUES[key].includes(v);
  }

  // Sends `name` with only its allowed params. Returns the params sent (null if not sent).
  function send(name, params) {
    const keys = EVENTS[name];
    if (!keys) return null;
    const out = {};
    for (const k of keys) {
      if (!params || !validValue(k, params[k])) return null;  // never send a partial/odd event
      out[k] = params[k];
    }
    try {
      if (typeof gtag === 'function') { gtag('event', name, out); return out; }
    } catch (e) { /* analytics must never break a tool */ }
    return null;
  }

  function wordBucket(words) {
    const n = Number(words) || 0;
    if (n < 300) return '<300';
    if (n < 1000) return '300-1000';
    if (n < 3000) return '1000-3000';
    return '3000+';
  }

  // index.html's internal tool ids → event tool names
  function toolName(id) {
    if (id === 'detect') return 'ai_detect';
    return TOOLS.includes(id) ? id : null;
  }

  // Why a /api/process call failed, from its HTTP status (0 = no response / not JSON).
  // 503 is the backend's "all providers busy" answer (high_demand); 504 is Vercel's timeout.
  function errorTypeFromStatus(status) {
    if (status === 503) return 'all_busy';
    if (status === 504) return 'timeout';
    return 'other';
  }

  const api = {
    EVENTS, VALUES, send, wordBucket, toolName, errorTypeFromStatus,
    toolUsed:       (tool, inputType, words) => send('tool_used', { tool, input_type: inputType, word_bucket: wordBucket(words) }),
    toolError:      (tool, errorType) => send('tool_error', { tool, error_type: errorType }),
    resultDownload: (tool, format) => send('result_download', { tool, format }),
    cvDownload:     (template, format, sample) => send('cv_download', { template, format, sample: sample === true ? 'true' : 'false' }),
    coverLetterDownload: (format) => send('cover_letter_download', { format }),
    jobSearch:      (hasResults) => send('job_search', { has_results: !!hasResults }),
    cvDownloadBlocked: (reason) => send('cv_download_blocked', { reason }),
    cvStarted:      (field) => send('cv_started', { field }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PFEvents = api;
})(typeof window !== 'undefined' ? window : this);
