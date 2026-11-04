#!/usr/bin/env node
'use strict';
// SEO phase 2 (one-off, idempotent): every tool page gets a question H2 phrased the way people ask an AI assistant,
// with a direct 40–60-word answer first — facts only from what the tool really does (same facts as llms.txt).
// Run: node scripts/seo-phase2-qa.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const PDF_ANCHOR = '  <section class="pf-section">\n    <h2>Quick facts</h2>';
const section = (b) => `  <section class="pf-section pf-qa">\n    <h2 id="${b.id}">${b.q}</h2>\n    <p class="pf-answer">${b.a}</p>\n  </section>\n`;
const box = (b, style) => `<div class="pf-qa" style="${style || "max-width:892px;margin:26px auto;padding:0 16px;box-sizing:border-box;font-family:'DM Sans',sans-serif;line-height:1.7;"}">\n  <h2 id="${b.id}">${b.q}</h2>\n  <p class="pf-answer">${b.a}</p>\n</div>\n\n`;
const plain = (b) => `<h2 id="${b.id}">${b.q}</h2>\n  <p class="pf-answer">${b.a}</p>\n  `;

const PAGES = [
  ['pdf-to-word.html', PDF_ANCHOR, section, { id: 'pdf-to-word-free', q: 'How do I convert a PDF to Word for free without losing formatting?',
    a: 'Choose the PDF here and wait while each page is read — scanned pages go through OCR (English). ParaFree rebuilds headings, bold and italic, fonts, lists, tables, images and two-column reading order in an editable .docx. It runs in your browser, so the file is never uploaded, and it is free with no signup. Very complex layouts may not match exactly.' }],
  ['jpg-to-pdf.html', PDF_ANCHOR, section, { id: 'photos-to-pdf', q: 'How do I turn photos of my notes into one PDF?',
    a: 'Add your JPG, PNG or WebP photos, drag them into the right order and pick A4, Letter or fit-to-image pages. Photos taken sideways are turned upright automatically. Download one PDF — it is all done in your browser, so nothing is uploaded, and it is free with no signup. HEIC photos from an iPhone need converting to JPG first.' }],
  ['compress-pdf.html', PDF_ANCHOR, section, { id: 'compress-to-size', q: 'How do I compress a PDF to a specific size for free?',
    a: 'Choose Target size and pick 100 KB, 200 KB, 500 KB, 1 MB, 2 MB or your own size. ParaFree tries Light compression first, which keeps the text selectable, then Strong at the highest quality that still fits. If the target can’t be reached it says so and offers the smallest file it could make. It runs in your browser — free, nothing uploaded.' }],
  ['merge-pdf.html', PDF_ANCHOR, section, { id: 'merge-free', q: 'How do I merge PDF files for free without uploading them?',
    a: 'Add the PDFs, drag them into the order you want and press Merge. ParaFree joins the whole files in your browser — nothing is uploaded — and keeps each page’s size and selectable text. It handles up to 2,000 pages, and on desktop Chrome or Edge each file can be up to 2 GB. It is free, with no signup and no watermark.' }],
  ['compress-pdf-to-100kb.html', PDF_ANCHOR, section, { id: 'under-100kb', q: 'How do I make a PDF smaller than 100 KB?',
    a: 'Choose your PDF on this page — the target is already set to 100 KB. ParaFree tries Light compression first, then Strong (pages become images) at the highest quality under 100 KB, down to about 72 DPI. A short scanned form usually fits; a long colour scan may not, and then the page tells you and offers the smallest file instead. Free, in your browser.' }],
  ['jpg-to-pdf-for-assignment.html', PDF_ANCHOR, section, { id: 'handwritten-homework', q: 'How do I submit handwritten homework as a PDF?',
    a: 'Photograph each page flat in good light, add the photos here in page order and keep A4 portrait — this page opens with A4 and small margins already set. Sideways photos are turned upright automatically. Download the single PDF and check that every page is readable before you upload it to your course portal. It is free, runs in your browser and needs no signup.' }],
  ['flashcard-quiz-maker.html', '  <section class="pf-section">\n    <h2>Three sizes</h2>', section, { id: 'pdf-to-flashcards-free', q: 'How do I turn a PDF into flashcards for free?',
    a: 'Upload the PDF — or a Word file, PowerPoint or your pasted notes — choose Quick, Standard or Exam prep and press one button. ParaFree reads the file in your browser, then one AI request writes key-point notes, flip flashcards and a multiple-choice quiz with explanations. It is free with no signup. AI can make mistakes, so check the cards against your notes.' }],
  // (here the definition box sits inside the first section, so the answer goes right before that section's H2)
  ['pdf-tools.html', '    <h2>Each tool has its own page</h2>', (b) => `<h2 id="${b.id}">${b.q}</h2>\n    <p class="pf-answer">${b.a}</p>\n    `, { id: 'free-and-private', q: 'Are these PDF tools really free and private?',
    a: 'Yes. All six tools — PDF to Word, Word to PDF, JPG to PDF, PDF to JPG, Compress and Merge — are free, need no signup and add no watermark. They run in your browser: the file is processed on your own device and never uploaded to a server. Each tool states its limits on its own page, for example 50 pages per PDF to Word conversion.' }],
  ['code.html', '<!-- Token Tracker Section -->', (b) => box(b), { id: 'free-ai-chat-no-signup', q: 'Is there a free AI chat with no signup?',
    a: 'Yes — ParaFree AI is a free assistant you can use straight away without an account. Ask questions, get help with code, research a topic or upload a file and ask about it, with a live preview for web pages it writes. It is one of ParaFree’s free tools. Like any AI it can be wrong, so check important answers before you rely on them.' }],
  ['cv-builder.html', '<!-- SEO: FAQ section -->', (b) => box(b, "max-width:900px;margin:16px auto 0;background:white;border:1.5px solid #e2ddd4;border-radius:12px;padding:18px 22px;box-sizing:border-box;font-family:'DM Sans',sans-serif;line-height:1.7;"), { id: 'cv-free-no-signup', q: 'How do I make a CV for free without signing up?',
    a: 'Choose one of the 54 templates, type your details — or let the AI draft your bullet points and summary — and download the PDF. There is no account, no payment step and no watermark. The PDF has real, selectable text that applicant tracking systems can read, with clickable email and LinkedIn links, and you can write a matching cover letter too.' }],
  ['paraphrase-essay.html', '<h2>Frequently Asked Questions</h2>', plain, { id: 'no-plagiarism', q: 'How do I paraphrase an essay without plagiarising?',
    a: 'Understand the source first, then write it in your own sentences, keep the original meaning and cite the source — a paraphrase without a citation is still plagiarism. A paraphrasing tool can suggest new wording for your own drafts, but check every sentence, keep direct quotations in quotation marks and follow your institution’s rules on using AI tools.' }],
  ['paraphrase-word-document.html', '<div class="section-alt">\n  <div class="container" style="max-width:700px;">\n    <div style="text-align:center;margin-bottom:40px;">\n      <div class="tag">FAQ</div>', (b) => box(b), { id: 'word-keep-formatting', q: 'How do I paraphrase a Word document and keep the formatting?',
    a: 'Upload the .docx file instead of copying the text out. ParaFree paraphrases the body paragraphs and writes the new wording back into the same document, so headings, fonts, colours, bold, italics and tables stay in place. Reference lists and paragraphs with links are left unchanged. Download the edited .docx and read it through before you submit.' }],
];

for (const [file, anchor, wrap, b] of PAGES) {
  const f = path.join(ROOT, file);
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n');
  if (s.includes(`id="${b.id}"`)) { console.log(file + ': already done'); continue; }
  if (!s.includes(anchor)) throw new Error(file + ': anchor not found');
  s = s.replace(anchor, wrap(b) + anchor);
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log(`${file}: "${b.q}" — ${b.a.split(/\s+/).length} words`);
}
