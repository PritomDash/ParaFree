// ═══════════════════════════════════════════════════
// ParaFree — Secure Backend API (process.js)
// Place this file at: api/process.js in your GitHub repo
// Keys stored ONLY in Vercel Environment Variables
// ═══════════════════════════════════════════════════

// ── RATE LIMIT CONSTANTS ──
const HOURLY_LIMIT       = 200;              // 200 requests per hour per IP
const HOURLY_WINDOW      = 60 * 60 * 1000;  // 1 hour
const BURST_LIMIT        = 10;              // max requests within burst window
const BURST_WINDOW       = 5 * 1000;        // 5 seconds
const BURST_BLOCK        = 60 * 60 * 1000;  // block 1 hour on burst
const DUPE_THRESHOLD     = 5;              // same text N times = bot
const DUPE_BLOCK         = 30 * 60 * 1000; // block 30 mins on duplicate spam
const MAX_TEXT_LENGTH    = 50000;

// NOTE: In-memory only — resets on every Vercel cold start.
const rateLimitMap = new Map();
let lastCleanup = Date.now();

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

// ── KEY VALIDATION ──
function validKey(k) {
  return k && k.length > 10;
}

// ── ADMIN PASSWORD ──
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

// ── API CALLERS ──
async function callGroq(text, prompt, key) {
  console.log("Attempting API: Groq");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("Groq:" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Groq: no response");
  return data.choices[0].message.content;
}

async function callGemini(text, prompt, key) {
  console.log("Attempting API: Gemini");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + "\n\n" + text }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    })
  });
  if (!res.ok) throw new Error("Gemini:" + res.status);
  const data = await res.json();
  if (data.error) throw new Error("Gemini:" + data.error.message);
  if (!data.candidates || !data.candidates[0]) throw new Error("Gemini: no response");
  return data.candidates[0].content.parts[0].text;
}

async function callCerebras(text, prompt, key) {
  console.log("Attempting API: Cerebras");
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama3.1-8b",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("Cerebras:" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Cerebras: no response");
  return data.choices[0].message.content;
}

async function callOpenRouter(text, prompt, key) {
  console.log("Attempting API: OpenRouter");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct:free",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (res.status === 401) throw new Error("OpenRouter:401:invalid_key — check OPENROUTER_KEY in Vercel env vars");
  if (!res.ok) throw new Error("OpenRouter:" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("OpenRouter: no response");
  return data.choices[0].message.content;
}

async function callMistral(text, prompt, key) {
  console.log("Attempting API: Mistral");
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("Mistral:" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Mistral: no response");
  return data.choices[0].message.content;
}

async function callCloudflare(text, prompt, key, account) {
  console.log("Attempting API: Cloudflare");
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/run/@cf/meta/llama-3.1-8b-instruct",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt + "\n\n" + text }], max_tokens: 2048 })
    }
  );
  if (!res.ok) throw new Error("Cloudflare:" + res.status);
  const data = await res.json();
  if (!data.success) throw new Error("Cloudflare: " + JSON.stringify(data.errors));
  return data.result.response;
}

async function callExtra(text, prompt, key, label) {
  console.log("Attempting API:", label);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct:free",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error(label + ":" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error(label + ": no response");
  return data.choices[0].message.content;
}

// ── PROMPTS ──
const PROMPTS = {
  standard:     "Paraphrase the following text. Keep the same meaning but use different words and sentence structures. Return only the paraphrased text, nothing else:",
  fluency:      "Rewrite the following text to make it flow naturally and sound fluent. Return only the rewritten text, nothing else:",
  creative:     "Paraphrase the following text in a creative engaging way. Keep the core meaning. Return only the paraphrased text, nothing else:",
  formal:       "Rewrite the following text in formal professional tone. Return only the rewritten text, nothing else:",
  simple:       "Simplify the following text using simple words and short sentences. Return only the simplified text, nothing else:",
  natural:      "Rewrite the following AI-generated text to sound completely natural and human-written. Use varied sentence lengths, natural transitions, avoid AI patterns. Return only the rewritten text, nothing else:",
  student:      "Rewrite the following AI-generated text to sound like a real university student wrote it. Mix formal and informal, vary sentence structure. Return only the rewritten text, nothing else:",
  professional: "Rewrite the following AI-generated text to sound like an experienced professional wrote it. Use confident clear language. Return only the rewritten text, nothing else:",
  casual:       "Rewrite the following AI-generated text in a casual conversational tone. Use everyday language and contractions. Return only the rewritten text, nothing else:",
  summarize:    "Summarize the following text. Your summary MUST be significantly shorter than the input — maximum 30% of the original word count. Use concise bullet points for the key ideas, then one short conclusion sentence. Be brief and to the point. Never exceed 30% of input word count. Return only the summary, nothing else:",
  grammar:      "Check and correct the following text for grammar, spelling, and punctuation errors.\n\nRespond in this exact format:\nCORRECTED TEXT:\n[Write the fully corrected text here]\n\nERRORS FOUND:\n[List each error: Original → Corrected (reason)]\n\nIf no errors found write: No errors found! Your text looks great.\n\nText to check:",
  cv_build:     "You are a professional resume writer. Read the instructions below carefully and follow them exactly. Output ONLY what is requested — no labels, no preamble, no markdown, no extra commentary:",
  cover_letter: "You are a professional resume writer. Write a tailored cover letter based on the candidate information and job description below. Keep it to 3-4 paragraphs. Do not use generic openers like 'I am writing to express my interest' or clichés like 'proven track record' or 'passionate about'. Ground every sentence in the candidate's actual background and the specific role. Confident, natural tone. Return only the cover letter text, nothing else:",
};

function getPrompt(mode, language) {
  const base = PROMPTS[mode] || PROMPTS.standard;
  if (!language || language === "english") return base;
  const langName = language.charAt(0).toUpperCase() + language.slice(1);
  return base + " Respond in " + langName + ".";
}

// ── MAIN API CHAIN ──
// Order is STRICT: Groq → Gemini → Cerebras → OpenRouter → Mistral → Cloudflare → Extra1-6
async function runChain(text, prompt) {
  const GROQ_KEY       = process.env.GROQ_KEY;
  const GEMINI_KEY     = process.env.GEMINI_KEY;
  const CEREBRAS_KEY   = process.env.CEREBRAS_KEY;
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
  const MISTRAL_KEY    = process.env.MISTRAL_KEY;
  const CF_KEY         = process.env.CF_KEY;
  const CF_ACCOUNT     = process.env.CF_ACCOUNT;
  const EXTRA1_KEY     = process.env.EXTRA1_KEY;
  const EXTRA2_KEY     = process.env.EXTRA2_KEY;
  const EXTRA3_KEY     = process.env.EXTRA3_KEY;
  const EXTRA4_KEY     = process.env.EXTRA4_KEY;
  const EXTRA5_KEY     = process.env.EXTRA5_KEY;
  const EXTRA6_KEY     = process.env.EXTRA6_KEY;

  // Ordered candidates — Groq MUST be first
  const candidates = [
    { name: "groq",       key: GROQ_KEY,       fn: () => callGroq(text, prompt, GROQ_KEY) },
    { name: "gemini",     key: GEMINI_KEY,      fn: () => callGemini(text, prompt, GEMINI_KEY) },
    { name: "cerebras",   key: CEREBRAS_KEY,    fn: () => callCerebras(text, prompt, CEREBRAS_KEY) },
    { name: "openrouter", key: OPENROUTER_KEY,  fn: () => callOpenRouter(text, prompt, OPENROUTER_KEY) },
    { name: "mistral",    key: MISTRAL_KEY,     fn: () => callMistral(text, prompt, MISTRAL_KEY) },
    { name: "cloudflare", key: CF_KEY,          fn: () => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT), extra: CF_ACCOUNT },
    { name: "extra1",     key: EXTRA1_KEY,      fn: () => callExtra(text, prompt, EXTRA1_KEY, "Extra1") },
    { name: "extra2",     key: EXTRA2_KEY,      fn: () => callExtra(text, prompt, EXTRA2_KEY, "Extra2") },
    { name: "extra3",     key: EXTRA3_KEY,      fn: () => callExtra(text, prompt, EXTRA3_KEY, "Extra3") },
    { name: "extra4",     key: EXTRA4_KEY,      fn: () => callExtra(text, prompt, EXTRA4_KEY, "Extra4") },
    { name: "extra5",     key: EXTRA5_KEY,      fn: () => callExtra(text, prompt, EXTRA5_KEY, "Extra5") },
    { name: "extra6",     key: EXTRA6_KEY,      fn: () => callExtra(text, prompt, EXTRA6_KEY, "Extra6") },
  ];

  // All start as skipped; updated as each candidate is tried
  const apiStatuses = {};
  candidates.forEach(c => { apiStatuses[c.name] = "skipped"; });

  let anyKeyFound = false;

  for (const c of candidates) {
    const keyOk  = c.key && c.key.length > 10;
    const extraOk = c.extra !== undefined ? (c.extra && c.extra.length > 10) : true;

    if (!keyOk || !extraOk) {
      console.log("Skipping", c.name, "- key missing or empty");
      // already "skipped" in apiStatuses
      continue;
    }

    anyKeyFound = true;

    try {
      const result = await c.fn();
      if (result && result.trim().length > 10) {
        console.log("[ParaFree] Success:", c.name);
        apiStatuses[c.name] = "success";
        return { success: true, result: result.trim(), usedApi: c.name, apiStatuses };
      }
      console.warn("[ParaFree]", c.name, "returned empty/short result — trying next");
      apiStatuses[c.name] = "failed";
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes(":401") || msg.includes(":403")) {
        apiStatuses[c.name] = "expired";
      } else if (msg.includes(":429")) {
        apiStatuses[c.name] = "limit";
      } else {
        apiStatuses[c.name] = "failed";
      }
      console.warn("[ParaFree]", c.name, "failed:", msg, "— trying next");
    }
  }

  if (!anyKeyFound) {
    console.error("[ParaFree] No valid API keys found — check Vercel environment variables");
    return { success: false, error: "No API keys configured", apiStatuses };
  }

  return { success: false, error: "All APIs failed", apiStatuses };
}

// ── TEST KEYS HANDLER ──
async function handleTestKeys(body) {
  const adminPw = getAdminPassword();
  if (!adminPw || body.adminPassword !== adminPw) {
    return { error: "Unauthorized", status: 401 };
  }

  const testText = "say hi";
  const testPrompt = "Say hi and nothing else:";

  const tests = [
    {
      name: "groq",
      model: "llama-3.1-8b-instant",
      key: process.env.GROQ_KEY,
      fn: (k) => callGroq(testText, testPrompt, k),
    },
    {
      name: "gemini",
      model: "gemini-2.0-flash",
      key: process.env.GEMINI_KEY,
      fn: (k) => callGemini(testText, testPrompt, k),
    },
    {
      name: "cerebras",
      model: "llama3.1-8b",
      key: process.env.CEREBRAS_KEY,
      fn: (k) => callCerebras(testText, testPrompt, k),
    },
    {
      name: "openrouter",
      model: "llama-3.1-8b-instruct:free",
      key: process.env.OPENROUTER_KEY,
      fn: (k) => callOpenRouter(testText, testPrompt, k),
    },
    {
      name: "mistral",
      model: "mistral-small-latest",
      key: process.env.MISTRAL_KEY,
      fn: (k) => callMistral(testText, testPrompt, k),
    },
    {
      name: "cloudflare",
      model: "llama-3.1-8b-instruct",
      key: process.env.CF_KEY,
      account: process.env.CF_ACCOUNT,
      fn: (k) => callCloudflare(testText, testPrompt, k, process.env.CF_ACCOUNT),
    },
  ];

  const results = {};

  await Promise.all(tests.map(async (t) => {
    const keyMissing = !t.key || t.key.length <= 10;
    const accountMissing = t.account !== undefined && (!t.account || t.account.length <= 5);

    if (keyMissing) {
      results[t.name] = { status: "⚠️ no key", error: "Key not set in Vercel environment variables" };
      return;
    }
    if (accountMissing) {
      results[t.name] = { status: "⚠️ no key", error: "CF_ACCOUNT not set in Vercel environment variables" };
      return;
    }

    try {
      const response = await t.fn(t.key);
      if (!response || response.trim().length === 0) {
        results[t.name] = { status: "❌ failed", error: "Empty response from API" };
      } else {
        results[t.name] = { status: "✅ working", model: t.model };
      }
    } catch (e) {
      results[t.name] = { status: "❌ failed", error: e.message };
    }
  }));

  return { success: true, results };
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  // KEYS FOUND — absolute first line so this appears in every Vercel function invocation
  console.log("KEYS FOUND:", {
    groq:       process.env.GROQ_KEY       ? process.env.GROQ_KEY.slice(0, 8)       + "..." : "(not set)",
    gemini:     process.env.GEMINI_KEY     ? process.env.GEMINI_KEY.slice(0, 8)     + "..." : "(not set)",
    cerebras:   process.env.CEREBRAS_KEY   ? process.env.CEREBRAS_KEY.slice(0, 8)   + "..." : "(not set)",
    openrouter: process.env.OPENROUTER_KEY ? process.env.OPENROUTER_KEY.slice(0, 8) + "..." : "(not set)",
    mistral:    process.env.MISTRAL_KEY    ? process.env.MISTRAL_KEY.slice(0, 8)    + "..." : "(not set)",
  });

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
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

    // Build prompt — use frontend-supplied prompt if provided, otherwise derive from mode
    const prompt = (body.prompt && typeof body.prompt === 'string' && body.prompt.trim().length > 0)
      ? body.prompt.trim()
      : getPrompt(mode || type || "standard", language);

    const { success, result, usedApi, error, apiStatuses } = await runChain(text.trim(), prompt);

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
      error: "All AI engines busy",
      message: "All free AI engines are currently busy. Please try again in a few hours!",
      apiStatuses
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
};
