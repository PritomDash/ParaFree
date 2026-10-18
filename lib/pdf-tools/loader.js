// ═══════════════════════════════════════════════════
// ParaFree PDF tools — library loader (lib/pdf-tools/loader.js)
// Every library comes from cdn.jsdelivr.net at an EXACT pinned version and is loaded only
// when a tab (or a step such as OCR) needs it. Nothing here sends files anywhere: the
// libraries run in this browser tab (pdf.js and Tesseract in their own Web Workers).
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const V = {
    pdfLib:      'pdf-lib@1.17.1',
    pdfjs:       'pdfjs-dist@4.10.38',
    docx:        'docx@9.5.1',
    docxPreview: 'docx-preview@0.3.6',
    jszip:       'jszip@3.10.1',
    jspdf:       'jspdf@4.2.1',
    notoSans:    '@expo-google-fonts/noto-sans@0.4.2',
    notoSerif:   '@expo-google-fonts/noto-serif@0.4.2',
    notoMono:    '@expo-google-fonts/noto-sans-mono@0.4.2',
    tesseract:   'tesseract.js@5.1.1',
    tessCore:    'tesseract.js-core@5.1.1',
    tessEng:     '@tesseract.js-data/eng@1.0.0',
  };
  const URLS = {
    pdfLib:      CDN + V.pdfLib + '/dist/pdf-lib.min.js',
    pdfjs:       CDN + V.pdfjs + '/build/pdf.min.mjs',
    pdfjsWorker: CDN + V.pdfjs + '/build/pdf.worker.min.mjs',
    pdfjsCMaps:  CDN + V.pdfjs + '/cmaps/',
    pdfjsFonts:  CDN + V.pdfjs + '/standard_fonts/',
    docx:        CDN + V.docx + '/dist/index.iife.js',
    docxPreview: CDN + V.docxPreview + '/dist/docx-preview.min.js',
    jszip:       CDN + V.jszip + '/dist/jszip.min.js',
    jspdf:       CDN + V.jspdf + '/dist/jspdf.umd.min.js',
    notoSans:    CDN + V.notoSans + '/',
    notoSerif:   CDN + V.notoSerif + '/',
    notoMono:    CDN + V.notoMono + '/',
    tesseract:   CDN + V.tesseract + '/dist/tesseract.min.js',
    tessWorker:  CDN + V.tesseract + '/dist/worker.min.js',
    tessCore:    CDN + V.tessCore,
    tessLang:    CDN + V.tessEng + '/4.0.0_best_int',
  };

  const cache = {};

  // Classic script → the global it defines. docx and docx-preview both use window.docx, so
  // the global is captured and the previous value restored.
  function script(key, globalName) {
    if (cache[key]) return cache[key];
    cache[key] = new Promise((resolve, reject) => {
      const prev = window[globalName];
      const s = document.createElement('script');
      s.src = URLS[key];
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        const lib = window[globalName];
        if (globalName === 'docx') window[globalName] = prev;
        lib ? resolve(lib) : reject(new Error('Library did not load: ' + key));
      };
      s.onerror = () => { delete cache[key]; reject(new Error('Could not load ' + key + ' — check your connection.')); };
      document.head.appendChild(s);
    });
    return cache[key];
  }

  const PFLoad = {
    VERSIONS: V,
    URLS,
    pdfLib: () => script('pdfLib', 'PDFLib'),
    pdfjs: () => {
      if (!cache.pdfjs) {
        cache.pdfjs = import(URLS.pdfjs).then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = URLS.pdfjsWorker;   // pdf.js runs parsing in a Web Worker
          return lib;
        }, (e) => { delete cache.pdfjs; throw e; });
      }
      return cache.pdfjs;
    },
    docx: () => script('docx', 'docx'),
    docxPreview: () => script('jszip', 'JSZip').then(() => script('docxPreview', 'docx')),
    jspdf: () => script('jspdf', 'jspdf'),
    tesseract: () => script('tesseract', 'Tesseract'),
    // Shared options for pdf.js getDocument (no eval, fonts/cmaps from the same pinned CDN).
    pdfjsOptions: (data) => ({
      data, isEvalSupported: false, cMapUrl: URLS.pdfjsCMaps, cMapPacked: true, standardFontDataUrl: URLS.pdfjsFonts,
    }),
  };

  window.PFLoad = PFLoad;
})();
