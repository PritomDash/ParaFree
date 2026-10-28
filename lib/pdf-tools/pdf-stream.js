// ═══════════════════════════════════════════════════
// ParaFree PDF tools — streaming PDF engine (lib/pdf-tools/pdf-stream.js)
// Large files without loading them whole:
// • open(): reads a PDF through file.slice() windows. Every object's dictionary is parsed (with
//   pdf-lib's own object parser), but stream data (images, page contents) stays on disk: each
//   stream remembers where its bytes are, and they are read only when a tool needs them.
// • writer(): writes a PDF object by object to a sink. Unchanged stream data is passed on as a
//   slice of the original file, so the browser copies it straight from disk to the output.
//   Small objects go into compressed object streams, with a cross-reference stream at the end.
// • sinks: fileSink() writes to a file the user chose (File System Access API, Chrome/Edge
//   desktop), so the output never has to fit in memory; blobSink() builds a Blob (all
//   browsers), whose new bytes are held by the browser.
// • openPdfjs(): pdf.js reads byte ranges of the file on demand (PDFDataRangeTransport)
//   instead of being handed a copy of the whole file.
// • zipWriter(): ZIP (stored, no compression) written entry by entry to a sink.
// Nothing here uploads anything.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';

  const WINDOW = 1 << 20;                      // bytes read per file.slice() window
  const MAX_OBJECT = 16 << 20;                 // a dictionary bigger than this = damaged file
  const EMPTY = new Uint8Array(0);

  class StreamError extends Error {
    constructor(type, message) { super(message); this.type = type; }
  }

  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const ascii = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const isWS = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  // ── Reading: one window of the file at a time ───────
  class Reader {
    constructor(file) { this.file = file; this.size = file.size; this.win = null; this.at = 0; }
    // bytes [off, off+len) — may be a view of the shared window: copy (slice) to keep them
    async read(off, len) {
      off = Math.max(0, off); len = Math.max(0, Math.min(len, this.size - off));
      const w = this.win;
      if (w && off >= this.at && off + len <= this.at + w.length) return w.subarray(off - this.at, off - this.at + len);
      if (len > WINDOW) return new Uint8Array(await this.file.slice(off, off + len).arrayBuffer());
      this.win = new Uint8Array(await this.file.slice(off, Math.min(this.size, off + WINDOW)).arrayBuffer());
      this.at = off;
      return this.win.subarray(0, len);
    }
  }

  function skipWS(b, i) {
    for (;;) {
      while (i < b.length && isWS(b[i])) i++;
      if (b[i] !== 0x25) return i;                             // % comment
      while (i < b.length && b[i] !== 10 && b[i] !== 13) i++;
    }
  }
  const startsAt = (b, i, word) => { for (let k = 0; k < word.length; k++) if (b[i + k] !== word.charCodeAt(k)) return false; return true; };

  // One indirect object at file offset off → { num, gen, obj, data?: { start, len, lenRef } }.
  // Streams are not read: data says where their bytes are.
  async function readObject(r, L, ctx, off) {
    for (let len = 4096; ; len *= 4) {
      const b = await r.read(off, Math.min(len, MAX_OBJECT));
      const m = /^\s*(\d+)\s+(\d+)\s+obj/.exec(latin1(b.subarray(0, 48)));
      if (!m) throw new StreamError('damaged', 'no object at ' + off);
      let i = skipWS(b, m[0].length);
      try {
        const p = L.PDFObjectParser.forBytes(b.subarray(i), ctx);
        const obj = b[i] === 0x3c && b[i + 1] === 0x3c ? p.parseDict() : p.parseObject();
        i = skipWS(b, i + p.bytes.offset());
        if (i + 7 > b.length && off + b.length < r.size && len < MAX_OBJECT) continue;   // might be "stream": look further
        const rec = { num: +m[1], gen: +m[2], obj };
        if (startsAt(b, i, 'stream') && obj instanceof L.PDFDict) {
          i += 6;
          if (b[i] === 13) i++;
          if (b[i] === 10) i++;
          const lv = obj.get(L.PDFName.of('Length'));
          rec.data = { start: off + i, len: lv instanceof L.PDFNumber ? lv.asNumber() : null, lenRef: lv instanceof L.PDFRef ? lv : null };
        }
        return rec;
      } catch (e) {
        if (e instanceof StreamError) throw e;
        if (off + b.length >= r.size || len >= MAX_OBJECT) throw new StreamError('damaged', 'object at ' + off + ': ' + e.message);
      }
    }
  }

  // The xref section at off (a table, or a cross-reference stream) → { entries: [[num, entry]], trailer }
  async function readXref(r, L, ctx, base, off) {
    const head = latin1(await r.read(base + off, 32));
    if (/^\s*xref/.test(head)) {
      for (let len = 1 << 16; ; len *= 4) {
        const b = await r.read(base + off, len), s = latin1(b);
        const out = [];
        const re = /\s*(\d+)\s+(\d+)[ \t]*[\r\n]+/y, ent = /\s*(\d{1,10})\s+(\d{1,5})\s+([nf])/y;
        let i = s.indexOf('xref') + 4, ok = false;
        for (;;) {
          re.lastIndex = i;
          const sub = re.exec(s);
          if (!sub) break;
          i = re.lastIndex;
          let n = +sub[1];
          for (let k = 0; k < +sub[2]; k++) {
            ent.lastIndex = i;
            const e = ent.exec(s);
            if (!e) break;
            i = ent.lastIndex;
            if (e[3] === 'n' && +e[1] > 0) out.push([n, { off: +e[1], gen: +e[2] }]);
            n++;
          }
        }
        const t = s.indexOf('trailer', i);
        if (t >= 0) {
          try {
            const p = L.PDFObjectParser.forBytes(b.subarray(skipWS(b, t + 7)), ctx);
            const trailer = p.parseDict();
            ok = true;
            return { entries: out, trailer };
          } catch (e) { /* cut off: read more */ }
        }
        if (!ok && (base + off + b.length >= r.size || len > 256 << 20)) throw new StreamError('damaged', 'bad xref table');
      }
    }
    const rec = await readObject(r, L, ctx, base + off);
    if (!rec.data) throw new StreamError('damaged', 'bad xref stream');
    const len = rec.data.len != null ? rec.data.len : await findLength(r, rec.data.start);
    const raw = L.PDFRawStream.of(rec.obj, (await r.read(rec.data.start, len)).slice());
    const entries = L.PDFXRefStreamParser.forStream(raw).parseEntries()
      .filter((e) => !e.deleted && e.ref.objectNumber > 0)
      .map((e) => [e.ref.objectNumber, e.inObjectStream ? { stm: e.offset } : { off: e.offset, gen: e.ref.generationNumber }]);
    return { entries, trailer: rec.obj, self: rec.num };
  }

  // Length of a stream whose /Length is missing or wrong: up to the next "endstream".
  async function findLength(r, start) {
    for (let at = start; at < r.size; at += WINDOW - 16) {
      const b = await r.read(at, WINDOW), s = latin1(b);
      const k = s.indexOf('endstream');
      if (k >= 0) {
        let end = at + k;
        const tail = await r.read(Math.max(start, end - 2), end - Math.max(start, end - 2));
        if (tail[tail.length - 1] === 10) end--;
        if (tail[tail.length - 2] === 13 && tail[tail.length - 1] === 10) end--;
        else if (tail[tail.length - 1] === 13) end--;
        return Math.max(0, end - start);
      }
    }
    throw new StreamError('damaged', 'stream without endstream');
  }
  async function lengthOk(r, start, len) {
    if (start + len > r.size) return false;
    const b = await r.read(start + len, 24);
    return startsAt(b, skipWS(b, 0), 'endstream');
  }

  // No usable xref: find "N G obj" by scanning the file, window by window.
  async function scanObjects(r, L, ctx) {
    const found = new Map();
    let trailer = null;
    for (let at = 0; at < r.size; at += WINDOW - 64) {
      const b = await r.read(at, WINDOW), s = latin1(b);
      const re = /(?:^|[\s>])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
      let m;
      while ((m = re.exec(s))) found.set(+m[1], { off: at + m.index + m[0].indexOf(m[1]), gen: +m[2] });
      let t = -1;
      while ((t = s.indexOf('trailer', t + 1)) >= 0) {
        try { trailer = L.PDFObjectParser.forBytes(b.subarray(skipWS(b, t + 7)), ctx).parseDict(); } catch (e) { /* not a dictionary */ }
      }
      if (at + WINDOW >= r.size) break;
    }
    return { entries: [...found], trailer };
  }

  // → a lazy document: { L, ctx, file, root, info, data: Map(stream → { start, len }) }
  async function open(file, L, onProgress) {
    const r = new Reader(file), ctx = L.PDFContext.create(), N = (k) => L.PDFName.of(k);
    const head = latin1(await r.read(0, 1024));
    const base = head.indexOf('%PDF-');
    if (base < 0) throw new StreamError('file_error', 'not a PDF');
    let final = new Map(), trailer = null, xrefSelf = new Set();
    try {
      const tail = latin1(await r.read(Math.max(0, r.size - 4096), 4096));
      const sx = tail.lastIndexOf('startxref');
      if (sx < 0) throw new StreamError('damaged', 'no startxref');
      const queue = [parseInt(tail.slice(sx + 9).trim(), 10)], seen = new Set();
      while (queue.length) {
        const off = queue.shift();
        if (!(off >= 0) || seen.has(off) || seen.size > 1000) continue;
        seen.add(off);
        const sec = await readXref(r, L, ctx, base, off);
        if (sec.self) xrefSelf.add(sec.self);
        for (const [n, e] of sec.entries) if (!final.has(n)) final.set(n, e);   // the newest section wins
        if (!trailer) trailer = sec.trailer;
        const xs = sec.trailer.get(N('XRefStm')), prev = sec.trailer.get(N('Prev'));
        if (xs instanceof L.PDFNumber) queue.unshift(xs.asNumber());
        if (prev instanceof L.PDFNumber) queue.push(prev.asNumber());
      }
      if (!trailer || !trailer.get(N('Root'))) throw new StreamError('damaged', 'no Root');
    } catch (e) {
      if (e instanceof StreamError && e.type === 'file_error') throw e;
      const sc = await scanObjects(r, L, ctx);
      final = new Map(sc.entries.map(([n, e]) => [n, { off: e.off - base, gen: e.gen }]));
      trailer = sc.trailer;
    }
    if (trailer && trailer.get(N('Encrypt'))) throw new StreamError('encrypted', 'encrypted');

    const data = new Map();
    const t1 = [...final].filter(([, e]) => e.off != null).sort((a, b) => a[1].off - b[1].off);
    const stms = new Set([...final.values()].filter((e) => e.stm != null).map((e) => e.stm));
    const load = async ([n, e]) => {
      const rec = await readObject(r, L, ctx, base + e.off);
      if (rec.num !== n) throw new StreamError('damaged', 'xref points to object ' + rec.num + ' for ' + n);
      const ref = L.PDFRef.of(n, rec.gen);
      if (rec.data) {
        const s = L.PDFRawStream.of(rec.obj, EMPTY);
        if (rec.data.len != null && !(await lengthOk(r, rec.data.start, rec.data.len))) rec.data.len = null;
        data.set(s, rec.data);
        ctx.assign(ref, s);
      } else ctx.assign(ref, rec.obj);
      if (n > ctx.largestObjectNumber) ctx.largestObjectNumber = n;
    };
    // object streams first, then the other objects (a newer plain object wins over a copy in an object stream)
    const first = t1.filter(([n]) => stms.has(n)), rest = t1.filter(([n]) => !stms.has(n));
    for (const x of first) await load(x);
    for (const n of stms) {
      const ref = L.PDFRef.of(n, 0), s = ctx.lookup(ref);
      if (!(s instanceof L.PDFRawStream)) continue;
      const bytes = await bytesOf({ r, data, ctx, L }, s);
      L.PDFObjectStreamParser.forStream(L.PDFRawStream.of(s.dict, bytes)).parseIntoContext();
    }
    for (let i = 0; i < rest.length; i++) {
      try { await load(rest[i]); } catch (e) { if (!(e instanceof StreamError)) throw e; /* a broken object: left out */ }
      if (i % 2000 === 1999) { if (onProgress) onProgress(i / rest.length); await yieldUI(); }
    }
    // indirect /Length values, then anything still unknown: up to "endstream"
    for (const [s, d] of data) {
      if (d.len == null && d.lenRef) {
        const v = ctx.lookup(d.lenRef);
        if (v instanceof L.PDFNumber && (await lengthOk(r, d.start, v.asNumber()))) d.len = v.asNumber();
      }
      if (d.len == null) d.len = await findLength(r, d.start);
      d.lenRef = null;
    }
    // object streams and cross-reference streams are rebuilt when the PDF is written
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      const type = obj instanceof L.PDFRawStream ? obj.dict.get(N('Type')) : null;
      if (type === N('ObjStm') || type === N('XRef') || xrefSelf.has(ref.objectNumber)) { ctx.delete(ref); data.delete(obj); }
    }
    const rootRef = trailer && trailer.get(N('Root'));
    const catalog = rootRef instanceof L.PDFRef ? ctx.lookup(rootRef) : null;
    if (!(catalog instanceof L.PDFDict)) throw new StreamError('damaged', 'no catalog');
    const info = trailer.get(N('Info'));
    return { L, ctx, r, file, data, root: rootRef, info: info instanceof L.PDFRef ? info : null };
  }

  // The same shape for a document pdf-lib loaded whole (the fallback for files this reader can't follow).
  function fromPdfLib(pdfDoc, L) {
    const t = pdfDoc.context.trailerInfo;
    return { L, ctx: pdfDoc.context, r: null, file: null, data: new Map(), root: t.Root, info: t.Info instanceof L.PDFRef ? t.Info : null };
  }

  // a stream's bytes (still encoded), read from the file if they are not in memory
  async function bytesOf(doc, s) {
    const d = doc.data.get(s);
    if (!d) return s.contents;
    return (await doc.r.read(d.start, d.len)).slice();
  }
  const sizeOf = (doc, s) => { const d = doc.data.get(s); return d ? d.len : s.contents.length; };
  // the stream's bytes as a Blob slice of the original file (no copy), or null if in memory
  const sliceOf = (doc, s) => { const d = doc.data.get(s); return d ? doc.file.slice(d.start, d.start + d.len) : null; };

  // Pages in order → [{ ref, node, inherited: { Resources, MediaBox, CropBox, Rotate } }]
  function pages(doc) {
    const { L, ctx } = doc, N = (k) => L.PDFName.of(k);
    const out = [], seen = new Set();
    const cat = ctx.lookup(doc.root);
    const walk = (ref, inh, depth) => {
      const node = ctx.lookup(ref);
      if (!(node instanceof L.PDFDict) || depth > 64 || (ref instanceof L.PDFRef && seen.has(ref.tag))) return;
      if (ref instanceof L.PDFRef) seen.add(ref.tag);
      const here = Object.assign({}, inh);
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) { const v = node.get(N(k)); if (v) here[k] = v; }
      const kids = ctx.lookup(node.get(N('Kids')));
      if (kids instanceof L.PDFArray && node.get(N('Type')) !== N('Page')) kids.asArray().forEach((k) => walk(k, here, depth + 1));
      else if (ref instanceof L.PDFRef) out.push({ ref, node, inherited: here });
    };
    walk(cat.get(N('Pages')), {}, 0);
    return out;
  }

  // ── Sinks ─────────────────────────────────────────
  // write(part) takes Uint8Array or Blob parts; small byte parts are gathered into 1 MB chunks.
  function chunker(put) {
    let buf = new Uint8Array(WINDOW), n = 0;
    const flush = async () => { if (n) { const c = buf.slice(0, n); n = 0; await put(c); } };
    return {
      async write(part) {
        if (part instanceof Blob) { await flush(); if (part.size) await put(part); return; }
        if (part.length > WINDOW / 4) { await flush(); await put(part.slice()); return; }
        if (n + part.length > buf.length) await flush();
        buf.set(part, n); n += part.length;
      },
      flush,
    };
  }
  function blobSink(type) {
    const parts = [];
    const c = chunker(async (p) => { parts.push(p instanceof Blob ? p : new Blob([p])); });
    let size = 0;
    return {
      kind: 'memory',
      get size() { return size; },
      async write(p) { size += p instanceof Blob ? p.size : p.length; await c.write(p); },
      async close() { await c.flush(); return new Blob(parts, { type: type || 'application/pdf' }); },
      async abort() { parts.length = 0; },
    };
  }
  // handle: a FileSystemFileHandle from showSaveFilePicker()
  async function fileSink(handle) {
    const w = await handle.createWritable();
    const c = chunker((p) => w.write(p));
    let size = 0;
    return {
      kind: 'file',
      name: handle.name,
      get size() { return size; },
      async write(p) { size += p instanceof Blob ? p.size : p.length; await c.write(p); },
      async close() { await c.flush(); await w.close(); return handle.getFile(); },
      async abort() { try { await w.abort(); } catch (e) { /* already closed */ } },
    };
  }
  const canSaveToDisk = () => typeof root.showSaveFilePicker === 'function';
  // Ask where to save (must run in a click handler). null = cancelled, or the API isn't there.
  async function pickSaveFile(suggestedName, desc, mime, ext) {
    if (!canSaveToDisk()) return null;
    try {
      return await root.showSaveFilePicker({ suggestedName, types: [{ description: desc, accept: { [mime]: [ext] } }] });
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      throw e;
    }
  }

  // ── Writing a PDF ─────────────────────────────────
  async function deflate(bytes) {
    const cs = new CompressionStream('deflate');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  }
  const serialize = (obj) => { const b = new Uint8Array(obj.sizeInBytes()); obj.copyBytesInto(b, 0); return b; };

  // w = writer(sink, L, { firstFree }); await w.start(); await w.put(ref, obj, data?) …; await w.finish({ root, info })
  // obj: any pdf-lib object. For a PDFRawStream, data = Uint8Array | Blob (default: its contents); /Length is set here.
  function writer(sink, L, opts) {
    const o = Object.assign({ objectStreams: true, group: 100 }, opts || {});
    const N = (k) => L.PDFName.of(k);
    const ctx = L.PDFContext.create();
    const offsets = new Map();                // num → { off, gen } | { stm, idx }
    let pos = 0, next = o.firstFree || 1, group = [];
    const write = async (p) => { await sink.write(p); pos += p instanceof Blob ? p.size : p.length; };
    const alloc = () => L.PDFRef.of(next++, 0);
    const seenNum = (n) => { if (n >= next) next = n + 1; };
    async function rawObject(num, gen, obj, data) {
      offsets.set(num, { off: pos, gen });
      if (obj instanceof L.PDFRawStream || data !== undefined) {
        const dict = obj instanceof L.PDFRawStream ? obj.dict : obj;
        const body = data !== undefined ? data : obj.contents;
        dict.set(N('Length'), L.PDFNumber.of(body instanceof Blob ? body.size : body.length));
        await write(ascii(`${num} ${gen} obj\n`));
        await write(serialize(dict));
        await write(ascii('\nstream\n'));
        await write(body);
        await write(ascii('\nendstream\nendobj\n'));
      } else {
        await write(ascii(`${num} ${gen} obj\n`));
        await write(serialize(obj));
        await write(ascii('\nendobj\n'));
      }
    }
    async function flushGroup() {
      if (!group.length) return;
      const items = group; group = [];
      const ref = alloc();
      let header = '', o2 = 0;
      const bodies = items.map((it, i) => { header += `${it.num} ${o2} `; o2 += it.bytes.length + 1; offsets.set(it.num, { stm: ref.objectNumber, idx: i }); return it.bytes; });
      const head = ascii(header);
      const all = new Uint8Array(head.length + o2);
      all.set(head, 0);
      let at = head.length;
      for (const b of bodies) { all.set(b, at); at += b.length; all[at++] = 10; }
      const dict = ctx.obj({ Type: 'ObjStm', N: items.length, First: head.length, Filter: 'FlateDecode' });
      await rawObject(ref.objectNumber, 0, dict, await deflate(all));
    }
    return {
      alloc,
      get size() { return pos; },
      async start() { await write(ascii('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')); },
      async put(ref, obj, data) {
        seenNum(ref.objectNumber + 1);
        if (obj instanceof L.PDFRawStream || data !== undefined || !o.objectStreams || ref.generationNumber !== 0) {
          await rawObject(ref.objectNumber, ref.generationNumber, obj, data);
        } else {
          group.push({ num: ref.objectNumber, bytes: serialize(obj) });
          if (group.length >= o.group) await flushGroup();
        }
      },
      async finish({ root: rootRef, info }) {
        await flushGroup();
        const self = alloc(), size = next;
        const xoff = pos;
        offsets.set(self.objectNumber, { off: xoff, gen: 0 });
        const ob = Math.max(4, Math.ceil(Math.log2(xoff + 2) / 8));
        const row = 1 + ob + 2, table = new Uint8Array(size * row);
        for (let n = 0; n < size; n++) {
          const e = offsets.get(n), at = n * row;
          let type = 0, f2 = 0, f3 = n === 0 ? 65535 : 0;
          if (e && e.off != null) { type = 1; f2 = e.off; f3 = e.gen; } else if (e) { type = 2; f2 = e.stm; f3 = e.idx; }
          table[at] = type;
          for (let k = ob - 1, v = f2; k >= 0; k--) { table[at + 1 + k] = v % 256; v = Math.floor(v / 256); }
          table[at + 1 + ob] = (f3 >> 8) & 255; table[at + 2 + ob] = f3 & 255;
        }
        const dict = ctx.obj({ Type: 'XRef', Size: size, W: [1, ob, 2], Root: rootRef, Filter: 'FlateDecode' });
        if (info) dict.set(N('Info'), info);
        await rawObject(self.objectNumber, 0, dict, await deflate(table));
        await write(ascii(`startxref\n${xoff}\n%%EOF\n`));
      },
    };
  }

  // Copy a whole lazy document to a writer: every object, in object-number order. transform(ref, obj) may return
  // { obj, data } to replace an object (data: new stream bytes), or null to keep it. Stream data that is not
  // replaced is passed on as a slice of the original file.
  async function copyAll(doc, w, transform, onProgress) {
    const N = (k) => doc.L.PDFName.of(k);
    const all = [...doc.ctx.enumerateIndirectObjects()].sort((a, b) => a[0].objectNumber - b[0].objectNumber)
      .filter(([, obj]) => !(obj instanceof doc.L.PDFRawStream && [N('ObjStm'), N('XRef')].includes(obj.dict.get(N('Type')))));
    for (let i = 0; i < all.length; i++) {
      const [ref, obj] = all[i];
      const t = transform ? await transform(ref, obj) : null;
      if (t) await w.put(ref, t.obj, t.data);
      else if (obj instanceof doc.L.PDFRawStream) await w.put(ref, obj, sliceOf(doc, obj) || obj.contents);
      else await w.put(ref, obj);
      if (onProgress && i % 200 === 199) { onProgress(i / all.length); await yieldUI(); }
    }
  }

  // ── pdf.js reading ranges of the file ───────────────
  // pdf.js asks for the bytes it needs (fonts, one page's contents and images…); nothing is copied up front.
  function openPdfjs(pdfjs, file, options) {
    class SliceTransport extends pdfjs.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        file.slice(begin, end).arrayBuffer().then((b) => this.onDataRange(begin, new Uint8Array(b)), () => this.onDataRange(begin, new Uint8Array(end - begin)));
      }
    }
    const transport = new SliceTransport(file.size, new Uint8Array(0));
    return pdfjs.getDocument(Object.assign({}, options, { data: undefined, range: transport, length: file.size,
      rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true }));
  }
  // Pages one after another; the document is reopened every `batch` pages, so pdf.js never keeps more than
  // about one batch of the file in memory. getPage(n) must be called with n rising.
  function pagedPdfjs(pdfjs, file, options, batch) {
    let doc = null, from = 0, numPages = 0;
    const B = batch || 20;
    return {
      async open() { doc = await openPdfjs(pdfjs, file, options).promise; numPages = doc.numPages; from = 1; return numPages; },
      get numPages() { return numPages; },
      async getPage(n) {
        if (!doc || n >= from + B || n < from) { if (doc) await doc.destroy(); doc = await openPdfjs(pdfjs, file, options).promise; from = n; }
        return doc.getPage(n);
      },
      async close() { if (doc) { const d = doc; doc = null; await d.destroy(); } },
    };
  }

  // ── ZIP, stored (images are already compressed) ─────
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  async function crc32(blob) {
    let c = 0xFFFFFFFF;
    for (let at = 0; at < blob.size; at += 8 * WINDOW) {
      const b = new Uint8Array(await blob.slice(at, at + 8 * WINDOW).arrayBuffer());
      for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const ZIP_MAX = 0xFFFFFFFF - (64 << 20);     // no ZIP64: the whole archive stays under 4 GB
  function zipWriter(sink) {
    const dir = [];
    let pos = 0;
    const le = (n, b) => { const a = new Uint8Array(b); for (let i = 0; i < b; i++) { a[i] = n & 255; n = Math.floor(n / 256); } return a; };
    const cat = (...a) => { const out = new Uint8Array(a.reduce((t, x) => t + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
    const put = async (p) => { await sink.write(p); pos += p instanceof Blob ? p.size : p.length; };
    return {
      get size() { return pos; },
      async add(name, blob) {
        const nm = new TextEncoder().encode(name), crc = await crc32(blob);
        if (pos + blob.size + 2 * nm.length + 200 + dir.length * 100 > ZIP_MAX) throw new StreamError('too_large', 'zip over 4 GB');
        dir.push({ nm, crc, size: blob.size, off: pos });
        await put(cat(le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 4), le(crc, 4), le(blob.size, 4), le(blob.size, 4), le(nm.length, 2), le(0, 2), nm));
        await put(blob);
      },
      async finish() {
        const start = pos;
        for (const e of dir) {
          await put(cat(le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 4), le(e.crc, 4), le(e.size, 4), le(e.size, 4),
            le(e.nm.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(e.off, 4), e.nm));
        }
        await put(cat(le(0x06054b50, 4), le(0, 2), le(0, 2), le(dir.length, 2), le(dir.length, 2), le(pos - start, 4), le(start, 4), le(0, 2)));
      },
    };
  }

  const api = { StreamError, Reader, open, fromPdfLib, bytesOf, sizeOf, sliceOf, pages, writer, copyAll, blobSink, fileSink, canSaveToDisk, pickSaveFile,
    openPdfjs, pagedPdfjs, zipWriter, crc32, deflate, latin1, ascii, ZIP_MAX };
  root.PFStream = api;
})(typeof window !== 'undefined' ? window : globalThis);
