// ═══════════════════════════════════════════════════
// ParaFree — Study Pack (api/_studypack.js)
// One AI call turns study material into { key_points, flashcards, quiz }.
//  - text (pasted, or extracted in the browser from PDF / DOCX / PPTX / YouTube captions): the browser
//    pre-filters it with TextRank, then ONE request goes through the normal provider chain (Gemini first).
//  - audio / video: the browser sends the file in chunks; each chunk is relayed to the Gemini Files API
//    (resumable upload — the upload URL never leaves the server, it travels inside a sealed token), then ONE
//    Gemini call listens to the file and returns the pack (no transcript in the output). Fallback for small
//    files: Groq Whisper transcribes, then the text chain makes the pack.
//  - YouTube link without readable captions: Gemini reads the public video from its URL (Google fetches it,
//    not our server) — counted like an audio job.
// The prompt is always built here from {mode, inputType}; a client-supplied prompt is ignored.
// Audio switch + daily cap: env ENABLE_AUDIO / STUDYPACK_AUDIO_CAP, overridable at runtime (no redeploy) with
// the Upstash hash "studypack:cfg" fields audio ("0"/"1") and cap (number).
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
};
const MIN_ITEMS = 3;                       // fewer valid items than this in any section = not a usable pack
const MAX_TEXT_CHARS = 60000;              // the browser sends at most ~4,000 TextRank-selected words
const AUDIO_DEFAULTS = { enabled: true, cap: 5 };   // launch: audio on, 5 audio/video/YouTube-AI jobs per IP per UTC day
const AUDIO_MAX_BYTES = 50 * 1024 * 1024;           // 50 MB per file
const CHUNK_BYTES = 9 * 256 * 1024;                 // 2.25 MiB raw (Gemini upload granularity 256 KiB; ~3 MB as base64, under Vercel's 4.5 MB body limit)
const WHISPER_MAX_BYTES = 3 * 1024 * 1024;          // the fallback gets the whole file in one request
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_TYPES = /^(audio|video)\/[\w.+-]+$/;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

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
  const secret = env.STUDYPACK_SECRET || env.GEMINI_KEY || env.GEMINI_KEY_2 || '';
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
  let cap = Number.isFinite(+env.STUDYPACK_AUDIO_CAP) && env.STUDYPACK_AUDIO_CAP !== '' && env.STUDYPACK_AUDIO_CAP !== undefined ? +env.STUDYPACK_AUDIO_CAP : AUDIO_DEFAULTS.cap;
  if (redis && redis.hgetall) {
    try {
      const o = await redis.hgetall('studypack:cfg');
      if (o && o.audio !== undefined && o.audio !== null) enabled = /^(1|true|on|yes)$/i.test(String(o.audio));
      if (o && o.cap !== undefined && o.cap !== null && Number.isFinite(+o.cap)) cap = +o.cap;
    } catch (_) {}
  }
  const gemini = !!(env.GEMINI_KEY || env.GEMINI_KEY_2), whisper = !!env.GROQ_KEY;
  return { enabled: enabled && (gemini || whisper), cap: Math.max(0, Math.floor(cap)), gemini, whisper };
}
const memCount = new Map();                 // per instance, used when Upstash is not configured
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ipKey = (ip) => crypto.createHash('sha256').update('pf-ip:' + ip).digest('hex').slice(0, 16);   // no raw IPs stored
async function takeAudioSlot(redis, ip, cap) {
  const key = 'studypack:audio:' + dayOf() + ':' + ipKey(ip);
  let used;
  if (redis && redis.incr) {
    try { used = await redis.incr(key); if (used === 1 && redis.expire) redis.expire(key, 2 * 86400).catch(() => {}); } catch (_) { used = undefined; }
  }
  if (used === undefined) {
    if (memCount.size > 5000) memCount.clear();
    used = (memCount.get(key) || 0) + 1;
    memCount.set(key, used);
  }
  return { ok: used <= cap, used, remaining: Math.max(0, cap - used) };
}

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
async function geminiGenerate(fetchFn, key, model, filePart, prompt, ms) {
  const res = await fetchFn(`${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', signal: AbortSignal.timeout(ms),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: filePart }, { text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) { let b = ''; try { b = await res.text(); } catch (_) {} throw new Error(`Gemini/${model}:${res.status} ${b.slice(0, 160)}`); }
  const data = await res.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return parts ? parts.map((p) => p.text || '').join('') : '';
}
// Each media model is tried until one returns a valid pack; one invalid answer is re-requested once (next model).
// Everything stays inside the function's 60 s (maxDuration): no new attempt with less than 10 s left.
const MEDIA_BUDGET_MS = 52000;
async function geminiPack(fetchFn, env, keyIndex, filePart, mode, inputType) {
  const deadline = Date.now() + MEDIA_BUDGET_MS;
  const key = keyIndex === 2 ? env.GEMINI_KEY_2 : env.GEMINI_KEY;
  const models = [...new Set([env.STUDYPACK_GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
  const prompt = buildPrompt(mode, inputType, true);
  let invalid = 0, lastErr = null;
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 10000) break;
    try {
      const pack = parsePack(await geminiGenerate(fetchFn, key, model, filePart, prompt, left), mode);
      if (pack) return { pack, model };
      if (++invalid > 1) break;
    } catch (e) { lastErr = e; }
  }
  return { error: invalid ? 'invalid_output' : 'ai_unavailable', detail: lastErr && lastErr.message };
}

// ── Groq Whisper (fallback transcription for small files) ──
async function whisperTranscribe(fetchFn, key, buf, mime, name) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), String(name || 'audio').slice(0, 80));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'text');
  const res = await fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('whisper: ' + res.status);
  return String(await res.text()).trim();
}

// ── Request handling ──
const fail = (status, error, message, extra) => ({ status, body: Object.assign({ success: false, error, message }, extra || {}) });
const ok = (body) => ({ status: 200, body: Object.assign({ success: true }, body) });
const YT_RE = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/;

// ctx: { env, redis, ip, fetch, rateLimit(text) → {allowed, message}, runText(text, prompt, accept) → chain result }
async function handle(body, ctx) {
  const { env, redis, ip } = ctx, fetchFn = ctx.fetch || fetch;
  const type = body.type, mode = modeOf(body.mode);

  if (type === 'studypack_config') {
    const a = await audioConfig(env, redis);
    return ok({ audio: { enabled: a.enabled, cap: a.cap, maxBytes: AUDIO_MAX_BYTES, chunkBytes: CHUNK_BYTES, whisperMaxBytes: WHISPER_MAX_BYTES, gemini: a.gemini, whisper: a.whisper },
      modes: Object.keys(MODES) });
  }

  // text → one call through the provider chain (Gemini first); invalid JSON = that provider failed, next one tries once
  if (type === 'studypack') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 80) return fail(400, 'too_short', 'Add a bit more material — at least a few sentences.');
    if (text.length > MAX_TEXT_CHARS) return fail(400, 'too_long', 'This is too long to send in one go. Try a shorter section.');
    const rate = ctx.rateLimit(text);
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    const inputType = inputOf(body.inputType);
    let pack = null, invalid = 0;
    const accept = (raw) => {
      const p = parsePack(raw, mode);
      if (p) { pack = p; return true; }
      invalid++;
      return invalid > 1 ? 'stop' : false;            // re-request once, then give up
    };
    const r = await ctx.runText(text, buildPrompt(mode, inputType, false), accept);
    if (pack) return ok({ pack, inputType, mode });
    if (invalid) return fail(502, 'invalid_output', 'The AI answer could not be turned into a study pack. Please try again.');
    return fail(503, 'high_demand', 'Our AI is busy right now. Please wait a few seconds and try again.', { apiStatuses: r && r.apiStatuses });
  }

  // audio / video / YouTube-via-AI: switch + daily cap first
  if (['studypack_audio_start', 'studypack_youtube', 'studypack_audio_whisper'].includes(type)) {
    const a = await audioConfig(env, redis);
    if (!a.enabled) return fail(403, 'audio_disabled', 'Audio and video study packs are switched off right now. Paste the text or a transcript instead.');
    const rate = ctx.rateLimit(type + ':' + (body.name || body.url || ''));
    if (!rate.allowed) return fail(429, 'rate_limited', rate.message);
    if (type === 'studypack_audio_start') {
      const size = +body.size, mime = String(body.mime || '');
      if (!MEDIA_TYPES.test(mime)) return fail(400, 'bad_type', 'Please choose an audio or video file.');
      if (!(size > 0) || size > AUDIO_MAX_BYTES) return fail(413, 'too_large', `Audio and video files can be up to ${AUDIO_MAX_BYTES / 1048576} MB.`);
      if (!a.gemini) return fail(503, 'use_whisper', 'Large audio is not available right now.', { whisperMaxBytes: a.whisper ? WHISPER_MAX_BYTES : 0 });
    }
    if (type === 'studypack_youtube' && !YT_RE.test(String(body.url || ''))) return fail(400, 'bad_url', 'That doesn’t look like a YouTube video link.');
    if (type === 'studypack_youtube' && !a.gemini) return fail(503, 'ai_unavailable', 'This option is not available right now — paste the transcript instead.');
    const slot = await takeAudioSlot(redis, ip, a.cap);
    if (!slot.ok) return fail(429, 'audio_cap', `You’ve used today’s ${a.cap} audio/video study packs. Paste text or a transcript instead, or come back tomorrow.`, { cap: a.cap });

    if (type === 'studypack_audio_start') {
      const keyIndex = env.GEMINI_KEY ? 1 : 2, key = keyIndex === 2 ? env.GEMINI_KEY_2 : env.GEMINI_KEY;
      try {
        const url = await geminiStartUpload(fetchFn, key, String(body.mime), +body.size, body.name);
        return ok({ token: seal(env, { u: url, k: keyIndex, m: String(body.mime), s: +body.size }), chunkBytes: CHUNK_BYTES, remaining: slot.remaining });
      } catch (e) {
        console.error('[StudyPack] audio start:', e.message);
        return fail(503, 'ai_unavailable', 'The audio service is busy right now.', { whisperMaxBytes: a.whisper ? WHISPER_MAX_BYTES : 0 });
      }
    }
    if (type === 'studypack_youtube') {
      const r = await geminiPack(fetchFn, env, env.GEMINI_KEY ? 1 : 2, { file_uri: String(body.url).match(YT_RE)[0] }, mode, 'video');
      if (r.pack) return ok({ pack: r.pack, inputType: 'youtube', mode, remaining: slot.remaining });
      console.error('[StudyPack] youtube:', r.error, r.detail || '');
      return r.error === 'invalid_output'
        ? fail(502, 'invalid_output', 'The AI answer could not be turned into a study pack. Please try again.')
        : fail(503, 'ai_unavailable', 'The AI couldn’t read this video right now. Paste the transcript instead.');
    }
    // Whisper fallback: the whole (small) file in this request → transcript → text chain
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (!buf.length || buf.length > WHISPER_MAX_BYTES) return fail(413, 'too_large', `This fallback handles files up to ${WHISPER_MAX_BYTES / 1048576} MB.`);
    if (!a.whisper) return fail(503, 'ai_unavailable', 'The audio service is busy right now.');
    let transcript = '';
    try { transcript = await whisperTranscribe(fetchFn, env.GROQ_KEY, buf, String(body.mime || 'audio/mpeg'), body.name); }
    catch (e) { console.error('[StudyPack] whisper:', e.message); return fail(503, 'ai_unavailable', 'The audio service is busy right now.'); }
    if (transcript.length < 80) return fail(422, 'no_speech', 'Not enough speech was found in this file.');
    let pack = null, invalid = 0;
    const r = await ctx.runText(transcript.slice(0, MAX_TEXT_CHARS), buildPrompt(mode, 'audio', false), (raw) => {
      const p = parsePack(raw, mode); if (p) { pack = p; return true; } invalid++; return invalid > 1 ? 'stop' : false;
    });
    if (pack) return ok({ pack, inputType: 'audio', mode, via: 'whisper', remaining: slot.remaining });
    return invalid ? fail(502, 'invalid_output', 'The AI answer could not be turned into a study pack. Please try again.')
      : fail(503, 'high_demand', 'Our AI is busy right now. Please try again.', { apiStatuses: r && r.apiStatuses });
  }

  // chunk relay: only with a valid token, in order, never beyond the declared size
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
      return ok({ done: true, token: seal(env, { f: file.name, uri: file.uri, k: t.k, m: file.mimeType || t.m }) });
    } catch (e) {
      console.error('[StudyPack] chunk:', e.message);
      return fail(503, 'ai_unavailable', 'Upload failed — please try again.');
    }
  }

  // generate from the uploaded file (once Gemini has processed it); the file is deleted afterwards
  if (type === 'studypack_audio_generate') {
    const t = unseal(env, body.token);
    if (!t || !t.f) return fail(400, 'bad_token', 'This upload expired — please choose the file again.');
    const key = t.k === 2 ? env.GEMINI_KEY_2 : env.GEMINI_KEY;
    try {
      const f = await geminiGetFile(fetchFn, key, t.f);
      if (f.state === 'PROCESSING') return { status: 202, body: { success: false, processing: true, message: 'Still processing the recording…' } };
      if (f.state && f.state !== 'ACTIVE') throw new Error('file state ' + f.state);
    } catch (e) {
      console.error('[StudyPack] file:', e.message);
      return fail(503, 'ai_unavailable', 'The audio service is busy right now.');
    }
    const r = await geminiPack(fetchFn, env, t.k, { mime_type: t.m, file_uri: t.uri }, mode, String(t.m).startsWith('video/') ? 'video' : 'audio');
    geminiDeleteFile(fetchFn, key, t.f);
    if (r.pack) return ok({ pack: r.pack, inputType: String(t.m).startsWith('video/') ? 'video' : 'audio', mode });
    console.error('[StudyPack] audio generate:', r.error, r.detail || '');
    return r.error === 'invalid_output'
      ? fail(502, 'invalid_output', 'The AI answer could not be turned into a study pack. Please try again.')
      : fail(503, 'ai_unavailable', 'The audio service is busy right now.');
  }

  return fail(400, 'bad_request', 'Unknown study pack request.');
}

module.exports = {
  handle, buildPrompt, looseParse, closeTruncated, validatePack, parsePack, seal, unseal, audioConfig, takeAudioSlot,
  MODES, SOURCES, AUDIO_DEFAULTS, AUDIO_MAX_BYTES, CHUNK_BYTES, WHISPER_MAX_BYTES, MIN_ITEMS, YT_RE,
};
