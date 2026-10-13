// ═══════════════════════════════════════════════════
// ParaFree — automatic model discovery (api/_model-discovery.js)
// The leading underscore keeps Vercel from exposing this file as an endpoint.
//
// Each provider has a PREFERENCE LIST of model patterns (env *_MODEL_PREFS, comma-separated,
// "*" = wildcard). Every pattern resolves to the NEWEST matching text/chat model the key can
// access, taken from the provider's live model list. Slot 0 = Tier 1, slots 1+ = Tier 2
// (NVIDIA: all slots are its Tier 3 fallback list).
//
// Lists are cached in Upstash (fresh for 6 h, kept 7 days as a fallback). If a live fetch
// fails: last cached list → defaults. A user request never waits more than ~1 s for it.
// A model that answers HTTP 404/410, or whose error says decommissioned/retired/deprecated, is marked dead for
// 24 h (memory + Upstash) and its slot re-resolves to the next model immediately.
// ═══════════════════════════════════════════════════
'use strict';

const FRESH_MS       = 6 * 60 * 60 * 1000;   // list considered fresh for 6 h
const CACHE_KEEP_S   = 7 * 24 * 60 * 60;     // Upstash keeps the last list 7 days (stale fallback)
const RETRY_MS       = 5 * 60 * 1000;        // after a failed/partial refresh, retry at most every 5 min
const WAIT_MS        = 1000;                 // max time a user request waits for discovery
const FETCH_MS       = 4000;                 // per list-fetch timeout (background)
const DEAD_MS        = 24 * 60 * 60 * 1000;  // dead model kept out for 24 h
const DEAD_REDIS_KEY = 'pf_dead_models';
const listKey = (pk) => 'pf_models:' + pk;

// Non-chat model families — excluded unless the pattern names the word explicitly.
const EXCLUDE_WORDS = ['embed', 'vision', 'whisper', 'tts', 'guard', 'moderation', 'audio', 'image', 'preview',
                       'exp', 'experimental', 'learnlm'];

const GROQ_KEY_NAMES = ['groq', 'groq-2', 'groq-3'];

function parsePrefs(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Defaults resolve, with today's model lists, to exactly the v2.4 chain. Old single-model
// env overrides (GROQ_MODEL, GEMINI_LITE_MODEL, GEMMA_MODEL, NVIDIA_MODEL) still work.
function defaultPrefs(env) {
  return {
    groq:       [env.GROQ_MODEL || 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-*-versatile'],
    gemini:     ['gemini-*-flash-lite', env.GEMINI_LITE_MODEL || 'gemini-*-flash-lite', env.GEMMA_MODEL || 'gemma-*-it'],
    cloudflare: ['@cf/meta/llama-*-8b-instruct'],
    nvidia:     [...(env.NVIDIA_MODEL ? [env.NVIDIA_MODEL] : []),
                 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/nemotron-3-ultra-550b-a55b',
                 'deepseek-ai/deepseek-v4.1-flash', 'mistralai/mistral-large-2-instruct',
                 'nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3-flash', 'nv-mistralai/mistral-nemo-12b-instruct'],
  };
}
// Concrete models used when no list is available and a pattern has a wildcard.
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
function patternRe(pattern) {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}
function isTextModel(id, pattern) {
  const lid = id.toLowerCase(), lp = pattern.toLowerCase();
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
// Newest first: higher version numbers, then newer `created`, then name.
function newestFirst(a, b) {
  return compareVersions(versionKey(b.id), versionKey(a.id)) || ((b.created || 0) - (a.created || 0)) || a.id.localeCompare(b.id);
}

// prefs × list → [{ pattern, model|null }], one per pattern. Each pattern picks the newest
// matching model not already picked by an earlier pattern and not dead.
function resolveSlots(prefs, list, isDead, defaults) {
  const chosen = new Set();
  return prefs.map((pattern, i) => {
    let model = null;
    if (list) {
      const re = patternRe(pattern);
      const cands = list.filter(m => re.test(m.id) && isTextModel(m.id, pattern) && !isDead(m.id) && !chosen.has(m.id)).sort(newestFirst);
      model = cands.length ? cands[0].id : null;
    } else {
      const lit = pattern.includes('*') ? (defaults[i] || null) : pattern;
      model = lit && !isDead(lit) && !chosen.has(lit) ? lit : null;
    }
    if (model) chosen.add(model);
    return { pattern, model };
  });
}

// Dead = HTTP 404/410 (callers put the status after a colon, e.g. "Groq/<model>:404 …"), or the
// error says decommissioned / retired / deprecated. "not found" on its own is NOT enough.
function isDeadModelError(msg) {
  return /:(404|410)\b|decommission|retired|deprecated/i.test(String(msg || ''));
}

// ── Discovery service ──
function createModelDiscovery({ fetchWithTimeout, getRedis, env = process.env, log = console }) {
  const LISTS = {};     // providerKey → { models:[{id,created}], fetchedAt, source, error? }
  const STATUS = {};    // providerKey → { source, error } for keys without a list
  const DEAD = new Map(); // "provider:model" → until (epoch ms)
  const LAST = {};      // providerKey → last resolved models by slot (for swap logs)
  let refreshing = null;
  let lastAttempt = 0;
  let lastRefresh = 0;

  const validKey = (k) => !!(k && k.length > 10);
  const providerOf = (pk) => pk.startsWith('groq') ? 'groq' : pk;
  const isDead = (provider, model) => {
    const until = DEAD.get(provider + ':' + model);
    if (!until) return false;
    if (until <= Date.now()) { DEAD.delete(provider + ':' + model); return false; }
    return true;
  };

  async function redisGet(k) { const r = getRedis(); if (!r) return null; try { return await r.get(k); } catch (_) { return null; } }
  async function redisSet(k, v, ex) { const r = getRedis(); if (!r) return; try { await r.set(k, v, { ex }); } catch (_) {} }

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
    if (validKey(env.CF_KEY) && validKey(env.CF_ACCOUNT)) f.cloudflare = async () => {
      const d = await getJson('https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT + '/ai/models/search?task=Text%20Generation&per_page=1000',
        { Authorization: 'Bearer ' + env.CF_KEY });
      return (d.result || []).filter(m => m.name).map(m => ({ id: m.name, created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) || 0 : 0 }));
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
    return resolveSlots(prefsFor(provider, env), list, (m) => isDead(provider, m), defaultModels(env)[provider]);
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

  async function refresh({ force = false } = {}) {
    lastAttempt = Date.now();
    await loadDead();
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
    // Only a cold instance (nothing loaded yet) waits — and for at most WAIT_MS.
    if (refreshing && loaded.length === 0) {
      let timer;
      await Promise.race([refreshing, new Promise(r => { timer = setTimeout(r, WAIT_MS); if (timer.unref) timer.unref(); })]);
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
    return {
      lists,
      lastAttempt: lastAttempt ? new Date(lastAttempt).toISOString() : null,
      lastFullRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      freshForHours: FRESH_MS / 3600000,
      deadModels: dead,
      prefs: { groq: prefsFor('groq', env), gemini: prefsFor('gemini', env), cloudflare: prefsFor('cloudflare', env), nvidia: prefsFor('nvidia', env) },
    };
  }

  return { ensure, refresh, slots, models, markDead, isDead, status, tierLabel, isDeadModelError };
}

module.exports = {
  createModelDiscovery, resolveSlots, patternRe, isTextModel, newestFirst, isDeadModelError,
  defaultPrefs, defaultModels, prefsFor, parsePrefs, EXCLUDE_WORDS, FRESH_MS, WAIT_MS, DEAD_MS,
};
