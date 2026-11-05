// ═══════════════════════════════════════════════════
// ParaFree — parts the AI could not paraphrase (lib/partial.js)
// The backend returns `failedParts` when a part of a document still failed after every provider and one split:
// that part's ORIGINAL text is in the result unchanged. This module keeps the list, marks those paragraphs in the
// output (<mark class="pf-unchanged">), shows "N part(s) couldn't be paraphrased — Retry this part", and splices a
// successful retry back into the raw result. It is never silent: an unchanged part is always marked and announced.
// Loaded by index.html (window.PFPartial) and by node tests (module.exports). No network calls here.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';
  let parts = [];        // [{ text }] — text exactly as it sits in the raw result

  const paragraphs = (t) => String(t).replace(/^<<<\d+>>>\s*/gm, '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => (p.match(/\S+/g) || []).length >= 3);

  function reset() { parts = []; const n = root.document && root.document.getElementById('pfPartialNotice'); if (n) n.remove(); }
  function add(list) { (list || []).forEach((p) => { if (p && typeof p.text === 'string' && p.text.trim()) parts.push({ text: p.text }); }); }
  function list() { return parts.slice(); }
  function remove(i) { parts.splice(i, 1); }

  // Wrap the first occurrence of each unchanged paragraph (already HTML-escaped by the page) in <mark>.
  function markHtml(html, escape) {
    if (!parts.length) return html;
    let out = html;
    for (const p of parts) for (const para of paragraphs(p.text)) {
      const e = escape(para);
      const at = out.indexOf(e);
      if (at >= 0) {
        out = out.slice(0, at) + '<mark class="pf-unchanged" title="Not paraphrased — this part kept its original text">' + e + '</mark>' + out.slice(at + e.length);
      }
    }
    return out;
  }

  // Replace the first occurrence of `oldText` in `raw` with `newText` → new string, or null if it isn't there.
  function splice(raw, oldText, newText) {
    const at = String(raw).indexOf(oldText);
    if (at < 0) return null;
    return raw.slice(0, at) + String(newText).trim() + raw.slice(at + oldText.length);
  }

  const label = (n) => n === 1 ? '1 part couldn’t be paraphrased' : n + ' parts couldn’t be paraphrased';

  // opts: { onRetry(i) → Promise<boolean>, before: element the notice goes above, wholeDoc: true when only a full re-run is possible }
  function showNotice(opts) {
    const doc = root.document;
    if (!doc) return null;
    const old = doc.getElementById('pfPartialNotice');
    if (old) old.remove();
    if (!parts.length) return null;
    const box = doc.createElement('div');
    box.id = 'pfPartialNotice';
    box.className = 'pf-partial';
    box.setAttribute('role', 'status');
    const msg = doc.createElement('p');
    msg.textContent = label(parts.length) + (opts.wholeDoc
      ? ' — those parts keep their original text. Retry to try them again.'
      : ' — it is shown unchanged and highlighted below. Retry to try it again.');
    box.appendChild(msg);
    const n = opts.wholeDoc ? 1 : parts.length;
    for (let i = 0; i < n; i++) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'pf-retry-part';
      b.textContent = n === 1 ? 'Retry this part' : 'Retry part ' + (i + 1);
      b.addEventListener('click', async () => {
        b.disabled = true;
        const was = b.textContent;
        b.textContent = 'Retrying…';
        let ok = false;
        try { ok = await opts.onRetry(opts.wholeDoc ? -1 : i); } catch (e) { ok = false; }
        if (!ok && b.isConnected) { b.disabled = false; b.textContent = was; msg.textContent = 'Still couldn’t paraphrase this part — please try again in a minute.'; }
      });
      box.appendChild(b);
    }
    const before = opts.before || doc.getElementById('outputText');
    if (before && before.parentNode) before.parentNode.insertBefore(box, before);
    return box;
  }

  const api = { reset, add, list, remove, markHtml, splice, showNotice, paragraphs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PFPartial = api;
})(typeof window !== 'undefined' ? window : globalThis);
