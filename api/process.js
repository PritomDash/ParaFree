// ═══════════════════════════════════════════════════
// ParaFree — Secure Backend API (process.js)
// Place this file at: api/process.js in your GitHub repo
// Keys stored ONLY in Vercel Environment Variables
// ═══════════════════════════════════════════════════

// ── RATE LIMIT CONSTANTS ──
const HOURLY_LIMIT       = 200;              // 200 requests per hour per IP
const HOURLY_WINDOW      = 60 * 60 * 1000;  // 1 hour
const BURST_LIMIT        = 15;              // max requests within burst window
const BURST_WINDOW       = 8 * 1000;        // 8 seconds
const BURST_BLOCK        = 20 * 60 * 1000;  // block 20 min on burst (was 1 hour)
const DUPE_THRESHOLD     = 8;              // same text N times = bot (was 5)
const DUPE_BLOCK         = 30 * 60 * 1000; // block 30 mins on duplicate spam
const MAX_TEXT_LENGTH    = 50000;

// Provider timeout budget (writing chain)
// Sequential processing (CHUNK_CONCURRENCY=1) means no parallel pressure — give providers time.
// Many providers need 5-10s for 600-word output (OVH, LLM7, OpenRouter Qwen, Scaleway).
// With 4 max chunks × 10s = 40s per backend call — safely under the 60s Vercel limit.
const FAST_TIMEOUT = 10000;  // ms per provider; was 4000 which timed out working slow providers
const LAST_TIMEOUT = 14000;  // ms for the last-resort provider
const SLOW_TIMEOUT = 25000;  // ms for slow providers (OVHcloud, LLM7, NVIDIA) — they need 10-20s per chunk
const REQUEST_BUDGET = 55000; // ms — every provider timeout is clipped so the whole request ends under maxDuration=60s
const MIN_ATTEMPT_MS = 1500;  // don't start a provider call with less time than this left in the budget
const SAFETY_NET_MS  = 5000;  // ms each chunk keeps back for the Cloudflare safety net (Tier 4, ~1-3 s per chunk)
const TIMEOUT_COOLDOWN        = 2 * 60 * 1000; // a model that timed out sits out 2 min (this instance)…
const TIMEOUT_COOLDOWN_MIN_MS = 8000;          // …only if it had at least 8 s (not when the budget clipped it)

// NOTE: In-memory only — resets on every Vercel cold start.
const rateLimitMap = new Map();
let lastCleanup = Date.now();
let requestCounter = 0; // writing-chain rotation: spreads per-minute load across providers

// Fingerprint = first 200 chars + total length (avoids storing full text in memory)
function textFingerprint(text) {
  return text ? text.slice(0, 200) + '|' + text.length : '';
}

// ── RATE LIMITING ──
// Returns { allowed, remaining, reason }
function checkRateLimit(ip, text) {
  const now = Date.now();

  // Periodic cleanup: remove stale entries every 10 minutes to prevent memory growth
  if (now - lastCleanup > 10 * 60 * 1000) {
    for (const [key, e] of rateLimitMap.entries()) {
      if (e.resetAt < now && e.blockedUntil < now) rateLimitMap.delete(key);
    }
    lastCleanup = now;
  }

  let e = rateLimitMap.get(ip);
  if (!e) {
    e = { count: 0, resetAt: now + HOURLY_WINDOW, burstTs: [], blockedUntil: 0, blockReason: '', fps: [] };
    rateLimitMap.set(ip, e);
  }

  // If actively blocked (burst or duplicate spam), reject immediately
  if (e.blockedUntil > now) {
    return { allowed: false, remaining: 0, reason: e.blockReason };
  }

  // Reset hourly window when expired
  if (now > e.resetAt) {
    e.count = 0;
    e.resetAt = now + HOURLY_WINDOW;
    e.burstTs = [];
    e.fps = [];
  }

  // ── BURST DETECTION: 10 requests within 5 seconds = bot ──
  e.burstTs = e.burstTs.filter(t => now - t < BURST_WINDOW);
  if (e.burstTs.length >= BURST_LIMIT) {
    e.blockedUntil = now + BURST_BLOCK;
    e.blockReason  = 'burst';
    console.warn('[RateLimit] Burst detected from', ip);
    return { allowed: false, remaining: 0, reason: 'burst' };
  }

  // ── DUPLICATE TEXT DETECTION: same text 5+ times = bot ──
  const fp = textFingerprint(text);
  if (fp) {
    const dupes = e.fps.filter(f => f === fp).length;
    if (dupes >= DUPE_THRESHOLD) {
      e.blockedUntil = now + DUPE_BLOCK;
      e.blockReason  = 'duplicate';
      console.warn('[RateLimit] Duplicate text spam from', ip);
      return { allowed: false, remaining: 0, reason: 'duplicate' };
    }
    e.fps.push(fp);
    if (e.fps.length > 30) e.fps.shift(); // keep last 30 fingerprints
  }

  // ── HOURLY LIMIT ──
  if (e.count >= HOURLY_LIMIT) {
    return { allowed: false, remaining: 0, reason: 'hourly' };
  }

  // All checks passed — consume quota
  e.count++;
  e.burstTs.push(now);
  return { allowed: true, remaining: HOURLY_LIMIT - e.count };
}

// ── UPSTASH REDIS CACHE (graceful — skipped if env vars missing) ──
let redis = null;
(function initRedis() {
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      console.log('[ParaFree] Redis: KV env vars not set — job caching skipped');
      return;
    }
    const { Redis } = require('@upstash/redis');
    redis = Redis.fromEnv();
    console.log('[ParaFree] Redis: connected');
  } catch (e) {
    console.error('[ParaFree] Redis init error:', e.message);
  }
})();

function decodeSnippet(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ── JOB SEARCH HANDLER (Phases 2-4: Jooble + cache + fallback) ──
async function handleJobSearch(body) {
  const jobTitle = (body.jobTitle || '').trim();
  const country  = (body.country  || '').trim();

  if (!jobTitle) return { success: false, error: 'jobTitle required' };

  // Build fallback links (always available, mirrors the existing updateJobSearch() logic)
  const encTitle  = encodeURIComponent(jobTitle);
  const encLoc    = encodeURIComponent(country);
  const seekTitle = jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'jobs';
  const seekCity  = (country.split(',')[0] || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'australia';
  const fallbackLinks = {
    linkedin: `https://www.linkedin.com/jobs/search/?keywords=${encTitle}&location=${encLoc}`,
    indeed:   `https://www.indeed.com/jobs?q=${encTitle}&l=${encLoc}`,
    seek:     `https://www.seek.com.au/${seekTitle}-jobs/in-${seekCity}`,
    google:   `https://www.google.com/search?q=${encodeURIComponent(jobTitle + ' jobs in ' + country)}&ibp=htl;jobs`
  };

  const JOOBLE_KEY = process.env.JOOBLE_KEY;
  console.log('[ParaFree] jobSearch: JOOBLE_KEY', JOOBLE_KEY ? `PRESENT (${JOOBLE_KEY.length} chars)` : 'NOT SET');
  if (!JOOBLE_KEY) {
    return { success: true, fallback: true, fallbackLinks, source: 'no-key' };
  }

  // Cache key: normalized title + country (e.g. "jobs:marketing manager:australia")
  const cacheKey = 'jobs:' + jobTitle.toLowerCase() + ':' + country.toLowerCase();

  // Phase 3: check cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('[ParaFree] jobSearch: cache hit', cacheKey);
        return { success: true, jobs: cached, source: 'cache', fallbackLinks };
      }
    } catch (e) {
      console.error('[ParaFree] Redis get error:', e.message);
    }
  }

  // Phase 2: call Jooble
  // Request shape:  POST https://jooble.org/api/{KEY}  body: { keywords, location, page, resultsOnPage }
  // Response shape: { totalCount: N, jobs: [ { title, company, location, link, salary, snippet, type, updated } ] }
  try {
    console.log('[ParaFree] jobSearch: calling Jooble for', JSON.stringify({ jobTitle, country }));
    const joobleRes = await fetchWithTimeout(
      `https://jooble.org/api/${JOOBLE_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ keywords: jobTitle, location: country, page: 1, resultsOnPage: 10 })
      },
      8000
    );

    if (!joobleRes.ok) {
      let b = ''; try { b = await joobleRes.text(); } catch(_) {}
      throw new Error(`Jooble:${joobleRes.status} ${b.slice(0, 200)}`);
    }

    const data = await joobleRes.json();
    const seen = new Set();
    const jobs = (data.jobs || [])
      .filter(j => {
        const key = j.link || `${j.title}|${j.company || ''}`;
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      })
      .slice(0, 10)
      .map(j => ({
        title:    j.title    || '',
        company:  j.company  || '',
        location: j.location || '',
        link:     j.link     || '',
        salary:   j.salary   || '',
        snippet:  decodeSnippet(j.snippet || '')
      }));

    if (jobs.length === 0) {
      console.log('[ParaFree] jobSearch: Jooble returned 0 results — using fallback');
      return { success: true, fallback: true, fallbackLinks, source: 'no-results' };
    }

    // Phase 3: cache result with 10-day TTL
    if (redis) {
      try {
        await redis.set(cacheKey, jobs, { ex: 864000 });
        console.log('[ParaFree] jobSearch: cached', jobs.length, 'jobs →', cacheKey);
      } catch (e) {
        console.error('[ParaFree] Redis set error:', e.message);
      }
    }

    return { success: true, jobs, source: 'jooble', totalCount: data.totalCount || jobs.length, fallbackLinks };

  } catch (e) {
    // Phase 4: any Jooble failure → fallback links, never crash
    console.error('[ParaFree] Jooble error:', e.message);
    return { success: true, fallback: true, fallbackLinks, source: 'jooble-error' };
  }
}

// ── KEY VALIDATION ──
function validKey(k) {
  return k && k.length > 10;
}

// ── FETCH WITH TIMEOUT ──
// Wraps fetch with an AbortController so a hanging provider fails fast,
// leaving budget for fallbacks. Default FAST_TIMEOUT (10 s); last-resort provider passes LAST_TIMEOUT.
function fetchWithTimeout(url, options, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

// ── ADMIN PASSWORD ──
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

// ── API CALLERS ──
// Set GROQ_MODEL env var in Vercel to override — check console.groq.com/docs/models for current IDs.
const GROQ_MODEL   = process.env.GROQ_MODEL   || "openai/gpt-oss-120b";
const isGptOss = (model) => /gpt-oss/i.test(model);
const GEMINI_MODEL = "gemini-3.5-flash-lite";            // callGemini default (health check, legacy callers)
const CF_MODEL     = "@cf/meta/llama-3.1-8b-instruct";   // callCloudflare default

// ── MODEL DISCOVERY ──
// Which model each slot uses comes from preference lists (GROQ_MODEL_PREFS, GEMINI_MODEL_PREFS,
// CF_MODEL_PREFS, NVIDIA_MODEL_PREFS) resolved against each provider's live model list —
// retired models are replaced without code changes. See api/_model-discovery.js.
const { createModelDiscovery } = require("./_model-discovery");
const ratings = require("./_ratings");
const usage = require("./_usage");
const studypack = require("./_studypack");
const discovery = createModelDiscovery({ fetchWithTimeout, getRedis: () => redis });

// ── PROVIDER CHAIN ──
// One working chain shared by every tool: paraphrase, humanize, summarize, grammar,
// detector, CV builder and ParaFree AI chat/code. Every key+model is its own entry
// (own cooldown), named "<key>/<model>" for Groq, Gemini-key and NVIDIA models.
// Each Groq / Gemini model group is rotated per chunk/request (startOffset) across that
// provider's keys (groq, groq-2, groq-3, groq-4 / gemini, gemini-2 — extra keys only when set).
//   TIER 1 — first resolved model of: groq ×keys → gemini ×keys
//   TIER 2 — following resolved models: groq ×keys per model → gemini ×keys per model
//   TIER 3 — stronger backups in TIER3_ORDER (fixed quality/speed order, never reordered by
//            recent success): nvidia nemotron-3-ultra-550b → nvidia nemotron-3.5-lightning-30b
//            (fast) → ovhcloud Llama 3.3 70B → llm7
//   TIER 4 — cloudflare (ALL its slots): a small ~8B model — the fast safety net, always last
// Env FALLBACK_ORDER (comma-separated, "nvidia#N" = Nth resolved NVIDIA model) replaces TIER3_ORDER.
const TIER3_ORDER = (process.env.FALLBACK_ORDER || "nvidia#0,nvidia#1,ovhcloud,llm7")
  .split(",").map(s => s.trim()).filter(Boolean);
const tier3Rank = (name) => { const i = TIER3_ORDER.indexOf(name); return i === -1 ? 1900 : 1000 + i; };
const SLOT_RANK = {
  groq:       (slot) => slot === 0 ? 0 : 10 + slot,
  gemini:     (slot) => slot === 0 ? 1 : 100 + slot,
  nvidia:     (slot) => TIER3_ORDER.includes("nvidia#" + slot) ? tier3Rank("nvidia#" + slot) : 1100 + slot,
  cloudflare: (slot) => 5000 + slot,
};

// Permanently dead providers (billing walls, paid-only plans, revoked keys).
// Their callers and add() lines are kept — remove a name here to re-enable it.
const DISABLED_PROVIDERS = new Set([
  "openrouter", "mistral", "mistral-2", "sambanova", "chutes", "scaleway",
  "deepseek", "deepseek-coder", "huggingface", "qwen-coder",
  "extra1", "extra2", "extra3", "extra4", "extra5", "extra6",
]);

const PROVIDER_TIMEOUTS = { ovhcloud: SLOW_TIMEOUT, llm7: SLOW_TIMEOUT, nvidia: SLOW_TIMEOUT };

// One chain entry for a resolved slot (`slot` = position among the key's resolved models,
// `patternIndex` = which preference slot it came from — used for "last good" tracking).
// If the model turns out to be retired (HTTP 404/410, or decommissioned/retired/deprecated),
// it is marked dead and the SAME entry retries at once with the model the slot now resolves to.
function slotEntry(provider, pk, slot, model, call, nameFor, patternIndex = slot) {
  const entry = {
    name: nameFor(model), rank: SLOT_RANK[provider](slot), group: provider === "groq" || provider === "gemini" ? provider + ":" + slot : undefined,
    pk, patternIndex, model,
    async fn(ms) {
      const deadline = Date.now() + ms;
      let m = model;
      for (let attempt = 0; ; attempt++) {
        try {
          return await call(m, Math.max(MIN_ATTEMPT_MS, deadline - Date.now()));
        } catch (e) {
          if (attempt >= 3 || !discovery.isDeadModelError(e.message)) throw e;
          const next = await discovery.markDead(provider, m, e.message, pk, slot);
          if (!next || next === m || deadline - Date.now() < MIN_ATTEMPT_MS) throw e;
          m = next;
          entry.model = m;
          entry.name = nameFor(m);
        }
      }
    }
  };
  return entry;
}

// Slot entries for every resolved model: Groq / Gemini (Tiers 1–2), NVIDIA (Tier 3), Cloudflare
// (Tier 4). callers.groq(key) / gemini(key) and callers.nvidia / cloudflare return
// (model, ms) => Promise<string> for the path being built (writing or chat).
function slotEntries(keys, callers) {
  const out = [];
  const add = (provider, pk, call, nameFor) => {
    let pos = 0;
    discovery.slots(pk).forEach((s, patternIndex) => {
      if (!s.model) return;
      const slot = pos++;
      out.push(slotEntry(provider, pk, slot, s.model, call, (m) => nameFor(m, slot), patternIndex));
    });
  };
  const groqKeys = { "groq": keys.GROQ_KEY, "groq-2": keys.GROQ_KEY_2, "groq-3": keys.GROQ_KEY_3, "groq-4": keys.GROQ_KEY_4 };
  for (const [k, key] of Object.entries(groqKeys)) {
    if (validKey(key)) add("groq", k, callers.groq(key), (m) => k + "/" + m);
  }
  const geminiKeys = { "gemini": keys.GEMINI_KEY, "gemini-2": keys.GEMINI_KEY_2 };
  for (const [k, key] of Object.entries(geminiKeys)) {
    if (validKey(key)) add("gemini", k, callers.gemini(key), (m) => k + "/" + m);
  }
  if (validKey(keys.NVIDIA_KEY)) add("nvidia", "nvidia", callers.nvidia, (m) => "nvidia/" + m);
  if (validKey(keys.CF_KEY) && validKey(keys.CF_ACCOUNT)) {
    add("cloudflare", "cloudflare", callers.cloudflare, (m, slot) => slot === 0 ? "cloudflare" : "cloudflare/" + m);
  }
  return out;
}

// Rank of a chain entry: slot entries carry `rank`; ovhcloud / llm7 follow TIER3_ORDER
// (unlisted names go to the end of Tier 3). Tiers: 0–9 = 1, 10–999 = 2, 1000–4999 = 3, 5000+ = 4.
function rankOf(c) { return c.rank !== undefined ? c.rank : tier3Rank(c.name); }
function tierOf(c) { const r = rankOf(c); return r < 10 ? 1 : r < 1000 ? 2 : r < 5000 ? 3 : 4; }

// Drops disabled providers, sorts by rank and rotates each run of same-`group` entries (one
// Groq or Gemini slot across that provider's keys) by startOffset, so consecutive chunks start
// on a different key.
// Then, WITHIN Tiers 1, 2 and 4 only, the most recently successful entry goes first ("last known
// good", shared across instances). Tier 3 keeps its fixed quality order. Tiers are never
// reordered against each other, and entries that tie (no recent success, or the same 10-minute
// bucket) keep the rotation order.
function orderChain(candidates, startOffset) {
  const active = candidates.filter(c => !DISABLED_PROVIDERS.has(c.name)).sort((a, b) => rankOf(a) - rankOf(b));
  const out = [];
  for (let i = 0; i < active.length;) {
    let j = i + 1;
    if (active[i].group) while (j < active.length && active[j].group === active[i].group) j++;
    const run = active.slice(i, j);
    const s = active[i].group ? startOffset % run.length : 0;
    out.push(...run.slice(s), ...run.slice(0, s));
    i = j;
  }
  // A Groq / Gemini group (one model across the keys) shares the recency of its most recent
  // member, so the keys tie with each other and the rotation keeps spreading load across them.
  const groupRecency = {};
  for (const c of out) if (c.group) groupRecency[c.group] = Math.max(groupRecency[c.group] ?? -1, discovery.recency(c.name));
  const recent = (c, tier) => tier === 3 ? -1 : c.group ? groupRecency[c.group] : discovery.recency(c.name);
  return out
    .map((c, idx) => { const tier = tierOf(c); return { c, idx, tier, recent: recent(c, tier) }; })
    .sort((a, b) => (a.tier - b.tier) || (b.recent - a.recent) || (a.idx - b.idx))
    .map(x => x.c);
}

// ── PROVIDER COOLDOWN ──
// A provider that returns a rate-limit/quota error is skipped for a while instead of
// being retried on every chunk: 60 s for per-minute limits, 15 min for daily quotas. When the
// provider says how long to wait (Retry-After header / Gemini retryDelay) that is used instead:
// per-minute → 5 s…15 min, daily → at least 15 min, at most 6 h.
// A Tier 1–3 model that times out with ≥8 s to work with sits out TIMEOUT_COOLDOWN (2 min).
// In-memory only (per serverless instance) — resets on cold start. The health-check skip list
// and dead-model marks are the shared (Upstash) part.
const MINUTE_COOLDOWN = 60 * 1000;
const DAILY_COOLDOWN  = 15 * 60 * 1000;
const MAX_COOLDOWN    = 6 * 60 * 60 * 1000;
const providerCooldowns = new Map(); // name → epoch ms when it may be tried again

function isQuotaError(msg) {
  return /:429\b|quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(msg || "");
}
// Daily quotas: Groq "requests per day (RPD)" / "tokens per day (TPD)", Gemini "...PerDay..." /
// "per_day", Cloudflare "used up your daily free allocation". Anything else is per-minute.
const DAILY_RE = /per.?day|daily|\bRPD\b|\bTPD\b/i;
function quotaCooldown(msg) {
  return DAILY_RE.test(msg || "") ? DAILY_COOLDOWN : MINUTE_COOLDOWN;
}
function retryAfterMs(msg) {
  const m = /\[retry-after (\d+)s\]/.exec(msg || "");
  return m ? Number(m[1]) * 1000 : 0;
}
function quotaCooldownMs(msg) {
  const base = quotaCooldown(msg), ra = retryAfterMs(msg);
  if (!ra) return base;
  return base === DAILY_COOLDOWN ? Math.min(MAX_COOLDOWN, Math.max(DAILY_COOLDOWN, ra)) : Math.min(DAILY_COOLDOWN, Math.max(5000, ra));
}
// Error detail for a failed call: the first 200 characters of the body, plus for a 429
// "[per-day quota]" when the daily marker sits further down (Gemini's quota id "…PerDay…" comes
// well after 200 characters) and "[retry-after Ns]" from the Retry-After header or retryDelay.
function errDetail(res, body) {
  const b = String(body || "");
  let d = b.slice(0, 200);
  if (res.status !== 429) return d;
  if (DAILY_RE.test(b) && !DAILY_RE.test(d)) d += " [per-day quota]";
  let ra = 0;
  try { ra = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 0; } catch (_) {}
  if (!ra) { const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(b); if (m) ra = Number(m[1]); }
  if (ra > 0) d += " [retry-after " + Math.ceil(ra) + "s]";
  return d;
}
// Cooling = rate-limit cooldown (this instance) OR on the shared health-check skip list.
function cooldownUntil(name) {
  let until = providerCooldowns.get(name) || 0;
  if (until && until <= Date.now()) { providerCooldowns.delete(name); until = 0; }
  return Math.max(until, discovery.skipUntil(name));
}
function isCoolingDown(name) {
  return cooldownUntil(name) > Date.now();
}
function startCooldown(name, msg, ms = quotaCooldownMs(msg), why = quotaCooldown(msg) === DAILY_COOLDOWN ? 'daily quota' : 'rate-limited') {
  providerCooldowns.set(name, Date.now() + ms);
  console.log(`[ParaFree] ⏸ ${name} ${why} — skipping it for ${Math.round(ms / 1000)}s`);
}
// If EVERY candidate is cooling down, returns the one whose cooldown ends soonest
// (it gets tried anyway rather than failing outright); otherwise null.
function soonestIfAllCooling(candidates) {
  if (candidates.length === 0 || !candidates.every(c => isCoolingDown(c.name))) return null;
  const pick = candidates.reduce((a, b) => cooldownUntil(b.name) < cooldownUntil(a.name) ? b : a);
  console.log(`[ParaFree] ⏸ all providers cooling down — trying ${pick.name} (cooldown ends soonest, in ${Math.ceil((cooldownUntil(pick.name) - Date.now()) / 1000)}s)`);
  return pick;
}
// Per-provider timeout ("nvidia/<model>" uses the nvidia value), clipped to `until`.
function providerTimeout(name, until) {
  return Math.min(PROVIDER_TIMEOUTS[name] || PROVIDER_TIMEOUTS[name.split("/")[0]] || FAST_TIMEOUT, until - Date.now());
}

async function callGroq(text, prompt, key, maxTokens = 2048, ms, model = GROQ_MODEL) {
  console.log("[ParaFree] Trying: groq/" + model);
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens,
      // gpt-oss models are reasoning models; "low" is fastest for paraphrase. Other models reject it.
      ...(isGptOss(model) ? { reasoning_effort: "low" } : {})
    })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Groq/" + model + ":" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Groq: no response");
  const content = data.choices[0].message?.content;
  if (content === null || content === undefined) {
    throw new Error("Groq: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  }
  return content;
}

async function callGemini(text, prompt, key, maxTokens = 2048, ms, model = GEMINI_MODEL) {
  console.log("[ParaFree] Trying: gemini/" + model);
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + "\n\n" + text }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens }
    })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Gemini/" + model + ":" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (data.error) throw new Error("Gemini/" + model + ":" + data.error.message);
  if (!data.candidates || !data.candidates[0]) throw new Error("Gemini/" + model + ": no response");
  return data.candidates[0].content.parts[0].text;
}

async function callCerebras(text, prompt, key) {
  console.log("[ParaFree] Trying: cerebras");
  const res = await fetchWithTimeout("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch(_) {}
    throw new Error("Cerebras:" + res.status + " " + errBody.slice(0, 100));
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Cerebras: no response");
  return data.choices[0].message.content;
}

async function callOpenRouter(text, prompt, key, maxTokens = 2048) {
  console.log("[ParaFree] Trying: openrouter");
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "qwen/qwen3.8-27b:free",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("OpenRouter:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("OpenRouter: no response");
  const _oc = data.choices[0].message?.content;
  if (_oc === null || _oc === undefined) throw new Error("OpenRouter: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _oc;
}

async function callOpenRouterModel(text, prompt, key, model) {
  console.log("[ParaFree] Trying: openrouter/" + model);
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "HTTP-Referer": "https://parafree.app", "X-Title": "ParaFree" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 4096 })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("OpenRouter/" + model + ":" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("OpenRouter/" + model + ": no response");
  const _orm = data.choices[0].message?.content;
  if (_orm === null || _orm === undefined) throw new Error("OpenRouter/" + model + ": null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _orm;
}

async function callGroqModel(text, prompt, key, model, ms) {
  console.log("[ParaFree] Trying: groq/" + model);
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 4096 })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Groq/" + model + ":" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Groq/" + model + ": no response");
  const content = data.choices[0].message?.content;
  if (content === null || content === undefined) {
    throw new Error("Groq/" + model + ": null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  }
  return content;
}

async function callMistral(text, prompt, key, maxTokens = 2048) {
  console.log("[ParaFree] Trying: mistral");
  const res = await fetchWithTimeout("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Mistral:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Mistral: no response");
  const _mc = data.choices[0].message?.content;
  if (_mc === null || _mc === undefined) throw new Error("Mistral: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _mc;
}

async function callCloudflare(text, prompt, key, account, maxTokens = 2048, ms, model = CF_MODEL) {
  console.log("[ParaFree] Trying: cloudflare/" + model);
  const res = await fetchWithTimeout(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/run/" + model,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt + "\n\n" + text }], max_tokens: maxTokens })
    },
    ms
  );
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Cloudflare:" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.success) throw new Error("Cloudflare: " + JSON.stringify(data.errors));
  return data.result.response;
}

async function callGLM(text, prompt, key, maxTokens = 1500) {
  console.log("[ParaFree] Trying: glm");
  const res = await fetchWithTimeout("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "glm-4-flash", // free-tier model; ⚠️ Zhipu AI (Chinese company)
      messages: [
        { role: "system", content: prompt },
        { role: "user",   content: text }
      ],
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("GLM:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  const result = data.choices?.[0]?.message?.content;
  if (!result) throw new Error("GLM: empty response");
  return result;
}

async function callExtra(text, prompt, key, label, maxTokens = 1500) {
  console.log("[ParaFree] Trying:", label);
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "qwen/qwen3.8-27b:free",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error(label + ":" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error(label + ": no response");
  const _ec = data.choices[0].message?.content;
  if (_ec === null || _ec === undefined) throw new Error(label + ": null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _ec;
}

async function callSambaNova(text, prompt, key) {
  console.log("[ParaFree] Trying: sambanova");
  const res = await fetchWithTimeout("https://api.sambanova.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "Meta-Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("SambaNova:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("SambaNova: no response");
  return data.choices[0].message.content;
}

// One NVIDIA model per call: each resolved NVIDIA model (NVIDIA_MODEL_PREFS) is its own chain
// entry ("nvidia/<model>"). A 404/410 is marked dead by the entry, which retries at once with the
// model its slot now resolves to.
async function callNvidiaModel(text, prompt, key, maxTokens = 1500, ms = FAST_TIMEOUT, model) {
  console.log("[ParaFree] Trying: nvidia/" + model);
  const res = await fetchWithTimeout("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: maxTokens, stream: false })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("NVIDIA/" + model + ":" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("NVIDIA/" + model + ": no response");
  const content = data.choices[0].message?.content;
  if (content === null || content === undefined) throw new Error("NVIDIA/" + model + ": null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return content;
}

async function callOVHcloud(text, prompt, maxTokens = 1500, ms) {
  console.log("[ParaFree] Trying: ovhcloud");
  const res = await fetchWithTimeout("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "Meta-Llama-3_3-70B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("OVHcloud:" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("OVHcloud: no response");
  const _ovc = data.choices[0].message?.content;
  if (_ovc === null || _ovc === undefined) throw new Error("OVHcloud: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _ovc;
}

async function callDeepSeek(text, prompt, key) {
  console.log("[ParaFree] Trying: deepseek");
  const res = await fetchWithTimeout("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("DeepSeek:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("DeepSeek: no response");
  return data.choices[0].message.content;
}

async function callLLM7(text, prompt, maxTokens = 1500, ms) {
  console.log("[ParaFree] Trying: llm7");
  const res = await fetchWithTimeout("https://api.llm7.io/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral-Nemo-Instruct-2407",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  }, ms);
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("LLM7:" + res.status + " " + errDetail(res, b)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("LLM7: no response");
  const _lc = data.choices[0].message?.content;
  if (_lc === null || _lc === undefined) throw new Error("LLM7: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _lc;
}

async function callScaleway(text, prompt, key, maxTokens = 1500) {
  console.log("[ParaFree] Trying: scaleway");
  const res = await fetchWithTimeout("https://api.scaleway.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama-3.3-70b-instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Scaleway:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("Scaleway: no response");
  const _sc = data.choices[0].message?.content;
  if (_sc === null || _sc === undefined) throw new Error("Scaleway: null content (finish_reason=" + (data.choices[0].finish_reason || "unknown") + ")");
  return _sc;
}

async function callHuggingFace(text, prompt, key) {
  console.log("[ParaFree] Trying: huggingface");
  const res = await fetchWithTimeout("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "meta-llama/Llama-3.2-3B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("HuggingFace:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("HuggingFace: no response");
  return data.choices[0].message.content;
}

async function callChutes(text, prompt, key) {
  console.log("[ParaFree] Trying: chutes");
  const res = await fetchWithTimeout("https://api.chutes.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "deepseek-ai/DeepSeek-V3-0324",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Chutes:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("Chutes: no response");
  return data.choices[0].message.content;
}

async function callHetzner(text, prompt, key, maxTokens = 1500) {
  console.log("[ParaFree] Trying: hetzner");
  const res = await fetchWithTimeout("https://api.hetzner.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) { let b=""; try{b=await res.text();}catch(_){} throw new Error("Hetzner:" + res.status + " " + b.slice(0,200)); }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("Hetzner: no response");
  return data.choices[0].message.content;
}

// ── PROMPTS ──
const PROMPTS = {
  paraphrase:   `You are paraphrasing a document.\n\nSTRICT RULES:\n1. Return EXACTLY the same number of paragraphs as the input\n2. Each output paragraph corresponds to the same input paragraph\n3. Keep paragraph order identical\n4. Use plain text only - NO markdown\n5. No ** bold markers. No ## heading markers. No * bullet markers.\n6. Keep ALL of these UNCHANGED: names, numbers, dates, technical terms, addresses, passport numbers, amounts, university names, company names, country names\n7. Only rephrase the sentence structure and word choice\n8. Do NOT ask questions. Do NOT request more information. Do NOT add commentary.\n9. Do NOT write any preamble, header, or language instruction (e.g. never write "Respond in English", "Here is the paraphrase", "Sure!", etc.). Start your response DIRECTLY with the first paraphrased paragraph.\n10. Write in a natural, human style: deliberately vary sentence lengths (mix short punchy sentences with longer ones), vary how sentences begin, and use specific natural word choices. Do NOT use formulaic AI transition phrases such as "Furthermore," "Moreover," "Additionally," "Notably," "It is worth noting that," "In conclusion," or "It should be noted." Do NOT produce uniformly structured paragraphs that all follow the same pattern.\n\nOutput must have same paragraph count as input. This is critical.\n\nText to paraphrase:`,
  standard:     `You are paraphrasing a document.\n\nSTRICT RULES:\n1. Return EXACTLY the same number of paragraphs as the input\n2. Each output paragraph corresponds to the same input paragraph\n3. Keep paragraph order identical\n4. Use plain text only - NO markdown\n5. No ** bold markers. No ## heading markers. No * bullet markers.\n6. Keep ALL of these UNCHANGED: names, numbers, dates, technical terms, addresses, passport numbers, amounts, university names, company names, country names\n7. Only rephrase the sentence structure and word choice\n8. Do NOT ask questions. Do NOT request more information. Do NOT add commentary.\n9. Do NOT write any preamble, header, or language instruction (e.g. never write "Respond in English", "Here is the paraphrase", "Sure!", etc.). Start your response DIRECTLY with the first paraphrased paragraph.\n10. Write in a natural, human style: deliberately vary sentence lengths (mix short punchy sentences with longer ones), vary how sentences begin, and use specific natural word choices. Do NOT use formulaic AI transition phrases such as "Furthermore," "Moreover," "Additionally," "Notably," "It is worth noting that," "In conclusion," or "It should be noted." Do NOT produce uniformly structured paragraphs that all follow the same pattern.\n\nOutput must have same paragraph count as input. This is critical.\n\nText to paraphrase:`,
  fluency:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE for fluency: improve flow and readability with varied sentence structure and natural phrasing\n8. HUMAN STYLE: mix short and long sentences, avoid formulaic AI phrases like "Furthermore," "Moreover," "Additionally," "It is worth noting," — these sound robotic\n\nNow rewrite the following text to improve fluency and natural flow, following ALL rules above exactly:`,
  creative:     `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. PARAPHRASE creatively with vivid, engaging, specific language — avoid generic AI phrasing\n8. HUMAN STYLE: vary sentence rhythm, use unexpected but accurate word choices, avoid predictable structure\n\nNow paraphrase the following text in a creative and engaging way, following ALL rules above exactly:`,
  formal:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE in formal professional academic tone — precise, authoritative, clear\n8. HUMAN STYLE: even formal writing varies sentence length and structure; avoid robotic repetition of transitions like "Furthermore," "Moreover," "Additionally"\n\nNow rewrite the following text in a formal professional tone, following ALL rules above exactly:`,
  simple:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. SIMPLIFY using simple, everyday words and short clear sentences\n8. HUMAN STYLE: write the way a clear-headed person would explain it to a friend — direct and natural, not robotic\n\nNow simplify the following text using simple words and short sentences, following ALL rules above exactly:`,
  natural:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound completely natural and human-written — eliminate all AI writing signatures\n8. HUMAN STYLE: vary sentence lengths dramatically (some very short, some long), use natural connectors ("but," "so," "though," "still"), avoid "Furthermore," "Moreover," "Additionally," "It is worth noting," never start multiple sentences the same way\n\nNow rewrite the following AI-generated text to sound completely natural and human-written, following ALL rules above exactly:`,
  student:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound like a real university student — genuine, slightly imperfect, engaged\n8. HUMAN STYLE: mix formal sentences with more casual phrasings, use "I think," "this shows," "it seems" naturally, vary sentence lengths, avoid polished AI transitions\n\nNow rewrite the following text to sound like a real university student wrote it, following ALL rules above exactly:`,
  professional: `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound like an experienced human professional — confident, direct, clear\n8. HUMAN STYLE: professionals write concisely and vary structure; avoid filler transitions like "Furthermore," "Moreover," "It should be noted" — get straight to the point\n\nNow rewrite the following text to sound like an experienced professional wrote it, following ALL rules above exactly:`,
  casual:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE in casual conversational tone with contractions and natural expressions\n8. HUMAN STYLE: write like texting a smart friend — use "it's," "that's," "you'd," short punchy sentences mixed with longer ones, natural connectors like "honestly," "basically," "actually"\n\nNow rewrite the following text in a casual conversational tone, following ALL rules above exactly:`,
  summarize:    "Summarize the following text. Your summary MUST be significantly shorter than the input — maximum 30% of the original word count. Use concise bullet points for the key ideas, then one short conclusion sentence. Be brief and to the point. Never exceed 30% of input word count. Return only the summary, nothing else:",
  grammar:      "Check and correct the following text for grammar, spelling, and punctuation errors.\n\nRespond in this exact format:\nCORRECTED TEXT:\n[Write the fully corrected text here]\n\nERRORS FOUND:\n[List each error: Original → Corrected (reason)]\n\nIf no errors found write: No errors found! Your text looks great.\n\nText to check:",
  cv_build:     "You are a professional resume writer. Read the instructions below carefully and follow them exactly. Output ONLY what is requested — no labels, no preamble, no markdown, no extra commentary. Never invent facts: use only the candidate details given (no added years of experience, employers, tools, certifications, frameworks or achievements) and never make up a number — where a figure would help, write a bracketed placeholder such as [X]% or [N]. Never describe the candidate in the third person (no he/she/they/his/her/their):",
  cv_extract:   `Extract all information from the CV text below and return ONLY a valid JSON object. No text before or after. No markdown. No code blocks. Just the raw JSON.

JSON structure to populate (use empty string or empty array when data is not found):
{"name":"","title":"","email":"","phone":"","location":"","linkedin":"","summary":"","skills":"skill1, skill2","certifications":"","volunteer":"","awards":"","experience":[{"title":"","company":"","startDate":"","endDate":"","bullets":["achievement"]}],"education":[{"degree":"","school":"","startYear":"","endYear":""}],"languages":[{"language":"","level":"Native/Fluent/Professional/Intermediate/Basic"}],"projects":[{"name":"","duration":"","url":"","description":""}]}

CV Text:`,
  cover_letter: "You are a professional resume writer. Write a tailored cover letter based on the candidate information and job description below. Keep it to 3-4 paragraphs. Do not use generic openers like 'I am writing to express my interest' or clichés like 'proven track record' or 'passionate about'. Ground every sentence in the candidate's actual background and the specific role. Use only the CV facts given: every company, role, number and achievement must match the CV exactly — never invent a new metric or change an existing one, and where a figure is missing write a bracketed placeholder such as [X]%. Write in the first person throughout. Confident, natural tone. Return only the cover letter text, nothing else:",
  code_assistant: `Your creator and developer is Pritom. If asked who made you — answer: Pritom.

You are ParaFree AI — a smart, helpful AI assistant like Claude and ChatGPT.

PERSONALITY:
- Natural, warm and conversational
- Confident but never arrogant
- Direct — give answers, not descriptions
- Match user's tone (casual = casual, technical = technical)
- Use emojis naturally, not excessively

RESPONSE QUALITY RULES:
1. Always give COMPLETE answers. Never say "I cannot" or "I don't have access" — always try to help.

2. For factual questions: Give clear, accurate, well-structured answers with examples where helpful.

3. For creative requests: Be imaginative and thorough.

4. For technical questions: Explain clearly, use analogies, include working examples/code.

5. For opinions: Give a real perspective, not "it depends".

6. For research/find requests: Provide actual formatted information with real links and details. Never say "let me search" without results.

7. For math/logic: Show step by step working.

8. For language/writing: Match the style requested perfectly.

FORMAT RULES:
- Use **bold** for important points
- Use bullet points for lists
- Use numbered lists for steps
- Use headers for long responses
- Code always in proper code blocks
- Keep paragraphs short (2-3 sentences)
- Add line breaks between sections

WHAT TO NEVER DO:
- Never say "As an AI I cannot..."
- Never refuse reasonable requests
- Never give empty vague answers
- Never ask unnecessary clarifying questions
- Never repeat the question back
- Never say "Great question!"
- Never be robotic or template-like
- Never give half answers

BUILD/CREATE RULES:
- PPT request → return JSON immediately
- Document request → return JSON immediately
- Website/app request → return HTML immediately
- No questions, no outlines, just build it

PPT JSON format:
\`\`\`json
{"type":"presentation","title":"Title","slides":[{"title":"Slide Title","bullets":["Point 1","Point 2","Point 3"]}]}
\`\`\`
Create 6-8 slides minimum. Make content professional and specific.

DOCUMENT JSON format:
\`\`\`json
{"type":"document","title":"Title","content":[{"type":"heading","text":"Section"},{"type":"paragraph","text":"Content here."},{"type":"bullet","text":"Point"}]}
\`\`\`
Create minimum 8-10 content items. Make paragraphs detailed (2-4 sentences each).

WEBSITE/APP: Return ONLY complete HTML in one \`\`\`html code block. Start with <!DOCTYPE html>. Include all CSS and JS. No explanations.

IMPORTANT CONTEXT RULES:
- When user mentions an AI model name (Mistral, GPT, ChatGPT, Claude, Gemini, Groq, Llama, Deepseek): They want to SWITCH to that AI model. Respond: "Switching to [model name] for this conversation." Then continue normally.
- Never interpret AI model names as fonts, topics, tools, or anything else.
- When user says "make it look good" or "improve the design" about a website: Improve the CSS/design of the last HTML you provided. Return new complete improved HTML.
- When user says "preview not fully visible", "can't see it", or similar: Acknowledge and explain they can click the ↗ icon at the top-right of the preview to open it fullscreen.
- When user asks for changes to the last output: Apply the changes and return the full updated version — not just the diff.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PARAFREE CUSTOMER CARE — VERIFIED FACTS ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are also the official support agent for ParaFree (https://parafree.app).
When users ask about ParaFree tools, pricing, features, or support — answer using ONLY the verified facts below. Never invent features.

── WHAT IS PARAFREE? ──
ParaFree is a 100% free-forever AI writing suite. No premium tier, no trial expiry, no paywall, no hidden charge at download. Two main tools:

1. PARAPHRASING TOOL — parafree.app
   - Rewrites text and full documents (DOCX, PDF, PPTX, TXT) using AI
   - No word limit — paste full essays, chapters, books
   - No signup — open page, use instantly
   - 11 modes: Standard, Fluency, Creative, Formal, Simple, Natural (human-like), Student, Professional, Casual, Summarize, Grammar Check
   - 18 languages: English, Spanish, French, Arabic, Chinese, Hindi, Portuguese, German, Japanese, Korean, Bengali, Urdu, Persian/Farsi, Thai, Vietnamese, Tamil, Telugu, Filipino
   - Supports RTL scripts (Arabic, Urdu, Persian) correctly
   - DOCX output: fonts, colors, bold, italics, tables, headings all preserved
   - PPTX output: slide designs, backgrounds, images preserved — only text rewritten
   - PDF: text extracted and paraphrased; complex PDF layouts may lose some formatting — recommend DOCX for best results
   - Output formats: DOCX, PDF, PPTX

2. CV / RESUME BUILDER — parafree.app/cv-builder.html
   - 54 ATS-optimized templates, all free — no locked tier
   - AI writes bullet points, professional summary, cover letter from user input
   - Built-in live job search (Jooble API) — only free CV builder with this feature
   - Downloads: CV as PDF, Cover Letter as PDF + DOCX — always free, no watermark
   - No signup, no payment at download
   - Formats for AU / UK / CA / US CV styles

3. PARAFREE AI — parafree.app/code.html (this tool)
   - Free AI chat, code generation, research, file uploads, live preview
   - No signup, no limit

── PRICING ──
Everything free forever. No subscription, no credit card, no charge at download.

── PRIVACY ──
No user text or files stored on servers. No personal data collected. No signup means no account. Anonymous usage feedback only (optional rating).

── COMMON SUPPORT QUESTIONS ──
Q: Why is my PDF formatting partly lost?
A: PDFs are complex binary formats. For best formatting fidelity, upload as DOCX — fonts, tables, and layout are fully preserved in DOCX output.

Q: Is there a word limit?
A: No limit at all. Paste full essays, research papers, entire chapters — ParaFree processes any length.

Q: Do I need to sign up or create an account?
A: No. No email, no account, no registration. Open the page and use it instantly.

Q: Is it really free? What is the catch?
A: Genuinely free forever. No hidden charge at the download step, no trial that expires, no premium tier.

Q: What languages are supported?
A: 18 languages including Hindi, Bengali, Arabic, Urdu, Tamil, Telugu, Filipino — more than most free tools. QuillBot free does not support these languages.

Q: My PowerPoint slide design changed or disappeared.
A: ParaFree is designed to preserve slide designs. If you see an issue, try re-uploading the original PPTX file.

Q: Can I download my CV for free?
A: Yes. PDF download is always free, no watermark, no payment required.

Q: Does the CV builder help me find jobs?
A: Yes — built-in live job search via Jooble shows real current listings with direct apply links. No other free CV builder includes this.

Q: How many CV templates are there?
A: 54 ATS-friendly templates, all completely free.

Q: What is ATS and why does it matter?
A: ATS (Applicant Tracking System) is software employers use to filter resumes. ParaFree templates are single-column, text-based, and keyword-readable by ATS so your CV is not rejected before a human reads it.

Q: How is ParaFree different from QuillBot?
A: QuillBot free: 125-word limit, requires signup, no document upload, around $20/month paid. ParaFree: no word limit, no signup, free DOCX/PDF/PPTX upload, $0 forever.

Q: How is ParaFree different from Wordtune?
A: Wordtune free: 10 rewrites per day, requires signup. ParaFree: unlimited, no signup.

Q: How is ParaFree CV different from Zety or Resume.io?
A: Zety and Resume.io require a paid subscription to download. ParaFree download is always free.

Q: How is ParaFree CV different from Canva or FlowCV?
A: Canva and FlowCV require account creation. ParaFree requires no signup.

── PARAFREE PAGES ──
Main paraphraser: https://parafree.app
CV builder: https://parafree.app/cv-builder.html
ParaFree AI: https://parafree.app/code.html
FAQ: https://parafree.app/faq.html
Contact: https://parafree.app/contact.html
Privacy: https://parafree.app/privacy.html
About: https://parafree.app/about.html

── SUPPORT ESCALATION ──
If the user's issue is not covered above, direct them to:
- FAQ: parafree.app/faq.html
- Contact form: parafree.app/contact.html
Never make up answers. Never claim features not listed above.`,
};

function getPrompt(mode, language) {
  const base = PROMPTS[mode] || PROMPTS.standard;
  if (!language || language === "english") return base;
  const langName = language.charAt(0).toUpperCase() + language.slice(1);
  // Prepend language rule so it reads as an instruction, not as text to paraphrase
  return 'IMPORTANT: Your entire response must be in ' + langName + ' only. Do not include this instruction in your response.\n\n' + base;
}

// ── CHUNKING HELPERS ──
// Dynamic word-based chunking: target ~600 words/chunk, 1–8 chunks max.
// Formula: chunkCount = clamp(ceil(wordCount / CHUNK_TARGET_WORDS), 1, CHUNK_MAX_COUNT)
// Smaller chunks = fewer tokens per API call = less rate-limit pressure and faster responses.
// 350 words ≈ 500 tokens input → OVHcloud/LLM7 respond in <8s (under FAST_TIMEOUT).
const CHUNK_TARGET_WORDS = 350;
const CHUNK_MAX_COUNT    = 4; // max 4 sequential chunks: 4 × 10s = 40s max, under 60s Vercel limit
const CHUNK_CONCURRENCY  = 1; // sequential: one chunk at a time — only 1 working provider needed per batch
const CHUNK_INTER_DELAY  = 600; // ms pause between chunks — lets rate-limited providers recover

function countWordsApprox(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildChunks(text) {
  const words = countWordsApprox(text);
  // clamp(ceil(words / 400), 1, 12)
  const chunkCount = Math.max(1, Math.min(CHUNK_MAX_COUNT, Math.ceil(words / CHUNK_TARGET_WORDS)));
  if (chunkCount === 1) return [text];

  const targetWords = Math.ceil(words / chunkCount);
  const paras = text.split(/\n\n+/).filter(p => p.trim());

  const chunks = [];
  let cur = [], curWords = 0;
  for (const para of paras) {
    const pw = countWordsApprox(para);
    // Flush when we've hit the per-chunk target and still have quota for more chunks
    if (curWords >= targetWords && chunks.length < chunkCount - 1) {
      chunks.push(cur.join('\n\n'));
      cur = [];
      curWords = 0;
    }
    cur.push(para);
    curWords += pw;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

// Runs `fns` (thunks) in parallel, at most `limit` at a time.
// Preserves result order. Replaces unbounded Promise.all for chunk calls.
async function parallelLimit(fns, limit) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

// Builds the writing provider list with closures bound to the given text.
// Called per-chunk so each chunk gets its own bound calls.
//
// Returns { chain, lastResort }:
//   chain      — every candidate whose key is set; orderChain() later drops DISABLED_PROVIDERS,
//                applies TIER3_ORDER and rotates the Groq / Gemini keys. Each fn takes a timeout (ms).
//   lastResort — tried after chain exhausts; NOT rotated; gets LAST_TIMEOUT. Currently none.
//
// Active chain (see PROVIDER CHAIN): Tier 1 groq×keys/gpt-oss-120b → gemini×keys; Tier 2 groq×keys/
// gpt-oss-20b → groq×keys/third slot → gemini×keys Flash → Gemma; Tier 3 nvidia ultra → nvidia
// lightning → ovhcloud → llm7; Tier 4 cloudflare (safety net)
// Disabled: see DISABLED_PROVIDERS; GLM (ToS unverifiable, data in China) stays commented out.
function buildWritingCandidates(text, prompt, keys) {
  const { DEEPSEEK_KEY, GROQ_KEY, GROQ_KEY_2, GROQ_KEY_3, MISTRAL_KEY, MISTRAL_KEY_2,
          CF_KEY, CF_ACCOUNT, OPENROUTER_KEY, GLM_KEY, SAMBANOVA_KEY, NVIDIA_KEY,
          SCW_KEY, HF_KEY, CHUTES_KEY, HETZNER_KEY,
          EXTRA1_KEY, EXTRA2_KEY, EXTRA3_KEY, EXTRA4_KEY, EXTRA5_KEY, EXTRA6_KEY } = keys;
  const cfOk = validKey(CF_KEY) && validKey(CF_ACCOUNT);

  // ── Active chain (rotation pool) ──
  const chain = [];
  const add = (name, fn, keyOk = true) => { if (keyOk) chain.push({ name, fn }); };

  // Dynamic max_tokens: cap output at ~1.5× input word count in tokens (1 word ≈ 1.5 tokens),
  // floored at 600 and capped at 1500. Prevents over-provisioning on short chunks and
  // reduces per-request token consumption on providers with daily quota limits.
  const chunkWords = countWordsApprox(text);
  const mt = Math.min(1500, Math.max(600, Math.ceil(chunkWords * 1.5)));

  // Working chain (final order from orderChain: slot ranks, TIER3_ORDER for Tier 3)
  // One entry per resolved key+model slot; `group` lets orderChain rotate each Groq / Gemini slot across the keys.
  chain.push(...slotEntries(keys, {
    groq:       (key) => (m, ms) => callGroq(text, prompt, key, mt, ms, m),
    gemini:     (key) => (m, ms) => callGemini(text, prompt, key, mt, ms, m),
    nvidia:     (m, ms) => callNvidiaModel(text, prompt, NVIDIA_KEY, mt, ms, m),
    cloudflare: (m, ms) => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT, mt, ms, m),
  }));
  add("ovhcloud",   (ms) => callOVHcloud(text, prompt, mt, ms),                       true);
  add("llm7",       (ms) => callLLM7(text, prompt, mt, ms),                           true);

  // ── DISABLED (listed in DISABLED_PROVIDERS — filtered out by orderChain) ──
  // mistral / mistral-2 — free plan requires paid upgrade to activate keys (card required)
  add("mistral",    () => callMistral(text, prompt, MISTRAL_KEY, mt),             validKey(MISTRAL_KEY));
  add("mistral-2",  () => callMistral(text, prompt, MISTRAL_KEY_2, mt),           validKey(MISTRAL_KEY_2));
  add("openrouter", () => callOpenRouter(text, prompt, OPENROUTER_KEY, mt),       validKey(OPENROUTER_KEY));
  add("scaleway",   () => callScaleway(text, prompt, SCW_KEY, mt),                validKey(SCW_KEY));
  add("extra1",     () => callExtra(text, prompt, EXTRA1_KEY, "Extra1", mt),      validKey(EXTRA1_KEY));
  add("extra2",     () => callExtra(text, prompt, EXTRA2_KEY, "Extra2", mt),      validKey(EXTRA2_KEY));
  add("extra3",     () => callExtra(text, prompt, EXTRA3_KEY, "Extra3", mt),      validKey(EXTRA3_KEY));
  add("extra4",     () => callExtra(text, prompt, EXTRA4_KEY, "Extra4", mt),      validKey(EXTRA4_KEY));
  add("extra5",     () => callExtra(text, prompt, EXTRA5_KEY, "Extra5", mt),      validKey(EXTRA5_KEY));
  add("extra6",     () => callExtra(text, prompt, EXTRA6_KEY, "Extra6", mt),      validKey(EXTRA6_KEY));
  add("deepseek",   () => callDeepSeek(text, prompt, DEEPSEEK_KEY),               validKey(DEEPSEEK_KEY));    // billing-walled (402)
  add("sambanova",  () => callSambaNova(text, prompt, SAMBANOVA_KEY),             validKey(SAMBANOVA_KEY));   // billing-walled (402)
  add("huggingface",() => callHuggingFace(text, prompt, HF_KEY),                  validKey(HF_KEY));          // no working free key
  add("chutes",     () => callChutes(text, prompt, CHUTES_KEY),                   validKey(CHUTES_KEY));      // 401
  // add("glm",       () => callGLM(text, prompt, GLM_KEY, mt),         validKey(GLM_KEY));         // ⚠️ ToS unverifiable (Chinese-only, login required); data in China

  // ── Last resort ──
  const lastResort = null;

  return { chain, lastResort };
}

// Tries every writing provider for one chunk, in chain order with the Groq / Gemini keys
// rotated by startOffset. Providers in cooldown are skipped. Time: the chunk gets a fair share of
// what is left of the request budget (budget ÷ chunks still to do), so one slow model can't starve
// the chunks after it; Tiers 1–3 also leave SAFETY_NET_MS of that share for the Cloudflare safety
// net, which may itself run until the deadline minus SAFETY_NET_MS per later chunk. Every attempt
// is capped by its provider timeout as before. Returns the result string, or null if all failed.
async function paraphraseChunk(chunkText, prompt, envKeys, startOffset, seq = 0, deadline = Date.now() + REQUEST_BUDGET, chunksLeft = 1) {
  const { chain, lastResort } = buildWritingCandidates(chunkText, prompt, envKeys);
  // startOffset comes from runChain's sequential counter (baseOffset + chunkSeq), so
  // consecutive chunks start on a DIFFERENT Groq key — even load across the keys.
  const rotated = orderChain(chain, startOffset);
  const ordered = lastResort ? [...rotated, lastResort] : rotated;
  if (ordered.length === 0) {
    console.error('[ParaFree] ❌ paraphraseChunk: 0 providers — no valid API keys configured');
    return null;
  }

  const chunkStart = Date.now();
  const chunkDeadline = chunkStart + (deadline - chunkStart) / Math.max(1, chunksLeft);
  const laterReserve = Math.max(0, chunksLeft - 1) * SAFETY_NET_MS;
  console.log(`[ParaFree] chunk seq=${seq}: ${chunkText.length} chars, ${Math.round((chunkDeadline - chunkStart) / 1000)}s share, chain: ${ordered.map(c => c.name).join(' → ')}`);
  const forced = soonestIfAllCooling(ordered);
  const hasNet = ordered.some(c => tierOf(c) === 4 && (c === forced || !isCoolingDown(c.name)));
  for (const c of ordered) {
    if (c !== forced && isCoolingDown(c.name)) {
      console.log(`[ParaFree] ⏭ chunk seq=${seq} ${c.name} [cooldown] — skipped`);
      continue;
    }
    const isNet = tierOf(c) === 4;
    const until = isNet ? deadline - laterReserve : chunkDeadline - (hasNet ? SAFETY_NET_MS : 0);
    const isLast = lastResort !== null && c.name === lastResort.name;
    const expectedTimeout = isLast ? Math.min(LAST_TIMEOUT, until - Date.now()) : providerTimeout(c.name, until);
    if (expectedTimeout < MIN_ATTEMPT_MS) {
      if (!isNet && hasNet) {
        console.log(`[ParaFree] ⏭ chunk seq=${seq} ${c.name} [no time left in this chunk's share] — skipped`);
        continue;
      }
      console.warn(`[ParaFree] ⏱ chunk seq=${seq} request budget exhausted before ${c.name}`);
      break;
    }
    const t0 = Date.now();
    try {
      const result = await c.fn(expectedTimeout);
      const ms = Date.now() - t0;
      if (result && result.trim().length > 5) {
        console.log(`[ParaFree] ✅ chunk seq=${seq} handled by ${c.name} in ${ms}ms (${result.trim().length} chars out)`);
        discovery.noteSuccess(c.name, c.pk, c.patternIndex, c.model);
        usage.record(redis, 'chunk', c.name);
        return result.trim();
      }
      console.warn(`[ParaFree] ⚠️ chunk seq=${seq} ${c.name} empty/short (${result?.length || 0} chars, ${ms}ms) — next`);
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e.message || 'unknown';
      const isAbort = msg.includes('abort') || msg.includes('AbortError') || ms >= expectedTimeout - 100;
      const quota = isQuotaError(msg);
      const tag = quota ? '429-rate-limit' : msg.includes(':401') ? '401-auth' : msg.includes(':403') ? '403-forbidden' : msg.includes(':404') ? '404-model-not-found' : msg.includes(':503') ? '503-unavailable' : isAbort ? `TIMEOUT-${expectedTimeout}ms` : 'error';
      console.log(`[ParaFree] ❌ chunk seq=${seq} ${c.name} [${tag}] in ${ms}ms — ${msg.slice(0, 200)}`);
      if (quota) startCooldown(c.name, msg);
      else if (isAbort && !isNet && expectedTimeout >= TIMEOUT_COOLDOWN_MIN_MS) startCooldown(c.name, msg, TIMEOUT_COOLDOWN, 'timed out');
    }
  }
  console.error(`[ParaFree] ❌ chunk seq=${seq} exhausted all ${ordered.length} providers in ${Date.now() - chunkStart}ms`);
  usage.record(redis, 'chunk', null);
  return null;
}

// ── MAIN API CHAIN ──
// Every tool (writing chunks, AI chat/code, CV extract) uses the same chain (see PROVIDER CHAIN):
//   Tier 1 groq/gpt-oss-120b → gemini Flash-Lite → Tier 2 groq/gpt-oss-20b → groq third slot →
//   gemini Flash → Gemma → Tier 3 nvidia ultra → nvidia lightning → ovhcloud → llm7 →
//   Tier 4 cloudflare (one entry per key+model)
// The Groq / Gemini keys rotate per chunk (writing) or per request (chat/CV). Disabled providers:
// DISABLED_PROVIDERS. Rate-limited providers sit out their cooldown (PROVIDER COOLDOWN).
// opts.accept(result) (Study Pack): a result it rejects counts as that provider failing; 'stop' ends the chain.
async function runChain(text, prompt, type, opts = {}) {
  const deadline       = Date.now() + REQUEST_BUDGET;
  await discovery.ensure();   // model lists: never waits more than ~1 s (cold instance only)
  const GROQ_KEY       = process.env.GROQ_KEY;
  const GROQ_KEY_2     = process.env.GROQ_KEY_2;
  const GROQ_KEY_3     = process.env.GROQ_KEY_3;
  const GROQ_KEY_4     = process.env.GROQ_KEY_4;     // optional — used only when set
  const GEMINI_KEY     = process.env.GEMINI_KEY;
  const GEMINI_KEY_2   = process.env.GEMINI_KEY_2;   // optional — used only when set
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
  const GLM_KEY        = process.env.GLM_KEY;
  const MISTRAL_KEY    = process.env.MISTRAL_KEY;
  const MISTRAL_KEY_2  = process.env.MISTRAL_KEY_2;
  const CF_KEY         = process.env.CF_KEY;
  const CF_ACCOUNT     = process.env.CF_ACCOUNT;
  const SAMBANOVA_KEY  = process.env.SAMBANOVA_KEY;
  const NVIDIA_KEY     = process.env.NVIDIA_KEY;
  const DEEPSEEK_KEY   = process.env.DEEPSEEK_KEY;
  const SCW_KEY        = process.env.SCW_KEY;
  const HF_KEY         = process.env.HF_KEY;
  const CHUTES_KEY     = process.env.CHUTES_KEY;
  const HETZNER_KEY    = process.env.HETZNER_KEY;
  const EXTRA1_KEY     = process.env.EXTRA1_KEY;
  const EXTRA2_KEY     = process.env.EXTRA2_KEY;
  const EXTRA3_KEY     = process.env.EXTRA3_KEY;
  const EXTRA4_KEY     = process.env.EXTRA4_KEY;
  const EXTRA5_KEY     = process.env.EXTRA5_KEY;
  const EXTRA6_KEY     = process.env.EXTRA6_KEY;

  const isAIChat    = type === "code_assistant" || type === "code_project";
  // CV writing (summary, bullets, LinkedIn, cover letter, CV review) is one instruction + the CV facts:
  // it must reach the model in ONE request — chunking would split the facts from the instruction.
  // Study Pack: one instruction + the (TextRank-filtered) material → one JSON answer, never chunked
  const isCVExtract = type === "cv_extract" || type === "cv_build" || type === "cover_letter" || type === "studypack";
  const outTokens = type === "studypack" ? 4096 : undefined;   // notes + flashcards + quiz in one answer
  const cfOk = validKey(CF_KEY) && validKey(CF_ACCOUNT);

  // ── WRITING PATH: parallel chunks ──
  // Chunks fire simultaneously via Promise.all — total time ≈ ONE chunk's time (~3s),
  // well inside Vercel Hobby's 10s limit. Each chunk tries providers independently
  // starting at a different offset so parallel calls spread across providers.
  if (!isAIChat && !isCVExtract) {
    const envKeys = {
      DEEPSEEK_KEY, GEMINI_KEY, GEMINI_KEY_2, GROQ_KEY, GROQ_KEY_2, GROQ_KEY_3, GROQ_KEY_4, MISTRAL_KEY, MISTRAL_KEY_2,
      CF_KEY, CF_ACCOUNT, OPENROUTER_KEY, GLM_KEY, SAMBANOVA_KEY, NVIDIA_KEY,
      SCW_KEY, HF_KEY, CHUTES_KEY, HETZNER_KEY,
      EXTRA1_KEY, EXTRA2_KEY, EXTRA3_KEY, EXTRA4_KEY, EXTRA5_KEY, EXTRA6_KEY
    };
    const { chain: sampleAll, lastResort: sampleLast } = buildWritingCandidates("x", "x", envKeys);
    const sampleChain = orderChain(sampleAll, 0);
    const sampleTotal = sampleChain.length + (sampleLast ? 1 : 0);
    if (sampleTotal === 0) {
      console.error("[ParaFree] ❌ No valid API keys — check Vercel environment variables");
      return { success: false, error: "no_keys", apiStatuses: {} };
    }
    const chunks = buildChunks(text);
    const baseOffset = requestCounter;
    requestCounter = (requestCounter + Math.max(chunks.length, 1)) % 100000;
    const inputWords = countWordsApprox(text);
    const isPPTX = text.includes('[SLIDE') && text.includes('[/SLIDE');

    // Assign each chunk an explicit sequence number BEFORE dispatch.
    // Chunks may complete in any order during parallel processing — the seq
    // number is the only authoritative record of original position.
    const indexedChunks = chunks.map((text, seq) => ({ seq, text }));
    console.log(`[ParaFree] writing: ${indexedChunks.length} chunk(s) × ${sampleTotal} providers (chain=${sampleChain.length} + last-resort=${sampleLast ? 1 : 0}) — sequential, input=${inputWords} words, isPPTX=${isPPTX}, seqs=[${indexedChunks.map(c => c.seq).join(',')}]`);
    const t0 = Date.now();

    // Each thunk returns {seq, result} so the sequence number travels with the result.
    // A brief inter-chunk pause lets rate-limited providers (Groq, Gemini) recover quota.
    const rawResults = await parallelLimit(
      indexedChunks.map(({ seq, text: chunkText }) => async () => {
        if (seq > 0) await new Promise(r => setTimeout(r, CHUNK_INTER_DELAY));
        const result = await paraphraseChunk(chunkText, prompt, envKeys, baseOffset + seq, seq, deadline, indexedChunks.length - seq);
        return { seq, result };
      }),
      CHUNK_CONCURRENCY
    );
    const elapsed = Date.now() - t0;

    // Sort by original sequence number. parallelLimit already fills results by position,
    // but the explicit sort makes the ordering guarantee visible and self-verifying.
    rawResults.sort((a, b) => a.seq - b.seq);

    // Verify sequence integrity and apply graceful fallback for any failed chunk.
    // Sequence gaps are still fatal (structural error). Individual chunk failures
    // fall back to the original text for that chunk so the document still completes.
    for (let i = 0; i < indexedChunks.length; i++) {
      if (!rawResults[i] || rawResults[i].seq !== i) {
        console.error(`[ParaFree] ❌ Sequence gap at index ${i} — expected seq=${i}, got seq=${rawResults[i] ? rawResults[i].seq : 'undefined'}`);
        return { success: false, error: "high_demand", apiStatuses: {} };
      }
      if (rawResults[i].result === null) {
        console.warn(`[ParaFree] ⚠️ Chunk seq=${i} (${i + 1}/${indexedChunks.length}) failed all providers — keeping original text for this chunk`);
        rawResults[i].result = indexedChunks[i].text; // graceful: partial doc beats total failure
      }
    }

    // Assemble strictly in sequence order — guaranteed by the sort + verification above.
    const assembled = rawResults.map(r => r.result).join('\n\n');
    console.log(`[ParaFree] ✅ All ${indexedChunks.length} chunk(s) complete in ${elapsed}ms — assembled ${assembled.length} chars, seqs verified [${rawResults.map(r => r.seq).join(',')}]`);
    return { success: true, result: assembled, usedApi: 'parallel-chunks', apiStatuses: {} };
  }

  // ── AI CHAT / CV EXTRACT PATH: sequential with single retry ──
  // Short texts only — no chunking needed. One retry with 2s wait stays inside 10s limit.
  let candidates = [];
  const addC = (name, fn, keyOk = true) => { if (keyOk) candidates.push({ name, fn }); };

  // AI chat/code and CV extract share one chain (Cerebras removed — requires payment).
  // Same default max_tokens per caller as before; order comes from orderChain (see PROVIDER CHAIN).
  // One entry per resolved key+model slot (rotated per request by orderChain); Groq calls here
  // are unchanged otherwise — callGroqModel never sends reasoning_effort.
  candidates.push(...slotEntries({ GROQ_KEY, GROQ_KEY_2, GROQ_KEY_3, GROQ_KEY_4, GEMINI_KEY, GEMINI_KEY_2, NVIDIA_KEY, CF_KEY, CF_ACCOUNT }, {
    groq:       (key) => (m, ms) => callGroqModel(text, prompt, key, m, ms),
    gemini:     (key) => (m, ms) => callGemini(text, prompt, key, outTokens, ms, m),
    nvidia:     (m, ms) => callNvidiaModel(text, prompt, NVIDIA_KEY, outTokens, ms, m),
    cloudflare: (m, ms) => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT, outTokens, ms, m),
  }));
  addC("ovhcloud",   (ms) => callOVHcloud(text, prompt, outTokens, ms),                    true);
  addC("llm7",       (ms) => callLLM7(text, prompt, outTokens, ms),                        true);
  if (isAIChat) {
    // ── DISABLED (listed in DISABLED_PROVIDERS — filtered out by orderChain) ──
    addC("deepseek-coder", () => callOpenRouterModel(text, prompt, OPENROUTER_KEY, "deepseek/deepseek-coder-v2-instruct:free"), validKey(OPENROUTER_KEY));
    addC("qwen-coder",     () => callOpenRouterModel(text, prompt, OPENROUTER_KEY, "qwen/qwen-2.5-coder-32b-instruct:free"),    validKey(OPENROUTER_KEY));
    addC("extra1",         () => callExtra(text, prompt, EXTRA1_KEY, "Extra1"),                                            validKey(EXTRA1_KEY));
    addC("extra2",         () => callExtra(text, prompt, EXTRA2_KEY, "Extra2"),                                            validKey(EXTRA2_KEY));
    addC("extra3",         () => callExtra(text, prompt, EXTRA3_KEY, "Extra3"),                                            validKey(EXTRA3_KEY));
    addC("extra4",         () => callExtra(text, prompt, EXTRA4_KEY, "Extra4"),                                            validKey(EXTRA4_KEY));
    addC("extra5",         () => callExtra(text, prompt, EXTRA5_KEY, "Extra5"),                                            validKey(EXTRA5_KEY));
    addC("extra6",         () => callExtra(text, prompt, EXTRA6_KEY, "Extra6"),                                            validKey(EXTRA6_KEY));
  }

  const chatOffset = requestCounter;
  requestCounter = (requestCounter + 1) % 100000;
  candidates = orderChain(candidates, chatOffset);
  // Study Pack: Gemini first (it also does the audio jobs), then the rest of the chain in its usual order
  if (type === "studypack") candidates = [...candidates.filter(c => c.name.startsWith("gemini")), ...candidates.filter(c => !c.name.startsWith("gemini"))];
  console.log(`[ParaFree] Chain (${isCVExtract ? 'CV' : 'AI'}): ${candidates.map(c => c.name).join(' → ') || 'EMPTY'}`);

  if (candidates.length === 0) {
    console.error("[ParaFree] ❌ No valid API keys found — check Vercel environment variables");
    return { success: false, error: "no_keys", apiStatuses: {} };
  }

  const MAX_RETRIES = 1;
  let lastApiStatuses = {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const apiStatuses = {};
    candidates.forEach(c => { apiStatuses[c.name] = "skipped"; });
    const forced = soonestIfAllCooling(candidates);
    // Tiers 1–3 leave SAFETY_NET_MS of the budget for the Cloudflare safety net (Tier 4).
    const hasNet = candidates.some(c => tierOf(c) === 4 && (c === forced || !isCoolingDown(c.name)));
    for (const c of candidates) {
      if (c !== forced && isCoolingDown(c.name)) {
        apiStatuses[c.name] = "limit";
        console.log(`[ParaFree] ⏭ ${c.name} [cooldown] — skipped`);
        continue;
      }
      const isNet = tierOf(c) === 4;
      const ms = providerTimeout(c.name, isNet || !hasNet ? deadline : deadline - SAFETY_NET_MS);
      if (ms < MIN_ATTEMPT_MS) {
        if (!isNet && hasNet) {
          console.log(`[ParaFree] ⏭ ${c.name} [no time left before the safety net] — skipped`);
          continue;
        }
        console.warn(`[ParaFree] ⏱ request budget exhausted before ${c.name}`);
        break;
      }
      apiStatuses[c.name] = "trying";
      const t0 = Date.now();
      try {
        const result = await c.fn(ms);
        const verdict = result && result.trim().length > 5 && opts.accept ? opts.accept(result) : true;
        if (verdict !== true && result && result.trim().length > 5) {
          console.warn(`[ParaFree] ⚠️ ${c.name} answer rejected (invalid study pack JSON)${verdict === 'stop' ? ' — giving up' : ' — next'}`);
          apiStatuses[c.name] = "invalid";
          if (verdict === 'stop') return { success: false, error: "invalid_output", apiStatuses };
          continue;
        }
        if (result && result.trim().length > 5) {
          console.log(`[ParaFree] ✅ ${isCVExtract ? 'CV' : 'AI'} request handled by ${c.name}${attempt > 0 ? ' (retry)' : ''}`);
          discovery.noteSuccess(c.name, c.pk, c.patternIndex, c.model);
          usage.record(redis, 'chat', c.name);
          apiStatuses[c.name] = "success";
          return { success: true, result: result.trim(), usedApi: c.name, apiStatuses };
        }
        console.warn(`[ParaFree] ⚠️ ${c.name} empty/short — next`);
        apiStatuses[c.name] = "failed";
      } catch (e) {
        const msg = e.message || "";
        const quota = isQuotaError(msg);
        apiStatuses[c.name] = quota ? "limit" : (msg.includes(":401") || msg.includes(":403")) ? "expired" : msg.includes(":404") ? "model_not_found" : "failed";
        console.log(`[ParaFree] ❌ ${c.name} — ${msg}`);
        const isAbort = /abort/i.test(msg) || Date.now() - t0 >= ms - 100;
        if (quota) startCooldown(c.name, msg);
        else if (isAbort && !isNet && ms >= TIMEOUT_COOLDOWN_MIN_MS) startCooldown(c.name, msg, TIMEOUT_COOLDOWN, 'timed out');
      }
    }
    lastApiStatuses = { ...apiStatuses };
    if (attempt < MAX_RETRIES) {
      console.log(`[ParaFree] All providers failed — waiting 2s before retry`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.error("[ParaFree] ❌ ALL providers exhausted:", JSON.stringify(lastApiStatuses));
  return { success: false, error: "high_demand", apiStatuses: lastApiStatuses };
}

// ── NVIDIA MODELS DIAGNOSTIC HANDLER ──
async function handleNvidiaModels(body) {
  const adminPw = getAdminPassword();
  if (!adminPw || body.adminPassword !== adminPw) return { error: "Unauthorized", status: 401 };

  const key = process.env.NVIDIA_KEY;
  const keyPrefix = key ? key.slice(0, 12) + "..." : null;

  if (!key || key.length <= 10) return { keyPrefix, error: "NVIDIA_KEY not set or too short — check Vercel env vars" };
  if (!key.startsWith("nvapi-")) return { keyPrefix, warning: "Key does not start with 'nvapi-' — may be wrong key format" };

  try {
    const res = await fetchWithTimeout("https://integrate.api.nvidia.com/v1/models", {
      method: "GET",
      headers: { "Authorization": "Bearer " + key }
    }, 10000);

    const httpStatus = res.status;
    let rawText = "";
    try { rawText = await res.text(); } catch(_) {}

    if (!res.ok) {
      return { keyPrefix, httpStatus, error: "Non-OK response", raw: rawText.slice(0, 500) };
    }

    let data;
    try { data = JSON.parse(rawText); } catch(_) {
      return { keyPrefix, httpStatus, error: "Non-JSON response", raw: rawText.slice(0, 500) };
    }

    const models = (data.data || []).map(m => m.id).filter(Boolean).sort();
    return { keyPrefix, httpStatus, modelCount: models.length, models };
  } catch (e) {
    return { keyPrefix, error: e.message };
  }
}

// ── TEST KEYS HANDLER ──
async function handleTestKeys(body) {
  const adminPw = getAdminPassword();
  if (!adminPw || body.adminPassword !== adminPw) {
    return { error: "Unauthorized", status: 401 };
  }

  const testText = "say hi";
  const testPrompt = "Say hi and nothing else:";

  const cfAccount = process.env.CF_ACCOUNT;

  // Health check refreshes the model lists (Upstash cache respected; body.refreshModels forces live).
  await discovery.refresh({ force: !!body.refreshModels });

  // One row per preference slot: pattern → resolved model (and HOW it was picked: match,
  // previous, last-good, default or auto) → status. Names match the chain entries
  // (e.g. "groq-2/openai/gpt-oss-20b"); a slot that resolved to nothing gets its own row.
  const slotRows = (pk, provider, key, call, nameFor, extra = {}) => {
    let pos = -1;
    return discovery.slots(pk).map((s, patternIndex) => {
      if (!s.model) return { name: `${pk}/(no match) ${s.pattern}`, pattern: s.pattern, model: null, tier: null, key, noMatch: true };
      pos++;
      const position = pos;
      return { name: nameFor(s.model, position), pattern: s.pattern, model: s.model, pickedBy: s.from, tier: discovery.tierLabel(provider, position),
               provider, pk, patternIndex, key, fn: (k) => call(k, s.model), ...extra };
    });
  };

  // groq-4 / gemini-2 rows appear only when GROQ_KEY_4 / GEMINI_KEY_2 are set.
  const keyRows = (pairs) => pairs.filter(([n, key]) => !/-[24]$/.test(n) || validKey(key));
  const tests = [
    ...keyRows([["groq", process.env.GROQ_KEY], ["groq-2", process.env.GROQ_KEY_2], ["groq-3", process.env.GROQ_KEY_3], ["groq-4", process.env.GROQ_KEY_4]]).flatMap(([n, key]) =>
      slotRows(n, "groq", key, (k, m) => callGroq(testText, testPrompt, k, undefined, undefined, m), (m) => n + "/" + m)),
    ...keyRows([["gemini", process.env.GEMINI_KEY], ["gemini-2", process.env.GEMINI_KEY_2]]).flatMap(([n, key]) =>
      slotRows(n, "gemini", key, (k, m) => callGemini(testText, testPrompt, k, undefined, undefined, m), (m) => n + "/" + m)),
    ...slotRows("cloudflare", "cloudflare", process.env.CF_KEY, (k, m) => callCloudflare(testText, testPrompt, k, cfAccount, undefined, undefined, m),
      (m, pos) => pos === 0 ? "cloudflare" : "cloudflare/" + m, { account: cfAccount }),
    ...slotRows("nvidia", "nvidia", process.env.NVIDIA_KEY, (k, m) => callNvidiaModel(testText, testPrompt, k, undefined, undefined, m), (m) => "nvidia/" + m),
    { name: "sambanova",  model: "Meta-Llama-3.3-70B-Instruct",       key: process.env.SAMBANOVA_KEY,  fn: (k) => callSambaNova(testText, testPrompt, k) },
    { name: "mistral",    model: "mistral-small-latest",              key: process.env.MISTRAL_KEY,    fn: (k) => callMistral(testText, testPrompt, k) },
    { name: "mistral-2",  model: "mistral-small-latest",              key: process.env.MISTRAL_KEY_2,  fn: async (k) => { await new Promise(r => setTimeout(r, 3500)); return callMistral(testText, testPrompt, k); } },
    { name: "ovhcloud",   model: "Meta-Llama-3_3-70B-Instruct",      key: "no-key-needed",            fn: () => callOVHcloud(testText, testPrompt) },
    { name: "deepseek",   model: "deepseek-chat",                     key: process.env.DEEPSEEK_KEY,   fn: (k) => callDeepSeek(testText, testPrompt, k) },
    { name: "openrouter", model: "qwen/qwen3.8-27b:free",               key: process.env.OPENROUTER_KEY, fn: (k) => callOpenRouter(testText, testPrompt, k) },
    { name: "llm7",       model: "mistral-Nemo-Instruct-2407",    key: "no-key-needed",            fn: () => callLLM7(testText, testPrompt) },
    { name: "scaleway",   model: "llama-3.3-70b-instruct",        key: process.env.SCW_KEY,        fn: (k) => callScaleway(testText, testPrompt, k) },
    // hetzner removed (requires billing card — card-free policy)
    // kept for diagnostics (not in active chain):
    { name: "huggingface",model: "Llama-3.2-3B-Instruct",         key: process.env.HF_KEY,         fn: (k) => callHuggingFace(testText, testPrompt, k) },
    { name: "chutes",     model: "DeepSeek-V3-0324",              key: process.env.CHUTES_KEY,     fn: (k) => callChutes(testText, testPrompt, k) },
  ];

  const results = {};

  await Promise.all(tests.map(async (t) => {
    if (t.noMatch) {
      results[t.name] = { status: "⚠️ no match", error: "No available text/chat model matches this preference pattern" };
      return;
    }
    if (DISABLED_PROVIDERS.has(t.name)) {
      results[t.name] = { status: "⏸ disabled", error: "In DISABLED_PROVIDERS — not called" };
      return;
    }
    if (!t.key || (t.key !== "no-key-needed" && t.key.length <= 10)) {
      results[t.name] = { status: "⚠️ no key", error: "Key not set in Vercel environment variables" };
      return;
    }
    if (t.account !== undefined && (!t.account || t.account.length <= 5)) {
      results[t.name] = { status: "⚠️ no key", error: "CF_ACCOUNT not set — add it to Vercel environment variables" };
      return;
    }
    try {
      const response = await t.fn(t.key);
      if (!response || response.trim().length === 0) {
        results[t.name] = { status: "❌ failed", error: "Empty response" };
      } else {
        results[t.name] = { status: "✅ working", model: t.model, response: response.trim().slice(0, 60) };
        discovery.noteSuccess(t.name, t.pk, t.patternIndex, t.model);   // also clears any skip
      }
    } catch (e) {
      const msg = e.message || "";
      const quota = isQuotaError(msg);
      results[t.name] = {
        status: quota ? (quotaCooldown(msg) === DAILY_COOLDOWN ? "⏳ daily limit" : "⏳ rate-limited") : "❌ failed",
        model: t.model, error: msg
      };
      // Only failures that won't fix themselves go on the shared skip list: auth (401/403) and
      // retired models (404/410/decommissioned/retired/deprecated — also marked dead for 24 h).
      // Timeouts and 5xx are NOT skipped: slow providers (ovhcloud, llm7, nvidia) often time out
      // in this quick check but work in real requests.
      const dead = discovery.isDeadModelError(msg);
      if (!quota && (dead || /:(401|403)\b/.test(msg))) {
        if (dead && t.provider && t.model) {
          await discovery.markDead(t.provider, t.model, msg);
          results[t.name].markedDead = true;
        }
        discovery.skip(t.name, msg);
        results[t.name].skippedForMinutes = Math.round((discovery.skipUntil(t.name) - Date.now()) / 60000);
      }
    }
  }));

  // Active in-memory cooldowns on this warm instance, per key+model
  for (const name of Object.keys(results)) {
    const until = providerCooldowns.get(name);
    if (until && until > Date.now()) results[name].cooldownSecondsLeft = Math.ceil((until - Date.now()) / 1000);
  }
  // Slot rows: show the preference pattern, the resolved model and the tier next to the status.
  for (const t of tests) {
    if (t.pattern !== undefined && results[t.name]) {
      Object.assign(results[t.name], { tier: t.tier, pattern: t.pattern, model: t.model, pickedBy: t.pickedBy || null,
                                       autoPicked: t.pickedBy === "auto" });
    }
  }

  // Which provider served how many writing chunks / chat requests per UTC day (counts only).
  let usageDays;
  try { usageDays = await usage.getUsage(redis, body.usageDays || 7); } catch (e) { usageDays = { ok: false, error: e.message }; }

  return {
    success: true, results,
    discovery: discovery.status(),   // when each model list was last refreshed, its source, dead + blocked models, preference lists
    chainOrder: { tier3: TIER3_ORDER, safetyNet: "cloudflare (Tier 4)" },
    usage: usageDays,
    note: "CF_ACCOUNT " + (cfAccount ? "is set" : "NOT SET — add to Vercel env vars")
  };
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  // KEYS FOUND — absolute first line so this appears in every Vercel function invocation
  // Only whether each provider has a key — never any part of the key itself.
  const hasKey = (name) => !!validKey(process.env[name]);
  console.log("KEYS FOUND:", {
    groq:       hasKey("GROQ_KEY"),
    groq2:      hasKey("GROQ_KEY_2"),
    groq3:      hasKey("GROQ_KEY_3"),
    groq4:      hasKey("GROQ_KEY_4"),
    gemini:     hasKey("GEMINI_KEY"),
    gemini2:    hasKey("GEMINI_KEY_2"),
    cloudflare: hasKey("CF_KEY") && hasKey("CF_ACCOUNT"),
    nvidia:     hasKey("NVIDIA_KEY"),
    sambanova:  hasKey("SAMBANOVA_KEY"),
    mistral:    hasKey("MISTRAL_KEY"),
    mistral2:   hasKey("MISTRAL_KEY_2"),
    deepseek:   hasKey("DEEPSEEK_KEY"),
    openrouter: hasKey("OPENROUTER_KEY"),
  });

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Public rating summary — average + count only (no comments). GET so the CDN caches it for 1 h.
  // Only a real summary (ok:true) is cached; failures (no totals yet, Upstash error) use no-store.
  if (req.method === "GET" && req.query && req.query.type === "ratingSummary") {
    let summary;
    try {
      summary = await ratings.getSummary(redis);
    } catch (e) {
      summary = { ok: false };
    }
    res.setHeader("Cache-Control", summary && summary.ok === true
      ? "public, s-maxage=3600, stale-while-revalidate=86400"
      : "no-store");
    return res.status(200).json(summary);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Get IP
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();

  try {
    const body = req.body;

    // Test keys endpoint (exempt from rate limiting)
    if (body && body.type === "testKeys") {
      const result = await handleTestKeys(body);
      if (result.status) return res.status(result.status).json(result);
      return res.status(200).json(result);
    }

    // NVIDIA models diagnostic (exempt from rate limiting)
    if (body && body.type === "nvidiaModels") {
      const result = await handleNvidiaModels(body);
      if (result.status) return res.status(result.status).json(result);
      return res.status(200).json(result);
    }

    // Job search endpoint (no text required — exempt from AI rate limiting)
    if (body && body.type === "jobSearch") {
      const result = await handleJobSearch(body);
      return res.status(200).json(result);
    }

    // Submit anonymous feedback — no IP, no user data stored
    if (body && body.type === "submitFeedback") {
      try {
        const rating = parseInt(body.rating, 10);
        if (!rating || rating < 1 || rating > 5) {
          return res.status(400).json({ error: "Invalid rating" });
        }
        // Only ratings sent from parafree.app count toward the public total (not previews/tests)
        let origin = req.headers.origin || "";
        if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch (e) {} }
        await ratings.recordRating(redis, {
          rating, comment: body.comment, tool: body.tool, test: body.test === true, origin
        });
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(200).json({ ok: true }); // fail silently
      }
    }

    // Rebuild the public rating totals from the stored list — PIN-gated, dry run by default
    if (body && body.type === "rebuildRatings") {
      try {
        const correctPin = process.env.FEEDBACK_PIN;
        if (!correctPin) {
          return res.status(503).json({ error: "Feedback PIN is not configured" });
        }
        if (body.pin !== correctPin) {
          return res.status(403).json({ error: "Invalid PIN" });
        }
        const result = await ratings.rebuildTotals(redis, {
          dryRun: body.dryRun !== false,
          excludeTs: Array.isArray(body.excludeTs) ? body.excludeTs : [],
          includeTs: Array.isArray(body.includeTs) ? body.includeTs : [],
        });
        return res.status(200).json(result);
      } catch (e) {
        return res.status(500).json({ error: "Failed to rebuild ratings" });
      }
    }

    // Get feedback viewer — PIN-gated, private
    if (body && body.type === "getFeedback") {
      try {
        const correctPin = process.env.FEEDBACK_PIN;
        if (!correctPin) {
          return res.status(503).json({ error: "Feedback PIN is not configured" });
        }
        if (body.pin !== correctPin) {
          return res.status(403).json({ error: "Invalid PIN" });
        }
        const items = redis ? await redis.lrange("pf_feedback", 0, 199) : [];
        const parsed = items.map(function(item) {
          try { return typeof item === "string" ? JSON.parse(item) : item; }
          catch (e) { return null; }
        }).filter(Boolean);
        return res.status(200).json({ ok: true, feedback: parsed });
      } catch (e) {
        return res.status(500).json({ error: "Failed to read feedback" });
      }
    }

    // Daily provider usage (counts only, no text) — PIN-gated, private
    if (body && body.type === "providerUsage") {
      try {
        const correctPin = process.env.FEEDBACK_PIN;
        if (!correctPin) {
          return res.status(503).json({ error: "Feedback PIN is not configured" });
        }
        if (body.pin !== correctPin) {
          return res.status(403).json({ error: "Invalid PIN" });
        }
        return res.status(200).json(await usage.getUsage(redis, body.days));
      } catch (e) {
        return res.status(500).json({ error: "Failed to read usage" });
      }
    }

    // Study Pack (studypack.html): the prompt is built server-side from {text, mode, inputType}
    if (body && typeof body.type === "string" && body.type.startsWith("studypack")) {
      const r = await studypack.handle(body, {
        env: process.env, redis, ip,
        rateLimit: (t) => {
          const rate = checkRateLimit(ip, t);
          return { allowed: rate.allowed, message: rate.allowed ? "" : "Too many requests — please wait a little and try again." };
        },
        runText: (t, p, accept) => runChain(t, p, "studypack", { accept }),
      });
      return res.status(r.status).json(r.body);
    }

    // Validate input early so we have `text` for duplicate detection
    const { text, mode, language, type } = body || {};
    if (!text || typeof text !== "string" || text.trim().length < 5) {
      return res.status(400).json({ error: "No text provided" });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: "Text too long. Max 50,000 characters." });
    }

    // Rate limit check (uses text for duplicate detection)
    const rate = checkRateLimit(ip, text);
    res.setHeader("X-RateLimit-Remaining", rate.remaining);

    if (!rate.allowed) {
      const messages = {
        burst:     "Too many requests too quickly — please slow down.",
        duplicate: "Repeated identical requests detected. Please wait 30 minutes before trying again.",
        hourly:    "Hourly limit reached (200 requests). Please try again in 1 hour.",
      };
      return res.status(429).json({
        error: "Too many requests",
        message: messages[rate.reason] || "Rate limit reached. Please try again later."
      });
    }

    // code_assistant/code_project always use their stored prompt — frontend override is ignored
    const isAIChat = type === 'code_assistant' || type === 'code_project';
    const prompt = isAIChat
      ? getPrompt(type, language)
      : (body.prompt && typeof body.prompt === 'string' && body.prompt.trim().length > 0)
        ? body.prompt.trim()
        : getPrompt(mode || type || "standard", language);

    const { success, result, usedApi, error, apiStatuses } = await runChain(text.trim(), prompt, type);

    if (success) {
      return res.status(200).json({
        success: true,
        result,
        usedApi,
        apiStatuses,
        remaining: rate.remaining
      });
    }

    return res.status(503).json({
      success: false,
      error: "high_demand",
      message: "Our AI is at high demand right now. Please wait 20 seconds and try again — your full document will process.",
      apiStatuses
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
};
