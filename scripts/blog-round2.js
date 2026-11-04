#!/usr/bin/env node
'use strict';
// SEO phase 5: ten student guides (Pritom's voice, like the existing blog), each aimed at a real query from Search
// Console / the phase-0 diagnosis and linking to the matching tool. Built on the layout of
// blog-compress-pdf-upload-limits.html (same head assets, nav, styles, footer). Also adds them to blog.html, the
// sitemap and llms.txt. Run: node scripts/blog-round2.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SITE = 'https://parafree.app/';
const DATE = '2026-11-04', DATE_TEXT = 'November 4, 2026';
const tpl = fs.readFileSync(path.join(ROOT, 'blog-compress-pdf-upload-limits.html'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const words = (h) => h.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
const tryBox = (label, href, button) => `<div class="pf-try pf-try-btn" style="margin:22px 0;padding:14px 16px;border:1px solid #b7e4c7;background:#f0fdf4;border-radius:12px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;font-family:'DM Sans',sans-serif;"><span style="font-weight:600;color:#1a1814;">${label}</span><a href="${href}" style="display:inline-block;background:#2d6a4f;color:#fff;border-radius:20px;padding:8px 18px;font-size:14px;font-weight:700;text-decoration:none;">${button} →</a></div>`;

const POSTS = [
  {
    slug: 'blog-paraphrase-without-plagiarism', query: 'how to paraphrase without plagiarism',
    title: 'How to Paraphrase Without Plagiarising (A Student’s Method)', short: 'How to paraphrase without plagiarising',
    desc: 'Paraphrasing without a citation is still plagiarism. A five-step method for writing a source in your own words, citing it, and using an AI tool honestly.',
    card: 'A five-step method for putting a source in your own words — and where an AI paraphraser fits honestly.',
    tool: ['Try it free — paraphrase your own draft', '/', 'Open the paraphraser'],
    body: `<p>When I started university I thought paraphrasing meant “change enough words that it doesn’t look copied”. It doesn’t. A paraphrase that changes every word but keeps someone else’s idea without saying whose it is, is still plagiarism. Here is the method I use now — it takes a little longer and produces better essays.</p>
<h2>What counts as plagiarism when you paraphrase?</h2>
<p>Using another person’s idea, argument or findings without crediting them — whether you quote them, summarise them or rewrite them sentence by sentence. Changing the words does not change whose idea it is. A good paraphrase is in your own words <em>and</em> cited.</p>
<h2>A five-step method</h2>
<ol>
<li><strong>Read until you understand it.</strong> Read the passage twice. If you can’t explain it to a friend, you are not ready to paraphrase it.</li>
<li><strong>Close the source.</strong> Write the idea from memory, in your own sentences and your own order. This is the step that stops you copying the structure.</li>
<li><strong>Compare.</strong> Open the source again. Did you keep the meaning? Did any phrase sneak in word for word? Put unavoidable exact phrases in quotation marks.</li>
<li><strong>Cite it.</strong> Add the in-text citation and the reference in the style your course uses (APA, Harvard, MLA…).</li>
<li><strong>Connect it to your argument.</strong> A paraphrase should do a job in your essay — follow it with what it means for your point.</li>
</ol>
<h2>Where an AI paraphraser fits</h2>
<p>I built ParaFree’s paraphraser, so I’ll be clear about what it is for. It is useful for <strong>your own drafts</strong>: a sentence of yours that reads clumsily, a paragraph that repeats the same word, a draft you want in a more formal register. It is not a way to turn somebody else’s text into “your” text — that is exactly the plagiarism this post is about.</p>
<p>When you do use it, read every sentence of the result. An AI can shift a nuance — “may cause” becoming “causes” changes a claim. Keep names, numbers and quotations exactly as they are (ParaFree tries to leave them untouched, but check), and follow your institution’s rules on AI tools; some courses require you to say you used one.</p>
<h2>Paraphrase, quote or summarise?</h2>
<ul>
<li><strong>Quote</strong> when the exact words matter — a definition, a striking phrase, a legal text.</li>
<li><strong>Paraphrase</strong> when the idea matters but the wording doesn’t, and you need about the same level of detail.</li>
<li><strong>Summarise</strong> when you only need the main point of a longer piece — the <a href="/ai-summarizer.html">summarizer</a> can help you see the key ideas of a paper before you write your own summary.</li>
</ul>
<h2>A quick self-check before you submit</h2>
<p>For each paraphrased passage ask: is there a citation? Would the original author recognise their idea and agree it’s fairly represented? Could I explain it without looking? If all three are yes, you are fine. Run the essay through a <a href="/grammar-checker.html">grammar check</a> last, so you fix the typos — not the meaning.</p>`,
    related: [['/paraphrase-essay.html', 'Paraphrase an essay'], ['/blog-keep-meaning-when-paraphrasing.html', 'Keep the meaning when paraphrasing'], ['/blog-academic-papers-citations.html', 'Academic papers and citations']],
  },
  {
    slug: 'blog-flashcards-from-lecture-slides', query: 'how to make flashcards from lecture slides',
    title: 'How to Make Flashcards From Lecture Slides (Free)', short: 'Flashcards from lecture slides',
    desc: 'Lecture slides are mostly headings and fragments. How to turn them into flashcards that actually test you — by hand or with a free AI tool — and what to check.',
    card: 'Slides are fragments. How to turn them into cards that test you — and what to check before you revise.',
    tool: ['Try it free — upload your slides', '/lecture-to-flashcards.html', 'Make flashcards from a lecture'],
    body: `<p>Every lecturer I had uploaded the slides after class, and every exam season I opened forty decks of bullet points and felt like I knew nothing. Re-reading slides feels productive and isn’t. Turning them into questions is what made revision work for me.</p>
<h2>Why slides make poor revision material on their own</h2>
<p>Slides are prompts for a talk, not the talk. “Krebs cycle — 3 stages” tells you nothing you can be tested on. A flashcard forces the missing part: <em>What are the three stages of the Krebs cycle, and what does each produce?</em> Answering that from memory — active recall — is what makes it stick.</p>
<h2>How do I turn slides into flashcards?</h2>
<ol>
<li><strong>Pick one slide deck per session.</strong> One lecture, one deck.</li>
<li><strong>Turn each heading into a question.</strong> “Causes of inflation” becomes “What are the main causes of inflation?”.</li>
<li><strong>Fill the answer from your notes or the recording,</strong> not from the slide — the slide is usually too thin.</li>
<li><strong>One idea per card.</strong> If an answer needs a list of six things, make it six cards or one card with a short list.</li>
<li><strong>Add the diagrams yourself.</strong> A text tool can’t read a diagram the way you can; describe it in a card (“What does the supply curve shift show?”).</li>
</ol>
<h2>Doing it with a free AI tool</h2>
<p>This is the part I automated in ParaFree. On the <a href="/lecture-to-flashcards.html">lecture to flashcards</a> page you upload the .pptx or PDF; the slide text (and speaker notes) is read in your browser and one AI request writes flashcards, a short multiple-choice quiz and the key points. Choose <strong>Quick</strong> for one topic, <strong>Standard</strong> for a normal lecture and <strong>Exam prep</strong> for a whole module.</p>
<p>Two tips that make a big difference: paste your own lecture notes in as well, because slides alone are thin; and if the PDF is a scan, run it through <a href="/pdf-to-word.html">PDF to Word</a> (it reads scans with OCR) first, then upload the Word file.</p>
<h2>What to check before you revise</h2>
<p>Read every card once. AI can merge two ideas into one card, miss what a diagram showed or word a question so the answer is obvious. Delete or fix those — it takes a couple of minutes and you will trust the deck in the exam week.</p>
<h2>Then actually use them</h2>
<p>Go through the cards without looking at the answers, say the answer out loud, then flip. Put the ones you got wrong in a separate pile and repeat them tomorrow. Take the quiz at the end of the week as a check. That is the whole method — less re-reading, more remembering.</p>`,
    related: [['/lecture-to-flashcards.html', 'Lecture to flashcards'], ['/notes-to-flashcards.html', 'Notes to flashcards'], ['/blog-active-recall-flashcards.html', 'Study with flashcards: active recall']],
  },
  {
    slug: 'blog-youtube-lecture-to-flashcards', query: 'youtube video to flashcards',
    title: 'How to Turn a YouTube Lecture Into Flashcards (Free)', short: 'YouTube lecture to flashcards',
    desc: 'Copy a YouTube video’s transcript, paste it, and get flashcards and a quiz. Step-by-step, what works with auto-captions, and which videos make good cards.',
    card: 'Copy the transcript, paste it, get cards and a quiz — plus which videos make good flashcards.',
    tool: ['Try it free — paste a video transcript', '/youtube-to-flashcards.html', 'Make flashcards from a video'],
    body: `<p>Half of what I learned in second year came from YouTube — a professor from another university explaining the thing my lecturer rushed. Watching is easy; remembering a week later is not. Here is how I turn a video into something I can revise from.</p>
<h2>Step 1: get the transcript</h2>
<p>On the video page, click <strong>…more</strong> under the title, scroll down and choose <strong>Show transcript</strong>. A panel opens with the text and timestamps. Select all of it (click at the top, shift-click at the bottom) and copy. Auto-generated captions work too — they just mishear names and technical terms more often.</p>
<h2>Step 2: turn it into cards</h2>
<p>Paste the transcript into the YouTube tab of ParaFree’s <a href="/youtube-to-flashcards.html">YouTube to flashcards</a> page. It removes the timestamps, keeps the most central sentences of long transcripts and writes flashcards, a multiple-choice quiz and the key points from what is said. You can paste only the link instead — ParaFree then tries to read the captions itself — but YouTube often blocks that, and then it asks you for the transcript rather than guessing.</p>
<h2>Which videos make good flashcards?</h2>
<ul>
<li><strong>Good:</strong> lectures, explainers and tutorials where the speaker says the important points out loud.</li>
<li><strong>Thin:</strong> videos that teach mainly through on-screen equations, code or diagrams — only the spoken words are in the transcript. Add your own notes for those.</li>
<li><strong>Not worth it:</strong> vlogs, opinion pieces and anything you don’t need to be tested on.</li>
</ul>
<h2>Check the cards against the video</h2>
<p>Auto-captions turn “mitosis” into “my toe sis” more often than you would think. Skim the cards, and for anything odd, jump to that moment in the video. Fix the term once and the card is good for the rest of the term.</p>
<h2>Revise the active way</h2>
<p>Cover the answer, answer out loud, flip. Do the quiz at the end. If you got a question wrong, rewatch just that part — the timestamp is in the transcript you copied. You will spend less time watching and remember more of it.</p>`,
    related: [['/youtube-to-flashcards.html', 'YouTube to flashcards'], ['/flashcard-quiz-maker.html', 'Flashcards & Quiz maker'], ['/blog-active-recall-flashcards.html', 'Study with flashcards: active recall']],
  },
  {
    slug: 'blog-how-to-rephrase-a-sentence', query: 'rephrase my sentence',
    title: 'How to Rephrase a Sentence (5 Ways, With Examples)', short: 'How to rephrase a sentence',
    desc: 'Five ways to rephrase a sentence — change the voice, structure, order, register or length — with examples, and when an AI rephraser helps.',
    card: 'Five ways to rephrase a sentence, with before-and-after examples.',
    tool: ['Try it free — rephrase a sentence', '/ai-rephraser.html', 'Open the AI rephraser'],
    body: `<p>“Rephrase my sentence” is one of the things people most often type into ParaFree, and it is usually one stubborn sentence, not a whole essay. These are the five moves I use when a sentence won’t sit right.</p>
<h2>1. Change active to passive (or back)</h2>
<p><em>The committee rejected the proposal.</em> → <em>The proposal was rejected by the committee.</em> Active is usually clearer; passive is useful when the doer doesn’t matter or isn’t known (“The samples were stored at 4 °C”).</p>
<h2>2. Change the structure</h2>
<p><em>Because prices rose, demand fell.</em> → <em>Demand fell as prices rose.</em> → <em>Rising prices pushed demand down.</em> Same fact, three shapes. Pick the one that connects best to the sentence before it.</p>
<h2>3. Move the important part to the end</h2>
<p>English puts emphasis at the end of a sentence. <em>A 40% drop in sales was the main result of the change.</em> → <em>The main result of the change was a 40% drop in sales.</em> Now the number lands.</p>
<h2>4. Change the register</h2>
<p><em>The results were pretty bad.</em> (casual) → <em>The results were disappointing.</em> (neutral) → <em>The results fell well short of expectations.</em> (formal). Match the register to the reader: an essay, an email to a tutor and a message to a friend each want a different one.</p>
<h2>5. Shorten it — or split it</h2>
<p>Most stubborn sentences are just too long. <em>Due to the fact that the data was incomplete, it was not possible for us to reach a conclusion.</em> → <em>The data was incomplete, so we couldn’t reach a conclusion.</em></p>
<h2>When does an AI rephraser help?</h2>
<p>When you have tried and the sentence still sounds wrong, paste it into the <a href="/ai-rephraser.html">AI rephraser</a>, pick a mode (Standard keeps your tone; Formal and Simple change the register) and compare two or three versions. Keep the one that sounds like you, and check that names, numbers and the actual claim didn’t change. A rephraser is a second pair of eyes for your own writing — the idea and the final choice should still be yours.</p>`,
    related: [['/ai-rephraser.html', 'AI rephraser'], ['/blog-keep-meaning-when-paraphrasing.html', 'Keep the meaning when paraphrasing'], ['/grammar-checker.html', 'Grammar checker']],
  },
  {
    slug: 'blog-uk-cv-format', query: 'uk cv format',
    title: 'UK CV Format in 2026: Length, Layout and What to Leave Out', short: 'UK CV format in 2026',
    desc: 'How long a UK CV should be, the section order recruiters expect, and what to leave out (photo, date of birth, full address). With a free CV builder.',
    card: 'Length, section order, the personal statement — and what UK employers don’t want on a CV.',
    tool: ['Try it free — build a UK CV', '/free-cv-builder-uk.html', 'Open the UK CV builder'],
    body: `<p>I moved countries for university and my first CV was the format from home: photo, date of birth, a whole page of “personal details”. In the UK that CV looked wrong before anyone read it. Here is the format that works here.</p>
<h2>How long should a UK CV be?</h2>
<p>Two A4 pages once you have some experience; one full page if you are a student or recent graduate. Recruiters skim, so the first half of page one does most of the work.</p>
<h2>The usual section order</h2>
<ol>
<li><strong>Name and contact details</strong> — phone, email, town or city, LinkedIn. That’s all.</li>
<li><strong>Personal statement</strong> — three to five lines: who you are, your strongest skills, and the kind of role you want.</li>
<li><strong>Experience</strong> — most recent first; job title, employer, dates, then 3–5 bullet points that start with a verb and show a result.</li>
<li><strong>Education</strong> — most recent first; for graduates this can come before experience.</li>
<li><strong>Skills</strong> — the ones the job advert asks for, honestly.</li>
<li><strong>References</strong> — “available on request” is fine, or leave it out.</li>
</ol>
<h2>What to leave out</h2>
<ul>
<li><strong>Photo</strong> — not expected in the UK (acting and modelling are the usual exceptions).</li>
<li><strong>Date of birth and marital status</strong> — age is a protected characteristic under the Equality Act 2010; employers don’t need it.</li>
<li><strong>Full home address</strong> — town or city is enough.</li>
<li><strong>“Curriculum Vitae” as a title</strong> — your name is the title.</li>
</ul>
<h2>Writing bullet points that work</h2>
<p>“Responsible for social media” says nothing. “Grew the society’s Instagram from 300 to 1,200 followers in one term” says a lot. If you don’t have a number, describe the outcome: what changed because you were there? Never invent figures — an interviewer will ask.</p>
<h2>Make it readable by software too</h2>
<p>Many employers use an applicant tracking system that reads the text of your CV. Use a simple one- or two-column layout with real text (not an image), standard headings and no tables for key information. The <a href="/free-cv-builder-uk.html">UK CV builder</a> on ParaFree has 54 templates built that way; the PDF has selectable text and clickable email and LinkedIn links, it downloads free with no watermark, and you don’t need an account.</p>`,
    related: [['/free-cv-builder-uk.html', 'Free CV builder UK'], ['/blog-cv-personal-statement.html', 'How to write a CV personal statement'], ['/blog-ats-friendly-cv-guide.html', 'ATS-friendly CV guide']],
  },
  {
    slug: 'blog-handwritten-homework-pdf', query: 'how to submit handwritten homework as pdf',
    title: 'How to Submit Handwritten Homework as One PDF (Phone Only)', short: 'Handwritten homework as one PDF',
    desc: 'Photograph your pages, put them in order, make one readable PDF under the upload limit — all on your phone, free, without uploading your work to a converter.',
    card: 'Photograph the pages, put them in order, one readable PDF under the limit — on your phone.',
    tool: ['Try it free — photos to one PDF', '/jpg-to-pdf-for-assignment.html', 'Open JPG to PDF for assignments'],
    body: `<p>Maths problem sets, lab sheets, a drawing for design class — sometimes the work is on paper and the portal wants one PDF. These are the steps I give every friend who asks the night before a deadline.</p>
<h2>1. Take good photos</h2>
<ul>
<li>Daylight or a bright lamp, no flash (flash makes a glare spot in the middle of the page).</li>
<li>Phone directly above the page, the page filling the frame, nothing else in the picture.</li>
<li>Dark pen on white paper photographs best. Pencil is fine if you press hard.</li>
</ul>
<h2>2. Put them in order</h2>
<p>Name or number the photos as you take them, or take them in page order. In ParaFree’s <a href="/jpg-to-pdf-for-assignment.html">JPG to PDF for assignments</a> you can still drag pages into the right order before making the file. Photos taken sideways are turned upright automatically.</p>
<h2>3. Make the PDF</h2>
<p>That page opens with A4 portrait pages and small margins already set, which is what most courses expect. Add the photos (JPG, PNG or WebP), check the order, and download one PDF. It all happens in your browser, so your work is never uploaded to a converter site. iPhone photos in HEIC format need to be JPG first — in iPhone settings, <em>Camera → Formats → Most Compatible</em> makes the camera save JPG.</p>
<h2>4. Check it before you submit</h2>
<p>Open the PDF and zoom into the smallest writing on the hardest page. If you can read it, your marker can. Check the page count matches, and that nothing is cut off at the edges.</p>
<h2>What if the PDF is too big to upload?</h2>
<p>Phone photos are large; ten pages can be 30 MB. If the portal has a limit, run the PDF through <a href="/compress-pdf.html">Compress PDF</a> and pick the limit as the target size (for example 5 MB, 2 MB or 1 MB). Handwriting stays readable at much smaller sizes than you might expect, but always zoom in again after compressing.</p>`,
    related: [['/jpg-to-pdf-for-assignment.html', 'JPG to PDF for assignments'], ['/compress-pdf-to-1mb.html', 'Compress PDF to 1 MB'], ['/blog-compress-pdf-upload-limits.html', 'PDF upload limits guide']],
  },
  {
    slug: 'blog-active-recall-flashcards', query: 'how to study with flashcards',
    title: 'How to Study With Flashcards (Active Recall Made Simple)', short: 'How to study with flashcards',
    desc: 'Why testing yourself beats re-reading, how to write cards that work, a simple daily routine, and how to make cards from your own notes for free.',
    card: 'Why testing yourself beats re-reading, how to write good cards and a simple routine.',
    tool: ['Try it free — make cards from your notes', '/flashcard-quiz-maker.html', 'Open Flashcards & Quiz'],
    body: `<p>The most useful thing I learned at university wasn’t on any syllabus: re-reading my notes felt like studying and barely worked; testing myself felt harder and worked far better. Researchers call it active recall. Flashcards are the simplest way to do it.</p>
<h2>Why does testing yourself work?</h2>
<p>Every time you pull an answer out of memory, you make it easier to pull out next time. Re-reading only makes the material <em>familiar</em>, which feels like knowing it until the exam asks you a question. A flashcard makes you answer the question first.</p>
<h2>How to write cards that work</h2>
<ul>
<li><strong>One idea per card.</strong> “What are the three branches of government?” is one card; the powers of each branch are three more.</li>
<li><strong>Ask, don’t state.</strong> The front is a question, not a heading.</li>
<li><strong>Use your own words</strong> in the answer — and keep it short enough to say out loud.</li>
<li><strong>Add the “why”</strong> for important ones: “Why does X happen?” cards build understanding, not just facts.</li>
</ul>
<h2>A simple routine</h2>
<ol>
<li>Make cards on the day of the lecture, while it’s fresh.</li>
<li>Go through them the next day: answer out loud, then flip.</li>
<li>Cards you got wrong go in a “tomorrow” pile; cards you got right wait a few days.</li>
<li>Once a week, do a practice quiz on the whole topic to check yourself the way an exam will.</li>
</ol>
<p>That spacing — more often for what you get wrong, less for what you know — is the whole trick behind every spaced-repetition app.</p>
<h2>Making the cards takes too long — so let AI draft them</h2>
<p>Writing cards is where most people give up. ParaFree’s <a href="/flashcard-quiz-maker.html">Flashcards &amp; Quiz</a> drafts them from your own notes, a PDF, slides, a YouTube transcript or a lecture recording, and adds a multiple-choice quiz with explanations. It is free and needs no account. It doesn’t store decks or schedule repetitions for you, so copy or download the cards into whatever you revise with. And read them before you trust them — AI can make mistakes.</p>`,
    related: [['/flashcard-quiz-maker.html', 'Flashcards & Quiz maker'], ['/quiz-from-notes.html', 'Quiz from notes'], ['/blog-flashcards-from-lecture-slides.html', 'Flashcards from lecture slides']],
  },
  {
    slug: 'blog-cv-personal-statement', query: 'how to write a personal statement for a cv',
    title: 'How to Write a CV Personal Statement (With 3 Examples)', short: 'How to write a CV personal statement',
    desc: 'A CV personal statement in three to five lines: who you are, what you offer, what you want. A formula plus examples for a student, graduate and career changer.',
    card: 'Three to five lines that make a recruiter keep reading — a formula and three examples.',
    tool: ['Try it free — draft yours in the CV builder', '/cv-builder.html', 'Open the CV builder'],
    body: `<p>The personal statement is the first thing a recruiter reads on a UK-style CV, and most of them say the same thing: “hard-working team player with excellent communication skills”. Here is how to write one that sounds like a person.</p>
<h2>What should a CV personal statement include?</h2>
<p>Use a simple formula — who, what, want:</p>
<ol>
<li><strong>Who you are</strong> — your current stage and field: “Final-year accounting student”, “Junior software developer with two years’ experience”.</li>
<li><strong>What you offer</strong> — two or three specific strengths, ideally with evidence: a project, a result, a tool you know well.</li>
<li><strong>What you want</strong> — the role you are applying for, in the employer’s words.</li>
</ol>
<p>Three to five lines. First person without “I” is the usual UK style (“Final-year student with…”), but full first person is fine if it reads more naturally — just be consistent.</p>
<h2>Example: student</h2>
<p><em>Second-year marketing student with hands-on social media experience from running a 1,200-member university society account. Comfortable with Canva, Meta Business Suite and basic Google Analytics. Looking for a summer marketing internship where I can work on real campaigns.</em></p>
<h2>Example: graduate</h2>
<p><em>Civil engineering graduate (2:1) with a dissertation on low-carbon concrete and a ten-week placement on a residential site in Leeds. AutoCAD and Revit trained. Seeking a graduate engineer role on a chartership pathway.</em></p>
<h2>Example: career changer</h2>
<p><em>Retail supervisor moving into data analysis, with five years of managing stock and rota data for a team of 12 and a recently completed Google Data Analytics certificate. Looking for an entry-level analyst role where operations experience is an advantage.</em></p>
<h2>Common mistakes</h2>
<ul>
<li>Clichés with no evidence (“passionate”, “results-driven”).</li>
<li>Writing about what you want from the employer instead of what you offer.</li>
<li>Going past five lines — it stops being read.</li>
<li>Numbers you can’t back up in an interview. Never invent them.</li>
</ul>
<h2>Drafting it with AI — carefully</h2>
<p>ParaFree’s <a href="/cv-builder.html">CV builder</a> can draft a summary from the details you have already entered. Treat it as a first draft: it is instructed not to invent facts or figures and to leave placeholders like [X]% for you to fill, but you know your own story. Edit it until it sounds like you, then download the CV as a PDF — free, no watermark, no account.</p>`,
    related: [['/cv-builder.html', 'CV builder'], ['/blog-uk-cv-format.html', 'UK CV format in 2026'], ['/student-cv-builder.html', 'Student CV builder']],
  },
  {
    slug: 'blog-summarize-a-research-article', query: 'how to summarize a research article',
    title: 'How to Summarise a Research Article in 15 Minutes', short: 'How to summarise a research article',
    desc: 'Read a paper in the right order, pull out the question, method, result and limits, and write a five-sentence summary — plus where an AI summarizer helps.',
    card: 'The order to read a paper in, a five-sentence summary template, and where AI helps.',
    tool: ['Try it free — get the key points first', '/ai-summarizer.html', 'Open the AI summarizer'],
    body: `<p>My first literature review took weeks because I read every paper like a novel, start to finish. A research paper is built to be read out of order. This is the routine that got me down to about fifteen minutes a paper.</p>
<h2>In what order should you read a research paper?</h2>
<ol>
<li><strong>Title and abstract</strong> — what they asked and what they claim.</li>
<li><strong>Conclusion</strong> — the claim in the authors’ own final words, often with the limits.</li>
<li><strong>Figures and tables</strong> — the evidence, with captions.</li>
<li><strong>Methods</strong> — skim: who or what was studied, how many, how.</li>
<li><strong>Introduction and discussion</strong> — only for what you still need: the gap they fill, how they explain surprises.</li>
</ol>
<h2>Pull out five things</h2>
<ul>
<li>The <strong>question</strong> the paper answers.</li>
<li>The <strong>method</strong> in one line (design, sample, setting).</li>
<li>The <strong>main result</strong>, with the key number if there is one.</li>
<li>The <strong>limits</strong> the authors admit — and any you notice.</li>
<li><strong>Why it matters for your work</strong>.</li>
</ul>
<h2>A five-sentence summary template</h2>
<p><em>[Authors, year] investigated [question] using [method] with [sample]. They found [main result]. This suggests [meaning]. However, [limit]. For my [essay/project], this shows [relevance].</em> Write it in your own words and cite it — a summary of somebody’s paper is still their work.</p>
<h2>Where an AI summarizer helps — and where it doesn’t</h2>
<p>An AI summary is a good first pass to decide whether a paper is worth reading fully. ParaFree’s <a href="/ai-summarizer.html">summarizer</a> gives key points as bullets plus a conclusion sentence, aiming for under about 30% of the original length. It is not a replacement for the five things above: it can miss the limitations, flatten an uncertain result into a confident one, and it has not read the figures. Use it to sort papers, then read the ones that matter the way you would anyway.</p>
<p>Long PDF? <a href="/pdf-to-word.html">PDF to Word</a> gets the text out first — it keeps two-column papers in reading order.</p>`,
    related: [['/ai-summarizer.html', 'AI summarizer'], ['/blog-academic-papers-citations.html', 'Academic papers and citations'], ['/pdf-to-word.html', 'PDF to Word']],
  },
  {
    slug: 'blog-proofread-before-submitting', query: 'proofreading checklist',
    title: 'A Proofreading Checklist Before You Submit an Essay', short: 'Proofreading checklist before you submit',
    desc: 'A ten-minute proofreading checklist for essays and reports: the errors spell-check misses, how to read your own work, and how to use a grammar checker well.',
    card: 'The errors spell-check misses, how to read your own work, and how to use a grammar checker.',
    tool: ['Try it free — check your grammar', '/grammar-checker.html', 'Open the grammar checker'],
    body: `<p>I have lost marks for “there” instead of “their” in an essay I had read five times. You can’t proofread what you remember writing — your brain fills in what you meant. These are the tricks that actually catch mistakes.</p>
<h2>Leave it, then change how it looks</h2>
<p>Put the essay away for a few hours, even just overnight. Then change the font or the size, or read it on your phone. New-looking text gets read instead of remembered.</p>
<h2>Read it out loud</h2>
<p>Slow, every word. Missing words, repeated words (“the the”) and sentences that run on for ever are obvious when you hear them. Your device’s read-aloud feature does this for you.</p>
<h2>The checklist</h2>
<ul>
<li><strong>Homophones</strong>: their/there/they’re, its/it’s, affect/effect, than/then.</li>
<li><strong>Agreement</strong>: “The results of the study <em>were</em>”, not “was”.</li>
<li><strong>Apostrophes</strong>: “the student’s essay” (one), “the students’ essays” (many).</li>
<li><strong>Tense</strong>: past for what you did (“we measured”), present for what is generally true.</li>
<li><strong>Numbers and names</strong>: check every figure, date and author name against your source.</li>
<li><strong>Citations</strong>: every in-text citation has a reference, and the other way round.</li>
<li><strong>Formatting</strong>: headings consistent, page numbers, the right referencing style, the word count within the limit.</li>
</ul>
<h2>Use a grammar checker — and read what it says</h2>
<p>A grammar checker catches the mechanical slips your eyes skip. ParaFree’s <a href="/grammar-checker.html">grammar checker</a> gives back the corrected text and a list of every fix as <em>original → corrected (reason)</em>, so you can see each change instead of accepting a whole new version. Read the list: some “errors” are deliberate (a quotation, a term from your field), and the reason tells you whether to keep the fix. Run it last, after you have finished changing the content.</p>
<h2>What should I check in the final two minutes?</h2>
<p>Check the file name, the format the portal wants (PDF or Word) and that the right version is attached. If it has to be a PDF, export it from Word with <a href="/word-to-pdf.html">Word to PDF</a> so the text stays selectable.</p>`,
    related: [['/grammar-checker.html', 'Grammar checker'], ['/blog-paraphrase-without-plagiarism.html', 'Paraphrase without plagiarising'], ['/word-to-pdf.html', 'Word to PDF']],
  },
];

const out = [];
for (const p of POSTS) {
  const url = SITE + p.slug + '.html';
  const titleFull = `${p.title} | ParaFree`.length <= 60 ? `${p.title} | ParaFree` : p.title;
  let s = tpl;
  const rep = (re, val) => { if (!re.test(s)) throw new Error(p.slug + ': template pattern missing ' + re); s = s.replace(re, val); };
  rep(/<title>[\s\S]*?<\/title>/, `<title>${titleFull}</title>`);
  rep(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(p.desc)}">`);
  rep(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  rep(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(titleFull)}">`);
  rep(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(p.desc)}">`);
  rep(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  rep(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(titleFull)}">`);
  rep(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(p.desc)}">`);
  s = s.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/g, '');
  const article = { '@context': 'https://schema.org', '@type': 'Article', headline: p.title, description: p.desc, author: { '@type': 'Person', name: 'Pritom Dash' },
    datePublished: DATE, dateModified: DATE, publisher: { '@type': 'Organization', name: 'ParaFree', url: SITE }, mainEntityOfPage: url, url, inLanguage: 'en' };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE }, { '@type': 'ListItem', position: 2, name: 'Blog', item: SITE + 'blog.html' },
    { '@type': 'ListItem', position: 3, name: p.short, item: url }] };
  // a short FAQ = the visible "In short" box (one question: the query this guide answers)
  const firstP = (p.body.match(/<p>([\s\S]*?)<\/p>/) || [, ''])[1].replace(/<[^>]+>/g, '');
  const q = p.query.charAt(0).toUpperCase() + p.query.slice(1) + '?';
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: p.desc } }] };
  s = s.replace('</head>', [article, crumbs, faq].map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n') + '\n</head>');
  const related = p.related.map(([h, t]) => `<a href="${h}">${t}</a>`).join(' · ');
  const articleHtml = `<article data-round="seo-push-2">
    <nav class="pf-crumbs" aria-label="Breadcrumb" style="font-size:13px;opacity:.78;margin:0 0 12px;"><a href="/" style="color:inherit;">Home</a> <span aria-hidden="true">›</span> <a href="/blog.html" style="color:inherit;">Blog</a> <span aria-hidden="true">›</span> <span aria-current="page">${p.short}</span></nav>
    <h1>${p.title}</h1>
    <p class="article-meta">By Pritom Dash &middot; Published ${DATE_TEXT}</p>
<div class="pf-faq" style="margin:18px 0;padding:14px 16px;border-left:4px solid #2d6a4f;background:#f7f5f0;border-radius:0 10px 10px 0;"><p class="faq-q" style="margin:0 0 6px;font-weight:700;">${q}</p><p class="faq-a" style="margin:0;">${p.desc}</p></div>
${tryBox(p.tool[0], p.tool[1], p.tool[2])}
${p.body}
<p>Related: ${related}</p>
<p class="author-sig">— Pritom Dash</p>
    <div class="cta-box">
      <p>${p.tool[0].replace(/^Try it free — /, '').replace(/^./, (c) => c.toUpperCase())} — free, no signup.</p>
      <a href="${p.tool[1]}">${p.tool[2]} →</a>
    </div>
  </article>`;
  s = s.replace(/<article>[\s\S]*?<\/article>/, articleHtml);
  fs.writeFileSync(path.join(ROOT, p.slug + '.html'), s.replace(/\n/g, '\r\n'));
  out.push(`${p.slug}.html — ${words(p.body)} words — "${titleFull}" (${titleFull.length})`);
}
console.log(out.join('\n'));

// blog.html cards (newest first), sitemap, llms.txt guides
function edit(f, fn) { const p = path.join(ROOT, f), raw = fs.readFileSync(p, 'utf8'), crlf = raw.includes('\r\n'), s0 = raw.replace(/\r\n/g, '\n'), s = fn(s0); if (s !== s0) fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s); }
edit('blog.html', (s) => {
  const cards = POSTS.filter((p) => !s.includes(`href="/${p.slug}.html" class="blog-card"`)).map((p) => `\n    <a href="/${p.slug}.html" class="blog-card">\n      <div class="card-date">${DATE_TEXT}</div>\n      <h2>${p.title}</h2>\n      <p>${p.card}</p>\n      <span class="card-link">Read article &rarr;</span>\n    </a>`).join('');
  return s.replace('<div class="blog-grid">', '<div class="blog-grid">' + cards);
});
edit('sitemap.xml', (s) => { for (const p of POSTS) if (!s.includes(`/${p.slug}.html<`)) s = s.replace('</urlset>', `  <url>\n    <loc>${SITE}${p.slug}.html</loc>\n    <lastmod>${DATE}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>`); return s; });
for (const f of ['llms.txt', 'llms-full.txt']) edit(f, (s) => {
  if (s.includes('blog-paraphrase-without-plagiarism')) return s;
  const lines = POSTS.map((p) => `- [${p.title}](${SITE}${p.slug}.html)`).join('\n');
  return s.includes('### Guides\n') ? s.replace('### Guides\n', '### Guides\n' + lines + '\n') : s + '\n## Student guides (November 2026)\n' + lines + '\n';
});
