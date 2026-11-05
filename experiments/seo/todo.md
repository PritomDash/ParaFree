# Off-site to-do (SEO phase 6) — for Pritom, after feat/seo-push is merged and deployed

These steps need your own accounts, so they are yours to do. I didn't create any accounts or submit anything.
Do them in this order. Each one says how long it takes.

## 1. Bing Webmaster Tools (15 min) — highest priority
Bing and Yahoo are the only search sources that dropped (−12% week on week). Bing also feeds ChatGPT search and Copilot,
and ChatGPT already sends 48.6% of sessions.
1. Go to https://www.bing.com/webmasters and sign in. Choose **Import from Google Search Console**. This verifies the
   site and copies the sitemap in one step.
2. If the import isn't offered, go to **Add site** → `https://parafree.app/` → verify with the **HTML meta tag**. Send me
   the tag and I'll add it to index.html (that file is mine to edit, not yours).
3. Go to **Sitemaps** → submit `https://parafree.app/sitemap.xml`.
4. Go to **IndexNow** and check that the pings from the GitHub Action are arriving. They start after the next deploy.
   The key file is `/<key>.txt` at the site root.
5. Go to **URL Inspection** → check that `/ai-rephraser.html` and `/free-cv-builder-uk.html` are indexed.

## 2. Google Search Console — Request Indexing (10 min a day; the quota is about 10 URLs a day)
URL Inspection → paste the URL → **Request indexing**.
Day 1 (new pages):
1. https://parafree.app/lecture-to-flashcards.html
2. https://parafree.app/youtube-to-flashcards.html
3. https://parafree.app/compress-pdf-to-1mb.html
4. https://parafree.app/free-spanish-paraphrasing-tool.html
5. https://parafree.app/free-portuguese-paraphrasing-tool.html
6. https://parafree.app/blog-uk-cv-format.html
7. https://parafree.app/blog-how-to-rephrase-a-sentence.html
8. https://parafree.app/blog-paraphrase-without-plagiarism.html
9. https://parafree.app/blog-cv-personal-statement.html
10. https://parafree.app/blog-flashcards-from-lecture-slides.html

Day 2:
- the other 7 new URLs: free-chinese / free-filipino paraphrasing pages, blog-youtube-lecture-to-flashcards,
  blog-active-recall-flashcards, blog-summarize-a-research-article, blog-handwritten-homework-pdf,
  blog-proofread-before-submitting;
- then the first 3 of the 24 "Discovered – currently not indexed" pages (Pages → Not indexed → that row).

Day 3: the rest of those 24, about 10 a day.

Also: **Sitemaps** → resubmit `sitemap.xml`. Its lastmod dates now come from git, and 404.html has been removed.

## 3. Directories and listings (about 1–2 h in total, spread over a week)
Use the same honest description everywhere. Don't use best/only/#1, don't name competitors' prices or limits, and
don't make "undetectable" claims about the humanizer:

> ParaFree is a free AI writing and study toolkit built by a student: paraphraser, AI rephraser, summarizer,
> grammar checker, humanizer, CV builder with 54 templates (PDF download, no watermark), flashcards & quizzes from
> notes/PDFs/slides/YouTube, and PDF tools that run in the browser. No signup.

| Where | Category | Notes |
|---|---|---|
| AlternativeTo (alternativeto.net) | Add as an alternative to the paraphrasers and CV builders people search for | Free listing; the reviews there get cited by AI answers |
| SaaSHub (saashub.com) | Writing tools / Resume builders | Free listing |
| Product Hunt | Launch on a Tuesday–Thursday, 12:01 am PT | Prepare 4 screenshots and a short maker comment telling the student story. One launch only |
| Futurepedia, There's An AI For That, Toolify | AI writing / education | Free submissions only. Skip any listing that needs payment or a card |
| GitHub README + repo topics | `paraphrasing-tool`, `cv-builder`, `flashcards` | Already public; add the site URL in the About box |

## 4. Student communities (ongoing, about 20 min a week)
- Only post where self-promotion is allowed, and read each community's rules first. Possible places:
  - r/GetStudying and r/studytips (they often have weekly resource threads);
  - r/UKJobs and r/cscareerquestionsuk (CV feedback threads);
  - your university's Discord or Facebook groups;
  - Bangladeshi and Indian student groups.
- Answer the question that was asked and mention the tool only when it fits. Link to the matching guide (for example
  blog-uk-cv-format) rather than the home page.
- Quora: answer "how do I make flashcards from lecture slides" and "UK CV format" style questions, with a link to the
  guide.

## 5. Track AI citations every month (30 min, on the first Monday of each month)
1. Ask ChatGPT (search on), Perplexity, Copilot and Gemini these 8 questions. Keep the wording the same each month:
   - free paraphrasing tool with no word limit
   - free CV builder UK with no watermark
   - how to make flashcards from lecture slides
   - youtube video to flashcards free
   - free AI rephraser
   - compress pdf to 1mb free
   - free spanish paraphrasing tool
   - how to write a CV personal statement
2. For each answer, note: is ParaFree mentioned (Y/N), is it linked (Y/N), and which page. Keep the table in
   `experiments/seo/ai-citations.csv` with the columns
   `date,assistant,question,mentioned,linked,url`.
3. Cross-check against GA4: **Reports → Acquisition → Traffic acquisition**, filtered to session source chatgpt.com /
   perplexity.ai / copilot.microsoft.com / gemini.google.com.

## What to measure, and when

Compare against `baseline.json` (taken 2026-11-04). In GSC, use date ranges of the same length, ending on the same
weekday.

### At 2 weeks (around 2026-11-18 — enough time to see indexing, too soon for rankings)
- **GSC Pages → Indexed:** was 73 indexed and 24 discovered-not-indexed. Target: at least 85 indexed and fewer than 15
  discovered-not-indexed.
- **The 17 new URLs:** each one shows "URL is on Google" in URL Inspection. Count how many do.
- **Quick-win CTR:** title and meta changes show up first.
  - ai-rephraser: 2.8% at position 5.1. Target above 5%.
  - paraphrase-powerpoint: 4.4%.
  - paraphrase-pdf and paraphrasing-tool-no-word-limit: any clicks at all.
- **Bing Webmaster:** the site is verified, the sitemap shows "Success", and IndexNow submissions are counted.
- **Rich results** (GSC Enhancements): Breadcrumbs, FAQ and HowTo are detected with 0 errors.
- **Lighthouse mobile on the home page:** performance 36 (was 26), CLS 0. Check it stays there after the deploy.

### At 4 weeks (around 2026-12-02 — rankings and traffic)
- **GSC, 28 days vs the 28 days before 11-04:** clicks were 2000 over 3 months (about 670 a month); impressions;
  average position 8.3.
- **The UK CV cluster** (free cv builder uk / generator / creator / maker): was at position 22–31 with 0 clicks.
  Target: under 15 for at least 2 of them.
- **The new pages and guides:** impressions above 0 for at least 10 of the 17, and the queries they rank for.
- **GA4 sessions by source** (was google 1256, bing 564, chatgpt.com 3083 over 14 days):
  - Bing and Yahoo back to the Oct 6–19 level or above;
  - Google up.
- **AI citations:** the first monthly table, compared with the next one.
- **Then decide:**
  - pages with impressions but no clicks get a title rewrite;
  - pages still not indexed after 4 weeks get more internal links from the home page and hubs;
  - next, carry on with the calendar in `calendar.md`.
