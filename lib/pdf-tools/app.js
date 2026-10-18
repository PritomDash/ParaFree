// ═══════════════════════════════════════════════════
// ParaFree PDF tools — page controller (lib/pdf-tools/app.js)
// Tabs with URL hashes (#pdf-to-word, #word-to-pdf, #jpg-to-pdf, #compress-pdf, #merge-pdf).
// A tab's libraries are fetched from the CDN the first time that tab is opened.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TABS = ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf'];
  const DEFAULT = 'pdf-to-word';
  const started = {};
  const instances = {};          // id → { reset } returned by each tool's init
  let current = null;

  function fromHash() {
    const h = decodeURIComponent((location.hash || '').slice(1));
    return TABS.includes(h) ? h : null;
  }

  // Each tab keeps its own state. Leaving a tab clears its file, result and download, so a
  // download button can never hand out something made in another tab.
  function activate(id) {
    if (current && current !== id && instances[current] && instances[current].reset) instances[current].reset();
    current = id;
    document.querySelectorAll('.tool-tab[data-tab]').forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.pf-tool-panel').forEach((p) => { p.hidden = p.dataset.tool !== id; });
    const panel = document.getElementById('panel-' + id);
    const tool = window.PFTools && window.PFTools[id];
    if (!panel || !tool || started[id]) return;
    started[id] = true;
    instances[id] = tool.init(panel) || null;
    const status = panel.querySelector('[data-role="lib-status"]');
    if (status) status.textContent = 'Loading tool…';
    tool.libs().then(
      () => { if (status) status.textContent = 'Ready'; },
      () => { if (status) status.textContent = 'Could not load this tool — check your connection'; },
    );
  }

  document.querySelectorAll('.tool-tab[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.tab;
      activate(id);                     // right away, so the panel is ready before any file is chosen
      if (fromHash() !== id) history.pushState(null, '', '#' + id);   // back button → hashchange/popstate
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.indexOf(b.dataset.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      const nb = document.querySelector(`.tool-tab[data-tab="${next}"]`);
      nb.focus(); nb.click();
    });
  });
  const onHash = () => { activate(fromHash() || DEFAULT); };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);
  // "Try it" links further down the page jump back up to the tools.
  document.querySelectorAll('a.pf-try[href^="#"]').forEach((a) => a.addEventListener('click', () => {
    const wrap = document.querySelector('.tool-tabs-wrap');
    if (wrap) setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }));
  activate(fromHash() || DEFAULT);

  // Same nav behaviour as the homepage: transparent over the hero, white once scrolled.
  const nav = document.getElementById('mainNav');
  let scrolled = false;
  function onScroll() {
    const s = window.scrollY > 20;
    if (s === scrolled) return;
    scrolled = s;
    nav.classList.toggle('pf-nav-scrolled', s);
    const logo = document.getElementById('navLogo');
    if (logo) logo.src = s ? '/logo.svg' : '/logo-dark.svg';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

function toggleMenu() {
  var m = document.getElementById('mobileMenu');
  if (!m) return;
  m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
}
