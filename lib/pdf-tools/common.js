// ═══════════════════════════════════════════════════
// ParaFree PDF tools — shared helpers (lib/pdf-tools/common.js)
// Limits, file checks, progress, downloads, sortable file lists, the editable output box and
// HTML → PDF. Files are read with File.arrayBuffer() and stay in memory in this tab; nothing
// in this file (or any lib/pdf-tools file) uploads them.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const MB = 1024 * 1024;
  const LIMITS = { fileBytes: 50 * MB, totalBytes: 200 * MB, wordPages: 50, pages: 300 };

  class ToolError extends Error {
    constructor(type, message) { super(message); this.type = type; }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
    return (n / MB).toFixed(n < 10 * MB ? 2 : 1) + ' MB';
  }

  // "My Notes.final.pdf" → "My Notes.final"
  function baseName(name) {
    const b = String(name || 'file').replace(/\.[^.\\/]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
    return b || 'file';
  }

  function extOf(name) {
    const m = /\.([^.]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function checkSizes(files) {
    let total = 0;
    for (const f of files) {
      if (f.size > LIMITS.fileBytes) {
        throw new ToolError('too_large', `"${f.name}" is ${fmtBytes(f.size)}. The limit is 50 MB per file — try compressing it first or splitting it.`);
      }
      total += f.size;
    }
    if (total > LIMITS.totalBytes) {
      throw new ToolError('too_large', `These files add up to ${fmtBytes(total)}. The limit is 200 MB per task — try fewer files at a time.`);
    }
  }

  function checkPages(count, max, what) {
    if (count > max) {
      throw new ToolError('too_many_pages', `${what} has ${count} pages. This tool handles up to ${max} pages at a time — try splitting it into smaller parts.`);
    }
  }

  function isPdfFile(f) { return extOf(f.name) === 'pdf' || f.type === 'application/pdf'; }

  // pdf-lib and pdf.js report password protection differently.
  function isEncryptedError(e) {
    if (!e) return false;
    return e.name === 'PasswordException' || e.name === 'EncryptedPDFError' ||
      /encrypt|password/i.test(String(e.message || ''));
  }

  function encryptedError(name) {
    return new ToolError('encrypted', `"${name}" is password-protected (encrypted). Please remove the password first (open it, then print or save it as a new PDF), then try again.`);
  }

  // Turn anything thrown into a ToolError with a friendly message.
  function toToolError(e, fileName) {
    if (e instanceof ToolError) return e;
    if (isEncryptedError(e)) return encryptedError(fileName || 'This PDF');
    if (e && (e.name === 'InvalidPDFException' || /invalid pdf|failed to parse|no pdf header/i.test(String(e.message)))) {
      return new ToolError('file_error', `${fileName ? '"' + fileName + '"' : 'This file'} could not be read as a PDF. It may be damaged — try opening and re-saving it.`);
    }
    if (e && /Could not load|Library did not load|Failed to fetch dynamically imported module/i.test(String(e.message))) {
      return new ToolError('other', 'A part of this tool could not be downloaded. Please check your connection and try again.');
    }
    console.error('[pdf-tools]', e);
    return new ToolError('other', 'Something went wrong while processing this file. Please try again, or try a different file.');
  }

  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality));
  }

  // ── Per-panel UI pieces ───────────────────────────
  function q(panel, role) { return panel.querySelector('[data-role="' + role + '"]'); }

  function progress(panel) {
    const wrap = q(panel, 'progress');
    const bar = wrap.querySelector('.pf-progress-bar span');
    const label = wrap.querySelector('.pf-progress-label');
    return {
      set(fraction, text) {
        wrap.hidden = false;
        bar.style.width = Math.max(2, Math.min(100, Math.round(fraction * 100))) + '%';
        if (text != null) label.textContent = text;
      },
      hide() { wrap.hidden = true; bar.style.width = '0%'; label.textContent = ''; },
    };
  }

  function showError(panel, err) {
    const el = q(panel, 'error');
    el.textContent = err.message;
    el.hidden = false;
  }
  function clearError(panel) {
    const el = q(panel, 'error'); el.hidden = true; el.textContent = '';
    const note = q(panel, 'note'); if (note) note.hidden = true;
  }

  // Tap-to-choose (the zone is a <label> around the file input) plus drag-and-drop.
  function setupDrop(panel, onFiles) {
    const zone = q(panel, 'drop');
    const input = zone.querySelector('input[type=file]');
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      if (files.length) onFiles(files);
    });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('pf-drop-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('pf-drop-over')));
    zone.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      onFiles([...e.dataTransfer.files]);
    });
  }

  // A reorderable list: drag on desktop, ↑/↓ buttons on touch screens, ✕ to remove.
  // items: [{ id, ... }]; renderItem(item) → inner HTML element for the row.
  function sortableList(listEl, { renderItem, onChange }) {
    let items = [];
    let dragId = null;

    function render() {
      listEl.innerHTML = '';
      items.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'pf-item';
        li.draggable = true;
        li.dataset.id = item.id;
        li.appendChild(renderItem(item, i));
        const ctr = document.createElement('div');
        ctr.className = 'pf-item-controls';
        ctr.innerHTML =
          `<button type="button" class="pf-icon-btn" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>` +
          `<button type="button" class="pf-icon-btn" data-act="down" aria-label="Move down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>` +
          `<button type="button" class="pf-icon-btn pf-icon-remove" data-act="remove" aria-label="Remove">✕</button>`;
        li.appendChild(ctr);
        listEl.appendChild(li);
      });
      onChange(items);
    }

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.pf-item').dataset.id;
      const i = items.findIndex((x) => String(x.id) === id);
      if (i < 0) return;
      if (btn.dataset.act === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
      else if (btn.dataset.act === 'down' && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
      else if (btn.dataset.act === 'remove') { const [gone] = items.splice(i, 1); if (gone.dispose) gone.dispose(); }
      render();
    });
    listEl.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.pf-item');
      if (!li) return;
      dragId = li.dataset.id;
      li.classList.add('pf-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* old browsers */ }
    });
    listEl.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
    listEl.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const target = e.target.closest('.pf-item');
      const from = items.findIndex((x) => String(x.id) === dragId);
      let to = target ? items.findIndex((x) => String(x.id) === target.dataset.id) : items.length - 1;
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
      }
      dragId = null;
      render();
    });
    listEl.addEventListener('dragend', () => { dragId = null; listEl.querySelectorAll('.pf-dragging').forEach((n) => n.classList.remove('pf-dragging')); });

    return {
      get items() { return items; },
      add(newItems) { items = items.concat(newItems); render(); },
      clear() { items.forEach((x) => x.dispose && x.dispose()); items = []; render(); },
    };
  }

  // Editable output box with a ✏ toggle like the homepage. Fires pdf_edit_used once.
  function editableOutput(panel, gaTool) {
    const box = q(panel, 'output');
    const toggle = q(panel, 'edit-toggle');
    let on = true;
    function apply() {
      box.contentEditable = on ? 'true' : 'false';
      toggle.classList.toggle('fmt-btn-active', on);
      toggle.title = on ? 'Editing ON — click to lock text' : 'Editing OFF — click to edit the text';
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    toggle.addEventListener('click', () => { on = !on; apply(); });
    box.addEventListener('input', () => { if (window.PFPdfEvents) window.PFPdfEvents.editUsed(gaTool); });
    apply();
    return box;
  }

  // Current output box → PDF with selectable text (lib/pdf-tools/pdf-writer.js).
  async function htmlToPdf(el, { onProgress } = {}) {
    if (onProgress) onProgress(0.3, 'Building PDF…');
    return window.PFPdfWriter.toPdf(el);
  }

  const COMPLEX_NOTE = "Your document uses non-English script — choose 'Save as PDF' in the print window for correct letters.";
  const COMPLEX_FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,400;0,700;1,400&family=Noto+Sans+Bengali:wght@400;700&family=Noto+Sans+Devanagari:wght@400;700&family=Noto+Sans+Arabic:wght@400;700&display=swap';

  // Fonts that can draw Bengali / Devanagari / Arabic for printing (system fonts are listed
  // in the print stylesheet too, so this is a best effort with a short time limit).
  async function loadComplexFonts(sample) {
    if (!document.getElementById('pfComplexFonts')) {
      const link = document.createElement('link');
      link.id = 'pfComplexFonts'; link.rel = 'stylesheet'; link.href = COMPLEX_FONTS_CSS;
      document.head.appendChild(link);
    }
    const loads = ['Noto Sans Bengali', 'Noto Sans Devanagari', 'Noto Sans Arabic', 'Noto Sans']
      .map((f) => document.fonts.load(`16px "${f}"`, sample).catch(() => null));
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2500))]);
  }

  // Print just this element (browser "Save as PDF"), using the print stylesheet in pdf-tools.css.
  async function printElement(el, { complex = false } = {}) {
    let area = document.getElementById('pfPrintArea');
    if (!area) { area = document.createElement('div'); area.id = 'pfPrintArea'; document.body.appendChild(area); }
    if (complex) await loadComplexFonts(el.textContent.slice(0, 200));
    area.className = (el.classList.contains('pf-doc') ? 'pf-doc' : '') + (complex ? ' pf-complex' : '');
    area.innerHTML = el.innerHTML;
    document.body.classList.add('pf-printing');
    const done = () => { document.body.classList.remove('pf-printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(() => { if (!window.matchMedia('print').matches) done(); }, 1000);
  }

  // "Download PDF": jsPDF for Latin-script documents, the print flow for complex scripts.
  // Returns the PDF blob, or null when the print window was used instead.
  async function documentPdf(panel, box, onProgress) {
    const note = q(panel, 'note');
    if (window.PFPdfWriter.hasComplexScript(box.textContent)) {
      if (note) { note.textContent = COMPLEX_NOTE; note.hidden = false; }
      await printElement(box, { complex: true });
      return null;
    }
    if (note) note.hidden = true;
    return htmlToPdf(box, { onProgress });
  }

  window.PFC = {
    LIMITS, ToolError, fmtBytes, baseName, extOf, checkSizes, checkPages, isPdfFile,
    isEncryptedError, encryptedError, toToolError, yieldUI, download, freeCanvas, canvasToBlob,
    q, progress, showError, clearError, setupDrop, sortableList, editableOutput, htmlToPdf, printElement, documentPdf, COMPLEX_NOTE,
  };
})();
