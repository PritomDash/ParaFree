// ═══════════════════════════════════════════════════
// ParaFree PDF tools — Word to PDF (lib/pdf-tools/word-to-pdf.js)
// .docx → docx-preview renders it into the editable output box → jsPDF .html() builds a PDF
// with selectable text from the (possibly edited) box. "Print / Save as PDF" is the fallback.
// Runs in this tab; the file is never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'word_to_pdf';
  const C = window.PFC;

  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const box = C.editableOutput(panel, TOOL);
    const styles = C.q(panel, 'styles');
    let run = 0, fileBase = 'document';

    function reset() {
      run++;
      box.innerHTML = '';
      styles.innerHTML = '';
      result.hidden = true;
      C.clearError(panel);
      P.hide();
      C.q(panel, 'drop').hidden = false;
    }

    async function convert(files) {
      reset();
      const me = run;
      const f = files[0];
      try {
        const ext = C.extOf(f.name);
        if (ext === 'doc') throw new C.ToolError('unsupported', 'Please save as .docx first — open the file in Word, choose File → Save As → Word Document (.docx), then upload that.');
        if (ext !== 'docx') throw new C.ToolError('unsupported', 'Please choose a Word file (.docx). For PDFs, use the PDF to Word tab.');
        C.checkSizes([f]);
        fileBase = C.baseName(f.name);
        C.q(panel, 'drop').hidden = true;
        P.set(0.1, 'Loading Word reader…');
        const dp = await window.PFLoad.docxPreview();
        const buf = await f.arrayBuffer();
        const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
        if (head[0] !== 0x50 || head[1] !== 0x4b) throw new C.ToolError('file_error', `"${f.name}" doesn't look like a valid .docx file. Try opening it in Word and saving it again.`);
        if (me !== run) return;
        P.set(0.4, 'Rendering your document…');
        await C.yieldUI();
        try {
          await dp.renderAsync(new Blob([buf]), box, styles, {
            className: 'docx', inWrapper: false, ignoreWidth: false, ignoreHeight: false, breakPages: true,
            renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
            useBase64URL: true, experimental: false,
          });
        } catch (e) {
          throw new C.ToolError('file_error', `"${f.name}" could not be read as a Word document. It may be damaged — try opening it in Word and saving it again.`);
        }
        if (me !== run) return;
        P.hide();
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'docx');
      } catch (e) {
        if (me !== run) return;
        const err = C.toToolError(e, f && f.name);
        P.hide();
        C.q(panel, 'drop').hidden = false;
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
      }
    }

    C.setupDrop(panel, convert);
    C.q(panel, 'start-over').addEventListener('click', reset);

    C.q(panel, 'dl-pdf').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const blob = await C.documentPdf(panel, box, (f, t) => P.set(f, t));
        if (blob) C.download(blob, fileBase + '-converted.pdf');
        if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
      } catch (err) {
        const te = C.toToolError(err);
        C.showError(panel, te);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, te.type);
      } finally { btn.disabled = false; P.hide(); }
    });

    C.q(panel, 'print').addEventListener('click', () => C.printElement(box, { complex: window.PFPdfWriter.hasComplexScript(box.textContent) }));
    return { reset };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['word-to-pdf'] = { libs: () => window.PFLoad.docxPreview(), init };
})();
