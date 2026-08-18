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
let requestCounter = 0; // writing-chain rotation: spreads per-minute load across providers

// ── PROVIDER HEALTH TRACKER ──
// In-memory only — resets on cold start. Any failure (error, 429, empty) = 60s cooldown.
const providerHealth = {};
function isHealthy(name) {
  const h = providerHealth[name];
  if (!h) return true;
  return (Date.now() - h.failedAt) > h.cooldownMs;
}
function markUnhealthy(name) {
  providerHealth[name] = { failedAt: Date.now(), cooldownMs: 60000 };
  console.log(`[ParaFree] Provider ${name} marked unhealthy (60s cooldown)`);
}

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

// ── FETCH WITH TIMEOUT ──
// Wraps fetch with an AbortController so a hanging provider fails in 4s,
// leaving the remaining Vercel budget for fallbacks (10s Vercel Hobby limit).
function fetchWithTimeout(url, options, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

// ── ADMIN PASSWORD ──
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

// ── API CALLERS ──
async function callGroq(text, prompt, key) {
  console.log("[ParaFree] Trying: groq");
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
  console.log("[ParaFree] Trying: gemini");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + key;
  const res = await fetchWithTimeout(url, {
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
  console.log("[ParaFree] Trying: cerebras");
  const res = await fetchWithTimeout("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch(_) {}
    throw new Error("Cerebras:" + res.status + " " + errBody.slice(0, 100));
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Cerebras: no response");
  return data.choices[0].message.content;
}

async function callOpenRouter(text, prompt, key) {
  console.log("[ParaFree] Trying: openrouter");
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.3-70b-instruct:free",
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

async function callOpenRouterModel(text, prompt, key, model) {
  console.log("[ParaFree] Trying: openrouter/" + model);
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "HTTP-Referer": "https://parafree.app", "X-Title": "ParaFree" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 4096 })
  });
  if (!res.ok) throw new Error("OpenRouter/" + model + ":" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("OpenRouter/" + model + ": no response");
  return data.choices[0].message.content;
}

async function callGroqModel(text, prompt, key, model) {
  console.log("[ParaFree] Trying: groq/" + model);
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n" + text }], temperature: 0.7, max_tokens: 4096 })
  });
  if (!res.ok) throw new Error("Groq/" + model + ":" + res.status);
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Groq/" + model + ": no response");
  return data.choices[0].message.content;
}

async function callMistral(text, prompt, key) {
  console.log("[ParaFree] Trying: mistral");
  const res = await fetchWithTimeout("https://api.mistral.ai/v1/chat/completions", {
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
  console.log("[ParaFree] Trying: cloudflare");
  const res = await fetchWithTimeout(
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

async function callGLM(text, prompt, key) {
  console.log("[ParaFree] Trying: glm");
  const res = await fetchWithTimeout("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "glm-4-flash",
      messages: [
        { role: "system", content: prompt },
        { role: "user",   content: text }
      ],
      max_tokens: 4000,
      temperature: 0.7
    })
  });
  if (!res.ok) throw new Error("GLM:" + res.status);
  const data = await res.json();
  const result = data.choices?.[0]?.message?.content;
  if (!result) throw new Error("GLM: empty response");
  return result;
}

async function callExtra(text, prompt, key, label) {
  console.log("[ParaFree] Trying:", label);
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "HTTP-Referer": "https://parafree.app",
      "X-Title": "ParaFree"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.3-70b-instruct:free",
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

async function callSambaNova(text, prompt, key) {
  console.log("[ParaFree] Trying: sambanova");
  const res = await fetchWithTimeout("https://api.sambanova.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "Meta-Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("SambaNova:" + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("SambaNova: no response");
  return data.choices[0].message.content;
}

async function callNvidia(text, prompt, key) {
  console.log("[ParaFree] Trying: nvidia");
  const res = await fetchWithTimeout("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "meta/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048,
      stream: false
    })
  });
  if (!res.ok) throw new Error("NVIDIA:" + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("NVIDIA: no response");
  return data.choices[0].message.content;
}

async function callOVHcloud(text, prompt) {
  console.log("[ParaFree] Trying: ovhcloud");
  const res = await fetchWithTimeout("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "Meta-Llama-3_3-70B-Instruct",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("OVHcloud:" + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("OVHcloud: no response");
  return data.choices[0].message.content;
}

async function callDeepSeek(text, prompt, key) {
  console.log("[ParaFree] Trying: deepseek");
  const res = await fetchWithTimeout("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt + "\n\n" + text }],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error("DeepSeek:" + res.status);
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("DeepSeek: no response");
  return data.choices[0].message.content;
}

// ── PROMPTS ──
const PROMPTS = {
  paraphrase:   `You are paraphrasing a document.\n\nSTRICT RULES:\n1. Return EXACTLY the same number of paragraphs as the input\n2. Each output paragraph corresponds to the same input paragraph\n3. Keep paragraph order identical\n4. Use plain text only - NO markdown\n5. No ** bold markers. No ## heading markers. No * bullet markers.\n6. Keep ALL of these UNCHANGED: names, numbers, dates, technical terms, addresses, passport numbers, amounts, university names, company names, country names\n7. Only rephrase the sentence structure and word choice\n8. Do NOT ask questions. Do NOT request more information. Do NOT add commentary.\n9. Do NOT write any preamble, header, or language instruction (e.g. never write "Respond in English", "Here is the paraphrase", "Sure!", etc.). Start your response DIRECTLY with the first paraphrased paragraph.\n\nOutput must have same paragraph count as input. This is critical.\n\nText to paraphrase:`,
  standard:     `You are paraphrasing a document.\n\nSTRICT RULES:\n1. Return EXACTLY the same number of paragraphs as the input\n2. Each output paragraph corresponds to the same input paragraph\n3. Keep paragraph order identical\n4. Use plain text only - NO markdown\n5. No ** bold markers. No ## heading markers. No * bullet markers.\n6. Keep ALL of these UNCHANGED: names, numbers, dates, technical terms, addresses, passport numbers, amounts, university names, company names, country names\n7. Only rephrase the sentence structure and word choice\n8. Do NOT ask questions. Do NOT request more information. Do NOT add commentary.\n9. Do NOT write any preamble, header, or language instruction (e.g. never write "Respond in English", "Here is the paraphrase", "Sure!", etc.). Start your response DIRECTLY with the first paraphrased paragraph.\n\nOutput must have same paragraph count as input. This is critical.\n\nText to paraphrase:`,
  fluency:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE for fluency: improve flow and readability\n\nNow rewrite the following text to improve fluency and natural flow, following ALL rules above exactly:`,
  creative:     `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. PARAPHRASE creatively with vivid engaging language\n\nNow paraphrase the following text in a creative and engaging way, following ALL rules above exactly:`,
  formal:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE in formal professional academic tone\n\nNow rewrite the following text in a formal professional tone, following ALL rules above exactly:`,
  simple:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. SIMPLIFY using simple words and short sentences\n\nNow simplify the following text using simple words and short sentences, following ALL rules above exactly:`,
  natural:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound natural and human-written, avoid AI patterns\n\nNow rewrite the following AI-generated text to sound completely natural and human-written, following ALL rules above exactly:`,
  student:      `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound like a university student\n\nNow rewrite the following text to sound like a real university student wrote it, following ALL rules above exactly:`,
  professional: `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE to sound like an experienced professional\n\nNow rewrite the following text to sound like an experienced professional wrote it, following ALL rules above exactly:`,
  casual:       `You are a professional paraphrasing assistant.\n\nCRITICAL RULES:\n1. OUTPUT: Plain text ONLY. Zero markdown. No #, **, *, __, backticks, ---, === ever.\n2. HEADINGS: Use [H1]text[/H1], [H2]text[/H2], [H3]text[/H3]\n3. BOLD TEXT: Use [BOLD]text[/BOLD]\n4. BULLETS: Use only the • symbol\n5. TABLES: Use [TABLE]\\nHeader1 | Header2\\nVal1 | Val2\\n[/TABLE]\n6. PRESERVE: names, dates, numbers, addresses, amounts, proper nouns — do not change these\n7. REWRITE in casual conversational tone with contractions\n\nNow rewrite the following text in a casual conversational tone, following ALL rules above exactly:`,
  summarize:    "Summarize the following text. Your summary MUST be significantly shorter than the input — maximum 30% of the original word count. Use concise bullet points for the key ideas, then one short conclusion sentence. Be brief and to the point. Never exceed 30% of input word count. Return only the summary, nothing else:",
  grammar:      "Check and correct the following text for grammar, spelling, and punctuation errors.\n\nRespond in this exact format:\nCORRECTED TEXT:\n[Write the fully corrected text here]\n\nERRORS FOUND:\n[List each error: Original → Corrected (reason)]\n\nIf no errors found write: No errors found! Your text looks great.\n\nText to check:",
  cv_build:     "You are a professional resume writer. Read the instructions below carefully and follow them exactly. Output ONLY what is requested — no labels, no preamble, no markdown, no extra commentary:",
  cv_extract:   `Extract all information from the CV text below and return ONLY a valid JSON object. No text before or after. No markdown. No code blocks. Just the raw JSON.

JSON structure to populate (use empty string or empty array when data is not found):
{"name":"","title":"","email":"","phone":"","location":"","linkedin":"","summary":"","skills":"skill1, skill2","certifications":"","volunteer":"","awards":"","experience":[{"title":"","company":"","startDate":"","endDate":"","bullets":["achievement"]}],"education":[{"degree":"","school":"","startYear":"","endYear":""}],"languages":[{"language":"","level":"Native/Fluent/Professional/Intermediate/Basic"}],"projects":[{"name":"","duration":"","url":"","description":""}]}

CV Text:`,
  cover_letter: "You are a professional resume writer. Write a tailored cover letter based on the candidate information and job description below. Keep it to 3-4 paragraphs. Do not use generic openers like 'I am writing to express my interest' or clichés like 'proven track record' or 'passionate about'. Ground every sentence in the candidate's actual background and the specific role. Confident, natural tone. Return only the cover letter text, nothing else:",
  code_assistant: `Your creator and developer is Pritom. If asked who made you — answer: Pritom.

You are ParaFree AI — a smart, helpful AI assistant like Claude and ChatGPT.

PERSONALITY:
- Natural, warm and conversational
- Confident but never arrogant
- Direct — give answers, not descriptions
- Match user's tone (casual = casual, technical = technical)
- Use emojis naturally, not excessively

RESPONSE QUALITY RULES:
1. Always give COMPLETE answers. Never say "I cannot" or "I don't have access" — always try to help.

2. For factual questions: Give clear, accurate, well-structured answers with examples where helpful.

3. For creative requests: Be imaginative and thorough.

4. For technical questions: Explain clearly, use analogies, include working examples/code.

5. For opinions: Give a real perspective, not "it depends".

6. For research/find requests: Provide actual formatted information with real links and details. Never say "let me search" without results.

7. For math/logic: Show step by step working.

8. For language/writing: Match the style requested perfectly.

FORMAT RULES:
- Use **bold** for important points
- Use bullet points for lists
- Use numbered lists for steps
- Use headers for long responses
- Code always in proper code blocks
- Keep paragraphs short (2-3 sentences)
- Add line breaks between sections

WHAT TO NEVER DO:
- Never say "As an AI I cannot..."
- Never refuse reasonable requests
- Never give empty vague answers
- Never ask unnecessary clarifying questions
- Never repeat the question back
- Never say "Great question!"
- Never be robotic or template-like
- Never give half answers

BUILD/CREATE RULES:
- PPT request → return JSON immediately
- Document request → return JSON immediately
- Website/app request → return HTML immediately
- No questions, no outlines, just build it

PPT JSON format:
\`\`\`json
{"type":"presentation","title":"Title","slides":[{"title":"Slide Title","bullets":["Point 1","Point 2","Point 3"]}]}
\`\`\`
Create 6-8 slides minimum. Make content professional and specific.

DOCUMENT JSON format:
\`\`\`json
{"type":"document","title":"Title","content":[{"type":"heading","text":"Section"},{"type":"paragraph","text":"Content here."},{"type":"bullet","text":"Point"}]}
\`\`\`
Create minimum 8-10 content items. Make paragraphs detailed (2-4 sentences each).

WEBSITE/APP: Return ONLY complete HTML in one \`\`\`html code block. Start with <!DOCTYPE html>. Include all CSS and JS. No explanations.

IMPORTANT CONTEXT RULES:
- When user mentions an AI model name (Mistral, GPT, ChatGPT, Claude, Gemini, Groq, Llama, Deepseek): They want to SWITCH to that AI model. Respond: "Switching to [model name] for this conversation." Then continue normally.
- Never interpret AI model names as fonts, topics, tools, or anything else.
- When user says "make it look good" or "improve the design" about a website: Improve the CSS/design of the last HTML you provided. Return new complete improved HTML.
- When user says "preview not fully visible", "can't see it", or similar: Acknowledge and explain they can click the ↗ icon at the top-right of the preview to open it fullscreen.
- When user asks for changes to the last output: Apply the changes and return the full updated version — not just the diff.`,
};

function getPrompt(mode, language) {
  const base = PROMPTS[mode] || PROMPTS.standard;
  if (!language || language === "english") return base;
  const langName = language.charAt(0).toUpperCase() + language.slice(1);
  // Prepend language rule so it reads as an instruction, not as text to paraphrase
  return 'IMPORTANT: Your entire response must be in ' + langName + ' only. Do not include this instruction in your response.\n\n' + base;
}

// ── CHUNKING HELPERS ──
const MAX_CHUNK_PARAS = 20;
const MAX_CHUNK_CHARS = 8000;

function buildChunks(text) {
  const paras = text.split(/\n\n+/).filter(p => p.trim());
  if (paras.length <= MAX_CHUNK_PARAS && text.length <= MAX_CHUNK_CHARS) return [text];
  const chunks = [];
  let cur = [], curLen = 0;
  for (const para of paras) {
    if (cur.length >= MAX_CHUNK_PARAS || (cur.length > 0 && curLen + para.length > MAX_CHUNK_CHARS)) {
      chunks.push(cur.join('\n\n')); cur = []; curLen = 0;
    }
    cur.push(para); curLen += para.length;
  }
  if (cur.length > 0) chunks.push(cur.join('\n\n'));
  return chunks;
}

// Builds the writing provider list with closures bound to the given text.
// Called per-chunk so each chunk gets its own bound calls.
// Priority order: groq → gemini → sambanova → nvidia → mistral → cloudflare → ovhcloud → deepseek → extras
// Cerebras removed (now requires payment method).
// Any provider with a missing key is silently skipped. OVHcloud needs no key.
// Health-unhealthy providers are excluded for their 60s cooldown window.
function buildWritingCandidates(text, prompt, keys) {
  const { DEEPSEEK_KEY, GEMINI_KEY, GROQ_KEY, MISTRAL_KEY, CF_KEY, CF_ACCOUNT,
          OPENROUTER_KEY, GLM_KEY, SAMBANOVA_KEY, NVIDIA_KEY,
          EXTRA1_KEY, EXTRA2_KEY, EXTRA3_KEY, EXTRA4_KEY, EXTRA5_KEY, EXTRA6_KEY } = keys;
  const cfOk = validKey(CF_KEY) && validKey(CF_ACCOUNT);
  const c = [];
  const add = (name, fn, keyOk = true) => {
    if (keyOk && isHealthy(name)) c.push({ name, fn });
  };
  add("groq",       () => callGroq(text, prompt, GROQ_KEY),                          validKey(GROQ_KEY));
  add("gemini",     () => callGemini(text, prompt, GEMINI_KEY),                      validKey(GEMINI_KEY));
  add("sambanova",  () => callSambaNova(text, prompt, SAMBANOVA_KEY),                validKey(SAMBANOVA_KEY));
  add("nvidia",     () => callNvidia(text, prompt, NVIDIA_KEY),                      validKey(NVIDIA_KEY));
  add("mistral",    () => callMistral(text, prompt, MISTRAL_KEY),                    validKey(MISTRAL_KEY));
  add("cloudflare", () => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT),          cfOk);
  add("ovhcloud",   () => callOVHcloud(text, prompt),                                true); // no key needed
  add("deepseek",   () => callDeepSeek(text, prompt, DEEPSEEK_KEY),                 validKey(DEEPSEEK_KEY));
  add("openrouter", () => callOpenRouter(text, prompt, OPENROUTER_KEY),              validKey(OPENROUTER_KEY));
  add("glm",        () => callGLM(text, prompt, GLM_KEY),                            validKey(GLM_KEY));
  add("extra1",     () => callExtra(text, prompt, EXTRA1_KEY, "Extra1"),             validKey(EXTRA1_KEY));
  add("extra2",     () => callExtra(text, prompt, EXTRA2_KEY, "Extra2"),             validKey(EXTRA2_KEY));
  add("extra3",     () => callExtra(text, prompt, EXTRA3_KEY, "Extra3"),             validKey(EXTRA3_KEY));
  add("extra4",     () => callExtra(text, prompt, EXTRA4_KEY, "Extra4"),             validKey(EXTRA4_KEY));
  add("extra5",     () => callExtra(text, prompt, EXTRA5_KEY, "Extra5"),             validKey(EXTRA5_KEY));
  add("extra6",     () => callExtra(text, prompt, EXTRA6_KEY, "Extra6"),             validKey(EXTRA6_KEY));
  return c;
}

// Tries every writing provider for one chunk, starting at startOffset (rotation).
// Returns the result string, or null if every provider failed this chunk.
async function paraphraseChunk(chunkText, prompt, envKeys, startOffset) {
  const candidates = buildWritingCandidates(chunkText, prompt, envKeys);
  if (candidates.length === 0) return null;
  const n = candidates.length;
  const start = startOffset % n;
  const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
  for (const c of rotated) {
    try {
      const result = await c.fn();
      if (result && result.trim().length > 5) {
        console.log(`[ParaFree] ✅ chunk[offset=${start}] done by ${c.name}`);
        return result.trim();
      }
      console.warn(`[ParaFree] ⚠️ chunk ${c.name} empty/short — next`);
      markUnhealthy(c.name);
    } catch (e) {
      const tag = (e.message || "").includes(":429") ? "429" : "err";
      console.log(`[ParaFree] ❌ chunk ${c.name} ${tag} — next`);
      markUnhealthy(c.name);
    }
  }
  return null;
}

// ── MAIN API CHAIN ──
// Writing:  parallel chunks — each chunk starts at a different provider (spread load)
// AI chat:  Gemini → Cerebras → Groq-70b → DeepSeek → Qwen → Mistral → Cloudflare → SambaNova → NVIDIA → Extras
// CV extract: Gemini → Groq-70b → Cerebras → Mistral → Cloudflare
async function runChain(text, prompt, type) {
  const GROQ_KEY       = process.env.GROQ_KEY;
  const GEMINI_KEY     = process.env.GEMINI_KEY;
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
  const GLM_KEY        = process.env.GLM_KEY;
  const MISTRAL_KEY    = process.env.MISTRAL_KEY;
  const CF_KEY         = process.env.CF_KEY;
  const CF_ACCOUNT     = process.env.CF_ACCOUNT;
  const SAMBANOVA_KEY  = process.env.SAMBANOVA_KEY;
  const NVIDIA_KEY     = process.env.NVIDIA_KEY;
  const DEEPSEEK_KEY   = process.env.DEEPSEEK_KEY;
  const EXTRA1_KEY     = process.env.EXTRA1_KEY;
  const EXTRA2_KEY     = process.env.EXTRA2_KEY;
  const EXTRA3_KEY     = process.env.EXTRA3_KEY;
  const EXTRA4_KEY     = process.env.EXTRA4_KEY;
  const EXTRA5_KEY     = process.env.EXTRA5_KEY;
  const EXTRA6_KEY     = process.env.EXTRA6_KEY;

  const isAIChat    = type === "code_assistant" || type === "code_project";
  const isCVExtract = type === "cv_extract";
  const cfOk = validKey(CF_KEY) && validKey(CF_ACCOUNT);

  // ── WRITING PATH: parallel chunks ──
  // Chunks fire simultaneously via Promise.all — total time ≈ ONE chunk's time (~3s),
  // well inside Vercel Hobby's 10s limit. Each chunk tries providers independently
  // starting at a different offset so parallel calls spread across providers.
  if (!isAIChat && !isCVExtract) {
    const envKeys = {
      DEEPSEEK_KEY, GEMINI_KEY, GROQ_KEY, MISTRAL_KEY, CF_KEY, CF_ACCOUNT,
      OPENROUTER_KEY, GLM_KEY, SAMBANOVA_KEY, NVIDIA_KEY,
      EXTRA1_KEY, EXTRA2_KEY, EXTRA3_KEY, EXTRA4_KEY, EXTRA5_KEY, EXTRA6_KEY
    };
    const sampleCandidates = buildWritingCandidates("x", "x", envKeys);
    if (sampleCandidates.length === 0) {
      console.error("[ParaFree] ❌ No valid API keys — check Vercel environment variables");
      return { success: false, error: "no_keys", apiStatuses: {} };
    }
    const chunks = buildChunks(text);
    const baseOffset = requestCounter;
    requestCounter = (requestCounter + Math.max(chunks.length, 1)) % 100000;
    console.log(`[ParaFree] writing: ${chunks.length} chunk(s) × ${sampleCandidates.length} providers — parallel (offsets ${baseOffset}–${baseOffset + chunks.length - 1})`);
    const chunkResults = await Promise.all(
      chunks.map((chunk, i) => paraphraseChunk(chunk, prompt, envKeys, baseOffset + i))
    );
    const failedIdx = chunkResults.findIndex(r => r === null);
    if (failedIdx !== -1) {
      console.error(`[ParaFree] ❌ Chunk ${failedIdx + 1}/${chunks.length} failed all providers`);
      return { success: false, error: "high_demand", apiStatuses: {} };
    }
    console.log(`[ParaFree] ✅ All ${chunks.length} chunk(s) complete`);
    return { success: true, result: chunkResults.join('\n\n'), usedApi: 'parallel-chunks', apiStatuses: {} };
  }

  // ── AI CHAT / CV EXTRACT PATH: sequential with single retry ──
  // Short texts only — no chunking needed. One retry with 2s wait stays inside 10s limit.
  let candidates = [];
  // Helper: add to candidates only if key present and provider healthy
  const addC = (name, fn, keyOk = true) => { if (keyOk && isHealthy(name)) candidates.push({ name, fn }); };

  if (isCVExtract) {
    addC("groq",       () => callGroqModel(text, prompt, GROQ_KEY, "llama-3.1-8b-instant"), validKey(GROQ_KEY));
    addC("gemini",     () => callGemini(text, prompt, GEMINI_KEY),                         validKey(GEMINI_KEY));
    addC("sambanova",  () => callSambaNova(text, prompt, SAMBANOVA_KEY),                   validKey(SAMBANOVA_KEY));
    addC("mistral",    () => callMistral(text, prompt, MISTRAL_KEY),                       validKey(MISTRAL_KEY));
    addC("cloudflare", () => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT),             cfOk);
    addC("ovhcloud",   () => callOVHcloud(text, prompt),                                   true);
  } else {
    // AI chat path — Cerebras removed (requires payment). groq first for speed.
    addC("groq",           () => callGroqModel(text, prompt, GROQ_KEY, "llama-3.1-8b-instant"),                              validKey(GROQ_KEY));
    addC("gemini",         () => callGemini(text, prompt, GEMINI_KEY),                                                     validKey(GEMINI_KEY));
    addC("sambanova",      () => callSambaNova(text, prompt, SAMBANOVA_KEY),                                               validKey(SAMBANOVA_KEY));
    addC("nvidia",         () => callNvidia(text, prompt, NVIDIA_KEY),                                                     validKey(NVIDIA_KEY));
    addC("deepseek-coder", () => callOpenRouterModel(text, prompt, OPENROUTER_KEY, "deepseek/deepseek-coder-v2-instruct:free"), validKey(OPENROUTER_KEY));
    addC("qwen-coder",     () => callOpenRouterModel(text, prompt, OPENROUTER_KEY, "qwen/qwen-2.5-coder-32b-instruct:free"),    validKey(OPENROUTER_KEY));
    addC("mistral",        () => callMistral(text, prompt, MISTRAL_KEY),                                                   validKey(MISTRAL_KEY));
    addC("cloudflare",     () => callCloudflare(text, prompt, CF_KEY, CF_ACCOUNT),                                         cfOk);
    addC("ovhcloud",       () => callOVHcloud(text, prompt),                                                               true);
    addC("deepseek",       () => callDeepSeek(text, prompt, DEEPSEEK_KEY),                                                 validKey(DEEPSEEK_KEY));
    addC("extra1",         () => callExtra(text, prompt, EXTRA1_KEY, "Extra1"),                                            validKey(EXTRA1_KEY));
    addC("extra2",         () => callExtra(text, prompt, EXTRA2_KEY, "Extra2"),                                            validKey(EXTRA2_KEY));
    addC("extra3",         () => callExtra(text, prompt, EXTRA3_KEY, "Extra3"),                                            validKey(EXTRA3_KEY));
    addC("extra4",         () => callExtra(text, prompt, EXTRA4_KEY, "Extra4"),                                            validKey(EXTRA4_KEY));
    addC("extra5",         () => callExtra(text, prompt, EXTRA5_KEY, "Extra5"),                                            validKey(EXTRA5_KEY));
    addC("extra6",         () => callExtra(text, prompt, EXTRA6_KEY, "Extra6"),                                            validKey(EXTRA6_KEY));
  }

  console.log(`[ParaFree] Chain (${isCVExtract ? 'CV' : 'AI'}): ${candidates.map(c => c.name).join(' → ') || 'EMPTY'}`);

  if (candidates.length === 0) {
    console.error("[ParaFree] ❌ No valid API keys found — check Vercel environment variables");
    return { success: false, error: "no_keys", apiStatuses: {} };
  }

  const MAX_RETRIES = 1;
  let lastApiStatuses = {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const apiStatuses = {};
    candidates.forEach(c => { apiStatuses[c.name] = "skipped"; });
    for (const c of candidates) {
      apiStatuses[c.name] = "trying";
      try {
        const result = await c.fn();
        if (result && result.trim().length > 5) {
          console.log(`[ParaFree] ✅ ${c.name}${attempt > 0 ? ' (retry)' : ''}`);
          apiStatuses[c.name] = "success";
          return { success: true, result: result.trim(), usedApi: c.name, apiStatuses };
        }
        console.warn(`[ParaFree] ⚠️ ${c.name} empty/short — next`);
        apiStatuses[c.name] = "failed";
        markUnhealthy(c.name);
      } catch (e) {
        const msg = e.message || "";
        apiStatuses[c.name] = msg.includes(":429") ? "limit" : (msg.includes(":401") || msg.includes(":403")) ? "expired" : msg.includes(":404") ? "model_not_found" : "failed";
        console.log(`[ParaFree] ❌ ${c.name} — ${msg}`);
        markUnhealthy(c.name);
      }
    }
    lastApiStatuses = { ...apiStatuses };
    if (attempt < MAX_RETRIES) {
      console.log(`[ParaFree] All providers failed — waiting 2s before retry`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.error("[ParaFree] ❌ ALL providers exhausted:", JSON.stringify(lastApiStatuses));
  return { success: false, error: "high_demand", apiStatuses: lastApiStatuses };
}

// ── TEST KEYS HANDLER ──
async function handleTestKeys(body) {
  const adminPw = getAdminPassword();
  if (!adminPw || body.adminPassword !== adminPw) {
    return { error: "Unauthorized", status: 401 };
  }

  const testText = "say hi";
  const testPrompt = "Say hi and nothing else:";

  const cfAccount = process.env.CF_ACCOUNT;

  const tests = [
    { name: "groq",       model: "llama-3.1-8b-instant",              key: process.env.GROQ_KEY,       fn: (k) => callGroq(testText, testPrompt, k) },
    { name: "gemini",     model: "gemini-2.5-flash",                  key: process.env.GEMINI_KEY,     fn: (k) => callGemini(testText, testPrompt, k) },
    { name: "sambanova",  model: "Meta-Llama-3.3-70B-Instruct",       key: process.env.SAMBANOVA_KEY,  fn: (k) => callSambaNova(testText, testPrompt, k) },
    { name: "nvidia",     model: "meta/llama-3.3-70b-instruct",       key: process.env.NVIDIA_KEY,     fn: (k) => callNvidia(testText, testPrompt, k) },
    { name: "mistral",    model: "mistral-small-latest",              key: process.env.MISTRAL_KEY,    fn: (k) => callMistral(testText, testPrompt, k) },
    { name: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct",   key: process.env.CF_KEY, account: cfAccount, fn: (k) => callCloudflare(testText, testPrompt, k, cfAccount) },
    { name: "ovhcloud",   model: "Meta-Llama-3_3-70B-Instruct",      key: "no-key-needed",            fn: () => callOVHcloud(testText, testPrompt) },
    { name: "deepseek",   model: "deepseek-chat",                     key: process.env.DEEPSEEK_KEY,   fn: (k) => callDeepSeek(testText, testPrompt, k) },
    { name: "openrouter", model: "llama-3.1-8b-instruct:free",        key: process.env.OPENROUTER_KEY, fn: (k) => callOpenRouter(testText, testPrompt, k) },
    { name: "glm",        model: "glm-4-flash",                       key: process.env.GLM_KEY,        fn: (k) => callGLM(testText, testPrompt, k) },
  ];

  const results = {};

  await Promise.all(tests.map(async (t) => {
    if (!t.key || t.key.length <= 10) {
      results[t.name] = { status: "⚠️ no key", error: "Key not set in Vercel environment variables" };
      return;
    }
    if (t.account !== undefined && (!t.account || t.account.length <= 5)) {
      results[t.name] = { status: "⚠️ no key", error: "CF_ACCOUNT not set — add it to Vercel environment variables" };
      return;
    }
    try {
      const response = await t.fn(t.key);
      if (!response || response.trim().length === 0) {
        results[t.name] = { status: "❌ failed", error: "Empty response" };
      } else {
        results[t.name] = { status: "✅ working", model: t.model, response: response.trim().slice(0, 60) };
      }
    } catch (e) {
      results[t.name] = { status: "❌ failed", error: e.message };
    }
  }));

  return { success: true, results, note: "CF_ACCOUNT " + (cfAccount ? "is set" : "NOT SET — add to Vercel env vars") };
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  // KEYS FOUND — absolute first line so this appears in every Vercel function invocation
  console.log("KEYS FOUND:", {
    groq:       process.env.GROQ_KEY       ? process.env.GROQ_KEY.slice(0, 8)       + "..." : "(not set)",
    gemini:     process.env.GEMINI_KEY     ? process.env.GEMINI_KEY.slice(0, 8)     + "..." : "(not set)",
    sambanova:  process.env.SAMBANOVA_KEY  ? process.env.SAMBANOVA_KEY.slice(0, 8)  + "..." : "(not set)",
    nvidia:     process.env.NVIDIA_KEY     ? process.env.NVIDIA_KEY.slice(0, 8)     + "..." : "(not set)",
    mistral:    process.env.MISTRAL_KEY    ? process.env.MISTRAL_KEY.slice(0, 8)    + "..." : "(not set)",
    cloudflare: process.env.CF_KEY         ? process.env.CF_KEY.slice(0, 8)         + "..." : "(not set)",
    ovhcloud:   "no-key-needed",
    deepseek:   process.env.DEEPSEEK_KEY   ? process.env.DEEPSEEK_KEY.slice(0, 8)   + "..." : "(not set)",
    openrouter: process.env.OPENROUTER_KEY ? process.env.OPENROUTER_KEY.slice(0, 8) + "..." : "(not set)",
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

    // code_assistant/code_project always use their stored prompt — frontend override is ignored
    const isAIChat = type === 'code_assistant' || type === 'code_project';
    const prompt = isAIChat
      ? getPrompt(type, language)
      : (body.prompt && typeof body.prompt === 'string' && body.prompt.trim().length > 0)
        ? body.prompt.trim()
        : getPrompt(mode || type || "standard", language);

    const { success, result, usedApi, error, apiStatuses } = await runChain(text.trim(), prompt, type);

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
      success: false,
      error: "high_demand",
      message: "Our AI is at high demand right now. Please wait 20 seconds and try again — your full document will process.",
      apiStatuses
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
};
