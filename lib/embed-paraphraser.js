// ═══════════════════════════════════════════════════
// ParaFree — paraphraser embed mode (lib/embed-paraphraser.js)
// index.html loads this ONLY with ?embed=paraphraser (landing pages show the tool card in a lazy iframe,
// see lib/embed-host.js). Without that parameter it is never fetched and the homepage is unchanged.
//
// Here: only the tool card stays (mode, language, input/output, upload, downloads, result notes); nav, hero,
// tabs, marketing, footer, banners, floating buttons and ads are hidden. noindex is added (the page's canonical
// stays https://parafree.app/). Presets: tool=paraphraser|humanizer|summarizer|grammar|detector, mode=, lang=
// (applied here: the homepage's own ?lang= handler runs before the output box exists, so it never applies),
// size=compact (shorter text boxes, for the compact boxes on blog and comparison pages). The height is posted to the host page (same origin
// only), so the iframe is exactly as tall as the tool: no inner scrollbar.
// GA: index.html sends no page view in this mode (the landing page already did); tool events fire as normal,
// with embed_page = the landing page's path.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';
  var d = document, html = d.documentElement, O = location.origin, q = new URLSearchParams(location.search);
  var TOOLS = { paraphraser: 'paraphrase', humanizer: 'humanize', summarizer: 'summarize', grammar: 'grammar', detector: 'detect' };
  // the tool card: everything else that is in the page when it loads is hidden
  var KEEP_ID = ['langBar', 'paraphraseModes', 'humanizeModes', 'previewNote', 'humanScoreBadge', 'tryAgainNote',
    'grammarErrorsPanel', 'paraphraseWrap', 'humanizeWrap', 'summarizeWrap', 'grammarWrap', 'detectWrap', 'scorePanel'];
  var KEEP_CLASS = ['status-bar', 'tool-container'];
  var framed = window.parent !== window;

  var robots = d.createElement('meta'); robots.name = 'robots'; robots.content = 'noindex, follow';
  d.head.appendChild(robots);
  var st = d.createElement('style');
  st.textContent =
    'html.pf-pe,html.pf-pe body{background:transparent!important}' +
    'html.pf-pe body{min-height:0!important;padding-top:12px!important;padding-bottom:4px!important}' +
    'html.pf-pe body>.pf-e-hide,html.pf-pe .pf-pdf-hint,html.pf-pe ins.adsbygoogle,html.pf-pe .google-auto-placed{display:none!important}' +
    (q.get('size') === 'compact' ? 'html.pf-pe textarea,html.pf-pe .output-text{min-height:150px!important}' : '') +
    (framed ? 'html.pf-pe,html.pf-pe body{overflow-y:hidden!important}' : '');
  d.head.appendChild(st);
  if (framed) try { if (typeof gtag === 'function') gtag('set', { embed_page: parent.location.pathname }); } catch (e) {}

  function keep(el) {
    if (KEEP_ID.indexOf(el.id) >= 0) return true;
    for (var i = 0; i < KEEP_CLASS.length; i++) if (el.classList.contains(KEEP_CLASS[i])) return true;
    return /^(SCRIPT|STYLE|NOSCRIPT|LINK|TEMPLATE)$/.test(el.tagName);
  }

  var timer = 0, last = 0;
  function size() {
    timer = 0;
    var b = d.body; if (!b) return;
    var cs = getComputedStyle(b);
    var h = Math.ceil(b.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
    if (h === last) return;
    last = h;
    parent.postMessage({ type: 'pf-para-size', height: h }, O);
  }
  function soon() { if (!timer) timer = setTimeout(size, 60); }

  function ready() {
    var kids = d.body.children;
    for (var i = 0; i < kids.length; i++) if (!keep(kids[i])) kids[i].classList.add('pf-e-hide');
    var tool = TOOLS[q.get('tool')] || 'paraphrase';
    if (tool !== 'paraphrase' && typeof switchTool === 'function') switchTool(tool);
    var lang = (q.get('lang') || '').toLowerCase(), sel = d.getElementById('langSelect'), out = d.getElementById('outputText');
    if (lang && sel && [].some.call(sel.options, function (o) { return o.value === lang; })) {
      sel.value = lang;
      var rtl = /^(arabic|urdu|persian)$/.test(lang);                // same as the homepage's RTL handler
      if (out) { out.setAttribute('dir', rtl ? 'rtl' : 'ltr'); out.style.textAlign = rtl ? 'right' : ''; }
    }
    var mode = q.get('mode');
    if (mode && /^[a-z]+$/.test(mode)) {
      var sel = tool === 'humanize' ? '[data-hmode="' + mode + '"]' : tool === 'paraphrase' ? '#paraphraseModes [data-mode="' + mode + '"]' : '';
      var btn = sel && d.querySelector(sel);
      if (btn) btn.click();
    }
    html.classList.add('pf-e-ready');
    if (!framed) return;
    if (window.ResizeObserver) new ResizeObserver(soon).observe(d.body);
    new MutationObserver(soon).observe(d.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    addEventListener('load', soon);
    size();
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', ready); else ready();
})();
