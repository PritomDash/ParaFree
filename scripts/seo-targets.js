// ParaFree — the 15 non-brand long-tail targets (seo-indexing round, Nov 10 2026) and one strong page for each.
// Each page must carry the exact phrase (case-insensitive; "200 KB" = "200kb") in its <title>, <h1> and first body
// paragraph, have FAQPage schema and the tool on the page (embedded, or a clear button for tools that live on their own
// page). Checked by tests/seo-indexing.test.js. Picked for: low competition, student intent, a page that already exists.
'use strict';
module.exports = [
  { q: 'turn lecture slides into flashcards', page: 'lecture-to-flashcards.html' },
  { q: 'compress pdf to 200kb for a university portal', page: 'compress-pdf-to-200kb.html' },
  { q: 'paraphrase powerpoint', page: 'paraphrase-powerpoint.html', also: 'paraphrase powerpoint slides' },   // title + H1 pinned (it ranks); "slides" in the first paragraph
  { q: 'paraphrase documents online', page: 'paraphrase-document-online-keep-format.html' },
  { q: 'youtube to flashcards', page: 'youtube-to-flashcards.html' },
  { q: 'pdf to flashcards', page: 'pdf-to-flashcards.html' },
  { q: 'compress pdf to 100kb', page: 'compress-pdf-to-100kb.html' },
  { q: 'jpg to pdf for assignment', page: 'jpg-to-pdf-for-assignment.html' },
  { q: 'free cv builder for international students', page: 'free-cv-builder-international-students.html' },
  { q: 'uk cv format', page: 'blog-uk-cv-format.html' },
  { q: 'summarise a research article', page: 'blog-summarize-a-research-article.html' },
  { q: 'proofreading checklist', page: 'blog-proofread-before-submitting.html' },
  { q: 'rephrase a sentence', page: 'blog-how-to-rephrase-a-sentence.html' },
  { q: 'handwritten homework as one pdf', page: 'blog-handwritten-homework-pdf.html' },
  { q: 'paraphrasing tool with no word limit', page: 'paraphrasing-tool-no-word-limit.html' },
];
