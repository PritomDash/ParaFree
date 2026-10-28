// ═══════════════════════════════════════════════════
// ParaFree PDF tools — Compress PDF (lib/pdf-tools/compress-pdf.js)
// Light: every embedded image whose resolution is above ~150 DPI at the size it is shown on
//        the page is downsampled and re-encoded (JPEG quality 0.75; images with transparency
//        stay lossless Flate). Text and vector graphics are not touched and stay selectable.
//        Re-saved with object streams.
// Strong: every page rendered by pdf.js at ~110 DPI → JPEG (quality 0.6) → new PDF.
//        Smallest file, but the text is no longer selectable.
// Target size: the original if it is already small enough; else Light; else Strong, searching
//        (binary search) for the best page resolution / JPEG quality that still fits, down to
//        ~72 DPI / quality 0.4. If even that is too big, the smallest file made is offered and
//        the summary says so.
// Large files: the PDF is read in slices and the result written as it is made (lib/pdf-tools/pdf-stream.js),
// so only one image or page is in memory at a time; for big inputs in Chrome/Edge the result goes straight to a
// file the user picks. Runs in this tab; the file is never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'compress_pdf';
  const C = window.PFC;
  const TARGET_DPI = 150, DPI_SLACK = 1.1, JPEG_QUALITY = 0.75;
  const UNKNOWN_MAX_SIDE = 1600;            // images we can't find on a page (patterns, annotations…)
  const MIN_SIDE = 48, MIN_IMAGE_BYTES = 8 * 1024;
  const STRONG_DPI = 110, STRONG_QUALITY = 0.6;
  const STRONG_BATCH = 10;                   // Strong: pdf.js is reopened every 10 pages (bounds its memory)
  const LIGHT_PAGES = 2000;                  // Light reads one page at a time, so it takes longer PDFs than Strong
  const MEMORY_FALLBACK = 200 * 1000 * 1000; // a PDF the slice reader can't follow is loaded whole only up to this size
  // target-size search range for Strong: s = 1 → 150 DPI / q 0.8 … s = 0 → 72 DPI / q 0.4 (the floor)
  const T_DPI = [72, 150], T_Q = [0.4, 0.8];
  const strongAt = (x) => ({ dpi: Math.round(T_DPI[0] + x * (T_DPI[1] - T_DPI[0])), q: Math.round((T_Q[0] + x * (T_Q[1] - T_Q[0])) * 100) / 100 });

  // ── Stream filters ───────────────────────────────
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }
  async function deflate(bytes) {
    const cs = new CompressionStream('deflate');            // zlib format = PDF FlateDecode
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  }

  function ascii85(b) {
    const out = [];
    let group = [], i = 0;
    if (b[0] === 0x3c && b[1] === 0x7e) i = 2;                // optional "<~"
    for (; i < b.length; i++) {
      const c = b[i];
      if (c === 0x7e) break;                                   // "~>"
      if (c <= 0x20) continue;
      if (c === 0x7a && !group.length) { out.push(0, 0, 0, 0); continue; }   // "z"
      group.push(c - 33);
      if (group.length === 5) {
        let v = 0;
        for (const d of group) v = v * 85 + d;
        out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
        group = [];
      }
    }
    if (group.length) {
      const n = group.length;
      while (group.length < 5) group.push(84);
      let v = 0;
      for (const d of group) v = v * 85 + d;
      const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      out.push(...bytes.slice(0, n - 1));
    }
    return new Uint8Array(out);
  }

  function asciiHex(b) {
    const out = [];
    let hi = -1;
    for (const c of b) {
      if (c === 0x3e) break;
      const h = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (h < 0) continue;
      if (hi < 0) hi = h; else { out.push(hi * 16 + h); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return new Uint8Array(out);
  }

  function runLength(b) {
    const out = [];
    for (let i = 0; i < b.length;) {
      const n = b[i++];
      if (n === 128) break;
      if (n < 128) { for (let k = 0; k <= n && i < b.length; k++) out.push(b[i++]); }
      else { const v = b[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); }
    }
    return new Uint8Array(out);
  }

  // PNG predictors (DecodeParms /Predictor ≥ 10).
  function unpredict(data, colors, columns, bpc = 8) {
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)), row = Math.ceil((colors * bpc * columns) / 8);
    const out = new Uint8Array(row * Math.floor(data.length / (row + 1)));
    let prev = new Uint8Array(row);
    for (let i = 0, o = 0; i + row < data.length + 1 && o < out.length;) {
      const type = data[i++];
      const cur = out.subarray(o, o + row);
      for (let x = 0; x < row; x++) {
        const raw = data[i + x];
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (type) {
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

  const asArray = (L, ctx, v) => {
    v = ctx.lookup(v);
    if (!v) return [];
    return v instanceof L.PDFArray ? v.asArray().map((x) => ctx.lookup(x)) : [v];
  };

  // Decode a stream through its whole filter chain. Stops at DCTDecode and returns the JPEG
  // bytes ({ jpeg }), otherwise returns the decoded bytes ({ raw }). null = unsupported filter.
  async function decodeChain(L, ctx, stream) {
    const filters = asArray(L, ctx, stream.dict.get(L.PDFName.of('Filter')));
    const parms = asArray(L, ctx, stream.dict.get(L.PDFName.of('DecodeParms')));
    let data = stream.contents;
    for (let k = 0; k < filters.length; k++) {
      const f = filters[k] && filters[k].asString ? filters[k].asString().slice(1) : String(filters[k]).replace(/^\//, '');
      const p = parms[k] instanceof L.PDFDict ? parms[k] : null;
      if (f === 'DCTDecode' || f === 'DCT') return k === filters.length - 1 ? { jpeg: data } : null;
      if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
      else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
      else if (f === 'FlateDecode' || f === 'Fl') {
        data = await inflate(data);
        const pred = p && p.get(L.PDFName.of('Predictor'));
        const pv = pred ? pred.asNumber() : 1;
        if (pv >= 10) {
          const n = (key, d) => { const v = p.get(L.PDFName.of(key)); return v ? v.asNumber() : d; };
          data = unpredict(data, n('Colors', 1), n('Columns', 1), n('BitsPerComponent', 8));
        } else if (pv > 1) return null;                          // TIFF predictor: leave alone
      } else return null;                                        // LZW, JBIG2, JPX, CCITT…
    }
    return { raw: data };
  }

  // ── Where (and how big) each image is drawn ─────────
  // Minimal content-stream reader: q / Q / cm / Do, recursing into Form XObjects; inline images
  // (BI … ID … EI) are skipped. Returns Map(image ref tag → largest displayed { w, h } in points).
  function* tokens(b) {
    const n = b.length;
    let i = 0;
    const delim = (c) => c <= 0x20 || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
    while (i < n) {
      const c = b[i];
      if (c <= 0x20) { i++; continue; }
      if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }          // % comment
      if (c === 0x28) {                                                                            // ( string )
        let depth = 1; i++;
        while (i < n && depth) { if (b[i] === 0x5c) i += 2; else { if (b[i] === 0x28) depth++; else if (b[i] === 0x29) depth--; i++; } }
        yield { k: 'str' }; continue;
      }
      if (c === 0x3c) {
        if (b[i + 1] === 0x3c) { i += 2; yield { k: 'op', v: '<<' }; continue; }
        while (i < n && b[i] !== 0x3e) i++; i++; yield { k: 'str' }; continue;
      }
      if (c === 0x3e) { i += b[i + 1] === 0x3e ? 2 : 1; yield { k: 'op', v: '>>' }; continue; }
      if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; yield { k: 'op', v: String.fromCharCode(c) }; continue; }
      if (c === 0x2f) {
        let s = ''; i++;
        while (i < n && !delim(b[i])) s += String.fromCharCode(b[i++]);
        yield { k: 'name', v: s.replace(/#([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))) }; continue;
      }
      let s = '';
      while (i < n && !delim(b[i])) s += String.fromCharCode(b[i++]);
      if (!s) { i++; continue; }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) { yield { k: 'num', v: parseFloat(s) }; continue; }
      if (s === 'ID') {                                                                            // inline image data
        i++;
        while (i < n - 2 && !(b[i] === 0x45 && b[i + 1] === 0x49 && (b[i - 1] <= 0x20) && (i + 2 >= n || b[i + 2] <= 0x20))) i++;
        i += 2; yield { k: 'op', v: 'EI' }; continue;
      }
      yield { k: 'op', v: s };
    }
  }

  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

  // full(stream) → the same stream with its bytes in memory (read from the file only when needed)
  async function contentBytes(L, ctx, contents, full) {
    const parts = [];
    for (const s of asArray(L, ctx, contents)) {
      if (!(s instanceof L.PDFRawStream)) continue;
      const d = await decodeChain(L, ctx, await full(s)).catch(() => null);
      if (d && d.raw) parts.push(d.raw, new Uint8Array([10]));
    }
    const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // pages: PFStream.pages(doc) — { node, inherited: { Resources } } in page order
  async function displaySizes(L, ctx, pages, full, onPage) {
    const sizes = new Map();
    const N = (k) => L.PDFName.of(k);
    async function run(bytes, resources, ctm0, depth) {
      const xobjects = resources && ctx.lookup(resources.get(N('XObject')));
      let ctm = ctm0;
      const stack = [];
      let operands = [];
      for (const t of tokens(bytes)) {
        if (t.k !== 'op') { operands.push(t); continue; }
        if (t.v === 'q') stack.push(ctm);
        else if (t.v === 'Q') ctm = stack.pop() || ctm0;
        else if (t.v === 'cm' && operands.length >= 6) {
          const m = operands.slice(-6).map((x) => x.v);
          if (m.every((x) => typeof x === 'number')) ctm = mul(m, ctm);
        } else if (t.v === 'Do' && operands.length && xobjects instanceof L.PDFDict) {
          const name = operands[operands.length - 1].v;
          const ref = xobjects.get(N(name));
          const obj = ctx.lookup(ref);
          if (obj instanceof L.PDFRawStream) {
            const sub = obj.dict.get(N('Subtype'));
            if (sub === N('Image') && ref instanceof L.PDFRef) {
              const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
              const prev = sizes.get(ref.tag) || { w: 0, h: 0 };
              sizes.set(ref.tag, { w: Math.max(prev.w, w), h: Math.max(prev.h, h) });
            } else if (sub === N('Form') && depth < 8) {
              const mx = ctx.lookup(obj.dict.get(N('Matrix')));
              const fm = mx instanceof L.PDFArray ? mx.asArray().map((x) => ctx.lookup(x).asNumber()) : [1, 0, 0, 1, 0, 0];
              const fres = ctx.lookup(obj.dict.get(N('Resources'))) || resources;
              const d = await decodeChain(L, ctx, await full(obj)).catch(() => null);
              if (d && d.raw) await run(d.raw, fres, mul(fm, ctm), depth + 1);
            }
          }
        }
        operands = [];
      }
    }
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      const res = ctx.lookup(pg.inherited.Resources);
      const bytes = await contentBytes(L, ctx, pg.node.get(N('Contents')), full);
      await run(bytes, res instanceof L.PDFDict ? res : null, [1, 0, 0, 1, 0, 0], 0);
      if (onPage) onPage(i + 1, pages.length);
      await C.yieldUI();
    }
    return sizes;
  }

  // ── Images → pixels → smaller images ─────────────────
  function colorCount(L, ctx, cs) {
    cs = ctx.lookup(cs);
    if (!cs) return 0;
    if (cs instanceof L.PDFName) return cs === L.PDFName.of('DeviceRGB') || cs === L.PDFName.of('CalRGB') ? 3 : cs === L.PDFName.of('DeviceGray') || cs === L.PDFName.of('CalGray') ? 1 : 0;
    if (cs instanceof L.PDFArray && cs.size() >= 2) {
      const kind = ctx.lookup(cs.get(0));
      if (kind === L.PDFName.of('ICCBased')) {
        const icc = ctx.lookup(cs.get(1));
        const nv = icc && icc.dict && icc.dict.get(L.PDFName.of('N'));
        const v = nv && nv.asNumber ? nv.asNumber() : 0;
        return v === 3 || v === 1 ? v : 0;
      }
      if (kind === L.PDFName.of('CalRGB')) return 3;
      if (kind === L.PDFName.of('CalGray')) return 1;
    }
    return 0;                                                  // CMYK, Indexed, Lab, Separation… left as they are
  }

  // → ImageBitmap of the image (colour images, or a soft mask when asMask), or null.
  async function decodeImage(L, ctx, obj, asMask) {
    const d = obj.dict, get = (k) => ctx.lookup(d.get(L.PDFName.of(k)));
    const w = get('Width') && get('Width').asNumber(), h = get('Height') && get('Height').asNumber();
    if (!w || !h || get('ImageMask') === L.PDFBool.True || get('Decode')) return null;
    const colors = asMask ? 1 : colorCount(L, ctx, d.get(L.PDFName.of('ColorSpace')));
    if (!colors) return null;
    const dec = await decodeChain(L, ctx, obj);
    if (!dec) return null;
    if (dec.jpeg) return createImageBitmap(new Blob([dec.jpeg], { type: 'image/jpeg' }));
    const bpc = get('BitsPerComponent') && get('BitsPerComponent').asNumber();
    if (bpc !== 8 || dec.raw.length < w * h * colors) return null;
    const id = new ImageData(w, h);
    const o = id.data, raw = dec.raw;
    for (let p = 0, s = 0; p < w * h; p++, s += colors) {
      const j = p * 4;
      if (colors === 3) { o[j] = raw[s]; o[j + 1] = raw[s + 1]; o[j + 2] = raw[s + 2]; } else { o[j] = o[j + 1] = o[j + 2] = raw[s]; }
      o[j + 3] = 255;
    }
    return createImageBitmap(id);
  }

  function resample(bmp, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    return c;
  }

  async function flatePixels(canvas, colors) {
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const raw = new Uint8Array(canvas.width * canvas.height * colors);
    for (let p = 0, s = 0; s < raw.length; p += 4, s += colors) {
      raw[s] = px[p];
      if (colors === 3) { raw[s + 1] = px[p + 1]; raw[s + 2] = px[p + 2]; }
    }
    return deflate(raw);
  }

  // Target size for an image of pw×ph pixels shown at disp (points): ~150 DPI, never upscaled.
  function targetSize(pw, ph, disp) {
    let scale;
    if (disp && disp.w > 0 && disp.h > 0) {
      const needW = (disp.w / 72) * TARGET_DPI, needH = (disp.h / 72) * TARGET_DPI;
      scale = Math.max(needW / pw, needH / ph);
      if (scale * DPI_SLACK >= 1) scale = 1;                    // already ≤ ~165 DPI: keep the size
    } else {
      scale = Math.min(1, UNKNOWN_MAX_SIDE / Math.max(pw, ph));
    }
    return { w: Math.max(1, Math.round(pw * scale)), h: Math.max(1, Math.round(ph * scale)), scale };
  }

  // The PDF, read in slices (lib/pdf-tools/pdf-stream.js). A file whose structure that reader can't follow is
  // loaded whole by pdf-lib instead — only up to MEMORY_FALLBACK, so a damaged huge file gets a message, not a crash.
  async function openDoc(file, name, onProgress) {
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    try { return await S.open(file, L, onProgress); }
    catch (e) {
      if (!(e instanceof S.StreamError) || e.type !== 'damaged' || file.size > MEMORY_FALLBACK) throw C.toToolError(e, name);
      let d;
      try { d = await L.PDFDocument.load(new Uint8Array(await file.arrayBuffer()), { updateMetadata: false }); }
      catch (e2) { throw C.isEncryptedError(e2) ? C.encryptedError(name) : C.toToolError(e2, name); }
      return S.fromPdfLib(d, L);
    }
  }

  // Light, written to sink as it goes: every object is copied in order; images on the plan are read, made
  // smaller and written one at a time, so only one image is ever decoded in memory. → { stats }
  async function compressLight(file, name, sink, onProgress) {
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    const doc = await openDoc(file, name, (x) => onProgress(0.03 * x, 'Reading the PDF…'));
    const ctx = doc.ctx;
    const NM = (k) => L.PDFName.of(k);
    const pages = S.pages(doc);
    C.checkPages(pages.length, LIGHT_PAGES, `"${name}"`);
    const full = async (s) => (doc.data.has(s) ? L.PDFRawStream.of(s.dict, await S.bytesOf(doc, s)) : s);
    const shown = await displaySizes(L, ctx, pages, full, (n, of) => onProgress(0.03 + 0.05 * (n / of), `Finding images… page ${n} of ${of}`));

    const smaskOwners = new Map();             // soft mask ref tag → number of images using it
    const images = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream) || obj.dict.get(NM('Subtype')) !== NM('Image')) continue;
      const sm = obj.dict.get(NM('SMask'));
      if (sm instanceof L.PDFRef) smaskOwners.set(sm.tag, (smaskOwners.get(sm.tag) || 0) + 1);
      images.push([ref, obj]);
    }
    // the plan: opaque images → JPEG; images with transparency → smaller lossless Flate, with their soft mask
    const stats = { images: 0, changed: 0 };
    const plan = new Map();
    for (const [ref, obj] of images) {
      if (smaskOwners.has(ref.tag)) continue;                  // soft masks are planned with their image
      stats.images++;
      const get = (k) => ctx.lookup(obj.dict.get(NM(k)));
      const pw = get('Width') ? get('Width').asNumber() : 0, ph = get('Height') ? get('Height').asNumber() : 0;
      if (Math.max(pw, ph) < MIN_SIDE || S.sizeOf(doc, obj) < MIN_IMAGE_BYTES) continue;
      const t = targetSize(pw, ph, shown.get(ref.tag));
      const smRef = obj.dict.get(NM('SMask'));
      if (!(smRef instanceof L.PDFRef)) plan.set(ref.tag, { kind: 'jpeg', t });
      else if (t.scale < 1) {
        plan.set(ref.tag, { kind: 'flate', t, smRef });
        if (smaskOwners.get(smRef.tag) === 1) plan.set(smRef.tag, { kind: 'mask', t });
      }
    }

    const w = S.writer(sink, L, { firstFree: ctx.largestObjectNumber + 1 });
    await w.start();
    let done = 0;
    await S.copyAll(doc, w, async (ref, obj) => {
      const job = plan.get(ref.tag);
      if (!job) return null;
      done++;
      onProgress(0.08 + 0.9 * (done / plan.size), `Optimising image ${done} of ${plan.size}…`);
      await C.yieldUI();
      const before = S.sizeOf(doc, obj), src = await full(obj), t = job.t;
      const bmp = await decodeImage(L, ctx, src, job.kind === 'mask').catch(() => null);
      if (!bmp) return null;
      const canvas = resample(bmp, t.w, t.h);
      if (bmp.close) bmp.close();
      try {
        if (job.kind === 'jpeg') {
          const jpg = new Uint8Array(await (await C.canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY)).arrayBuffer());
          if (jpg.length >= before * 0.9) return null;
          const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: t.w, Height: t.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
          const interp = obj.dict.get(NM('Interpolate'));
          if (interp) dict.set(NM('Interpolate'), interp);
          stats.changed++;
          return { obj: dict, data: jpg };
        }
        const colors = job.kind === 'mask' ? 1 : colorCount(L, ctx, obj.dict.get(NM('ColorSpace'))) === 1 ? 1 : 3;
        const data = await flatePixels(canvas, colors);
        if (data.length >= before * 0.9) return null;
        const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: t.w, Height: t.h, ColorSpace: colors === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
        if (job.smRef) dict.set(NM('SMask'), job.smRef);
        if (job.kind !== 'mask') stats.changed++;
        return { obj: dict, data };
      } finally { C.freeCanvas(canvas); }
    });
    onProgress(0.99, 'Saving…');
    await w.finish({ root: doc.root, info: doc.info });
    return { stats };
  }

  // Strong: each page rendered by pdf.js (reading only that page's part of the file) → JPEG → written to sink
  // straight away. pdf.js is reopened every few pages, so it never holds more than a few pages of the file.
  async function compressStrong(file, name, sink, onProgress, dpi = STRONG_DPI, quality = STRONG_QUALITY) {
    const pdfjs = await window.PFLoad.pdfjs();
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    const src = S.pagedPdfjs(pdfjs, file, window.PFLoad.pdfjsOptions(), STRONG_BATCH);
    let n;
    try { n = await src.open(); } catch (e) { throw C.toToolError(e, name); }
    try {
      C.checkPages(n, C.LIMITS.pages, `"${name}"`);
      const ctx = L.PDFContext.create();
      const w = S.writer(sink, L);
      await w.start();
      const pagesRef = w.alloc(), kids = [];
      for (let p = 1; p <= n; p++) {
        onProgress((p - 1) / n, `Compressing page ${p} of ${n}…`);
        await C.yieldUI();
        const page = await src.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const jpg = await C.canvasToBlob(canvas, 'image/jpeg', quality);
        const iw = canvas.width, ih = canvas.height;
        C.freeCanvas(canvas);
        page.cleanup();
        const img = w.alloc(), content = w.alloc(), pageRef = w.alloc();
        const W = Math.round(base.width * 1000) / 1000, H = Math.round(base.height * 1000) / 1000;
        await w.put(img, ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: iw, Height: ih, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }), jpg);
        await w.put(content, ctx.obj({}), S.ascii(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`));
        await w.put(pageRef, ctx.obj({ Type: 'Page', Parent: pagesRef, MediaBox: [0, 0, W, H], Resources: { XObject: { Im0: img } }, Contents: content }));
        kids.push(pageRef);
      }
      onProgress(0.99, 'Saving…');
      await w.put(pagesRef, ctx.obj({ Type: 'Pages', Kids: kids, Count: kids.length }));
      const cat = w.alloc();
      await w.put(cat, ctx.obj({ Type: 'Catalog', Pages: pagesRef }));
      await w.finish({ root: cat });
      return { stats: { pages: n, dpi, quality } };
    } finally {
      await src.close();
    }
  }

  // one pass into memory → Blob
  async function toBlob(fn) {
    const sink = window.PFStream.blobSink();
    const r = await fn(sink);
    return Object.assign({ blob: await sink.close() }, r);
  }

  // → { blob, how: 'original' | 'light' | 'strong', fits, dpi? }
  async function compressToTarget(file, name, target, onProgress) {
    if (file.size <= target) return { blob: file, how: 'original', fits: true };
    const span = (a, b) => (x, t) => onProgress(a + (b - a) * x, t);
    const light = await toBlob((s) => compressLight(file, name, s, span(0, 0.2)));
    if (light.blob.size <= target) return { blob: light.blob, how: 'light', fits: true };
    let best = light.blob.size < file.size ? { blob: light.blob, how: 'light' } : { blob: file, how: 'original' };
    const keep = (r, x) => { if (r.blob.size < best.blob.size) best = { blob: r.blob, how: 'strong', dpi: strongAt(x).dpi }; };
    const strong = (x, a, b, label) => {
      const { dpi, q } = strongAt(x);
      return toBlob((s) => compressStrong(file, name, s, (y, t) => onProgress(a + (b - a) * y, `${label} — ${t}`), dpi, q));
    };
    // the floor first: if even 72 DPI / q 0.4 is too big, the target can't be reached
    const floor = await strong(0, 0.2, 0.36, 'Trying the smallest size');
    keep(floor, 0);
    if (floor.blob.size > target) return Object.assign({ fits: false }, best);
    let fit = { r: floor, x: 0 };
    const top = await strong(1, 0.36, 0.52, 'Trying the best quality');
    if (top.blob.size <= target) fit = { r: top, x: 1 };
    else {
      let lo = 0, hi = 1;
      for (let k = 0; k < 4; k++) {                            // best quality that still fits
        const mid = (lo + hi) / 2;
        const r = await strong(mid, 0.52 + k * 0.115, 0.52 + (k + 1) * 0.115, `Finding the best quality (step ${k + 1} of 4)`);
        if (r.blob.size <= target) { lo = mid; fit = { r, x: mid }; } else hi = mid;
      }
    }
    return { blob: fit.r.blob, how: 'strong', fits: true, dpi: strongAt(fit.x).dpi };
  }

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const summary = C.q(panel, 'summary');
    const go = C.q(panel, 'go');
    const fileLabel = C.q(panel, 'file-name');
    const dl = C.q(panel, 'dl-pdf'), alt = C.q(panel, 'dl-alt');
    let run = 0, file = null, out = null, outName = '', altOut = null, altName = '';
    const targetRow = C.q(panel, 'target-row'), targetSel = C.q(panel, 'target'), targetCustom = C.q(panel, 'target-custom');
    const modeOf = () => (panel.querySelector('input[name="pf-compress-mode"]:checked') || {}).value || 'light';
    function targetBytes() {
      if (targetSel.value !== 'custom') return +targetSel.value;
      const kb = parseFloat(String(targetCustom.value).replace(',', '.'));
      return kb > 0 ? Math.round(kb * 1000) : 0;
    }
    function syncTarget() {
      targetRow.hidden = modeOf() !== 'target';
      targetCustom.hidden = targetSel.value !== 'custom';
    }

    let savedAs = '';                        // set when the result was written straight to a file on disk
    function clearResult() {
      out = null; altOut = null; outName = ''; altName = ''; savedAs = '';
      result.hidden = true;
      alt.hidden = true;
      dl.hidden = false;
      summary.textContent = '';
    }
    function reset() {
      run++;
      file = null;
      clearResult();
      fileLabel.textContent = '';
      go.disabled = true;
      C.clearError(panel);
      C.bigNote(panel, 0);
      P.hide();
    }

    function choose(files) {
      reset();
      const f = files[0];
      try {
        if (!C.isPdfFile(f)) throw new C.ToolError('unsupported', 'Please choose a PDF file (.pdf).');
        C.checkSizes([f], 'compress-pdf');
      } catch (e) {
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
        return;
      }
      file = f;
      fileLabel.textContent = `${f.name} · ${C.fmtBytes(f.size)}`;
      C.bigNote(panel, f.size);
      go.disabled = false;
    }
    // "Saved to your computer as …" for a result written straight to disk (there is nothing left to download)
    function saved(text) {
      dl.hidden = true;
      alt.hidden = true;
      const s = document.createElement('span');
      s.textContent = ` Saved to your computer as “${savedAs}”.`;
      summary.append(text || '', s);
    }

    async function compress() {
      if (!file) return;
      const me = ++run;
      const f = file;
      const mode = modeOf();
      const target = mode === 'target' ? targetBytes() : 0;
      if (mode === 'target' && !(target >= 10000)) {
        C.showError(panel, new C.ToolError('unsupported', 'Enter a target size of at least 10 KB.'));
        return;
      }
      // Strong and Target size render every page with pdf.js, which needs memory in proportion to the file
      const render = C.opLimits('compress-pdf').render;
      if (mode !== 'light' && f.size > render) {
        const e = new C.ToolError('too_large', `"${f.name}" is ${C.fmtBytes(f.size)}. Strong and Target size handle files up to ${C.fmtLimit(render)}${C.bigTier() ? '' : ' in this browser'} — use Light for this file (up to ${C.fmtLimit(C.opLimits('compress-pdf').file)}), or split it.`);
        C.showError(panel, e);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type);
        return;
      }
      C.clearError(panel);
      clearResult();
      go.disabled = true;
      const compressedName = C.baseName(f.name) + '-compressed.pdf';
      let dest = null;
      try {
        // first, while this still runs from the click: for a large file, where to save the result
        dest = await C.outputSink(f.size, compressedName);
        if (me !== run) { await dest.sink.abort(); return; }
        if (dest.toDisk) savedAs = dest.sink.name;
        P.set(0.02, 'Loading…');
        if (mode === 'target') {
          const r = await compressToTarget(f, f.name, target, (x, t) => me === run && P.set(x, t));
          if (dest.toDisk) { await dest.sink.write(r.blob); await dest.sink.close(); } else await dest.sink.abort();
          if (me !== run) return;
          showTarget(f, r, target);
          result.hidden = false;
          if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
          return;
        }
        if (mode === 'strong') await compressStrong(f, f.name, dest.sink, (x, t) => me === run && P.set(x, t));
        else await compressLight(f, f.name, dest.sink, (x, t) => me === run && P.set(x, t));
        const compressed = await dest.sink.close();
        if (me !== run) return;
        const before = f.size, after = compressed.size;
        const sizes = `Before: ${C.fmtBytes(before)} → After: ${C.fmtBytes(after)}`;
        summary.innerHTML = '';
        if (after >= before * 0.98) {
          // not (meaningfully) smaller: the original is the better file, but say so plainly and still offer the result
          out = f; outName = f.name;
          altOut = compressed; altName = compressedName;
          const b = document.createElement('strong');
          b.textContent = 'This PDF is already well compressed.';
          if (savedAs) {
            summary.append(`${sizes} — ${after >= before ? 'not smaller' : 'barely smaller'}. `, b, ' Keep your original file; the saved copy is not smaller.');
            saved();
          } else {
            summary.append(`${sizes} — ${after >= before ? 'not smaller' : 'barely smaller'}. `, b,
              mode === 'strong' ? ' The download below is your original file, unchanged (its text stays selectable).' : ' The download below is your original file, unchanged.');
            dl.textContent = '⬇ Download original PDF (unchanged)';
            alt.textContent = mode === 'strong' ? `Download the image-only version anyway (${C.fmtBytes(after)})` : `Download the re-saved version anyway (${C.fmtBytes(after)})`;
            alt.hidden = false;
          }
        } else {
          out = compressed; outName = compressedName;
          const pct = (1 - after / before) * 100;
          summary.textContent = `${sizes} (${pct < 1 ? '<1' : Math.round(pct)}% smaller)` + (mode === 'strong' ? ' · text is no longer selectable' : '');
          if (savedAs) saved(); else dl.textContent = '⬇ Download compressed PDF';
        }
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
        if (dest) await dest.sink.abort();
        if (me !== run) return;
        const err = C.toToolError(e, f.name);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      } finally {
        if (me === run) { P.hide(); go.disabled = !file; }
      }
    }

    // Target size result: what was made, whether it fits, and what that cost (selectable text or not)
    function showTarget(f, r, target) {
      // the limit as people write it: "1 MB", "500 KB", "1.5 MB" (1 KB = 1,000 bytes, like the rest of the tool)
      const trim = (n) => String(Math.round(n * 100) / 100);
      const goal = target >= 1e6 ? trim(target / 1e6) + ' MB' : trim(target / 1e3) + ' KB';
      const before = f.size, after = r.blob.size;
      const name = C.baseName(f.name) + '-compressed.pdf';
      summary.innerHTML = '';
      if (r.how === 'original') {
        out = f; outName = f.name;
        summary.textContent = `Already under ${goal}: your PDF is ${C.fmtBytes(before)}, so there is nothing to compress.` + (savedAs ? ' The saved file is a copy of your original.' : ' The download below is your original file, unchanged.');
        if (savedAs) saved(); else dl.textContent = '⬇ Download original PDF (unchanged)';
        return;
      }
      out = r.blob; outName = name;
      const sizes = `Before: ${C.fmtBytes(before)} → After: ${C.fmtBytes(after)}`;
      const how = r.how === 'light' ? 'Text stays selectable.'
        : r.how === 'strong' ? `Pages became images at ${r.dpi} DPI, so the text is no longer selectable.` : '';
      if (r.fits) {
        summary.textContent = `${sizes} — under ${goal}. ${how}`.trim();
        if (savedAs) saved(); else dl.textContent = '⬇ Download compressed PDF';
      } else {
        const b = document.createElement('strong');
        b.textContent = `Couldn’t get this PDF under ${goal}.`;
        summary.append(b, ` The smallest we could make is ${C.fmtBytes(after)} (before: ${C.fmtBytes(before)}). ${how} Try removing pages you don’t need, or split the file and upload it in parts.`);
        if (savedAs) saved(); else dl.textContent = `⬇ Download the smallest version (${C.fmtBytes(after)})`;
      }
    }

    C.setupDrop(panel, choose);
    go.addEventListener('click', compress);
    dl.addEventListener('click', () => {
      if (!out) return;
      C.download(out, outName);
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
    });
    alt.addEventListener('click', () => {
      if (!altOut) return;
      C.download(altOut, altName);
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
    });
    C.q(panel, 'start-over').addEventListener('click', reset);
    panel.querySelectorAll('input[name="pf-compress-mode"]').forEach((r) => r.addEventListener('change', () => { clearResult(); syncTarget(); }));
    targetSel.addEventListener('change', () => { clearResult(); syncTarget(); if (targetSel.value === 'custom') targetCustom.focus(); });
    targetCustom.addEventListener('input', clearResult);
    syncTarget();
    return { reset };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['compress-pdf'] = {
    libs: () => Promise.all([window.PFLoad.pdfLib(), C.loadModule('pdf-stream')]), init,
    _internals: { unpredict, ascii85, asciiHex, runLength, targetSize, displaySizes, decodeChain, compressLight, compressStrong, compressToTarget, strongAt, openDoc },
  };
})();
