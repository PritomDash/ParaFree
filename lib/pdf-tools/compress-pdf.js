// ═══════════════════════════════════════════════════
// ParaFree PDF tools — Compress PDF (lib/pdf-tools/compress-pdf.js)
// Light: pdf-lib re-save with object streams + re-encode large embedded JPEG / 8-bit RGB or
//        grey images at a lower resolution. Text stays selectable.
// Strong: every page rendered by pdf.js at ~110 DPI → JPEG (quality 0.6) → new PDF.
//        Smallest file, but the text is no longer selectable.
// Runs in this tab; the file is never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'compress_pdf';
  const C = window.PFC;
  const LIGHT_MAX_SIDE = 1600, LIGHT_QUALITY = 0.7, MIN_IMAGE_BYTES = 20 * 1024;
  const STRONG_DPI = 110, STRONG_QUALITY = 0.6;

  // ── Light mode helpers ───────────────────────────
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }

  // PNG predictors (DecodeParms /Predictor ≥ 10).
  function unpredict(data, colors, columns) {
    const bpp = colors, row = colors * columns;
    const out = new Uint8Array(row * Math.floor(data.length / (row + 1)));
    let prev = new Uint8Array(row);
    for (let r = 0, i = 0, o = 0; i + row < data.length + 1 && o < out.length; r++) {
      const type = data[i++];
      const cur = out.subarray(o, o + row);
      for (let x = 0; x < row; x++) {
        const raw = data[i + x];
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (type) {
          case 0: v = raw; break;
          case 1: v = raw + a; break;
          case 2: v = raw + b; break;
          case 3: v = raw + ((a + b) >> 1); break;
          case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
          default: v = raw;
        }
        cur[x] = v & 255;
      }
      prev = cur;
      i += row; o += row;
    }
    return out;
  }

  function colorCount(L, cs, context) {
    if (!cs) return 0;
    if (cs instanceof L.PDFName) return cs === L.PDFName.of('DeviceRGB') ? 3 : cs === L.PDFName.of('DeviceGray') ? 1 : 0;
    if (cs instanceof L.PDFArray && cs.size() === 2 && cs.get(0) === L.PDFName.of('ICCBased')) {
      const icc = context.lookup(cs.get(1));
      const n = icc && icc.dict && icc.dict.get(L.PDFName.of('N'));
      const nv = n && n.asNumber ? n.asNumber() : 0;
      return nv === 3 || nv === 1 ? nv : 0;
    }
    return 0;
  }

  async function decodeImage(L, obj, context) {
    const d = obj.dict, N = (k) => d.get(L.PDFName.of(k));
    let filter = N('Filter');
    if (filter instanceof L.PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
    const w = N('Width') && N('Width').asNumber(), h = N('Height') && N('Height').asNumber();
    if (!w || !h || N('ImageMask') === L.PDFBool.True || N('Decode')) return null;
    const colors = colorCount(L, context.lookup(N('ColorSpace')), context);
    if (!colors) return null;                                  // CMYK, Indexed, Lab… left as they are
    if (filter === L.PDFName.of('DCTDecode')) {
      return createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
    }
    if (filter === L.PDFName.of('FlateDecode')) {
      const bpc = N('BitsPerComponent') && N('BitsPerComponent').asNumber();
      if (bpc !== 8) return null;
      let raw = await inflate(obj.contents);
      const parms = context.lookup(N('DecodeParms'));
      const pred = parms && parms.get && parms.get(L.PDFName.of('Predictor'));
      if (pred && pred.asNumber() >= 10) raw = unpredict(raw, colors, w);
      else if (pred && pred.asNumber() > 1) return null;
      if (raw.length < w * h * colors) return null;
      const id = new ImageData(w, h);
      const o = id.data;
      for (let p = 0, s = 0; p < w * h; p++, s += colors) {
        const j = p * 4;
        if (colors === 3) { o[j] = raw[s]; o[j + 1] = raw[s + 1]; o[j + 2] = raw[s + 2]; }
        else { o[j] = o[j + 1] = o[j + 2] = raw[s]; }
        o[j + 3] = 255;
      }
      return createImageBitmap(id);
    }
    return null;
  }

  async function compressLight(bytes, name, onProgress) {
    const L = await window.PFLoad.pdfLib();
    let doc;
    try { doc = await L.PDFDocument.load(bytes, { updateMetadata: false }); }
    catch (e) { if (C.isEncryptedError(e)) throw C.encryptedError(name); throw C.toToolError(e, name); }
    C.checkPages(doc.getPageCount(), C.LIMITS.pages, `"${name}"`);
    const ctx = doc.context;
    const IMAGE = L.PDFName.of('Image');
    const smasks = new Set();
    const images = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream) || obj.dict.get(L.PDFName.of('Subtype')) !== IMAGE) continue;
      const sm = obj.dict.get(L.PDFName.of('SMask'));
      if (sm instanceof L.PDFRef) smasks.add(sm.tag);
      images.push([ref, obj]);
    }
    let i = 0;
    for (const [ref, obj] of images) {
      i++;
      onProgress(i / (images.length + 1), `Optimising image ${i} of ${images.length}…`);
      await C.yieldUI();
      if (smasks.has(ref.tag) || obj.contents.length < MIN_IMAGE_BYTES) continue;
      let bmp = null;
      try { bmp = await decodeImage(L, obj, ctx); } catch (e) { bmp = null; }
      if (!bmp) continue;
      const scale = Math.min(1, LIGHT_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close && bmp.close();
      const blob = await C.canvasToBlob(canvas, 'image/jpeg', LIGHT_QUALITY);
      const jpg = new Uint8Array(await blob.arrayBuffer());
      if (jpg.length < obj.contents.length * 0.9) {
        const dict = ctx.obj({
          Type: 'XObject', Subtype: 'Image', Width: canvas.width, Height: canvas.height,
          ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
        });
        const sm = obj.dict.get(L.PDFName.of('SMask'));
        if (sm) dict.set(L.PDFName.of('SMask'), sm);
        const interp = obj.dict.get(L.PDFName.of('Interpolate'));
        if (interp) dict.set(L.PDFName.of('Interpolate'), interp);
        ctx.assign(ref, L.PDFRawStream.of(dict, jpg));
      }
      C.freeCanvas(canvas);
    }
    onProgress(0.98, 'Saving…');
    return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  }

  async function compressStrong(bytes, name, onProgress) {
    const pdfjs = await window.PFLoad.pdfjs();
    const L = await window.PFLoad.pdfLib();
    let src;
    try { src = await pdfjs.getDocument(window.PFLoad.pdfjsOptions(bytes.slice())).promise; }
    catch (e) { throw C.toToolError(e, name); }
    try {
      C.checkPages(src.numPages, C.LIMITS.pages, `"${name}"`);
      const out = await L.PDFDocument.create();
      for (let p = 1; p <= src.numPages; p++) {
        onProgress((p - 1) / src.numPages, `Compressing page ${p} of ${src.numPages}…`);
        await C.yieldUI();
        const page = await src.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: STRONG_DPI / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const blob = await C.canvasToBlob(canvas, 'image/jpeg', STRONG_QUALITY);
        C.freeCanvas(canvas);
        page.cleanup();
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const np = out.addPage([base.width, base.height]);
        np.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      onProgress(0.98, 'Saving…');
      return await out.save({ useObjectStreams: true });
    } finally {
      src.destroy();
    }
  }

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const summary = C.q(panel, 'summary');
    const go = C.q(panel, 'go');
    const fileLabel = C.q(panel, 'file-name');
    let run = 0, file = null, out = null, outName = '';

    function reset() {
      run++;
      file = null; out = null;
      fileLabel.textContent = '';
      go.disabled = true;
      result.hidden = true;
      C.clearError(panel);
      P.hide();
    }

    function choose(files) {
      reset();
      const f = files[0];
      try {
        if (!C.isPdfFile(f)) throw new C.ToolError('unsupported', 'Please choose a PDF file (.pdf).');
        C.checkSizes([f]);
      } catch (e) {
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
        return;
      }
      file = f;
      fileLabel.textContent = `${f.name} · ${C.fmtBytes(f.size)}`;
      go.disabled = false;
    }

    async function compress() {
      if (!file) return;
      const me = ++run;
      const f = file;
      const mode = (panel.querySelector('input[name="pf-compress-mode"]:checked') || {}).value || 'light';
      C.clearError(panel);
      result.hidden = true;
      go.disabled = true;
      try {
        P.set(0.02, 'Loading…');
        const bytes = new Uint8Array(await f.arrayBuffer());
        const res = mode === 'strong'
          ? await compressStrong(bytes, f.name, (x, t) => me === run && P.set(x, t))
          : await compressLight(bytes, f.name, (x, t) => me === run && P.set(x, t));
        if (me !== run) return;
        const before = f.size, after = res.length;
        if (after >= before) {
          out = f;
          outName = f.name;
          summary.innerHTML = '';
          summary.append(`${C.fmtBytes(before)} → ${C.fmtBytes(after)}. `);
          const b = document.createElement('strong');
          b.textContent = 'This PDF is already well compressed.';
          summary.append(b, ' You can download the original file unchanged.');
          C.q(panel, 'dl-pdf').textContent = '⬇ Download original PDF';
        } else {
          out = new Blob([res], { type: 'application/pdf' });
          outName = C.baseName(f.name) + '-compressed.pdf';
          const saved = Math.round((1 - after / before) * 100);
          summary.textContent = `${C.fmtBytes(before)} → ${C.fmtBytes(after)} (${saved}% smaller)` + (mode === 'strong' ? ' · text is no longer selectable' : '');
          C.q(panel, 'dl-pdf').textContent = '⬇ Download compressed PDF';
        }
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
        if (me !== run) return;
        const err = C.toToolError(e, f.name);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      } finally {
        if (me === run) { P.hide(); go.disabled = !file; }
      }
    }

    C.setupDrop(panel, choose);
    go.addEventListener('click', compress);
    C.q(panel, 'dl-pdf').addEventListener('click', () => {
      if (!out) return;
      C.download(out, outName);
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
    });
    C.q(panel, 'start-over').addEventListener('click', reset);
    panel.querySelectorAll('input[name="pf-compress-mode"]').forEach((r) => r.addEventListener('change', () => { result.hidden = true; }));
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['compress-pdf'] = { libs: () => window.PFLoad.pdfLib(), init, _internals: { unpredict } };
})();
