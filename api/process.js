// ═══════════════════════════════════════════════════
// ParaFree — Secure Backend API (process.js)
// Place this file at: api/process.js in your GitHub repo
// Keys stored ONLY in Vercel Environment Variables
// ═══════════════════════════════════════════════════

const RATE_LIMIT = 50;
const RATE_WINDOW = 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 50000;
// NOTE: In-memory only — resets on every Vercel cold start.
// For persistent rate limiting across all instances, use Vercel KV or Upstash Redis.
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

// ── LOAD KEYS FROM VERCEL ENV VARS ──
function getKeys() {
  return {
    groq:       process.env.GROQ_KEY       || "",
    gemini:     process.env.GEMINI_KEY     || "",
    cerebras:   process.env.CEREBRAS_KEY   || "",
    openrouter: process.env.OPENROUTER_KEY || "",
    mistral:    process.env.MISTRAL_KEY    || "",
    cloudflare: process.env.CF_KEY         || "",
    cf_account: process.env.CF_ACCOUNT     || "",
    extra1:     process.env.EXTRA1_KEY     || "",
    extra2:     process.env.EXTRA2_KEY     || "",
    extra3:     process.env.EXTRA3_KEY     || "",
    extra4:     process.env.EXTRA4_KEY     || "",
    extra5:     process.env.EXTRA5_KEY     || "",
    extra6:     process.env.EXTRA6_KEY     || "",
  };
}

// ── ADMIN PASSWORD ──
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

// ── API CALLERS ──
async function callGroq(text, prompt, key) {
  console.log("Trying: Groq (llama-3.1-8b-instant)");
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
  console.log("Trying: Gemini (gemini-2.0-flash)");
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
  console.log("Trying: Cerebras (llama3.1-8b)");
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
  console.log("Trying: OpenRouter (llama-3.1-8b-instruct)");
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
  console.log("Trying: Mistral (mistral-small-latest)");
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
  console.log("Trying: Cloudflare (llama-3.1-8b-instruct)");
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

async function callExtra(text, prompt, key) {
  console.log("Trying: Extra (OpenRouter fallback)");
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
  if (!res.ok) throw new Error("Extra:" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Extra: no response");
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
  const K = getKeys();

  // Diagnostic: log which keys are present so Vercel logs show why a fallback happens
  console.log("[ParaFree] Key presence — Groq:", !!K.groq, "| Gemini:", !!K.gemini, "| Cerebras:", !!K.cerebras, "| OpenRouter:", !!K.openrouter, "| Mistral:", !!K.mistral, "| Cloudflare:", !!(K.cloudflare && K.cf_account));

  // Build the ordered list. Groq is ALWAYS first when key is present.
  const apis = [
    { name: "Groq",       fn: () => callGroq(text, prompt, K.groq),                            key: K.groq },
    { name: "Gemini",     fn: () => callGemini(text, prompt, K.gemini),                        key: K.gemini },
    { name: "Cerebras",   fn: () => callCerebras(text, prompt, K.cerebras),                    key: K.cerebras },
    { name: "OpenRouter", fn: () => callOpenRouter(text, prompt, K.openrouter),                key: K.openrouter },
    { name: "Mistral",    fn: () => callMistral(text, prompt, K.mistral),                      key: K.mistral },
    { name: "Cloudflare", fn: () => callCloudflare(text, prompt, K.cloudflare, K.cf_account),  key: K.cloudflare && K.cf_account },
    { name: "Extra1",     fn: () => callExtra(text, prompt, K.extra1),                         key: K.extra1 },
    { name: "Extra2",     fn: () => callExtra(text, prompt, K.extra2),                         key: K.extra2 },
    { name: "Extra3",     fn: () => callExtra(text, prompt, K.extra3),                         key: K.extra3 },
    { name: "Extra4",     fn: () => callExtra(text, prompt, K.extra4),                         key: K.extra4 },
    { name: "Extra5",     fn: () => callExtra(text, prompt, K.extra5),                         key: K.extra5 },
    { name: "Extra6",     fn: () => callExtra(text, prompt, K.extra6),                         key: K.extra6 },
  ].filter(a => !!a.key);

  if (apis.length === 0) {
    console.error("[ParaFree] No API keys configured — all keys missing or empty");
    return { success: false, error: "No API keys configured" };
  }

  console.log("[ParaFree] Attempt order:", apis.map(a => a.name).join(" → "));

  for (const api of apis) {
    try {
      const result = await api.fn();
      if (result && result.trim().length > 10) {
        console.log("[ParaFree] Success:", api.name);
        return { success: true, result: result.trim(), usedApi: api.name };
      }
      console.warn("[ParaFree]", api.name, "returned empty/short result — trying next");
    } catch (e) {
      console.warn("[ParaFree]", api.name, "failed:", e.message, "— trying next");
    }
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
    const K = getKeys();
    const results = {};
    const testText = "Hello";
    const testPrompt = "Say OK and nothing else:";
    const tests = [
      { name: "groq",       fn: () => callGroq(testText, testPrompt, K.groq),       enabled: !!K.groq },
      { name: "gemini",     fn: () => callGemini(testText, testPrompt, K.gemini),   enabled: !!K.gemini },
      { name: "cerebras",   fn: () => callCerebras(testText, testPrompt, K.cerebras), enabled: !!K.cerebras },
      { name: "openrouter", fn: () => callOpenRouter(testText, testPrompt, K.openrouter), enabled: !!K.openrouter },
      { name: "mistral",    fn: () => callMistral(testText, testPrompt, K.mistral), enabled: !!K.mistral },
    ];
    await Promise.all(tests.map(async t => {
      if (!t.enabled) { results[t.name] = "no_key"; return; }
      try { await t.fn(); results[t.name] = "ok"; }
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
