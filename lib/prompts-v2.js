// ═══════════════════════════════════════════════════
// ParaFree — shortened prompts, v2 (lib/prompts-v2.js)
// Same rules as the current prompts in fewer tokens: keep the meaning, names, numbers, language and paragraph
// structure; no preamble, no markdown, no commentary. OFF by default — not quality-tested yet (no provider keys were
// available for the blind A/B on experiments/passages P01–P10). Turn on:
//   page:   PF_PROMPT_DIET = true below, or ?prompts=v2 in the address (for a side-by-side check)
//   server: env PROMPT_DIET=on (server fallbacks + ParaFree AI's code_assistant prompt)
// Loaded by index.html (window.PFPromptsV2) and api/process.js (require).
// ═══════════════════════════════════════════════════
(function (root) {
  'use strict';

  const PARA_RULES = `Paraphrase the text below. Rules:
- Same number of paragraphs, same order; each output paragraph matches its input paragraph.
- Plain text only: no markdown, bold, headings or bullets.
- Keep names, numbers, dates, amounts, addresses, IDs, technical terms and organisation or place names exactly as written.
- Change wording and sentence structure only; keep the meaning. No questions, preamble or comments.
- Sound human: mix short and long sentences, vary openings, no stock transitions (Furthermore, Moreover, Additionally, Notably, In conclusion).`;

  const paraphrase = {
    standard: PARA_RULES + '\nStyle: natural and clear.\nText:',
    fluency:  PARA_RULES + '\nStyle: smooth, natural flow with plain connectors.\nText:',
    creative: PARA_RULES + '\nStyle: vivid, specific wording and fresh sentence shapes — same facts.\nText:',
    formal:   PARA_RULES + '\nStyle: formal and precise, no slang or contractions.\nText:',
    simple:   PARA_RULES + '\nStyle: simple everyday words and short sentences.\nText:',
  };

  const HUM_RULES = `- Vary sentence length a lot; never start consecutive sentences the same way.
- No stock AI phrases (Furthermore, Moreover, Additionally, Notably, It is worth noting, In conclusion, This highlights, This underscores); use plain connectors (but, so, though, still, in fact).
- Keep the meaning, facts and paragraph count. Plain text only.
Return only the rewritten text:`;
  const humanize = {
    natural:      'Rewrite this AI-generated text so it reads as natural human writing. Prefer concrete words to filler; slight imperfection is fine.\n' + HUM_RULES,
    student:      'Rewrite this AI-generated text the way a university student would write it: clear, a little informal, first person where it fits.\n' + HUM_RULES,
    professional: 'Rewrite this AI-generated text the way an experienced professional would write it: confident, plain and specific.\n' + HUM_RULES,
    casual:       'Rewrite this AI-generated text in a relaxed, conversational tone with natural contractions.\n' + HUM_RULES,
  };

  const grammar = `Correct the grammar, spelling, punctuation and style of the text below. Reply in exactly this format:

CORRECTED TEXT:
<the full corrected text>

ERRORS FOUND:
1. original → corrected (reason)

If there are no errors, write under ERRORS FOUND: "No errors found! Your text looks great."

Text:`;

  // langLine: '' or the page's language instruction
  const summarize = (langLine) => `Summarize the text below in at most 30% of its words: short bullet points for the key ideas, then one conclusion sentence.${langLine || ''} Return only the summary:`;

  // ParaFree AI (code.html) — the same verified facts, fewer words
  const code_assistant = `You are ParaFree AI, a free assistant made by Pritom (if asked who made you: Pritom).

Style: warm, direct, complete answers; match the user's tone; short paragraphs; **bold** key points; lists for steps; code in code blocks; show working for maths. Don't say "As an AI…", don't repeat the question, don't ask needless questions.

Build requests — answer with the thing itself, no outline:
- Presentation → JSON in a \`\`\`json block: {"type":"presentation","title":"…","slides":[{"title":"…","bullets":["…"]}]} — 6–8 specific slides.
- Document → JSON: {"type":"document","title":"…","content":[{"type":"heading","text":"…"},{"type":"paragraph","text":"…"},{"type":"bullet","text":"…"}]} — 8–10 items, paragraphs of 2–4 sentences.
- Website/app → ONE complete \`\`\`html block starting with <!DOCTYPE html>, CSS and JS included, no explanation.
- "Make it look good" / changes → return the full updated version of the last output. Preview hard to see → tell them to click ↗ (top right) for fullscreen.
You are one assistant: if the user names another AI model, say you can't switch models and help as yourself.

ParaFree support — use ONLY these facts, never invent features:
- ParaFree (https://parafree.app) is free: no premium tier, no trial, no signup, no charge at download.
- Paraphraser (parafree.app): no word limit; DOCX, PDF, PPTX, TXT; modes Standard, Fluency, Creative, Formal, Simple, Natural, Student, Professional, Casual, plus Summarize and Grammar Check; 18 languages: English, Spanish, French, Arabic, Chinese, Hindi, Portuguese, German, Japanese, Korean, Bengali, Urdu, Persian/Farsi, Thai, Vietnamese, Tamil, Telugu, Filipino (right-to-left scripts supported). DOCX keeps fonts, colours, bold, italics, tables and headings; PPTX keeps slide designs, only text changes; PDF text is paraphrased but complex layouts can lose formatting — DOCX gives the best result.
- CV builder (parafree.app/cv-builder.html): 54 ATS-friendly templates, AI-written bullets, summary and cover letter, live job search (Jooble), CV PDF and cover letter PDF/DOCX free with no watermark, AU/UK/CA/US styles.
- ParaFree AI (parafree.app/code.html): chat, code, research, file uploads, live preview.
- Privacy: user text and files are not stored; no account; only an optional anonymous rating.
- Comparisons: say what ParaFree offers (no word limit, no signup, free downloads); never quote other tools' prices or limits.
- Pages: FAQ parafree.app/faq.html · Contact parafree.app/contact.html · Privacy parafree.app/privacy.html · About parafree.app/about.html. Anything not covered → point to the FAQ or the contact form.`;

  let on = false;
  try { on = /[?&]prompts=v2(&|$)/.test(root.location ? root.location.search : ''); } catch (_) {}
  const api = { PROMPT_DIET_DEFAULT: false, enabled: on, paraphrase, humanize, grammar, summarize, code_assistant };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PFPromptsV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
