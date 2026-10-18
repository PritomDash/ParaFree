// ═══════════════════════════════════════════════════
// ParaFree PDF tools — PDF to Word (lib/pdf-tools/pdf-to-word.js)
// pdf.js text layer → one document model (headings, paragraphs, lists, images, page breaks)
// → editable HTML in the output box. Pages without a text layer are read with Tesseract OCR.
// The .docx is built with the docx library FROM THE OUTPUT BOX, so edits are included.
// Everything runs in this tab; the file is never uploaded.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const TOOL = 'pdf_to_word';
  const C = window.PFC;

  const BULLET_RE = /^\s*([•●▪◦‣∙·○■□➢➤►\-–—*])\s+/;
  const NUM_RE = /^\s*(\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])\s+/;
  const BARE_NUM_RE = /^\s*\d{1,3}[.)]?\s+/;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Fonts: bold / italic from the font name ─────────────
  function fontInfo(page, fontName, cache) {
    if (cache.has(fontName)) return cache.get(fontName);
    let name = '', bold = false, italic = false;
    try {
      if (page.commonObjs.has(fontName)) {
        const f = page.commonObjs.get(fontName);
        name = String((f && (f.name || f.fallbackName)) || '');
        bold = !!(f && (f.bold || f.black));
        italic = !!(f && f.italic);
      }
    } catch (e) { /* font not loaded: treat as regular */ }
    const info = {
      bold: bold || /bold|black|heavy|semibold|demibold|extrabold|-bd\b|,bd\b/i.test(name),
      italic: italic || /italic|oblique|-it\b|,it\b/i.test(name),
    };
    cache.set(fontName, info);
    return info;
  }

  // ── Text items → lines (kept in content order, which follows columns) ──
  function buildLines(page, items) {
    const fonts = new Map();
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const t = it.transform;
      const size = Math.hypot(t[2], t[3]) || it.height || 10;
      const x = t[4], y = t[5];
      if (!it.str.length) { if (it.hasEOL && cur) cur.eol = true; continue; }
      const sameLine = cur && !cur.eol && Math.abs(y - cur.y) <= Math.max(2, 0.45 * Math.max(size, cur.size)) &&
        x >= cur.xEnd - Math.max(size, cur.size) * 1.5;
      if (!sameLine) {
        cur = { y, x, xEnd: x, size: 0, runs: [], text: '', eol: false, items: [], cells: [] };
        lines.push(cur);
      }
      const f = fontInfo(page, it.fontName, fonts);
      const gapX = x - cur.xEnd;
      let str = it.str;
      // a visible gap between items means a space
      if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(str) && gapX > 0.18 * size) str = ' ' + str;
      if (it.str.trim()) cur.size = Math.max(cur.size, size);
      const last = cur.runs[cur.runs.length - 1];
      if (last && last.b === f.bold && last.i === f.italic) last.text += str;
      else cur.runs.push({ text: str, b: f.bold, i: f.italic });
      cur.text += str;
      // cells: a wide gap (more than two characters' height) starts a new column
      if (it.str.trim()) {
        if (!cur.cells.length || gapX > 2 * size) cur.cells.push({ x, runs: [] });
        const cell = cur.cells[cur.cells.length - 1];
        const cl = cell.runs[cell.runs.length - 1];
        const cs = cl && gapX > 0.18 * size && !/\s$/.test(cl.text) ? ' ' + it.str : it.str;
        if (cl && cl.b === f.bold && cl.i === f.italic) cl.text += cs;
        else cell.runs.push({ text: cs, b: f.bold, i: f.italic });
        cur.items.push({ x, xEnd: x + (it.width || 0), str: it.str });
        // pdf.js adds whitespace items that span wide gaps; only real text sets the line's extent
        cur.xEnd = Math.max(cur.xEnd, x + (it.width || 0));
      }
      if (it.hasEOL) cur.eol = true;
    }
    return lines.filter((l) => l.text.trim());
  }

  // Most common text size on the page, weighted by characters.
  function bodySize(lines) {
    const w = new Map();
    for (const l of lines) {
      const k = Math.round(l.size * 2) / 2;
      w.set(k, (w.get(k) || 0) + l.text.trim().length);
    }
    let best = 0, bestN = -1;
    for (const [k, n] of w) if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
    return best || 11;
  }

  // A line is a heading when its text is clearly larger than the page's body text. The
  // level (h1–h3) is decided later across the whole document, by ranking heading sizes.
  function headingLevel(size, body) {
    return size / body >= 1.12 ? 'h' : null;
  }

  // every block, including those inside column groups
  const allBlocks = (model) => model.flatMap((b) => (b.type === 'cols' ? b.columns.flatMap(allBlocks) : [b]));

  function rankHeadings(model) {
    const flat = allBlocks(model);
    const sizes = [...new Set(flat.filter((b) => b.type === 'h').map((b) => Math.round(b.size)))].sort((a, b) => b - a);
    for (const b of flat) {
      if (b.type !== 'h') continue;
      const rank = sizes.indexOf(Math.round(b.size));
      b.type = rank === 0 ? 'h1' : rank === 1 ? 'h2' : 'h3';
    }
    return model;
  }

  function stripMarker(runs, re) {
    const out = runs.map((r) => ({ ...r }));
    while (out.length) {
      const m = re.exec(out[0].text);
      if (m) { out[0].text = out[0].text.slice(m[0].length); }
      if (out[0].text) break;
      out.shift();
      if (m) break;
    }
    return out;
  }

  function appendRuns(target, runs) {
    // join lines with a space (or undo an end-of-line hyphenation)
    const last = target[target.length - 1];
    const first = runs[0];
    if (last && first) {
      if (/[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(first.text)) last.text = last.text.slice(0, -1);
      else if (!/\s$/.test(last.text) && !/^\s/.test(first.text)) last.text += ' ';
    }
    for (const r of runs) {
      const l = target[target.length - 1];
      if (l && l.b === r.b && l.i === r.i) l.text += r.text;
      else target.push({ ...r });
    }
  }

  // "1  Audit…" — a bare number set apart from the text by a clear gap (not "2024 was…").
  function bareNumber(line) {
    const it = line.items;
    return it.length >= 2 && /^\d{1,3}[.)]?$/.test(it[0].str.trim()) && it[1].x - it[0].xEnd > 0.6 * line.size;
  }

  // Cells of a line that could be a table row (2+ columns set well apart, not a list item).
  function rowCells(line) {
    const c = line.cells;
    if (c.length < 2 || BULLET_RE.test(line.text) || bareNumber(line)) return null;
    for (let k = 1; k < c.length; k++) if (c[k].x - c[k - 1].x < 3 * line.size) return null;
    return c;
  }

  // 2+ consecutive rows with the same number of columns starting at the same x positions.
  // Anything less certain is left to the paragraph rules, so text is never scrambled.
  function detectTable(lines, i) {
    const first = rowCells(lines[i]);
    if (!first) return null;
    const rows = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const c = rowCells(lines[j]);
      if (!c || c.length !== first.length) break;
      if (!c.every((cell, k) => Math.abs(cell.x - first[k].x) <= Math.max(4, 0.5 * lines[j].size))) break;
      const gap = lines[j - 1].y - lines[j].y;
      if (gap <= 0 || gap > 3 * Math.max(lines[j].size, lines[j - 1].size)) break;
      rows.push(lines[j]);
    }
    return rows.length >= 2 ? rows : null;
  }

  // ── Columns ──────────────────────────────────────
  // A page is read as 2 or 3 columns only when a clear vertical gap runs through most of its
  // text rows and every column holds running text; anything less certain stays one column.
  function itemBox(it) {
    const t = it.transform;
    return { x: t[4], xEnd: t[4] + (it.width || 0), y: t[5], size: Math.hypot(t[2], t[3]) || it.height || 10, it };
  }

  function clusterRows(boxes) {                 // → rows, top of the page first
    const rows = [];
    for (const b of boxes.slice().sort((a, c) => c.y - a.y)) {
      const r = rows[rows.length - 1];
      if (r && Math.abs(r.y - b.y) <= 0.45 * Math.max(r.size, b.size)) { r.items.push(b); r.size = Math.max(r.size, b.size); r.bottom = Math.min(r.bottom, b.y); }
      else rows.push({ y: b.y, bottom: b.y, size: b.size, items: [b] });
    }
    return rows;
  }

  const textBoxes = (items) => items.filter((it) => typeof it.str === 'string' && it.str.trim()).map(itemBox);

  function detectColumns(items) {
    const boxes = textBoxes(items);
    if (boxes.length < 20) return null;
    const rows = clusterRows(boxes);
    if (rows.length < 12) return null;
    const minX = Math.min(...boxes.map((b) => b.x)), maxX = Math.max(...boxes.map((b) => b.xEnd));
    const span = maxX - minX;
    if (span < 250) return null;
    // how many rows have text at each x (1 pt steps)
    const cover = new Uint16Array(Math.ceil(span) + 2);
    for (const r of rows) {
      const mark = new Uint8Array(cover.length);
      for (const b of r.items) for (let x = Math.max(0, Math.floor(b.x - minX)); x <= Math.min(cover.length - 1, Math.ceil(b.xEnd - minX)); x++) mark[x] = 1;
      for (let x = 0; x < cover.length; x++) cover[x] += mark[x];
    }
    const sizes = boxes.map((b) => b.size).sort((a, c) => a - c);
    const med = sizes[sizes.length >> 1];
    const lowMax = Math.max(1, Math.floor(rows.length * 0.12));      // full-width rows (title…) may cross
    const gaps = [];
    for (let x = 0, s = -1; x <= cover.length; x++) {
      const low = x < cover.length && cover[x] <= lowMax;
      if (low && s < 0) s = x;
      if (!low && s >= 0) { if (x - s >= Math.max(8, 0.8 * med)) gaps.push({ start: minX + s, end: minX + x, mid: minX + (s + x) / 2 }); s = -1; }
    }
    const inner = gaps.filter((g) => g.start > minX + 0.12 * span && g.end < maxX - 0.12 * span);
    const near = (f, tol) => inner.filter((g) => Math.abs(g.mid - (minX + f * span)) <= tol * span).sort((a, c) => (c.end - c.start) - (a.end - a.start))[0];
    const tries = [];
    const g13 = near(1 / 3, 0.1), g23 = near(2 / 3, 0.1), g12 = near(1 / 2, 0.12);
    if (g13 && g23) tries.push([g13, g23]);
    if (g12) tries.push([g12]);
    for (const gutters of tries) {
      const layout = validateColumns(rows, gutters, minX, maxX);
      if (layout) return layout;
    }
    return null;
  }

  function validateColumns(rows, gutters, minX, maxX) {
    const edges = [minX, ...gutters.flatMap((g) => [g.start, g.end]), maxX];
    const bands = [];
    for (let k = 0; k < edges.length; k += 2) bands.push({ x0: edges[k], x1: edges[k + 1] });
    const crosses = (b) => gutters.some((g) => b.x < g.start - 1 && b.xEnd > g.end + 1);
    const bandOf = (b) => {                     // column index: which side of each gutter's middle
      const c = (b.x + b.xEnd) / 2;
      let k = 0;
      while (k < gutters.length && c > gutters[k].mid) k++;
      return k;
    };
    const body = rows.filter((r) => !r.items.some(crosses));
    if (body.length < 10) return null;
    const ranges = [];
    for (let k = 0; k < bands.length; k++) {
      const bd = bands[k];
      const inBand = body.map((r) => r.items.filter((b) => bandOf(b) === k)).filter((list) => list.length);
      if (inBand.length < Math.max(5, 0.2 * body.length)) return null;
      // running text fills its column (a table's short cells don't)
      const widths = inBand.map((list) => Math.max(...list.map((b) => b.xEnd)) - Math.min(...list.map((b) => b.x))).sort((a, c) => a - c);
      if (widths[widths.length >> 1] < 0.6 * (bd.x1 - bd.x0)) return null;
      const ys = inBand.flat().map((b) => b.y);
      ranges.push([Math.min(...ys), Math.max(...ys)]);
    }
    for (let k = 1; k < ranges.length; k++) {
      const [a0, a1] = ranges[k - 1], [b0, b1] = ranges[k];
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap < 0.4 * Math.min(a1 - a0, b1 - b0)) return null;      // side by side, not stacked
    }
    return { gutters, bands, crosses, bandOf };
  }

  // Page → regions top to bottom: full-width rows, and column regions read column by column.
  function columnRegions(items, layout) {
    const rows = clusterRows(textBoxes(items));
    const regions = [];
    for (const r of rows) {
      const kind = r.items.some(layout.crosses) ? 'full' : 'cols';
      const last = regions[regions.length - 1];
      if (last && last.kind === kind) { last.rows.push(r); last.bottom = r.bottom; }
      else regions.push({ kind, rows: [r], top: r.y + r.size, bottom: r.bottom });
    }
    // the short last line of a full-width paragraph doesn't cross the gutter: a left-only row right
    // under a full-width row, at normal line spacing, still belongs to that paragraph
    for (let k = 1; k < regions.length; k++) {
      const f = regions[k - 1], g = regions[k];
      if (f.kind !== 'full' || g.kind !== 'cols') continue;
      while (g.rows.length) {
        const row = g.rows[0], above = f.rows[f.rows.length - 1];
        if (!row.items.every((b) => layout.bandOf(b) === 0) || above.bottom - row.y > 1.6 * Math.max(row.size, above.size)) break;
        f.rows.push(g.rows.shift()); f.bottom = row.bottom;
        if (g.rows.length) g.top = g.rows[0].y + g.rows[0].size;
      }
    }
    // a couple of side-by-side rows between full-width parts are not a column layout
    for (const g of regions) if (g.kind === 'cols' && g.rows.length < 3) g.kind = 'full';
    const merged = [];
    for (const g of regions) {
      const last = merged[merged.length - 1];
      if (last && last.kind === 'full' && g.kind === 'full') { last.rows.push(...g.rows); last.bottom = g.bottom; } else merged.push(g);
    }
    // items in reading order; hasEOL is dropped because the original order no longer applies
    const ordered = (list) => list.map((b) => ({ ...b.it, hasEOL: false }));
    return merged.map((g) => {
      if (g.kind === 'full') return { kind: 'full', top: g.top, bottom: g.bottom, items: ordered(g.rows.flatMap((r) => r.items.slice().sort((a, c) => a.x - c.x))) };
      const columns = layout.bands.map((_, k) => {
        const mine = g.rows.flatMap((r) => r.items.filter((b) => layout.bandOf(b) === k));
        return ordered(clusterRows(mine).flatMap((r) => r.items.slice().sort((a, c) => a.x - c.x)));
      });
      return { kind: 'cols', top: g.top, bottom: g.bottom, columns };
    });
  }

  // List level from indentation: each new, deeper x starts a level (max 3).
  function listLevel(list, x, size) {
    const xs = list.levelXs;
    for (let k = 0; k < xs.length; k++) if (Math.abs(x - xs[k]) < size * 0.6) return k;
    if (x > xs[xs.length - 1] && xs.length < 3) { xs.push(x); return xs.length - 1; }
    let k = 0;
    while (k + 1 < xs.length && x > xs[k + 1]) k++;
    return k;
  }

  // ── Lines → blocks ────────────────────────────────
  function buildBlocks(lines, body) {
    const blocks = [];
    let prevLine = null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lvl = headingLevel(line.size, body);
      const prev = blocks[blocks.length - 1];
      const gap = prevLine ? prevLine.y - line.y : Infinity;     // > 0 when moving down the page
      const lineH = Math.max(line.size, prevLine ? prevLine.size : 0) * 1.2;
      const close = gap > 0 && gap < lineH * 1.45;

      const tableRows = detectTable(lines, li);
      if (tableRows) {
        blocks.push({ type: 'table', rows: tableRows.map((l) => l.cells.map((c) => trimRuns(c.runs))), top: line.y + line.size });
        li += tableRows.length - 1;
        prevLine = tableRows[tableRows.length - 1];
        continue;
      }

      const bullet = !lvl && BULLET_RE.test(line.text);
      const bare = !lvl && !bullet && bareNumber(line);
      const num = !lvl && !bullet && (bare || (NUM_RE.test(line.text) && line.text.length > 3));

      if (bullet || num) {
        const runs = stripMarker(line.runs, bullet ? BULLET_RE : bare ? BARE_NUM_RE : NUM_RE);
        if (prev && prev.type === 'list' && gap > 0 && gap < lineH * 2.2) {
          prev.items.push({ runs, x: line.x, level: listLevel(prev, line.x, line.size), ordered: num });
        } else {
          blocks.push({ type: 'list', levelXs: [line.x], items: [{ runs, x: line.x, level: 0, ordered: num }], top: line.y + line.size });
        }
      } else if (prev && prev.type === 'list' && close && line.x > prev.items[prev.items.length - 1].x + line.size * 0.5) {
        appendRuns(prev.items[prev.items.length - 1].runs, line.runs);           // wrapped list item
      } else {
        const type = lvl || 'p';
        const indented = prev && prev.type === 'p' && line.x > prev.x + line.size * 1.5;
        const sameSize = !prev || type !== 'h' || Math.abs((prev.size || 0) - line.size) < 0.5;
        if (prev && prev.type === type && close && !indented && sameSize) {
          appendRuns(prev.runs, line.runs);
          prev.lines++;
        } else {
          blocks.push({ type, runs: line.runs.map((r) => ({ ...r })), x: line.x, size: line.size, lines: 1, top: line.y + line.size });
        }
      }
      prevLine = line;
    }
    // A short, all-bold line on its own reads as a sub-heading.
    for (const b of blocks) {
      if (b.type !== 'p' || b.lines !== 1) continue;
      const text = b.runs.map((r) => r.text).join('').trim();
      if (text.length && text.length < 90 && b.runs.every((r) => r.b || !r.text.trim()) && !/[.,;]$/.test(text)) b.type = 'h';
    }
    for (const b of blocks) {
      if (b.runs) b.runs = trimRuns(b.runs);
      if (b.items) b.items.forEach((it) => { it.runs = trimRuns(it.runs); });
    }
    return blocks;
  }

  function trimRuns(runs) {
    const out = runs.filter((r) => r.text.length);
    // keep spaces outside bold/italic runs ("<b>word</b> next", not "<b>word </b>next")
    for (let i = 0; i < out.length - 1; i++) {
      const m = /\s+$/.exec(out[i].text);
      if (m && (out[i].b || out[i].i) && out[i].text.trim()) {
        out[i].text = out[i].text.slice(0, m.index);
        out[i + 1].text = m[0] + out[i + 1].text;
      }
    }
    if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ''); out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ''); }
    return out.filter((r) => r.text.length);
  }

  // ── Images (best effort) ──────────────────────────
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }

  function getObj(page, id) {
    const store = id.startsWith('g_') ? page.commonObjs : page.objs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      try { store.get(id, (o) => { clearTimeout(timer); resolve(o); }); } catch (e) { clearTimeout(timer); resolve(null); }
    });
  }

  function imageToDataUrl(img) {
    let w = img.width, h = img.height;
    if (!w || !h) return null;
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const ctx = src.getContext('2d');
    let png = true;
    if (img.bitmap) {
      ctx.drawImage(img.bitmap, 0, 0);
    } else if (img.data) {
      const out = ctx.createImageData(w, h);
      const d = img.data, o = out.data;
      if (img.kind === 3) { o.set(d.subarray(0, o.length)); }
      else if (img.kind === 2) {
        png = false;
        for (let i = 0, j = 0; j < o.length; i += 3, j += 4) { o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255; }
      } else if (img.kind === 1) {
        png = false;
        const rowBytes = (w + 7) >> 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const bit = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0, j = (y * w + x) * 4;
          o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255;
        }
      } else { C.freeCanvas(src); return null; }
      ctx.putImageData(out, 0, 0);
    } else { C.freeCanvas(src); return null; }
    // keep the Word file reasonable: longest side ≤ 1600 px
    let canvas = src;
    const scale = Math.min(1, 1600 / Math.max(w, h));
    if (scale < 1) {
      canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
      C.freeCanvas(src);
      w = canvas.width; h = canvas.height;
    }
    const url = png ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
    C.freeCanvas(canvas);
    return { src: url, pxW: w, pxH: h };
  }

  async function extractImages(page, pdfjs, opList) {
    const OPS = pdfjs.OPS;
    const found = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);
        if (wPt < 24 || hPt < 24) continue;                 // skip tiny decorations
        const top = Math.max(ctm[5], ctm[5] + ctm[3], ctm[5] + ctm[1], ctm[5] + ctm[1] + ctm[3]);
        const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
        found.push({ ref: args[0], inline: fn === OPS.paintInlineImageXObject, wPt, hPt, top, x0: Math.min(...xs), x1: Math.max(...xs) });
        if (found.length >= 30) break;
      }
    }
    const out = [];
    for (const f of found) {
      try {
        const img = f.inline ? f.ref : await getObj(page, f.ref);
        if (!img) continue;
        const d = imageToDataUrl(img);
        if (d) out.push({ type: 'img', src: d.src, w: Math.round(f.wPt * 96 / 72), h: Math.round(f.hPt * 96 / 72), top: f.top, x0: f.x0, x1: f.x1 });
      } catch (e) { /* skip this image silently */ }
    }
    return out;
  }

  function placeImages(blocks, images) {
    for (const img of images.sort((a, b) => b.top - a.top)) {
      let idx = blocks.findIndex((b) => b.type !== 'img' && b.top < img.top - 1);
      if (idx < 0) idx = blocks.length;
      blocks.splice(idx, 0, img);
    }
    return blocks;
  }

  // ── OCR for pages without a text layer ───────────
  let ocrWorker = null;
  async function getOcrWorker(onLog) {
    if (ocrWorker) return ocrWorker;
    const T = await window.PFLoad.tesseract();
    const U = window.PFLoad.URLS;
    ocrWorker = await T.createWorker('eng', 1, {
      workerPath: U.tessWorker, corePath: U.tessCore, langPath: U.tessLang,
      logger: (m) => onLog && onLog(m),
    });
    return ocrWorker;
  }
  async function endOcr() { if (ocrWorker) { const w = ocrWorker; ocrWorker = null; try { await w.terminate(); } catch (e) { /* ignore */ } } }

  async function ocrPage(page, onLog) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 3500 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const worker = await getOcrWorker(onLog);
    const { data } = await worker.recognize(canvas);
    C.freeCanvas(canvas);
    const blocks = [];
    for (const para of String(data.text || '').split(/\n\s*\n/)) {
      const lines = para.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const ln of lines) {
        const bullet = BULLET_RE.test(ln), num = !bullet && NUM_RE.test(ln) && ln.length > 3;
        const prev = blocks[blocks.length - 1];
        if (bullet || num) {
          const item = { runs: [{ text: ln.replace(bullet ? BULLET_RE : NUM_RE, ''), b: false, i: false }], level: 0, ordered: num };
          if (prev && prev.type === 'list' && prev.para === para) prev.items.push(item);
          else blocks.push({ type: 'list', items: [item], para });
        } else if (prev && prev.type === 'p' && prev.para === para) {
          appendRuns(prev.runs, [{ text: ln, b: false, i: false }]);
        } else {
          blocks.push({ type: 'p', runs: [{ text: ln, b: false, i: false }], para });
        }
      }
    }
    return blocks;
  }

  // ── Model → HTML ──────────────────────────────────
  function runsHtml(runs) {
    return runs.map((r) => {
      let h = esc(r.text);
      if (r.i) h = '<em>' + h + '</em>';
      if (r.b) h = '<strong>' + h + '</strong>';
      return h;
    }).join('');
  }
  // Flat list items with levels → nested <ul>/<ol> (a deeper list sits inside the item above it).
  function listHtml(items) {
    let html = '';
    const stack = [];
    for (const it of items) {
      const tag = it.ordered ? 'ol' : 'ul';
      const level = Math.min(it.level || 0, (stack.length ? stack[stack.length - 1].level + 1 : 0));
      while (stack.length && stack[stack.length - 1].level > level) html += '</li></' + stack.pop().tag + '>';
      const top = stack[stack.length - 1];
      if (!top || top.level < level) { html += '<' + tag + '>'; stack.push({ tag, level }); }
      else if (top.tag !== tag) { html += '</li></' + top.tag + '><' + tag + '>'; top.tag = tag; }
      else html += '</li>';
      html += '<li>' + runsHtml(it.runs);
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return html;
  }

  // A page with columns → full-width blocks and { type: 'cols' } groups (one block list per column).
  function columnBlocks(page, items, layout, body, images) {
    const blocks = [];
    const groups = [];
    for (const reg of columnRegions(items, layout)) {
      if (reg.kind === 'full') blocks.push(...buildBlocks(buildLines(page, reg.items), body));
      else {
        const g = { type: 'cols', count: reg.columns.length, columns: reg.columns.map((col) => buildBlocks(buildLines(page, col), body)), top: reg.top, bottom: reg.bottom };
        if (g.columns.filter((c) => c.length).length < 2) blocks.push(...g.columns.flat());   // nothing side by side after all
        else { blocks.push(g); groups.push(g); }
      }
    }
    // images: inside a column region and within one column → that column; otherwise full width
    for (const img of images) {
      const g = groups.find((x) => img.top <= x.top + 2 && img.top >= x.bottom - 2);
      const crosses = layout.gutters.some((gt) => img.x0 < gt.start - 1 && img.x1 > gt.end + 1);
      if (g && !crosses) {
        const k = layout.bandOf({ x: img.x0, xEnd: img.x1 });
        placeImages(g.columns[k], [img]);
      } else placeImages(blocks, [img]);
    }
    return blocks;
  }

  function modelToHtml(model) {
    return blocksHtml(model) || '<p></p>';
  }

  function blocksHtml(model) {
    let html = '';
    for (const b of model) {
      if (b.type === 'cols') {
        // real columns in the preview too; each source column is its own .pf-col (column break after it)
        html += `<div class="pf-cols" data-cols="${b.count}" style="column-count:${b.count}">` +
          b.columns.map((c) => `<div class="pf-col">${blocksHtml(c) || '<p></p>'}</div>`).join('') + '</div>';
      } else if (b.type === 'pagebreak') html += '<hr class="pf-page-break" data-page-break="1" contenteditable="false">';
      else if (b.type === 'img') html += `<p class="pf-img"><img src="${b.src}" width="${Math.min(b.w, 620)}" alt=""></p>`;
      else if (b.type === 'list') html += listHtml(b.items);
      else if (b.type === 'table') html += '<table><tbody>' + b.rows.map((r) => '<tr>' + r.map((c) => '<td>' + runsHtml(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
      else if (b.runs && b.runs.length) html += `<${b.type}>${runsHtml(b.runs)}</${b.type}>`;
    }
    return html;
  }

  // ── Output box (possibly edited) → .docx ──────────
  const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|LI|HR|SECTION|ARTICLE|BLOCKQUOTE|TABLE|THEAD|TBODY|TR|FIGURE|HEADER|FOOTER|PRE)$/;

  function dataUrlBytes(src) {
    const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/i.exec(src || '');
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const t = m[1].toLowerCase();
    return { type: t === 'jpeg' ? 'jpg' : t, bytes };
  }

  // Output box → Word sections: [{ cols, children }]. A .pf-cols group becomes its own section
  // with 2–3 columns (joined to its neighbours by continuous section breaks), and each source
  // column ends with a column break.
  function htmlToDocxSections(root, D) {
    const parts = [{ cols: 1, children: [] }];
    let children = parts[0].children;
    let listInstance = 0;
    function startPart(cols) {
      const cur = parts[parts.length - 1];
      if (!cur.children.length) { cur.cols = cols; return; }
      parts.push({ cols, children: [] });
      children = parts[parts.length - 1].children;
    }

    function imageRun(img) {
      const d = dataUrlBytes(img.getAttribute('src'));
      if (!d) return null;
      let w = Number(img.getAttribute('width')) || img.naturalWidth || 300;
      const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.75;
      w = Math.min(w, 600);
      return new D.ImageRun({ type: d.type, data: d.bytes, transformation: { width: Math.round(w), height: Math.round(w * ratio) } });
    }

    function runsOf(node, st, out) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const t = n.nodeValue.replace(/[\t\n\r ]+/g, ' ');
          if (t) out.push(new D.TextRun({ text: t, bold: st.b || undefined, italics: st.i || undefined, underline: st.u ? {} : undefined }));
        } else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === 'BR') { out.push(new D.TextRun({ text: '', break: 1 })); continue; }
          if (tag === 'IMG') { const r = imageRun(n); if (r) out.push(r); continue; }
          if (tag === 'UL' || tag === 'OL') continue;   // nested lists handled by the list walker
          const s = { ...st };
          if (tag === 'STRONG' || tag === 'B') s.b = true;
          if (tag === 'EM' || tag === 'I') s.i = true;
          if (tag === 'U') s.u = true;
          const css = n.style;
          if (css) {
            if (/bold|[6-9]00/.test(css.fontWeight)) s.b = true;
            if (css.fontStyle === 'italic') s.i = true;
            if (/underline/.test(css.textDecoration || css.textDecorationLine || '')) s.u = true;
          }
          runsOf(n, s, out);
        }
      }
      return out;
    }

    function paragraph(el, opts) {
      children.push(new D.Paragraph({ ...opts, children: runsOf(el, {}, []) }));
    }

    function hasBlockChild(el) { return [...el.children].some((c) => BLOCK_TAGS.test(c.tagName)); }

    // A real Word table with borders; the first row is a repeating header when it is all bold.
    function table(el) {
      const trs = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
      if (!trs.length) return;
      const cols = Math.max(...trs.map((tr) => tr.cells.length));
      const allBold = (td) => td.tagName === 'TH' || (!!td.textContent.trim() &&
        [...td.querySelectorAll('strong, b')].map((x) => x.textContent).join('').replace(/\s/g, '') === td.textContent.replace(/\s/g, ''));
      const header = [...trs[0].cells].every(allBold);
      const line = { style: D.BorderStyle.SINGLE, size: 6, color: '808080' };
      const cell = (td) => new D.TableCell({
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new D.Paragraph({ children: td ? runsOf(td, { b: td.tagName === 'TH' }, []) : [] })],
      });
      children.push(new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
        rows: trs.map((tr, ri) => new D.TableRow({
          tableHeader: ri === 0 && header,
          children: Array.from({ length: cols }, (_, k) => cell(tr.cells[k])),
        })),
      }));
    }

    function list(el, level) {
      const ordered = el.tagName === 'OL';
      const instance = ++listInstance;
      for (const li of el.children) {
        if (li.tagName !== 'LI') { if (li.tagName === 'UL' || li.tagName === 'OL') list(li, Math.min(level + 1, 2)); continue; }
        const runs = runsOf(li, {}, []);
        children.push(new D.Paragraph({
          children: runs,
          ...(ordered ? { numbering: { reference: 'pf-ol', level, instance } } : { bullet: { level } }),
        }));
        for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') list(sub, Math.min(level + 1, 2));
      }
    }

    function blocks(parent) {
      let pending = [];
      const flush = () => {
        if (!pending.length) return;
        const runs = [];
        const wrap = document.createElement('span');
        pending.forEach((n) => wrap.appendChild(n.cloneNode(true)));
        runsOf(wrap, {}, runs);
        if (wrap.textContent.trim() || wrap.querySelector('img')) children.push(new D.Paragraph({ children: runs }));
        pending = [];
      };
      for (const n of parent.childNodes) {
        if (n.nodeType !== 1 || !BLOCK_TAGS.test(n.tagName)) { pending.push(n); continue; }
        flush();
        const tag = n.tagName;
        if (tag === 'DIV' && n.classList.contains('pf-cols')) {
          const cols = [...n.children].filter((c) => c.classList.contains('pf-col'));
          const count = Math.max(2, Math.min(3, Number(n.dataset.cols) || cols.length));
          if (cols.length < 2) { blocks(n); continue; }     // edited down to one column: plain text
          startPart(count);
          cols.forEach((c, k) => {
            if (k) children.push(new D.Paragraph({ spacing: { before: 0, after: 0 }, children: [new D.ColumnBreak()] }));
            blocks(c);
          });
          startPart(1);
          continue;
        }
        if (/^H[1-6]$/.test(tag)) {
          const lv = Math.min(3, Number(tag[1]));
          paragraph(n, { heading: [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][lv - 1] });
        } else if (tag === 'UL' || tag === 'OL') list(n, 0);
        else if (tag === 'HR') { if (n.dataset.pageBreak || n.classList.contains('pf-page-break')) children.push(new D.Paragraph({ children: [new D.PageBreak()] })); }
        else if (tag === 'TABLE') table(n);
        else if (tag === 'THEAD' || tag === 'TBODY') blocks(n);
        else if (tag === 'TR') children.push(new D.Paragraph({ children: [new D.TextRun({ text: [...n.children].map((c) => c.textContent.trim()).join('\t') })] }));
        else if (hasBlockChild(n)) blocks(n);
        else paragraph(n, {});
      }
      flush();
    }

    blocks(root);
    const out = parts.filter((p, i) => p.children.length || i === 0);
    for (const p of out) {
      // Word needs a paragraph after a table that ends a section
      if (!p.children.length || p.children[p.children.length - 1] instanceof D.Table) p.children.push(new D.Paragraph({ children: [] }));
    }
    return out;
  }

  // single-section form (kept for callers that only want the paragraphs)
  function htmlToDocxChildren(root, D) {
    return htmlToDocxSections(root, D).flatMap((p) => p.children);
  }

  async function buildDocx(root) {
    const D = await window.PFLoad.docx();
    const lvl = (level, text) => ({
      level, format: D.LevelFormat.DECIMAL, text, alignment: D.AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    });
    const doc = new D.Document({
      creator: 'ParaFree PDF tools',
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      numbering: { config: [{ reference: 'pf-ol', levels: [lvl(0, '%1.'), lvl(1, '%2.'), lvl(2, '%3.')] }] },
      sections: htmlToDocxSections(root, D).map((p, i) => ({
        properties: {
          ...(i ? { type: D.SectionType.CONTINUOUS } : {}),
          ...(p.cols > 1 ? { column: { count: p.cols, space: 567, equalWidth: true } } : {}),   // 1 cm gap
        },
        children: p.children,
      })),
    });
    return D.Packer.toBlob(doc);
  }

  // ── Page flow ─────────────────────────────────────
  function init(panel) {
    const P = C.progress(panel);
    const result = C.q(panel, 'result');
    const box = C.editableOutput(panel, TOOL);
    const status = C.q(panel, 'summary');
    let run = 0, fileBase = 'document', pdfDoc = null;

    function reset() {
      run++;
      if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }
      endOcr();
      box.innerHTML = '';
      result.hidden = true;
      status.textContent = '';
      C.clearError(panel);
      P.hide();
      C.q(panel, 'drop').hidden = false;
    }

    async function convert(files) {
      reset();
      const me = run;
      const f = files[0];
      try {
        if (!C.isPdfFile(f)) throw new C.ToolError('unsupported', 'Please choose a PDF file (.pdf). For Word files, use the Word to PDF tab.');
        C.checkSizes([f]);
        fileBase = C.baseName(f.name);
        C.q(panel, 'drop').hidden = true;
        P.set(0.02, 'Loading PDF reader…');
        const pdfjs = await window.PFLoad.pdfjs();
        const data = new Uint8Array(await f.arrayBuffer());
        try { pdfDoc = await pdfjs.getDocument(window.PFLoad.pdfjsOptions(data)).promise; } catch (e) { throw C.toToolError(e, f.name); }
        if (me !== run) return;
        C.checkPages(pdfDoc.numPages, C.LIMITS.wordPages, `"${f.name}"`);
        const n = pdfDoc.numPages;
        const model = [];
        let ocrPages = 0, colPages = 0;
        for (let p = 1; p <= n; p++) {
          P.set((p - 1) / n, `Reading page ${p} of ${n}…`);
          await C.yieldUI();
          const page = await pdfDoc.getPage(p);
          const opList = await page.getOperatorList();
          const tc = await page.getTextContent();
          if (me !== run) return;
          const lines = buildLines(page, tc.items);
          const chars = lines.reduce((s, l) => s + l.text.replace(/\s/g, '').length, 0);
          let blocks;
          if (chars < 8) {
            ocrPages++;
            P.set((p - 1) / n, `Page ${p} of ${n} is a scan — reading the text (OCR)…`);
            blocks = await ocrPage(page, (m) => {
              if (me !== run) return;
              if (m.status === 'recognizing text') P.set((p - 1 + m.progress) / n, `Page ${p} of ${n}: reading scanned text ${Math.round(m.progress * 100)}%`);
              else if (/load|initializ/i.test(m.status)) P.set((p - 1) / n, `Page ${p} of ${n}: preparing OCR (first time can take a moment)…`);
            });
          } else {
            const body = bodySize(lines);
            const images = await extractImages(page, pdfjs, opList).catch(() => []);
            const layout = detectColumns(tc.items);
            blocks = layout ? columnBlocks(page, tc.items, layout, body, images) : placeImages(buildBlocks(lines, body), images);
            if (layout) colPages++;
          }
          if (me !== run) return;
          if (p > 1) model.push({ type: 'pagebreak' });
          model.push(...blocks);
          page.cleanup();
        }
        await endOcr();
        if (me !== run) return;
        box.innerHTML = modelToHtml(rankHeadings(model));
        status.textContent = `${n} page${n === 1 ? '' : 's'} converted${ocrPages ? ` (${ocrPages} scanned page${ocrPages === 1 ? '' : 's'} read with OCR — please check the text)` : ''}${colPages ? ` — columns kept on ${colPages} page${colPages === 1 ? "" : "s"}` : ""}. Edit the text below, then download.`;
        P.hide();
        result.hidden = false;
        if (window.PFPdfEvents) window.PFPdfEvents.toolUsed(TOOL, 'pdf');
      } catch (e) {
        if (me !== run) return;
        const err = C.toToolError(e, f && f.name);
        P.hide();
        C.q(panel, 'drop').hidden = false;
        C.showError(panel, err);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, err.type);
        endOcr();
      } finally {
        if (pdfDoc && me === run) { pdfDoc.destroy(); pdfDoc = null; }
      }
    }

    C.setupDrop(panel, convert);
    C.q(panel, 'start-over').addEventListener('click', reset);

    C.q(panel, 'dl-docx').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const blob = await buildDocx(box);
        C.download(blob, fileBase + '-converted.docx');
        if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'docx');
      } catch (err) {
        const te = C.toToolError(err);
        C.showError(panel, te);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, te.type);
      } finally { btn.disabled = false; }
    });

    C.q(panel, 'dl-pdf').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        P.set(0.1, 'Building PDF…');
        const blob = await C.documentPdf(panel, box, (f, t) => P.set(f, t));
        if (blob) C.download(blob, fileBase + '-converted.pdf');
        if (window.PFPdfEvents) window.PFPdfEvents.resultDownload(TOOL, 'pdf');
      } catch (err) {
        const te = C.toToolError(err);
        C.showError(panel, te);
        if (window.PFPdfEvents) window.PFPdfEvents.toolError(TOOL, te.type);
      } finally { btn.disabled = false; P.hide(); }
    });
    return { reset };
  }

  window.PFTools = window.PFTools || {};
  window.PFTools['pdf-to-word'] = {
    libs: () => Promise.all([window.PFLoad.pdfjs(), window.PFLoad.docx()]),
    init,
    // exposed for tests
    _internals: { buildLines, buildBlocks, bodySize, headingLevel, rankHeadings, modelToHtml, htmlToDocxChildren, htmlToDocxSections, buildDocx, detectColumns, columnRegions },
  };
})();
