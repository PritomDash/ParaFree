// ═══════════════════════════════════════════════════
// ParaFree — daily provider usage counter (api/_usage.js)
// One Upstash hash per UTC day ("pf_usage:2026-10-23"): field = which chain entry served the
// call, value = how many. Only counts are stored — never text, IPs or anything about the user.
// Fields:
//   "chunk|<entry>"  — a writing chunk (paraphrase, humanize, summarize, grammar, …)
//   "chunk|(none)"   — a writing chunk every provider failed (the original text was kept)
//   "chat|<entry>"   — an AI chat / CV request
// Read back by the admin health check (testKeys) and the PIN-gated "providerUsage" endpoint.
// ═══════════════════════════════════════════════════
'use strict';

const PREFIX = 'pf_usage:';
const KEEP_S = 40 * 24 * 60 * 60;        // each day's hash is kept 40 days
const NONE = '(none)';
const expired = new Set();               // day keys this instance already set an expiry on

const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);   // UTC date

// Fire-and-forget: never awaited by the request, never throws.
function record(redis, kind, entry) {
  if (!redis || !redis.hincrby) return;
  const key = PREFIX + dayOf();
  try {
    Promise.resolve(redis.hincrby(key, kind + '|' + (entry || NONE), 1)).catch(() => {});
    if (!expired.has(key) && redis.expire) {
      expired.add(key);
      Promise.resolve(redis.expire(key, KEEP_S)).catch(() => {});
    }
  } catch (_) {}
}

// Provider family of an entry name: "groq-2/openai/gpt-oss-120b" → "groq",
// "nvidia/nvidia/nemotron-3-ultra-550b-a55b" → "nvidia", "cloudflare" → "cloudflare".
function familyOf(entry) {
  return String(entry).split('/')[0].replace(/-\d+$/, '');
}

// Last `days` UTC days, newest first. Each day: per-entry counts for chunks and chat requests,
// totals per provider family, and how many chunks fell to the Cloudflare safety net.
async function getUsage(redis, days = 7) {
  if (!redis || !redis.hgetall) return { ok: false, error: 'Upstash not configured' };
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = dayOf(Date.now() - i * 86400000);
    let h = null;
    try { h = await redis.hgetall(PREFIX + date); } catch (_) {}
    const chunks = {}, chat = {}, chunksByProvider = {};
    let totalChunks = 0, totalChat = 0;
    for (const [field, v] of Object.entries(h || {})) {
      const count = Number(v) || 0;
      const bar = field.indexOf('|');
      const kind = field.slice(0, bar), entry = field.slice(bar + 1);
      if (kind === 'chunk') {
        chunks[entry] = count; totalChunks += count;
        const fam = entry === NONE ? NONE : familyOf(entry);
        chunksByProvider[fam] = (chunksByProvider[fam] || 0) + count;
      } else if (kind === 'chat') {
        chat[entry] = count; totalChat += count;
      }
    }
    const cf = chunksByProvider.cloudflare || 0;
    out.push({
      date, totalChunks, totalChat, chunks, chunksByProvider, chat,
      cloudflareChunks: cf,
      cloudflareShare: totalChunks ? Math.round((cf / totalChunks) * 1000) / 10 : 0,   // percent
    });
  }
  return { ok: true, timezone: 'UTC', days: out };
}

module.exports = { record, getUsage, dayOf, familyOf, PREFIX, NONE };
