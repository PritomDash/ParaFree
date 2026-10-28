// ParaFree Study Pack — page logic (lib/studypack/app.js)
// Every input ends in ONE AI call that returns key points, flashcards and a quiz; the three tabs only re-render it.
//  paste / PDF / DOCX / PPTX / YouTube captions → text in the browser → TextRank pre-filter → {type:'studypack'}
//  YouTube: the pasted transcript is the main route (text path); a link alone → captions tried silently in the
//  browser; the experimental {type:'studypack_youtube'} (Gemini reads the video) falls back to the paste route
//  audio / video → split into pieces here → Groq Whisper piece by piece → {type:'studypack_audio_pack'} (text chain);
//  only if Whisper is unavailable: chunked upload relayed to Gemini → {type:'studypack_audio_generate'}
(function () {
  'use strict';
  const API = '/api/process';
  const LIB = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js',
    zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  };
  const $ = (id) => document.getElementById(id);
  const CTA_HTML = $('spGo').innerHTML;            // long label, and a shorter one for small phones (CSS picks)
  const state = { input: 'paste', mode: 'standard', pack: null, view: 'notes', card: 0, flipped: false, answers: [], audio: null, ytUrl: '', file: null, media: null };
  const ev = (name, params) => { try { if (typeof gtag === 'function') gtag('event', name, params || {}); } catch (e) {} };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  async function post(body) {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  }

  // ── status / progress ──
  function status(msg, kind) {
    const el = $('spStatus');
    el.textContent = msg || '';
    el.className = 'sp-status' + (kind ? ' sp-' + kind : '');
    el.hidden = !msg;
  }
  function progress(frac, label) {
    const wrap = $('spProgress');
    wrap.hidden = frac == null;
    if (frac == null) return;
    wrap.querySelector('span').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    $('spProgressLabel').textContent = label || '';
  }
  function busy(on) {
    $('spGo').disabled = on;
    if (on) $('spGo').textContent = 'Working…'; else $('spGo').innerHTML = CTA_HTML;
  }

  // ── client-side text extraction ──
  // Documents are read in slices (file.slice), never whole: pdf.js asks for the byte ranges it needs and is
  // reopened every PDF_BATCH pages; .docx/.pptx are zip files, so only the zip directory and the text parts
  // (document.xml / slide*.xml) are read — images and media inside them are never touched. The size limit only
  // protects the browser: TextRank still trims the text before the single AI call (packFromText), so a bigger
  // document makes no difference to API usage.
  const MB = 1000 * 1000;
  const DOC_MAX = { big: 2000 * MB, basic: 500 * MB };          // big = desktop Chrome/Edge with ≥ 4 GB of memory
  const docTier = () => (typeof window.showSaveFilePicker === 'function' && !(navigator.deviceMemory && navigator.deviceMemory < 4) ? 'big' : 'basic');
  const DOC_BIG = 200 * MB;                                      // above this: the "large file" note
  const TEXT_MAX = 20 * 1000 * 1000;                             // characters read from one document (≈ 3 million words)
  const PDF_BATCH = 50;
  const fmtMB = (n) => (n >= 1000 * MB ? Math.round(n / (100 * MB)) / 10 + ' GB' : Math.round(n / MB) + ' MB');   // 2.1 GB, 600 MB
  function checkDoc(file) {
    const max = DOC_MAX[docTier()];
    if (file.size > max) {
      throw new Error(`This file is ${fmtMB(file.size)}. Documents can be up to ${fmtMB(max)} here` +
        (docTier() === 'basic' ? ` (up to ${fmtMB(DOC_MAX.big)} on desktop Chrome or Edge)` : '') + ' — try a shorter part of it.');
    }
  }
  let textCut = false;                                           // the last document was longer than TEXT_MAX
  function rangeDoc(file) {
    class Slices extends window.pdfjsLib.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        file.slice(begin, end).arrayBuffer().then((b) => this.onDataRange(begin, new Uint8Array(b)), () => this.onDataRange(begin, new Uint8Array(end - begin)));
      }
    }
    return window.pdfjsLib.getDocument({ range: new Slices(file.size, new Uint8Array(0)), length: file.size, rangeChunkSize: 1 << 20,
      disableAutoFetch: true, disableStream: true }).promise;
  }
  async function pdfText(file) {
    await loadScript(LIB.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
    let doc = await rangeDoc(file);
    const n = doc.numPages, pages = [];
    let chars = 0;
    try {
      for (let i = 1; i <= n; i++) {
        if (i > 1 && (i - 1) % PDF_BATCH === 0) { await doc.destroy(); doc = await rangeDoc(file); }   // let go of the pages read so far
        if (n > PDF_BATCH) progress(i / n, `Reading page ${i} of ${n}…`);
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        page.cleanup();
        let line = '', out = '';
        tc.items.forEach((it) => { line += it.str; if (it.hasEOL) { out += line.trim() + '\n'; line = ''; } else line += ' '; });
        const text = (out + line).replace(/[ \t]+/g, ' ').trim();
        pages.push(text);
        chars += text.length;
        if (chars > TEXT_MAX) { textCut = i < n; break; }
      }
    } finally { await doc.destroy(); progress(null); }
    return pages.filter(Boolean).join('\n\n');
  }
  const xmlText = (xml, para, run) => (xml.match(new RegExp(`<${para}[ >][\\s\\S]*?</${para}>`, 'g')) || [])
    .map((p) => (p.match(new RegExp(`<${run}(?: [^>]*)?>([^<]*)</${run}>`, 'g')) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
    .map((t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim())
    .filter(Boolean);
  // The zip's central directory (read from the end of the file) → Map(name → { method, size, at })
  async function zipDir(file) {
    const bytes = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
    const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;
    const tailAt = Math.max(0, file.size - 65558), tail = await bytes(tailAt, file.size);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip');
    let count = u16(tail, e + 10), size = u32(tail, e + 12), off = u32(tail, e + 16);
    if (off === 0xFFFFFFFF || count === 0xFFFF) {                // ZIP64
      const loc = await bytes(tailAt + e - 20, tailAt + e);
      const z = await bytes(u64(loc, 8), u64(loc, 8) + 56);
      count = u64(z, 32); size = u64(z, 40); off = u64(z, 48);
    }
    const cd = await bytes(off, off + size), dir = new Map(), dec = new TextDecoder();
    for (let p = 0, k = 0; k < count && u32(cd, p) === 0x02014b50; k++) {
      const nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32);
      let comp = u32(cd, p + 20), at = u32(cd, p + 42);
      const usz = u32(cd, p + 24);
      for (let x = p + 46 + nl; x < p + 46 + nl + xl;) {            // ZIP64 extra field: sizes / offset that didn't fit
        const id = u16(cd, x), len = u16(cd, x + 2);
        if (id === 1) { let q = x + 4; if (usz === 0xFFFFFFFF) q += 8; if (comp === 0xFFFFFFFF) { comp = u64(cd, q); q += 8; } if (at === 0xFFFFFFFF) at = u64(cd, q); }
        x += 4 + len;
      }
      dir.set(dec.decode(cd.subarray(p + 46, p + 46 + nl)), { method: u16(cd, p + 10), size: comp, at });
      p += 46 + nl + xl + cl;
    }
    return dir;
  }
  async function zipEntryText(file, e) {
    const h = new Uint8Array(await file.slice(e.at, e.at + 30).arrayBuffer());
    const start = e.at + 30 + (h[26] | (h[27] << 8)) + (h[28] | (h[29] << 8));
    const data = file.slice(start, start + e.size);
    if (e.method === 0) return data.text();
    if (e.method !== 8) throw new Error('unsupported zip compression');
    return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  // .docx / .pptx: the named text parts, read straight from the zip (old browsers without DecompressionStream:
  // JSZip with the whole file, only for files that fit in memory)
  async function zipTexts(file, pick) {
    if (typeof DecompressionStream === 'function') {
      const dir = await zipDir(file), names = pick([...dir.keys()]), out = [];
      for (const n of names) out.push(await zipEntryText(file, dir.get(n)));
      return out;
    }
    if (file.size > DOC_BIG) throw new Error('This browser can’t read such a large file — try desktop Chrome, Edge or Firefox.');
    await loadScript(LIB.zip);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const names = pick(Object.keys(zip.files)), out = [];
    for (const n of names) out.push(await zip.file(n).async('string'));
    return out;
  }
  async function docxText(file) {
    const [xml] = await zipTexts(file, (names) => names.filter((n) => n === 'word/document.xml'));
    if (xml == null) throw new Error('This Word file has no document text.');
    return xmlText(xml, 'w:p', 'w:t').join('\n\n');
  }
  async function pptxText(file) {
    const slides = await zipTexts(file, (names) => names.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]));
    return slides.map((x) => xmlText(x, 'a:p', 'a:t').join('\n')).filter(Boolean).join('\n\n');
  }

  // ── YouTube captions, read in the browser (the user's own connection) ──
  function youtubeId(url) {
    const m = String(url).trim().match(/^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  async function youtubeCaptions(id) {
    const tries = ['lang=en', 'lang=en-US', 'lang=en-GB', 'lang=en&kind=asr'];
    for (const q of tries) {
      try {
        const res = await fetch(`https://www.youtube.com/api/timedtext?v=${id}&${q}&fmt=json3`);
        if (!res.ok) continue;
        const raw = await res.text();
        if (!raw.trim()) continue;
        const data = JSON.parse(raw);
        const text = (data.events || []).map((e) => (e.segs || []).map((s) => s.utf8 || '').join('')).join(' ').replace(/\s+/g, ' ').trim();
        if (text.length > 80) return text;
      } catch (e) { /* blocked or not JSON: try the next form */ }
    }
    return null;
  }

  // ── text path: TextRank, then one call ──
  async function packFromText(text, inputType) {
    const tr = window.PFTextRank.filter(text);
    if (tr.inputWords < 25) throw new Error('Add a bit more material — at least a few sentences.');
    $('spTrStat').hidden = false;
    $('spTrStat').textContent = tr.filtered
      ? `TextRank kept the ${tr.outputWords.toLocaleString()} most central words of ${tr.inputWords.toLocaleString()} (${Math.round(100 - 100 * tr.outputWords / tr.inputWords)}% fewer sent to the AI).`
      : `${tr.inputWords.toLocaleString()} words sent to the AI (short texts are sent in full).`;
    if (textCut) $('spTrStat').textContent += ' This document is very long, so only its first part (about 20 million characters) was read.';
    status('Making your key points, flashcards and quiz…', 'info');
    const r = await post({ type: 'studypack', text: tr.text, mode: state.mode, inputType });
    if (r.status === 200 && r.data.success) return r.data.pack;
    throw new Error(r.data.message || 'Something went wrong — please try again.');
  }

  // ── audio / video ──
  // PRIMARY: Groq Whisper. The recording is split here into pieces that fit one request each (Vercel's body limit):
  // MP3 is cut at frame boundaries; other formats are decoded and re-encoded as 16 kHz mono WAV, 90 s a piece.
  // Each piece's transcript comes back sealed; the last call turns them into the pack. SECONDARY (Whisper
  // unavailable, or a file the browser can't decode): chunked upload to Gemini, which listens to the file.
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const WHISPER_EXT = /\.(flac|mp3|mp4|mpeg|mpga|m4a|ogg|opus|wav|webm)$/i;
  // Non-MP3 audio is decoded to full PCM in memory before it is cut into WAV pieces; above this size that can
  // exhaust a phone's memory, so the user is warned first (not blocked). MP3 is cut without decoding.
  const LARGE_DECODE_BYTES = 20 * 1024 * 1024;
  const BIG_NOTE = 'Large non-MP3 files are processed in your browser and need a lot of memory — this works best on desktop, or convert to MP3 first.';
  const isMp3 = (f) => /^audio\/(mpeg|mp3)$/.test(f.type) || /\.mp3$/i.test(f.name);
  const needsDecode = (file, cfg) => !!(cfg && cfg.whisper) && !isMp3(file) && !(file.size <= cfg.pieceBytes && WHISPER_EXT.test(file.name));
  const bigDecode = (file, cfg) => needsDecode(file, cfg) && file.size > LARGE_DECODE_BYTES;
  const minutes = (s) => { const m = Math.max(1, Math.round(s / 60)); return m + (m === 1 ? ' minute' : ' minutes'); };
  const tooLong = (cfg) => `This recording is too long — try a shorter clip (up to ${minutes(cfg.maxSeconds)}).`;
  function mediaDuration(file) {
    return new Promise((resolve) => {
      const m = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio'), url = URL.createObjectURL(file);
      let settled = false;
      const done = (d) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
      m.preload = 'metadata';
      m.onloadedmetadata = () => done(m.duration);
      m.onerror = () => done(0);
      setTimeout(() => done(0), 8000);
      m.src = url;
    });
  }
  async function mp3Pieces(file, max) {
    const out = [];
    for (let start = 0, n = 1; start < file.size; n++) {
      let end = Math.min(file.size, start + max);
      if (end < file.size) {
        // cut just before an MPEG audio frame header, so every piece starts on a frame
        const back = Math.min(8192, end - start - 1), look = new Uint8Array(await file.slice(end - back, end).arrayBuffer());
        for (let i = look.length - 3; i > 0; i--) {
          if (look[i] === 0xFF && (look[i + 1] & 0xE6) === 0xE2 && (look[i + 2] & 0xF0) !== 0xF0 && (look[i + 2] & 0x0C) !== 0x0C) { end = end - back + i; break; }
        }
      }
      out.push({ blob: file.slice(start, end, 'audio/mpeg'), name: `part-${n}.mp3`, mime: 'audio/mpeg' });
      start = end;
    }
    return out;
  }
  async function wavPieces(file, seconds) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const audio = await new AC(1, 1, 16000).decodeAudioData(await file.arrayBuffer());   // resampled to 16 kHz
    const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    const per = 16000 * seconds, out = [];
    for (let s = 0, n = 1; s < audio.length; s += per, n++) {
      const len = Math.min(per, audio.length - s), v = new DataView(new ArrayBuffer(44 + len * 2));
      const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 2, true);
      for (let i = 0; i < len; i++) {
        let x = 0;
        for (const c of chans) x += c[s + i];
        v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x / chans.length)) * 0x7FFF, true);
      }
      out.push({ blob: new Blob([v], { type: 'audio/wav' }), name: `part-${n}.wav`, mime: 'audio/wav' });
    }
    return out;
  }
  // → pieces, or null when this browser can't split the file (then Gemini gets the whole file)
  async function splitForWhisper(file, cfg) {
    try {
      if (file.size <= cfg.pieceBytes && WHISPER_EXT.test(file.name)) return [{ blob: file, name: file.name, mime: file.type }];
      if (isMp3(file)) return await mp3Pieces(file, cfg.pieceBytes - 16384);
    } catch (e) { return null; }
    const secs = Math.max(10, Math.min(cfg.pieceSeconds, Math.floor((cfg.pieceBytes - 4096) / 32000)));
    try { return await wavPieces(file, secs); }
    catch (e) {
      // decode failed (unsupported codec, or out of memory): a large file gets the memory notice instead of a broken
      // state; a small one goes to the Gemini route, which needs no decoding
      if (file.size > LARGE_DECODE_BYTES) { $('spBigNote').hidden = false; throw new Error(BIG_NOTE); }
      return null;
    }
  }
  async function whisperJob(job, pieces) {
    const sealed = [];
    for (let i = 0; i < pieces.length; i++) {
      progress(i / pieces.length, pieces.length > 1 ? `Transcribing… part ${i + 1} of ${pieces.length}` : 'Transcribing…');
      const p = pieces[i];
      const r = await post({ type: 'studypack_audio_piece', job, index: i, data: await toBase64(p.blob), mime: p.mime || 'audio/mpeg', name: p.name });
      if (!(r.status === 200 && r.data.success)) return { error: r.data.error, message: r.data.message };
      sealed.push(r.data.piece);
    }
    progress(1, 'Writing your flashcards, quiz and notes…');
    status('Making your key points, flashcards and quiz…', 'info');
    const r = await post({ type: 'studypack_audio_pack', job, pieces: sealed, mode: state.mode });
    if (r.status === 200 && r.data.success) return { pack: r.data.pack };
    throw new Error(r.data.message || 'Something went wrong — please try again.');
  }
  async function geminiJob(file, start) {
    let token = start.token;
    const chunk = start.chunkBytes;
    status('Uploading your recording…', 'info');
    for (let offset = 0; offset < file.size; offset += chunk) {
      progress(offset / file.size, `Uploading… ${Math.round(100 * offset / file.size)}%`);
      const r = await post({ type: 'studypack_audio_chunk', token, offset, data: await toBase64(file.slice(offset, offset + chunk)) });
      if (!(r.status === 200 && r.data.success)) throw new Error(r.data.message || 'Upload failed — please try again.');
      if (r.data.done) token = r.data.token;
    }
    progress(1, 'Listening to your recording…');
    status('The AI is listening and writing your flashcards, quiz and notes…', 'info');
    for (let i = 0; i < 40; i++) {
      const r = await post({ type: 'studypack_audio_generate', token, mode: state.mode });
      if (r.status === 202 && r.data.processing) { await sleep(3000); continue; }
      if (r.status === 200 && r.data.success) return r.data.pack;
      throw new Error(r.data.message || 'Something went wrong — please try again.');
    }
    throw new Error('This recording is taking too long to process — try a shorter one.');
  }
  async function packFromMedia(file) {
    const cfg = state.audio;
    if (!cfg || !cfg.enabled) throw new Error('Audio and video uploads are switched off right now. Paste the text or a transcript instead.');
    if (file.size > cfg.maxBytes) throw new Error(`Audio and video files can be up to ${Math.round(cfg.maxBytes / 1048576)} MB.`);
    status('Preparing your recording…', 'info');
    const seconds = await mediaDuration(file);
    if (seconds > cfg.maxSeconds) throw new Error(tooLong(cfg));
    const pieces = cfg.whisper ? await splitForWhisper(file, cfg) : null;
    const base = { type: 'studypack_audio_start', mime: file.type, size: file.size, name: file.name, seconds: Math.round(seconds), mode: state.mode };
    const start = await post(Object.assign({ pieces: pieces ? pieces.length : 0, split: !!pieces }, base));
    if (!(start.status === 200 && start.data.success)) throw new Error(start.data.message || 'Upload failed — please try again.');
    if (start.data.route !== 'whisper') return geminiJob(file, start.data);
    const r = await whisperJob(start.data.job, pieces);
    if (r.pack) return r.pack;
    if (!(cfg.gemini && (r.error === 'whisper_unavailable' || r.error === 'bad_audio'))) throw new Error(r.message || 'Something went wrong — please try again.');
    // Whisper unavailable → Gemini listens to the file instead (same daily slot: the job token comes along)
    const again = await post(Object.assign({ split: false, job: start.data.job }, base));
    if (!(again.status === 200 && again.data.success)) throw new Error(again.data.message || r.message || 'The audio service is busy right now.');
    return geminiJob(file, again.data);
  }

  // ── generate ──
  async function generate() {
    status(''); progress(null); $('spTrStat').hidden = true;
    busy(true);
    ev('studypack_generate', { input: state.input, mode: state.mode });
    try {
      let pack;
      if (state.input === 'paste') pack = await packFromText($('spText').value, 'text');
      else if (state.input === 'file') {
        const f = state.file;
        if (!f) throw new Error('Choose a PDF, Word or PowerPoint file first.');
        const ext = f.name.split('.').pop().toLowerCase();
        checkDoc(f);
        textCut = false;
        status('Reading your file…', 'info');
        const text = ext === 'pdf' ? await pdfText(f) : ext === 'docx' ? await docxText(f) : ext === 'pptx' ? await pptxText(f) : null;
        if (text == null) throw new Error('Please choose a .pdf, .docx or .pptx file.');
        if (text.trim().length < 80) throw new Error(ext === 'pdf' ? 'This PDF has no readable text (it may be a scan). Try PDF to Word with OCR first, then upload the Word file.' : 'This file has very little text.');
        pack = await packFromText(text, ext);
      } else if (state.input === 'youtube') {
        const transcript = cleanTranscript($('spYtText').value);
        if (transcript) pack = await packFromText(transcript, 'youtube');      // the main route
        else {
          const url = $('spYtUrl').value.trim(), id = youtubeId(url);
          if (!url) { pointToPaste('Paste the video’s transcript first.'); return; }
          if (!id) throw new Error('Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…).');
          // captions, silently: usually blocked by YouTube, so a miss is not an error — just the paste route
          status('Checking the video for captions…', 'info');
          const captions = await youtubeCaptions(id);
          if (!captions) { pointToPaste('We couldn’t read this video’s captions automatically — paste its transcript instead.'); return; }
          pack = await packFromText(captions, 'youtube');
        }
      } else if (state.input === 'media') {
        if (!state.media) throw new Error('Choose an audio or video file first.');
        pack = await packFromMedia(state.media);
      }
      show(pack);
      status('');
      ev('studypack_ready', { input: state.input, mode: state.mode });
    } catch (e) {
      status(e.message || 'Something went wrong — please try again.', 'error');
    } finally {
      busy(false); progress(null);
    }
  }
  // YouTube timestamps ("0:00", "12:34", "1:02:03") on their own lines come along when the transcript is copied
  const cleanTranscript = (t) => String(t || '').split(/\r?\n/).filter((l) => !/^\s*\d{1,2}(?::\d{2}){1,2}\s*$/.test(l)).join('\n').trim();
  function pointToPaste(lead) {
    status(lead + ' ' + $('spYtHow').textContent, 'info');
    const box = $('spYtText');
    box.classList.remove('sp-yt-flash'); void box.offsetWidth; box.classList.add('sp-yt-flash');
    box.focus();
  }
  function ytAiOptions() {
    const a = state.audio, on = !!(a && a.enabled && a.gemini);
    $('spYtAiBox').hidden = !on;
    $('spYtAiNote').textContent = on ? `Optional. Uses one of today’s ${a.cap} audio/video packs.` : '';
  }
  // experimental: Gemini reads the public video from its link. ANY failure → the paste route, never a dead end.
  async function youtubeViaAi() {
    const url = $('spYtUrl').value.trim();
    if (!youtubeId(url)) { status('Add the video link above to try this.', 'info'); $('spYtUrl').focus(); return; }
    busy(true); progress(null);
    status('The AI is watching the video and writing your flashcards, quiz and notes…', 'info');
    try {
      const r = await post({ type: 'studypack_youtube', url, mode: state.mode });
      if (r.status === 200 && r.data.success) { show(r.data.pack); status(''); ev('studypack_ready', { input: 'youtube_ai', mode: state.mode }); return; }
      pointToPaste(r.data.error === 'audio_cap' ? (r.data.message || 'You’ve used today’s audio/video packs.') : 'The AI couldn’t read this video right now.');
    } catch (e) {
      pointToPaste('The AI couldn’t read this video right now.');
    } finally { busy(false); }
  }

  // ── output: Notes / Flashcards / Quiz (all from the one answer) ──
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(pack) {
    state.pack = pack; state.card = 0; state.flipped = false; state.answers = pack.quiz.map(() => null);
    $('spOut').hidden = false;
    $('spCountNotes').textContent = pack.key_points.length;
    $('spCountCards').textContent = pack.flashcards.length;
    $('spCountQuiz').textContent = pack.quiz.length;
    view('notes');
    $('spOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function view(name) {
    state.view = name;
    document.querySelectorAll('.sp-tab').forEach((t) => { const on = t.dataset.view === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    ['notes', 'cards', 'quiz'].forEach((v) => { $('spView-' + v).hidden = v !== name; });
    if (name === 'notes') renderNotes(); else if (name === 'cards') renderCard(); else renderQuiz();
  }
  function renderNotes() {
    const ol = $('spNotes');
    ol.textContent = '';
    state.pack.key_points.forEach((p) => ol.appendChild(el('li', null, p)));
  }
  function renderCard() {
    const c = state.pack.flashcards[state.card];
    const card = $('spCard');
    card.classList.toggle('flipped', state.flipped);
    $('spCardFront').textContent = c.front;
    $('spCardBack').textContent = c.back;
    card.setAttribute('aria-label', state.flipped ? 'Answer: ' + c.back : 'Question: ' + c.front + ' — select to show the answer');
    $('spCardPos').textContent = `${state.card + 1} / ${state.pack.flashcards.length}`;
    $('spPrev').disabled = state.card === 0;
    $('spNext').disabled = state.card === state.pack.flashcards.length - 1;
  }
  function moveCard(d) {
    const n = state.pack.flashcards.length;
    state.card = Math.max(0, Math.min(n - 1, state.card + d)); state.flipped = false; renderCard();
  }
  function renderQuiz() {
    const wrap = $('spQuiz');
    wrap.textContent = '';
    state.pack.quiz.forEach((q, qi) => {
      const box = el('fieldset', 'sp-q');
      box.appendChild(el('legend', null, `${qi + 1}. ${q.question}`));
      q.options.forEach((o, oi) => {
        const lab = el('label', 'sp-opt');
        const r = el('input'); r.type = 'radio'; r.name = 'spq' + qi; r.value = String(oi);
        r.checked = state.answers[qi] === oi; r.disabled = state.answers[qi] !== null;
        r.addEventListener('change', () => { state.answers[qi] = oi; renderQuiz(); });
        lab.appendChild(r); lab.appendChild(el('span', null, o));
        if (state.answers[qi] !== null) lab.classList.add(oi === q.answer_index ? 'sp-right' : oi === state.answers[qi] ? 'sp-wrong' : 'sp-dim');
        box.appendChild(lab);
      });
      if (state.answers[qi] !== null) {
        const good = state.answers[qi] === q.answer_index;
        box.appendChild(el('p', 'sp-expl ' + (good ? 'sp-ok' : 'sp-bad'), (good ? '✓ Correct. ' : '✗ Not quite. ') + (q.explanation || '')));
      }
      wrap.appendChild(box);
    });
    const done = state.answers.filter((a) => a !== null).length;
    const right = state.answers.filter((a, i) => a === state.pack.quiz[i].answer_index).length;
    $('spScore').textContent = done ? `Score: ${right} / ${done} answered (${state.pack.quiz.length} questions)` : '';
  }
  function notesText() {
    const p = state.pack;
    return 'KEY POINTS\n' + p.key_points.map((k, i) => `${i + 1}. ${k}`).join('\n') +
      '\n\nFLASHCARDS\n' + p.flashcards.map((c) => `Q: ${c.front}\nA: ${c.back}`).join('\n\n') +
      '\n\nQUIZ\n' + p.quiz.map((q, i) => `${i + 1}. ${q.question}\n` + q.options.map((o, j) => `   ${'ABCDEF'[j]}) ${o}`).join('\n') + `\n   Answer: ${'ABCDEF'[q.answer_index]} — ${q.explanation}`).join('\n\n');
  }

  // ── inputs ──
  function input(name) {
    state.input = name;
    document.querySelectorAll('.sp-in').forEach((t) => { const on = t.dataset.input === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    ['paste', 'file', 'youtube', 'media'].forEach((v) => { $('spIn-' + v).hidden = v !== name; });
    status('');
  }
  function wire() {
    document.querySelectorAll('.sp-in').forEach((t) => t.addEventListener('click', () => input(t.dataset.input)));
    document.querySelectorAll('.sp-tab').forEach((t) => t.addEventListener('click', () => view(t.dataset.view)));
    document.querySelectorAll('input[name="spMode"]').forEach((r) => r.addEventListener('change', () => { state.mode = r.value; }));
    $('spText').addEventListener('input', () => { $('spWords').textContent = window.PFTextRank.countWords($('spText').value) + ' words'; });
    $('spFile').addEventListener('change', (e) => {
      state.file = e.target.files[0] || null;
      $('spFileName').textContent = state.file ? '📄 ' + state.file.name + (state.file.size > DOC_BIG ? ` (${fmtMB(state.file.size)}) — large file: it is read on your device, which can take a minute. Works best on desktop Chrome or Edge${docTier() === 'basic' ? `; in this browser the limit is ${fmtMB(DOC_MAX.basic)}` : ''}.` : '') : '';
      status('');
      if (state.file) { try { checkDoc(state.file); } catch (err) { status(err.message, 'error'); } }
    });
    $('spMedia').addEventListener('change', (e) => {
      state.media = e.target.files[0] || null;
      $('spMediaName').textContent = state.media ? `🎧 ${state.media.name} (${(state.media.size / 1048576).toFixed(1)} MB)` : '';
      $('spBigNote').hidden = !(state.media && bigDecode(state.media, state.audio));   // shown before anything is processed
    });
    $('spGo').addEventListener('click', generate);
    $('spYtAi').addEventListener('click', youtubeViaAi);
    $('spCard').addEventListener('click', () => { state.flipped = !state.flipped; renderCard(); });
    $('spCard').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); state.flipped = !state.flipped; renderCard(); } });
    $('spPrev').addEventListener('click', () => moveCard(-1));
    $('spNext').addEventListener('click', () => moveCard(1));
    $('spCopy').addEventListener('click', () => {
      navigator.clipboard.writeText(notesText()).then(() => { $('spCopy').textContent = '✓ Copied'; setTimeout(() => { $('spCopy').textContent = '⎘ Copy all'; }, 1500); }).catch(() => {});
    });
    $('spDownload').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([notesText()], { type: 'text/plain' }));
      a.download = 'flashcards-quiz-notes.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    // nav: transparent over the hero, white once scrolled (as on the other pages)
    const nav = $('mainNav');
    const onScroll = () => { const s = window.scrollY > 20; nav.classList.toggle('pf-nav-scrolled', s); const l = $('navLogo'); if (l) l.src = s ? '/logo.svg' : '/logo-dark.svg'; };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }
  async function config() {
    try {
      const r = await post({ type: 'studypack_config' });
      if (r.status === 200 && r.data.success) state.audio = r.data.audio;
    } catch (e) {}
    const a = state.audio;
    $('spMediaNote').textContent = a && a.enabled
      ? `Up to ${Math.round(a.maxBytes / 1048576)} MB and ${minutes(a.maxSeconds)} · ${a.cap} audio/video packs per day. The recording is sent to our AI provider to be transcribed; ParaFree doesn’t save it.`
      : 'Audio and video uploads are switched off right now — paste the text or a transcript instead.';
    $('spMediaPick').hidden = !(a && a.enabled);
    ytAiOptions();
  }

  window.toggleMenu = function () { const m = $('mobileMenu'); if (m) m.style.display = m.style.display === 'flex' ? 'none' : 'flex'; };
  window.PFStudyPack = { state, generate, show, view, youtubeId, youtubeCaptions, LARGE_DECODE_BYTES };
  wire();
  config();
})();
