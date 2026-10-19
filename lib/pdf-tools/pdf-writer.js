// ═══════════════════════════════════════════════════
// ParaFree PDF tools — rendered document → PDF (lib/pdf-tools/pdf-writer.js)
// Walks the rendered output box (our own HTML, or docx-preview's pages), reads each block's
// computed style (size, weight, italic, colour, alignment, indent, spacing, list marker) and
// lays the text out itself with jsPDF and an embedded Unicode font (Noto Sans). Because the
// same font measures and draws the text, words are never split, punctuation stays attached,
// and the PDF's text copies out cleanly. Adjacent runs with the same style are merged first.
// Bullets are drawn as small shapes (not font glyphs). Complex scripts (Bengali, Devanagari,
// Arabic, CJK…) are not handled here — the tools send those documents to the print flow.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  // Embedded font families: the closest Noto face for each run's font (sans / serif / mono).
  const FONT_SETS = {
    sans: { family: 'PFNoto', url: 'notoSans', files: {
      normal: '400Regular/NotoSans_400Regular.ttf', bold: '700Bold/NotoSans_700Bold.ttf',
      italic: '400Regular_Italic/NotoSans_400Regular_Italic.ttf', bolditalic: '700Bold_Italic/NotoSans_700Bold_Italic.ttf' } },
    serif: { family: 'PFNotoSerif', url: 'notoSerif', files: {
      normal: '400Regular/NotoSerif_400Regular.ttf', bold: '700Bold/NotoSerif_700Bold.ttf',
      italic: '400Regular_Italic/NotoSerif_400Regular_Italic.ttf', bolditalic: '700Bold_Italic/NotoSerif_700Bold_Italic.ttf' } },
    mono: { family: 'PFNotoMono', url: 'notoMono', files: {
      normal: '400Regular/NotoSansMono_400Regular.ttf', bold: '700Bold/NotoSansMono_700Bold.ttf' } },   // no italic face
  };
  // CSS font-family list -> 'sans' | 'serif' | 'mono'
  function category(cssFamily) {
    const f = String(cssFamily || '').toLowerCase();
    if (/mono|courier|consolas|menlo|lucida console/.test(f)) return 'mono';
    if (/pfnotoserif/.test(f)) return 'serif';
    if (/pfnoto/.test(f)) return 'sans';
    const first = f.split(',')[0];
    if ((/serif/.test(first) && !/sans/.test(first)) || /times|georgia|garamond|cambria|roman|antiqua|palatino|constantia|baskerville|minion/.test(first)) return 'serif';
    return 'sans';
  }
  const A4 = [595.28, 841.89];
  const PX = 0.75;                                   // CSS px → pt

  // Scripts the embedded Latin font can't shape go to the print flow; the check lives in common.js
  // (it is needed before this file loads).
  const hasComplexScript = (text) => window.PFC.hasComplexScript(text);

  const BULLETS = { '●': 'disc', '•': 'disc', '∙': 'disc', '◦': 'circle', '○': 'circle', '▪': 'square', '■': 'square', '□': 'square-open', '': 'disc' };

  // ── Fonts ────────────────────────────────────────
  const fontCache = {};
  function toBase64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // The same TTF bytes go into jsPDF and (as a FontFace) into the page, so the browser's layout
  // of the off-screen copy and the PDF measure text identically. Only the families in use load.
  function loadSet(cat) {
    if (!fontCache[cat]) {
      const set = FONT_SETS[cat];
      fontCache[cat] = Promise.all(Object.entries(set.files).map(async ([style, file]) => {
        const r = await fetch(window.PFLoad.URLS[set.url] + file);
        if (!r.ok) throw new Error('Could not load font ' + file);
        const buf = await r.arrayBuffer();
        try {
          const face = new FontFace(set.family, buf.slice(0), { weight: /bold/.test(style) ? '700' : '400', style: /italic/.test(style) ? 'italic' : 'normal' });
          document.fonts.add(await face.load());
        } catch (e) { /* layout falls back to the page font */ }
        return [style, toBase64(buf)];
      })).then((list) => Object.fromEntries(list), (e) => { delete fontCache[cat]; throw e; });
    }
    return fontCache[cat];
  }
  async function loadFonts(cats = ['sans']) {
    const want = [...new Set(['sans', ...cats])];
    const sets = await Promise.all(want.map(loadSet));
    return Object.fromEntries(want.map((c, i) => [c, sets[i]]));
  }
  function copyStyle() {
    if (document.getElementById('pfPdfCopyStyle')) return;
    const st = document.createElement('style');
    st.id = 'pfPdfCopyStyle';
    st.textContent = '.pf-pdf-copy, .pf-pdf-copy * { font-kerning: none; font-variant-ligatures: none; }' +
      ' .pf-pdf-copy .pf-cols { display: flex !important; gap: 1cm; column-count: auto !important; } .pf-pdf-copy .pf-col { flex: 1 1 0; min-width: 0; }';
    document.head.appendChild(st);
  }

  // ── Small helpers ────────────────────────────────
  function rgb(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return [26, 24, 20];
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0] | 0, p[1] | 0, p[2] | 0];
  }
  const num = (v) => parseFloat(v) || 0;
  const isBold = (w) => w === 'bold' || w === 'bolder' || num(w) >= 600;
  const styleKey = (b, i) => (b && i ? 'bolditalic' : b ? 'bold' : i ? 'italic' : 'normal');

  function cssUnescape(s) {
    return s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
  }
  function roman(n) {
    const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
    return s;
  }
  function alpha(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
  function fmtCounter(v, style) {
    switch ((style || 'decimal').trim()) {
      case 'lower-alpha': case 'lower-latin': return alpha(v);
      case 'upper-alpha': case 'upper-latin': return alpha(v).toUpperCase();
      case 'lower-roman': return roman(v);
      case 'upper-roman': return roman(v).toUpperCase();
      case 'decimal-leading-zero': return (v < 10 ? '0' : '') + v;
      case 'none': return '';
      default: return String(v);
    }
  }
  function pairs(value) {
    const out = [];
    if (!value || value === 'none') return out;
    const parts = value.trim().split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const n = parts[i], next = parts[i + 1];
      if (next !== undefined && /^-?\d+$/.test(next)) { out.push([n, parseInt(next, 10)]); i++; } else out.push([n, null]);
    }
    return out;
  }

  // ── DOM → blocks ─────────────────────────────────
  const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|LI|SECTION|ARTICLE|BLOCKQUOTE|HEADER|FOOTER|FIGURE|PRE|TABLE|ADDRESS|MAIN|NAV|ASIDE|DL|DT|DD)$/;

  function collector(root) {
    const cs = new Map();
    const style = (el) => { let s = cs.get(el); if (!s) { s = getComputedStyle(el); cs.set(el, s); } return s; };
    const counters = new Map();

    function isBlock(el) {
      const d = style(el).display;
      if (d === 'none') return false;
      if (BLOCK_TAGS.test(el.tagName)) return !/^inline/.test(d) || el.tagName === 'TABLE';
      return d === 'block' || d === 'list-item' || d === 'flex' || d === 'grid' || d === 'table';
    }

    function runStyle(el) {
      const s = style(el);
      return {
        b: isBold(s.fontWeight), i: s.fontStyle === 'italic' || s.fontStyle === 'oblique', fam: category(s.fontFamily),
        size: Math.max(4, num(s.fontSize) * PX), color: rgb(s.color),
        u: /underline/.test(s.textDecorationLine || s.textDecoration || ''),
      };
    }

    // List markers from docx-preview's ::before content, with its CSS counters simulated.
    function applyCounters(el) {
      const s = style(el);
      for (const [n, v] of pairs(s.counterReset)) counters.set(n, v == null ? 0 : v);
      for (const [n, v] of pairs(s.counterSet)) counters.set(n, v == null ? 0 : v);
      const b = getComputedStyle(el, '::before');
      for (const [n, v] of pairs(b.counterReset)) counters.set(n, v == null ? 0 : v);
      for (const [n, v] of pairs(b.counterSet)) counters.set(n, v == null ? 0 : v);
      for (const [n, v] of pairs(b.counterIncrement)) counters.set(n, (counters.get(n) || 0) + (v == null ? 1 : v));
      const content = b.content;
      if (!content || content === 'none' || content === 'normal') return null;
      let text = '';
      const re = /"((?:[^"\\]|\\.)*)"|counters?\(\s*([^,)\s]+)\s*(?:,\s*([^)]*))?\)/g;
      let m;
      while ((m = re.exec(content))) {
        if (m[1] !== undefined) text += cssUnescape(m[1]);
        else {
          const args = (m[3] || '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
          const st = args.find((a) => /^[a-z-]+$/.test(a)) || 'decimal';
          text += fmtCounter(counters.get(m[2]) || 0, st);
        }
      }
      text = text.replace(/[\t\s]+$/, '').replace(/^\s+/, '');
      if (!text) return null;
      return { text, run: runStyle(el) };
    }

    function liMarker(li) {
      const list = li.parentElement;
      const type = style(li).listStyleType || (list && list.tagName === 'OL' ? 'decimal' : 'disc');
      if (type === 'none') return null;
      if (/disc|circle|square/.test(type)) return { shape: type, run: runStyle(li) };
      let n = list && list.tagName === 'OL' ? (list.start || 1) : 1;
      for (let s = li.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === 'LI') n++;
      return { text: fmtCounter(n, type) + '.', run: runStyle(li), outside: true };
    }

    function textFrag(node, out) {
      const parent = node.parentElement;
      const ws = style(parent).whiteSpace;
      let t = node.nodeValue;
      if (/pre/.test(ws)) {
        const parts = t.replace(/\t/g, ' ').split('\n');
        parts.forEach((p, i) => { if (i) out.push({ br: true }); if (p) out.push({ text: p, ...runStyle(parent) }); });
        return;
      }
      t = t.replace(/[\t\n\r\f ]+/g, ' ');
      if (t) out.push({ text: t, ...runStyle(parent) });
    }

    function inline(el, out) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) textFrag(n, out);
        else if (n.nodeType === 1) {
          if (style(n).display === 'none') continue;
          if (n.tagName === 'BR') out.push({ br: true });
          else if (n.tagName === 'IMG') out.push({ img: n });
          else if (isBlock(n)) out.push({ block: n });
          else inline(n, out);
        }
      }
      return out;
    }

    function paraProps(el, origin, scale) {
      const s = style(el), r = el.getBoundingClientRect();
      const left = r.left + num(s.borderLeftWidth) + num(s.paddingLeft);
      const width = r.width - num(s.borderLeftWidth) - num(s.borderRightWidth) - num(s.paddingLeft) - num(s.paddingRight);
      const fs = num(s.fontSize) || 16;
      const lh = s.lineHeight === 'normal' ? 1.3 : Math.max(1, num(s.lineHeight) / fs);
      return {
        x: (left - origin) * scale, width: Math.max(20, width * scale), indent: num(s.textIndent) * scale,
        align: /center/.test(s.textAlign) ? 'center' : /right|end/.test(s.textAlign) ? 'right' : 'left',
        before: num(s.marginTop) * PX, after: num(s.marginBottom) * PX, lh, size: fs * PX,
        minLine: el.tagName === 'P' || /^H\d$/.test(el.tagName),
      };
    }

    // Normalise one paragraph's runs: merge same-style neighbours, collapse spaces between runs.
    function cleanFrags(frags) {
      const out = [];
      for (const f of frags) {
        const last = out[out.length - 1];
        if (f.text != null && last && last.text != null && last.b === f.b && last.i === f.i && last.fam === f.fam && last.size === f.size && last.u === f.u && last.color.join() === f.color.join()) last.text += f.text;
        else out.push({ ...f });
      }
      for (let k = 1; k < out.length; k++) {
        const a = out[k - 1], b = out[k];
        if (a.text != null && b.text != null && /\s$/.test(a.text) && /^\s/.test(b.text)) b.text = b.text.replace(/^\s+/, '');
      }
      const texts = out.filter((f) => f.text != null);
      if (texts.length) { texts[0].text = texts[0].text.replace(/^\s+/, ''); texts[texts.length - 1].text = texts[texts.length - 1].text.replace(/\s+$/, ''); }
      return out.filter((f) => f.br || (f.text != null && f.text.length));
    }

    function walk(el, blocks, origin, scale) {
      if (el.classList && el.classList.contains('pf-cols')) {
        const columns = [...el.children].filter((c) => c.classList.contains('pf-col')).map((c) => {
          const list = [];
          for (const ch of c.children) walk(ch, list, origin, scale);
          return list;
        });
        const colX = [...el.children].filter((c) => c.classList.contains('pf-col')).map((c) => (c.getBoundingClientRect().left - origin) * scale);
        if (columns.length > 1) { blocks.push({ kind: 'cols', columns, colX }); return; }
      }
      if (el.tagName === 'TABLE') { blocks.push(tableBlock(el, origin, scale)); return; }
      if (el.tagName === 'HR') { if (el.dataset.pageBreak || el.classList.contains('pf-page-break')) blocks.push({ kind: 'break' }); return; }
      if (el.tagName === 'UL' || el.tagName === 'OL') { for (const c of el.children) if (isBlock(c)) walk(c, blocks, origin, scale); return; }
      const marker = el.tagName === 'LI' ? liMarker(el) : applyCounters(el);
      const items = inline(el, []);
      let frags = [];
      let first = true, other = false;
      const flush = (force) => {
        const clean = cleanFrags(frags);
        frags = [];
        if (!clean.length && !(force && first && !other && (marker || paraProps(el, origin, scale).minLine))) return;
        const p = paraProps(el, origin, scale);
        blocks.push({ kind: 'para', ...p, frags: clean, marker: first ? marker : null, indent: first ? p.indent : 0 });
        first = false;
      };
      for (const it of items) {
        if (it.block) { flush(false); other = true; walk(it.block, blocks, origin, scale); }
        else if (it.img) { flush(false); other = true; const b = imageBlock(it.img, origin, scale); if (b) blocks.push(b); }
        else frags.push(it);
      }
      flush(true);
    }

    function imageBlock(img, origin, scale) {
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height || !img.complete || !img.naturalWidth) return null;
      return { kind: 'img', img, x: (r.left - origin) * scale, w: r.width * scale, h: r.height * scale };
    }

    function tableBlock(table, origin, scale) {
      const rows = [];
      for (const tr of table.rows) {
        const cells = [];
        for (const td of tr.cells) {
          const r = td.getBoundingClientRect(), s = style(td);
          const blocks = [];
          walk(td, blocks, origin, scale);
          const side = (k) => (s[`border${k}Style`] !== 'none' && num(s[`border${k}Width`]) > 0 ? { w: Math.max(0.5, num(s[`border${k}Width`]) * PX), color: rgb(s[`border${k}Color`]) } : null);
          cells.push({ x: (r.left - origin) * scale, w: r.width * scale, padTop: num(s.paddingTop) * PX, padBottom: num(s.paddingBottom) * PX, blocks, border: { Top: side('Top'), Right: side('Right'), Bottom: side('Bottom'), Left: side('Left') } });
        }
        rows.push(cells);
      }
      return { kind: 'table', rows };
    }

    return { walk, style };
  }

  // ── Layout + drawing ─────────────────────────────
  function render(doc, blocks) {
    const fontsOk = {};
    const widthCache = new Map();
    const loaded = doc._pfFonts || { sans: true };
    function face(r) {
      const fam = loaded[r.fam] ? r.fam : 'sans';
      let st = styleKey(r.b, r.i);
      if (!FONT_SETS[fam].files[st]) st = r.b ? 'bold' : 'normal';
      return [FONT_SETS[fam].family, st];
    }
    function setRun(r) { const [f, st] = face(r); doc.setFont(f, st); doc.setFontSize(r.size); }
    function measure(text, r) {
      const k = face(r).join('|') + '|' + r.size + '|' + text;
      let w = widthCache.get(k);
      if (w == null) { setRun(r); w = doc.getTextWidth(text); widthCache.set(k, w); }
      return w;
    }
    // characters the font has no glyph for become "?" (complex scripts never get here)
    function safe(text, r) {
      const key = face(r).join('|');
      let map = fontsOk[key];
      if (map === undefined) {
        try { setRun(r); const f = doc.getFont(); map = f.metadata && f.metadata.cmap && f.metadata.cmap.unicode && f.metadata.cmap.unicode.codeMap; } catch (e) { map = null; }
        fontsOk[key] = map || null;
      }
      if (!map) return text;
      let out = '';
      for (const ch of text) { const c = ch.codePointAt(0); out += c < 32 || map[c] || ch === ' ' ? ch : (BULLETS[ch] && map[0x2022] ? '•' : '?'); }
      return out;
    }

    // Break a paragraph into lines of tokens.
    function layoutPara(p) {
      const tokens = [];
      for (const f of p.frags) {
        if (f.br) { tokens.push({ br: true }); continue; }
        const text = safe(f.text, f);
        for (const m of text.matchAll(/\s+|[^\s]+/g)) tokens.push({ text: m[0], ws: /^\s/.test(m[0]), run: f, w: measure(m[0], f) });
      }
      const lines = [];
      let line = { toks: [], w: 0 };
      const maxW = (i) => p.width - (i === 0 ? Math.max(0, p.indent) : 0);
      const push = () => {
        while (line.toks.length && line.toks[line.toks.length - 1].ws) line.w -= line.toks.pop().w;
        lines.push(line);
        line = { toks: [], w: 0 };
      };
      for (const t of tokens) {
        if (t.br) { push(); continue; }
        if (t.ws && !line.toks.length && lines.length) continue;               // no leading space on wrapped lines
        // small tolerance: browser layout and jsPDF can differ by a fraction of a point
        if (!t.ws && line.w + t.w > maxW(lines.length) * 1.03 + 0.5 && line.toks.length) push();
        if (!t.ws && t.w > maxW(lines.length) * 1.25 + 2) {                    // only a very long word (URL…) is split
          let piece = '';
          for (const ch of t.text) {
            const w = measure(piece + ch, t.run);
            if (w > maxW(lines.length) - line.w && piece) { line.toks.push({ text: piece, run: t.run, w: measure(piece, t.run) }); line.w += measure(piece, t.run); push(); piece = ''; }
            piece += ch;
          }
          if (piece) { const w = measure(piece, t.run); line.toks.push({ text: piece, run: t.run, w }); line.w += w; }
          continue;
        }
        line.toks.push(t); line.w += t.w;
      }
      if (line.toks.length || !lines.length) push();
      return lines.map((l) => {
        const size = l.toks.reduce((m, t) => Math.max(m, t.run.size), 0) || p.size;
        return { ...l, size, h: size * p.lh };
      });
    }

    let page = null, y = 0, lastAfter = 0, atTop = true, pageNo = 0;
    let colFlow = null, slotShift = 0;      // column flow state while drawing a .pf-cols group
    const noteLow = (cc) => { if (pageNo > cc.low.page || (pageNo === cc.low.page && y > cc.low.y)) cc.low = { page: pageNo, y }; };
    // Out of room (or a column break): next column, or a new page when the last column is full.
    function nextArea() {
      const cc = colFlow;
      if (!cc) { newPage(); return; }
      noteLow(cc);
      cc.slot++;
      if (cc.slot >= cc.n) { newPage(); cc.slot = 0; cc.top = y; cc.limit = null; }
      else { doc.setPage(pageNo); y = cc.top; atTop = true; lastAfter = 0; }
      slotShift = cc.colX[cc.slot] - cc.colX[cc.src];
    }
    // Next page: re-use a page an earlier column already created, else add one.
    function newPage(geom) {
      if (geom) page = geom;
      if (!doc._pfStarted) { doc._pfStarted = true; pageNo = 1; }
      else if (!geom && pageNo < doc.getNumberOfPages()) { pageNo++; doc.setPage(pageNo); }
      else { doc.addPage([page.w, page.h], page.w > page.h ? 'l' : 'p'); pageNo = doc.getNumberOfPages(); }
      y = page.m.t; lastAfter = 0; atTop = true;
    }
    // bottom of the writing area (a balanced column group may end higher up)
    const bottom = () => (colFlow && colFlow.limit ? Math.min(colFlow.limit, page.h - page.m.b) : page.h - page.m.b);

    function drawMarker(mk, x, baseline, lineH) {
      const r = mk.run;
      if (mk.shape || BULLETS[mk.text] ) {
        const shape = mk.shape || BULLETS[mk.text];
        const s = r.size, cx = x + s * 0.25, cy = baseline - s * 0.32, rad = s * 0.17;
        doc.setFillColor(...r.color); doc.setDrawColor(...r.color); doc.setLineWidth(s * 0.06);
        if (shape === 'circle') doc.circle(cx, cy, rad, 'S');
        else if (shape === 'square') doc.rect(cx - rad, cy - rad, rad * 2, rad * 2, 'F');
        else if (shape === 'square-open') doc.rect(cx - rad, cy - rad, rad * 2, rad * 2, 'S');
        else doc.circle(cx, cy, rad, 'F');
        return;
      }
      setRun(r); doc.setTextColor(...r.color);
      doc.text(safe(mk.text, r), x, baseline);
    }

    function drawLine(l, x0, yTop) {
      const baseline = yTop + (l.h - l.size) / 2 + l.size * 0.86;
      let x = x0;
      let i = 0;
      while (i < l.toks.length) {
        // one doc.text() per run of same-style tokens (spaces inside the string)
        const r = l.toks[i].run;
        let str = '', w = 0;
        while (i < l.toks.length && l.toks[i].run === r) { str += l.toks[i].text; w += l.toks[i].w; i++; }
        setRun(r); doc.setTextColor(...r.color);
        doc.text(str, x, baseline);
        if (r.u && str.trim()) { doc.setDrawColor(...r.color); doc.setLineWidth(r.size * 0.05); doc.line(x, baseline + r.size * 0.12, x + w, baseline + r.size * 0.12); }
        x += w;
      }
      return baseline;
    }

    // Draw (or just measure, when dry) a paragraph starting at y. Returns the new y.
    function para(p, yStart, dry, xShift = 0) {
      const lines = layoutPara(p);
      let yy = yStart;
      lines.forEach((l, i) => {
        if (!dry && yy + l.h > bottom() && !atTop) { nextArea(); yy = y; }
        if (!dry) {
          // with a marker in a hanging indent, the text starts at the left edge (after the "tab")
          const hang = p.marker && p.indent < 0;
          let x = page.m.l + p.x + xShift + slotShift + (i === 0 && !hang ? p.indent : 0);
          if (p.align === 'center') x = page.m.l + p.x + xShift + slotShift + (p.width - l.w) / 2;
          else if (p.align === 'right') x = page.m.l + p.x + xShift + slotShift + p.width - l.w;
          if (i === 0 && p.marker) {                 // marker first, so "1." reads before its text
            const mk = p.marker;
            let mx;
            if (mk.outside || p.indent >= 0) mx = page.m.l + p.x + xShift + slotShift - (mk.shape || BULLETS[mk.text] ? mk.run.size * 0.9 : measure(mk.text, mk.run) + mk.run.size * 0.4);
            else mx = page.m.l + p.x + xShift + slotShift + p.indent;
            drawMarker(mk, mx, yy + (l.h - l.size) / 2 + l.size * 0.86, l.h);
          }
          drawLine(l, x, yy);
          atTop = false;
        }
        yy += l.h;
      });
      return yy;
    }

    function blocksHeight(blocks) {
      let h = 0, after = 0;
      for (const b of blocks) {
        if (b.kind === 'para') { h += Math.max(after, b.before) + (para(b, 0, true)); after = b.after; }
        else if (b.kind === 'img') h += b.h;
        else if (b.kind === 'table') h += tableHeights(b).reduce((s, x) => s + x, 0);
      }
      return h + after;
    }
    function tableHeights(t) {
      return t.rows.map((cells) => Math.max(12, ...cells.map((c) => c.padTop + blocksHeight(c.blocks) + c.padBottom)));
    }

    function drawBlocks(blocks, xShift = 0) {
      for (const b of blocks) {
        if (b.kind === 'section') { newPage(b.page); continue; }
        if (b.kind === 'cols') {
          // Word's continuous columns: the text flows column to column (no forced breaks) and, when
          // the whole group fits on this page, the columns are balanced to about equal height.
          y += atTop ? 0 : Math.max(lastAfter, 4);
          const flow = b.columns.flatMap((col, k) => col.map((blk) => ({ blk, k })));
          const total = blocksHeight(flow.map((f) => f.blk));
          const room = bottom() - y;
          const slack = Math.max(12, ...flow.map((f) => (f.blk.kind === 'para' ? f.blk.size * f.blk.lh * 1.2 : 0)));
          const cc = { n: b.columns.length, slot: 0, top: y, src: 0, colX: b.colX, low: { page: pageNo, y }, limit: null };
          cc.limit = total / cc.n <= room ? y + total / cc.n + slack : null;
          colFlow = cc;
          atTop = true; lastAfter = 0;
          for (const f of flow) {
            cc.src = f.k;
            slotShift = cc.colX[cc.slot] - cc.colX[f.k];
            drawBlocks([f.blk], xShift);
          }
          noteLow(cc);
          colFlow = null; slotShift = 0;
          pageNo = cc.low.page; doc.setPage(pageNo); y = cc.low.y; atTop = false; lastAfter = 6;
          continue;
        }
        if (b.kind === 'break') { if (!atTop) newPage(); continue; }
        if (b.kind === 'para') {
          y += atTop ? 0 : Math.max(lastAfter, b.before);
          y = para(b, y, false, xShift);
          lastAfter = b.after;
        } else if (b.kind === 'img') {
          let w = Math.min(b.w, page.w - page.m.l - page.m.r), h = b.h * (w / b.w);
          const maxH = bottom() - page.m.t;
          if (h > maxH) { w *= maxH / h; h = maxH; }
          y += atTop ? 0 : Math.max(lastAfter, 4);
          if (y + h > bottom() && !atTop) nextArea();
          drawImage(b.img, page.m.l + Math.max(0, b.x + xShift + slotShift), y, w, h);
          y += h; lastAfter = 4; atTop = false;
        } else if (b.kind === 'table') {
          y += atTop ? 0 : Math.max(lastAfter, 4);
          const heights = tableHeights(b);
          b.rows.forEach((cells, ri) => {
            const h = heights[ri];
            if (y + h > bottom() && !atTop) nextArea();
            const top = y;
            for (const c of cells) {
              const saveY = y, saveAfter = lastAfter, saveTop = atTop;
              y = top + c.padTop; atTop = true;
              drawBlocks(c.blocks, xShift);
              y = saveY; lastAfter = saveAfter; atTop = saveTop;
              const x = page.m.l + c.x + xShift + slotShift;
              const edge = (side, x1, y1, x2, y2) => { const s = c.border[side]; if (!s) return; doc.setDrawColor(...s.color); doc.setLineWidth(s.w); doc.line(x1, y1, x2, y2); };
              edge('Top', x, top, x + c.w, top);
              edge('Bottom', x, top + h, x + c.w, top + h);
              edge('Left', x, top, x, top + h);
              edge('Right', x + c.w, top, x + c.w, top + h);
            }
            y = top + h; atTop = false;
          });
          lastAfter = 6;
        }
      }
    }

    function drawImage(img, x, yy, w, h) {
      let src = img.currentSrc || img.src;
      let fmt = /^data:image\/jpe?g/i.test(src) ? 'JPEG' : /^data:image\/png/i.test(src) ? 'PNG' : null;
      if (!fmt) {                                     // other formats / blob: URLs → PNG via canvas
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          src = c.toDataURL('image/png'); fmt = 'PNG';
          c.width = c.height = 0;
        } catch (e) { return; }
      }
      try { doc.addImage(src, fmt, x, yy, w, h, undefined, 'FAST'); } catch (e) { /* skip an image jsPDF can't read */ }
    }

    drawBlocks(blocks);
    return doc;
  }

  // Pages: docx-preview sections carry their own size and margins; our own HTML is A4.
  function collectBlocks(root) {
    const col = collector(root);
    const blocks = [];
    const sections = [...root.querySelectorAll(':scope > section.docx, :scope > .docx-wrapper > section.docx')];
    if (sections.length) {
      for (const sec of sections) {
        const s = col.style(sec), r = sec.getBoundingClientRect();
        const scale = PX * (sec.offsetWidth / r.width || 1);      // ignore any CSS zoom on screen
        const w = r.width * scale, h = (num(s.minHeight) || 1122.5) * PX;
        blocks.push({ kind: 'section', page: { w, h, m: { t: num(s.paddingTop) * PX, r: num(s.paddingRight) * PX, b: num(s.paddingBottom) * PX, l: num(s.paddingLeft) * PX } } });
        const origin = r.left + (num(s.borderLeftWidth) + num(s.paddingLeft)) * (r.width / (sec.offsetWidth || r.width));
        const body = sec.querySelector(':scope > article') || sec;
        for (const c of body.children) col.walk(c, blocks, origin, scale);
      }
    } else {
      // root is the off-screen copy laid out at exactly the A4 content width (see toPdf)
      const r = root.getBoundingClientRect();
      blocks.push({ kind: 'section', page: { w: A4[0], h: A4[1], m: { ...A4_MARGIN } } });
      for (const c of root.children) col.walk(c, blocks, r.left, PX);
    }
    return blocks;
  }

  const A4_MARGIN = { t: 56, r: 56, b: 56, l: 56 };

  // Our own HTML: lay out a copy at the PDF's content width (483 pt = 644 px at 0.75 pt/px),
  // so font sizes and positions share one scale whatever the width of the box on screen.
  async function a4Copy(root) {
    const holder = document.createElement('div');
    holder.className = root.className + ' pf-pdf-copy';
    holder.setAttribute('aria-hidden', 'true');
    copyStyle();
    holder.style.cssText = root.style.cssText;                 // the document's own size and font
    Object.assign(holder.style, {
      position: 'fixed', left: '-20000px', top: '0', width: `${(A4[0] - A4_MARGIN.l - A4_MARGIN.r) / PX}px`,
      padding: '0', border: '0', margin: '0', maxHeight: 'none', minHeight: '0', overflow: 'visible',
    });
    if (!holder.style.fontSize) holder.style.fontSize = '11pt';
    holder.style.fontFamily = FONT_SETS[category(getComputedStyle(root).fontFamily)].family;
    holder.innerHTML = root.innerHTML;
    // every font in the copy -> the embedded face the PDF will use (same metrics)
    holder.querySelectorAll('[style]').forEach((n) => { if (n.style.fontFamily) n.style.fontFamily = FONT_SETS[category(n.style.fontFamily)].family; });
    holder.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    document.body.appendChild(holder);
    await Promise.all([...holder.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => null) : null)));
    return holder;
  }

  async function toPdf(root) {
    const cats = new Set([category(getComputedStyle(root).fontFamily)]);
    for (const el of root.querySelectorAll('*')) cats.add(category(getComputedStyle(el).fontFamily));
    const [{ jsPDF }, fonts] = await Promise.all([window.PFLoad.jspdf(), loadFonts([...cats])]);
    const isDocx = !!root.querySelector(':scope > section.docx, :scope > .docx-wrapper > section.docx');
    const copy = isDocx ? null : await a4Copy(root);
    let blocks;
    try { blocks = collectBlocks(copy || root); } finally { if (copy) copy.remove(); }
    const first = blocks[0].page;
    const doc = new jsPDF({ unit: 'pt', format: [first.w, first.h], orientation: first.w > first.h ? 'l' : 'p', compress: true, putOnlyUsedFonts: true });
    doc._pfFonts = {};
    for (const [cat, styles] of Object.entries(fonts)) {
      doc._pfFonts[cat] = true;
      for (const [style, b64] of Object.entries(styles)) {
        const file = `${FONT_SETS[cat].family}-${style}.ttf`;
        doc.addFileToVFS(file, b64);
        doc.addFont(file, FONT_SETS[cat].family, style, 'Identity-H');
      }
    }
    render(doc, blocks);
    return doc.output('blob');
  }

  window.PFPdfWriter = { toPdf, hasComplexScript, loadFonts, _internals: { fmtCounter, cssUnescape, pairs } };
})();
