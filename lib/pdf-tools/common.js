// ═══════════════════════════════════════════════════
// ParaFree PDF tools — shared helpers (lib/pdf-tools/common.js)
// Limits, file checks, progress, downloads, sortable file lists, the editable output box and
// HTML → PDF. Files are read with File.arrayBuffer() and stay in memory in this tab; nothing
// in this file (or any lib/pdf-tools file) uploads them.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  // Sizes use decimal units everywhere: 1 MB = 1,000,000 bytes (what phones and macOS show).
  const KB = 1000, MB = 1000 * 1000, GB = 1000 * MB;
  const LIMITS = { fileBytes: 50 * MB, totalBytes: 200 * MB, wordPages: 50, pages: 300, bigFile: 200 * MB };

  // Per tool: the largest file (and, for several files, the whole task). "big" = browsers that can save
  // straight to disk (desktop Chrome / Edge: File System Access API), "basic" = the others (Firefox, Safari,
  // phones), where the result is built in memory. Tools that read the file in slices (lib/pdf-tools/
  // pdf-stream.js) go much higher than the ones that still need the whole document at once (PDF to Word keeps
  // every image in its editable preview; Word to PDF lays the document out on the page). Values come from crash
  // tests on a PC with 2–3 GB free (Chrome and Firefox), with a margin: tests/pdf-limits.spec.ts asserts them.
  //   Chrome peak / file: Light compress 0.30 GB / 2 GB · Merge 0.27 GB / 2 × 2 GB · Strong 1.34 GB / 1 GB (pdf.js
  //   needs a buffer as long as the file: a 2 GB file crashed it) · PDF to JPG 1.40 GB / 1 GB · JPG to PDF
  //   0.68 GB / 1 GB · PDF to Word 1.34 GB / 100 MB (150 MB: the preview exceeds the browser's string limit).
  //   Firefox (result in memory) handled ~1 GB for Compress / Merge / PDF to JPG / JPG to PDF, but PDF to Word
  //   took 2.45 GB at 50 MB; "basic" also covers phones, so it is about half the Firefox figures.
  // render: Compress Strong and Target size (pdf.js renders every page) — lower than Light.
  const OPS = {
    'merge-pdf':    { big: { file: 2 * GB, total: 4 * GB }, basic: { file: 500 * MB, total: 1 * GB } },
    'compress-pdf': { big: { file: 2 * GB, render: 1 * GB }, basic: { file: 500 * MB, render: 500 * MB } },
    'pdf-to-jpg':   { big: { file: 1 * GB }, basic: { file: 500 * MB } },
    'jpg-to-pdf':   { big: { file: 50 * MB, total: 1 * GB }, basic: { file: 50 * MB, total: 500 * MB } },
    'pdf-to-word':  { big: { file: 100 * MB }, basic: { file: 50 * MB } },
    'word-to-pdf':  { big: { file: 50 * MB }, basic: { file: 50 * MB } },
  };
  // Desktop Chrome / Edge with enough memory get the higher limits (navigator.deviceMemory is capped at 8).
  const bigTier = () => typeof window.showSaveFilePicker === 'function' && !(navigator.deviceMemory && navigator.deviceMemory < 4);
  const opLimits = (op) => (OPS[op] ? OPS[op][bigTier() ? 'big' : 'basic'] : { file: LIMITS.fileBytes, total: LIMITS.totalBytes });
  const fmtLimit = (n) => (n >= GB ? (n / GB) + ' GB' : (n / MB) + ' MB');

  class ToolError extends Error {
    constructor(type, message) { super(message); this.type = type; }
  }

  function fmtBytes(n) {
    if (n < KB) return n + ' B';
    if (n < MB) return (n / KB).toFixed(n < 10 * KB ? 1 : 0) + ' KB';
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

  // op: the tool id ('compress-pdf', …) — its own limits; without it, the old 50 MB / 200 MB.
  function checkSizes(files, op) {
    const lim = opLimits(op), more = OPS[op] && !bigTier() && OPS[op].big.file > lim.file;
    const hint = more ? ` in this browser (up to ${fmtLimit(OPS[op].big.file)} on desktop Chrome or Edge)` : '';
    let total = 0;
    for (const f of files) {
      if (f.size > lim.file) {
        throw new ToolError('too_large', `"${f.name}" is ${fmtBytes(f.size)}. The limit is ${fmtLimit(lim.file)} per file${hint} — try compressing it first or splitting it.`);
      }
      total += f.size;
    }
    if (lim.total && total > lim.total) {
      throw new ToolError('too_large', `These files add up to ${fmtBytes(total)}. The limit is ${fmtLimit(lim.total)} per task${more ? ' in this browser' : ''} — try fewer files at a time.`);
    }
  }

  // Large files: say up front that this runs on the device and can take a while (no crash surprises).
  const BIG_NOTE = 'Large file: it is processed on your device, so this can take a few minutes — keep this tab open. Very large files work best on desktop Chrome or Edge.';
  function bigNote(panel, bytes) {
    let el = panel.querySelector('[data-role="big-note"]');
    if (!el) {
      el = document.createElement('p');
      el.className = 'pf-warn';
      el.dataset.role = 'big-note';
      el.setAttribute('role', 'status');
      const before = q(panel, 'progress');
      before.parentNode.insertBefore(el, before);
    }
    const op = OPS[panel.dataset.tool];
    el.textContent = BIG_NOTE + (op && !bigTier() ? ` In this browser the limit is ${fmtLimit(op.basic.total || op.basic.file)}${op.basic.total ? ' per task' : ''}.` : '');
    el.hidden = !(bytes > LIMITS.bigFile);
  }

  // Where a result goes. For a large input in a browser that can save to disk, ask for the file now (this must
  // run straight from the click) and write the result into it as it is made; otherwise build it in memory.
  // → { sink, toDisk }
  async function outputSink(inputBytes, suggestedName, kind) {
    const S = window.PFStream;
    const types = { pdf: ['PDF document', 'application/pdf', '.pdf'], zip: ['ZIP archive', 'application/zip', '.zip'] }[kind || 'pdf'];
    if (inputBytes > LIMITS.bigFile && S.canSaveToDisk()) {
      const handle = await S.pickSaveFile(suggestedName, types[0], types[1], types[2]);
      if (handle) return { sink: await S.fileSink(handle), toDisk: true };
    }
    return { sink: S.blobSink(types[1]), toDisk: false };
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
    if (e && e.type && e.name !== 'PasswordException' && window.PFStream && e instanceof window.PFStream.StreamError) {
      if (e.type === 'encrypted') return encryptedError(fileName || 'This PDF');
      if (e.type === 'too_large') return new ToolError('too_large', 'The result would be over 4 GB, which a ZIP file can’t hold — select fewer pages at a time.');
      return new ToolError('file_error', `${fileName ? '"' + fileName + '"' : 'This file'} could not be read as a PDF. It may be damaged — try opening and re-saving it.`);
    }
    if (e && e.name === 'QuotaExceededError') {
      return new ToolError('too_large', 'There isn’t enough free space on your disk to save the result. Free up some space, or choose another drive, and try again.');
    }
    // PDF to Word keeps every image in its editable preview: past a point the page's HTML is longer than a
    // browser allows for one string — a limit of the document, not of memory
    if (e && e.name === 'RangeError' && /Invalid string length/i.test(String(e.message))) {
      return new ToolError('too_large', 'This PDF has more image data than one conversion can hold. Split it and convert it in parts — for example 20 pages at a time.');
    }
    // out of memory (allocation failed, canvas too big…): say so instead of failing silently
    if (e && (e.name === 'RangeError' || /allocation failed|out of memory|Invalid array length|NotReadableError/i.test(String(e.message) + ' ' + e.name))) {
      console.error('[pdf-tools] out of memory:', e);
      return new ToolError('too_large', 'This file needs more memory than this browser tab has. Close other tabs and try again, use desktop Chrome or Edge, or split the file into smaller parts.');
    }
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
    // the hint under the button states the desktop Chrome/Edge limit; other browsers get their own number
    const op = OPS[panel.dataset.tool], hint = zone.querySelector('.pf-drop-hint');
    if (op && hint && !bigTier() && hint.lastChild && hint.lastChild.nodeType === 3) {
      hint.lastChild.textContent = hint.lastChild.textContent.replace(fmtLimit(op.big.file), fmtLimit(op.basic.file));
    }
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

  // ── Lazy modules ─────────────────────────────────
  // Our own files load only when needed, with the page's version (?v=) so long-cached copies
  // are replaced as soon as the files change. Downloads run in parallel; async=false keeps the
  // order in which they run. The map is shared with home.js / app.js (window.PFModules).
  const modules = (window.PFModules = window.PFModules || {});
  function loadModule(name) {
    if (!modules[name]) {
      modules[name] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/lib/pdf-tools/' + name + '.js' + (window.PFV ? '?v=' + window.PFV : '');
        s.async = false;
        s.onload = resolve;
        s.onerror = () => { delete modules[name]; reject(new Error('Could not load ' + name + ' — check your connection.')); };
        document.head.appendChild(s);
      });
    }
    return modules[name];
  }

  // Scripts the embedded Latin font can't shape (Hebrew/Arabic, Indic, Thai/Lao/Tibetan, Myanmar,
  // Khmer, Hangul, CJK…): those documents use the print flow instead of jsPDF.
  const COMPLEX_RE = /[֐-ࣿऀ-෿฀-࿿က-႟ᄀ-ᇿក-៿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿יִ-﷿ﹰ-﻿]/;
  const hasComplexScript = (text) => COMPLEX_RE.test(String(text || ''));

  // Current output box → PDF with selectable text (lib/pdf-tools/pdf-writer.js, loaded on first use).
  async function htmlToPdf(el, { onProgress } = {}) {
    if (onProgress) onProgress(0.3, 'Building PDF…');
    await loadModule('pdf-writer');
    return window.PFPdfWriter.toPdf(el);
  }

  // A file chosen or dropped while a tool is still loading is kept and handed to the tool once
  // its own handlers are attached. Returns release(), to call right after the tool's init.
  function holdFiles(panel) {
    const zone = q(panel, 'drop');
    const input = zone && zone.querySelector('input[type=file]');
    if (!input) return () => {};
    let held = null;
    const onChange = () => { if (input.files && input.files.length) held = [...input.files]; };
    const onOver = (e) => e.preventDefault();
    const onDrop = (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) held = [...e.dataTransfer.files]; };
    input.addEventListener('change', onChange);
    zone.addEventListener('dragover', onOver);
    zone.addEventListener('drop', onDrop);
    return function release() {
      input.removeEventListener('change', onChange);
      zone.removeEventListener('dragover', onOver);
      zone.removeEventListener('drop', onDrop);
      if (!held) return;
      try {
        const dt = new DataTransfer();
        held.forEach((f) => dt.items.add(f));
        input.files = dt.files;
      } catch (e) { /* the files are still in the input */ }
      input.dispatchEvent(new Event('change'));
    };
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
    await loadModule('pdf-writer');           // our small writer file; jsPDF itself only loads for Latin text
    if (hasComplexScript(box.textContent)) {
      if (note) { note.textContent = COMPLEX_NOTE; note.hidden = false; }
      await printElement(box, { complex: true });
      return null;
    }
    if (note) note.hidden = true;
    return htmlToPdf(box, { onProgress });
  }

  window.PFC = {
    LIMITS, OPS, opLimits, bigTier, fmtLimit, bigNote, outputSink, ToolError, fmtBytes, baseName, extOf, checkSizes, checkPages, isPdfFile,
    isEncryptedError, encryptedError, toToolError, yieldUI, download, freeCanvas, canvasToBlob,
    q, progress, showError, clearError, setupDrop, sortableList, editableOutput, htmlToPdf, printElement, documentPdf, COMPLEX_NOTE,
    loadModule, hasComplexScript, holdFiles,
  };
})();
