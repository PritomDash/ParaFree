'use strict';
// Phase 3 before/after benchmark: the SAME mocked, rate-limited providers through two copies ("instances") of a
// handler, sharing one fake Upstash. Providers enforce per-key RPM and a scaled-down per-day limit (so a "day" fits in
// the run). Counts: requests served, refused (429) calls the chain made anyway, attempts per request.
// Usage: node tests/bench/handler-bench.js [path to an api/ folder]   (default: this checkout's api/)
// No network: every provider URL is mocked; unknown URLs throw.
const path = require('path');
const apiDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'api'));
for (const k of Object.keys(process.env)) if (/_KEY|_KEY_\d|^CF_ACCOUNT$|^UPSTASH|^KV_|_MODEL$|^PF_MAX/.test(k)) delete process.env[k];
Object.assign(process.env, { GROQ_KEY: 'groq-key-1-xxxxxxxx', GROQ_KEY_2: 'groq-key-2-xxxxxxxx', GROQ_KEY_3: 'groq-key-3-xxxxxxxx', GROQ_KEY_4: 'groq-key-4-xxxxxxxx',
  GEMINI_KEY: 'gemini-key-1-xxxxxxxx', GEMINI_KEY_2: 'gemini-key-2-xxxxxxxx', CF_KEY: 'cf-key-xxxxxxxxxxxx', CF_ACCOUNT: 'cf-account-xxxxxxx',
  KV_REST_API_URL: 'https://fake.upstash.io', KV_REST_API_TOKEN: 'fake-token' });

// fake clock (timers stay real but every chain delay is tiny)
const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
// one fake Upstash for every instance
const H = new Map(), KV = new Map();
const hash = (k) => { if (!H.has(k)) H.set(k, {}); return H.get(k); };
class FakeRedis {
  static fromEnv() { return new FakeRedis(); }
  async get(k) { return KV.has(k) ? KV.get(k) : null; } async set(k, v) { KV.set(k, v); return 'OK'; }
  async hgetall(k) { return H.has(k) ? Object.assign({}, H.get(k)) : null; } async hset(k, o) { Object.assign(hash(k), o); return 1; }
  async hdel(k, f) { delete hash(k)[f]; return 1; } async hincrby(k, f, n) { const o = hash(k); o[f] = (Number(o[f]) || 0) + n; return o[f]; }
  async expire() { return 1; } async incr(k) { const v = (Number(KV.get(k)) || 0) + 1; KV.set(k, v); return v; } async lrange() { return []; } async lpush() { return 1; } async ltrim() { return 'OK'; }
}
require.cache[require.resolve('@upstash/redis')] = { exports: { Redis: FakeRedis } };

// providers: per-KEY limits (each key its own org/project), scaled-down day
const LIM = { 'gpt-oss-120b': { rpm: 30, rpd: 40 }, 'gpt-oss-20b': { rpm: 30, rpd: 40 }, other: { rpm: 30, rpd: 40 }, 'flash-lite': { rpm: 15, rpd: 25 }, flash: { rpm: 5, rpd: 4 }, gemma: { rpm: 30, rpd: 400 } };
const used = new Map();
let refused = 0, calls = 0;
const respond = (status, json, headers = {}) => ({ ok: status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => json, text: async () => JSON.stringify(json) });
global.fetch = async (url, opts) => {
  if (opts && opts.method === 'GET') return respond(503, { error: 'no lists' });
  const body = JSON.parse(opts.body || '{}');
  let pool, fam;
  if (url.startsWith('https://api.groq.com/')) { pool = (opts.headers.Authorization || '').slice(7) + '/' + body.model; fam = /120b/.test(body.model) ? 'gpt-oss-120b' : /20b/.test(body.model) ? 'gpt-oss-20b' : 'other'; }
  else if (url.startsWith('https://generativelanguage.googleapis.com/')) { const m = url.match(/\/models\/([^:]+):/)[1]; pool = url.split('key=')[1] + '/' + m; fam = /flash-lite/.test(m) ? 'flash-lite' : /gemma/.test(m) ? 'gemma' : 'flash'; }
  else if (url.includes('/ai/run/') || /nvidia|ovh|llm7/.test(url)) { calls++; return respond(500, { error: 'not used in this benchmark' }); }
  else throw new Error('UNMOCKED URL — refusing live call: ' + url);
  calls++;
  const L = LIM[fam], t = Date.now(), u = used.get(pool) || { min: [], day: 0 };
  u.min = u.min.filter((x) => x > t - 60000);
  if (u.day >= L.rpd) {
    refused++;
    const msg = url.includes('googleapis') ? 'Quota exceeded for metric: generate_requests_per_model_per_day (GenerateRequestsPerDayPerProjectPerModel)' : 'Rate limit reached for model on requests per day (RPD): Limit ' + L.rpd;
    return respond(429, { error: { message: msg } });
  }
  if (u.min.length >= L.rpm) { refused++; return respond(429, { error: { message: 'Rate limit reached for model on requests per minute (RPM)' } }, { 'retry-after': '20' }); }
  u.min.push(t); u.day++; used.set(pool, u);
  const content = (body.messages ? body.messages[0].content : body.contents[0].parts[0].text);
  const text = content.slice(content.lastIndexOf(':\n\n') + 3).replace(/\b(\w{3,})\b/g, (w, x, i) => (i % 3 ? w : w + 'ed'));
  const rem = { 'x-ratelimit-remaining-requests': String(L.rpd - u.day), 'x-ratelimit-limit-requests': String(L.rpd) };
  if (url.includes('googleapis')) return respond(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
  return respond(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] }, rem);
};

// two instances = two fresh copies of the module (separate in-memory state, shared fake Upstash)
const load = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(apiDir)) delete require.cache[k]; return require(path.join(apiDir, 'process.js')); };
let LOGS = [];
const quiet = () => { console.log = console.warn = console.error = (...a) => { if (process.env.BENCH_DEBUG) LOGS.push(a.join(' ')); }; };
const realLog = console.log;
quiet();
const inst = [load(), load()];
(async () => {
  let ok = 0, failedReq = 0, attempts = 0;
  const N = 500;
  const text = 'Students who plan their revision week by week tend to remember more of what they read before the exam.';
  for (let i = 0; i < N; i++) {
    shift += 4000;                                      // one request every 4 s (fake clock) → ~33 min, ~15 req/min
    const before = calls;
    let status = 0;
    const res = { setHeader() {}, status(s) { status = s; return this; }, json() { return this; }, end() { return this; } };
    await inst[i % 2]({ method: 'POST', headers: { 'x-forwarded-for': '10.3.' + Math.floor(i / 200) + '.' + (i % 200) }, body: { text, mode: 'standard' } }, res);
    attempts += calls - before;
    if (status === 200) ok++; else { failedReq++; if (process.env.BENCH_DEBUG) { console.log = realLog; console.log('FAILED request', i, status); LOGS.slice(-25).forEach(l => console.log('  ' + l.slice(0, 200))); quiet(); } }
    LOGS = [];
  }
  console.log = realLog;
  console.log(JSON.stringify({ api: path.relative(process.cwd(), apiDir) || 'api', requests: N, served: ok, failed: failedReq, refused429Calls: refused, providerCalls: calls, attemptsPerRequest: +(attempts / N).toFixed(2) }));
  process.exit(0);
})().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
