#!/usr/bin/env node
'use strict';
// SEO phase 1 (one-off, kept for the record): new <title>/<meta description> for the real query on pages Google
// already ranks (Search Console, 3 months to 2026-11-01), plus a question H2 with a direct 40–60-word answer near
// the top, so the page can be quoted for that question. H1s are not touched. Run: node scripts/seo-phase1.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
// the designed 'How It Works' section on the PowerPoint and PDF pages
const HOW = '<div class="section">\n  <div class="container">\n    <div style="text-align:center;margin-bottom:48px;">\n      <div class="tag">How It Works</div>';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const PAGES = {
  'ai-rephraser.html': {
    title: 'AI Rephraser Free — Rephrase Sentences and Paragraphs',
    desc: 'Rephrase a sentence, a paragraph or a whole document free with AI. Paste text or upload DOCX/PDF, pick a mode and copy the result. No signup.',
    before: '<h2>Rephrase a Single Sentence</h2>',
    blocks: [{ q: 'How do I rephrase a sentence with AI for free?', id: 'how-to-rephrase',
      a: 'Paste the sentence into the box above, choose a mode — Standard keeps your meaning and tone, Formal and Simple change the register — and press Paraphrase. ParaFree rewrites the wording and sentence structure but keeps names, numbers and facts. It is free with no signup, and works for one sentence or a whole document.',
      more: 'For a single sentence, try two or three modes and keep the version that sounds most like you. Always read the result: an AI can shift a nuance, so check that it still says exactly what you meant.' }],
  },
  'paraphrase-powerpoint.html': {
    title: 'Paraphrase PowerPoint Free — Rewrite Slides, Keep Design',
    desc: 'Upload a .pptx and ParaFree rewrites the text on your slides; you download the same deck with its layouts, images and colours. Free, no signup.',
    before: HOW, wrap: true,
    blocks: [{ q: 'How do I paraphrase a PowerPoint without losing the design?', id: 'keep-design',
      a: 'Upload the .pptx file instead of copying the text out. ParaFree reads the text in each slide’s text boxes, paraphrases it and writes the new wording back into the same boxes, so layouts, images, colours and backgrounds stay where they were. Slide titles are left unchanged. Download the edited .pptx and look through every slide before you present.',
      more: 'A rewrite can be a little longer than the original, so check dense slides for text that no longer fits its box and trim it in PowerPoint if needed.' }],
  },
  'paraphrase-pdf.html': {
    title: 'Paraphrase PDF Online Free — Upload a PDF, Get a Rewrite',
    desc: 'Upload a PDF; ParaFree extracts the text (OCR for scanned pages) and paraphrases it with AI. Free, no word limit, no signup. Layout matters? Use Word.',
    before: HOW, wrap: true,
    blocks: [{ q: 'Can I paraphrase a PDF for free?', id: 'paraphrase-pdf-free',
      a: 'Yes. Upload the PDF and ParaFree pulls out its text — scanned pages are read with OCR — then paraphrases it with no word limit and no signup. A PDF’s exact layout can’t be rebuilt, so you get the rewritten text back. If the layout matters, convert the PDF to Word first, paraphrase the .docx, then save it as a PDF again.',
      more: 'The <a href="/pdf-to-word.html">PDF to Word</a> converter and <a href="/word-to-pdf.html">Word to PDF</a> both run in your browser, so the round trip stays free.' }],
  },
  'best-free-paraphrasing-tool.html': {
    // title pinned by an earlier round (tests/seo-push.spec.ts RETITLED) — only the answer block is added
    before: '<h2>Tool-by-Tool Reviews</h2>',
    blocks: [{ q: 'How do I choose a free paraphrasing tool?', id: 'how-to-choose',
      a: 'Test each tool on a paragraph you know well. A good free paraphraser keeps your meaning and facts, sounds natural rather than swapped word by word, handles the file you actually have (Word, PDF or slides), states its limits plainly and lets you try it without an account. Put two or three tools on the same text and read the results closely.',
      more: 'Limits and prices of other tools change often, so this page describes what each is good at rather than quoting numbers — check each tool’s own site before you decide.' }],
  },
  'best-free-cv-builder.html': {
    // title pinned by an earlier round; depth restored after its comparison table was removed (honest, no figures)
    before: '<h2>Tool-by-Tool Breakdown</h2>',
    blocks: [{ q: 'How do I check that a CV builder is really free?', id: 'really-free',
      a: 'Build a short test CV and try to download it before you put in hours of work. A builder is free in practice when the PDF downloads without a payment step, carries no watermark, needs no account and uses a template that an applicant tracking system can read as text. Check that your email and LinkedIn links still work in the PDF.',
      more: 'Plans change, so rather than quoting other builders’ prices this guide describes what to test. For ParaFree: the PDF download is free, with no watermark and no signup.' }],
  },
  'paraphrasing-tool-no-word-limit.html': {
    title: 'Paraphrasing Tool With No Word Limit — Free, No Signup',
    desc: 'Paraphrase essays, reports and whole documents in one go: no word limit, no daily cap, no signup. Paste text or upload a DOCX, PDF or PPTX file.',
    before: '<h2>Why Most Paraphrasing Tools Have Word Limits</h2>',
    blocks: [{ q: 'What is a free paraphrasing tool with no word limit?', id: 'what-is-no-limit',
      a: 'It is a paraphraser that rewrites your whole text in one go instead of stopping after a few hundred words. ParaFree has no word limit and no daily cap: paste a full essay or upload a Word, PDF or PowerPoint file, and it is rewritten in parts behind the scenes and put back together in order. It is free and needs no signup.',
      more: 'Long documents simply take longer — a few thousand words can take a minute or more — so read the result section by section before you use it.' }],
  },
  'free-cv-builder-uk.html': {
    title: 'Free CV Builder UK — Make a UK CV Online, Download PDF',
    desc: 'Make a UK CV free: 54 templates, AI bullet points and a personal statement in the UK CV style. Download the PDF with no watermark. No signup needed.',
    before: '<h2>Top UK Job Search Sites</h2>',
    blocks: [
      { q: 'How long should a UK CV be?', id: 'uk-cv-length',
        a: 'Two A4 pages is the usual length for a UK CV once you have some work experience. Students, school leavers and graduates with little experience are usually better with one full page. Recruiters skim, so put your strongest, most recent experience first and cut anything older or unrelated to the job instead of shrinking the font.',
        more: 'In the builder you choose 1, 2 or 3 pages; “Fit to 1 page” tightens spacing and margins before it ever makes the text smaller.' },
      { q: 'Should a UK CV have a photo, date of birth or full address?', id: 'uk-cv-photo',
        a: 'Usually not. UK employers do not expect a photo, and age is a protected characteristic under the Equality Act 2010, so a date of birth is unnecessary. Your town or city and a postcode area are enough instead of a full address. Leave them out unless a job advert asks for them — acting and modelling roles are the usual exceptions.',
        more: '' },
      { q: 'What is the difference between a CV and a resume in the UK?', id: 'cv-vs-resume',
        a: 'In the UK, “CV” is the normal word for the document you send with a job application — usually one or two pages. “Resume” is the American term for much the same thing. An academic CV is different: it can run much longer because it lists publications, research and teaching.',
        more: 'Most UK CVs open with a personal statement: three to five lines on who you are, your key skills and the kind of role you want. The builder’s AI can draft one from your details — edit it so it sounds like you.' },
    ],
  },
};

// wrap: the page is built from designed sections — the answer gets its own box (like the pf-define box above it)
function block(b, wrap) {
  const inner = `<h2 id="${b.id}">${b.q}</h2>\n  <p class="pf-answer">${b.a}</p>\n` + (b.more ? `  <p>${b.more}</p>\n` : '');
  if (!wrap) return inner + '  ';
  return `<div class="pf-qa" style="max-width:892px;margin:26px auto;padding:0 16px;box-sizing:border-box;font-family:'DM Sans',sans-serif;line-height:1.7;">\n  ${inner}</div>\n\n`;
}
let changed = 0;
for (const [file, p] of Object.entries(PAGES)) {
  const f = path.join(ROOT, file);
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n');
  if (p.title) s = s.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(p.title).replace(/&quot;/g, '"')}</title>`);
  if (p.desc) s = s.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(p.desc)}"`);
  for (const b of p.blocks) if (!s.includes(`id="${b.id}"`)) {
    if (!s.includes(p.before)) throw new Error(`${file}: anchor not found: ${p.before}`);
    s = s.replace(p.before, block(b, p.wrap) + p.before);
  }
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  changed++;
  const t = p.title || (s.match(/<title>([^<]*)/) || [])[1];
  console.log(`${file}: title ${t.length} chars, description ${(p.desc || '').length} chars, answers: ${p.blocks.map((b) => b.a.split(/\s+/).length + ' words').join(', ')}`);
}
console.log(changed + ' pages');
