// ═══════════════════════════════════════════════════
// ParaFree PDF tools — homepage PDF tab (lib/pdf-tools/home.js)
// The tab's shell (sub-tabs, "Loading tool…") is drawn at once by the small loader in index.html;
// this file then loads, IN PARALLEL, the panels (lib/pdf-tools/panels.js), the core modules and
// only the ACTIVE tool's module. Other tools' modules load when their sub-tab is first opened.
// Everything is versioned (?v=) and long-cached. Same modules as pdf-tools.html, no copies.
// Everything lives inside #pfHomePdf (.pf-home-pdf) — the Paraphraser's elements are never touched.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const IDS = ['pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf', 'pdf-to-jpg'];
  const CORE = ['panels', 'pdf-events', 'loader', 'common'];
  const V = window.PFV || '';
  const url = (name, ext = '.js') => '/lib/pdf-tools/' + name + ext + (V ? '?v=' + V : '');
  const host = () => document.getElementById('pfHomePdf');

  // Shared with common.loadModule: one <script> per module, downloads in parallel, runs in order.
  const modules = (window.PFModules = window.PFModules || {});
  function load(name) {
    if (!modules[name]) {
      modules[name] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url(name);
        s.async = false;
        s.onload = resolve;
        s.onerror = () => { delete modules[name]; reject(new Error('Could not load ' + name)); };
        document.head.appendChild(s);
      });
    }
    return modules[name];
  }
  function css() {
    if (document.getElementById('pfHomeCss')) return;
    const l = document.createElement('link');
    l.id = 'pfHomeCss'; l.rel = 'stylesheet'; l.href = url('home', '.css');
    document.head.appendChild(l);
  }

  let coreReady = null, current = null;
  const started = {}, instances = {};

  // panels + core modules (in parallel); the panels replace the "Loading tool…" note
  function core() {
    if (!coreReady) {
      css();
      coreReady = Promise.all(CORE.map(load)).then(() => {
        const box = host().querySelector('.pf-home-panels');
        window.PFPanels.render(box);
      }, (e) => { coreReady = null; throw e; });
    }
    return coreReady;
  }

  function markTabs(id) {
    const h = host();
    h.querySelectorAll('.pf-subtab').forEach((b) => {
      const on = b.dataset.pftab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const full = h.querySelector('.pf-home-full');
    if (full) full.href = '/pdf-tools.html#' + id;
  }

  // Each sub-tool keeps its own state; leaving one clears it (same rule as pdf-tools.html).
  async function activate(id, fromClick) {
    if (!IDS.includes(id)) id = IDS[0];
    if (current && current !== id && instances[current] && instances[current].reset) instances[current].reset();
    current = id;
    markTabs(id);
    if (fromClick) { try { history.replaceState(history.state, '', '#' + id); } catch (e) { /* ignore */ } }
    const coreP = core();            // appended first, so it runs before the tool module
    const toolP = load(id);          // …but both download at the same time
    await coreP;
    if (current !== id) return;
    const h = host();
    h.querySelectorAll('.pf-tool-panel').forEach((p) => { p.hidden = p.dataset.tool !== id; });
    const panel = h.querySelector('#panel-' + id);
    if (!panel || started[id]) return;
    started[id] = true;
    const status = panel.querySelector('[data-role="lib-status"]');
    if (status) status.textContent = 'Loading tool…';
    const release = window.PFC.holdFiles(panel);              // a file picked meanwhile is kept
    try { await toolP; } catch (e) {
      if (status) status.textContent = 'Could not load this tool — check your connection';
      started[id] = false;
      return;
    }
    const tool = window.PFTools[id];
    instances[id] = tool.init(panel) || null;
    panel.dataset.ready = '1';
    release();
    tool.libs().then(() => { if (status) status.textContent = 'Ready'; },
      () => { if (status) status.textContent = 'Could not load this tool — check your connection'; });
  }

  window.PFHome = {
    open(tool, fromClick) { return activate(tool || current || IDS[0], fromClick); },
    // leaving the PDF tab clears the open tool (its file, result and downloads)
    close() {
      if (current && instances[current] && instances[current].reset) instances[current].reset();
    },
    TOOLS: IDS,
  };
})();
