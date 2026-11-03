// ═══════════════════════════════════════════════════
// ParaFree — Vercel AI Gateway speech-to-text, the 2nd transcription route (api/_gateway.js)
// Route order for audio/video (api/_studypack.js): Groq Whisper → AI Gateway → Gemini Files (one request).
//
// Auth: the Vercel OIDC token — no API key. At request time it arrives as the x-vercel-oidc-token request header
// (Vercel Functions); VERCEL_OIDC_TOKEN (vercel env pull, builds) and @vercel/oidc's getVercelOidcToken() are the
// fallbacks. No token → the route is simply off.
// Endpoint: POST https://ai-gateway.vercel.sh/v4/ai/transcription-model, base64 audio in a JSON body, the model in the
// ai-model-id header (docs: vercel.com/docs/ai-gateway/modalities/speech-to-text, updated 2026-09-08).
// Models: only ones on the free AI Gateway credit list we verified (google/gemini-3.5-transcribe, openai/whisper-1;
// whisper-1 retires 2027-02-26) AND present in the public catalog (GET /v1/models, checked at most once a day).
// The catalog does not say which models the free credit covers, so the list is fixed here (env GATEWAY_MODELS
// can only narrow it) and a 403 RestrictedModelsError / not-in-catalog answer switches the route off for 24 h.
// Spend guard: every call's cost is estimated BEFORE it is made (seconds × the model's list price, seconds over-
// estimated from the file size) and recorded after; the route stops when the rolling 30-day total would pass $4.50
// (the free credit is $5 / 30 days). It never buys credits and no code here calls a billing endpoint.
// Upstash: one hash "pf_gw" — d:<YYYY-MM-DD> → micro-dollars spent that day, n:<day> → calls, off_until → epoch ms.
// ═══════════════════════════════════════════════════
'use strict';

const BASE = 'https://ai-gateway.vercel.sh';
const CAP_USD = 4.5;
const KEY = 'pf_gw';
const FREE_CREDIT_MODELS = [
  // $/second of audio (list price, rounded up): gemini-3.5-transcribe ≈ 32 audio tokens/s × $2/M + ~4 output tokens/s × $12/M
  { id: 'google/gemini-3.5-transcribe', perSecond: 0.00012 },
  { id: 'openai/whisper-1', perSecond: 0.0001, retires: Date.UTC(2027, 1, 26) },
];
const OFF_MS = 24 * 60 * 60 * 1000;
const CATALOG_MS = 24 * 60 * 60 * 1000;
let catalog = { at: 0, ids: null };
const memDay = new Map();   // day → micro-dollars (when Upstash is not configured)
let memOff = 0;

const day = (t) => new Date(t).toISOString().slice(0, 10);
// Seconds of audio, over-estimated on purpose: WAV 16 kHz mono 16-bit = 32,000 bytes/s (8 kHz = 16,000); anything
// compressed is treated as 64 kbit/s (8,000 bytes/s), so a 128 kbit/s MP3 is counted as twice its real length.
function estimateSeconds(bytes, mime) {
  if (/wav/.test(String(mime))) return Math.ceil(bytes / 16000);
  return Math.ceil(bytes / 8000);
}

async function oidcToken(ctx) {
  const h = ctx && ctx.headers ? (ctx.headers['x-vercel-oidc-token'] || ctx.headers['X-Vercel-Oidc-Token']) : null;
  if (h) return String(h);
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN;
  try { const m = require('@vercel/oidc'); if (m && m.getVercelOidcToken) return await m.getVercelOidcToken(); } catch (_) {}
  return null;
}

async function readState(redis) {
  let h = null;
  if (redis && redis.hgetall) { try { h = await redis.hgetall(KEY); } catch (_) {} }
  const now = Date.now();
  let spentMicro = 0, calls = 0;
  for (let i = 0; i < 30; i++) {
    const d = day(now - i * 86400000);
    // Upstash is the shared truth; this instance's memory only when Upstash is not configured
    spentMicro += Number(redis && redis.hgetall ? (h && h['d:' + d]) || 0 : memDay.get(d) || 0);
    calls += Number((h && h['n:' + d]) || 0);
  }
  const offUntil = Math.max(Number((h && h.off_until) || 0), memOff);
  return { spentUsd: spentMicro / 1e6, calls, offUntil: offUntil > now ? offUntil : 0 };
}
async function record(redis, usd) {
  const d = day(Date.now()), micro = Math.ceil(usd * 1e6);
  memDay.set(d, (memDay.get(d) || 0) + micro);
  if (redis && redis.hincrby) {
    try { await redis.hincrby(KEY, 'd:' + d, micro); await redis.hincrby(KEY, 'n:' + d, 1); } catch (_) {}
  }
}
async function switchOff(redis, why) {
  memOff = Date.now() + OFF_MS;
  console.log(`[ParaFree] AI Gateway route switched off for 24 h — ${why}`);
  if (redis && redis.hset) { try { await redis.hset(KEY, { off_until: String(memOff) }); } catch (_) {} }
}

// Which free-credit models are in the public catalog right now (cached a day; a failed fetch keeps the old answer)
async function catalogIds(fetchFn) {
  if (catalog.ids && Date.now() - catalog.at < CATALOG_MS) return catalog.ids;
  try {
    const res = await fetchFn(BASE + '/v1/models', { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const j = await res.json();
      const list = Array.isArray(j) ? j : (j && j.data) || [];
      catalog = { at: Date.now(), ids: new Set(list.filter((m) => m && (!m.type || m.type === 'transcription')).map((m) => m.id)) };
    }
  } catch (_) {}
  return catalog.ids;
}
function modelsFor(env) {
  const allow = env && env.GATEWAY_MODELS ? new Set(String(env.GATEWAY_MODELS).split(',').map((s) => s.trim())) : null;
  return FREE_CREDIT_MODELS.filter((m) => (!m.retires || Date.now() < m.retires) && (!allow || allow.has(m.id)));
}

const configured = (env) => !env || !/^(0|off|false|no)$/i.test(String(env.AI_GATEWAY_TRANSCRIBE || 'on'));

// Is the route usable for a file of `bytes`? → { ok, why }
async function ready(env, redis, ctx, fetchFn = fetch, bytes = 0, mime = 'audio/wav') {
  if (!configured(env)) return { ok: false, why: 'disabled' };
  if (!(await oidcToken(ctx))) return { ok: false, why: 'no_oidc_token' };
  const st = await readState(redis);
  if (st.offUntil) return { ok: false, why: 'switched_off' };
  const ids = await catalogIds(fetchFn);
  const m = modelsFor(env).find((x) => !ids || ids.has(x.id));
  if (!m) return { ok: false, why: 'not_in_catalog' };
  const est = estimateSeconds(bytes, mime) * m.perSecond;
  if (st.spentUsd + est > CAP_USD) return { ok: false, why: 'spend_cap' };
  return { ok: true, model: m, estimate: est };
}

// → { text } or { error: 'gateway_unavailable' | 'spend_cap' | 'too_large' | 'bad_audio' }
async function transcribe(env, redis, ctx, fetchFn, buf, mime, ms) {
  const r = await ready(env, redis, ctx, fetchFn, buf.length, mime);
  if (!r.ok) return { error: r.why === 'spend_cap' ? 'spend_cap' : 'gateway_unavailable', why: r.why };
  const token = await oidcToken(ctx);
  let res;
  try {
    res = await fetchFn(BASE + '/v4/ai/transcription-model', {
      method: 'POST', signal: AbortSignal.timeout(Math.max(3000, ms)),
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'ai-gateway-protocol-version': '0.0.1', 'ai-transcription-model-specification-version': '4', 'ai-model-id': r.model.id,
      },
      body: JSON.stringify({ audio: Buffer.from(buf).toString('base64'), mediaType: mime }),
    });
  } catch (e) {
    console.error('[ParaFree] AI Gateway transcription failed:', String(e.message).slice(0, 120));
    return { error: 'gateway_unavailable' };
  }
  let body = ''; try { body = await res.text(); } catch (_) {}
  if (!res.ok) {
    // free-credit restriction, unknown model, or no credit left → off for 24 h (never buy credits)
    if (res.status === 403 || res.status === 402 || /RestrictedModels|not.?(found|in.?catalog)|insufficient|credit/i.test(body) && res.status !== 429) {
      await switchOff(redis, `${res.status} ${/RestrictedModels/i.test(body) ? 'RestrictedModelsError' : body.slice(0, 80)}`);
    }
    if (res.status === 413) return { error: 'too_large' };
    if (res.status === 400 || res.status === 415) return { error: 'bad_audio' };
    return { error: 'gateway_unavailable' };
  }
  let j = {}; try { j = JSON.parse(body); } catch (_) {}
  const secs = Number(j.durationInSeconds) > 0 ? Number(j.durationInSeconds) : estimateSeconds(buf.length, mime);
  await record(redis, Math.max(secs * r.model.perSecond, 0.000001));
  const text = String(j.text || '').trim();
  return text ? { text, model: r.model.id } : { error: 'gateway_unavailable' };
}

// For the admin dashboard: spend in the rolling 30 days, the cap, whether the route is on
async function status(env, redis) {
  const st = await readState(redis);
  return { enabled: configured(env), spent30d: +st.spentUsd.toFixed(4), capUsd: CAP_USD, calls30d: st.calls, disabledUntil: st.offUntil ? new Date(st.offUntil).toISOString() : null };
}

function _reset() { catalog = { at: 0, ids: null }; memDay.clear(); memOff = 0; }

module.exports = { transcribe, ready, status, estimateSeconds, modelsFor, oidcToken, CAP_USD, FREE_CREDIT_MODELS, BASE, _reset };
