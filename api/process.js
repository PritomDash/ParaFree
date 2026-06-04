// ═══════════════════════════════════════════════════════
// ParaFree — Secure Backend API
// All API keys stored in Vercel Environment Variables
// Never exposed to browser or public
// ═══════════════════════════════════════════════════════

// ── RATE LIMITING (in-memory per serverless instance) ──
const rateLimitMap = new Map();
const RATE_LIMIT = 15;        // max requests per IP
const RATE_WINDOW = 60 * 60 * 1000; // per hour (ms)
const MAX_TEXT_LENGTH = 50000; // max 50k characters input

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return { count: entry.count, limit: RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - entry.count) };
}

// ── API KEY LOADER (from Vercel env vars) ──
function getKeys() {
  return {
    gemini:     process.env.GEMINI_KEY     || "",
    groq:       process.env.GROQ_KEY       || "",
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

// ── ADMIN PASSWORD (from Vercel env vars) ──
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || "Pritom994338";
}

// ── API CALLERS ──
async function callGemini(text, prompt, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-latest:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + "\n\n" + text }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
    })
  });
  if (!res.ok) throw new Error("Gemini:" + res.status);
  const data = await res.json();
  if (data.error) throw new Error("Gemini error");
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(text, prompt, key) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7, max_tokens: 4096
    })
  });
  if (!res.ok) throw new Error("Groq:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callCerebras(text, prompt, key) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama3.1-8b",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7, max_tokens: 4096
    })
  });
  if (!res.ok) throw new Error("Cerebras:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callOpenRouter(text, prompt, key) {
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
      temperature: 0.7, max_tokens: 4096
    })
  });
  if (!res.ok) throw new Error("OpenRouter:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callMistral(text, prompt, key) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7, max_tokens: 4096
    })
  });
  if (!res.ok) throw new Error("Mistral:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callCloudflare(text, prompt, key, account) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt + "\n\n" + text }], max_tokens: 4096 })
    }
  );
  if (!res.ok) throw new Error("Cloudflare:" + res.status);
  const data = await res.json();
  if (!data.success) throw new Error("Cloudflare error");
  return data.result.response;
}

async function callExtra(text, prompt, key) {
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
      temperature: 0.7, max_tokens: 4096
    })
  });
  if (!res.ok) throw new Error("Extra:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── PROMPTS ──
const PROMPTS = {
  standard:     "Paraphrase the following text. Keep the same meaning but use different words and sentence structures. Return only the paraphrased text, nothing else:",
  fluency:      "Rewrite the following text to make it flow naturally and sound more fluent and easy to read. Return only the rewritten text, nothing else:",
  creative:     "Paraphrase the following text in a creative and engaging way while keeping the original meaning. Return only the paraphrased text, nothing else:",
  formal:       "Rewrite the following text in a formal, professional tone suitable for academic or business use. Return only the rewritten text, nothing else:",
  simple:       "Simplify the following text so it is easy to understand for anyone. Use simple words and short sentences. Return only the simplified text, nothing else:",
  natural:      "Rewrite the following AI-generated text to sound completely natural and human-written. Use varied sentence lengths, natural transitions, and avoid repetitive AI patterns. Return only the rewritten text, nothing else:",
  student:      "Rewrite the following AI-generated text to sound like it was written by a university student. Use a mix of formal and informal language, vary sentence structure. Return only the rewritten text, nothing else:",
  professional: "Rewrite the following AI-generated text to sound like it was written by an experienced professional. Use confident, clear language. Return only the rewritten text, nothing else:",
  casual:       "Rewrite the following AI-generated text in a casual, conversational human tone. Use everyday language and contractions. Return only the rewritten text, nothing else:",
  summarize:    "Summarize the following text into a clear, concise summary. Keep all key points. Use bullet points for main ideas followed by a brief paragraph conclusion. Return only the summary, nothing else:",
  grammar:      "You are a grammar checker. Check the following text for grammar, spelling, punctuation, and style errors. Format your response as:\n\nCORRECTED TEXT:\n[Write the fully corrected text here]\n\nERRORS FOUND:\n[List each error found with: 'Original: ... → Corrected: ... (Reason)']\n\nIf no errors found, write 'No errors found! Your text looks great.'\n\nText to check:",
};

function getPrompt(mode, language) {
  const base = PROMPTS[mode] || PROMPTS.standard;
  if (!language || language === "english") return base;
  return base + ` Write the response in ${language.charAt(0).toUpperCase() + language.slice(1)}.`;
}

// ── MAIN API CHAIN RUNNER ──
async function runChain(text, prompt) {
  const KEYS = getKeys();
  const apis = [
    { name: "mistral",    fn: () => callMistral(text, prompt, KEYS.mistral),                         enabled: !!KEYS.mistral },
    { name: "cloudflare", fn: () => callCloudflare(text, prompt, KEYS.cloudflare, KEYS.cf_account),  enabled: !!(KEYS.cloudflare && KEYS.cf_account) },
    { name: "gemini",     fn: () => callGemini(text, prompt, KEYS.gemini),                           enabled: !!KEYS.gemini },
    { name: "groq",       fn: () => callGroq(text, prompt, KEYS.groq),                               enabled: !!KEYS.groq },
    { name: "cerebras",   fn: () => callCerebras(text, prompt, KEYS.cerebras),                       enabled: !!KEYS.cerebras },
    { name: "openrouter", fn: () => callOpenRouter(text, prompt, KEYS.openrouter),                   enabled: !!KEYS.openrouter },
    { name: "extra1",     fn: () => callExtra(text, prompt, KEYS.extra1),                            enabled: !!KEYS.extra1 },
    { name: "extra2",     fn: () => callExtra(text, prompt, KEYS.extra2),                            enabled: !!KEYS.extra2 },
    { name: "extra3",     fn: () => callExtra(text, prompt, KEYS.extra3),                            enabled: !!KEYS.extra3 },
    { name: "extra4",     fn: () => callExtra(text, prompt, KEYS.extra4),                            enabled: !!KEYS.extra4 },
    { name: "extra5",     fn: () => callExtra(text, prompt, KEYS.extra5),                            enabled: !!KEYS.extra5 },
    { name: "extra6",     fn: () => callExtra(text, prompt, KEYS.extra6),                            enabled: !!KEYS.extra6 },
  ].filter(a => a.enabled);

  for (const api of apis) {
    try {
      const result = await api.fn();
      if (result && result.trim().length > 0) {
        return { success: true, result: result.trim(), usedApi: api.name };
      }
    } catch(e) {
      console.warn(api.name, "failed:", e.message);
    }
  }
  return { success: false, result: null, usedApi: null };
}

// ── ADMIN HANDLER ──
async function handleAdmin(body) {
  const { adminAction, password } = body;
  if (password !== getAdminPassword()) {
    return { error: "Wrong password", status: 401 };
  }

  if (adminAction === "getKeys") {
    const KEYS = getKeys();
    // Return masked keys for display
    const masked = {};
    Object.entries(KEYS).forEach(([k, v]) => {
      masked[k] = v ? v.substring(0, 8) + "..." + v.substring(v.length - 4) : "";
    });
    return { success: true, keys: masked };
  }

  if (adminAction === "testKeys") {
    const KEYS = getKeys();
    const results = {};
    const testPrompt = "Say 'OK' and nothing else.";
    const testText = "test";
    const tests = [
      { name: "gemini",     fn: () => callGemini(testText, testPrompt, KEYS.gemini),    enabled: !!KEYS.gemini },
      { name: "groq",       fn: () => callGroq(testText, testPrompt, KEYS.groq),        enabled: !!KEYS.groq },
      { name: "cerebras",   fn: () => callCerebras(testText, testPrompt, KEYS.cerebras),enabled: !!KEYS.cerebras },
      { name: "openrouter", fn: () => callOpenRouter(testText, testPrompt, KEYS.openrouter), enabled: !!KEYS.openrouter },
      { name: "mistral",    fn: () => callMistral(testText, testPrompt, KEYS.mistral),  enabled: !!KEYS.mistral },
    ];
    await Promise.all(tests.map(async t => {
      if (!t.enabled) { results[t.name] = "no_key"; return; }
      try { await t.fn(); results[t.name] = "ok"; }
      catch(e) { results[t.name] = "failed: " + e.message; }
    }));
    return { success: true, results };
  }

  return { error: "Unknown admin action", status: 400 };
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://para-free.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Get real IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

  try {
    const body = req.body;

    // ── ADMIN ENDPOINT ──
    if (body.type === "admin") {
      const result = await handleAdmin(body);
      if (result.status) return res.status(result.status).json(result);
      return res.status(200).json(result);
    }

    // ── RATE LIMITING ──
    const rateCheck = getRateLimit(ip);
    if (rateCheck.count > RATE_LIMIT) {
      return res.status(429).json({
        error: "Too many requests",
        message: "You have exceeded the rate limit. Please try again in an hour.",
        remaining: 0
      });
    }

    // ── INPUT VALIDATION ──
    const { text, mode, language, type } = body;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "No text provided" });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: "Text too long. Max 50,000 characters." });
    }

    if (!type) {
      return res.status(400).json({ error: "No type specified" });
    }

    // ── PROCESS REQUEST ──
    const prompt = getPrompt(mode || type, language);
    const { success, result, usedApi } = await runChain(text, prompt);

    if (success) {
      return res.status(200).json({
        success: true,
        result,
        usedApi,
        remaining: rateCheck.remaining
      });
    } else {
      return res.status(503).json({
        error: "All AI engines busy",
        message: "All free AI engines have hit their daily limits. Please try again in a few hours!"
      });
    }

  } catch(err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
}
