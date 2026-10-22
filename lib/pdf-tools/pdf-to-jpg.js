// ═══════════════════════════════════════════════════
// ParaFree PDF tools — PDF to JPG (lib/pdf-tools/pdf-to-jpg.js)
// PDF pages → JPG or PNG images with pdf.js, one page at a time (each canvas is freed before the
// next, so phones with little memory cope). One page → that image; several → one ZIP (JSZip) plus
// a link per page. Runs in this tab; the PDF and the images are never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'pdf_to_jpg';
  const C = window.PFC;
  const QUALITY = {                          // DPI and JPG quality per setting
    low:    { dpi: 100, q: 0.75 },
    medium: { dpi: 150, q: 0.85 },
    high:   { dpi: 220, q: 0.92 },
  };
  const MAX_PIXELS = 16e6;                   // a canvas larger than this fails on many phones: scale down
  const THUMB_W = 110;

  // "1-3, 5" → [1, 2, 3, 5] (sorted, no repeats). Throws a ToolError for anything it can't read.
  function parseRange(text, max) {
    const src = String(text || '').trim();
    if (!src) throw new C.ToolError('other', 'Type the pages you want, for example 1-3, 5.');
    const out = new Set();
    for (const raw of src.split(/[,;]+/)) {
      const part = raw.trim();
      if (!part) continue;
      const m = /^(\d+)\s*(?:[-–—]\s*(\d+))?$/.exec(part);
      if (!m) throw new C.ToolError('other', `“${part}” isn’t a page number or range. Use numbers like 1-3, 5.`);
      let a = +m[1], b = m[2] ? +m[2] : a;
      if (a > b) [a, b] = [b, a];
      if (a < 1) throw new C.ToolError('other', 'Pages start at 1.');
      if (b > max) throw new C.ToolError('other', `This PDF has ${max} page${max === 1 ? '' : 's'}, so page ${b} doesn’t exist.`);
      for (let p = a; p <= b; p++) out.add(p);
    }
    if (!out.size) throw new C.ToolError('other', 'Type the pages you want, for example 1-3, 5.');
    return [...out].sort((x, y) => x - y);
  }

  // [1, 2, 3, 5] → "1-3, 5"
  function formatRange(pages) {
    const parts = [];
    for (let i = 0; i < pages.length; i++) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      parts.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]));
      i = j;
    }
    return parts.join(', ');
  }

  async function renderPage(doc, n, scale, type, quality) {
    const page = await doc.getPage(n);
    try {
      let vp = page.getViewport({ scale });
      const px = vp.width * vp.height;
      if (px > MAX_PIXELS) vp = page.getViewport({ scale: scale * Math.sqrt(MAX_PIXELS / px) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);    // JPG has no transparency: white page
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const blob = await C.canvasToBlob(canvas, type, quality);
      const size = { w: canvas.width, h: canvas.height };
      C.freeCanvas(canvas);
      return { blob, size };
    } finally {
      page.cleanup();
    }
  }

  function init(panel) {
    const P = C.progress(panel);
    const thumbs = C.q(panel, 'thumbs');
    const selRow = C.q(panel, 'select-row');
    const range = C.q(panel, 'range');
    const rangeErr = C.q(panel, 'range-error');
    const selCount = C.q(panel, 'sel-count');
    const fileName = C.q(panel, 'file-name');
    const result = C.q(panel, 'result');
    const go = C.q(panel, 'go');
    const fmt = C.q(panel, 'opt-format');
    const qual = C.q(panel, 'opt-quality');
    const links = C.q(panel, 'links');
    const dlMain = C.q(panel, 'dl-main');
    let run = 0, thumbRun = 0, doc = null, name = 'file', pages = 0, selected = new Set();
    let output = null;                     // { kind: 'zip' | 'jpg' | 'png', blob, filename, urls: [] }

    function clearOutput() {
      if (output) output.urls.forEach((u) => URL.revokeObjectURL(u));
      output = null;
      links.innerHTML = '';
      result.hidden = true;
    }
    function label() {
      const n = selected.size;
      go.disabled = !doc || !n;
      go.textContent = `Convert ${n === 1 ? '1 page' : n + ' pages'} to ${fmt.value === 'png' ? 'PNG' : 'JPG'}`;
      selCount.textContent = doc ? `${n} of ${pages} page${pages === 1 ? '' : 's'} selected` : '';
    }
    function paintSelection() {
      thumbs.querySelectorAll('.pf-thumb').forEach((b) => {
        const on = selected.has(+b.dataset.page);
        b.classList.toggle('pf-thumb-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      label();
    }
    function setSelection(list, fromRange) {
      selected = new Set(list);
      if (!fromRange) range.value = selected.size === pages ? '' : formatRange([...selected].sort((a, b) => a - b));
      rangeErr.hidden = true;
      clearOutput();
      paintSelection();
    }

    async function drawThumbs(me) {
      for (let n = 1; n <= pages; n++) {
        if (me !== thumbRun || !doc) return;
        const b = thumbs.querySelector(`.pf-thumb[data-page="${n}"]`);
        try {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          page.cleanup();
          const { blob } = await renderPage(doc, n, THUMB_W / base.width, 'image/jpeg', 0.7);
          if (me !== thumbRun) return;
          const img = b.querySelector('img');
          img.onload = () => URL.revokeObjectURL(img.src);
          img.src = URL.createObjectURL(blob);
        } catch (e) { /* a thumbnail that fails to draw still selects its page */ }
        await C.yieldUI();
      }
    }

    async function open(files) {
      const me = ++run;
      reset(true);
      const f = files[0];
      try {
        if (!C.isPdfFile(f)) throw new C.ToolError('unsupported', 'Please choose a PDF file (.pdf). For photos, use the JPG to PDF tool.');
        C.checkSizes([f]);
        P.set(0.1, 'Reading the PDF…');
        const pdfjs = await window.PFLoad.pdfjs();
        const bytes = new Uint8Array(await f.arrayBuffer());
        let d;
        try { d = await pdfjs.getDocument(window.PFLoad.pdfjsOptions(bytes)).promise; }
        catch (e) { throw C.toToolError(e, f.name); }
        if (me !== run) { d.destroy(); return; }
        try { C.checkPages(d.numPages, C.LIMITS.pages, `"${f.name}"`); }
        catch (e) { d.destroy(); throw e; }
        doc = d; name = C.baseName(f.name); pages = d.numPages;
        fileName.textContent = `${f.name} · ${pages} page${pages === 1 ? '' : 's'} · ${C.fmtBytes(f.size)}`;
        thumbs.innerHTML = Array.from({ length: pages }, (_, i) =>
          `<button type="button" class="pf-thumb" data-page="${i + 1}" aria-pressed="true" aria-label="Page ${i + 1}"><img alt=""><span>${i + 1}</span></button>`).join('');
        selRow.hidden = false;
        setSelection(Array.from({ length: pages }, (_, i) => i + 1));
        P.hide();
        drawThumbs(++thumbRun);         // own counter: converting doesn't stop the thumbnails
      } catch (e) {
        if (me !== run) return;
        P.hide();
        const err = C.toToolError(e, f && f.name);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      }
    }

    async function convert() {
      if (!doc || !selected.size) return;
      const me = ++run;
      const list = [...selected].sort((a, b) => a - b);
      const ext = fmt.value === 'png' ? 'png' : 'jpg';
      const type = ext === 'png' ? 'image/png' : 'image/jpeg';
      const { dpi, q } = QUALITY[qual.value] || QUALITY.medium;
      C.clearError(panel);
      clearOutput();
      go.disabled = true;
      try {
        const images = [];
        for (let i = 0; i < list.length; i++) {
          if (me !== run) return;
          P.set(i / (list.length + 1), `Converting page ${list[i]} (${i + 1} of ${list.length})…`);
          await C.yieldUI();
          const { blob } = await renderPage(doc, list[i], dpi / 72, type, q);
          images.push({ page: list[i], blob, filename: `${name}-p${list[i]}.${ext}` });
        }
        if (me !== run) return;
        const total = images.reduce((s, x) => s + x.blob.size, 0);
        const what = `${ext.toUpperCase()}, ${dpi} DPI`;
        if (images.length === 1) {
          output = { kind: ext, blob: images[0].blob, filename: images[0].filename, urls: [] };
          C.q(panel, 'summary').textContent = `Page ${images[0].page} → ${what}: ${C.fmtBytes(total)}.`;
          dlMain.textContent = `⬇ Download ${ext.toUpperCase()} (${images[0].filename})`;
        } else {
          P.set(list.length / (list.length + 1), 'Making the ZIP…');
          const JSZip = await window.PFLoad.jszip();
          const zip = new JSZip();
          images.forEach((x) => zip.file(x.filename, x.blob));   // already compressed images: stored as they are
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
          if (me !== run) return;
          output = { kind: 'zip', blob, filename: `${name}-images.zip`, urls: [] };
          C.q(panel, 'summary').textContent = `${images.length} pages → ${what}: ${C.fmtBytes(total)} in total (ZIP ${C.fmtBytes(blob.size)}).`;
          dlMain.textContent = `⬇ Download all as ZIP (${output.filename})`;
          links.innerHTML = '';
          images.forEach((x) => {
            const url = URL.createObjectURL(x.blob);
            output.urls.push(url);
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = url; a.download = x.filename; a.dataset.format = ext;
            a.textContent = `Page ${x.page} · ${C.fmtBytes(x.blob.size)}`;
            li.appendChild(a);
            links.appendChild(li);
          });
        }
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
        if (me !== run) return;
        const err = C.toToolError(e, name);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      } finally {
        if (me === run) { P.hide(); label(); }
      }
    }

    thumbs.addEventListener('click', (e) => {
      const b = e.target.closest('.pf-thumb');
      if (!b) return;
      const n = +b.dataset.page, next = new Set(selected);
      if (next.has(n)) next.delete(n); else next.add(n);
      setSelection([...next]);
    });
    C.q(panel, 'sel-all').addEventListener('click', () => setSelection(Array.from({ length: pages }, (_, i) => i + 1)));
    C.q(panel, 'sel-none').addEventListener('click', () => setSelection([]));
    range.addEventListener('input', () => {
      if (!doc) return;
      if (!range.value.trim()) { rangeErr.hidden = true; return; }
      try { setSelection(parseRange(range.value, pages), true); }
      catch (e) { rangeErr.textContent = e.message; rangeErr.hidden = false; }
    });
    fmt.addEventListener('change', () => { clearOutput(); label(); });
    qual.addEventListener('change', () => { clearOutput(); label(); });
    go.addEventListener('click', convert);
    dlMain.addEventListener('click', () => {
      if (!output) return;
      C.download(output.blob, output.filename);
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, output.kind);
    });
    links.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-format]');
      if (a && window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, a.dataset.format);
    });
    C.setupDrop(panel, open);

    function reset(keepRun) {
      if (!keepRun) run++;
      thumbRun++;
      clearOutput();
      if (doc) { doc.destroy(); doc = null; }
      pages = 0; selected = new Set(); name = 'file';
      thumbs.innerHTML = '';
      selRow.hidden = true;
      range.value = ''; rangeErr.hidden = true;
      fileName.textContent = '';
      C.clearError(panel);
      P.hide();
      label();
    }
    C.q(panel, 'start-over').addEventListener('click', () => reset());
    label();
    return { reset: () => reset() };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['pdf-to-jpg'] = { libs: () => window.PFLoad.pdfjs(), init, parseRange, formatRange };
})();
