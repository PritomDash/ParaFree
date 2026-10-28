// ═══════════════════════════════════════════════════
// ParaFree PDF tools — JPG/PNG to PDF (lib/pdf-tools/jpg-to-pdf.js)
// Images (jpg, jpeg, png, webp) → one PDF (pdf-lib's image embedders). Phone photos are turned the right
// way up (EXIF orientation), very large images are scaled down to 3000 px, WebP becomes PNG.
// The PDF is written page by page (lib/pdf-tools/pdf-stream.js); JPEGs that need no change go in as they are,
// straight from the file. For large inputs in Chrome/Edge the PDF is saved to a file the user picks.
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

  const HEAD = 256 * 1024;                   // enough of a JPEG for its markers (size, colours, EXIF)

  // → { type: 'jpg', head, blob, w, h } | { type: 'png', bytes, w, h }, upright and ≤ 3000 px. A JPEG that needs
  // no change is passed on as the file itself (only its first bytes are read), so it never has to be in memory.
  // Pixel size from the file header: JPEG SOF marker, PNG IHDR. null if not found in the bytes given.
  function headerSize(b, kind) {
    if (kind === 'png') return b.length >= 24 ? { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 } : null;
    if (kind !== 'jpg') return null;
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  // Decoded, upright (EXIF applied) — one image at a time, released by the caller (bitmap.close()).
  async function decode(item) {
    try { return await createImageBitmap(item.file, { imageOrientation: 'from-image' }); }
    catch (e) { return loadImg(item.url); }                    // older browsers: an <img>
  }

  async function prepare(item) {
    const head = new Uint8Array(await item.file.slice(0, HEAD).arrayBuffer());
    const kind = sniff(head);
    if (!kind) throw new C.ToolError('unsupported', `"${item.name}" isn't a JPG, PNG or WebP image.`);
    // an upright JPEG or a PNG that is small enough goes in as it is: its size comes from the header, no decoding
    // (decoding every photo just to measure it is what used up memory on big batches, in Firefox especially)
    const hs = headerSize(head, kind);
    if (hs && hs.w && hs.h && Math.max(hs.w, hs.h) <= MAX_SIDE) {
      if (kind === 'jpg' && exifOrientation(head) === 1) return { type: 'jpg', head, blob: item.file, w: hs.w, h: hs.h };
      if (kind === 'png') return { type: 'png', bytes: new Uint8Array(await item.file.arrayBuffer()), w: hs.w, h: hs.h };
    }
    let img;
    try { img = await decode(item); } catch (e) { throw new C.ToolError('file_error', `"${item.name}" could not be opened. It may be damaged.`); }
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;   // already upright
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (kind === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (img.close) img.close();
    const type = kind === 'jpg' ? 'jpg' : 'png';
    const blob = await C.canvasToBlob(canvas, type === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
    const out = type === 'jpg'
      ? { type, head: new Uint8Array(await blob.slice(0, HEAD).arrayBuffer()), blob, w: canvas.width, h: canvas.height }
      : { type, bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
    C.freeCanvas(canvas);
    return out;
  }

  // Write one image (and a PNG's soft mask) to the PDF writer → its ref. pdf-lib's embedders build the image
  // dictionary (colour space, size…); a JPEG's data is the file (or canvas Blob) itself, passed on without a copy.
  async function embed(L, w, im) {
    const tmp = L.PDFContext.create(), ref = tmp.nextRef();
    let emb;
    if (im.type === 'jpg') {
      try { emb = await L.JpegEmbedder.for(im.head); }
      catch (e) { emb = await L.JpegEmbedder.for(new Uint8Array(await im.blob.arrayBuffer())); }   // markers past the first 256 KB
    } else emb = await L.PngEmbedder.for(im.bytes);
    await emb.embedIntoContext(tmp, ref);
    const map = new Map();
    for (const [r] of tmp.enumerateIndirectObjects()) map.set(r.tag, w.alloc());
    const remap = (v) => {
      if (v instanceof L.PDFRef) return map.get(v.tag) || L.PDFNull;
      if (v instanceof L.PDFDict) { const d = L.PDFDict.withContext(tmp); for (const [k, x] of v.entries()) d.set(k, remap(x)); return d; }
      if (v instanceof L.PDFArray) { const a = L.PDFArray.withContext(tmp); for (const x of v.asArray()) a.push(remap(x)); return a; }
      return v;
    };
    for (const [r, o] of tmp.enumerateIndirectObjects()) {
      if (o.updateDict) o.updateDict();
      const data = r === ref && im.type === 'jpg' ? im.blob : o.getContents ? o.getContents() : o.contents;
      await w.put(map.get(r.tag), remap(o.dict || o), data);
    }
    return map.get(ref.tag);
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
        if (item.thumb) d.querySelector('img').src = item.thumb;
        d.querySelector('.pf-item-name').textContent = item.name;
        return d;
      },
      onChange(items) {
        outBlob = null;                                         // any change to the list invalidates the PDF
        go.disabled = !items.length;
        count.textContent = items.length ? `${items.length} image${items.length === 1 ? '' : 's'} · drag or use ↑ ↓ to change the order` : '';
        C.bigNote(panel, items.reduce((t, x) => t + x.file.size, 0));
        result.hidden = true;
      },
    });

    // Small thumbnails, drawn one at a time: an <img> showing the full photo would keep every decoded photo in
    // memory (48 MB for a 12-megapixel one — Firefox holds them all), which is what limited big batches.
    let thumbs = Promise.resolve();
    async function drawThumbs(items) {
      for (const item of items) {
        try {
          const bmp = await createImageBitmap(item.file, { resizeWidth: 96, resizeQuality: 'medium' });
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          bmp.close();
          const b = await C.canvasToBlob(c, 'image/jpeg', 0.8);
          C.freeCanvas(c);
          if (!list.items.includes(item)) continue;              // removed meanwhile
          item.thumb = URL.createObjectURL(b);
          const img = C.q(panel, 'list').querySelector(`.pf-item[data-id="${item.id}"] img`);
          if (img) img.src = item.thumb;
        } catch (e) { /* no thumbnail: the row still shows the file name */ }
        await C.yieldUI();
      }
    }

    sizeSel.addEventListener('change', () => { orientSel.disabled = sizeSel.value === 'fit'; });

    function add(files) {
      C.clearError(panel);
      result.hidden = true;
      outBlob = null;                                           // a new upload clears the previous result
      const bad = files.filter((f) => !OK_EXT.includes(C.extOf(f.name)) && !/^image\/(jpeg|png|webp)$/.test(f.type));
      const good = files.filter((f) => !bad.includes(f));
      try {
        C.checkSizes(list.items.map((x) => x.file).concat(good), 'jpg-to-pdf');
        if (list.items.length + good.length > C.LIMITS.pages) throw new C.ToolError('too_many_pages', `That would be ${list.items.length + good.length} images. This tool handles up to ${C.LIMITS.pages} images (pages) at a time.`);
      } catch (e) {
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
        return;
      }
      const added = good.map((file) => {
        const url = URL.createObjectURL(file);
        return { id: nextId++, file, name: file.name, url, thumb: '', dispose() { URL.revokeObjectURL(url); if (this.thumb) URL.revokeObjectURL(this.thumb); } };
      });
      list.add(added);
      thumbs = thumbs.then(() => drawThumbs(added));
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
      const dl = C.q(panel, 'dl-pdf');
      dl.hidden = false;
      let dest = null;
      try {
        // the PDF is written page by page: for large inputs in Chrome/Edge, into a file picked now (from the click)
        dest = await C.outputSink(items.reduce((t, x) => t + x.file.size, 0), 'images.pdf');
        P.set(0.02, 'Loading PDF builder…');
        const L = await window.PFLoad.pdfLib();
        const w = window.PFStream.writer(dest.sink, L), ctx = L.PDFContext.create();
        await w.start();
        const pagesRef = w.alloc(), kids = [];
        const n = (x) => Math.round(x * 1000) / 1000;
        for (let i = 0; i < items.length; i++) {
          if (me !== run) { await dest.sink.abort(); return; }
          P.set(i / items.length, `Adding image ${i + 1} of ${items.length}…`);
          await C.yieldUI();
          const im = await prepare(items[i]);
          let img;
          try { img = await embed(L, w, im); }
          catch (e) { throw new C.ToolError('file_error', `"${items[i].name}" could not be added — it may be damaged or use an unusual format.`); }
          const lay = pageLayout(im.w, im.h, opts);
          const content = w.alloc(), pageRef = w.alloc();
          await w.put(content, ctx.obj({}), window.PFStream.ascii(`q ${n(lay.dw)} 0 0 ${n(lay.dh)} ${n(lay.x)} ${n(lay.y)} cm /Im0 Do Q`));
          await w.put(pageRef, ctx.obj({ Type: 'Page', Parent: pagesRef, MediaBox: [0, 0, n(lay.W), n(lay.H)], Resources: { XObject: { Im0: img } }, Contents: content }));
          kids.push(pageRef);
        }
        P.set(0.97, 'Saving PDF…');
        await w.put(pagesRef, ctx.obj({ Type: 'Pages', Kids: kids, Count: kids.length }));
        const cat = w.alloc();
        await w.put(cat, ctx.obj({ Type: 'Catalog', Pages: pagesRef }));
        await w.finish({ root: cat });
        const blob = await dest.sink.close();
        if (me !== run) return;
        outBlob = dest.toDisk ? null : blob;
        dl.hidden = dest.toDisk;
        C.q(panel, 'summary').textContent = `Your PDF is ready: ${items.length} page${items.length === 1 ? '' : 's'}, ${C.fmtBytes(blob.size)}.` +
          (dest.toDisk ? ` Saved to your computer as “${dest.sink.name}”.` : '');
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'image');
      } catch (e) {
        if (dest) await dest.sink.abort();
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
      C.bigNote(panel, 0);
      P.hide();
      result.hidden = true;
    }
    C.q(panel, 'start-over').addEventListener('click', reset);
    return { reset };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['jpg-to-pdf'] = { libs: () => Promise.all([window.PFLoad.pdfLib(), C.loadModule('pdf-stream')]), init, _internals: { exifOrientation, pageLayout, sniff } };
})();
