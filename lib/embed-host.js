// ═══════════════════════════════════════════════════
// ParaFree — landing-page embeds (lib/embed-host.js)
// A landing page marks a box with data-pf-embed="<url>" (index.html?embed=paraphraser&… or
// cv-builder.html?embed=1). Nothing of the tool is fetched until the box comes near the screen
// (IntersectionObserver, watched from this page's load event on); then the real tool page is loaded in an iframe — no tool code is copied here.
// Sizing (messages are accepted only from our own origin and from that iframe):
//   pf-para-size {height}        → the frame is exactly as tall as the tool (no inner scrollbar)
//   pf-cv-size {height, mode}    → "flow": as tall as the builder; "app" (≤900px): one screen under the nav
//   pf-cv-focus                  → bring the frame's top under the nav (builder overlays need the screen)
// GA: the embedded pages send no page view of their own (this page already did); their tool events
// fire as normal, tagged embed_page = this page's path.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';
  var d = document, O = location.origin, frames = [], RZ = 0;

  function navH() {
    var n = d.querySelector('body > nav');
    if (!n) return 0;
    var p = getComputedStyle(n).position;
    return p === 'sticky' || p === 'fixed' ? n.offsetHeight : 0;
  }
  function avail() { return Math.max(320, innerHeight - navH()); }
  function host(f) { if (f.pfCv && f.contentWindow) f.contentWindow.postMessage({ type: 'pf-cv-host', vh: avail() }, O); }

  function load(box) {
    if (box.pfLoaded) return;
    box.pfLoaded = 1;
    var src = box.getAttribute('data-pf-embed');
    if (!/^\/[^/]/.test(src)) return;                                // our own pages only
    var f = d.createElement('iframe');
    f.src = src;
    f.title = box.getAttribute('data-pf-title') || 'ParaFree tool';
    f.pfCv = /^\/cv-builder\.html\?/.test(src);
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    f.style.cssText = 'display:block;width:100%;border:0;height:' + (f.pfCv ? avail() : Math.max(320, box.offsetHeight)) + 'px;' +
      (f.pfCv ? 'border-radius:14px;background:#f7f5f0;' : 'background:transparent;');
    f.addEventListener('load', function () {
      var l = box.querySelector('.pf-embed-loading');
      if (l) l.remove();
      host(f);
    });
    box.appendChild(f);
    frames.push(f);
  }

  function frameOf(win) { for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === win) return frames[i]; return null; }
  addEventListener('message', function (e) {
    if (e.origin !== O || !e.data) return;
    var f = frameOf(e.source), m = e.data;
    if (!f) return;
    var box = f.parentNode;
    if (m.type === 'pf-para-size' || m.type === 'pf-cv-size') {
      f.pfMode = m.type === 'pf-cv-size' && m.mode === 'app' ? 'app' : 'flow';
      f.style.height = (f.pfMode === 'app' ? avail() : Math.max(200, Math.min(+m.height || 0, 60000))) + 'px';
      box.style.minHeight = '0';
    } else if (m.type === 'pf-cv-focus') {
      var r = f.getBoundingClientRect(), top = navH();
      if (Math.abs(r.top - top) > 2) scrollBy({ top: r.top - top, behavior: 'smooth' });
    }
  });
  addEventListener('resize', function () {
    clearTimeout(RZ);
    RZ = setTimeout(function () { frames.forEach(function (f) { host(f); if (f.pfMode === 'app') f.style.height = avail() + 'px'; }); }, 150);
  });

  function init() {
    var boxes = d.querySelectorAll('[data-pf-embed]');
    if (!boxes.length) return;
    if (!('IntersectionObserver' in window)) { [].forEach.call(boxes, load); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); load(en.target); } });
    }, { rootMargin: '300px 0px' });
    [].forEach.call(boxes, function (b) { io.observe(b); });
  }
  // only after this page has finished loading, so the tool never competes with the page's own first paint
  if (d.readyState === 'complete') init(); else addEventListener('load', init);
})();
