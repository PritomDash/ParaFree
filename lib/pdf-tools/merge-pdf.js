// ═══════════════════════════════════════════════════
// ParaFree PDF tools — Merge PDF (lib/pdf-tools/merge-pdf.js)
// Several PDFs → one, in the order shown, with pdf-lib copyPages.
// Runs in this tab; the files are never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'merge_pdf';
  const C = window.PFC;
  let nextId = 1;

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const go = C.q(panel, 'go');
    const count = C.q(panel, 'count');
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
        const pages = items.reduce((s, x) => s + x.pages, 0);
        go.disabled = items.length < 2;
        count.textContent = items.length
          ? `${items.length} file${items.length === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'} in total` + (items.length < 2 ? ' · add at least one more PDF' : ' · drag or use ↑ ↓ to change the order')
          : '';
        result.hidden = true;
      },
    });

    async function addFiles(files) {
      C.clearError(panel);
      result.hidden = true;
      const L = await window.PFLoad.pdfLib();
      const problems = [];
      let errType = null;
      try { C.checkSizes(list.items.map((x) => x.file).concat(files)); }
      catch (e) { C.showError(panel, e); if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, e.type); return; }
      const added = [];
      for (const f of files) {
        if (!C.isPdfFile(f)) { problems.push(`"${f.name}" isn't a PDF.`); errType = errType || 'unsupported'; continue; }
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
          added.push({ id: nextId++, file: f, name: f.name, bytes, pages: doc.getPageCount(), dispose() { this.bytes = null; } });
        } catch (e) {
          if (C.isEncryptedError(e)) { problems.push(C.encryptedError(f.name).message); errType = 'encrypted'; }
          else { problems.push(`"${f.name}" could not be read as a PDF. It may be damaged.`); errType = errType || 'file_error'; }
        }
        await C.yieldUI();
      }
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
      go.disabled = true;
      try {
        const total = items.reduce((s, x) => s + x.pages, 0);
        if (total > C.LIMITS.pages) throw new C.ToolError('too_many_pages', `These PDFs have ${total} pages together. This tool handles up to ${C.LIMITS.pages} pages at a time — try merging fewer files.`);
        const L = await window.PFLoad.pdfLib();
        const out = await L.PDFDocument.create();
        for (let i = 0; i < items.length; i++) {
          if (me !== run) return;
          P.set(i / items.length, `Adding ${i + 1} of ${items.length}: ${items[i].name}`);
          await C.yieldUI();
          let src;
          try { src = await L.PDFDocument.load(items[i].bytes, { updateMetadata: false }); }
          catch (e) { throw C.isEncryptedError(e) ? C.encryptedError(items[i].name) : C.toToolError(e, items[i].name); }
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        }
        P.set(0.97, 'Saving…');
        const bytes = await out.save({ useObjectStreams: true });
        if (me !== run) return;
        outBlob = new Blob([bytes], { type: 'application/pdf' });
        C.q(panel, 'summary').textContent = `Merged ${items.length} files into one PDF: ${total} pages, ${C.fmtBytes(outBlob.size)}.`;
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
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
    C.q(panel, 'dl-pdf').addEventListener('click', () => {
      if (!outBlob) return;
      C.download(outBlob, 'merged.pdf');
      if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
    });
    C.q(panel, 'start-over').addEventListener('click', () => {
      run++;
      outBlob = null;
      list.clear();
      C.clearError(panel);
      P.hide();
      result.hidden = true;
    });
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['merge-pdf'] = { libs: () => window.PFLoad.pdfLib(), init };
})();
