// ═══════════════════════════════════════════════════
// ParaFree — Study Pack (api/_studypack.js)
// One AI call turns study material into { key_points, flashcards, quiz }.
//  - text (pasted, or extracted in the browser from PDF / DOCX / PPTX / YouTube captions): the browser
//    pre-filters it with TextRank, then ONE request goes through the normal provider chain (Gemini first).
//  - audio / video, PRIMARY: Groq Whisper (its own quota, separate from the Gemini LLM pool, which the
//    paraphraser mostly uses up). The browser splits the recording into pieces that fit one request each
//    (MP3 cut at frame boundaries; anything else decoded and re-encoded as 16 kHz mono WAV, 90 s a piece);
//    each piece is transcribed by the next Groq key in turn (rate-limited keys sit out their cooldown) and
//    comes back SEALED, so the transcript never reaches the browser; then one text-chain call makes the pack
//    from the joined (TextRank-trimmed) transcript. All pieces or no pack — never a partial one.
//  - audio / video, SECONDARY (only when Whisper is unavailable): the file is relayed in chunks to the Gemini
//    Files API (the upload URL travels inside a sealed token), then ONE Gemini call listens to it.
//  - YouTube link without readable captions: Gemini reads the public video from its URL (Google fetches it,
//    not our server) — counted like an audio job.
//  Gemini media calls use a model that was PROBED to accept audio on our key (a tiny silent WAV), cached;
//  default candidate gemini-3.5-flash-lite, override STUDYPACK_GEMINI_MODEL.
// The prompt is always built here from {mode, inputType}; a client-supplied prompt is ignored.
// Audio switch + daily cap: env ENABLE_AUDIO / STUDYPACK_AUDIO_CAP, overridable at runtime (no redeploy) with
// the Upstash hash "studypack:cfg" fields audio ("0"/"1") and cap (number). Longest recording:
// STUDYPACK_AUDIO_MAX_MIN (default 60), Upstash field maxmin.
// ═══════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const MODES = {
  quick:    { key_points: 6,  flashcards: 8,  quiz: 5 },
  standard: { key_points: 10, flashcards: 12, quiz: 8 },
  exam:     { key_points: 12, flashcards: 15, quiz: 12 },
};
const SOURCES = {
  text: 'study notes', pdf: 'document (from a PDF)', docx: 'document (from a Word file)', pptx: 'lecture slides',
  youtube: 'lecture transcript (YouTube captions)', audio: 'lecture recording', video: 'lecture video',
  transcript: 'lecture transcript (from a recording)',
};
const MIN_ITEMS = 3;                       // fewer valid items than this in any section = not a usable pack
const MAX_TEXT_CHARS = 60000;              // the browser sends at most ~4,000 TextRank-selected words
const AUDIO_DEFAULTS = { enabled: true, cap: 5, maxMinutes: 60 };   // launch: audio on, 5 audio/video/YouTube-AI jobs per IP per UTC day
const AUDIO_MAX_BYTES = 50 * 1024 * 1024;           // 50 MB per file
const CHUNK_BYTES = 9 * 256 * 1024;                 // 2.25 MiB raw (Gemini upload granularity 256 KiB; ~3 MB as base64, under Vercel's 4.5 MB body limit)
// One Whisper piece per request. Groq accepts ~25 MB per request, but a piece has to travel browser → Vercel
// first, and Vercel's request body limit is 4.5 MB: 3 MiB raw is ~4.2 MB as base64.
const WHISPER_MAX_BYTES = 3 * 1024 * 1024;
const PIECE_SECONDS = 90;                           // re-encoded WAV pieces: 16 kHz mono 16-bit, 90 s ≈ 2.9 MB
const WHISPER_MODEL = 'whisper-large-v3-turbo';
const WHISPER_TIMEOUT_MS = 25000;
const PIECE_BUDGET_MS = 50000;                      // a piece request (all key attempts) ends inside the 60 s maxDuration
const GEMINI_AUDIO_DEFAULT = 'gemini-3.5-flash-lite';
const PROBE_OK_MS = 6 * 60 * 60 * 1000, PROBE_NONE_MS = 60 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_TYPES = /^(audio|video)\/[\w.+-]+$/;
const WHISPER_EXT = /\.(flac|mp3|mp4|mpeg|mpga|m4a|ogg|opus|wav|webm)$/i;   // formats Groq Whisper accepts
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const TextRank = require('../lib/studypack/textrank.js');

const modeOf = (m) => (Object.prototype.hasOwnProperty.call(MODES, m) ? m : 'standard');
const inputOf = (t) => (Object.prototype.hasOwnProperty.call(SOURCES, t) ? t : 'text');

// ── Prompt (server-side only) ──
function buildPrompt(mode, inputType, media) {
  const n = MODES[modeOf(mode)], src = SOURCES[inputOf(inputType)];
  return [
    media
      ? `Listen to the attached ${src} and create study material from what is said in it. Do NOT include a transcript or long quotes.`
      : `Create study material from the ${src} below.`,
    'Return ONLY one JSON object — no markdown, no code fences, no text before or after it — with exactly this shape:',
    '{"key_points":["..."],"flashcards":[{"front":"...","back":"..."}],"quiz":[{"question":"...","options":["...","...","...","..."],"answer_index":0,"explanation":"..."}]}',
    'Rules:',
    `- key_points: ${n.key_points} concise points covering the most important ideas, one sentence each.`,
    `- flashcards: ${n.flashcards} cards; "front" is a question or term, "back" a short answer (at most 25 words).`,
    `- quiz: ${n.quiz} multiple-choice questions, exactly 4 options each, exactly one correct; "answer_index" is the 0-based index of the correct option; "explanation" is one sentence saying why it is correct.`,
    '- Use only information from the material. Do not invent facts, names, dates or numbers.',
    '- Write in the same language as the material.',
    '- Valid JSON: double quotes, escape quotes inside strings, no trailing commas.',
    media ? '' : '\nMaterial:',
  ].join('\n');
}

// ── JSON: parse, repair, validate ──
// Cut a truncated JSON text back to the last complete array element and close the open brackets.
function closeTruncated(s) {
  const stack = [];
  let inStr = false, esc = false, lastGood = -1, lastStack = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length && stack[stack.length - 1] === '[') { lastGood = i; lastStack = stack.slice(); }
      if (!stack.length) return s.slice(0, i + 1);
    }
  }
  if (lastGood < 0) return null;
  return s.slice(0, lastGood + 1) + lastStack.reverse().map((c) => (c === '[' ? ']' : '}')).join('');
}
function looseParse(raw) {
  let s = String(raw || '').replace(/^﻿/, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = s.indexOf('{');
  if (a < 0) return null;
  s = s.slice(a);
  const attempts = [
    (x) => x,
    (x) => x.slice(0, x.lastIndexOf('}') + 1),
    (x) => x.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1'),
    (x) => closeTruncated(x.replace(/,\s*([}\]])/g, '$1')),
  ];
  for (const f of attempts) {
    try { const t = f(s); if (t) return JSON.parse(t); } catch (_) {}
  }
  return null;
}
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Keeps only well-formed items; returns null unless every section has at least MIN_ITEMS of them.
function validatePack(obj, mode) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const n = MODES[modeOf(mode)], cap = (k) => n[k] + 3;
  const key_points = (Array.isArray(obj.key_points) ? obj.key_points : []).map((p) => str(p, 400)).filter(Boolean).slice(0, cap('key_points'));
  const flashcards = (Array.isArray(obj.flashcards) ? obj.flashcards : [])
    .map((c) => (c && typeof c === 'object' ? { front: str(c.front, 300), back: str(c.back, 400) } : null))
    .filter((c) => c && c.front && c.back).slice(0, cap('flashcards'));
  const quiz = (Array.isArray(obj.quiz) ? obj.quiz : []).map((q) => {
    if (!q || typeof q !== 'object' || !Array.isArray(q.options)) return null;
    const options = q.options.map((o) => str(typeof o === 'number' ? String(o) : o, 200)).filter(Boolean);
    const answer_index = Number(q.answer_index);
    if (options.length < 2 || options.length > 6 || new Set(options).size !== options.length) return null;
    if (!Number.isInteger(answer_index) || answer_index < 0 || answer_index >= options.length) return null;
    const question = str(q.question, 400);
    return question ? { question, options, answer_index, explanation: str(q.explanation, 400) } : null;
  }).filter(Boolean).slice(0, cap('quiz'));
  if (key_points.length < MIN_ITEMS || flashcards.length < MIN_ITEMS || quiz.length < MIN_ITEMS) return null;
  return { key_points, flashcards, quiz };
}
const parsePack = (raw, mode) => validatePack(looseParse(raw), mode);

// ── Sealed tokens (AES-256-GCM): carry the Gemini upload URL / file name to the browser and back, unreadable there ──
function tokenKey(env) {
  const secret = env.STUDYPACK_SECRET || env.GEMINI_KEY || env.GEMINI_KEY_2 || env.GROQ_KEY || '';
  return secret ? crypto.createHash('sha256').update('pf-studypack:' + secret).digest() : null;
}
function seal(env, data) {
  const key = tokenKey(env);
  if (!key) throw new Error('no token key');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(Object.assign({ exp: Date.now() + TOKEN_TTL_MS }, data)), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
function unseal(env, token) {
  try {
    const key = tokenKey(env), b = Buffer.from(String(token || ''), 'base64url');
    if (!key || b.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch (_) { return null; }
}

// ── Audio switch + per-IP daily cap ──
async function audioConfig(env, redis) {
  let enabled = env.ENABLE_AUDIO === undefined ? AUDIO_DEFAULTS.enabled : !/^(0|false|off|no)$/i.test(String(env.ENABLE_AUDIO));
  const num = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(+v);
  let cap = num(env.STUDYPACK_AUDIO_CAP) ? +env.STUDYPACK_AUDIO_CAP : AUDIO_DEFAULTS.cap;
  let maxMinutes = num(env.STUDYPACK_AUDIO_MAX_MIN) ? +env.STUDYPACK_AUDIO_MAX_MIN : AUDIO_DEFAULTS.maxMinutes;
  if (redis && redis.hgetall) {
    try {
      const o = await redis.hgetall('studypack:cfg');
      if (o && o.audio !== undefined && o.audio !== null) enabled = /^(1|true|on|yes)$/i.test(String(o.audio));
      if (o && num(o.cap)) cap = +o.cap;
      if (o && num(o.maxmin)) maxMinutes = +o.maxmin;
    } catch (_) {}
  }
  const gemini = !!(env.GEMINI_KEY || env.GEMINI_KEY_2), whisper = whisperKeys(env).length > 0;
  return { enabled: enabled && (gemini || whisper), cap: Math.max(0, Math.floor(cap)), maxMinutes: Math.max(1, maxMinutes), gemini, whisper };
}
const tooLongMsg = (a) => `This recording is too long — try a shorter clip (up to ${a.maxMinutes} minute${a.maxMinutes === 1 ? '' : 's'}).`;
// Pieces a job may have: the longest allowed recording in 90 s WAV pieces, or a 50 MB MP3 in 3 MiB pieces.
const maxPieces = (a) => Math.max(Math.ceil(a.maxMinutes * 60 / PIECE_SECONDS), Math.ceil(AUDIO_MAX_BYTES / WHISPER_MAX_BYTES)) + 1;
const memCount = new Map();                 // per instance, used when Upstash is not configured
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ipKey = (ip) => crypto.createHash('sha256').update('pf-ip:' + ip).digest('hex').slice(0, 16);   // no raw IPs stored
async function countUse(redis, key, ttlSec) {
  let used;
  if (redis && redis.incr) {
    try { used = await redis.incr(key); if (used === 1 && redis.expire) redis.expire(key, ttlSec).catch(() => {}); } catch (_) { used = undefined; }
  }
  if (used === undefined) {
    if (memCount.size > 5000) memCount.clear();
    used = (memCount.get(key) || 0) + 1;
    memCount.set(key, used);
  }
  return used;
}
async function takeAudioSlot(redis, ip, cap) {
  const used = await countUse(redis, 'studypack:audio:' + dayOf() + ':' + ipKey(ip), 2 * 86400);
  return { ok: used <= cap, used, remaining: Math.max(0, cap - used) };
}
// A job's own limits: one Gemini fallback, and each piece sent at most twice (one retry) — so a job token can't be
// replayed to skip the daily cap or to spend our Whisper quota.
// Job tokens carry the piece count n; piece tokens (j, i, t) and Gemini upload tokens don't, so neither passes as a job.
const isJob = (t) => !!(t && t.j && Number.isInteger(t.n) && t.n >= 1);
const jobUse = (redis, j, what) => countUse(redis, 'studypack:job:' + j + ':' + what, Math.ceil(TOKEN_TTL_MS / 1000));

// ── Gemini Files API + generateContent ──
async function geminiStartUpload(fetchFn, key, mime, size, name) {
  const res = await fetchFn(`${GEMINI_BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: String(name || 'studypack').slice(0, 80) } }),
  });
  const url = res.ok && res.headers && res.headers.get('x-goog-upload-url');
  if (!url) throw new Error('gemini upload start: ' + res.status);
  return url;
}
async function geminiUploadChunk(fetchFn, url, offset, buf, last) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': String(offset), 'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload', 'Content-Length': String(buf.length) },
    body: buf, signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error('gemini upload chunk: ' + res.status);
  return last ? (await res.json()).file : null;
}
async function geminiGetFile(fetchFn, key, name) {
  const res = await fetchFn(`${GEMINI_BASE}/v1beta/${name}?key=${key}`, { method: 'GET' });
  if (!res.ok) throw new Error('gemini file: ' + res.status);
  return res.json();
}
function geminiDeleteFile(fetchFn, key, name) {
  return Promise.resolve(fetchFn(`${GEMINI_BASE}/v1beta/${name}?key=${key}`, { method: 'DELETE' })).catch(() => {});
}
async function geminiGenerate(fetchFn, key, model, filePart, prompt, ms, cd) {
  const res = await fetchFn(`${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', signal: AbortSignal.timeout(ms),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: filePart }, { text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) { let b = ''; try { b = await res.text(); } catch (_) {} throw new Error(`Gemini/${model}:${res.status} ${cd.detail(res, b)}`); }
  const data = await res.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return parts ? parts.map((p) => p.text || '').join('') : '';
}
// Cooldown names match the text chain ("gemini/<model>", "gemini-2/<model>"), so a daily quota hit here also
// makes the chain skip that model, and the other way round.
const geminiSlot = (keyIndex, model) => (keyIndex === 2 ? 'gemini-2/' : 'gemini/') + model;
const geminiKeyOf = (env, keyIndex) => (keyIndex === 2 ? env.GEMINI_KEY_2 : env.GEMINI_KEY);
const geminiCandidates = (env) => [...new Set([env.STUDYPACK_GEMINI_MODEL, GEMINI_AUDIO_DEFAULT, 'gemini-3.5-flash'].filter(Boolean))];

// Audio probe: 0.25 s of silence (16-bit mono WAV, 8 kHz) — 200 means the model takes audio input on this key.
const SILENT_WAV = (() => {
  const n = 2000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b.toString('base64');
})();
async function geminiProbeAudio(fetchFn, key, model, slot, cd) {
  try {
    const res = await fetchFn(`${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'audio/wav', data: SILENT_WAV } }, { text: 'Reply with the single word OK.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 5 } }),
    });
    if (res.ok) return 'ok';
    let b = ''; try { b = await res.text(); } catch (_) {}
    if (res.status === 429) { cd.start(slot, `Gemini/${model}:429 ${cd.detail(res, b)}`); return 'busy'; }
    return res.status >= 500 ? 'busy' : 'no';           // 400 (no audio input) / 404 (no such model on this key)
  } catch (_) { return 'busy'; }                        // network / timeout: says nothing about audio support
}
// The audio-capable model for this key: cached result (memory, then Upstash), else probe the candidates in order.
// "none" is cached only when every candidate really refused audio — not when they were just rate-limited.
const probeCache = new Map();
async function geminiAudioModel(fetchFn, env, redis, keyIndex, cd) {
  const now = Date.now(), rkey = 'studypack:gaudio:' + keyIndex;
  let hit = probeCache.get(keyIndex);
  if (!hit && redis && redis.get) { try { hit = await redis.get(rkey); if (hit) probeCache.set(keyIndex, hit); } catch (_) {} }
  if (hit && hit.until > now && geminiCandidates(env).concat([null]).includes(hit.model) && (!hit.model || !cd.isCooling(geminiSlot(keyIndex, hit.model)))) return hit.model;
  const key = geminiKeyOf(env, keyIndex);
  let busy = false;
  for (const model of geminiCandidates(env)) {
    const slot = geminiSlot(keyIndex, model);
    if (cd.isCooling(slot)) { busy = true; continue; }
    const r = await geminiProbeAudio(fetchFn, key, model, slot, cd);
    if (r === 'ok') { hit = { model, until: now + PROBE_OK_MS }; break; }
    if (r === 'busy') busy = true;
    console.error(`[StudyPack] audio probe ${slot}: ${r === 'no' ? 'no audio input' : 'busy'}`);
    hit = null;
  }
  if (!hit && busy) return null;
  if (!hit) hit = { model: null, until: now + PROBE_NONE_MS };
  probeCache.set(keyIndex, hit);
  if (redis && redis.set) { try { await redis.set(rkey, hit, { ex: Math.ceil((hit.until - now) / 1000) }); } catch (_) {} }
  return hit.model;
}
// One Gemini call with the media; one invalid answer is re-requested once. Everything stays inside the function's
// 60 s (maxDuration): no new attempt with less than 10 s left.
const MEDIA_BUDGET_MS = 52000;
async function geminiPack(fetchFn, env, keyIndex, model, filePart, mode, inputType, cd) {
  const deadline = Date.now() + MEDIA_BUDGET_MS, key = geminiKeyOf(env, keyIndex);
  const prompt = buildPrompt(mode, inputType, true);
  let invalid = 0, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 10000) break;
    try {
      const pack = parsePack(await geminiGenerate(fetchFn, key, model, filePart, prompt, left, cd), mode);
      if (pack) return { pack, model };
      invalid++;
    } catch (e) {
      lastErr = e;
      if (/:429\b/.test(e.message)) cd.start(geminiSlot(keyIndex, model), e.message);
      break;
    }
  }
  return { error: invalid && !lastErr ? 'invalid_output' : 'ai_unavailable', detail: lastErr && lastErr.message };
}

// ── Groq Whisper (primary transcription), spread over the Groq keys like the text chain ──
const whisperKeys = (env) => [['groq', env.GROQ_KEY], ['groq-2', env.GROQ_KEY_2], ['groq-3', env.GROQ_KEY_3], ['groq-4', env.GROQ_KEY_4]]
  .filter(([, k]) => k).map(([n, key]) => ({ name: n + '/' + WHISPER_MODEL, key }));
let whisperTurn = 0;
const whisperReady = (env, cd) => whisperKeys(env).some((k) => !cd.isCooling(k.name));
async function whisperTranscribe(fetchFn, key, buf, mime, name, ms, cd) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), name);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');
  const res = await fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(ms) });
  if (!res.ok) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    throw Object.assign(new Error(`whisper:${res.status} ${cd.detail(res, b)}`), { status: res.status });
  }
  return String(await res.text()).trim();
}
// Next key in turn; a 429 starts that key's cooldown and the next key tries. → {text} or {error}
async function transcribePiece(fetchFn, env, cd, buf, mime, name) {
  const deadline = Date.now() + PIECE_BUDGET_MS, keys = whisperKeys(env);
  const start = keys.length ? whisperTurn++ % keys.length : 0;
  let timedOut = false;
  for (const k of keys.slice(start).concat(keys.slice(0, start))) {
    if (cd.isCooling(k.name)) continue;
    const left = deadline - Date.now();
    if (left < 5000) { timedOut = true; break; }
    try { return { text: await whisperTranscribe(fetchFn, k.key, buf, mime, name, Math.min(WHISPER_TIMEOUT_MS, left), cd), key: k.name }; }
    catch (e) {
      console.error(`[StudyPack] ${k.name}:`, String(e.message).slice(0, 160));
      if (e.name === 'TimeoutError' || e.name === 'AbortError') { timedOut = true; continue; }
      timedOut = false;
      if (e.status === 413) return { error: 'too_large' };
      if (e.status === 400 || e.status === 415) return { error: 'bad_audio' };      // the same file fails on every key
      if (e.status === 429 || /quota|rate.?limit/i.test(e.message)) cd.start(k.name, e.message);
    }
  }
  return { error: timedOut ? 'too_long' : 'whisper_unavailable' };
}
// Used when api/process.js passes no cooldown store (tests of this module alone)
const localCool = new Map();
const LOCAL_CD = {
  isCooling: (n) => (localCool.get(n) || 0) > Date.now(),
  start: (n, msg) => localCool.set(n, Date.now() + (/per.?day|daily/i.test(msg) ? 15 * 60000 : 60000)),
  detail: (res, b) => String(b || '').slice(0, 200),
};

// ── Request handling ──
const fail = (status, error, message, extra) => ({ status, body: Object.assign({ success: false, error, message }, extra || {}) });
const ok = (body) => ({ status: 200, body: Object.assign({ success: true }, body) });
const YT_RE = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/;

// ctx: { env, redis, ip, fetch, rateLimit(text) → {allowed, message}, runText(text, prompt, accept) → chain result,
//        cooldown: { isCooling(name), start(name, msg), detail(res, body) } — the text chain's cooldown store }
const BUSY_AUDIO = 'The audio service is busy right now. Please try again in a few minutes, or paste a transcript instead.';
const INVALID = 'The AI answer could not be turned into a study pack. Please try again.';
async function handle(body, ctx) {
  const { env, redis, ip } = ctx, fetchFn = ctx.fetch || fetch, cd = ctx.cooldown || LOCAL_CD;
  const type = body.type, mode = modeOf(body.mode);
  // text → one chain call; invalid JSON = that provider failed, the next one tries once, then a clean error
  const packFromText = async (text, inputType) => {
    let pack = null, invalid = 0;
    const r = await ctx.runText(text, buildPrompt(mode, inputType, false), (raw) => {
      const p = parsePack(raw, mode);
      if (p) { pack = p; return true; }
      invalid++;
      return invalid > 1 ? 'stop' : false;            // re-request once, then give up
    });
    if (pack) return { pack };
    if (invalid) return { fail: fail(502, 'invalid_output', INVALID) };
    return { fail: fail(503, 'high_demand', 'Our AI is busy right now. Please wait a few seconds and try again.', { apiStatuses: r && r.apiStatuses }) };
  };

  if (type === 'studypack_config') {
    const a = await audioConfig(env, redis);
    return ok({ audio: { enabled: a.enabled, cap: a.cap, maxBytes: AUDIO_MAX_BYTES, maxSeconds: a.maxMinutes * 60, chunkBytes: CHUNK_BYTES,
      pieceBytes: WHISPER_MAX_BYTES, pieceSeconds: PIECE_SECONDS, whisper: a.whisper && whisperReady(env, cd), gemini: a.gemini },
      modes: Object.keys(MODES) });
  }

  if (type === 'studypack') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 80) return fail(400, 'too_short', 'Add a bit more material — at least a few sentences.');
    if (text.length > MAX_TEXT_CHARS) return fail(400, 'too_long', 'This is too long to send in one go. Try a shorter section.');
    const rate = ctx.rateLimit(text);
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    const inputType = inputOf(body.inputType);
    const r = await packFromText(text, inputType);
    return r.pack ? ok({ pack: r.pack, inputType, mode }) : r.fail;
  }

  // start an audio / video job, or YouTube via AI: switch → rate limit → checks → daily cap (one slot per job)
  if (type === 'studypack_audio_start' || type === 'studypack_youtube') {
    const a = await audioConfig(env, redis);
    if (!a.enabled) return fail(403, 'audio_disabled', 'Audio and video study packs are switched off right now. Paste the text or a transcript instead.');
    const rate = ctx.rateLimit(type + ':' + (body.name || body.url || ''));
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    const capFail = () => fail(429, 'audio_cap', `You’ve used today’s ${a.cap} audio/video study packs. Paste text or a transcript instead, or come back tomorrow.`, { cap: a.cap });
    const keyIndex = env.GEMINI_KEY ? 1 : 2;

    if (type === 'studypack_youtube') {
      if (!YT_RE.test(String(body.url || ''))) return fail(400, 'bad_url', 'That doesn’t look like a YouTube video link.');
      const model = a.gemini ? await geminiAudioModel(fetchFn, env, redis, keyIndex, cd) : null;
      if (!model) return fail(503, 'ai_unavailable', 'The AI can’t watch YouTube videos right now. Paste the transcript instead, or upload the audio.');
      const slot = await takeAudioSlot(redis, ip, a.cap);
      if (!slot.ok) return capFail();
      const r = await geminiPack(fetchFn, env, keyIndex, model, { file_uri: String(body.url).match(YT_RE)[0] }, mode, 'video', cd);
      if (r.pack) return ok({ pack: r.pack, inputType: 'youtube', mode, remaining: slot.remaining });
      console.error('[StudyPack] youtube:', r.error, r.detail || '');
      return r.error === 'invalid_output' ? fail(502, 'invalid_output', INVALID)
        : fail(503, 'ai_unavailable', 'The AI couldn’t read this video right now. Paste the transcript instead, or upload the audio.');
    }

    const size = +body.size, mime = String(body.mime || '');
    if (!MEDIA_TYPES.test(mime)) return fail(400, 'bad_type', 'Please choose an audio or video file.');
    if (!(size > 0) || size > AUDIO_MAX_BYTES) return fail(413, 'too_large', `Audio and video files can be up to ${AUDIO_MAX_BYTES / 1048576} MB.`);
    if (+body.seconds > a.maxMinutes * 60) return fail(413, 'too_long', tooLongMsg(a), { maxSeconds: a.maxMinutes * 60 });
    const prior = body.job ? unseal(env, body.job) : null;       // a Whisper job falling back to Gemini keeps its slot (once)
    const pieces = +body.pieces;
    // PRIMARY: Groq Whisper, piece by piece
    if (!prior && body.split !== false && a.whisper && whisperReady(env, cd) && Number.isInteger(pieces) && pieces >= 1) {
      if (pieces > maxPieces(a)) return fail(413, 'too_long', tooLongMsg(a), { maxSeconds: a.maxMinutes * 60 });
      const slot = await takeAudioSlot(redis, ip, a.cap);
      if (!slot.ok) return capFail();
      const j = crypto.randomBytes(9).toString('base64url');
      return ok({ route: 'whisper', job: seal(env, { j, n: pieces, mt: mime }), pieces, remaining: slot.remaining });
    }
    // SECONDARY: Gemini listens to the whole file (Whisper unavailable, or the browser could not split the file)
    const model = a.gemini ? await geminiAudioModel(fetchFn, env, redis, keyIndex, cd) : null;
    if (!model) return fail(503, 'ai_unavailable', BUSY_AUDIO);
    let remaining;
    if (!(isJob(prior) && (await jobUse(redis, prior.j, 'fallback')) === 1)) {
      const slot = await takeAudioSlot(redis, ip, a.cap);
      if (!slot.ok) return capFail();
      remaining = slot.remaining;
    }
    try {
      const url = await geminiStartUpload(fetchFn, geminiKeyOf(env, keyIndex), mime, size, body.name);
      return ok({ route: 'gemini', token: seal(env, { u: url, k: keyIndex, md: model, m: mime, s: size }), chunkBytes: CHUNK_BYTES, remaining });
    } catch (e) {
      console.error('[StudyPack] audio start:', e.message);
      return fail(503, 'ai_unavailable', BUSY_AUDIO);
    }
  }

  // Whisper: one piece → its transcript, sealed (the browser only carries it back for the final call)
  if (type === 'studypack_audio_piece') {
    const job = unseal(env, body.job), index = +body.index;
    if (!isJob(job)) return fail(400, 'bad_token', 'This upload expired — please choose the file again.');
    if (!Number.isInteger(index) || index < 0 || index >= job.n) return fail(400, 'bad_piece', 'Upload error — please try again.');
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (!buf.length) return fail(400, 'bad_piece', 'Upload error — please try again.');
    if (buf.length > WHISPER_MAX_BYTES) return fail(413, 'too_large', 'This part of the recording is too large — please try again.');
    const rate = ctx.rateLimit('studypack_piece:' + job.j + ':' + index);
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    if ((await jobUse(redis, job.j, 'piece' + index)) > 2) return fail(429, 'piece_retries', 'This upload was retried too often — please choose the file again.');
    const mime = MEDIA_TYPES.test(String(body.mime || '')) ? String(body.mime) : 'audio/mpeg';
    const ext = (String(body.name || '').match(WHISPER_EXT) || [null, mime === 'audio/wav' ? 'wav' : 'mp3'])[1].toLowerCase();
    const r = await transcribePiece(fetchFn, env, cd, buf, mime, `part-${index + 1}.${ext}`);
    if (r.error === 'too_long') return fail(504, 'too_long', 'This recording took too long to transcribe — try a shorter clip.');
    if (r.error === 'too_large') return fail(413, 'too_large', 'This part of the recording is too large — please try again.');
    if (r.error === 'bad_audio') return fail(422, 'bad_audio', 'We couldn’t read the audio in this file. Try an MP3 or M4A file.');
    if (r.error) return fail(503, 'whisper_unavailable', BUSY_AUDIO);
    return ok({ piece: seal(env, { j: job.j, i: index, t: r.text }), index });
  }

  // Whisper: every piece's transcript → joined → TextRank → ONE text-chain call. All pieces or nothing.
  if (type === 'studypack_audio_pack') {
    const job = unseal(env, body.job);
    if (!isJob(job)) return fail(400, 'bad_token', 'This upload expired — please choose the file again.');
    const list = Array.isArray(body.pieces) ? body.pieces : [];
    const texts = new Array(job.n);
    for (const tok of list.length === job.n ? list : []) {
      const p = unseal(env, tok);
      if (p && p.j === job.j && Number.isInteger(p.i) && p.i >= 0 && p.i < job.n && texts[p.i] === undefined) texts[p.i] = String(p.t || '');
    }
    if (texts.filter((t) => t !== undefined).length !== job.n)
      return fail(400, 'incomplete', 'Part of the recording is missing — please try again.');
    const transcript = texts.join(' ').replace(/\s+/g, ' ').trim();
    if (transcript.length < 80) return fail(422, 'no_speech', 'Not enough speech was found in this recording.');
    const rate = ctx.rateLimit('studypack_pack:' + job.j);
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    const r = await packFromText(TextRank.filter(transcript).text.slice(0, MAX_TEXT_CHARS), 'transcript');
    return r.pack ? ok({ pack: r.pack, inputType: String(job.mt).startsWith('video/') ? 'video' : 'audio', mode, via: 'whisper' }) : r.fail;
  }

  // Gemini chunk relay: only with a valid token, in order, never beyond the declared size
  if (type === 'studypack_audio_chunk') {
    const t = unseal(env, body.token);
    if (!t || !t.u) return fail(400, 'bad_token', 'This upload expired — please choose the file again.');
    const offset = +body.offset, buf = Buffer.from(String(body.data || ''), 'base64');
    const last = offset + buf.length >= t.s;
    if (!Number.isInteger(offset) || offset < 0 || !buf.length || buf.length > CHUNK_BYTES || offset + buf.length > t.s || (!last && buf.length % (256 * 1024)))
      return fail(400, 'bad_chunk', 'Upload error — please try again.');
    try {
      const file = await geminiUploadChunk(fetchFn, t.u, offset, buf, last);
      if (!last) return ok({ next: offset + buf.length });
      return ok({ done: true, token: seal(env, { f: file.name, uri: file.uri, k: t.k, md: t.md, m: file.mimeType || t.m }) });
    } catch (e) {
      console.error('[StudyPack] chunk:', e.message);
      return fail(503, 'ai_unavailable', 'Upload failed — please try again.');
    }
  }

  // Gemini: generate from the uploaded file (once it is processed); the file is deleted afterwards
  if (type === 'studypack_audio_generate') {
    const t = unseal(env, body.token);
    if (!t || !t.f) return fail(400, 'bad_token', 'This upload expired — please choose the file again.');
    const key = geminiKeyOf(env, t.k);
    try {
      const f = await geminiGetFile(fetchFn, key, t.f);
      if (f.state === 'PROCESSING') return { status: 202, body: { success: false, processing: true, message: 'Still processing the recording…' } };
      if (f.state && f.state !== 'ACTIVE') throw new Error('file state ' + f.state);
    } catch (e) {
      console.error('[StudyPack] file:', e.message);
      return fail(503, 'ai_unavailable', BUSY_AUDIO);
    }
    const inputType = String(t.m).startsWith('video/') ? 'video' : 'audio';
    const r = await geminiPack(fetchFn, env, t.k, t.md || GEMINI_AUDIO_DEFAULT, { mime_type: t.m, file_uri: t.uri }, mode, inputType, cd);
    geminiDeleteFile(fetchFn, key, t.f);
    if (r.pack) return ok({ pack: r.pack, inputType, mode, via: 'gemini' });
    console.error('[StudyPack] audio generate:', r.error, r.detail || '');
    return r.error === 'invalid_output' ? fail(502, 'invalid_output', INVALID) : fail(503, 'ai_unavailable', BUSY_AUDIO);
  }

  return fail(400, 'bad_request', 'Unknown study pack request.');
}

module.exports = {
  handle, buildPrompt, looseParse, closeTruncated, validatePack, parsePack, seal, unseal, audioConfig, takeAudioSlot,
  geminiAudioModel, transcribePiece, whisperKeys, _probeCache: probeCache,
  MODES, SOURCES, AUDIO_DEFAULTS, AUDIO_MAX_BYTES, CHUNK_BYTES, WHISPER_MAX_BYTES, PIECE_SECONDS, WHISPER_MODEL, GEMINI_AUDIO_DEFAULT, MIN_ITEMS, YT_RE,
};
