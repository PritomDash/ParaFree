# Blog calendar — 8 weeks, 2 posts a week (from 2026-11-09)

Every topic comes from a real Search Console query (last 3 months, `gsc-queries-3m.csv`) or a gap found in the
phase-0 diagnosis. Rules for every post: Pritom's first-person voice, states only what the tool really does, no
best/only/#1, no competitor prices or limits, no "bypass/undetectable/human" claims, one question H2 at least, a
visible FAQ box that matches the FAQPage schema, a link to the matching tool, and an entry in blog.html, the sitemap
and llms.txt. `scripts/blog-round2.js` is the generator to copy (add a post object, run it, run
`node tests/seo-push-round2.test.js` — it picks up every `<article data-round="seo-push-2">`).

| Week | Post | Target query (impr., avg pos.) | Links to |
|---|---|---|---|
| 1 (Nov 9) | Australian resume format: what's different from a UK CV | australian resume builder (4, 85), resume creator australia (3, 66), australian resume template free (3, 78) | free-cv-builder-australia |
| 1 | How to rephrase a whole paragraph (not just a sentence) | rephrase my paragraph (1, 25), rephraser ai (7, 11) | ai-rephraser |
| 2 (Nov 16) | A CV for applying to universities abroad | where can i make the best cv for foreign colleges (2, 40) — write it without "best" | free-cv-builder-international-students |
| 2 | Making a CV as a student with no work experience | cv builder for students (2, 29) | student-cv-builder |
| 3 (Nov 23) | Free CV maker that downloads a PDF without paying: what to check | cv maker free download pdf no payment (2, 1.0), free cv generator uk (42, 27) | cv-builder |
| 3 | Paraphrasing a PDF you wrote: keep the layout question separate | paraphrase pdf (8, 7.9), paraphrase pdf online free (2, 4.5) | paraphrase-pdf |
| 4 (Nov 30) | Rewriting slide text for a presentation (PowerPoint) | paraphrasing powerpoint (4, 11) | paraphrase-powerpoint |
| 4 | How to make a CV in the UK in 30 minutes (step by step) | free cv builder uk (41, 28), free cv creator uk (41, 28), free cv maker uk (32, 29) | free-cv-builder-uk |
| 5 (Dec 7) | UK CV vs resume: is there a difference? | free resume builder uk (35, 22) | free-cv-builder-uk, ats-resume-builder |
| 5 | Exam season: a one-week revision plan with flashcards and quizzes | gap: flashcard pages are "discovered – not indexed"; seasonal (December exams) | flashcard-quiz-maker, pdf-to-flashcards |
| 6 (Dec 14) | Turning a textbook PDF chapter into flashcards | gap: pdf-to-flashcards not indexed | pdf-to-flashcards |
| 6 | Paraphrasing in Spanish (written in Spanish, linked from the ES page) | GA: Spanish is the 2nd language (5% of users); new free-spanish-paraphrasing-tool page | free-spanish-paraphrasing-tool |
| 7 (Dec 21) | Writing a cover letter that matches your CV | gap: cv cluster has no cover-letter guide; supports "cv builder free uk" (54, 31) | cv-builder |
| 7 | Combining several PDFs into one for a portal submission | gap: merge-pdf "discovered – not indexed" | merge-pdf |
| 8 (Dec 28) | New-year job search: updating an old CV in an evening | cv maker free uk (17, 30), uk cv maker free (8, 31) | free-cv-builder-uk |
| 8 | Summarising a long lecture recording into notes | gap: lecture-to-flashcards / studypack audio route is new | lecture-to-flashcards |

## How to choose the next batch (week 9 onwards)
1. In Search Console → Performance → Queries, filter to the last 28 days, sort by impressions, and keep queries at
   position 8–40 with 0–2 clicks (seen, not yet clicked).
2. Drop queries already covered by a page whose title contains the query; those need a title tweak, not a post.
3. Group the rest by tool; each group with ≥ 10 impressions is one post.
