// ═══════════════════════════════════════════════════
// ParaFree — automatic model discovery (api/_model-discovery.js)
// The leading underscore keeps Vercel from exposing this file as an endpoint.
//
// Each provider has a PREFERENCE LIST of model patterns (env *_MODEL_PREFS, comma-separated
// slots; within a slot "*" = wildcard and "|" = any of several patterns). Every slot resolves
// to the best matching text/chat model the key can access, taken from the provider's live
// model list. Slot 0 = Tier 1, slots 1+ = Tier 2 (NVIDIA: all slots are its Tier 3 list).
//
// A slot never goes empty: pattern match → last model that worked for that slot (Upstash)
// → hard-coded default → automatic pick of the best text model in the provider's list.
//
// Lists are cached in Upstash (fresh for 6 h, kept 7 days as a fallback). If a live fetch
// fails: last cached list → defaults. A user request never waits more than ~1 s for it.
// A model that answers HTTP 404/410, or whose error says decommissioned/retired/deprecated,
// is marked dead for 24 h (memory + Upstash) and its slot re-resolves immediately.
//
// Shared across instances via Upstash hashes: each entry's last success time (used to try
// the most recently working entry first WITHIN a tier), each slot's last good model, and
// health-check skips (non-quota failures, 15 min).
// ═══════════════════════════════════════════════════
'use strict';

const FRESH_MS         = 6 * 60 * 60 * 1000;   // list considered fresh for 6 h
const CACHE_KEEP_S     = 7 * 24 * 60 * 60;     // Upstash keeps lists / stats 7 days
const RETRY_MS         = 5 * 60 * 1000;        // after a failed/partial refresh, retry at most every 5 min
const WAIT_MS          = 1000;                 // max time a user request waits for discovery
const FETCH_MS         = 4000;                 // per list-fetch timeout (background)
const DEAD_MS          = 24 * 60 * 60 * 1000;  // dead model kept out for 24 h
const SKIP_MS          = 15 * 60 * 1000;       // health-check non-quota failure: entry skipped 15 min
const STATS_TTL_MS     = 60 * 1000;            // re-read shared success/skip stats at most every 60 s
const STATS_WRITE_MS   = 60 * 1000;            // write an entry's success time at most every 60 s
const RECENT_WINDOW_MS = 60 * 60 * 1000;       // only successes in the last hour affect ordering
const RECENT_BUCKET_MS = 10 * 60 * 1000;       // successes in the same 10-min bucket tie → rotation decides
const DEAD_REDIS_KEY   = 'pf_dead_models';
const SUCCESS_KEY      = 'pf_last_success';    // hash: entry name → epoch ms
const LAST_GOOD_KEY    = 'pf_last_good';       // hash: "<key>:<slot>" → { model, at }
const SKIP_KEY         = 'pf_skip';            // hash: entry name → until (epoch ms)
const listKey = (pk) => 'pf_models:' + pk;

// Non-chat model families — excluded unless the pattern names the word explicitly.
const EXCLUDE_WORDS = ['embed', 'vision', 'whisper', 'tts', 'guard', 'moderation', 'audio', 'image', 'preview',
                       'exp', 'experimental', 'learnlm', 'reward', 'reranker', 'classifier'];

const GROQ_KEY_NAMES = ['groq', 'groq-2', 'groq-3'];

// How each provider ranks several matching models:
//   largest  — biggest parameter count first (e.g. 70b before 32b), then newest
//   newest   — highest version first (gemini-3.5 before 3.1), then size, then `created`
//   smallest — smallest/cheapest first (Cloudflare bills per neuron), then newest
//   cloudflare — ~7–8B first, then larger (smallest of those first), then unknown size, then 3–7B
const PROVIDER_SORT = { groq: 'largest', gemini: 'newest', cloudflare: 'cloudflare', nvidia: 'largest' };
// Wildcard / automatic picks never go below this many billion parameters (exact names are allowed).
const MIN_SIZE_B = { cloudflare: 3 };
// Providers whose slots keep the previously working model while it still fits the pattern.
const PREFER_PREVIOUS = { cloudflare: true };

function parsePrefs(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Old single-model env overrides (GROQ_MODEL, GEMINI_LITE_MODEL, GEMMA_MODEL, NVIDIA_MODEL) still work.
function defaultPrefs(env) {
  return {
    groq:       [env.GROQ_MODEL || 'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
                 'llama-*|qwen*|meta-llama/*|moonshotai/*|*-instruct'],
    gemini:     ['gemini-*-flash-lite', env.GEMINI_LITE_MODEL || 'gemini-*-flash', env.GEMMA_MODEL || 'gemma-*-it'],
    cloudflare: ['@cf/*instruct*'],
    nvidia:     [...(env.NVIDIA_MODEL ? [env.NVIDIA_MODEL] : []),
                 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/nemotron-3-ultra-550b-a55b',
                 'deepseek-ai/deepseek-v4.1-flash', 'mistralai/mistral-large-2-instruct',
                 'nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3-flash', 'nv-mistralai/mistral-nemo-12b-instruct'],
  };
}
// The old hard-coded models — used when there is no list and a pattern has a wildcard, and as
// a slot's fallback when its pattern matches nothing.
function defaultModels(env) {
  return {
    groq:       [env.GROQ_MODEL || 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    gemini:     ['gemini-3.5-flash-lite', env.GEMINI_LITE_MODEL || 'gemini-3.1-flash-lite', env.GEMMA_MODEL || 'gemma-3-27b-it'],
    cloudflare: ['@cf/meta/llama-3.1-8b-instruct'],
    nvidia:     defaultPrefs(env).nvidia,
  };
}
function prefsFor(provider, env) {
  const envName = { groq: 'GROQ_MODEL_PREFS', gemini: 'GEMINI_MODEL_PREFS', cloudflare: 'CF_MODEL_PREFS', nvidia: 'NVIDIA_MODEL_PREFS' }[provider];
  const custom = parsePrefs(env[envName]);
  return custom.length ? custom : defaultPrefs(env)[provider];
}

// ── Matching ──
// "a*|b*" → matches either alternative; "*" = any characters; anchored, case-insensitive.
function patternRe(pattern) {
  const alt = String(pattern).split('|').map(p => p.trim()).filter(Boolean)
    .map(p => p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  return new RegExp('^(?:' + alt.join('|') + ')$', 'i');
}
function isTextModel(id, pattern) {
  const lid = id.toLowerCase(), lp = String(pattern || '').toLowerCase();
  return !EXCLUDE_WORDS.some(w => lid.includes(w) && !lp.includes(w));
}
// Version groups, e.g. "llama-3.3-70b" → [[3,3],[70]]; "gemma-3n-e4b-it" → [[3],[4]].
function versionKey(id) {
  return (id.match(/\d+(?:\.\d+)*/g) || []).map(g => g.split('.').map(Number));
}
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x) return -1; if (!y) return 1;
    for (let j = 0; j < Math.max(x.length, y.length); j++) {
      const p = x[j] === undefined ? -1 : x[j], q = y[j] === undefined ? -1 : y[j];
      if (p !== q) return p - q;
    }
  }
  return 0;
}
// Parameter count in billions from the name ("70b", "17b-16e", "e4b"); 0 if none.
function sizeOf(id) {
  let max = 0;
  for (const m of String(id).matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/gi)) max = Math.max(max, Number(m[1]));
  return max;
}
// Newest first: higher version numbers, then newer `created`, then name.
function newestFirst(a, b) {
  return compareVersions(versionKey(b.id), versionKey(a.id)) || ((b.created || 0) - (a.created || 0)) || a.id.localeCompare(b.id);
}
const SORTERS = {
  newest:   newestFirst,
  largest:  (a, b) => (sizeOf(b.id) - sizeOf(a.id)) || newestFirst(a, b),
  smallest: (a, b) => ((sizeOf(a.id) || Infinity) - (sizeOf(b.id) || Infinity)) || newestFirst(a, b),
  // Cloudflare: prefer ~7–8B (good quality, cheap neurons), then larger ones smallest-first,
  // then models whose size isn't in the name, then 3–7B.
  cloudflare: (a, b) => {
    const band = (s) => s >= 7 && s < 9 ? 0 : s >= 9 ? 1 : s === 0 ? 2 : 3;
    const sa = sizeOf(a.id), sb = sizeOf(b.id);
    return (band(sa) - band(sb)) || (sa - sb) || newestFirst(a, b);
  },
};

// prefs × list → [{ pattern, model|null, from }], one per slot. `from` says how the model was
// picked: "previous" (kept the model used before), "match" (best pattern match in the list),
// "literal" (exact name, no list), "last-good", "default", or "auto" (pattern matched nothing —
// best text model in the provider's list). A slot never goes empty unless every candidate is
// dead (retired) or already taken by an earlier slot.
// opts: { sort: 'newest'|'largest'|'smallest'|'cloudflare', preferPrevious: bool, minSizeB: number }
function resolveSlots(prefs, list, isDead, defaults, lastGood = [], opts = {}) {
  const sorter = SORTERS[opts.sort] || newestFirst;
  const chosen = new Set();
  const usable = (m) => !!m && !isDead(m) && !chosen.has(m);
  // opts.minSizeB: wildcard / automatic picks skip models whose name shows fewer parameters
  // (size unknown = allowed). An exact model name in the preferences is always allowed.
  const bigEnough = (id, pattern) => {
    if (!opts.minSizeB || !/[*|]/.test(pattern)) return true;
    const s = sizeOf(id);
    return s === 0 || s >= opts.minSizeB;
  };
  return prefs.map((pattern, i) => {
    const re = patternRe(pattern);
    let model = null, from = null;
    // Cloudflare-style: keep the model used before while it still fits the pattern.
    if (opts.preferPrevious) {
      for (const [c, f] of [[lastGood[i], 'previous'], [defaults[i], 'previous']]) {
        if (!model && usable(c) && re.test(c)) { model = c; from = f; }
      }
    }
    if (!model && list) {
      const cands = list.filter(m => re.test(m.id) && isTextModel(m.id, pattern) && usable(m.id) && bigEnough(m.id, pattern)).sort(sorter);
      if (cands.length) { model = cands[0].id; from = 'match'; }
    } else if (!model && !pattern.includes('*') && !pattern.includes('|') && usable(pattern)) {
      model = pattern; from = 'literal';
    }
    if (!model && usable(lastGood[i])) { model = lastGood[i]; from = 'last-good'; }
    if (!model && usable(defaults[i])) { model = defaults[i]; from = 'default'; }
    if (!model && list) {
      const best = list.filter(m => isTextModel(m.id, '') && usable(m.id) && bigEnough(m.id, '*')).sort(sorter)[0];
      if (best) { model = best.id; from = 'auto'; }
    }
    if (!model) { const alt = defaults.find(usable); if (alt) { model = alt; from = 'default'; } }
    if (model) chosen.add(model);
    return { pattern, model, from };
  });
}

// Dead = HTTP 404/410 (callers put the status after a colon, e.g. "Groq/<model>:404 …"), or the
// error says decommissioned / retired / deprecated. "not found" on its own is NOT enough.
function isDeadModelError(msg) {
  return /:(404|410)\b|decommission|retired|deprecated/i.test(String(msg || ''));
}

// ── Discovery service ──
function createModelDiscovery({ fetchWithTimeout, getRedis, env = process.env, log = console }) {
  const LISTS = {};          // providerKey → { models:[{id,created}], fetchedAt, source, error? }
  const STATUS = {};         // providerKey → { source, error } for keys without a list
  const DEAD = new Map();    // "provider:model" → until (epoch ms)
  const LAST = {};           // providerKey → last resolved models by position (for swap logs)
  const SUCCESS = new Map(); // entry name → last success (epoch ms)
  const SKIP = new Map();    // entry name → until (epoch ms)
  const LAST_GOOD = {};      // "<key>:<slot>" → { model, at }
  const lastWrite = new Map();
  let refreshing = null, statsLoading = null;
  let lastAttempt = 0, lastRefresh = 0, statsLoadedAt = 0;

  const validKey = (k) => !!(k && k.length > 10);
  const providerOf = (pk) => pk.startsWith('groq') ? 'groq' : pk;
  const isDead = (provider, model) => {
    const until = DEAD.get(provider + ':' + model);
    if (!until) return false;
    if (until <= Date.now()) { DEAD.delete(provider + ':' + model); return false; }
    return true;
  };

  const R = () => getRedis();
  async function redisGet(k) { const r = R(); if (!r) return null; try { return await r.get(k); } catch (_) { return null; } }
  async function redisSet(k, v, ex) { const r = R(); if (!r) return; try { await r.set(k, v, { ex }); } catch (_) {} }
  async function hgetall(k) { const r = R(); if (!r || !r.hgetall) return null; try { return await r.hgetall(k); } catch (_) { return null; } }
  async function hset(k, obj) {
    const r = R(); if (!r || !r.hset) return;
    try { await r.hset(k, obj); if (r.expire) await r.expire(k, CACHE_KEEP_S); } catch (_) {}
  }
  async function hdel(k, field) { const r = R(); if (!r || !r.hdel) return; try { await r.hdel(k, field); } catch (_) {} }

  async function getJson(url, headers) {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, FETCH_MS);
    if (!res.ok) { let b = ''; try { b = await res.text(); } catch (_) {} throw new Error(res.status + ' ' + b.slice(0, 120)); }
    return res.json();
  }

  // providerKey → () => Promise<[{id, created}]>, only for providers with credentials.
  function fetchers() {
    const f = {};
    const groqKeys = { 'groq': env.GROQ_KEY, 'groq-2': env.GROQ_KEY_2, 'groq-3': env.GROQ_KEY_3 };
    for (const [pk, key] of Object.entries(groqKeys)) {
      if (validKey(key)) f[pk] = async () => {
        const d = await getJson('https://api.groq.com/openai/v1/models', { Authorization: 'Bearer ' + key });
        return (d.data || []).filter(m => m.id && m.active !== false).map(m => ({ id: m.id, created: m.created || 0 }));
      };
    }
    if (validKey(env.GEMINI_KEY)) f.gemini = async () => {
      const out = [];
      let token = '';
      for (let page = 0; page < 5; page++) {
        const d = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : '') + '&key=' + env.GEMINI_KEY, {});
        for (const m of d.models || []) {
          if ((m.supportedGenerationMethods || []).includes('generateContent')) out.push({ id: String(m.name).replace(/^models\//, ''), created: 0 });
        }
        token = d.nextPageToken;
        if (!token) break;
      }
      return out;
    };
    // Cloudflare's model search is paginated — read every page (a first page alone can miss
    // the model in use, which made the Cloudflare slot look empty).
    if (validKey(env.CF_KEY) && validKey(env.CF_ACCOUNT)) f.cloudflare = async () => {
      const out = [];
      const PER = 100;
      for (let page = 1; page <= 10; page++) {
        const d = await getJson('https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT +
          '/ai/models/search?task=Text%20Generation&per_page=' + PER + '&page=' + page, { Authorization: 'Bearer ' + env.CF_KEY });
        const items = d.result || [];
        for (const m of items) if (m.name) out.push({ id: m.name, created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) || 0 : 0 });
        const info = d.result_info || {};
        if (items.length < PER || (info.total_pages && page >= info.total_pages) || (info.total_count && out.length >= info.total_count)) break;
      }
      return out;
    };
    if (validKey(env.NVIDIA_KEY)) f.nvidia = async () => {
      const d = await getJson('https://integrate.api.nvidia.com/v1/models', { Authorization: 'Bearer ' + env.NVIDIA_KEY });
      return (d.data || []).filter(m => m.id).map(m => ({ id: m.id, created: m.created || 0 }));
    };
    return f;
  }

  function slots(pk) {
    const provider = providerOf(pk);
    const list = LISTS[pk] ? LISTS[pk].models : null;
    const prefs = prefsFor(provider, env);
    const lastGood = prefs.map((_, i) => (LAST_GOOD[pk + ':' + i] || {}).model);
    return resolveSlots(prefs, list, (m) => isDead(provider, m), defaultModels(env)[provider], lastGood,
      { sort: PROVIDER_SORT[provider], preferPrevious: !!PREFER_PREVIOUS[provider], minSizeB: MIN_SIZE_B[provider] || 0 });
  }
  const models = (pk) => slots(pk).map(s => s.model).filter(Boolean);

  function tierLabel(provider, i) { return provider === 'nvidia' ? 'tier3 #' + (i + 1) : i === 0 ? 'tier1' : 'tier2'; }

  // Logs "model swap: <key> <tier> old → new" per tier position (tiers are positional among
  // resolved models). Only positions where a model really left or arrived are logged, so a
  // retirement gives one line ("tier1 A → B") rather than every later slot shifting up.
  function logSwaps(reason, only) {
    for (const pk of only ? [only] : [...GROQ_KEY_NAMES, 'gemini', 'cloudflare', 'nvidia']) {
      const now = models(pk);
      const before = LAST[pk];
      LAST[pk] = now;
      if (!before) continue;
      for (let i = 0; i < Math.max(now.length, before.length); i++) {
        const was = before[i], is = now[i];
        if (was === is) continue;
        if ((was && !now.includes(was)) || (is && !before.includes(is))) {
          log.log(`[ParaFree] model swap: ${pk} ${tierLabel(providerOf(pk), i)} ${was || '(none)'} → ${is || '(none)'} (${reason})`);
        }
      }
    }
  }
  // First snapshot = what the defaults resolve to, so the first discovery logs real swaps.
  for (const pk of [...GROQ_KEY_NAMES, 'gemini', 'cloudflare', 'nvidia']) LAST[pk] = models(pk);

  async function loadDead() {
    const stored = await redisGet(DEAD_REDIS_KEY);
    if (stored && typeof stored === 'object') {
      for (const [k, until] of Object.entries(stored)) if (until > Date.now()) DEAD.set(k, until);
    }
  }

  // Shared success times, last-good models and skips (merged: newest wins).
  async function loadStats() {
    const [succ, good, skip] = await Promise.all([hgetall(SUCCESS_KEY), hgetall(LAST_GOOD_KEY), hgetall(SKIP_KEY)]);
    for (const [k, v] of Object.entries(succ || {})) { const t = Number(v); if (t > (SUCCESS.get(k) || 0)) SUCCESS.set(k, t); }
    for (const [k, v] of Object.entries(good || {})) {
      const val = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch (_) { return null; } })() : v;
      if (val && val.model && (!LAST_GOOD[k] || val.at > LAST_GOOD[k].at)) LAST_GOOD[k] = { model: val.model, at: Number(val.at) || 0 };
    }
    for (const [k, v] of Object.entries(skip || {})) { const u = Number(v); if (u > Date.now() && u > (SKIP.get(k) || 0)) SKIP.set(k, u); }
    statsLoadedAt = Date.now();
  }

  async function refresh({ force = false } = {}) {
    lastAttempt = Date.now();
    await Promise.all([loadDead(), loadStats()]);
    const f = fetchers();
    let allOk = true;
    await Promise.all(Object.entries(f).map(async ([pk, fetchList]) => {
      const cached = await redisGet(listKey(pk));
      if (!force && cached && cached.models && Date.now() - cached.fetchedAt < FRESH_MS) {
        LISTS[pk] = { models: cached.models, fetchedAt: cached.fetchedAt, source: 'upstash-cache' };
        delete STATUS[pk];
        return;
      }
      try {
        const list = await fetchList();
        if (!list.length) throw new Error('empty model list');
        const entry = { models: list, fetchedAt: Date.now() };
        LISTS[pk] = { ...entry, source: 'live' };
        delete STATUS[pk];
        await redisSet(listKey(pk), entry, CACHE_KEEP_S);
      } catch (e) {
        allOk = false;
        const msg = e.message || String(e);
        if (cached && cached.models) LISTS[pk] = { models: cached.models, fetchedAt: cached.fetchedAt, source: 'stale-cache', error: msg };
        else if (LISTS[pk]) LISTS[pk] = { ...LISTS[pk], source: 'stale-memory', error: msg };
        else STATUS[pk] = { source: 'defaults', error: msg };
        log.warn(`[ParaFree] model discovery: ${pk} list fetch failed (${msg.slice(0, 80)}) — using ${LISTS[pk] ? LISTS[pk].source : 'defaults'}`);
      }
    }));
    if (allOk) lastRefresh = Date.now();
    logSwaps('discovery refresh');
  }

  // Called at the start of every request. Never blocks for more than WAIT_MS.
  async function ensure() {
    const keys = Object.keys(fetchers());
    const loaded = keys.filter(pk => LISTS[pk]);
    const stale = keys.some(pk => !LISTS[pk] || Date.now() - LISTS[pk].fetchedAt > FRESH_MS);
    if (stale && !refreshing && Date.now() - lastAttempt > RETRY_MS) {
      refreshing = refresh().catch(e => log.warn('[ParaFree] model discovery error: ' + e.message)).finally(() => { refreshing = null; });
    }
    if (!refreshing && !statsLoading && Date.now() - statsLoadedAt > STATS_TTL_MS) {
      statsLoading = loadStats().catch(() => {}).finally(() => { statsLoading = null; });
    }
    // Only a cold instance (nothing loaded yet) waits — and for at most WAIT_MS.
    const pending = [loaded.length === 0 && refreshing, statsLoadedAt === 0 && statsLoading].filter(Boolean);
    if (pending.length) {
      let timer;
      await Promise.race([Promise.all(pending), new Promise(r => { timer = setTimeout(r, WAIT_MS); if (timer.unref) timer.unref(); })]);
      clearTimeout(timer);
    }
  }

  // Marks a model dead for 24 h (memory + Upstash) and returns the model now at the same
  // position among the key's resolved models (null if none), logging the swap.
  // `slot` = position among RESOLVED models (Tier 1 = position 0), as used by the chain.
  async function markDead(provider, model, reason, pk, slot) {
    DEAD.set(provider + ':' + model, Date.now() + DEAD_MS);
    const stored = (await redisGet(DEAD_REDIS_KEY)) || {};
    const merged = { ...(typeof stored === 'object' ? stored : {}) };
    for (const [k, until] of DEAD) merged[k] = until;
    await redisSet(DEAD_REDIS_KEY, merged, Math.ceil(DEAD_MS / 1000));
    log.warn(`[ParaFree] model dead: ${provider}/${model} (${String(reason).slice(0, 80)}) — skipped for 24h`);
    const keysToLog = provider === 'groq' ? GROQ_KEY_NAMES : [provider];
    for (const k of keysToLog) logSwaps('retired: ' + String(reason).slice(0, 40), k);
    return pk !== undefined && slot !== undefined ? models(pk)[slot] || null : null;
  }

  // ── Last known good / success ordering ──
  // Records a successful call. pk + slot (pattern index) + model also update the slot's
  // last-good model. Upstash writes are throttled and never awaited by the request.
  function noteSuccess(name, pk, slot, model) {
    const now = Date.now();
    SUCCESS.set(name, now);
    if (SKIP.has(name)) { SKIP.delete(name); hdel(SKIP_KEY, name); }
    if (now - (lastWrite.get(name) || 0) > STATS_WRITE_MS) {
      lastWrite.set(name, now);
      hset(SUCCESS_KEY, { [name]: now });
    }
    if (pk !== undefined && slot !== undefined && model) {
      const k = pk + ':' + slot, prev = LAST_GOOD[k];
      LAST_GOOD[k] = { model, at: now };
      if (!prev || prev.model !== model || now - prev.at > STATS_WRITE_MS) hset(LAST_GOOD_KEY, { [k]: LAST_GOOD[k] });
    }
  }
  // Ordering key within a tier: higher = tried earlier. Successes older than an hour count as
  // none; successes in the same 10-minute bucket tie, so the Groq key rotation still spreads load.
  function recency(name) {
    const t = SUCCESS.get(name) || 0;
    return t && Date.now() - t < RECENT_WINDOW_MS ? Math.floor(t / RECENT_BUCKET_MS) : -1;
  }
  function lastSuccess(name) { return SUCCESS.get(name) || 0; }

  // ── Skip list (health-check failures that are not rate limits) ──
  function skip(name, reason, ms = SKIP_MS) {
    const until = Date.now() + ms;
    SKIP.set(name, until);
    hset(SKIP_KEY, { [name]: until });
    log.warn(`[ParaFree] skip: ${name} for ${Math.round(ms / 60000)} min (${String(reason).slice(0, 80)})`);
  }
  function skipUntil(name) {
    const u = SKIP.get(name);
    if (!u) return 0;
    if (u <= Date.now()) { SKIP.delete(name); return 0; }
    return u;
  }
  const isSkipped = (name) => skipUntil(name) > 0;

  function status() {
    const keys = [...new Set([...Object.keys(fetchers()), ...Object.keys(LISTS)])];
    const lists = {};
    for (const pk of keys) {
      const l = LISTS[pk];
      lists[pk] = l
        ? { source: l.source, refreshedAt: new Date(l.fetchedAt).toISOString(), ageMinutes: Math.round((Date.now() - l.fetchedAt) / 60000), modelCount: l.models.length, ...(l.error ? { error: l.error } : {}) }
        : { source: 'defaults', refreshedAt: null, ...(STATUS[pk] && STATUS[pk].error ? { error: STATUS[pk].error } : {}) };
    }
    const dead = [];
    for (const [k, until] of DEAD) if (until > Date.now()) { const i = k.indexOf(':'); dead.push({ provider: k.slice(0, i), model: k.slice(i + 1), until: new Date(until).toISOString() }); }
    const skipped = [];
    for (const [name, until] of SKIP) if (until > Date.now()) skipped.push({ entry: name, until: new Date(until).toISOString() });
    const lastGood = {};
    for (const [k, v] of Object.entries(LAST_GOOD)) lastGood[k] = { model: v.model, at: new Date(v.at).toISOString() };
    const recentSuccess = {};
    for (const [name, t] of SUCCESS) if (Date.now() - t < RECENT_WINDOW_MS) recentSuccess[name] = new Date(t).toISOString();
    return {
      lists,
      lastAttempt: lastAttempt ? new Date(lastAttempt).toISOString() : null,
      lastFullRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      freshForHours: FRESH_MS / 3600000,
      deadModels: dead,
      skippedEntries: skipped,
      lastGood,
      recentSuccess,
      prefs: { groq: prefsFor('groq', env), gemini: prefsFor('gemini', env), cloudflare: prefsFor('cloudflare', env), nvidia: prefsFor('nvidia', env) },
    };
  }

  return {
    ensure, refresh, slots, models, markDead, isDead, status, tierLabel, isDeadModelError,
    noteSuccess, recency, lastSuccess, skip, skipUntil, isSkipped,
  };
}

module.exports = {
  createModelDiscovery, resolveSlots, patternRe, isTextModel, newestFirst, sizeOf, isDeadModelError, MIN_SIZE_B,
  defaultPrefs, defaultModels, prefsFor, parsePrefs, EXCLUDE_WORDS, PROVIDER_SORT,
  FRESH_MS, WAIT_MS, DEAD_MS, SKIP_MS, RECENT_WINDOW_MS, RECENT_BUCKET_MS,
};
