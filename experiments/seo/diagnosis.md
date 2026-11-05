# SEO + AI-search diagnosis — 2026-11-04

All data was read with read-only browser access:
- **GA4:** property p540349237.
- **Search Console:** URL-prefix property `https://parafree.app/`. The `sc-domain:` property is not on this account. Data runs to Nov 1, and the indexing report is from Oct 23.

Raw exports in this folder:
- `gsc-queries-3m.csv` (128 queries)
- `gsc-pages-3m.csv` (92 pages)
- `gsc-daily-3m.csv`
- `baseline.json`

## 1. Is there a traffic drop? Mostly no. Two small ones, and both are on Bing's side.

**Sessions by source (GA4):**

| Source | Last 14 days (Oct 21 – Nov 3) | 14 days before (Oct 7–20) | Oct 6–19 | Change vs Oct 6–19 |
|---|---|---|---|---|
| **Total** | **6,344** | 3,992 | 3,896 | **+63%** |
| chatgpt.com (AI Assistant) | 3,083 (49%) | 1,151 | 1,059 | **+191%** |
| google | 1,256 | — | 805 | +56% |
| (direct) | 1,195 | 1,282 | 1,385 | **−14%** |
| bing | 564 | — | 489 | +15% |
| yahoo (all) | ~100 | — | ~50 | ≈ +100% |

**Week over week** (Oct 28 – Nov 3 vs Oct 21–27):
- Total +11.6%
- ChatGPT +27%
- Google +4.9%
- Direct +7.5%
- **Bing −11.7%**
- **in./uk.search.yahoo.com −54% to −68%** (Yahoo results come from Bing)

**Google Search Console** (clicks / impressions):

| Period | Clicks | Impressions |
|---|---|---|
| Last 14 days to Nov 1 | 785 | 1,281 |
| 14 days before | 530 | 970 |
| Oct 6–19 | 555 | 1,013 |

That is **+41% clicks vs Oct 6–19**. Last week vs the week before: +15% clicks, −3% impressions.

**Landing pages** (GA4 sessions, last 14 days vs Oct 6–19): `/` 4,161 vs 2,922 (+42%).

| Lost | Gained |
|---|---|
| `/cv-builder.html` −19% (22 vs 27) | the new PDF tool pages: `/pdf-to-word.html` 174, `/compress-pdf.html` 146, `/pdf-to-jpg.html` 54, from 0 |
| `/free-paraphrasing-tool-students.html` −4% | `/paraphrase-word-document-keep-formatting.html` 53 (from 8) |

**Likely causes of the two dips:**

**Bing / Yahoo, last week.**
- New pages are not reaching Bing's index quickly. `scripts/indexnow.js` exists, but nothing runs it on deploy, so Bing only learns about changes when it re-crawls.
- This matters twice over: ChatGPT search uses Bing's index, and ChatGPT is now ~half of all traffic.
- No Bing Webmaster data was available to me (that's on your to-do list).

**Direct, −14% over 14 days.**
- Most likely re-attribution, not lost users. GA4's "AI Assistant" channel now captures chatgpt.com sessions that used to arrive without a referrer.
- Total sessions rose 63% over the same period.

**CV builder, −19%.**
- Small numbers (27 → 22 sessions).
- The UK CV queries rank at position 22–31, on page 3 (see §2). There is no sign of a ranking loss, because those pages never ranked higher.

**Seasonality.** There's no year-ago data (the site is new), so this can't be measured.

## 2. Search Console opportunities (last 3 months)

**Totals:** 2,000 clicks, 5,040 impressions, CTR 39.7%, average position 8.3. About 96% of clicks are brand queries ("parafree", "para free", "parafree ai", "parafree humanizer").

**Quick wins** (position 5–20, 50+ impressions, or their URL pairs):

| Page | Impressions | Position | CTR | Target query |
|---|---|---|---|---|
| /ai-rephraser.html | 362 | 5.1 | 2.8% | "ai rephraser" (34 impr, pos 18.7), "rephrase my sentence", "rephraser ai" |
| /paraphrase-powerpoint.html | 135 | 7.4 | 4.4% | "paraphrasing powerpoint", "paraphrasing ppt" |
| /best-free-paraphrasing-tool(.html) | 123 + 71 | 11.0 / 7.5 | 6.5% / 0% | "paraphrase tool free" (30 impr, pos 13.8) |
| /paraphrase-pdf(.html) | 77 + 57 | 6.7 / 5.9 | 5.2% / 1.8% | "paraphrase pdf", "paraphrase pdf online free" |
| /paraphrasing-tool-no-word-limit(.html) | 24 + 66 | 10.9 / 1.2 | — | "paraphrasing tool free no word limit" |
| query "free para" | 132 | 5.1 | 2.3% | brand-like; home page title/description |

**Low CTR** (high impressions, CTR under 2%):

| Page | Impressions | Position | CTR | Note |
|---|---|---|---|---|
| /about.html | 532 | 2.2 | 0.2% | sitelink |
| /code.html | 439 | 1.9 | 0.9% | sitelink |
| /ai-cv-builder.html | 347 | 1.1 | 0% | sitelink |
| /free-paraphrasing-tool-students.html | 224 | 1.3 | 0% | sitelink |
| /faq.html | 221 | — | 0% | sitelink |
| /blog.html | 173 | — | 0% | sitelink |

These rank 1–3 for brand searches, where the user clicks the home page. Their titles and descriptions should say what the page is in a few words, but they are **not real lost clicks**.

**Striking distance** (page 3, the biggest non-brand cluster):
- UK CV queries: "cv builder free uk" 54 impressions at 30.8, "free cv generator uk" 42, "free cv creator uk" 41, "free cv builder uk" 41, "free resume builder uk" 35, "free cv maker uk" 32, and more.
- These all land on `/free-cv-builder-uk.html` (251 impressions, position 29.9).
- Australia queries: position 47–85.

**Impressions but 0 clicks:** most of the 92 pages (see `gsc-pages-3m.csv`).

**Indexing** (Page indexing report, Oct 23): **73 indexed, 69 not indexed.**

| Reason | Count | Detail |
|---|---|---|
| Page with redirect | 31 | Expected: the extensionless URLs 301 to `.html` (vercel.json). GSC still shows impressions for ~25 extensionless URLs, e.g. `/paraphrase-pdf` 77, `/best-free-paraphrasing-tool` 123. They are consolidating. Every canonical already points to `.html` and no internal link uses the extensionless form. |
| Discovered – currently not indexed | 24 | Includes `/pdf-to-word.html`, `/compress-pdf.html`, `/merge-pdf.html`, `/jpg-to-pdf.html`, `/word-to-pdf.html`, `/pdf-tools.html`, `/best-free-cv-builder.html`, `/free-cv-builder-usa.html`, `/free-french-paraphrasing-tool.html`, 6 country pages, 5 blog posts, and **`/404.html`**, which is listed in sitemap.xml and shouldn't be. |
| Alternate page with proper canonical tag | 10 | Fine. |
| Crawled – currently not indexed | 3 | `/blog-paraphrase-powerpoint-safely.html`, `/blog-paraphrasing-for-esl-students`, `/cv-blog.html`. |
| Redirect error | 1 | `/cv-builder-no-signup.html` (Jul 26; validation started). |

Not checked: canonical, 404 and mobile-usability issues beyond the above. GSC's mobile-usability report was retired, so Lighthouse mobile is used instead (Phase 4).

## 3. Audience (GA4, last 28 days)

- **Countries:** India 24.6%, US 10.1%, Pakistan 6.0%, Philippines 3.6%, Indonesia 3.2%, Singapore 3.0%, UK 2.9%, South Africa 2.8%, Saudi Arabia 2.7%, Australia 2.2%.
- **Browser languages:** English 80.8%, Spanish 4.9%, Arabic 3.3%, French 2.3%, Indonesian 1.6%, Chinese 1.1%, Portuguese 0.9%, Russian 0.9%, German 0.5%, Turkish 0.5%.
- **Browsers:** Chrome 60%, Safari 18%, Edge 17%.
- **Device:** desktop 71.5% (November feasibility snapshot).
- **Top tools** (tool_used): paraphrase 14K, humanize 4.7K, AI detector 1.4K, ParaFree AI code 267, compress PDF 245, PDF to Word 215, grammar 172, PDF to JPG 87, AI chat 67, summarize 30. Flashcards: 23 packs from 9 users.

## 4. What this means — the ranked opportunity list that drives Phases 1–6

1. **Bing + ChatGPT search** (half the traffic, and the only real dip):
   - Run IndexNow automatically on every production deploy, for changed URLs.
   - Keep llms.txt complete.
   - Use question-phrased H2s with direct answers, because that is how ChatGPT quotes pages.
2. **Get the "discovered – not indexed" pages crawled:**
   - Remove `/404.html` from the sitemap.
   - Use real `lastmod` dates.
   - Link the PDF tools, language and country pages from the home page and the related tool pages (topic clusters).
3. **Quick wins Google already ranks:** ai-rephraser, paraphrase-powerpoint, paraphrase-pdf, best-free-paraphrasing-tool, paraphrasing-tool-no-word-limit. Retitle them for the real query, and add a question H2 with a 40–60-word direct answer.
4. **UK CV cluster at position 22–31:** give `/free-cv-builder-uk.html` UK-specific depth (UK CV conventions, length, no photo, "CV vs resume", personal statement) and a title for "free CV builder UK".
5. **New pages for real intent, where nothing exists:**
   - Spanish (5% of users), Chinese, Portuguese and Filipino (Philippines is the 4th country) paraphraser pages.
   - Lecture-to-flashcards and YouTube-to-flashcards.
   - Compress PDF to 1 MB.
   - The other requested pages already exist; see the report.
6. **Technical:** BreadcrumbList on the 57 pages without it, the hreflang cluster across all language pages (today each page only points to itself and English), and Lighthouse mobile fixes.

## 5. Baseline to compare against in 2 and 4 weeks

See `baseline.json`:
- GSC clicks/impressions/position for the last 14 days;
- per-page GSC numbers for the quick-win pages;
- GA4 sessions by source;
- AI-referral users;
- the indexing counts.
