// ═══════════════════════════════════════════════════
// ParaFree — link, citation & reference protection (lib/protect.js)
// Loaded by index.html (window.PFProtect) and by node tests (module.exports).
//
// Before text goes to the AI (paraphrase, humanize, grammar):
//   • URLs, emails, DOIs and in-text citations are replaced by ⟦L1⟧, ⟦L2⟧ … and
//     restored to the exact original afterwards.
//   • Reference-list entries are not sent at all; a References/Bibliography/…
//     heading and everything after it is split off by the caller (splitReferences)
//     or, for DOCX/PPTX, skipped per paragraph/text box.
//   • If a placeholder comes back missing, duplicated or altered, that paragraph
//     falls back to its ORIGINAL text — a link is never lost.
// Understands the three request shapes index.html sends: plain paragraphs,
// DOCX <<<N>>> marker blocks and PPTX [SLIDEn_BOXm]…[/SLIDEn_BOXm] tags.
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';

  const TOOLS = new Set(['paraphrase', 'humanize', 'grammar']);
  const PROMPT_LINE = 'Keep every ⟦L#⟧ placeholder exactly as written, in place.';
  const TOKEN_RE = /⟦L\d+⟧/g;
  const BRACKET_RE = /[⟦⟧]/;

  // ── Reference headings ──
  const HEADING_WORDS = '(?:references?|reference\\s+list|bibliography|works\\s+cited|sources|citations)';
  // Optional section number ("7.", "IV.") and trailing colon; nothing else on the line.
  const HEADING_LINE = '[ \\t]*(?:(?:\\d+(?:\\.\\d+)*|[IVXLC]+)[.)]?[ \\t]+)?' + HEADING_WORDS + '[ \\t]*:?[ \\t\\r]*';
  const HEADING_RE = new RegExp('^' + HEADING_LINE + '$', 'i');
  const HEADING_START_RE = new RegExp('^' + HEADING_WORDS + '\\s*:?\\s*', 'i');

  // A heading line is only trusted when it is short (≤5 words) AND starts in the last
  // 40% of the document — a mid-document "Sources" section must not cut off the text.
  const HEADING_MAX_WORDS = 5;
  const HEADING_MIN_POSITION = 0.6; // fraction of the document before the heading
  function isRefHeading(t) {
    const s = String(t || '').trim();
    return s.split(/\s+/).length <= HEADING_MAX_WORDS && HEADING_RE.test(s);
  }
  function inLastPart(offset, total) { return total > 0 && offset >= HEADING_MIN_POSITION * total; }

  // Splits pasted/PDF text at the LAST qualifying reference heading line (a table of
  // contents that lists "References" earlier must not swallow the whole document).
  // body + gap + tail === text, byte for byte.
  function splitReferences(text) {
    const re = new RegExp('^' + HEADING_LINE + '$', 'gim');
    let last = null, m;
    while ((m = re.exec(text)) !== null) {
      if (isRefHeading(m[0]) && inLastPart(m.index, text.length)) last = m;
      if (m[0] === '') re.lastIndex++;
    }
    if (!last) return { body: text, gap: '', tail: '' };
    const before = text.slice(0, last.index);
    const body = before.replace(/\s+$/, '');
    return { body, gap: before.slice(body.length), tail: text.slice(last.index) };
  }

  // ── Reference entries (skipped even without a heading) ──
  const NAME = "\\p{Lu}[\\p{L}'’\\-]+";
  const YEAR = '(?:(?:1[6-9]|20)\\d{2}[a-z]?|n\\.d\\.)';
  const NUMBERED_ENTRY_RE = /^\[\d{1,3}\]\s*\S/;
  const APA_START_RE = new RegExp('^' + NAME + ',\\s+(?:\\p{Lu}\\.\\s*)+', 'u');
  const APA_YEAR_RE = new RegExp('\\(' + YEAR + '[^()]{0,25}\\)\\.');
  const HARVARD_RE = new RegExp('^' + NAME + '(?:,\\s+(?:\\p{Lu}\\.\\s*)+|(?:\\s+(?:et\\s+al\\.?|&|and)\\s+' + NAME + ')*)\\s*' + YEAR + ',', 'u');

  function isReferenceEntry(t) {
    const s = String(t || '').trim();
    if (!s || s.split(/\s+/).length > 150) return false;
    if (NUMBERED_ENTRY_RE.test(s)) return true;                                    // [1] / [12] …
    if (APA_START_RE.test(s) && APA_YEAR_RE.test(s.slice(0, 300))) return true;    // Author, A. (2020).
    if (HARVARD_RE.test(s)) return true;                                           // Author 2020, / Author, A. 2020,
    return false;
  }

  // ── Masking ──
  const URL_RE = /(?<![@\w.])(?:https?:\/\/|www\.)[^\s<>"⟦⟧]+/gi;
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
  const DOI_PREFIX_RE = /\bdoi:\s*10\.\d{4,9}\/[^\s<>"⟦⟧]+/gi;
  const DOI_BARE_RE = /\b10\.\d{4,9}\/[^\s<>"⟦⟧]+/g;
  const LOC = '(?:,\\s*(?:pp?\\.|para\\.|ch\\.|chap\\.)\\s*[\\d\\-–]+)?';
  const AUTH = NAME + '(?:\\s+(?:et\\s+al\\.?|&|and|' + NAME + '))*';
  const SEG = AUTH + ',?\\s+' + YEAR + '(?:,\\s*' + YEAR + ')*' + LOC;
  const PAREN_CITE_RE = new RegExp('\\((?:(?:see|e\\.g\\.,?|cf\\.)\\s+)?' + SEG + '(?:;\\s*' + SEG + ')*\\)', 'gu');
  const YEAR_CITE_RE = new RegExp('\\(' + YEAR + LOC + '\\)', 'g');               // Smith (2020)
  const NUM_CITE_RE = /\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g;                     // [3] / [3, 5] / [3–5]

  // Trailing sentence punctuation and unbalanced closing brackets are not part of a link.
  function splitTrailing(s) {
    let end = s.length;
    while (end > 0) {
      const ch = s[end - 1];
      const head = s.slice(0, end);
      if ('.,;:!?\'"'.includes(ch)) { end--; continue; }
      if (ch === ')' && head.split('(').length < head.split(')').length) { end--; continue; }
      if (ch === ']' && head.split('[').length < head.split(']').length) { end--; continue; }
      break;
    }
    return [s.slice(0, end), s.slice(end)];
  }

  function createMasker() {
    let n = 0;
    const map = new Map(); // token → original
    const tok = (orig) => { const t = '⟦L' + (++n) + '⟧'; map.set(t, orig); return t; };
    const linkTok = (m) => { const [core, tail] = splitTrailing(m); return core ? tok(core) + tail : m; };
    function mask(text) {
      return text
        .replace(URL_RE, linkTok)
        .replace(EMAIL_RE, tok)
        .replace(DOI_PREFIX_RE, linkTok)
        .replace(DOI_BARE_RE, linkTok)
        .replace(PAREN_CITE_RE, tok)
        .replace(YEAR_CITE_RE, tok)
        .replace(NUM_CITE_RE, tok);
    }
    return { mask, tok, map };
  }

  function tokensIn(s) { return String(s || '').match(TOKEN_RE) || []; }

  // Restores one paragraph. It must contain exactly the expected tokens, each once,
  // and nothing token-like besides — otherwise null (caller uses the original).
  function restoreUnit(out, expected, map) {
    const found = tokensIn(out);
    if (found.length !== expected.length) return null;
    const want = new Set(expected);
    for (const f of found) { if (!want.delete(f)) return null; }
    const r = out.replace(TOKEN_RE, (t) => map.get(t));
    return BRACKET_RE.test(r) ? null : r;
  }

  // ── DOCX: absolute positions that must keep their original XML ──
  // Same table-stripping + paragraph regex as extractBodyParasWithPos, so positions match.
  const HYPERLINK_RE = /<w:hyperlink\b|<w:fldSimple\b[^>]*HYPERLINK|<w:instrText\b[^>]*>[^<]*HYPERLINK/i;
  function docxKeepOriginalPositions(xml) {
    const noTables = xml.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, '');
    const paras = noTables.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
    const texts = paras.map(p => p.replace(/<[^>]+>/g, '').trim());
    const total = texts.reduce((n, t) => n + t.length, 0);
    let refStart = -1, offset = 0;
    texts.forEach((t, pos) => { if (isRefHeading(t) && inLastPart(offset, total)) refStart = pos; offset += t.length; });
    const keep = new Set();
    paras.forEach((p, pos) => {
      if ((refStart >= 0 && pos > refStart) || HYPERLINK_RE.test(p) || isReferenceEntry(texts[pos])) keep.add(pos);
    });
    return keep;
  }

  // ── PPTX: tags of text boxes on/after the reference slide (read-only use of slide data) ──
  function pptxSkipTags(slides) {
    const skip = new Set();
    if (!Array.isArray(slides)) return skip;
    const total = slides.reduce((n, s) => n + (s.textBoxItems || []).reduce((k, it) => k + String(it.text || '').length, 0), 0);
    let refIdx = -1, offset = 0;
    slides.forEach((s, si) => {
      for (const it of s.textBoxItems || []) {
        const t = String(it.text || '').trim();
        // Whole box is the heading, or the box starts with the heading followed by entries
        // (runs are joined without separators, e.g. "ReferencesSmith, J. (2020)…").
        const m = t.match(HEADING_START_RE);
        const heading = isRefHeading(t) || (m && isRefHeading(m[0]) && isReferenceEntry(t.slice(m[0].length)));
        if (heading && inLastPart(offset, total)) refIdx = si;
        offset += String(it.text || '').length;
      }
    });
    if (refIdx < 0) return skip;
    slides.slice(refIdx).forEach(s => (s.textBoxItems || []).forEach((it, ti) => {
      if (!it.isTitle) skip.add('SLIDE' + s.num + '_BOX' + (ti + 1));
    }));
    return skip;
  }

  // ── prepare(): mask a request, return what to send and how to restore the answer ──
  // opts: { tool, skipMarkers?: Set<number> (DOCX), pptxSlides?: slides (PPTX) }
  // Returns { changed, sendText, prompt, nothingToSend, keepOriginal:Set<number>, restore(result) }.
  function prepare(text, prompt, opts) {
    opts = opts || {};
    const passthrough = { changed: false, sendText: text, prompt, nothingToSend: false, keepOriginal: new Set(), restore: r => r };
    if (!text || BRACKET_RE.test(text)) return passthrough;
    const { mask, tok, map } = createMasker();
    const withPrompt = () => map.size > 0 ? prompt + '\n\n' + PROMPT_LINE : prompt;

    // ── DOCX marker blocks ──
    if (/^<<<\d+>>>/m.test(text)) {
      const skipMarkers = opts.skipMarkers || new Set();
      const units = [];
      const re = /<<<(\d+)>>>\s*([\s\S]*?)(?=<<<\d+>>>|$)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = parseInt(m[1], 10), orig = m[2].trim();
        const skip = skipMarkers.has(n) || isReferenceEntry(orig);
        const before = map.size;
        const masked = skip ? null : mask(orig);
        units.push({ n, orig, skip, masked, tokens: skip ? [] : [...map.keys()].slice(before) });
      }
      const sent = units.filter(u => !u.skip);
      if (sent.length === units.length && map.size === 0) return passthrough;
      const keepOriginal = new Set();
      return {
        changed: true,
        sendText: sent.map(u => '<<<' + u.n + '>>> ' + u.masked).join('\n\n'),
        prompt: withPrompt(),
        nothingToSend: sent.length === 0,
        keepOriginal,
        restore(result) {
          const outMap = new Map();
          const rr = /<<<(\d+)>>>\s*([\s\S]*?)(?=<<<\d+>>>|$)/g;
          let mm;
          while ((mm = rr.exec(result || '')) !== null) {
            // Same rule as paraphrase(): only the text up to the first blank line belongs to the marker.
            outMap.set(parseInt(mm[1], 10), mm[2].split(/\n\s*\n/)[0].trim());
          }
          const out = [];
          for (const u of units) {
            if (u.skip) { keepOriginal.add(u.n); out.push('<<<' + u.n + '>>> ' + u.orig); continue; }
            if (!outMap.has(u.n)) continue; // missing marker → paraphrase() keeps original DOCX text
            const o = outMap.get(u.n);
            const r = u.tokens.length || tokensIn(o).length ? restoreUnit(o, u.tokens, map) : o;
            if (r === null || !r) {
              console.warn('[protect] <<<' + u.n + '>>> placeholder missing/altered — keeping original paragraph');
              keepOriginal.add(u.n); out.push('<<<' + u.n + '>>> ' + u.orig);
            } else out.push('<<<' + u.n + '>>> ' + r);
          }
          return out.join('\n\n');
        }
      };
    }

    // ── PPTX tagged text boxes ──
    if (/\[SLIDE\d+_BOX\d+\]/.test(text)) {
      const skipTags = pptxSkipTags(opts.pptxSlides);
      const units = [];
      const re = /\[(SLIDE\d+_BOX\d+)\]([\s\S]*?)\[\/\1\]/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const tag = m[1], orig = m[2];
        const skip = skipTags.has(tag) || isReferenceEntry(orig);
        const before = map.size;
        const masked = skip ? null : mask(orig);
        units.push({ tag, orig, skip, masked, tokens: skip ? [] : [...map.keys()].slice(before) });
      }
      const sent = units.filter(u => !u.skip);
      if (sent.length === units.length && map.size === 0) return passthrough;
      return {
        changed: true,
        sendText: sent.map(u => '[' + u.tag + ']' + u.masked + '[/' + u.tag + ']').join('\n'),
        prompt: withPrompt(),
        nothingToSend: sent.length === 0,
        keepOriginal: new Set(),
        // Skipped / broken boxes are left OUT of the answer, so paraphrasePPTX falls back
        // to the box's original text (its existing "tag missing" path).
        restore(result) {
          const out = [];
          for (const u of sent) {
            const mm = String(result || '').match(new RegExp('\\[' + u.tag + '\\]([\\s\\S]*?)\\[\\/' + u.tag + '\\]', 'i'));
            if (!mm) continue;
            const o = mm[1];
            const r = u.tokens.length || tokensIn(o).length ? restoreUnit(o, u.tokens, map) : o;
            if (r === null) { console.warn('[protect] ' + u.tag + ' placeholder missing/altered — keeping original text'); continue; }
            out.push('[' + u.tag + ']' + r + '[/' + u.tag + ']');
          }
          return out.join('\n');
        }
      };
    }

    // ── Plain paragraphs (pasted text, PDF, humanize, grammar) ──
    const paras = text.split(/\n[ \t]*\n/).map(p => p.trim()).filter(Boolean);
    const units = paras.map(orig => {
      const before = map.size;
      // Reference entries become one whole-paragraph placeholder: never rewritten, kept in place.
      const masked = isReferenceEntry(orig) ? tok(orig) : mask(orig);
      return { orig, masked, tokens: [...map.keys()].slice(before) };
    });
    if (map.size === 0) return passthrough;
    const allTokens = [...map.keys()];

    function restorePlain(out) {
      out = String(out || '');
      const found = tokensIn(out);
      // 1. Every placeholder present exactly once → restore in place.
      if (found.length === allTokens.length && new Set(found).size === found.length && found.every(t => map.has(t))) {
        const r = out.replace(TOKEN_RE, t => map.get(t));
        if (!BRACKET_RE.test(r)) return r;
      }
      // 2. Same paragraph count → per-paragraph check; broken paragraphs use the original.
      const outParas = out.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      if (outParas.length === units.length) {
        return outParas.map((o, i) => {
          const r = restoreUnit(o, units[i].tokens, map);
          if (r === null) console.warn('[protect] paragraph ' + (i + 1) + ' placeholder missing/altered — keeping original');
          return r === null ? units[i].orig : r;
        }).join('\n\n');
      }
      // 3. Paragraphs merged/split AND a placeholder lost → whole request keeps its original text.
      console.warn('[protect] placeholder lost and paragraph count changed — keeping original text for this request');
      return units.map(u => u.orig).join('\n\n');
    }

    return {
      changed: true,
      sendText: units.map(u => u.masked).join('\n\n'),
      prompt: withPrompt(),
      nothingToSend: false,
      keepOriginal: new Set(),
      restore(result) {
        if (opts.tool !== 'grammar') return restorePlain(result);
        // Grammar: placeholders are checked in the CORRECTED TEXT section; the error list
        // only gets best-effort restoration (it is commentary, not the document).
        const s = String(result || '');
        const c = s.match(/CORRECTED\s+TEXT\s*:\s*/i);
        if (!c) return restorePlain(s);
        const start = c.index + c[0].length;
        const e = s.slice(start).match(/ERRORS?\s+FOUND\s*:/i);
        const end = e ? start + e.index : s.length;
        const errors = s.slice(end).replace(TOKEN_RE, t => map.has(t) ? map.get(t) : t);
        return s.slice(0, start) + restorePlain(s.slice(start, end).trim()) + (e ? '\n\n' : '') + errors;
      }
    };
  }

  // Grammar: append the untouched reference section to the end of CORRECTED TEXT.
  function appendToCorrected(result, extra) {
    const s = String(result || '');
    const c = s.match(/CORRECTED\s+TEXT\s*:\s*/i);
    if (!c) return s.replace(/\s+$/, '') + extra;
    const start = c.index + c[0].length;
    const e = s.slice(start).match(/ERRORS?\s+FOUND\s*:/i);
    if (!e) return s.replace(/\s+$/, '') + extra;
    const end = start + e.index;
    return s.slice(0, end).replace(/\s+$/, '') + extra + '\n\n' + s.slice(end);
  }

  const api = {
    TOOLS, PROMPT_LINE, prepare, splitReferences, appendToCorrected, isRefHeading, isReferenceEntry,
    docxKeepOriginalPositions, pptxSkipTags,
    _internal: { createMasker, restoreUnit, tokensIn, splitTrailing },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PFProtect = api;
})(typeof window !== 'undefined' ? window : this);
