'use strict';
// Phase 5 — Vercel AI Gateway transcription (api/_gateway.js) as the 2nd route: Groq Whisper → AI Gateway → Gemini
// Files. Everything is MOCKED (fetch, Upstash); unknown URLs throw, so nothing leaves this process.
// Run: node tests/gateway.test.js
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); failed++; }
}
const fs = require('fs'), path = require('path');
const GW = require('../api/_gateway.js');
const SP = require('../api/_studypack.js');

// ── fake Upstash ──
const H = new Map(), KV = new Map();
const hash = (k) => { if (!H.has(k)) H.set(k, {}); return H.get(k); };
const redis = {
  async hgetall(k) { return H.has(k) ? Object.assign({}, H.get(k)) : null; }, async hset(k, o) { Object.assign(hash(k), o); return 1; },
  async hincrby(k, f, n) { const o = hash(k); o[f] = (Number(o[f]) || 0) + n; return o[f]; }, async hdel(k, f) { delete hash(k)[f]; return 1; },
  async get(k) { return KV.has(k) ? KV.get(k) : null; }, async set(k, v) { KV.set(k, v); return 'OK'; },
  async incr(k) { const v = (Number(KV.get(k)) || 0) + 1; KV.set(k, v); return v; }, async expire() { return 1; },
};
const today = new Date().toISOString().slice(0, 10);

// ── fetch mock ──
let whisper = 'ok', gateway = 'ok', catalogIds = ['google/gemini-3.5-transcribe', 'openai/whisper-1', 'openai/gpt-4o-transcribe'], calls = [];
const respond = (status, json, headers = {}) => ({ ok: status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => json, text: async () => (typeof json === 'string' ? json : JSON.stringify(json)) });
async function fetchMock(url, opts = {}) {
  if (url === 'https://ai-gateway.vercel.sh/v1/models') { calls.push({ name: 'catalog' }); return respond(200, { data: catalogIds.map((id) => ({ id, type: 'transcription' })) }); }
  if (url === 'https://ai-gateway.vercel.sh/v4/ai/transcription-model') {
    calls.push({ name: 'gateway', model: opts.headers['ai-model-id'], auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    if (gateway === '403') return respond(403, { error: { type: 'RestrictedModelsError', message: 'This model is not available on the free credit.' } });
    if (gateway === 'fail') return respond(500, { error: 'mock failure' });
    return respond(200, { text: 'This lecture explains photosynthesis in green plants.', durationInSeconds: 90, segments: [], warnings: [] });
  }
  if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') {
    calls.push({ name: 'whisper' });
    if (whisper === '429') return respond(429, { error: { message: 'Rate limit reached for model whisper-large-v3-turbo on audio seconds per day (ASD)' } });
    return respond(200, 'Plants turn light into chemical energy in their leaves.');
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    calls.push({ name: 'gemini', url });
    if (/upload\/v1beta\/files/.test(url)) return respond(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session-1' });
    return respond(200, { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] });
  }
  throw new Error('UNMOCKED URL — refusing live call: ' + url);
}

const env = { STUDYPACK_SECRET: 'test-secret-xxxxxxxxxxxxxxxxxxxxxxxx', GROQ_KEY: 'groq-key-1-xxxxxxxx', GEMINI_KEY: 'gemini-key-xxxxxxxx' };
const cool = new Map();
const cd = { isCooling: (n) => (cool.get(n) || 0) > Date.now(), start: (n, msg) => cool.set(n, Date.now() + 60000), detail: (res, b) => String(b || '').slice(0, 200) };
const OIDC = { headers: { 'x-vercel-oidc-token': 'oidc-test-token' } };
let ipN = 0;
const ctx = (req = OIDC) => ({ env, redis, ip: '10.6.0.' + (++ipN), fetch: fetchMock, req, cooldown: cd, rateLimit: () => ({ allowed: true }), runText: async () => ({ success: false }) });
const quiet = () => { console.log = console.warn = console.error = () => {}; };
const realLog = console.log, realWarn = console.warn, realErr = console.error;
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
async function run(body, req) { calls = []; quiet(); try { return await SP.handle(body, ctx(req)); } finally { loud(); } }
const piece = Buffer.alloc(90 * 32000, 1).toString('base64');            // a 90 s 16 kHz WAV-sized piece

(async () => {
  console.log('\n── 1. Route order: Groq Whisper → AI Gateway → Gemini Files ──');
  let st = await run({ type: 'studypack_audio_start', mime: 'audio/mpeg', size: 3e6, name: 'lecture.mp3', seconds: 180, pieces: 2, split: true });
  assert('Whisper available → piece route', st.status === 200 && st.body.route === 'whisper', JSON.stringify(st.body));
  const job = st.body.job;
  let r = await run({ type: 'studypack_audio_piece', job, index: 0, data: piece, mime: 'audio/wav', name: 'part-1.wav' });
  assert('Whisper answers → the AI Gateway is never called', r.status === 200 && calls.some((c) => c.name === 'whisper') && !calls.some((c) => c.name === 'gateway'));
  whisper = '429'; cool.clear();
  r = await run({ type: 'studypack_audio_piece', job, index: 1, data: piece, mime: 'audio/wav', name: 'part-2.wav' });
  const g = calls.find((c) => c.name === 'gateway');
  assert('Whisper rate-limited → the same piece goes to the AI Gateway → success', r.status === 200 && g && calls.findIndex((c) => c.name === 'whisper') < calls.findIndex((c) => c.name === 'gateway'), JSON.stringify(r.body).slice(0, 160));
  assert('… with the preferred free-credit model google/gemini-3.5-transcribe', g && g.model === 'google/gemini-3.5-transcribe');
  assert('… authenticated with the Vercel OIDC token (no API key anywhere)', g && g.auth === 'Bearer oidc-test-token' && !Object.keys(process.env).some((k) => /AI_GATEWAY_API_KEY/.test(k)) && !/AI_GATEWAY_API_KEY/.test(fs.readFileSync(path.join(__dirname, '..', 'api', '_gateway.js'), 'utf8')));
  assert('… base64 audio + mediaType in the JSON body (REST API shape)', g && typeof g.body.audio === 'string' && g.body.mediaType === 'audio/wav');
  // every Whisper key busy at the start → still the piece route, because the gateway can take the pieces
  cool.set('groq', Date.now() + 60000);
  st = await run({ type: 'studypack_audio_start', mime: 'audio/mpeg', size: 3e6, name: 'lecture.mp3', seconds: 180, pieces: 2, split: true });
  assert('every Whisper key cooling + gateway ready → piece route (gateway transcribes)', st.status === 200 && st.body.route === 'whisper', JSON.stringify(st.body));
  st = await run({ type: 'studypack_audio_start', mime: 'audio/mpeg', size: 3e6, name: 'lecture.mp3', seconds: 180, pieces: 2, split: true }, { headers: {} });
  assert('no OIDC token → the gateway route is off → Gemini Files route', st.status === 200 && st.body.route === 'gemini', JSON.stringify(st.body).slice(0, 120));
  cool.clear(); whisper = 'ok';

  console.log('\n── 2. Spend guard: stops at $4.50 per rolling 30 days ──');
  GW._reset(); H.delete('pf_gw');
  const sp = await GW.status(env, redis);
  assert('fresh: $0 spent, cap $4.50', sp.spent30d === 0 && sp.capUsd === 4.5);
  let one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(90 * 32000), 'audio/wav', 10000);
  const after1 = await GW.status(env, redis);
  assert('a 90 s piece is recorded at its real duration × list price ($0.0108)', one.text && Math.abs(after1.spent30d - 90 * 0.00012) < 1e-6, JSON.stringify(after1));
  hash('pf_gw')['d:' + today] = String(Math.round(4.49 * 1e6));
  calls = [];
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(90 * 32000), 'audio/wav', 10000);
  assert('$4.49 spent + this piece\'s estimate > $4.50 → refused BEFORE any call (spend_cap)', one.error === 'spend_cap' && !calls.some((c) => c.name === 'gateway'), JSON.stringify(one));
  hash('pf_gw')['d:' + today] = String(Math.round(4.40 * 1e6));
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(10 * 32000), 'audio/wav', 10000);
  assert('$4.40 spent + a small piece still fits → allowed', !!one.text, JSON.stringify(one));
  const old = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  H.set('pf_gw', { ['d:' + old]: String(4.5e6) });
  assert('spend older than 30 days does not count (rolling window)', (await GW.status(env, redis)).spent30d === 0);
  assert('seconds are over-estimated from the size (MP3 counted as 64 kbit/s)', GW.estimateSeconds(1e6, 'audio/mpeg') === 125 && GW.estimateSeconds(320000, 'audio/wav') === 20);

  console.log('\n── 3. 403 RestrictedModelsError / not in the catalog → route off for 24 h ──');
  GW._reset(); H.delete('pf_gw'); gateway = '403';
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(32000), 'audio/wav', 10000);
  const off = await GW.status(env, redis);
  assert('403 RestrictedModelsError → disabled for 24 h (shared via Upstash)', one.error && off.disabledUntil && Math.abs(new Date(off.disabledUntil) - Date.now() - 86400000) < 60000, JSON.stringify(off));
  gateway = 'ok'; calls = [];
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(32000), 'audio/wav', 10000);
  assert('while disabled: no gateway call at all', one.error === 'gateway_unavailable' && !calls.some((c) => c.name === 'gateway'));
  GW._reset(); H.delete('pf_gw'); catalogIds = ['openai/gpt-4o-transcribe'];
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(32000), 'audio/wav', 10000);
  assert('neither free-credit model in the catalog → route off, no transcription call', one.error === 'gateway_unavailable' && one.why === 'not_in_catalog' && !calls.some((c) => c.name === 'gateway'));
  GW._reset(); catalogIds = ['openai/whisper-1'];
  calls = [];
  one = await GW.transcribe(env, redis, OIDC, fetchMock, Buffer.alloc(32000), 'audio/wav', 10000);
  assert('only whisper-1 listed → whisper-1 is used', one.text && calls.find((c) => c.name === 'gateway').model === 'openai/whisper-1');
  assert('whisper-1 is dropped after its retirement date (2027-02-26)', GW.FREE_CREDIT_MODELS.find((m) => m.id === 'openai/whisper-1').retires === Date.UTC(2027, 1, 26));
  catalogIds = ['google/gemini-3.5-transcribe', 'openai/whisper-1'];

  console.log('\n── 4. Never buys credits ──');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_gateway.js'), 'utf8');
  const urls = [...src.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]|BASE \+ '([^']+)'/g)].map((m) => m[1] || m[2]);
  assert('the only gateway URLs are the model list and the transcription endpoint', urls.every((u) => /^(https:\/\/ai-gateway\.vercel\.sh|\/v1\/models|\/v4\/ai\/transcription-model)$/.test(u)), urls.join(' '));
  assert('no billing / top-up / credit-purchase endpoint anywhere in the code', !/\/(billing|credits?|top-?up|purchase|checkout)\b/i.test(src.replace(/\/\/.*$/gm, '')));

  console.log('\n── 5. Gemini Files route: audio only, never video/* ──');
  st = await run({ type: 'studypack_audio_start', mime: 'video/mp4', size: 20e6, name: 'lecture.mp4', seconds: 600, pieces: 0, split: false }, { headers: {} });
  assert('a video sent to the Gemini route → 415 audio_only, nothing uploaded', st.status === 415 && st.body.error === 'audio_only' && !calls.some((c) => c.name === 'gemini' && /upload/.test(c.url)), JSON.stringify(st.body));
  st = await run({ type: 'studypack_audio_start', mime: 'audio/wav', size: 9.6e6, name: 'lecture.wav', seconds: 600, pieces: 0, split: false, from: 'video' }, { headers: {} });
  assert('the browser-extracted audio (audio/wav, from: video) → Gemini upload starts as audio', st.status === 200 && st.body.route === 'gemini', JSON.stringify(st.body).slice(0, 120));
  st = await run({ type: 'studypack_audio_start', mime: 'audio/wav', size: 60e6, name: 'long.wav', seconds: 3500, pieces: 0, split: false, from: 'video' }, { headers: {} });
  assert('extracted audio may be a little larger than the 50 MB file limit (8 kHz WAV of a 60-min video)', st.status === 200, JSON.stringify(st.body).slice(0, 120));
  const app = fs.readFileSync(path.join(__dirname, '..', 'lib', 'studypack', 'app.js'), 'utf8');
  assert('page: a video is turned into an 8 kHz WAV before the Gemini route (audioOnly → forGemini)', /async function audioOnly\(file\)/.test(app) && /wavPieces\(file, 24 \* 3600, 8000\)/.test(app) && /from: 'video'/.test(app) && /geminiJob\(g\.media/.test(app));
  const sp2 = fs.readFileSync(path.join(__dirname, '..', 'api', '_studypack.js'), 'utf8');
  assert('media route has its own budget inside the 90 s limit (80 s), pieces 75 s incl. 15 s for the gateway', /MEDIA_BUDGET_MS = 80000/.test(sp2) && /PIECE_BUDGET_MS = 75000/.test(sp2) && /GATEWAY_MIN_MS = 15000/.test(sp2));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { loud(); console.error(e); process.exit(1); });
