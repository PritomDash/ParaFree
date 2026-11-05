// B8 — rush-hour simulator (mocked providers, no network). Replays a day of writing chunks through
// (a) TODAY's chain logic (api/process.js: sticky "last good" order, per-instance in-memory cooldowns
//     of 60 s / 15 min, retry-after only as a clamp, every provider tried until the budget runs out) and
// (b) the PROPOSED logic: shared (Redis) per-provider pacing from the known limits, load spread by
//     remaining capacity, per-day exhaustion held until the real reset (+ jitter), single probe after a
//     cooldown, 15 % of each daily pool kept for short requests, at most 3 providers per chunk before the
//     safety net.
// Both for KEY CASE "separate" (each Groq key its own org, each Gemini key its own project) and
// "shared" (all Groq keys one org, both Gemini keys one project).
// Limits: A1 (see REPORT.md). Traffic: GA4 word buckets + an ASSUMED diurnal curve (peak 1.8× the mean).
// Run: node tests/bench/rush-sim.js  → tests/bench/results/b8-sim.json (copied from experiments/efficiency on branch experiments/efficiency-audit)
'use strict';
const fs = require('fs'), path = require('path');

// ── deterministic RNG ──
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── provider models (one entry = one key+model; `pool` = the quota it draws from) ──
// lat = typical ms, err = share of 5xx/garbage answers that are NOT quota errors
const MODELS = {
  'groq/120b':   { tier: 1, rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000, lat: 1500, err: 0.003, think: 120 },
  'gemini/lite': { tier: 1, rpm: 15, tpm: 250000, rpd: 500, tpd: Infinity, lat: 1900, err: 0.05, think: 30 },
  'groq/20b':    { tier: 2, rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000, lat: 1000, err: 0.003, think: 120 },
  'groq/qwen':   { tier: 2, rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000, lat: 1800, err: 0.01, think: 0 },
  'gemini/flash':{ tier: 2, rpm: 5, tpm: 250000, rpd: 20, tpd: Infinity, lat: 4000, err: 0.05, think: 400 },
  'gemini/gemma':{ tier: 2, rpm: 30, tpm: 16000, rpd: 14400, tpd: Infinity, lat: 5000, err: 0.05, think: 0 },
  'nvidia/ultra':{ tier: 3, rpm: 40, tpm: Infinity, rpd: Infinity, tpd: Infinity, lat: 15000, err: 0.15, think: 0 },
  'nvidia/light':{ tier: 3, rpm: 40, tpm: Infinity, rpd: Infinity, tpd: Infinity, lat: 6000, err: 0.15, think: 0 },
  'ovhcloud':    { tier: 3, rpm: 2, tpm: Infinity, rpd: Infinity, tpd: Infinity, lat: 12000, err: 0.10, think: 0 },
  'llm7':        { tier: 3, rpm: 30, tpm: Infinity, rpd: Infinity, tpd: Infinity, lat: 8000, err: 0.10, think: 0 },
  // Cloudflare: 10,000 neurons/day; llama-3.1-8b ≈ 25,608 neurons/M input + 75,147/M output
  'cloudflare':  { tier: 4, rpm: 300, tpm: Infinity, rpd: Infinity, tpd: Infinity, lat: 2000, err: 0.02, think: 0, neuronsPerDay: 10000 },
};

function buildEntries(keyCase) {
  const e = [];
  const groqKeys = ['groq', 'groq-2', 'groq-3', 'groq-4'], gemKeys = ['gemini', 'gemini-2'];
  const pool = (prov, key, model) => (keyCase === 'shared' ? prov : key) + '|' + model;
  for (const m of ['120b', '20b', 'qwen']) for (const k of groqKeys) e.push({ name: k + '/' + m, model: 'groq/' + m, pool: pool('groq', k, m), group: 'groq/' + m });
  for (const m of ['lite', 'flash', 'gemma']) for (const k of gemKeys) e.push({ name: k + '/' + m, model: 'gemini/' + m, pool: pool('gemini', k, m), group: 'gemini/' + m });
  for (const n of ['nvidia/ultra', 'nvidia/light', 'ovhcloud', 'llm7', 'cloudflare']) e.push({ name: n, model: n, pool: n, group: null });
  e.forEach((x) => Object.assign(x, MODELS[x.model]));
  return e;
}

// ── quota pools: sliding 60 s windows + daily counters (Groq: rolling 24 h ≈ midnight UTC here; Gemini: midnight PT = 08:00 UTC) ──
class Pools {
  constructor() { this.p = new Map(); }
  get(name) { if (!this.p.has(name)) this.p.set(name, { min: [], dayReq: 0, dayTok: 0, neurons: 0, dayStart: 0 }); return this.p.get(name); }
  roll(pool, t, resetHourUTC) {
    const day = Math.floor((t - resetHourUTC * 3600e3) / 86400e3);
    if (pool.dayStart !== day) { pool.dayStart = day; pool.dayReq = 0; pool.dayTok = 0; pool.neurons = 0; }
    while (pool.min.length && pool.min[0].t <= t - 60e3) pool.min.shift();
  }
  // returns null if the call would be accepted, else {kind:'minute'|'day', retryAfterS}
  check(entry, t, tokens) {
    const pool = this.get(entry.pool); this.roll(pool, t, entry.model.startsWith('gemini') ? 8 : 0);
    const rpm = pool.min.length, tpm = pool.min.reduce((a, x) => a + x.tok, 0);
    if (entry.neuronsPerDay && pool.neurons + tokens.neurons > entry.neuronsPerDay) return { kind: 'day', retryAfterS: 0 };
    if (pool.dayReq + 1 > entry.rpd || pool.dayTok + tokens.total > entry.tpd) return { kind: 'day', retryAfterS: entry.model.startsWith('groq') ? 600 : 0 };
    if (rpm + 1 > entry.rpm || tpm + tokens.total > entry.tpm) {
      const oldest = pool.min[0]; return { kind: 'minute', retryAfterS: oldest ? Math.ceil((oldest.t + 60e3 - t) / 1000) : 1 };
    }
    return null;
  }
  // a request the provider accepted (or rejected with a 429 — Groq/Gemini count only accepted ones; we count accepted)
  use(entry, t, tokens) { const pool = this.get(entry.pool); pool.min.push({ t, tok: tokens.total }); pool.dayReq++; pool.dayTok += tokens.total; pool.neurons += tokens.neurons || 0; }
  remainingFrac(entry, t) {
    const pool = this.get(entry.pool); this.roll(pool, t, entry.model.startsWith('gemini') ? 8 : 0);
    const r = Math.min(entry.rpd === Infinity ? 1 : 1 - pool.dayReq / entry.rpd, entry.tpd === Infinity ? 1 : 1 - pool.dayTok / entry.tpd, entry.neuronsPerDay ? 1 - pool.neurons / entry.neuronsPerDay : 1);
    return Math.max(0, r);
  }
}

// ── traffic: GA4 tool_used word buckets (28 days): <300 13K, 300–1000 3K, 1000–3000 2K, 3000+ 1.8K ──
const BUCKETS = [{ p: 13 / 19.8, lo: 20, hi: 300 }, { p: 3 / 19.8, lo: 300, hi: 1000 }, { p: 2 / 19.8, lo: 1000, hi: 3000 }, { p: 1.8 / 19.8, lo: 3000, hi: 6000 }];
const PROMPT_TOK = 281, TOK_PER_WORD = 1.27;
let CHUNK_W = 350, BATCH_W = 1200, BATCH_SPLIT = 1400;   // today; B5 variant: 1,000-word pieces, 3,000-word batches
function requestChunks(words) {
  // frontend: >1,400 words → ~1,200-word batches (each its own request); backend: 350-word target, ≤4 chunks
  const batches = words > BATCH_SPLIT ? Math.ceil(words / BATCH_W) : 1;
  const out = [];
  for (let b = 0; b < batches; b++) {
    const bw = Math.round(words / batches), n = Math.max(1, Math.min(4, Math.ceil(bw / CHUNK_W)));
    out.push(Array.from({ length: n }, () => Math.round(bw / n)));
  }
  return out;   // array of requests, each an array of chunk word counts
}
function tokensFor(words, entry, promptTok) {
  const inT = promptTok + words * TOK_PER_WORD, outT = words * TOK_PER_WORD * 1.05 + (entry.think || 0);
  return { total: Math.round(inT + outT), neurons: (inT * 25608 + outT * 75147) / 1e6 };
}
// ASSUMED diurnal curve (no hourly data was available): mean 1, peak 1.8× at 12:00 UTC, trough 0.25×
const diurnal = (h) => Math.max(0.25, 1 + 0.8 * Math.cos(((h - 12) / 24) * 2 * Math.PI));

function makeTraffic(userRequestsPerDay, seed, days = 2) {
  const r = rng(seed), reqs = [];
  const norm = Array.from({ length: 24 }, (_, h) => diurnal(h)).reduce((a, b) => a + b, 0) / 24;
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    const n = Math.round(userRequestsPerDay / 24 * diurnal(h) / norm);
    for (let i = 0; i < n; i++) {
      let x = r(), b = BUCKETS[0];
      for (const k of BUCKETS) { if (x < k.p) { b = k; break; } x -= k.p; }
      const words = Math.round(b.lo + (b.hi - b.lo) * r() * r());   // skewed to the low end of each band
      const t0 = (d * 24 + h) * 3600e3 + r() * 3600e3;
      // a long document is sent as sequential batch requests; ~15 s apart
      requestChunks(words).forEach((chunks, k) => reqs.push({ t: t0 + k * 15000, words, chunks, short: words <= 300, inst: Math.floor(r() * 2) }));
    }
  }
  return reqs.sort((a, b) => a.t - b.t);
}

// ── one simulated day of a given logic ──
function simulate({ logic, keyCase, userRequestsPerDay, seed = 7, promptTok = PROMPT_TOK }) {
  const entries = buildEntries(keyCase), pools = new Pools(), r = rng(seed + 1);
  const traffic = makeTraffic(userRequestsPerDay, seed);
  const instances = [new Map(), new Map()];            // TODAY: per-instance cooldowns
  const shared = new Map();                            // PROPOSED: shared cooldowns (Redis)
  const probing = new Set();
  let lastGood = {};                                   // group recency (shared via Upstash today too)
  let rot = 0;
  const day2 = 86400e3;
  const st = { req: 0, reqOk: 0, chunks: 0, chunkFail: 0, attempts: 0, wasted429: 0, cfChunks: 0, peakReq: 0, peakFail: 0, tier12Down: [], hourFail: Array(24).fill(0), hourReq: Array(24).fill(0), tier: [0, 0, 0, 0, 0] };

  for (const q of traffic) {
    const counted = q.t >= day2;
    let t = q.t, deadline = q.t + 55000, okAll = true, attempts = 0;
    for (let ci = 0; ci < q.chunks.length; ci++) {
      const words = q.chunks[ci];
      const chunkDeadline = t + (deadline - t) / (q.chunks.length - ci);
      let done = false, tried = 0;
      // chain order
      let order;
      if (logic === 'today') {
        order = orderToday(entries, rot++, lastGood);
      } else {
        order = orderProposed(entries, pools, t, rot++);
      }
      const cd = logic === 'today' ? instances[q.inst] : shared;
      for (const e of order) {
        if (done) break;
        const cdUntil = cd.get(e.name) || 0;
        if (logic === 'today') {
          // every entry cooling → try the soonest anyway (soonestIfAllCooling); approximated by skipping only
          if (cdUntil > t) continue;
        } else {
          if (cdUntil > t) continue;
          if (cdUntil && probing.has(e.name)) continue;   // single probe after a cooldown
          if (tried >= 3 && e.tier < 4) continue;          // at most 3 providers, then the safety net
          // pacing: don't send what the provider would refuse (known limits, shared counters)
          const tok = tokensFor(words, e, promptTok);
          const pre = pools.check(e, t, tok);
          if (pre) continue;
          // 15 % reserve for short requests
          if (!q.short && e.tier <= 2 && pools.remainingFrac(e, t) < 0.15) continue;
        }
        const until = e.tier === 4 ? deadline : chunkDeadline - 5000;
        if (until - t < 1500) continue;
        const tok = tokensFor(words, e, promptTok);
        // latency grows with the answer: e.lat is for a ~350-word chunk (~470 output tokens)
        const lat = e.lat * (0.35 + 0.65 * (words * TOK_PER_WORD * 1.05 + (e.think || 0)) / 470) * (0.6 + 0.8 * r());
        attempts++; tried++;
        const refuse = pools.check(e, t, tok);
        if (refuse) {
          if (counted) st.wasted429++;
          t += 300;
          if (logic === 'today') {
            // api/process.js: per-minute → 60 s (or retry-after clamped 5 s…15 min), per-day → 15 min (or ra, ≤6 h)
            const ms = refuse.kind === 'day' ? Math.max(15 * 60e3, refuse.retryAfterS * 1000) : (refuse.retryAfterS ? Math.min(15 * 60e3, Math.max(5000, refuse.retryAfterS * 1000)) : 60e3);
            cd.set(e.name, t + ms);
          } else {
            const ms = refuse.kind === 'day' ? untilReset(e, t) - t : refuse.retryAfterS * 1000;
            cd.set(e.name, t + ms + r() * 3000); probing.add(e.name);
          }
          continue;
        }
        if (lat > until - t) {            // timeout: the provider still counts the call
          const avail = until - t;
          pools.use(e, t, tok); t = until;
          if (logic === 'today' && avail >= 8000 && e.tier < 4) cd.set(e.name, t + 120e3);
          continue;
        }
        pools.use(e, t, tok);
        t += lat;
        if (r() < e.err) continue;        // 5xx / empty answer → next provider
        done = true; probing.delete(e.name);
        if (e.group) lastGood[e.group] = t;
        if (counted && e.tier === 4) st.cfChunks++;
        if (counted) st.tier[e.tier]++;
      }
      if (counted) { st.chunks++; if (!done) st.chunkFail++; }
      if (!done) okAll = false;
      t += 600;                             // CHUNK_INTER_DELAY
    }
    if (counted) {
      const h = Math.floor((q.t % 86400e3) / 3600e3);
      st.req++; if (okAll) st.reqOk++; st.attempts += attempts; st.hourReq[h]++; if (!okAll) st.hourFail[h]++;
      // "all cooled down": every Tier 1–2 entry unusable on this instance / shared state
      const cdm = logic === 'today' ? instances[q.inst] : shared;
      const down = entries.filter((e) => e.tier <= 2).every((e) => (cdm.get(e.name) || 0) > q.t || pools.remainingFrac(e, q.t) === 0);
      if (down) st.tier12Down.push(h);
    }
  }
  const peakH = st.hourReq.indexOf(Math.max(...st.hourReq));
  const firstDown = st.tier12Down.length ? Math.min(...st.tier12Down) : null;
  return {
    logic, keyCase, userRequestsPerDay,
    requests: st.req, requestsOk: st.reqOk, requestOkPct: +(100 * st.reqOk / st.req).toFixed(1),
    chunks: st.chunks, chunkFailPct: +(100 * st.chunkFail / st.chunks).toFixed(2),
    peakHourUTC: peakH, peakHourFailPct: +(100 * st.hourFail[peakH] / Math.max(1, st.hourReq[peakH])).toFixed(1),
    attemptsPerRequest: +(st.attempts / st.req).toFixed(2), attemptsPerChunk: +(st.attempts / st.chunks).toFixed(2),
    servedByTierPct: st.tier.slice(1).map((n) => +(100 * n / st.chunks).toFixed(1)), wasted429PerDay: st.wasted429,
    cloudflareSharePct: +(100 * st.cfChunks / st.chunks).toFixed(1),
    tier12AllDownHoursUTC: [...new Set(st.tier12Down)].length, firstAllDownHourUTC: firstDown,
  };
}
function untilReset(e, t) { const h = e.model.startsWith('gemini') ? 8 : 0; const d = Math.floor((t - h * 3600e3) / 86400e3); return (d + 1) * 86400e3 + h * 3600e3; }

// TODAY: tiers in order; within Tiers 1, 2 and 4 the most recently successful group goes first; each
// Groq/Gemini group rotated across keys by the request counter.
function orderToday(entries, rot, lastGood) {
  const groups = new Map();
  for (const e of entries) { const g = e.group || e.name; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); }
  const list = [...groups.entries()].map(([g, es]) => ({ g, tier: es[0].tier, es: es.slice(rot % es.length).concat(es.slice(0, rot % es.length)), idx: entries.indexOf(es[0]) }));
  list.sort((a, b) => (a.tier - b.tier) || (a.tier === 3 ? a.idx - b.idx : ((lastGood[b.g] || 0) - (lastGood[a.g] || 0)) || a.idx - b.idx));
  return list.flatMap((x) => x.es);
}
// PROPOSED: tiers in order; inside a tier, entries sorted by remaining daily capacity (headers / shared counters)
function orderProposed(entries, pools, t, rot) {
  return entries.map((e, i) => ({ e, i, rem: pools.remainingFrac(e, t) + ((i + rot) % 7) * 1e-6 }))
    .sort((a, b) => (a.e.tier - b.e.tier) || (b.rem - a.rem) || a.i - b.i).map((x) => x.e);
}

// ── runs ──
const out = { generated: new Date().toISOString(), assumptions: {
  diurnal: 'ASSUMED cosine, peak 1.8× mean at 12:00 UTC, trough 0.25× (no hourly data available)',
  instances: 'today: 2 warm Fluid instances, each with its own in-memory cooldowns (assumed)',
  latencies_ms: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.lat])),
  errors: 'non-quota error shares: Gemini 5 % (AI Studio shows 500/503 ≈ 2/3 of its errors), NVIDIA 15 % (Vercel 16.7 %), others small',
  tokens: 'prompt 281 + 1.27 tok/word in, 1.05× out, + reasoning (gpt-oss low ≈120, Gemini Flash medium ≈400, Flash-Lite minimal ≈30)',
  traffic: 'GA4 word buckets; "user requests" = tool_used-style requests (a 3,000-word doc = 3 batch requests)',
}, runs: [] };
const demands = [800, 1200, 1600, 2400, 3200, 4800];
for (const keyCase of ['separate', 'shared']) for (const logic of ['today', 'proposed']) for (const d of demands) out.runs.push(simulate({ logic, keyCase, userRequestsPerDay: d }));
// capacity = highest demand with ≥ 99 % of requests fully served
const cap = {};
for (const keyCase of ['separate', 'shared']) for (const logic of ['today', 'proposed']) {
  let lo = 200, hi = 20000;
  while (hi - lo > 50) { const mid = Math.round((lo + hi) / 2); const r = simulate({ logic, keyCase, userRequestsPerDay: mid }); if (r.requestOkPct >= 99) lo = mid; else hi = mid; }
  cap[keyCase + '/' + logic] = lo;
}
out.capacityAt99pct = cap;
// prompt diet on top of the proposed logic (shortened prompt 123 tokens)
for (const keyCase of ['separate', 'shared']) {
  let lo = 200, hi = 20000;
  while (hi - lo > 50) { const mid = Math.round((lo + hi) / 2); const r = simulate({ logic: 'proposed', keyCase, userRequestsPerDay: mid, promptTok: 123 }); if (r.requestOkPct >= 99) lo = mid; else hi = mid; }
  cap[keyCase + '/proposed+shortPrompt'] = lo;
}
// B5: adaptive chunking modelled as 1,000-word pieces in up to 3,000-word batches (no splitting failures modelled)
CHUNK_W = 1000; BATCH_W = 3000; BATCH_SPLIT = 3000;
for (const keyCase of ['separate', 'shared']) for (const logic of ['today', 'proposed']) {
  let lo = 200, hi = 30000;
  while (hi - lo > 50) { const mid = Math.round((lo + hi) / 2); const r = simulate({ logic, keyCase, userRequestsPerDay: mid }); if (r.requestOkPct >= 99) lo = mid; else hi = mid; }
  cap[keyCase + '/' + logic + '+chunk1000'] = lo;
}
{ let lo = 200, hi = 30000; while (hi - lo > 50) { const mid = Math.round((lo + hi) / 2); const r = simulate({ logic: 'proposed', keyCase: 'shared', userRequestsPerDay: mid, promptTok: 123 }); if (r.requestOkPct >= 99) lo = mid; else hi = mid; } cap['shared/ALL (proposed+shortPrompt+chunk1000)'] = lo; }
{ let lo = 200, hi = 40000; while (hi - lo > 50) { const mid = Math.round((lo + hi) / 2); const r = simulate({ logic: 'proposed', keyCase: 'separate', userRequestsPerDay: mid, promptTok: 123 }); if (r.requestOkPct >= 99) lo = mid; else hi = mid; } cap['separate/ALL (proposed+shortPrompt+chunk1000)'] = lo; }
out.b5at1200 = ['separate', 'shared'].map((k) => simulate({ logic: 'proposed', keyCase: k, userRequestsPerDay: 1200 }));
CHUNK_W = 350; BATCH_W = 1200; BATCH_SPLIT = 1400;
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'b8-sim.json'), JSON.stringify(out, null, 1));
console.table(out.runs);
console.log('capacity (user requests/day with ≥99 % fully served):', cap);
