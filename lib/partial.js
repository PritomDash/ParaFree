// ═══════════════════════════════════════════════════
// ParaFree — parts the AI could not paraphrase (lib/partial.js)
// The backend returns `failedParts` when a part of a document still failed after every provider:
// that part's ORIGINAL text is in the result unchanged. This module keeps the list, marks those paragraphs in the
// output (<mark class="pf-unchanged">), shows "N part(s) couldn't be paraphrased" with ONE manual "Retry" button (nothing is ever re-sent on its own), and splices a
// successful retry back into the raw result. It is never silent: an unchanged part is always marked and announced.
// Loaded by index.html (window.PFPartial) and by node tests (module.exports). No network calls here.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';
  let parts = [];        // [{ text }] — text exactly as it sits in the raw result
  let busy = false;      // a manual retry is running: the button is disabled, so two retries never run at once

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

  // ONE manual button: "Retry" sends the failed parts again, one at a time (never on its own, never in parallel).
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
      : ' — shown with the original text and highlighted below. Retry to try again.');
    box.appendChild(msg);
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pf-retry-part';
    b.textContent = 'Retry';
    b.disabled = busy;
    b.addEventListener('click', async () => {
      if (busy) return;
      busy = true; b.disabled = true; b.textContent = 'Retrying…';
      let ok = true;
      try {
        if (opts.wholeDoc) ok = !!(await opts.onRetry(-1));
        else for (const p of parts.slice()) {
          const i = parts.indexOf(p);
          if (i < 0) continue;
          let done = false;
          try { done = await opts.onRetry(i); } catch (e) { done = false; }
          ok = ok && !!done;
        }
      } catch (e) { ok = false; }
      finally { busy = false; }
      const now = doc.getElementById('pfPartialNotice');
      const btn = now && now.querySelector('.pf-retry-part');
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
      if (!ok && now) { const m = now.querySelector('p'); if (m) m.textContent = 'Still couldn’t paraphrase ' + (parts.length === 1 ? 'this part' : 'these parts') + ' — please try again in a minute.'; }
    });
    box.appendChild(b);
    const before = opts.before || doc.getElementById('outputText');
    if (before && before.parentNode) before.parentNode.insertBefore(box, before);
    return box;
  }

  const isBusy = () => busy;
  const api = { reset, add, list, remove, markHtml, splice, showNotice, isBusy, paragraphs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PFPartial = api;
})(typeof window !== 'undefined' ? window : globalThis);
