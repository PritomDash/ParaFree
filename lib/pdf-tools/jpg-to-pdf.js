// ═══════════════════════════════════════════════════
// ParaFree PDF tools — JPG/PNG to PDF (lib/pdf-tools/jpg-to-pdf.js)
// Images (jpg, jpeg, png, webp) → one PDF with pdf-lib. Phone photos are turned the right
// way up (EXIF orientation), very large images are scaled down to 3000 px, WebP becomes PNG.
// Runs in this tab; images are never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'jpg_to_pdf';
  const C = window.PFC;
  const MAX_SIDE = 3000;
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  const MARGINS = { none: 0, small: 20, large: 50 };
  const OK_EXT = ['jpg', 'jpeg', 'png', 'webp'];

  function sniff(b) {
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    return null;
  }

  // EXIF orientation tag (1–8) from a JPEG, 1 if there is none.
  function exifOrientation(b) {
    let o = 2;
    while (o + 4 < b.length && b[o] === 0xff) {
      const marker = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
      if (marker === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
        const t = o + 10, le = b[t] === 0x49;
        const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
        const u32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda) break;          // start of scan: no more metadata
      o += 2 + len;
    }
    return 1;
  }

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
  }

  // → { bytes, type: 'jpg'|'png', w, h } ready for pdf-lib, upright and ≤ 3000 px.
  async function prepare(item) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const kind = sniff(bytes);
    if (!kind) throw new C.ToolError('unsupported', `"${item.name}" isn't a JPG, PNG or WebP image.`);
    let img;
    try { img = await loadImg(item.url); } catch (e) { throw new C.ToolError('file_error', `"${item.name}" could not be opened. It may be damaged.`); }
    const w = img.naturalWidth, h = img.naturalHeight;          // already upright (browsers apply EXIF)
    const big = Math.max(w, h) > MAX_SIDE;
    if (kind === 'jpg' && !big && exifOrientation(bytes) === 1) return { bytes, type: 'jpg', w, h };
    if (kind === 'png' && !big) return { bytes, type: 'png', w, h };
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (kind === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = kind === 'jpg' ? 'jpg' : 'png';
    const blob = await C.canvasToBlob(canvas, type === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
    const out = { bytes: new Uint8Array(await blob.arrayBuffer()), type, w: canvas.width, h: canvas.height };
    C.freeCanvas(canvas);
    return out;
  }

  function pageLayout(w, h, opts) {
    const m = MARGINS[opts.margin] ?? 20;
    const iw = w * 0.75, ih = h * 0.75;                       // 96 px per inch → points
    let W, H;
    if (opts.size === 'fit') { W = iw + 2 * m; H = ih + 2 * m; }
    else {
      [W, H] = SIZES[opts.size] || SIZES.a4;
      const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && w > h);
      if (landscape) [W, H] = [H, W];
    }
    const s = opts.size === 'fit' ? 1 : Math.min((W - 2 * m) / iw, (H - 2 * m) / ih);
    const dw = iw * s, dh = ih * s;
    return { W, H, x: (W - dw) / 2, y: (H - dh) / 2, dw, dh };
  }

  let nextId = 1;

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const go = C.q(panel, 'go');
    const count = C.q(panel, 'count');
    const sizeSel = C.q(panel, 'opt-size'), orientSel = C.q(panel, 'opt-orientation'), marginSel = C.q(panel, 'opt-margin');
    let run = 0, outBlob = null;

    const list = C.sortableList(C.q(panel, 'list'), {
      renderItem(item) {
        const d = document.createElement('div');
        d.className = 'pf-item-main';
        d.innerHTML = '<img class="pf-thumb" alt=""><span class="pf-item-name"></span>';
        d.querySelector('img').src = item.url;
        d.querySelector('.pf-item-name').textContent = item.name;
        return d;
      },
      onChange(items) {
        outBlob = null;                                         // any change to the list invalidates the PDF
        go.disabled = !items.length;
        count.textContent = items.length ? `${items.length} image${items.length === 1 ? '' : 's'} · drag or use ↑ ↓ to change the order` : '';
        result.hidden = true;
      },
    });

    sizeSel.addEventListener('change', () => { orientSel.disabled = sizeSel.value === 'fit'; });

    function add(files) {
      C.clearError(panel);
      result.hidden = true;
      outBlob = null;                                           // a new upload clears the previous result
      const bad = files.filter((f) => !OK_EXT.includes(C.extOf(f.name)) && !/^image\/(jpeg|png|webp)$/.test(f.type));
      const good = files.filter((f) => !bad.includes(f));
      try {
        C.checkSizes(list.items.map((x) => x.file).concat(good));
        if (list.items.length + good.length > C.LIMITS.pages) throw new C.ToolError('too_many_pages', `That would be ${list.items.length + good.length} images. This tool handles up to ${C.LIMITS.pages} images (pages) at a time.`);
      } catch (e) {
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
        return;
      }
      list.add(good.map((file) => {
        const url = URL.createObjectURL(file);
        return { id: nextId++, file, name: file.name, url, dispose() { URL.revokeObjectURL(url); } };
      }));
      if (bad.length) {
        const e = new C.ToolError('unsupported', `Skipped ${bad.map((f) => '"' + f.name + '"').join(', ')} — please choose JPG, PNG or WebP images.`);
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
      }
    }

    async function convert() {
      const me = ++run;
      C.clearError(panel);
      result.hidden = true;
      go.disabled = true;
      const items = list.items.slice();
      const opts = { size: sizeSel.value, orientation: orientSel.value, margin: marginSel.value };
      try {
        P.set(0.02, 'Loading PDF builder…');
        const { PDFDocument } = await window.PFLoad.pdfLib();
        const pdf = await PDFDocument.create();
        for (let i = 0; i < items.length; i++) {
          if (me !== run) return;
          P.set(i / items.length, `Adding image ${i + 1} of ${items.length}…`);
          await C.yieldUI();
          const im = await prepare(items[i]);
          let embedded;
          try { embedded = im.type === 'jpg' ? await pdf.embedJpg(im.bytes) : await pdf.embedPng(im.bytes); }
          catch (e) { throw new C.ToolError('file_error', `"${items[i].name}" could not be added — it may be damaged or use an unusual format.`); }
          const L = pageLayout(im.w, im.h, opts);
          const page = pdf.addPage([L.W, L.H]);
          page.drawImage(embedded, { x: L.x, y: L.y, width: L.dw, height: L.dh });
        }
        P.set(0.97, 'Saving PDF…');
        const bytes = await pdf.save({ useObjectStreams: true });
        if (me !== run) return;
        outBlob = new Blob([bytes], { type: 'application/pdf' });
        C.q(panel, 'summary').textContent = `Your PDF is ready: ${items.length} page${items.length === 1 ? '' : 's'}, ${C.fmtBytes(outBlob.size)}.`;
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'image');
      } catch (e) {
        if (me !== run) return;
        const err = C.toToolError(e);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      } finally {
        if (me === run) { P.hide(); go.disabled = !list.items.length; }
      }
    }

    C.setupDrop(panel, add);
    go.addEventListener('click', convert);
    C.q(panel, 'dl-pdf').addEventListener('click', () => {
      if (!outBlob) return;
      C.download(outBlob, 'images.pdf');
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
    });
    function reset() {
      run++;
      outBlob = null;
      list.clear();
      C.clearError(panel);
      P.hide();
      result.hidden = true;
    }
    C.q(panel, 'start-over').addEventListener('click', reset);
    return { reset };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['jpg-to-pdf'] = { libs: () => window.PFLoad.pdfLib(), init, _internals: { exifOrientation, pageLayout, sniff } };
})();
