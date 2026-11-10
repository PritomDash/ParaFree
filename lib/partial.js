// ═══════════════════════════════════════════════════
// ParaFree — parts the AI could not paraphrase (lib/partial.js)
// The backend returns `failedParts` ONLY when no provider answered for a part (error / timeout / empty answer): that
// part's ORIGINAL text is in the result. Nothing here ever decides a part failed by comparing output with input —
// headings, short questions, short lines, citations, URLs and code are skipped on purpose and come back as they are.
// This module keeps the server's list, retries each failed part ONCE automatically (~3 s later, silently —
// "Finishing…"), marks what still failed in the output (<mark class="pf-unchanged">, prose lines only) and shows a small
// note with no button: "This part couldn't be paraphrased right now — run Paraphrase again to retry."
// Never more than one automatic retry per run, never the whole document. No network calls here.
// Loaded by index.html (window.PFPartial) and by node tests (module.exports).
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';
  let parts = [];        // [{ text }] — text exactly as it sits in the raw result (from the server's failedParts)
  let autoRanFor = null; // the parts list the one automatic retry already ran on (once per run)

  // Lines that are skipped on purpose — never highlighted, even inside a failed part: headings, short questions,
  // lines under ~8 words, list labels, citations / references, URLs, code, numbers-only lines, masked links.
  function skipLike(line) {
    const s = String(line).trim();
    const w = (s.match(/\S+/g) || []).length;
    if (w < 8) return true;
    if (/^#{1,6}\s/.test(s) || /^[^.!?]{0,120}\?$/.test(s) && w <= 15) return true;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(s) || /^\[\d{1,3}\]\s/.test(s) || /^\p{Lu}[\p{L}'’-]+,\s+(?:\p{Lu}\.\s*)+.*\((?:1[6-9]|20)\d{2}[a-z]?\)/u.test(s)) return true;
    if (/[{};]\s*$|^\s*(?:const|let|var|function|def|import|return|class|if|for|while)\b.*[=({:]/.test(s) || /`/.test(s)) return true;
    if (!/\p{L}/u.test(s) || /^(?:⟦L\d+⟧\s*)+$/.test(s)) return true;
    return false;
  }
  const paragraphs = (t) => String(t).replace(/^<<<\d+>>>\s*/gm, '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !skipLike(p));

  function reset() { parts = []; autoRanFor = null; const n = root.document && root.document.getElementById('pfPartialNotice'); if (n) n.remove(); }
  function add(list) { (list || []).forEach((p) => { if (p && typeof p.text === 'string' && p.text.trim()) parts.push({ text: p.text }); }); }
  function list() { return parts.slice(); }
  function remove(i) { parts.splice(i, 1); }

  // Mark the prose paragraphs of each failed part (already HTML-escaped by the page), searched from where that part
  // sits — never an identical line somewhere else in the document (a heading or citation repeated in a good part).
  function markHtml(html, escape) {
    if (!parts.length) return html;
    let out = html;
    for (const p of parts) {
      const all = String(p.text).replace(/^<<<\d+>>>\s*/gm, '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
      if (!all.length) continue;
      let from = out.indexOf(escape(all[0]));
      if (from < 0) continue;
      for (const para of all) {
        const e = escape(para);
        const at = out.indexOf(e, from);
        if (at < 0) continue;
        from = at + e.length;
        if (skipLike(para)) continue;
        const m = '<mark class="pf-unchanged" title="Not paraphrased — this part kept its original text">' + e + '</mark>';
        out = out.slice(0, at) + m + out.slice(at + e.length);
        from = at + m.length;
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

  // ONE automatic retry per failed part, ~3 s after the run, one part at a time. onRetry(i) re-sends ONLY part i and
  // removes it when it works; onStatus(n, total) shows "Finishing…". A new run (reset) stops it. Resolves when done.
  const AUTO_WAIT = 3000;
  async function autoRetryOnce(onRetry, opts = {}) {
    const wait = opts.wait != null ? opts.wait : (root.PF_AUTO_RETRY_WAIT != null ? root.PF_AUTO_RETRY_WAIT : AUTO_WAIT);
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const run = parts;    // reset() swaps in a new array: a new run stops this one
    if (autoRanFor === run || !run.length) return;
    autoRanFor = run;
    const todo = parts.slice();
    for (let k = 0; k < todo.length; k++) {
      if (opts.onStatus) opts.onStatus(k + 1, todo.length);
      await sleep(wait);
      const i = parts.indexOf(todo[k]);
      if (parts !== run || i < 0) continue;
      try { await onRetry(i); } catch (_) {}
    }
  }
  const autoRan = () => autoRanFor === parts;

  // The note for parts that still failed after the one automatic retry — no button.
  const noteText = (n) => (n === 1 ? 'This part' : 'These ' + n + ' parts') + ' couldn’t be paraphrased right now — run Paraphrase again to retry.';
  function showNote(opts = {}) {
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
    msg.textContent = noteText(parts.length);
    box.appendChild(msg);
    const before = opts.before || doc.getElementById('outputText');
    if (before && before.parentNode) before.parentNode.insertBefore(box, before);
    return box;
  }

  const api = { reset, add, list, remove, markHtml, splice, autoRetryOnce, autoRan, showNote, noteText, skipLike, paragraphs, AUTO_WAIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PFPartial = api;
})(typeof window !== 'undefined' ? window : globalThis);
