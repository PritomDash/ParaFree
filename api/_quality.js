// ═══════════════════════════════════════════════════
// ParaFree — writing quality: segmenting, per-chunk quality gate, finish checks (api/_quality.js)
// Used by api/process.js for every writing request (paraphrase, humanize, grammar, summarize).
//
//   segment(text)            → units: paragraphs, with any paragraph over MAX_PARA_WORDS split by
//                              SENTENCE (pieces rejoin with a space, so the paragraph count never changes).
//                              PPTX "[SLIDEn_BOXm]…[/SLIDEn_BOXm]" boxes are units and are never split.
//   groupUnits(units, target) → chunks of consecutive units of about `target` words
//   gate(input, output, opts) → null when the answer is usable, else a short reason
//                              ("length_ratio", "unchanged", "script", "preamble", "markdown",
//                              "repetition", "paragraphs", "markers", "format", "empty")
//   mapOutput(units, output) → the answer split back onto the chunk's units, or null if it doesn't fit
//   alignOutput(units, output) → the same, but a different paragraph count is re-aligned (markers, then sentences)
//   structure(units, output) → { texts } | { whole } | { collapsed } — only a bad collapse is a rejection
//   outputCap(words)         → max output tokens for a chunk: clamp(words × 2.2, 600, 3000)
// Nothing here logs or stores text.
// ═══════════════════════════════════════════════════
'use strict';

const MAX_PARA_WORDS = 350;
const countWords = (s) => (String(s || '').match(/\S+/g) || []).length;
const PPTX_BOX_RE = /\[(SLIDE\d+_BOX\d+)\][\s\S]*?\[\/\1\]/g;
const DOCX_MARKER_RE = /^<<<\d+>>>\s*/;
const isPptx = (text) => /\[SLIDE\d+_BOX\d+\]/.test(text) && /\[\/SLIDE\d+_BOX\d+\]/.test(text);

// Sentences of one paragraph (keeps trailing quotes/brackets with their sentence; handles । ؟ 。 ！ ？)
function sentences(p) {
  const out = String(p).match(/[^.!?।؟。！？]+(?:[.!?।؟。！？]+["'”’)\]»]*\s*|$)/g) || [p];
  return out.map((s) => s.trim()).filter(Boolean);
}

// Pieces of a long paragraph: whole sentences up to MAX_PARA_WORDS each (a single over-long
// sentence is cut at word boundaries as a last resort).
function splitParagraph(p, maxWords = MAX_PARA_WORDS) {
  const marker = (p.match(DOCX_MARKER_RE) || [''])[0];
  const body = p.slice(marker.length);
  const pieces = [];
  let cur = [], curW = 0;
  const flush = () => { if (cur.length) { pieces.push(cur.join(' ')); cur = []; curW = 0; } };
  for (const s of sentences(body)) {
    const w = countWords(s);
    if (w > maxWords) {
      flush();
      const words = s.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) pieces.push(words.slice(i, i + maxWords).join(' '));
      continue;
    }
    if (curW + w > maxWords && cur.length) flush();
    cur.push(s); curW += w;
  }
  flush();
  if (pieces.length) pieces[0] = marker + pieces[0];
  return pieces.length ? pieces : [p];
}

// → [{ text, sep, send }] — sep = what follows this unit when the document is rebuilt
//   ('\n\n' between paragraphs, ' ' between pieces of one paragraph, '\n' between PPTX boxes);
//   send = false for units with no letters (numbers, rules, bullets) — they are kept as they are.
function segment(text, maxParaWords = MAX_PARA_WORDS) {
  const units = [];
  if (isPptx(text)) {
    let last = 0, m;
    PPTX_BOX_RE.lastIndex = 0;
    while ((m = PPTX_BOX_RE.exec(text)) !== null) {
      const gap = text.slice(last, m.index);
      if (units.length) units[units.length - 1].sep = gap || '\n';
      else if (gap.trim()) units.push({ text: gap.trim(), sep: '\n', send: false });
      units.push({ text: m[0], sep: '', send: true, box: true });
      last = m.index + m[0].length;
    }
    const tail = text.slice(last);
    if (tail.trim()) { if (units.length) units[units.length - 1].sep = '\n'; units.push({ text: tail.trim(), sep: '', send: /\p{L}/u.test(tail) }); }
    return units;
  }
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  paras.forEach((p, i) => {
    const pieces = countWords(p) > maxParaWords ? splitParagraph(p, maxParaWords) : [p];
    pieces.forEach((piece, j) => units.push({ text: piece, sep: j < pieces.length - 1 ? ' ' : (i < paras.length - 1 ? '\n\n' : ''), send: /\p{L}/u.test(piece), para: i, piece: pieces.length > 1 ? j : undefined }));
  });
  return units;
}

// One unit cut into two halves at a sentence boundary (for "split on failure") → [a, b] or null.
// Both halves belong to the same paragraph: a joins b with a space, b keeps the unit's own separator.
function halve(unit) {
  if (unit.box) return null;
  const marker = (unit.text.match(DOCX_MARKER_RE) || [''])[0];
  const ss = sentences(unit.text.slice(marker.length));
  if (ss.length < 2) return null;
  const total = countWords(unit.text);
  let k = 0, w = 0;
  while (k < ss.length - 1 && w + countWords(ss[k]) <= total / 2) { w += countWords(ss[k]); k++; }
  if (k === 0) k = 1;
  const p = unit.piece != null ? unit.piece : 0;
  return [
    Object.assign({}, unit, { text: marker + ss.slice(0, k).join(' '), sep: ' ', piece: p }),
    Object.assign({}, unit, { text: ss.slice(k).join(' '), piece: p + 1 }),
  ];
}

// Consecutive units into chunks of about `target` words (a chunk never splits a unit).
function groupUnits(units, target) {
  const chunks = [];
  let cur = [], curW = 0;
  for (const u of units) {
    const w = countWords(u.text);
    if (cur.length && curW + w > target) { chunks.push(cur); cur = []; curW = 0; }
    cur.push(u); curW += w;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// What one chunk sends: its units that have letters, joined so each is its own paragraph.
const chunkSendText = (units) => units.filter((u) => u.send).map((u) => u.text).join(units.some((u) => u.box) ? '\n' : '\n\n');
// The chunk's original text, exactly as it sits in the rebuilt document.
const chunkOriginal = (units) => units.map((u, i) => u.text + (i < units.length - 1 ? u.sep : '')).join('');
// Rebuild a document from per-unit texts.
const rebuild = (units, texts) => units.map((u, i) => texts[i] + (i < units.length - 1 ? u.sep : '')).join('');

// The answer back onto the chunk's units → per-unit texts, or null when the paragraph count doesn't
// match (a merged or dropped paragraph). PPTX boxes are matched by tag.
function mapOutput(units, output) {
  const sent = units.filter((u) => u.send);
  const out = String(output).trim();
  let parts;
  if (units.some((u) => u.box)) {
    parts = sent.map((u) => {
      const tag = u.text.match(/^\[(SLIDE\d+_BOX\d+)\]/)[1];
      const m = out.match(new RegExp('\\[' + tag + '\\][\\s\\S]*?\\[\\/' + tag + '\\]'));
      return m ? m[0] : null;
    });
    if (parts.some((p) => p === null)) return null;
  } else {
    // one unit = one paragraph: a model that broke it into several is joined back (the paragraph count never grows)
    parts = sent.length === 1 ? [out.replace(/\s*\n\s*\n\s*/g, ' ')] : out.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== sent.length) return null;
  }
  let k = 0;
  return units.map((u) => (u.send ? parts[k++] : u.text));
}

// k pieces of `text` laid onto units of these word counts: its own paragraphs when there are exactly k, else its
// sentences cut where the running word share is closest to the input's → k strings, or null (fewer sentences than k)
function spread(text, weights) {
  const k = weights.length, t = String(text).trim();
  if (k === 1) return t ? [t.replace(/\s*\n\s*\n\s*/g, ' ')] : null;
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === k) return paras;
  const ss = paras.flatMap((p) => sentences(p));
  if (ss.length < k) return null;
  const total = weights.reduce((a, b) => a + b, 0) || k;
  const sw = ss.map(countWords), outTotal = sw.reduce((a, b) => a + b, 0);
  const pieces = [];
  let i = 0, done = 0, acc = 0;
  for (let u = 0; u < k - 1; u++) {
    acc += weights[u];
    const goal = (acc / total) * outTotal;
    const start = i;
    // at least one sentence each, and enough left for the units after this one
    while (i < ss.length - (k - 1 - u) && (i === start || Math.abs(done + sw[i] - goal) <= Math.abs(done - goal))) { done += sw[i]; i++; }
    pieces.push(ss.slice(start, i).join(' '));
  }
  pieces.push(ss.slice(i).join(' '));
  return pieces;
}

// Like mapOutput, but an answer with a different paragraph count is re-aligned instead of refused: split at the
// DOCX <<<N>>> markers (a marked paragraph and its unmarked continuation pieces form one group), then each group's
// text is laid onto its units by paragraph or by sentence. → per-unit texts, or null when it can't be re-aligned.
function alignOutput(units, output) {
  const direct = mapOutput(units, output);
  if (direct || units.some((u) => u.box)) return direct;
  const sent = units.filter((u) => u.send);
  const out = String(output).trim();
  const groups = [];   // [{ marker, units: [] }]
  for (const u of sent) {
    const m = u.text.match(/^<<<(\d+)>>>/);
    if (m || !groups.length) groups.push({ marker: m ? m[0] : null, units: [] });
    groups[groups.length - 1].units.push(u);
  }
  let segs;
  if (groups.some((g) => g.marker)) {
    const at = groups.map((g) => (g.marker ? out.indexOf(g.marker) : 0));
    if (at.some((p, i) => p < 0 || (i && p < at[i - 1]))) return null;
    segs = groups.map((g, i) => out.slice(at[i], i + 1 < groups.length ? at[i + 1] : out.length).trim());
  } else segs = [out];
  const texts = [];
  for (let g = 0; g < groups.length; g++) {
    const marker = groups[g].marker || '';
    const body = marker ? segs[g].slice(marker.length).trim() : segs[g];
    const pieces = spread(body, groups[g].units.map((u) => countWords(stripMarkers(u.text))));
    if (!pieces || pieces.some((p) => !p)) return null;
    pieces[0] = marker ? marker + ' ' + pieces[0] : pieces[0];
    texts.push(...pieces);
  }
  let k = 0;
  return units.map((u) => (u.send ? texts[k++] : u.text));
}

// Paragraph structure of an answer that passed the gate → { texts } (re-aligned per unit), { whole: true } (can't be
// re-aligned but still has at least half the paragraphs — used as it is), or { collapsed: true } (a bad collapse: reject).
function structure(units, output) {
  const texts = alignOutput(units, output);
  if (texts) return { texts };
  if (units.some((u) => u.box)) return { collapsed: true };
  const want = units.filter((u) => u.send && !(u.piece > 0)).length;   // the input's paragraphs (pieces of one count once)
  const got = String(output).trim().split(/\n\s*\n/).filter((p) => p.trim()).length;
  return got >= Math.ceil(want * 0.5) ? { whole: true } : { collapsed: true };
}

// ── quality gate ──
const SCRIPTS = [
  ['bengali', /\p{Script=Bengali}/u], ['devanagari', /\p{Script=Devanagari}/u], ['arabic', /\p{Script=Arabic}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u], ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ['thai', /\p{Script=Thai}/u], ['tamil', /\p{Script=Tamil}/u], ['telugu', /\p{Script=Telugu}/u], ['greek', /\p{Script=Greek}/u],
  ['latin', /\p{Script=Latin}/u],
];
const LANG_SCRIPT = { bengali: 'bengali', hindi: 'devanagari', arabic: 'arabic', urdu: 'arabic', persian: 'arabic',
  chinese: 'cjk', japanese: 'cjk', korean: 'cjk', thai: 'thai', tamil: 'tamil', telugu: 'telugu' };
// Dominant script of a text and its share of the letters (markers/tags are ignored)
function dominantScript(text) {
  const counts = {};
  let total = 0;
  for (const ch of stripMarkers(text)) {
    if (!/\p{L}/u.test(ch)) continue;
    total++;
    const s = (SCRIPTS.find(([, re]) => re.test(ch)) || ['other'])[0];
    counts[s] = (counts[s] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? { script: top[0], share: top[1] / total, letters: total } : { script: null, share: 0, letters: 0 };
}
const stripMarkers = (t) => String(t).replace(/<<<\d+>>>\s*/g, '').replace(/\[\/?SLIDE\d+_BOX\d+\]/g, '').replace(/⟦L\d+⟧/g, '');
const EN_STOP = new Set('the a an and or of to in is are was were be for with on that this it as at by from have has not but they their you we he she which'.split(' '));
const enShare = (t) => { const w = stripMarkers(t).toLowerCase().match(/[a-z']+/g) || []; return w.length ? w.filter((x) => EN_STOP.has(x)).length / w.length : 0; };
const tokens = (t) => stripMarkers(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Share of the input's words that did not survive (bag of words) — 0 = identical, 1 = all new
function changeShare(input, output) {
  const a = tokens(input), b = tokens(output);
  if (!a.length) return 1;
  const bag = new Map();
  for (const w of b) bag.set(w, (bag.get(w) || 0) + 1);
  let kept = 0;
  for (const w of a) { const n = bag.get(w); if (n) { kept++; bag.set(w, n - 1); } }
  return 1 - kept / Math.max(a.length, b.length);
}

// Minimum word change per mode: below it the answer counts as "not paraphrased"
const MIN_CHANGE = { standard: 0.15, paraphrase: 0.15, fluency: 0.10, formal: 0.12, simple: 0.15, creative: 0.20,
  natural: 0.10, student: 0.10, professional: 0.10, casual: 0.10, humanize: 0.10 };
const PREAMBLE_RE = /^\s*(?:here(?:'s| is| are)\b|sure[,!.]|certainly[,!.]|of course[,!.]|okay[,!.]|below is\b|i(?:'ve| have) (?:paraphrased|rewritten|revised)\b|(?:the )?paraphrased (?:text|version)\b|rewritten (?:text|version)\b|output:)/i;
const LANG_ECHO_RE = /\b(?:respond in [a-z]+|your entire response must be|do not include this instruction)\b/i;
const MD_HEAD_RE = /^\s{0,3}#{1,6}\s/m, MD_BOLD_RE = /\*\*[^*\n]+\*\*/, MD_BULLET_RE = /^\s*[*•]\s+\S/m;
// list / heading markers of any style at a line start: # headings, bullets (* • - – — ▪ ◦ ● ○ ■ ►), 1. 1) a. a) (i)
const STRUCTURE_RE = /^\s{0,3}(?:#{1,6}\s|[*•\-–—▪◦●○■►]\s+\S|\(?(?:\d{1,3}|[a-zA-Z]|[ivxIVX]{1,4})[.)]\s+\S)/m;

function repeats(text) {
  // a sentence of 6+ words said 3+ times, or one word 8+ times in a row
  const counts = new Map();
  for (const s of sentences(stripMarkers(text))) {
    const k = s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (countWords(k) >= 6) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if ([...counts.values()].some((n) => n >= 3)) return true;
  return /\b(\p{L}+)(?:\s+\1\b){7,}/iu.test(text);
}

// opts: { kind: 'paraphrase'|'humanize'|'grammar'|'summarize'|'other', mode, language }
function gate(input, output, opts = {}) {
  const kind = opts.kind || 'paraphrase';
  const out = String(output || '').trim();
  if (out.length < 2) return 'empty';
  if (kind === 'other') return null;
  const inW = countWords(stripMarkers(input)), outW = countWords(stripMarkers(out));
  const ratio = inW ? outW / inW : 1;

  // markers must survive: every DOCX <<<N>>> and PPTX box tag in the input
  const marks = (t) => (String(t).match(/<<<\d+>>>|\[\/?SLIDE\d+_BOX\d+\]/g) || []).sort().join(',');
  if (marks(input) && marks(input) !== marks(out)) return 'markers';

  // language / script
  const want = LANG_SCRIPT[String(opts.language || '').toLowerCase()] || null;
  const si = dominantScript(input), so = dominantScript(out);
  const expected = want || si.script;
  if (expected && so.letters >= 20 && so.script !== expected && so.share > 0.5) return 'script';
  if (!want && (!opts.language || /^english$/i.test(opts.language)) && si.script === 'latin' && enShare(input) >= 0.15 && outW >= 20 && enShare(out) < 0.06) return 'script';

  // preamble / instruction echo / markdown the input didn't have
  if (PREAMBLE_RE.test(stripMarkers(out)) && !PREAMBLE_RE.test(stripMarkers(input))) return 'preamble';
  if (LANG_ECHO_RE.test(out) && !LANG_ECHO_RE.test(input)) return 'preamble';
  // (summaries are asked for bullet points and grammar answers have their own format — markdown is only a fault
  // in a paraphrase / humanized text)
  // An input that already has list or heading markers (any bullet, "1." / "a)" numbering, "#") may get them back in
  // the model's own style: those are not markdown faults. Checked on the text without DOCX/PPTX markers, so a
  // "<<<N>>> • item" paragraph counts too. Bold is still a fault unless the input had bold.
  if (kind === 'paraphrase' || kind === 'humanize') {
    const plainIn = stripMarkers(input);
    const listy = STRUCTURE_RE.test(plainIn);
    for (const re of listy ? [MD_BOLD_RE] : [MD_HEAD_RE, MD_BOLD_RE, MD_BULLET_RE]) if (re.test(out) && !re.test(plainIn)) return 'markdown';
  }

  if (repeats(out) && !repeats(input)) return 'repetition';

  if (kind === 'grammar') {
    if (!/CORRECTED TEXT\s*:/i.test(out)) return 'format';
    return null;
  }
  if (kind === 'summarize') {
    if (inW >= 40 && (ratio > 0.9 || ratio < 0.03)) return 'length_ratio';
    return null;
  }
  // paraphrase / humanize
  if (inW >= 12 && (ratio < 0.6 || ratio > 1.6)) return 'length_ratio';
  const min = MIN_CHANGE[opts.mode] != null ? MIN_CHANGE[opts.mode] : (MIN_CHANGE[kind] || 0.15);
  if (inW >= 12 && changeShare(input, out) < min) return 'unchanged';
  return null;
}

// Output-token cap for a chunk (writing path)
const outputCap = (words) => Math.max(600, Math.min(3000, Math.ceil(words * 2.2)));

// Which gate rules a request type gets
function kindOf(type) {
  if (type === 'humanize') return 'humanize';
  if (type === 'grammar') return 'grammar';
  if (type === 'summarize') return 'summarize';
  if (!type || type === 'paraphrase' || type === 'standard') return 'paraphrase';
  return 'paraphrase';
}

// Cut-off detection on a raw provider answer (OpenAI-style or Gemini) → null or a reason
function finishProblem(data, shape) {
  if (shape === 'gemini') {
    const c = data && data.candidates && data.candidates[0];
    if (!c) return (data && data.promptFeedback && data.promptFeedback.blockReason) ? 'blocked' : 'empty';
    const fr = c.finishReason;
    if (fr && fr !== 'STOP' && fr !== 'FINISH_REASON_UNSPECIFIED') return fr === 'MAX_TOKENS' ? 'length' : String(fr).toLowerCase();
    return null;
  }
  const ch = data && data.choices && data.choices[0];
  if (!ch) return 'empty';
  const fr = ch.finish_reason;
  if (fr === 'length' || fr === 'max_tokens') return 'length';
  if (fr === 'content_filter') return 'content_filter';
  return null;
}

module.exports = {
  MAX_PARA_WORDS, MIN_CHANGE, countWords, sentences, splitParagraph, segment, groupUnits, halve, chunkSendText, chunkOriginal,
  rebuild, mapOutput, alignOutput, structure, gate, changeShare, dominantScript, outputCap, kindOf, finishProblem, isPptx, repeats,
};
