// ═══════════════════════════════════════════════════
// ParaFree — Secure Backend API (process.js)
// Place this file at: api/process.js in your GitHub repo
// Keys stored ONLY in Vercel Environment Variables
// ═══════════════════════════════════════════════════

const RATE_LIMIT = 50;
const RATE_WINDOW = 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 50000;
// NOTE: In-memory only — resets on every Vercel cold start.
const rateLimitMap = new Map();

// ── RATE LIMITING ──
function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return { count: entry.count, remaining: Math.max(0, RATE_LIMIT - entry.count) };
}

// ── KEY VALIDATION ──
// A key must be a non-empty string with more than 10 characters to be considered valid.
function validKey(k) {
  return typeof k === 'string' && k.trim().length > 10;
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
      "HTTP-Referer": "https://para-free.vercel.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct:free",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
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
      "HTTP-Referer": "https://para-free.vercel.app",
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
  // Read keys directly from process.env — no intermediate variable that could mask undefined
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
    { name: "Groq",       key: GROQ_KEY,       fn: () => callGroq(text, prompt, GROQ_KEY.trim()) },
    { name: "Gemini",     key: GEMINI_KEY,      fn: () => callGemini(text, prompt, GEMINI_KEY.trim()) },
    { name: "Cerebras",   key: CEREBRAS_KEY,    fn: () => callCerebras(text, prompt, CEREBRAS_KEY.trim()) },
    { name: "OpenRouter", key: OPENROUTER_KEY,  fn: () => callOpenRouter(text, prompt, OPENROUTER_KEY.trim()) },
    { name: "Mistral",    key: MISTRAL_KEY,     fn: () => callMistral(text, prompt, MISTRAL_KEY.trim()) },
    { name: "Cloudflare", key: CF_KEY,          fn: () => callCloudflare(text, prompt, CF_KEY.trim(), CF_ACCOUNT.trim()), extra: CF_ACCOUNT },
    { name: "Extra1",     key: EXTRA1_KEY,      fn: () => callExtra(text, prompt, EXTRA1_KEY.trim(), "Extra1") },
    { name: "Extra2",     key: EXTRA2_KEY,      fn: () => callExtra(text, prompt, EXTRA2_KEY.trim(), "Extra2") },
    { name: "Extra3",     key: EXTRA3_KEY,      fn: () => callExtra(text, prompt, EXTRA3_KEY.trim(), "Extra3") },
    { name: "Extra4",     key: EXTRA4_KEY,      fn: () => callExtra(text, prompt, EXTRA4_KEY.trim(), "Extra4") },
    { name: "Extra5",     key: EXTRA5_KEY,      fn: () => callExtra(text, prompt, EXTRA5_KEY.trim(), "Extra5") },
    { name: "Extra6",     key: EXTRA6_KEY,      fn: () => callExtra(text, prompt, EXTRA6_KEY.trim(), "Extra6") },
  ];

  let anyKeyFound = false;

  for (const c of candidates) {
    // Cloudflare also needs CF_ACCOUNT to be valid
    const keyOk  = validKey(c.key);
    const extraOk = c.extra !== undefined ? validKey(c.extra) : true;

    if (!keyOk || !extraOk) {
      console.log("Skipping", c.name, "- key missing or empty");
      continue;
    }

    anyKeyFound = true;

    try {
      const result = await c.fn();
      if (result && result.trim().length > 10) {
        console.log("[ParaFree] Success:", c.name);
        return { success: true, result: result.trim(), usedApi: c.name };
      }
      console.warn("[ParaFree]", c.name, "returned empty/short result — trying next");
    } catch (e) {
      console.warn("[ParaFree]", c.name, "failed:", e.message, "— trying next");
    }
  }

  if (!anyKeyFound) {
    console.error("[ParaFree] No valid API keys found — check Vercel environment variables");
    return { success: false, error: "No API keys configured" };
  }

  return { success: false, error: "All APIs failed" };
}

// ── ADMIN HANDLER ──
async function handleAdmin(body) {
  const { adminAction, password } = body;
  const adminPw = getAdminPassword();
  if (!adminPw || password !== adminPw) {
    return { error: "Unauthorized", status: 401 };
  }
  if (adminAction === "testKeys") {
    const results = {};
    const testText = "Hello";
    const testPrompt = "Say OK and nothing else:";
    const tests = [
      { name: "groq",       key: process.env.GROQ_KEY,       fn: (k) => callGroq(testText, testPrompt, k) },
      { name: "gemini",     key: process.env.GEMINI_KEY,     fn: (k) => callGemini(testText, testPrompt, k) },
      { name: "cerebras",   key: process.env.CEREBRAS_KEY,   fn: (k) => callCerebras(testText, testPrompt, k) },
      { name: "openrouter", key: process.env.OPENROUTER_KEY, fn: (k) => callOpenRouter(testText, testPrompt, k) },
      { name: "mistral",    key: process.env.MISTRAL_KEY,    fn: (k) => callMistral(testText, testPrompt, k) },
    ];
    await Promise.all(tests.map(async t => {
      if (!validKey(t.key)) { results[t.name] = "no_key"; return; }
      try { await t.fn(t.key.trim()); results[t.name] = "ok"; }
      catch (e) { results[t.name] = "failed: " + e.message; }
    }));
    return { success: true, results };
  }
  return { error: "Unknown action", status: 400 };
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ENV CHECK — log at the very start of every real request so Vercel logs show key state
  console.log("ENV CHECK:", {
    hasGroq:       typeof process.env.GROQ_KEY === 'string' && process.env.GROQ_KEY.trim().length > 10,
    hasGemini:     typeof process.env.GEMINI_KEY === 'string' && process.env.GEMINI_KEY.trim().length > 10,
    hasCerebras:   typeof process.env.CEREBRAS_KEY === 'string' && process.env.CEREBRAS_KEY.trim().length > 10,
    hasOpenRouter: typeof process.env.OPENROUTER_KEY === 'string' && process.env.OPENROUTER_KEY.trim().length > 10,
    hasMistral:    typeof process.env.MISTRAL_KEY === 'string' && process.env.MISTRAL_KEY.trim().length > 10,
    hasCloudflare: typeof process.env.CF_KEY === 'string' && process.env.CF_KEY.trim().length > 10,
    groqKeyLength: process.env.GROQ_KEY ? process.env.GROQ_KEY.length : 0,
  });

  // Get IP
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();

  try {
    const body = req.body;

    // Admin endpoint
    if (body && body.type === "admin") {
      const result = await handleAdmin(body);
      if (result.status) return res.status(result.status).json(result);
      return res.status(200).json(result);
    }

    // Rate limit check
    const rate = getRateLimit(ip);
    if (rate.count > RATE_LIMIT) {
      return res.status(429).json({
        error: "Too many requests",
        message: "Rate limit reached. Please try again in 1 hour."
      });
    }

    // Validate input
    const { text, mode, language, type } = body || {};
    if (!text || typeof text !== "string" || text.trim().length < 5) {
      return res.status(400).json({ error: "No text provided" });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: "Text too long. Max 50,000 characters." });
    }

    // Build prompt — use frontend-supplied prompt if provided, otherwise derive from mode
    const prompt = (body.prompt && typeof body.prompt === 'string' && body.prompt.trim().length > 0)
      ? body.prompt.trim()
      : getPrompt(mode || type || "standard", language);

    const { success, result, usedApi, error } = await runChain(text.trim(), prompt);

    if (success) {
      return res.status(200).json({
        success: true,
        result,
        usedApi,
        remaining: rate.remaining
      });
    }

    return res.status(503).json({
      error: "All AI engines busy",
      message: "All free AI engines are currently busy. Please try again in a few hours!"
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
};
