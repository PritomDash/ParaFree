// ═══════════════════════════════════════════════════
// ParaFree — user rating totals (api/_ratings.js)
// Every rating is still stored in the "pf_feedback" list (read by the PIN-gated viewer).
// Real ratings also add to a running total in the "pf_rating" hash (sum + count), so the
// public summary is exact and cheap to read. Only the average and count are ever public —
// comments, tools and timestamps never leave the server.
//
// NOT counted (still stored, marked counted:false):
//  - ratings sent from anywhere except parafree.app (Vercel previews, localhost, scripts)
//  - ratings sent with test:true (the owner's browser, see pf_admin in index.html)
//  - older entries that look like tests (comment/tool says "test", "asdf", …) — backfill only
// ═══════════════════════════════════════════════════
'use strict';

const LIST_KEY = 'pf_feedback';
const TOTAL_KEY = 'pf_rating';
const COUNTED_ORIGINS = ['https://parafree.app', 'https://www.parafree.app'];
const SUMMARY_TTL_MS = 60 * 60 * 1000;   // matches the 1 h CDN cache on the GET endpoint

function isCountedOrigin(origin) {
  return COUNTED_ORIGINS.includes(String(origin || '').replace(/\/+$/, '').toLowerCase());
}

// Old entries have no counted flag — spot obvious test submissions by their text.
const TEST_TEXT = /\b(test(ing)?|asdf|qwerty|ignore|dummy|lorem)\b/i;
function looksLikeTest(entry) {
  return TEST_TEXT.test(String(entry.comment || '')) || TEST_TEXT.test(String(entry.tool || ''));
}

function validRating(r) { return Number.isInteger(r) && r >= 1 && r <= 5; }

// Should this stored entry be in the public totals?
function shouldCount(entry, excludeTs) {
  if (!entry || !validRating(entry.rating)) return false;
  if (excludeTs && excludeTs.has(String(entry.ts))) return false;
  if (entry.counted === false || entry.test === true) return false;
  if (entry.counted === true) return true;
  return !looksLikeTest(entry);   // legacy entry (stored before this file existed)
}

function parseEntry(item) {
  try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (e) { return null; }
}

// Totals for a list of stored entries (used by the backfill script).
function computeTotals(items, excludeTs) {
  let sum = 0, count = 0;
  const excluded = [];
  for (const raw of items) {
    const e = parseEntry(raw);
    if (shouldCount(e, excludeTs)) { sum += e.rating; count++; }
    else if (e) excluded.push(e);
  }
  return { sum, count, excluded };
}

// Store one submitted rating. Returns the entry stored.
async function recordRating(redis, { rating, comment, tool, test, origin }) {
  const counted = !test && isCountedOrigin(origin);
  const entry = {
    rating,
    comment: (comment || '').toString().slice(0, 500),
    tool: (tool || '').toString().slice(0, 50),
    ts: Date.now(),
    counted,
  };
  if (redis) {
    await redis.lpush(LIST_KEY, JSON.stringify(entry));
    if (counted) {
      await redis.hincrby(TOTAL_KEY, 'sum', rating);
      await redis.hincrby(TOTAL_KEY, 'count', 1);
    }
  }
  return entry;
}

// One-time backfill (and safe to re-run): recompute the totals from the whole stored list.
// dryRun reports what would be counted/excluded without writing. excludeTs/includeTs are
// lists of entry timestamps the owner wants forced out of / into the totals.
async function rebuildTotals(redis, { dryRun = true, excludeTs = [], includeTs = [] } = {}) {
  if (!redis) return { ok: false, error: 'no_redis' };
  const items = (await redis.lrange(LIST_KEY, 0, -1)) || [];
  const inc = new Set(includeTs.map(String));
  const entries = items.map(parseEntry).filter(Boolean)
    .map(e => (inc.has(String(e.ts)) ? Object.assign({}, e, { counted: true, test: false }) : e));
  const { sum, count, excluded } = computeTotals(entries, new Set(excludeTs.map(String)));
  if (!dryRun) {
    await redis.hset(TOTAL_KEY, { sum, count });
    memo = null;
  }
  return {
    ok: true, dryRun, stored: entries.length, count, sum,
    average: count ? Math.round((sum / count) * 10) / 10 : null,
    excluded: excluded.map(e => ({ ts: e.ts, rating: e.rating, tool: e.tool || '', comment: String(e.comment || '').slice(0, 80) })),
  };
}

// Public summary: { ok, average, count } only. Memoised per warm instance for 1 h —
// but only when ok:true, so "no totals yet" is re-checked on the next request.
let memo = null;
async function getSummary(redis, now = Date.now()) {
  if (memo && now - memo.at < SUMMARY_TTL_MS) return memo.value;
  let value = { ok: false };
  if (redis) {
    const h = (await redis.hgetall(TOTAL_KEY)) || {};
    const sum = Number(h.sum) || 0, count = Number(h.count) || 0;
    if (count > 0) value = { ok: true, average: Math.round((sum / count) * 10) / 10, count };
  }
  memo = value.ok ? { at: now, value } : null;
  return value;
}
function _resetMemo() { memo = null; }

module.exports = {
  LIST_KEY, TOTAL_KEY, SUMMARY_TTL_MS,
  isCountedOrigin, looksLikeTest, shouldCount, computeTotals, recordRating, rebuildTotals, getSummary, _resetMemo,
};
