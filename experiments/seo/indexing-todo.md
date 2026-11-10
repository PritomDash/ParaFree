# Indexing round — what was wrong, what changed, and what only you can do

Branch: `feat/seo-indexing` (not merged). Search Console data read 2026-11-10 (report last updated 2026-11-06).
Re-check everything here with `node scripts/seo-crawl.js` and `node tests/seo-indexing.test.js`.

## What the 101 "not indexed" pages really are

| Reason (count) | What it is | Action |
|---|---|---|
| Page with redirect (33) | 28 extensionless URLs (`/cv-builder`, `/blog`, `/privacy`…) Google learned while `cleanUrls: true` was on (July – 23 Aug 2026). They now 301 to the `.html` page — **correct, leave them**. 5 are `.html` URLs last crawled in August, when they redirected *to* the clean URL; they are 200 now. | Request indexing for the 5 `.html` URLs (list below). The 28 drop out by themselves. |
| Alternate page with proper canonical (14) | 13 extensionless URLs crawled in August + `/?ref=producthunt`. All point their canonical at the right page. | Nothing to fix. |
| Redirect error (1) | `cv-builder-no-signup.html`, last crawled 26 Jul during the cleanUrls redirect loop. 200 now. Validation already started. | Request indexing. |
| Crawled – currently not indexed (2) | `cv-templates.html`, `cv-blog.html`. | Request indexing (both changed since). |
| Discovered – currently not indexed (51) | Never crawled ("Last crawled: N/A"): the core tool pages, PDF pages and the Oct–Nov guides. Internal links are already strong (core tool pages have 23–50 internal links each), so this is Google's crawl demand for a young site, not a site problem. | Request indexing (priority list), Bing, and the links below. |

The repo itself was already clean: every sitemap URL, internal link, canonical, hreflang, og:url and JSON-LD URL is a final 200 `.html` URL (the crawl found 0 redirects / 0 404s), except one JSON-LD logo (`/logo.png`, a 404 — fixed).

## Changed on the branch

- `/index.html` and `/index` now 301 to `/` (the homepage had two 200 URLs).
- JSON-LD logo on `best-free-cv-builder.html`: `/logo.png` (404) → `/logo.svg`.
- `ilovepdf-alternative.html`: 58 % the same text as `smallpdf-alternative.html` → `noindex, follow`, out of the sitemap and `llms.txt` (still live for visitors).
- One real section added to the thinnest pages: 5 short guides, the Chinese / Spanish / Portuguese / Filipino pages, Compress PDF to 500 KB and to 1 MB.
- 15 long-tail targets (`scripts/seo-targets.js`): the exact phrase in title, H1 and first paragraph (titles/H1 of pages that already rank were left alone), FAQPage schema, the tool on the page. Three guides now embed their tool (paraphraser, summarizer, grammar checker).
- A quotable "ParaFree’s … is a free in-browser tool that …" sentence on every PDF tool page.
- `llms.txt`: November 2026, more guides and the student / document pages listed.
- Sitemap `lastmod` refreshed (126 URLs).
- New checks: `scripts/seo-crawl.js` (local crawl, no network) and `tests/seo-indexing.test.js` (57 checks).

## Off-site — only you can do these

### 1. Vercel (5 minutes, do first)
- **Settings → Domains → `www.parafree.app`: change the redirect to `parafree.app` from 307 (temporary) to 308 (permanent).** Today `https://www.parafree.app/` answers `307`, so Google treats www as a separate, temporarily-moved host.

### 2. Google Search Console (u/1, property `https://parafree.app/`)
After the branch is merged and deployed:
1. **Sitemaps → resubmit `https://parafree.app/sitemap.xml`.**
2. **URL inspection → Request indexing** (about 10 a day — spread over the days below):
   - Day 1 — fixed URLs: `cv-builder-no-signup.html`, `cv-templates.html`, `cv-blog.html`, `blog-paraphrase-pdf-right-way.html`, `blog-student-built-free-ai-tool.html`, `blog-growing-indie-tool-organically.html`, `blog-building-taught-me-more-than-uni.html`, `blog-api-fallback-chains.html`, `ai-humanizer.html`, `ai-summarizer.html`
   - Day 2 — core tools: `grammar-checker.html`, `ai-detector.html`, `pdf-tools.html`, `pdf-to-word.html`, `compress-pdf.html`, `jpg-to-pdf.html`, `merge-pdf.html`, `word-to-pdf.html`, `pdf-to-jpg.html`, `flashcard-quiz-maker.html`
   - Day 3 — targets: `lecture-to-flashcards.html`, `compress-pdf-to-200kb.html`, `compress-pdf-to-100kb.html`, `jpg-to-pdf-for-assignment.html`, `youtube-to-flashcards.html`, `pdf-to-flashcards.html`, `paraphrase-document-online-keep-format.html`, `free-cv-builder-international-students.html`, `best-free-cv-builder.html`, `ai-study-tools.html`
   - Day 4 — guides: `blog-uk-cv-format.html`, `blog-summarize-a-research-article.html`, `blog-proofread-before-submitting.html`, `blog-how-to-rephrase-a-sentence.html`, `blog-handwritten-homework-pdf.html`, `blog-cv-personal-statement.html`, `blog-active-recall-flashcards.html`, `blog-compress-pdf-upload-limits.html`, `cover-letter-generator.html`, `free-ai-chat.html`
3. **Page indexing → Redirect error → the validation already running**: leave it to finish.
4. Do **not** "Validate fix" on "Page with redirect" or "Alternate page with proper canonical" — those URLs are meant to stay out of the index.

### 3. Bing Webmaster Tools (feeds ChatGPT search)
1. Add the site with **Import from Google Search Console** (no new verification needed).
2. Submit `https://parafree.app/sitemap.xml`.
3. **IndexNow** report: confirm submissions arrive after each deploy (the GitHub Action "IndexNow ping" ran successfully on every deploy to main, latest 2026-11-10).
4. URL inspection on the 15 target pages; fix anything Bing flags in **Site scan** (free).

### 4. Free directory listings (no card; honest descriptions — no "best / only / #1", no claims about other tools)
- AlternativeTo — list ParaFree (paraphraser) and ParaFree PDF tools; describe what they do.
- SaaSHub, There’s An AI For That, Futurepedia, Toolify, Uneed — one listing each, the same short factual description.
- Your GitHub profile / any portfolio page: link to `https://parafree.app/`.
- Student communities: only where self-promotion is allowed by the rules (e.g. a weekly tools thread), and say you built it.

## What to measure on 2026-11-24 (two weeks)

| Where | Metric | Today | Watch for |
|---|---|---|---|
| GSC → Page indexing | Indexed | 77 | ≥ 95 |
| GSC → Page indexing | Discovered – currently not indexed | 51 | falling (≤ 35) |
| GSC → Page indexing | Redirect error / Crawled – not indexed | 1 / 2 | 0 / 0 |
| GSC → Performance (queries **not** containing "parafree") | Non-brand impressions, 28 days | almost none | any impressions for the 15 targets; list the queries |
| GSC → Performance → Pages | Impressions on the 15 target pages | — | each target page appearing |
| Bing Webmaster → Search performance | Indexed pages, clicks | — | the 15 targets indexed |
| GA4 → Acquisition → Session source | `chatgpt.com` sessions | #1 source | stable or growing |
| `curl -sI https://www.parafree.app/` | redirect status | 307 | 308 |
