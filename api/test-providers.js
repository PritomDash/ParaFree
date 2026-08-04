// TEMPORARY DIAGNOSTIC ENDPOINT — DELETE AFTER TESTING
// Hit: https://parafree.app/api/test-providers
// Returns JSON showing which AI providers are working right now.

const TEST_TEXT   = "The cat sat on the mat.";
const TEST_PROMPT = "Paraphrase this sentence in one sentence:";

async function testGroq(key) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: TEST_PROMPT + "\n\n" + TEST_TEXT }],
      temperature: 0.7, max_tokens: 64
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("no choices");
  return data.choices[0].message.content;
}

async function testGemini(key) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: TEST_PROMPT + "\n\n" + TEST_TEXT }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 64 }
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates?.[0]) throw new Error("no candidates");
  return data.candidates[0].content.parts[0].text;
}

async function testCerebras(key) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: TEST_PROMPT + "\n\n" + TEST_TEXT }],
      temperature: 0.7, max_tokens: 64
    })
  });
  if (!res.ok) {
    let body = ""; try { body = await res.text(); } catch(_) {}
    throw new Error("HTTP " + res.status + " " + body.slice(0, 80));
  }
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("no choices");
  return data.choices[0].message.content;
}

async function testMistral(key) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: TEST_PROMPT + "\n\n" + TEST_TEXT }],
      temperature: 0.7, max_tokens: 64
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("no choices");
  return data.choices[0].message.content;
}

async function testOpenRouter(key) {
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
      messages: [{ role: "user", content: TEST_PROMPT + "\n\n" + TEST_TEXT }],
      temperature: 0.7, max_tokens: 64
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("no choices");
  return data.choices[0].message.content;
}

async function testCloudflare(key, account) {
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/run/@cf/meta/llama-3.1-8b-instruct",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ messages: [{ role: "user", content: TEST_PROMPT + "\n\n" + TEST_TEXT }], max_tokens: 64 })
    }
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));
  return data.result.response;
}

async function testGLM(key) {
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "glm-4-flash",
      messages: [{ role: "system", content: TEST_PROMPT }, { role: "user", content: TEST_TEXT }],
      max_tokens: 64, temperature: 0.7
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const result = data.choices?.[0]?.message?.content;
  if (!result) throw new Error("empty response");
  return result;
}

function label(k) {
  if (!k || k.length <= 10) return null;
  return k.slice(0, 6) + "...";
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const GROQ_KEY       = process.env.GROQ_KEY;
  const GEMINI_KEY     = process.env.GEMINI_KEY;
  const CEREBRAS_KEY   = process.env.CEREBRAS_KEY;
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
  const MISTRAL_KEY    = process.env.MISTRAL_KEY;
  const CF_KEY         = process.env.CF_KEY;
  const CF_ACCOUNT     = process.env.CF_ACCOUNT;
  const GLM_KEY        = process.env.GLM_KEY;
  const EXTRA1_KEY     = process.env.EXTRA1_KEY;
  const EXTRA2_KEY     = process.env.EXTRA2_KEY;
  const EXTRA3_KEY     = process.env.EXTRA3_KEY;

  const providers = [
    { name: "Groq (llama-3.3-70b)",        key: GROQ_KEY,       fn: () => testGroq(GROQ_KEY) },
    { name: "Gemini (gemini-2.0-flash)",    key: GEMINI_KEY,     fn: () => testGemini(GEMINI_KEY) },
    { name: "Cerebras (gpt-oss-120b)",      key: CEREBRAS_KEY,   fn: () => testCerebras(CEREBRAS_KEY) },
    { name: "Mistral (mistral-small)",      key: MISTRAL_KEY,    fn: () => testMistral(MISTRAL_KEY) },
    { name: "OpenRouter (llama-3.1-8b)",    key: OPENROUTER_KEY, fn: () => testOpenRouter(OPENROUTER_KEY) },
    { name: "Cloudflare (llama-3.1-8b)",    key: CF_KEY,         account: CF_ACCOUNT, fn: () => testCloudflare(CF_KEY, CF_ACCOUNT) },
    { name: "GLM (glm-4-flash)",            key: GLM_KEY,        fn: () => testGLM(GLM_KEY) },
    { name: "Extra1 (OpenRouter slot)",     key: EXTRA1_KEY,     fn: () => testOpenRouter(EXTRA1_KEY) },
    { name: "Extra2 (OpenRouter slot)",     key: EXTRA2_KEY,     fn: () => testOpenRouter(EXTRA2_KEY) },
    { name: "Extra3 (OpenRouter slot)",     key: EXTRA3_KEY,     fn: () => testOpenRouter(EXTRA3_KEY) },
  ];

  const start = Date.now();
  const results = await Promise.all(providers.map(async (p) => {
    // Key missing
    if (!p.key || p.key.length <= 10) {
      return { provider: p.name, status: "NO_KEY", icon: "🔑", keyPreview: null, ms: 0 };
    }
    // Cloudflare also needs CF_ACCOUNT
    if (p.name.startsWith("Cloudflare") && (!CF_ACCOUNT || CF_ACCOUNT.length <= 5)) {
      return { provider: p.name, status: "NO_KEY", icon: "🔑", note: "CF_ACCOUNT missing", ms: 0 };
    }
    const t0 = Date.now();
    try {
      const response = await p.fn();
      const ms = Date.now() - t0;
      if (!response || response.trim().length < 3) {
        return { provider: p.name, status: "ERROR", icon: "❌", error: "Empty response", ms, keyPreview: label(p.key) };
      }
      return { provider: p.name, status: "WORKING", icon: "✅", ms, preview: response.trim().slice(0, 80), keyPreview: label(p.key) };
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e.message || "";
      const status = msg.includes("429") ? "RATE_LIMITED" : "ERROR";
      const icon   = msg.includes("429") ? "⏳" : "❌";
      return { provider: p.name, status, icon, error: msg.slice(0, 120), ms, keyPreview: label(p.key) };
    }
  }));

  const totalMs = Date.now() - start;
  const working     = results.filter(r => r.status === "WORKING").length;
  const rateLimited = results.filter(r => r.status === "RATE_LIMITED").length;
  const errors      = results.filter(r => r.status === "ERROR").length;
  const noKey       = results.filter(r => r.status === "NO_KEY").length;

  // Pretty text summary for easy reading
  const lines = results.map(r => {
    const pad = r.provider.padEnd(32);
    const ms  = r.ms ? ` (${r.ms}ms)` : "";
    if (r.status === "WORKING")      return `${r.icon} ${pad} WORKING${ms} — "${r.preview}"`;
    if (r.status === "RATE_LIMITED") return `${r.icon} ${pad} RATE LIMITED${ms} — ${r.error}`;
    if (r.status === "NO_KEY")       return `${r.icon} ${pad} NO KEY${r.note ? ' — ' + r.note : ''}`;
    return `${r.icon} ${pad} ERROR${ms} — ${r.error}`;
  });

  return res.status(200).json({
    _note: "DELETE THIS FILE after testing — api/test-providers.js",
    testedAt: new Date().toISOString(),
    totalMs,
    summary: { total: providers.length, working, rateLimited, errors, noKey },
    writingChain: "Cerebras → Gemini → Groq → Mistral → Cloudflare → OpenRouter → GLM → Extras",
    results,
    plainText: lines.join("\n")
  });
};
