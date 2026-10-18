// ═══════════════════════════════════════════════════
// ParaFree PDF tools — "Paraphrase this document" hand-off (lib/pdf-tools/handoff.js)
// The Word file made by PDF to Word goes to the homepage Paraphraser through its EXISTING upload
// input: the file is put into #fileUpload with DataTransfer and a normal change event is fired,
// so the Paraphraser's own upload handler runs exactly as if the user had chosen the file.
//  - On the homepage (PDF tab): straight away.
//  - From pdf-tools.html: the file is kept in this browser's IndexedDB for up to 10 minutes,
//    then "/?handoff=pdf" opens the homepage, which takes it, deletes it and cleans the URL.
// The file never leaves the device.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const DB = 'parafree-handoff', STORE = 'files', TTL = 10 * 60 * 1000;
  const FALLBACK = 'Download the Word file and upload it here';
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('IndexedDB unavailable'));
    });
  }
  function run(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  async function store(file) {
    const db = await openDb();
    try {
      const ts = Date.now();
      await run(db, 'readwrite', (s) => s.put({ ts, name: file.name, type: file.type || DOCX, blob: file }, 'pdf-' + ts));
    } finally { db.close(); }
  }

  // Newest record younger than 10 minutes; everything in the store is deleted either way.
  async function take() {
    const db = await openDb();
    try {
      const all = (await run(db, 'readonly', (s) => s.getAll())) || [];
      await run(db, 'readwrite', (s) => s.clear());
      const fresh = all.filter((r) => r && r.blob && Date.now() - r.ts < TTL).sort((a, b) => b.ts - a.ts);
      return fresh[0] || null;
    } finally { db.close(); }
  }

  // Homepage: show the Paraphraser and feed the file to its existing upload input.
  function inject(file) {
    const input = document.getElementById('fileUpload');
    if (!input || typeof DataTransfer === 'undefined') throw new Error('upload input not available');
    if (typeof window.pfClosePdfTools === 'function') window.pfClosePdfTools();
    const tab = document.getElementById('tab-paraphrase');
    if (tab && !tab.classList.contains('active') && typeof window.switchTool === 'function') window.switchTool('paraphrase');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const tools = document.getElementById('tools');
    if (tools) tools.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showFallback() {
    let el = document.getElementById('pfHandoffNote');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pfHandoffNote';
      el.setAttribute('role', 'status');
      el.style.cssText = 'max-width:1100px;margin:6px auto 0;padding:0 16px;';
      el.innerHTML = '<div style="background:#fff4e8;border:1px solid #f6cfa6;border-radius:10px;padding:10px 16px;font-size:13px;color:#8a4b12;font-family:\'DM Sans\',sans-serif;"></div>';
      const after = document.getElementById('promoBar') || document.getElementById('tools');
      if (after && after.parentNode) after.parentNode.insertBefore(el, after.nextSibling); else document.body.prepend(el);
    }
    el.firstChild.textContent = FALLBACK;
  }

  const onHomepage = () => !!document.getElementById('fileUpload') && typeof window.pfOpenPdfTools === 'function';

  // From a PDF tools panel: hand the Word file over. Returns 'injected' | 'navigating'.
  async function send(file) {
    if (window.PFPdfEvents) window.PFPdfEvents.handoff('pdf_to_word');
    if (onHomepage()) { inject(file); return 'injected'; }
    await store(file);
    window.location.href = '/?handoff=pdf';
    return 'navigating';
  }

  // Homepage load with ?handoff=pdf: take the stored file, inject it, clean up.
  async function receive() {
    const clean = () => {
      try {
        const params = new URLSearchParams(location.search);
        params.delete('handoff');
        const q = params.toString();
        history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
      } catch (e) { /* leave the URL */ }
    };
    try {
      const rec = await take();
      if (!rec) throw new Error('nothing to hand over (expired or missing)');
      inject(new File([rec.blob], rec.name || 'document.docx', { type: rec.type || DOCX }));
    } catch (e) {
      showFallback();
    } finally {
      clean();
    }
  }

  window.PFHandoff = { send, receive, inject, FALLBACK, _internals: { store, take, TTL } };
})();
