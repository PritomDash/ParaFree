// ParaFree Secure Backend — Node.js Serverless Function
// Keys stored in Vercel Environment Variables only

const RATE_LIMIT = 15;
const RATE_WINDOW = 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 50000;
const rateLimitMap = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return { count: entry.count, remaining: Math.max(0, RATE_LIMIT - entry.count) };
}

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

async function callGemini(text, prompt, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt + "\n\n" + text }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } })
  });
  if (!res.ok) throw new Error("Gemini:" + res.status);
  const data = await res.json();
  if (data.error) throw new Error("Gemini error: " + data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(text, prompt, key) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 2048 })
  });
  if (!res.ok) throw new Error("Groq:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callCerebras(text, prompt, key) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model: "llama3.1-8b", messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 2048 })
  });
  if (!res.ok) throw new Error("Cerebras:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callOpenRouter(text, prompt, key) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "HTTP-Referer": "https://para-free.vercel.app", "X-Title": "ParaFree" },
    body: JSON.stringify({ model: "meta-llama/llama-3.1-8b-instruct:free", messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 2048 })
  });
  if (!res.ok) throw new Error("OpenRouter:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callMistral(text, prompt, key) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model: "mistral-small-latest", messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 2048 })
  });
  if (!res.ok) throw new Error("Mistral:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callExtra(text, prompt, key) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "HTTP-Referer": "https://para-free.vercel.app", "X-Title": "ParaFree" },
    body: JSON.stringify({ model: "meta-llama/llama-3.1-8b-instruct:free", messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 2048 })
  });
  if (!res.ok) throw new Error("Extra:" + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

const PROMPTS = {
  standard:     "Paraphrase the following text. Keep the same meaning but use different words. Return only the paraphrased text:",
  fluency:      "Rewrite the following text to flow naturally and sound fluent. Return only the rewritten text:",
  creative:     "Paraphrase the following text in a creative engaging way. Return only the paraphrased text:",
  formal:       "Rewrite the following text in formal professional tone. Return only the rewritten text:",
  simple:       "Simplify the following text using simple words. Return only the simplified text:",
  natural:      "Rewrite the following AI-generated text to sound completely natural and human. Vary sentence lengths, use natural transitions. Return only the rewritten text:",
  student:      "Rewrite the following AI-generated text to sound like a university student wrote it. Return only the rewritten text:",
  professional: "Rewrite the following AI-generated text to sound like an experienced professional wrote it. Return only the rewritten text:",
  casual:       "Rewrite the following AI-generated text in casual conversational tone. Return only the rewritten text:",
  summarize:    "Summarize the following text into clear bullet points then a brief conclusion. Return only the summary:",
  grammar:      "Check and fix grammar in the following text. Reply with:\nCORRECTED TEXT:\n[fixed text]\n\nERRORS FOUND:\n[list errors]",
};

function getPrompt(mode, language) {
  const base = PROMPTS[mode] || PROMPTS.standard;
  if (!language || language === "english") return base;
  return base + ` Respond in ${language}.`;
}

async function runChain(text, prompt) {
  const K = getKeys();
  const apis = [
    { name: "groq",       fn: () => callGroq(text, prompt, K.groq),           ok: !!K.groq },
    { name: "gemini",     fn: () => callGemini(text, prompt, K.gemini),       ok: !!K.gemini },
    { name: "cerebras",   fn: () => callCerebras(text, prompt, K.cerebras),   ok: !!K.cerebras },
    { name: "openrouter", fn: () => callOpenRouter(text, prompt, K.openrouter), ok: !!K.openrouter },
    { name: "mistral",    fn: () => callMistral(text, prompt, K.mistral),     ok: !!K.mistral },
    { name: "extra1",     fn: () => callExtra(text, prompt, K.extra1),        ok: !!K.extra1 },
    { name: "extra2",     fn: () => callExtra(text, prompt, K.extra2),        ok: !!K.extra2 },
    { name: "extra3",     fn: () => callExtra(text, prompt, K.extra3),        ok: !!K.extra3 },
    { name: "extra4",     fn: () => callExtra(text, prompt, K.extra4),        ok: !!K.extra4 },
    { name: "extra5",     fn: () => callExtra(text, prompt, K.extra5),        ok: !!K.extra5 },
    { name: "extra6",     fn: () => callExtra(text, prompt, K.extra6),        ok: !!K.extra6 },
  ].filter(a => a.ok);

  for (const api of apis) {
    try {
      const result = await api.fn();
      if (result && result.trim().length > 0) return { success: true, result: result.trim(), usedApi: api.name };
    } catch(e) { console.warn(api.name, "failed:", e.message); }
  }
  return { success: false };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const rate = getRateLimit(ip);
  if (rate.count > RATE_LIMIT) return res.status(429).json({ error: "Rate limit reached. Try again in 1 hour." });

  try {
    const { text, mode, language, type } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });
    if (text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: "Text too long" });

    const prompt = getPrompt(mode || type, language);
    const { success, result, usedApi } = await runChain(text, prompt);

    if (success) return res.status(200).json({ success: true, result, usedApi, remaining: rate.remaining });
    return res.status(503).json({ error: "All AI engines busy", message: "Please try again in a few hours!" });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
};
