// ParaFree — Dancing Cats loader (lib/cats/loader.js). Included once per tool page with <script defer>.
// Does nothing until the page has loaded AND the browser is idle, then fetches lib/cats/cats.js (the widget).
// Never runs inside an iframe or an embedded tool (?embed=…), on admin pages, on screens 768 px wide or less (mobile),
// or when window.PF_NO_CATS is set.
// No network calls of its own, no cookies, no tracking.
(function () {
  'use strict';
  try {
    if (window.PF_NO_CATS || window.top !== window.self) return;
    if (/[?&]embed=/.test(location.search) || /admin/i.test(location.pathname)) return;
  } catch (_) { return; }   // a cross-origin parent throws on window.top — that is an iframe too
  // Not on phones / small tablets: nothing is fetched at all there
  try { if (window.matchMedia('(max-width: 768px)').matches) return; } catch (_) {}
  var me = document.currentScript;
  var src = (me && me.src ? me.src.replace(/loader\.js(\?.*)?$/, '') : '/lib/cats/') + 'cats.js';
  function start() {
    if (window.PFCats) return;
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (me && me.dataset.renderer) s.dataset.renderer = me.dataset.renderer;   // "video" + data-src → WebM renderer
    if (me && me.dataset.src) s.dataset.src = me.dataset.src;
    document.body.appendChild(s);
  }
  function whenIdle() {
    var ric = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };
    ric(start, { timeout: 5000 });
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
})();
