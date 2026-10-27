// ParaFree Study Pack — page logic (lib/studypack/app.js)
// Every input ends in ONE AI call that returns key points, flashcards and a quiz; the three tabs only re-render it.
//  paste / PDF / DOCX / PPTX / YouTube captions → text in the browser → TextRank pre-filter → {type:'studypack'}
//  YouTube without readable captions → paste the transcript, or {type:'studypack_youtube'} (Gemini reads the video)
//  audio / video → chunked upload relayed to Gemini → {type:'studypack_audio_generate'}; small files can fall back
//  to {type:'studypack_audio_whisper'}
(function () {
  'use strict';
  const API = '/api/process';
  const LIB = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js',
    zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  };
  const $ = (id) => document.getElementById(id);
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
    $('spGo').textContent = on ? 'Working…' : '✦ Make my study pack';
  }

  // ── client-side text extraction ──
  async function pdfText(file) {
    await loadScript(LIB.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      let line = '', out = '';
      tc.items.forEach((it) => { line += it.str; if (it.hasEOL) { out += line.trim() + '\n'; line = ''; } else line += ' '; });
      pages.push((out + line).replace(/[ \t]+/g, ' ').trim());
    }
    return pages.filter(Boolean).join('\n\n');
  }
  const xmlText = (xml, para, run) => (xml.match(new RegExp(`<${para}[ >][\\s\\S]*?</${para}>`, 'g')) || [])
    .map((p) => (p.match(new RegExp(`<${run}(?: [^>]*)?>([^<]*)</${run}>`, 'g')) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
    .map((t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim())
    .filter(Boolean);
  async function docxText(file) {
    await loadScript(LIB.zip);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const xml = await zip.file('word/document.xml').async('string');
    return xmlText(xml, 'w:p', 'w:t').join('\n\n');
  }
  async function pptxText(file) {
    await loadScript(LIB.zip);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
    const out = [];
    for (const f of slides) out.push(xmlText(await zip.file(f).async('string'), 'a:p', 'a:t').join('\n'));
    return out.filter(Boolean).join('\n\n');
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
    status('Making your key points, flashcards and quiz…', 'info');
    const r = await post({ type: 'studypack', text: tr.text, mode: state.mode, inputType });
    if (r.status === 200 && r.data.success) return r.data.pack;
    throw new Error(r.data.message || 'Something went wrong — please try again.');
  }

  // ── audio / video: chunked upload → one Gemini call; Whisper fallback for small files ──
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function whisperFallback(file) {
    status('Trying the backup transcription…', 'info');
    const r = await post({ type: 'studypack_audio_whisper', data: await toBase64(file), mime: file.type, name: file.name, mode: state.mode });
    if (r.status === 200 && r.data.success) return r.data.pack;
    throw new Error(r.data.message || 'The audio service is busy right now.');
  }
  async function packFromMedia(file) {
    const cfg = state.audio;
    if (!cfg || !cfg.enabled) throw new Error('Audio and video study packs are switched off right now. Paste the text or a transcript instead.');
    if (file.size > cfg.maxBytes) throw new Error(`Audio and video files can be up to ${Math.round(cfg.maxBytes / 1048576)} MB.`);
    const small = cfg.whisper && file.size <= cfg.whisperMaxBytes;
    if (!cfg.gemini) { if (small) return whisperFallback(file); throw new Error('Large audio is not available right now — try a clip under ' + Math.round(cfg.whisperMaxBytes / 1048576) + ' MB.'); }
    status('Uploading your recording…', 'info');
    const start = await post({ type: 'studypack_audio_start', mime: file.type, size: file.size, name: file.name, mode: state.mode });
    if (!(start.status === 200 && start.data.success)) {
      if (start.data.error === 'ai_unavailable' && small) return whisperFallback(file);
      throw new Error(start.data.message || 'Upload failed — please try again.');
    }
    let token = start.data.token;
    const chunk = start.data.chunkBytes;
    for (let offset = 0; offset < file.size; offset += chunk) {
      progress(offset / file.size, `Uploading… ${Math.round(100 * offset / file.size)}%`);
      const r = await post({ type: 'studypack_audio_chunk', token, offset, data: await toBase64(file.slice(offset, offset + chunk)) });
      if (!(r.status === 200 && r.data.success)) throw new Error(r.data.message || 'Upload failed — please try again.');
      if (r.data.done) token = r.data.token;
    }
    progress(1, 'Listening to your recording…');
    status('The AI is listening and writing your study pack…', 'info');
    for (let i = 0; i < 40; i++) {
      const r = await post({ type: 'studypack_audio_generate', token, mode: state.mode });
      if (r.status === 202 && r.data.processing) { await sleep(3000); continue; }
      if (r.status === 200 && r.data.success) return r.data.pack;
      if (r.data.error === 'ai_unavailable' && small) return whisperFallback(file);
      throw new Error(r.data.message || 'Something went wrong — please try again.');
    }
    throw new Error('This recording is taking too long to process — try a shorter one.');
  }

  // ── generate ──
  async function generate() {
    status(''); progress(null); $('spTrStat').hidden = true; $('spYtHelp').hidden = true;
    busy(true);
    ev('studypack_generate', { input: state.input, mode: state.mode });
    try {
      let pack;
      if (state.input === 'paste') pack = await packFromText($('spText').value, 'text');
      else if (state.input === 'file') {
        const f = state.file;
        if (!f) throw new Error('Choose a PDF, Word or PowerPoint file first.');
        const ext = f.name.split('.').pop().toLowerCase();
        status('Reading your file…', 'info');
        const text = ext === 'pdf' ? await pdfText(f) : ext === 'docx' ? await docxText(f) : ext === 'pptx' ? await pptxText(f) : null;
        if (text == null) throw new Error('Please choose a .pdf, .docx or .pptx file.');
        if (text.trim().length < 80) throw new Error(ext === 'pdf' ? 'This PDF has no readable text (it may be a scan). Try PDF to Word with OCR first, then upload the Word file.' : 'This file has very little text.');
        pack = await packFromText(text, ext);
      } else if (state.input === 'youtube') {
        const url = $('spYtUrl').value.trim(), id = youtubeId(url);
        if (!id) throw new Error('Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…).');
        status('Reading the video’s captions…', 'info');
        const captions = await youtubeCaptions(id);
        if (!captions) { state.ytUrl = url; showYtHelp(); status(''); return; }
        pack = await packFromText(captions, 'youtube');
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
  function showYtHelp() {
    const box = $('spYtHelp');
    box.hidden = false;
    $('spYtAi').hidden = !(state.audio && state.audio.enabled && state.audio.gemini);
    $('spYtAiNote').textContent = state.audio && state.audio.enabled ? `Uses one of today’s ${state.audio.cap} audio/video study packs.` : '';
  }
  async function youtubeViaAi() {
    $('spYtHelp').hidden = true;
    busy(true);
    status('The AI is watching the video and writing your study pack…', 'info');
    try {
      const r = await post({ type: 'studypack_youtube', url: state.ytUrl, mode: state.mode });
      if (!(r.status === 200 && r.data.success)) throw new Error(r.data.message || 'Something went wrong — please try again.');
      show(r.data.pack); status('');
    } catch (e) { status(e.message, 'error'); } finally { busy(false); }
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
    status(''); $('spYtHelp').hidden = true;
  }
  function wire() {
    document.querySelectorAll('.sp-in').forEach((t) => t.addEventListener('click', () => input(t.dataset.input)));
    document.querySelectorAll('.sp-tab').forEach((t) => t.addEventListener('click', () => view(t.dataset.view)));
    document.querySelectorAll('input[name="spMode"]').forEach((r) => r.addEventListener('change', () => { state.mode = r.value; }));
    $('spText').addEventListener('input', () => { $('spWords').textContent = window.PFTextRank.countWords($('spText').value) + ' words'; });
    $('spFile').addEventListener('change', (e) => { state.file = e.target.files[0] || null; $('spFileName').textContent = state.file ? '📄 ' + state.file.name : ''; });
    $('spMedia').addEventListener('change', (e) => {
      state.media = e.target.files[0] || null;
      $('spMediaName').textContent = state.media ? `🎧 ${state.media.name} (${(state.media.size / 1048576).toFixed(1)} MB)` : '';
    });
    $('spGo').addEventListener('click', generate);
    $('spYtPaste').addEventListener('click', () => { input('paste'); $('spText').focus(); status('Paste the transcript here, then select “Make my study pack”.', 'info'); });
    $('spYtAi').addEventListener('click', youtubeViaAi);
    $('spYtMedia').addEventListener('click', () => input('media'));
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
      a.download = 'study-pack.txt'; a.click();
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
      ? `Up to ${Math.round(a.maxBytes / 1048576)} MB · ${a.cap} audio/video study packs per day. The file is sent to our AI provider to be listened to, then deleted.`
      : 'Audio and video study packs are switched off right now — paste the text or a transcript instead.';
    $('spMediaPick').hidden = !(a && a.enabled);
  }

  window.toggleMenu = function () { const m = $('mobileMenu'); if (m) m.style.display = m.style.display === 'flex' ? 'none' : 'flex'; };
  window.PFStudyPack = { state, generate, show, view, youtubeId, youtubeCaptions };
  wire();
  config();
})();
