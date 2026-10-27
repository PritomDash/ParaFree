// ParaFree Study Pack — TextRank pre-filter (lib/studypack/textrank.js), runs in the browser.
// Ranks sentences by how central they are (PageRank over a sentence-similarity graph) and keeps the best ones in
// their original order, so the AI gets ~40–60% fewer tokens with the main ideas intact. Very long documents are
// first cut to their most central sections (paragraph groups), so the graph stays small.
(function (root) {
  'use strict';
  const STOP = new Set(('a an the and or but if then so of to in on at by for with from into over under about as is are was were be been being ' +
    'it its this that these those there here which who whom whose what when where why how not no nor can could should would may might must will ' +
    'shall do does did done have has had having i you he she we they them his her their our your my me us also very more most such than too only ' +
    'just any each other some all both few many much own same between through during before after above below up down out off again further once').split(' '));
  const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));
  const countWords = (s) => (String(s).match(/\S+/g) || []).length;

  // sentences, keeping paragraph boundaries (a heading or bullet line counts as its own sentence)
  function splitSentences(text) {
    const out = [];
    String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n|\n(?=\s*(?:[-•*]|\d+[.)])\s)/).forEach((para, p) => {
      const parts = para.replace(/\s+/g, ' ').trim().match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g) || [];
      parts.map((s) => s.trim()).filter(Boolean).forEach((s) => out.push({ text: s, para: p }));
    });
    return out;
  }

  function similarity(a, b) {
    if (a.size < 2 || b.size < 2) return 0;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    return common ? common / (Math.log(a.size) + Math.log(b.size)) : 0;
  }

  // PageRank scores for a list of word sets
  function rank(sets, iterations = 30, d = 0.85) {
    const n = sets.length, W = Array.from({ length: n }, () => new Float64Array(n)), out = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const s = similarity(sets[i], sets[j]); W[i][j] = W[j][i] = s; out[i] += s; out[j] += s; }
    let score = new Float64Array(n).fill(1 / Math.max(n, 1));
    for (let it = 0; it < iterations; it++) {
      const next = new Float64Array(n).fill((1 - d) / Math.max(n, 1));
      for (let j = 0; j < n; j++) {
        if (!out[j]) continue;
        const share = d * score[j] / out[j];
        for (let i = 0; i < n; i++) if (W[j][i]) next[i] += share * W[j][i];
      }
      score = next;
    }
    return score;
  }

  // Cut a long text to its most central sections (groups of paragraphs, ~sectionWords each), in order.
  function topSections(sents, maxSentences, sectionWords = 600) {
    const sections = [];
    let cur = null;
    for (const s of sents) {
      if (!cur || (cur.words >= sectionWords && s.para !== cur.lastPara)) sections.push(cur = { sents: [], words: 0, lastPara: -1 });
      cur.sents.push(s); cur.words += countWords(s.text); cur.lastPara = s.para;
    }
    const freq = new Map();
    sents.forEach((s) => new Set(words(s.text)).forEach((w) => freq.set(w, (freq.get(w) || 0) + 1)));
    sections.forEach((sec, i) => {
      const ws = sec.sents.flatMap((s) => words(s.text));
      sec.score = ws.reduce((a, w) => a + Math.log(1 + freq.get(w)), 0) / Math.max(ws.length, 1);
      sec.i = i;
    });
    const keep = [];
    let n = 0;
    for (const sec of sections.slice().sort((a, b) => b.score - a.score)) {
      if (n + sec.sents.length > maxSentences && keep.length) continue;
      keep.push(sec); n += sec.sents.length;
    }
    return keep.sort((a, b) => a.i - b.i).flatMap((s) => s.sents);
  }

  // filter(text, {keepRatio, maxWords, minWords}) → { text, inputWords, outputWords, sentences, kept }
  function filter(text, opts) {
    const o = Object.assign({ keepRatio: 0.5, maxWords: 4000, minWords: 350, maxGraph: 900 }, opts || {});
    const inputWords = countWords(text);
    let sents = splitSentences(text);
    if (inputWords <= o.minWords || sents.length < 8) return { text: String(text).trim(), inputWords, outputWords: inputWords, sentences: sents.length, kept: sents.length, filtered: false };
    if (sents.length > o.maxGraph) sents = topSections(sents, o.maxGraph);
    const budget = Math.max(o.minWords, Math.min(o.maxWords, Math.round(inputWords * o.keepRatio)));
    const scores = rank(sents.map((s) => new Set(words(s.text))));
    const order = sents.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
    const keep = new Set();
    let total = 0;
    for (const i of order) {
      const w = countWords(sents[i].text);
      if (total + w > budget && keep.size) continue;
      keep.add(i); total += w;
      if (total >= budget) break;
    }
    // original order, paragraph breaks kept
    let out = '', lastPara = null;
    sents.forEach((s, i) => {
      if (!keep.has(i)) return;
      out += lastPara === null ? s.text : (s.para !== lastPara ? '\n\n' : ' ') + s.text;
      lastPara = s.para;
    });
    return { text: out, inputWords, outputWords: countWords(out), sentences: sents.length, kept: keep.size, filtered: true };
  }

  const api = { filter, splitSentences, rank, similarity, topSections, countWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PFTextRank = api;
})(typeof window !== 'undefined' ? window : globalThis);
