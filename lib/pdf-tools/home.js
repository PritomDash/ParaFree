// ═══════════════════════════════════════════════════
// ParaFree PDF tools — homepage PDF tab (lib/pdf-tools/home.js)
// Loaded only the first time the homepage "PDF Tools" tab is opened (see the small loader in
// index.html). Reuses the same modules as pdf-tools.html; the tool panels' markup is taken from
// pdf-tools.html itself, so there is one copy. Everything lives inside #pfHomePdf (.pf-home-pdf)
// with its own inputs, output boxes and buttons — the Paraphraser's elements are never touched.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOLS = [
    ['pdf-to-word', '📄 PDF to Word'], ['word-to-pdf', '📝 Word to PDF'], ['jpg-to-pdf', '🖼 JPG to PDF'],
    ['compress-pdf', '🗜 Compress PDF'], ['merge-pdf', '➕ Merge PDF'],
  ];
  const IDS = TOOLS.map((t) => t[0]);
  const MODULES = ['pdf-events', 'loader', 'common', 'pdf-writer', 'pdf-to-word', 'word-to-pdf', 'jpg-to-pdf', 'compress-pdf', 'merge-pdf', 'handoff'];
  const host = () => document.getElementById('pfHomePdf');

  const started = {}, instances = {};
  let built = null, current = null;

  function css(href) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`link[href="${href}"]`)) return resolve();
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = resolve; l.onerror = () => reject(new Error('Could not load ' + href));
      document.head.appendChild(l);
    });
  }
  function js(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function build() {
    await css('/lib/pdf-tools/home.css');
    const res = await fetch('/pdf-tools.html', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('PDF tools page not available');
    const page = new DOMParser().parseFromString(await res.text(), 'text/html');
    const panels = [...page.querySelectorAll('main.pf-tools > .pf-tool-panel')];
    if (panels.length !== IDS.length) throw new Error('PDF tools markup not found');
    // modules first: the panels appear only once their handlers can be attached
    for (const m of MODULES) await js('/lib/pdf-tools/' + m + '.js');
    const h = host();
    h.innerHTML =
      '<div class="pf-home-head">' +
        '<div class="pf-subtabs" role="tablist" aria-label="PDF tools">' +
          TOOLS.map(([id, label]) => `<button type="button" class="pf-subtab" role="tab" data-pftab="${id}" aria-selected="false">${label}</button>`).join('') +
        '</div>' +
        '<a class="pf-home-full" href="/pdf-tools.html">Open full PDF Tools page →</a>' +
      '</div>' +
      '<p class="pf-home-privacy">🔒 Your files never leave your device.</p>' +
      '<div class="pf-home-panels"></div>';
    const box = h.querySelector('.pf-home-panels');
    for (const p of panels) box.appendChild(document.importNode(p, true));
    h.querySelectorAll('.pf-subtab').forEach((b) => b.addEventListener('click', () => activate(b.dataset.pftab, true)));
  }

  // Each sub-tool keeps its own state; leaving one clears it (same rule as pdf-tools.html).
  function activate(id, fromClick) {
    if (!IDS.includes(id)) id = IDS[0];
    if (current && current !== id && instances[current] && instances[current].reset) instances[current].reset();
    current = id;
    const h = host();
    h.querySelectorAll('.pf-subtab').forEach((b) => {
      const on = b.dataset.pftab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    h.querySelectorAll('.pf-tool-panel').forEach((p) => { p.hidden = p.dataset.tool !== id; });
    const full = h.querySelector('.pf-home-full');
    if (full) full.href = '/pdf-tools.html#' + id;
    if (fromClick) { try { history.replaceState(history.state, '', '#' + id); } catch (e) { /* ignore */ } }
    const panel = h.querySelector('#panel-' + id);
    const tool = window.PFTools && window.PFTools[id];
    if (!panel || !tool || started[id]) return;
    started[id] = true;
    instances[id] = tool.init(panel) || null;
    const status = panel.querySelector('[data-role="lib-status"]');
    if (status) status.textContent = 'Loading tool…';
    tool.libs().then(() => { if (status) status.textContent = 'Ready'; },
      () => { if (status) status.textContent = 'Could not load this tool — check your connection'; });
  }

  window.PFHome = {
    async open(tool) {
      if (!built) built = build().catch((e) => { built = null; throw e; });
      await built;
      activate(tool || current || IDS[0], false);
    },
    // leaving the PDF tab clears the open tool (its file, result and downloads)
    close() {
      if (current && instances[current] && instances[current].reset) instances[current].reset();
    },
    TOOLS: IDS,
  };
})();
