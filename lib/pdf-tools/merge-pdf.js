// ═══════════════════════════════════════════════════
// ParaFree PDF tools — Merge PDF (lib/pdf-tools/merge-pdf.js)
// Several PDFs → one, in the order shown. Each file is read in slices (lib/pdf-tools/pdf-stream.js):
// its pages and everything they use are copied object by object, renumbered, into the new PDF, and
// image and page data go straight from the original file to the result without being read into
// memory — so the size of the files hardly matters. For large inputs in Chrome/Edge the result is
// written to a file the user picks. Runs in this tab; the files are never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'merge_pdf';
  const C = window.PFC;
  const MAX_PAGES = 2000;                    // pages in one merged PDF
  const MEMORY_FALLBACK = 200 * 1000 * 1000; // a PDF the slice reader can't follow is loaded whole only up to this size
  let nextId = 1;

  // A PDF, read in slices; or (damaged structure, not too big) loaded whole by pdf-lib.
  async function openPdf(f) {
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    try { return await S.open(f, L); }
    catch (e) {
      if (!(e instanceof S.StreamError) || e.type !== 'damaged' || f.size > MEMORY_FALLBACK) throw e;
      return S.fromPdfLib(await L.PDFDocument.load(new Uint8Array(await f.arrayBuffer()), { updateMetadata: false }), L);
    }
  }

  // Write every page of each document to the writer, with what the pages use. → page refs, in order
  async function copyPages(docs, w, pagesRef, onDoc) {
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    const N = (k) => L.PDFName.of(k), out = L.PDFContext.create(), kids = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (onDoc) onDoc(i);
      const pages = S.pages(doc), map = new Map(), queue = [];
      for (const pg of pages) map.set(pg.ref.tag, w.alloc());
      const isPageTree = (o) => o instanceof L.PDFDict && (o.get(N('Type')) === N('Pages') || o.get(N('Type')) === N('Page'));
      const remap = (v) => {
        if (v instanceof L.PDFRef) {
          let n = map.get(v.tag);
          if (!n) {
            const o = doc.ctx.lookup(v);
            if (o === undefined || isPageTree(o)) return L.PDFNull;       // never pull in another page tree
            n = w.alloc(); map.set(v.tag, n); queue.push([v, n]);
          }
          return n;
        }
        if (v instanceof L.PDFDict) { const d = L.PDFDict.withContext(out); for (const [k, x] of v.entries()) d.set(k, remap(x)); return d; }
        if (v instanceof L.PDFArray) { const a = L.PDFArray.withContext(out); for (const x of v.asArray()) a.push(remap(x)); return a; }
        return v;
      };
      for (const pg of pages) {
        const d = L.PDFDict.withContext(out);
        for (const [k, x] of pg.node.entries()) if (k !== N('Parent')) d.set(k, remap(x));
        for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (!pg.node.get(N(k)) && pg.inherited[k]) d.set(N(k), remap(pg.inherited[k]));
        if (!d.get(N('MediaBox'))) d.set(N('MediaBox'), out.obj([0, 0, 612, 792]));
        d.set(N('Parent'), pagesRef);
        const ref = map.get(pg.ref.tag);
        await w.put(ref, d);
        kids.push(ref);
        while (queue.length) {                                  // everything this page uses, one object at a time
          const [old, nref] = queue.shift();
          const o = doc.ctx.lookup(old);
          if (o instanceof L.PDFRawStream) await w.put(nref, remap(o.dict), S.sliceOf(doc, o) || o.contents);
          else await w.put(nref, remap(o));
        }
        await C.yieldUI();
      }
    }
    return kids;
  }

  async function mergeTo(docs, sink, onDoc) {
    const L = await window.PFLoad.pdfLib(), S = window.PFStream;
    const w = S.writer(sink, L), out = L.PDFContext.create();
    await w.start();
    const pagesRef = w.alloc();
    const kids = await copyPages(docs, w, pagesRef, onDoc);
    await w.put(pagesRef, out.obj({ Type: 'Pages', Kids: kids, Count: kids.length }));
    const cat = w.alloc();
    await w.put(cat, out.obj({ Type: 'Catalog', Pages: pagesRef }));
    await w.finish({ root: cat });
    return kids.length;
  }

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const go = C.q(panel, 'go');
    const count = C.q(panel, 'count');
    const dl = C.q(panel, 'dl-pdf');
    let run = 0, outBlob = null, adding = Promise.resolve();

    const list = C.sortableList(C.q(panel, 'list'), {
      renderItem(item) {
        const d = document.createElement('div');
        d.className = 'pf-item-main';
        d.innerHTML = '<span class="pf-file-icon" aria-hidden="true">PDF</span><span class="pf-item-name"></span><span class="pf-item-meta"></span>';
        d.querySelector('.pf-item-name').textContent = item.name;
        d.querySelector('.pf-item-meta').textContent = `${item.pages} page${item.pages === 1 ? '' : 's'}`;
        return d;
      },
      onChange(items) {
        outBlob = null;                                         // any change to the list invalidates the PDF
        const pages = items.reduce((s, x) => s + x.pages, 0);
        go.disabled = items.length < 2;
        count.textContent = items.length
          ? `${items.length} file${items.length === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'} in total` + (items.length < 2 ? ' · add at least one more PDF' : ' · drag or use ↑ ↓ to change the order')
          : '';
        C.bigNote(panel, items.reduce((s, x) => s + x.file.size, 0));
        result.hidden = true;
      },
    });

    async function addFiles(files) {
      const me = run;
      C.clearError(panel);
      result.hidden = true;
      outBlob = null;                                           // a new upload clears the previous result
      await window.PFLoad.pdfLib();
      const problems = [];
      let errType = null;
      try { C.checkSizes(list.items.map((x) => x.file).concat(files), 'merge-pdf'); }
      catch (e) { C.showError(panel, e); if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type); return; }
      const added = [];
      for (const f of files) {
        if (!C.isPdfFile(f)) { problems.push(`"${f.name}" isn't a PDF.`); errType = errType || 'unsupported'; continue; }
        try {
          if (f.size > C.LIMITS.bigFile) P.set(0.1, `Reading ${f.name}…`);
          const doc = await openPdf(f);
          added.push({ id: nextId++, file: f, name: f.name, doc, pages: window.PFStream.pages(doc).length, dispose() { this.doc = null; } });
        } catch (e) {
          if (C.isEncryptedError(e) || e.type === 'encrypted') { problems.push(C.encryptedError(f.name).message); errType = 'encrypted'; }
          else { problems.push(`"${f.name}" could not be read as a PDF. It may be damaged.`); errType = errType || 'file_error'; }
        }
        await C.yieldUI();
      }
      P.hide();
      if (me !== run) return;                                   // "Start over" / tab switch while reading
      if (added.length) list.add(added);
      if (problems.length) {
        C.showError(panel, new C.ToolError(errType, problems.join(' ')));
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, errType);
      }
    }

    async function merge() {
      const me = ++run;
      const items = list.items.slice();
      C.clearError(panel);
      result.hidden = true;
      dl.hidden = false;
      go.disabled = true;
      let dest = null;
      try {
        const total = items.reduce((s, x) => s + x.pages, 0);
        if (total > MAX_PAGES) throw new C.ToolError('too_many_pages', `These PDFs have ${total} pages together. This tool handles up to ${MAX_PAGES} pages at a time — try merging fewer files.`);
        dest = await C.outputSink(items.reduce((s, x) => s + x.file.size, 0), 'merged.pdf');   // from the click
        if (me !== run) { await dest.sink.abort(); return; }
        await mergeTo(items.map((x) => x.doc), dest.sink, (i) => {
          if (me === run) P.set(i / items.length, `Adding ${i + 1} of ${items.length}: ${items[i].name}`);
        });
        P.set(0.98, 'Saving…');
        const blob = await dest.sink.close();
        if (me !== run) return;
        outBlob = dest.toDisk ? null : blob;
        const s = C.q(panel, 'summary');
        s.textContent = `Merged ${items.length} files into one PDF: ${total} pages, ${C.fmtBytes(blob.size)}.` + (dest.toDisk ? ` Saved to your computer as “${dest.sink.name}”.` : '');
        dl.hidden = dest.toDisk;
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
        if (dest) await dest.sink.abort();
        if (me !== run) return;
        const err = C.toToolError(e);
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      } finally {
        if (me === run) { P.hide(); go.disabled = list.items.length < 2; }
      }
    }

    C.setupDrop(panel, (files) => { adding = adding.then(() => addFiles(files)).catch((e) => C.showError(panel, C.toToolError(e))); });
    go.addEventListener('click', merge);
    dl.addEventListener('click', () => {
      if (!outBlob) return;
      C.download(outBlob, 'merged.pdf');
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
  window.PFTools['merge-pdf'] = { libs: () => Promise.all([window.PFLoad.pdfLib(), C.loadModule('pdf-stream')]), init, _internals: { mergeTo, openPdf, MAX_PAGES } };
})();
