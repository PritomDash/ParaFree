// ═══════════════════════════════════════════════════
// ParaFree — shared provider pacing (api/_pacer.js)
// Cooldowns, per-day counters and rate-limit headroom, shared by every serverless instance through Upstash.
//
//   Cooldown kinds (note(name, kind, …)):
//     minute   per-minute 429      → retry-after (or 20 s) + 0–3 s jitter
//     day      per-day 429          → until that provider's daily reset (Groq: header reset or next UTC midnight;
//                                    Gemini: next midnight Pacific; Cloudflare: next UTC midnight) + 0–60 s jitter
//     overload Google 500/503 etc.  → 8 s + 0–2 s jitter (not quota)
//     timeout  a ≥8 s timeout       → 2 min
//   After a cooldown ends, ONE probe request goes through (shared flag, 20 s) before full traffic.
//   Headroom (0–1) of an entry = the lowest of: Groq x-ratelimit-remaining-requests ÷ RPD and -tokens ÷ TPM (fresh
//   headers), and today's counted requests/tokens against the free-tier limits below. No data → 1.
//
// Upstash commands (counted in the 500K/month free tier): cooldown writes only on a 429/overload/timeout (1 HSET) and
// when a probe starts/ends (1 HSET/HDEL); token counts are batched per instance and flushed at most every 30 s
// (1 HINCRBY per entry touched); a sync read (2 HGETALL) at most every 20 s per instance, and only when a request
// arrives. Requests per entry come from the existing pf_usage day hash (api/_usage.js), so no extra command.
// Never stores text, keys or IPs — only entry names, times and counts.
// ═══════════════════════════════════════════════════
'use strict';

const COOL_KEY = 'pf_cool';                 // hash: entry → JSON { until, kind, probeUntil }
const USAGE_PREFIX = 'pf_usage:';           // api/_usage.js day hash (chunk|entry, chat|entry); we add tok|entry
const SYNC_MS = 20000, FLUSH_MS = 30000, PROBE_MS = 20000;
const MINUTE_DEFAULT_S = 20, OVERLOAD_S = 8, TIMEOUT_S = 120;

// Free-tier limits by model (A1 of experiments/efficiency/REPORT.md, read 2026-11-04). Per key = per pool.
function limitsFor(name) {
  const n = String(name).toLowerCase();
  if (/^groq/.test(n)) {
    if (/whisper/.test(n)) return { rpm: 20, rpd: 2000 };
    return { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 };              // gpt-oss-120b / 20b / qwen3.8-27b
  }
  if (/^gemini/.test(n)) {
    if (/gemma/.test(n)) return { rpm: 30, rpd: 14400, tpm: 16000 };
    if (/flash-lite/.test(n)) return { rpm: 15, rpd: 500, tpm: 250000 };
    if (/flash/.test(n)) return { rpm: 5, rpd: 20, tpm: 250000 };
    return { rpm: 5, rpd: 20 };
  }
  if (/^nvidia/.test(n)) return { rpm: 40 };
  if (/^ovhcloud/.test(n)) return { rpm: 2 };
  if (/^llm7/.test(n)) return { rpm: 30 };
  if (/^cloudflare/.test(n)) return { rpd: 190 };                        // ≈ 10,000 neurons ÷ ~53 per chunk
  return {};
}

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const ptDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// next midnight in a time zone (ms) — searched minute by minute from the next hour boundary (cheap: ≤ 1,440 steps)
function nextMidnight(t, tz) {
  const day = tz ? new Date(t).toLocaleDateString('en-CA', { timeZone: tz }) : utcDay(t);
  let x = Math.ceil(t / 60000) * 60000;
  for (let i = 0; i < 60 * 26; i++, x += 60000) {
    const d = tz ? new Date(x).toLocaleDateString('en-CA', { timeZone: tz }) : utcDay(x);
    if (d !== day) return x;
  }
  return t + 86400000;
}
// Groq reset strings like "2m59.56s", "7.66s", "1h2m3s" → ms
function durationMs(s) {
  if (!s) return 0;
  let ms = 0; const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g; let m;
  while ((m = re.exec(String(s))) !== null) ms += Number(m[1]) * ({ h: 3600000, m: 60000, s: 1000, ms: 1 })[m[2]];
  return Math.round(ms);
}

function createPacer({ getRedis = () => null, now = () => Date.now(), random = Math.random } = {}) {
  const cool = new Map();       // entry → { until, kind, probeUntil }
  const heads = new Map();      // entry → { remReq, remTok, resetReqAt, resetTokAt, at }
  const today = new Map();      // `${utcDay}|chunk|entry` etc. → count (from the shared day hash + this instance)
  const pendingTok = new Map(); // entry → tokens not yet flushed
  const probing = new Set();    // probes in flight on this instance
  let lastSync = 0, lastFlush = 0, syncing = null, bornAt = 0;   // bornAt: shared records written before a test reset are ignored

  const redis = () => { try { return getRedis(); } catch (_) { return null; } };
  const jitter = (maxMs) => Math.floor(random() * maxMs);

  function resetAt(name, t) {
    const n = String(name);
    if (/^gemini/.test(n)) return nextMidnight(t, 'America/Los_Angeles');
    const h = heads.get(n);
    if (/^groq/.test(n) && h && h.resetReqAt && h.resetReqAt > t) return h.resetReqAt;
    return nextMidnight(t, null);
  }

  // ── reads ──
  async function sync(force = false) {
    const t = now();
    if (!force && t - lastSync < SYNC_MS) return;
    const r = redis();
    if (!r || !r.hgetall) { lastSync = t; return; }
    if (syncing) return syncing;
    lastSync = t;
    syncing = (async () => {
      try {
        const [c, u] = await Promise.all([r.hgetall(COOL_KEY), r.hgetall(USAGE_PREFIX + utcDay(t))]);
        for (const [name, v] of Object.entries(c || {})) {
          let o = v; try { if (typeof v === 'string') o = JSON.parse(v); } catch (_) { o = null; }
          if (!o || !o.until || (o.at || 0) < bornAt) continue;
          const mine = cool.get(name);
          if (!mine || (o.until || 0) > (mine.until || 0) || (o.probeUntil || 0) > (mine.probeUntil || 0)) cool.set(name, o);
        }
        const day = utcDay(t);
        for (const [k, v] of Object.entries(u || {})) today.set(day + '|' + k, Math.max(Number(v) || 0, today.get(day + '|' + k) || 0));
      } catch (_) { /* Upstash down: keep local state */ }
      finally { syncing = null; }
    })();
    return syncing;
  }

  function cooldownUntil(name) {
    const c = cool.get(name);
    return c && c.until > now() ? c.until : 0;
  }
  const isCooling = (name) => cooldownUntil(name) > 0;
  // After a cooldown: only one probe at a time (this instance or another one — shared probeUntil)
  function probeBlocked(name) {
    const c = cool.get(name);
    if (!c || c.until > now()) return false;
    if (!c.needsProbe) return false;
    return probing.has(name) || (c.probeUntil || 0) > now();
  }
  function startProbe(name) {
    const c = cool.get(name);
    if (!c || !c.needsProbe || c.until > now()) return false;
    probing.add(name);
    c.probeUntil = now() + PROBE_MS;
    write(name, c);
    return true;
  }

  // a probe that failed without a new cooldown (e.g. an auth error) frees the probe slot
  function endProbe(name) {
    if (!probing.has(name)) return;
    probing.delete(name);
    const c = cool.get(name);
    if (c) { c.probeUntil = 0; write(name, c); }
  }

  function write(name, o) {
    const r = redis();
    if (!r || !r.hset) return;
    o.at = now();
    try { Promise.resolve(r.hset(COOL_KEY, { [name]: JSON.stringify(o) })).catch(() => {}); } catch (_) {}
  }
  function clear(name) {
    cool.delete(name); probing.delete(name);
    const r = redis();
    if (!r || !r.hdel) return;
    try { Promise.resolve(r.hdel(COOL_KEY, name)).catch(() => {}); } catch (_) {}
  }

  // ── writes ──
  // kind: 'minute' | 'day' | 'overload' | 'timeout'; retryAfterS from the header / retryDelay (0 if none)
  function note(name, kind, retryAfterS = 0) {
    const t = now();
    let until;
    // per-day: Groq's TPD is a rolling window — a long retry-after (≥ 15 min) says exactly when; otherwise the reset
    if (kind === 'day') until = (retryAfterS >= 900 ? t + retryAfterS * 1000 : resetAt(name, t)) + jitter(60000);
    else if (kind === 'overload') until = t + OVERLOAD_S * 1000 + jitter(2000);
    else if (kind === 'timeout') until = t + TIMEOUT_S * 1000;
    else until = t + Math.max(1, retryAfterS || MINUTE_DEFAULT_S) * 1000 + jitter(3000);
    const o = { until, kind, needsProbe: true };
    cool.set(name, o);
    probing.delete(name);
    write(name, o);
    return until - t;
  }
  function noteHeaders(name, h) {
    if (!h || (h.remReq === undefined && h.remTok === undefined)) return;
    const t = now();
    heads.set(name, { remReq: h.remReq, remTok: h.remTok, at: t,
      resetReqAt: h.resetReq ? t + durationMs(h.resetReq) : undefined, resetTokAt: h.resetTok ? t + durationMs(h.resetTok) : undefined });
  }
  function noteSuccess(name, tokens = 0, headers = null) {
    noteHeaders(name, headers);
    const day = utcDay(now());
    today.set(day + '|chunk|' + name, (today.get(day + '|chunk|' + name) || 0) + 1);
    if (tokens > 0) {
      today.set(day + '|tok|' + name, (today.get(day + '|tok|' + name) || 0) + tokens);
      pendingTok.set(name, (pendingTok.get(name) || 0) + tokens);
    }
    const c = cool.get(name);
    if (c) clear(name);                       // a successful probe (or call) ends the cooldown everywhere
    flush();
  }
  function flush(force = false) {
    const t = now();
    if (!force && t - lastFlush < FLUSH_MS) return;
    const r = redis();
    lastFlush = t;
    if (!r || !r.hincrby || !pendingTok.size) { pendingTok.clear(); return; }
    const key = USAGE_PREFIX + utcDay(t);
    for (const [name, n] of pendingTok) { try { Promise.resolve(r.hincrby(key, 'tok|' + name, Math.round(n))).catch(() => {}); } catch (_) {} }
    pendingTok.clear();
  }

  // ── headroom 0..1 ──
  function headroom(name) {
    const L = limitsFor(name), t = now(), day = utcDay(t);
    let h = 1;
    const hd = heads.get(name);
    if (hd && t - hd.at < 120000) {
      if (hd.remReq !== undefined && L.rpd) h = Math.min(h, Math.max(0, hd.remReq) / L.rpd);
      if (hd.remTok !== undefined && L.tpm && !(hd.resetTokAt && hd.resetTokAt <= t)) h = Math.min(h, Math.max(0, hd.remTok) / L.tpm);
    }
    const reqs = (today.get(day + '|chunk|' + name) || 0) + (today.get(day + '|chat|' + name) || 0);
    if (L.rpd) h = Math.min(h, Math.max(0, 1 - reqs / L.rpd));
    const tok = today.get(day + '|tok|' + name) || 0;
    if (L.tpd) h = Math.min(h, Math.max(0, 1 - tok / L.tpd));
    return h;
  }

  function status() {
    const t = now(), list = [];
    for (const [name, c] of cool) if (c.until > t || c.needsProbe) list.push({ entry: name, kind: c.kind, until: new Date(c.until).toISOString(), cooling: c.until > t, awaitingProbe: c.until <= t && !!c.needsProbe });
    return { cooled: list.sort((a, b) => a.until.localeCompare(b.until)), headroom: Object.fromEntries([...new Set([...heads.keys()])].map((n) => [n, +headroom(n).toFixed(2)])) };
  }
  // tests only: forget everything, here AND in the shared hash (otherwise the next sync brings old cooldowns back)
  function _reset() {
    cool.clear(); heads.clear(); today.clear(); pendingTok.clear(); probing.clear(); lastSync = 0; lastFlush = 0; bornAt = now();
  }

  return { sync, isCooling, cooldownUntil, probeBlocked, startProbe, endProbe, note, noteHeaders, noteSuccess, flush, headroom, status, resetAt, _reset, _cool: cool };
}

module.exports = { createPacer, limitsFor, durationMs, nextMidnight, ptDay, utcDay, COOL_KEY };
