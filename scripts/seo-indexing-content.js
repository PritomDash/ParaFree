#!/usr/bin/env node
// ParaFree — seo-indexing round (Nov 10 2026): one genuinely useful section added to the thinnest pages Google has
// "discovered but not indexed" (the short round-2 guides, the language pages, the 500 KB / 1 MB compress pages).
// Idempotent: a page that already has its section (data-round="seo-indexing") is skipped. Additive only.
// Run from the repo root: node scripts/seo-indexing-content.js
'use strict';
const fs = require('fs');
const MARK = 'data-round="seo-indexing"';

// guides: before the "Related:" line; landing pages: before the FAQ heading
const GUIDE_AT = /\n<p>Related:/;
const FAQ_AT = /\n  <h2 id="faq">/;

const SECTIONS = {
  'blog-summarize-a-research-article.html': [GUIDE_AT, `
<section ${MARK}>
<h2>A worked example: one abstract, five sentences</h2>
<p>Here is the method on a made-up study, so you can see the shape of a good summary. Say the abstract reads: <em>“We tested whether 10-minute retrieval quizzes after lectures improve exam scores. 240 first-year students were split into quiz and re-reading groups for one term. The quiz group scored 8 points higher on the final exam. Effects were smaller for students who already scored highly.”</em></p>
<ol>
<li><strong>Question:</strong> Do short quizzes after lectures raise exam scores more than re-reading?</li>
<li><strong>Method:</strong> 240 first-year students, two groups, one term.</li>
<li><strong>Result:</strong> The quiz group scored 8 points higher on the final exam.</li>
<li><strong>Limits:</strong> One term, one cohort; smaller gains for high scorers.</li>
<li><strong>Why it matters for you:</strong> Supports using retrieval practice in your own revision plan.</li>
</ol>
<p>Notice what is missing: no background, no list of every statistic, no copied sentences. If a summary of yours runs past five sentences, the extra ones are usually background — cut them first. When you use an AI summarizer, compare its output with these five slots; anything it leaves out (often the limits) you add yourself from the discussion section.</p>
</section>`],

  'blog-how-to-rephrase-a-sentence.html': [GUIDE_AT, `
<section ${MARK}>
<h2>Common mistakes when you rephrase a sentence</h2>
<ul>
<li><strong>Swapping words, keeping the skeleton.</strong> Replacing every word with a synonym but keeping the original order is still close copying (often called patchwriting). Change the structure, not just the vocabulary.</li>
<li><strong>Changing the meaning with a “synonym”.</strong> <em>Significant</em> in a results section means statistically significant; <em>important</em> does not. Keep technical terms exactly as they are.</li>
<li><strong>Dropping the hedge.</strong> “The data <em>suggest</em> a link” is not the same as “the data <em>prove</em> a link”. Keep words like <em>may</em>, <em>suggests</em> and <em>in most cases</em>.</li>
<li><strong>Losing the citation.</strong> A rephrased idea still belongs to its author — keep the in-text citation next to it.</li>
</ul>
<h2>Check your rephrase in 30 seconds</h2>
<p>Read the original, cover it, and read your version. Ask three questions: does it say the same thing, with the same certainty, about the same people or data? Could someone reading just your sentence find the source? Does it sound like the rest of your writing? If all three answers are yes, the rephrase is done.</p>
</section>`],

  'blog-proofread-before-submitting.html': [GUIDE_AT, `
<section ${MARK}>
<h2>What a grammar checker can’t check for you</h2>
<p>Spelling and grammar tools read sentences one at a time. These five checks need you, and they are where marks are most often lost:</p>
<ol>
<li><strong>Every in-text citation has a reference-list entry</strong> — and every entry is cited at least once. Search for each author’s name.</li>
<li><strong>Figure and table numbers match the text.</strong> After moving a section, “see Figure 3” often points at the wrong figure.</li>
<li><strong>One spelling variant throughout.</strong> UK or US — <em>organise</em> or <em>organize</em> — but not both. Check what your course asks for.</li>
<li><strong>The word count is counted the way the brief says</strong> — with or without references, headings and tables.</li>
<li><strong>The file is what the portal wants</strong> — format (PDF or Word), file name pattern and size limit. If the PDF is too big, <a href="/compress-pdf.html">compress it</a> before the deadline, not at 11:58 pm.</li>
</ol>
</section>`],

  'blog-uk-cv-format.html': [GUIDE_AT, `
<section ${MARK}>
<h2>A UK CV layout you can copy</h2>
<ol>
<li><strong>Name and contact details</strong> — town or city, phone, email, LinkedIn. No photo, date of birth or full address.</li>
<li><strong>Personal profile</strong> — three or four lines: who you are, what you are looking for, one or two strengths with evidence.</li>
<li><strong>Education</strong> — most recent first: course, university, dates, expected or final grade, a relevant module or project if it helps.</li>
<li><strong>Work experience</strong> — most recent first, two to four bullet points each, starting with a verb and ending with a result where you can (“Cut stock-take time by a third by…”).</li>
<li><strong>Skills</strong> — languages (with level), software, certificates. Specific beats generic: “Excel pivot tables” rather than “IT skills”.</li>
<li><strong>Interests</strong> — optional; include them when they show something relevant.</li>
</ol>
<p>Two pages is the usual limit; one page is fine for a student or graduate. Use British spelling, dates as “Sept 2024 – June 2025”, and send a PDF unless the employer asks for Word. You do not need to write “References available on request”.</p>
</section>`],

  'blog-handwritten-homework-pdf.html': [GUIDE_AT, `
<section ${MARK}>
<h2>Photos a marker can actually read</h2>
<ul>
<li><strong>Light from the side or above, not behind you</strong> — your phone’s shadow over the page is the most common reason work is hard to read.</li>
<li><strong>Page flat, phone parallel to it.</strong> Hold the phone straight above the page so lines don’t slope; fill the frame with the page.</li>
<li><strong>One page per photo,</strong> taken in order, so the PDF comes out in the right sequence without re-sorting.</li>
<li><strong>Dark pen on plain paper</strong> photographs far better than pencil on squared paper.</li>
<li><strong>Zoom in on one photo before you convert.</strong> If you can’t read your own working at 100%, the marker can’t either — retake it.</li>
</ul>
<p>Then check the finished PDF against the portal’s limit. Many accept 5–10 MB; if yours is bigger, <a href="/compress-pdf.html">compress it</a> and look at a page again to make sure the writing is still clear. Name the file the way your course asks (often student number and assignment name).</p>
</section>`],

  'free-chinese-paraphrasing-tool.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>中文改写的几个实用技巧</h2>
  <ul>
    <li><strong>先确定用途。</strong>论文、报告选择“正式”模式；读书笔记或给自己看的总结可以用“标准”模式。</li>
    <li><strong>专业术语保持不变。</strong>改写会换掉普通词语和句子结构，但“统计显著”“细胞凋亡”这类术语应该原样保留。改写后请逐句核对。</li>
    <li><strong>引用照样标注出处。</strong>改写后的观点仍然属于原作者，文内引用和参考文献需要保留。</li>
    <li><strong>长文分段检查。</strong>可以一次粘贴整篇文章，但检查时最好一段一段对照原文，看意思和语气有没有变化。</li>
    <li><strong>保留你的写作风格。</strong>如果某一句改写后不像你会说的话，可以只保留结构的变化，再用自己的词语调整。</li>
  </ul>
  <h2>适合哪些场景？</h2>
  <p>留学生用中文整理阅读材料、把自己写的段落改得更通顺、把一段说明文字改写成更正式的书面语，或者把 Word 文档里的内容整体改写后再下载——这些都可以免费完成，不需要注册。改写结果是供你参考和修改的草稿，提交作业前请按学校的规定使用 AI 工具。</p>
  </section>`],

  'free-spanish-paraphrasing-tool.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>Consejos para parafrasear bien en español</h2>
  <ul>
    <li><strong>Elige el modo según el uso:</strong> “Formal” para trabajos académicos e informes; “Estándar” para textos generales.</li>
    <li><strong>Conserva los términos técnicos.</strong> Cambia la estructura y el vocabulario general, pero no conceptos como “significación estadística”.</li>
    <li><strong>Mantén las citas.</strong> Una idea parafraseada sigue siendo del autor original: deja la cita en el texto y en la bibliografía.</li>
    <li><strong>Revisa párrafo por párrafo.</strong> Compara cada párrafo con el original: ¿dice lo mismo, con la misma seguridad?</li>
  </ul>
  <p>El resultado es un borrador para que lo revises y lo hagas tuyo. Antes de entregar un trabajo, sigue las normas de tu centro sobre el uso de herramientas de IA.</p>
  </section>`],

  'free-portuguese-paraphrasing-tool.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>Dicas para parafrasear bem em português</h2>
  <ul>
    <li><strong>Escolha o modo conforme o uso:</strong> “Formal” para trabalhos acadêmicos e relatórios; “Padrão” para textos gerais.</li>
    <li><strong>Preserve os termos técnicos.</strong> Mude a estrutura e o vocabulário comum, mas não conceitos como “significância estatística”.</li>
    <li><strong>Mantenha as citações.</strong> Uma ideia parafraseada continua sendo do autor original: deixe a citação no texto e nas referências.</li>
    <li><strong>Revise parágrafo por parágrafo.</strong> Compare cada parágrafo com o original: diz a mesma coisa, com a mesma certeza?</li>
  </ul>
  <p>O resultado é um rascunho para você revisar e deixar com a sua voz. Antes de entregar um trabalho, siga as regras da sua instituição sobre ferramentas de IA.</p>
  </section>`],

  'free-filipino-paraphrasing-tool.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>Mga tip para sa mahusay na paraphrase</h2>
  <ul>
    <li><strong>Piliin ang mode ayon sa gamit:</strong> “Formal” para sa research paper at report; “Standard” para sa pangkalahatang teksto.</li>
    <li><strong>Huwag palitan ang mga teknikal na termino.</strong> Baguhin ang estruktura at karaniwang salita, pero panatilihin ang mga eksaktong konsepto.</li>
    <li><strong>Panatilihin ang citation.</strong> Ang ideyang na-paraphrase ay pag-aari pa rin ng orihinal na may-akda.</li>
    <li><strong>Suriin bawat talata.</strong> Ihambing sa orihinal: pareho ba ang sinasabi, at pareho ba ang katiyakan?</li>
  </ul>
  <p>Ang resulta ay draft na dapat mong basahin at ayusin sa sarili mong boses. Bago magpasa, sundin ang patakaran ng iyong paaralan tungkol sa paggamit ng AI tools.</p>
  </section>`],

  'compress-pdf-to-1mb.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>Getting a big PDF under 1 MB: what actually shrinks it</h2>
  <ul>
    <li><strong>Scanned pages and photos are the weight.</strong> A 20-page PDF of typed text is often already under 1 MB; the same pages scanned can be 10–30 MB. Try the target-size setting first.</li>
    <li><strong>Scan in greyscale, not colour,</strong> when you scan again — for black-and-white documents the result reads the same and is much smaller.</li>
    <li><strong>Leave out pages the form doesn’t need.</strong> Blank backs of pages and duplicate scans add size for nothing.</li>
    <li><strong>Split it if the portal allows several files.</strong> Two 900 KB files often look better than one heavily compressed 1 MB file.</li>
  </ul>
  <p>After compressing, open the result and zoom in on the smallest text and any signature: if those are still readable, the file is ready to upload.</p>
  </section>`],

  'compress-pdf-to-500kb.html': [FAQ_AT, `
  <section ${MARK}>
  <h2>Why 500 KB, and what to check before you upload</h2>
  <p>Visa, scholarship and job-application forms often set a 500 KB limit per document so their systems stay fast. Typed documents usually get there with a light setting; scans and photographed pages need the target-size setting.</p>
  <ul>
    <li><strong>Check readability at 100% zoom</strong> — especially stamps, signatures and small print on certificates.</li>
    <li><strong>Keep text selectable when you can.</strong> Some portals read the text of a CV or cover letter automatically.</li>
    <li><strong>Upload one file per requested document</strong> unless the form asks for them combined — merging several certificates into one file makes each harder to reach 500 KB.</li>
  </ul>
  </section>`],
};

let added = 0;
for (const [f, [at, html]] of Object.entries(SECTIONS)) {
  const raw = fs.readFileSync(f, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  if (s.includes(MARK)) { console.log('skip', f); continue; }
  const m = at.exec(s);
  if (!m) throw new Error('anchor not found: ' + f);
  s = s.slice(0, m.index) + '\n' + html.replace(/^\n/, '') + s.slice(m.index);
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log('added', f); added++;
}
console.log(added + ' section(s) added');
