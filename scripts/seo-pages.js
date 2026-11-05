#!/usr/bin/env node
'use strict';
// SEO phase 3: new pages for real search intent, built on the shared landing-page layout of notes-to-flashcards.html
// (same head assets, nav, styles and footer). Each page: the real tool embedded (or one click away), original copy,
// question H2s with direct answers, steps, FAQ (FAQPage = the visible FAQ), BreadcrumbList, SoftwareApplication,
// HowTo from the visible steps. Language pages: copy in that language, the paraphraser preset to it, hreflang.
// Run: node scripts/seo-pages.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SITE = 'https://parafree.app/';
const UPDATED = '2026-11-04';
const tpl = fs.readFileSync(path.join(ROOT, 'notes-to-flashcards.html'), 'utf8').replace(/\r\n/g, '\n');
const HEAD_END = tpl.indexOf('<!-- Google tag (gtag.js) -->');
const ASSETS = tpl.slice(HEAD_END, tpl.indexOf('</head>')).replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/g, '');   // gtag, fonts, styles (not the template's own schema)
const NAV = tpl.slice(tpl.indexOf('<body>'), tpl.indexOf('<div class="hero">'));  // nav + mobile menu
const FOOTER = tpl.slice(tpl.indexOf('<footer'));                                 // footer to </html>
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

// hreflang cluster of every language page (new + existing)
const LANG_PAGES = {
  es: 'free-spanish-paraphrasing-tool.html', 'zh-Hans': 'free-chinese-paraphrasing-tool.html', pt: 'free-portuguese-paraphrasing-tool.html',
  fil: 'free-filipino-paraphrasing-tool.html', fr: 'free-french-paraphrasing-tool.html', ar: 'free-arabic-paraphrasing-tool.html',
  hi: 'free-hindi-paraphrasing-tool.html', bn: 'free-bengali-paraphrasing-tool.html', ur: 'free-urdu-paraphrasing-tool.html',
};
const hreflangBlock = () => Object.entries(LANG_PAGES).map(([l, f]) => `<link rel="alternate" hreflang="${l}" href="${SITE}${f}">`).join('\n')
  + `\n<link rel="alternate" hreflang="en" href="${SITE}">\n<link rel="alternate" hreflang="x-default" href="${SITE}">\n`;

function page(p) {
  const url = SITE + p.file;
  const crumbs = [{ name: 'Home', item: SITE }].concat(p.parent ? [p.parent] : [], [{ name: p.crumb, item: url }]);
  const schema = [
    ld({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) }),
    ld({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: p.app, applicationCategory: p.category || 'EducationalApplication', operatingSystem: 'Web browser',
      url: p.appUrl, isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, description: strip(p.define), inLanguage: p.lang,
      publisher: { '@type': 'Organization', name: 'ParaFree', url: SITE } }),
    ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: p.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: strip(a) } })) }),
    ld({ '@context': 'https://schema.org', '@type': 'HowTo', name: p.howName, totalTime: 'PT2M', estimatedCost: { '@type': 'MonetaryAmount', currency: 'USD', value: '0' },
      step: p.steps.map(([n, t], i) => ({ '@type': 'HowToStep', position: i + 1, name: n, text: t, url: url + '#how-to' })) }),
  ].join('\n');
  const embed = p.embed ? `<!-- TOOL EMBED: the real tool, created by lib/embed-host.js only when it comes near the screen -->
<section class="pf-try" aria-label="${esc(p.tryLabel)}" style="max-width:1100px;margin:28px auto;padding:0;font-family:'DM Sans',sans-serif;box-sizing:border-box;">
  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 16px;margin:0 16px 8px;"><span style="font:700 17px Syne,'DM Sans',sans-serif;color:#1a1814;">${esc(p.tryLabel)}</span><a class="pf-try-full" href="${p.cta.href}" target="_blank" rel="noopener" style="font-size:13px;font-weight:700;color:#2d6a4f;text-decoration:none;white-space:nowrap;">${esc(p.openFull || 'Open full tool')} ↗</a></div>
  <div data-pf-embed="${esc(p.embed)}" data-pf-title="${esc(p.app)}" style="position:relative;min-height:${p.embedHeight || 900}px;"><p class="pf-embed-loading" style="position:absolute;top:0;left:0;right:0;margin:0;padding:40px 16px;text-align:center;color:#6b6660;font-size:14px;">${esc(p.loading || 'Loading the tool…')}</p><noscript><p style="padding:16px;text-align:center;"><a href="${p.cta.href}">${esc(p.cta.text)}</a></p></noscript></div>
</section>
<script src="/lib/embed-host.js" defer></script>
<!-- /TOOL EMBED -->
` : '';
  const body = `<div class="hero">
  <div class="hero-inner">
    <nav class="pf-crumbs" aria-label="Breadcrumb" style="font-size:13px;opacity:.78;margin:0 0 12px;color:#fff;">${crumbs.slice(0, -1).map((c) => `<a href="${c.item.replace(SITE, '/')}" style="color:inherit;">${esc(c.name)}</a> <span aria-hidden="true">›</span> `).join('')}<span aria-current="page">${esc(p.crumb)}</span></nav>
    <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(82,183,136,0.15);border:1px solid rgba(82,183,136,0.3);border-radius:24px;padding:8px 20px;margin-bottom:24px;color:#52b788;font-size:14px;font-weight:600;">${esc(p.badge)}</div>
    <h1 class="hero-h1">${p.h1}</h1>
    <p>${p.lede}</p>
    <a href="${p.cta.href}" class="btn-hero">${esc(p.cta.text)} →</a>
  </div>
</div>

${embed}
<div class="article-body">

  <p class="pf-define">${p.define}</p>
  <p class="pf-updated">${p.updatedLabel || 'Last updated'}: ${p.updatedText || 'November 4, 2026'}</p>

${p.sections.map(([q, html]) => `  <h2>${q}</h2>\n  ${html}\n`).join('\n')}
  <h2 id="how-to">${p.howName}</h2>
  <ol class="pf-steps">
${p.steps.map(([n, t]) => `    <li><strong>${n}.</strong> ${t}</li>`).join('\n')}
  </ol>

  <h2 id="faq">${p.faqTitle || 'Frequently asked questions'}</h2>
  <div class="pf-faq">
${p.faq.map(([q, a]) => `    <div class="faq-item"><p class="faq-q">${q}</p><p class="faq-a">${a}</p></div>`).join('\n')}
  </div>

  <h2>${p.relatedTitle || 'Related free tools'}</h2>
  <ul class="pf-related">
${p.related.map(([h, t, s]) => `    <li><a href="${h}">${t}<span>${s}</span></a></li>`).join('\n')}
  </ul>

  <div class="cta-box">
    <h3>${p.ctaBox[0]}</h3>
    <p>${p.ctaBox[1]}</p>
    <div class="pf-cta-row"><a href="${p.cta.href}" class="btn-primary">${esc(p.cta.text)} →</a></div>
  </div>

</div>

`;
  return `<!DOCTYPE html>
<html lang="${p.lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title).replace(/&quot;/g, '"')}</title>
<meta name="description" content="${esc(p.desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}">
${p.hreflang ? hreflangBlock() : ''}<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon.png">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:image" content="https://parafree.app/og-image.png">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(p.desc)}">
<meta name="twitter:image" content="https://parafree.app/og-image.png">
${schema}
  ${ASSETS}</head>
${NAV}${body}${FOOTER}`;
}

const STUDY = { name: 'Study tools', item: SITE + 'ai-study-tools.html' };
const PDFT = { name: 'PDF Tools', item: SITE + 'pdf-tools.html' };
const FLASH_RELATED = [
  ['/flashcard-quiz-maker.html', 'Flashcards &amp; Quiz maker', 'The tool itself: notes, files, YouTube or recordings'],
  ['/notes-to-flashcards.html', 'Notes to flashcards', 'Cards from notes you paste'],
  ['/pdf-to-flashcards.html', 'PDF to flashcards', 'Cards from a PDF, Word file or slides'],
  ['/quiz-from-notes.html', 'Quiz from notes', 'A multiple-choice quiz with explanations'],
  ['/ai-summarizer.html', 'AI summarizer', 'A short bullet-point summary of any text'],
  ['/ai-study-tools.html', 'AI study tools', 'Every free ParaFree tool for studying'],
];

const PAGES = [
  {
    file: 'lecture-to-flashcards.html', lang: 'en', parent: STUDY, crumb: 'Lecture to flashcards',
    title: 'Lecture to Flashcards Free — Slides or Recording to Cards',
    desc: 'Turn a lecture into flashcards free: upload the slides (PPTX or PDF) or the recording, and AI makes flip cards, a quiz and key points. No signup.',
    app: 'ParaFree Flashcards & Quiz', appUrl: SITE + 'flashcard-quiz-maker.html', embed: '/flashcard-quiz-maker.html?embed=1', tryLabel: 'Try it here — upload your lecture',
    badge: 'Lecture → Flashcards · Free', h1: 'Turn a Lecture into Flashcards — Slides, Notes or the Recording',
    lede: 'Upload the lecture slides or the recording, or paste your notes. Get flashcards, a practice quiz and the key points, made from that lecture only.',
    cta: { href: '/flashcard-quiz-maker.html', text: 'Make Flashcards from My Lecture' },
    define: 'Lecture to flashcards with ParaFree: upload the lecture slides (.pptx or PDF), a recording of up to 60 minutes, or your notes, and the free AI tool writes question-and-answer flashcards, a multiple-choice quiz and key points from that lecture — no signup.',
    sections: [
      ['How do I make flashcards from lecture slides?', '<p>Upload the PowerPoint (.pptx) or the PDF your lecturer shared. The text on every slide is read in your browser — speaker notes too — and one AI request turns it into flashcards, a quiz and a short list of key points. Slides are often only headings and fragments, so if you wrote notes in the lecture, paste them in as well: the cards get better with more context.</p>'],
      ['Can I turn a lecture recording into flashcards?', '<p>Yes. Choose <strong>Audio / Video</strong> and upload the recording — MP3, M4A, WAV or a video file, up to 50 MB and 60 minutes. The speech is transcribed, trimmed to its most important sentences and turned into a pack. For a video, only the sound is used. Recordings are limited to 5 packs per day so the free service stays available for everyone.</p>'],
      ['What should I check before I revise?', '<p>Read every card once. AI can misread a slide that is mostly a diagram, or merge two ideas into one card. Fix or delete anything that does not match what was taught — two minutes of checking makes the deck trustworthy for exam revision.</p>'],
    ],
    howName: 'Turn a lecture into flashcards in four steps',
    steps: [['Choose the input', 'Upload the slides or the recording, or paste your lecture notes.'], ['Pick a size', 'Quick for one topic, Standard for a lecture, Exam prep for a whole module.'],
      ['Make the pack', 'One click writes key points, flashcards and a quiz with explanations.'], ['Check and revise', 'Read the cards, fix anything wrong, then test yourself.']],
    faq: [
      ['Which slide files work?', 'PowerPoint (.pptx), PDF, Word (.docx) and .txt. Scanned PDFs need text first — run <a href="/pdf-to-word.html">PDF to Word</a> with OCR, then upload the Word file.'],
      ['How long can a recording be?', 'Up to 60 minutes and 50 MB per file, and 5 recording packs per day.'],
      ['Are my files uploaded?', 'Slides and documents are read in your browser; only the extracted text (trimmed to about 4,000 words) goes to the AI. Recordings are sent for transcription and are not kept by ParaFree.'],
      ['Is it free?', 'Yes — free, with no signup.'],
      ['Can I download the cards?', 'Yes — copy them or download them as a .txt file to use anywhere.'],
    ],
    related: FLASH_RELATED,
    ctaBox: ['Your lecture, as flashcards', 'Slides, notes or the recording — free, no signup.'],
  },
  {
    file: 'youtube-to-flashcards.html', lang: 'en', parent: STUDY, crumb: 'YouTube to flashcards',
    title: 'YouTube to Flashcards Free — Turn a Video Lecture into Cards',
    desc: 'Make flashcards from a YouTube video free: paste its transcript (or the link) and AI writes flip cards, a quiz and key points from it. No signup.',
    app: 'ParaFree Flashcards & Quiz', appUrl: SITE + 'flashcard-quiz-maker.html', embed: '/flashcard-quiz-maker.html?embed=1', tryLabel: 'Try it here — choose the YouTube tab',
    badge: 'YouTube → Flashcards · Free', h1: 'Turn a YouTube Video into Flashcards — Free',
    lede: 'Paste the video’s transcript, or its link, and get flashcards, a practice quiz and the key points from what the video actually says.',
    cta: { href: '/flashcard-quiz-maker.html', text: 'Make Flashcards from a Video' },
    define: 'YouTube to flashcards with ParaFree: paste a YouTube video’s transcript (or its link) into the YouTube tab and the free AI tool turns what is said in the video into flashcards, a multiple-choice quiz and key points — no signup.',
    sections: [
      ['How do I make flashcards from a YouTube video?', '<p>Open the video on YouTube, click <strong>…more</strong> under it and choose <strong>Show transcript</strong>. Select the whole transcript, copy it and paste it into the YouTube tab. ParaFree removes the timestamps, keeps the most important sentences and writes your flashcards, quiz and key points. This works for any video that has a transcript, including auto-generated captions.</p>'],
      ['Can I just paste the link?', '<p>You can. ParaFree then tries to read the video’s captions automatically. YouTube often blocks that, and when it does the page asks you to paste the transcript instead — it never guesses what the video says. Pasting the transcript is the most reliable route.</p>'],
      ['Which videos work best?', '<p>Lectures, explainers and tutorials where the speaker says the important points out loud. A video that teaches mostly through on-screen diagrams or equations gives thinner cards, because only the spoken words are in the transcript — add your own notes for those.</p>'],
    ],
    howName: 'Turn a YouTube video into flashcards in four steps',
    steps: [['Copy the transcript', 'On YouTube: …more → Show transcript, then select and copy it.'], ['Paste it', 'Into the YouTube tab — or paste the video link instead.'],
      ['Pick a size', 'Quick, Standard or Exam prep, then make the pack.'], ['Check and revise', 'Read the cards against the video and fix anything wrong.']],
    faq: [
      ['Do I need the video’s transcript?', 'It is the most reliable way. With only a link, ParaFree tries the captions automatically, but YouTube often blocks that.'],
      ['Does it work with auto-generated captions?', 'Yes. Automatic captions can mishear names and terms, so check those cards.'],
      ['Can it handle a long lecture video?', 'Yes. Long transcripts are trimmed to their most central sentences (TextRank) before the AI sees them.'],
      ['Is it free?', 'Yes — free, with no signup.'],
      ['Is anything saved?', 'No. The transcript is used to write your pack and is not stored by ParaFree.'],
    ],
    related: FLASH_RELATED.filter((r) => !/notes-to/.test(r[0])).concat([['/lecture-to-flashcards.html', 'Lecture to flashcards', 'Cards from slides or a recording']]),
    ctaBox: ['A video lecture, as flashcards', 'Paste the transcript — free, no signup.'],
  },
  {
    file: 'compress-pdf-to-1mb.html', lang: 'en', parent: PDFT, crumb: 'Compress PDF to 1 MB', category: 'UtilitiesApplication',
    title: 'Compress PDF to 1 MB Free — In Your Browser, No Upload',
    desc: 'Make a PDF smaller than 1 MB free: set the target to 1 MB and ParaFree keeps the highest quality that fits, on your device. No signup, no watermark.',
    app: 'ParaFree Compress PDF', appUrl: SITE + 'compress-pdf.html', embed: null,
    badge: 'Target Size · 1 MB · In Your Browser', h1: 'Compress a PDF to 1 MB — Free, for Email and Upload Limits',
    lede: '1 MB is a common limit for application portals and some email systems. Choose the 1 MB target and ParaFree keeps as much quality as fits.',
    cta: { href: '/compress-pdf.html', text: 'Compress My PDF' },
    define: 'Compress PDF to 1 MB with ParaFree: open Compress PDF, choose Target size → 1 MB, and the free in-browser tool makes the PDF fit — trying Light compression first so the text stays selectable — with no upload, no signup and no watermark.',
    sections: [
      ['How do I compress a PDF to under 1 MB?', '<p>Open <a href="/compress-pdf.html">Compress PDF</a>, choose your file, pick <strong>Target size</strong> and select <strong>1 MB</strong>. ParaFree tries Light compression first — it shrinks the images and keeps the text selectable — and only if that is not enough uses Strong compression at the highest quality that still fits under 1 MB.</p>'],
      ['Will my text still be selectable?', '<p>Usually, yes. At 1 MB most text documents, CVs and assignment files fit with Light compression, which leaves the text as real text. Strong compression turns pages into images, so it is only used when Light cannot reach the target — for example a long scanned or photo-heavy file.</p>'],
      ['What if it cannot reach 1 MB?', '<p>The page tells you plainly and offers the smallest file it managed. Then split the PDF into parts, remove pages you do not need, or scan at a lower resolution. A 50-page colour scan rarely fits in 1 MB at a readable quality.</p>'],
      ['Is my PDF uploaded anywhere?', '<p>No. Compression runs in your browser, on your device. The file never leaves your computer or phone.</p>'],
    ],
    howName: 'Compress a PDF to 1 MB in three steps',
    steps: [['Open Compress PDF', 'Choose your PDF on the Compress PDF page.'], ['Pick 1 MB', 'Select Target size → 1 MB (or type a custom size).'], ['Download', 'Save the smaller PDF and check that it reads well.']],
    faq: [
      ['Is it free?', 'Yes — free, with no signup and no watermark.'],
      ['Can I pick another size?', 'Yes — 100 KB, 200 KB, 500 KB, 2 MB or any custom size.'],
      ['How big can the original be?', 'Up to 1 GB and 300 pages for Strong/Target size on desktop Chrome or Edge (500 MB in other browsers).'],
      ['Why is my compressed PDF blurry?', 'Strong compression was needed to reach 1 MB. Try a larger target or remove pages to keep more quality.'],
    ],
    related: [['/compress-pdf.html', 'Compress PDF', 'Light, Strong or any target size'], ['/compress-pdf-to-500kb.html', 'Compress PDF to 500 KB', 'For stricter upload limits'],
      ['/compress-pdf-to-200kb.html', 'Compress PDF to 200 KB', 'For CVs on job portals'], ['/compress-pdf-to-100kb.html', 'Compress PDF to 100 KB', 'For government and admission forms'],
      ['/merge-pdf.html', 'Merge PDF', 'Join files before you compress'], ['/pdf-tools.html', 'All PDF tools', 'Six free tools, all in your browser']],
    ctaBox: ['Make your PDF fit 1 MB', 'In your browser — free, no upload.'],
  },
  {
    file: 'free-spanish-paraphrasing-tool.html', lang: 'es', hreflang: true, crumb: 'Parafraseador en español', category: 'UtilitiesApplication',
    title: 'Parafraseador Gratis en Español — Sin Límite de Palabras',
    desc: 'Parafrasea textos en español gratis con IA: sin límite de palabras y sin registro. Pega tu texto o sube un Word, PDF o PowerPoint y conserva el formato.',
    app: 'ParaFree — parafraseador', appUrl: SITE + '?lang=spanish', embed: '/?embed=paraphraser&tool=paraphraser&lang=spanish', embedHeight: 560,
    tryLabel: 'Pruébalo aquí — parafrasea en español', openFull: 'Abrir la herramienta completa', loading: 'Cargando el parafraseador…',
    badge: 'Español · Gratis · Sin registro', h1: 'Parafraseador Gratis en Español — Sin Límite de Palabras',
    lede: 'Reescribe frases, párrafos o documentos completos en español con otras palabras, sin cambiar el sentido. Gratis y sin crear una cuenta.',
    cta: { href: '/?lang=spanish', text: 'Parafrasear en español' },
    define: 'ParaFree es un parafraseador gratuito con IA que reescribe textos en español sin límite de palabras y sin registro: pega el texto o sube un archivo Word, PDF o PowerPoint, y el formato de Word y PowerPoint se conserva.',
    updatedLabel: 'Actualizado', updatedText: '4 de noviembre de 2026',
    sections: [
      ['¿Cómo parafraseo un texto en español gratis?', '<p>Pega tu texto en el cuadro de arriba (el idioma ya está en español), elige un modo —Estándar mantiene tu tono; Formal y Simple cambian el registro— y pulsa Parafrasear. ParaFree cambia las palabras y la estructura de las frases, pero conserva los nombres, las cifras y las fechas. No hay límite de palabras ni registro.</p>'],
      ['¿Puedo parafrasear un documento de Word o un PowerPoint?', '<p>Sí. Sube el archivo .docx o .pptx en lugar de copiar el texto: ParaFree reescribe los párrafos y los vuelve a colocar en el mismo documento, así que los títulos, las fuentes, las tablas y el diseño de las diapositivas se mantienen. Los PDF también funcionan, pero su diseño no se puede reconstruir igual; si el formato importa, conviértelo antes a Word.</p>'],
      ['¿Parafrasear es plagio?', '<p>Parafrasear sin citar la fuente sigue siendo plagio. Usa la herramienta para mejorar la redacción de tus propios borradores, cita siempre las fuentes y revisa cada frase: una IA puede cambiar un matiz. Sigue también las normas de tu universidad sobre el uso de herramientas de IA.</p>'],
    ],
    howName: 'Cómo parafrasear en español en tres pasos',
    steps: [['Pega o sube', 'Pega el texto o sube un archivo Word, PDF o PowerPoint.'], ['Elige un modo', 'Estándar, Fluidez, Creativo, Formal o Simple.'], ['Revisa y descarga', 'Lee el resultado, corrige lo necesario y cópialo o descárgalo.']],
    faqTitle: 'Preguntas frecuentes',
    faq: [
      ['¿Es gratis?', 'Sí, es gratis, sin registro y sin marca de agua en las descargas.'],
      ['¿Hay límite de palabras?', 'No. Puedes pegar un ensayo completo o subir un documento largo; los textos muy largos tardan un poco más.'],
      ['¿Guarda mi texto?', 'No. El texto se envía a un proveedor de IA para reescribirlo y ParaFree no lo guarda.'],
      ['¿Funciona con español de España y de Latinoamérica?', 'Sí. La IA respeta el vocabulario del texto que pegas; revisa el resultado si necesitas una variante concreta.'],
    ],
    relatedTitle: 'Otras herramientas gratuitas',
    related: [['/?lang=spanish', 'Parafraseador', 'La herramienta completa en español'], ['/ai-humanizer.html', 'AI Humanizer', 'Texto más natural (en inglés)'], ['/grammar-checker.html', 'Grammar Checker', 'Corrector gramatical'],
      ['/pdf-to-word.html', 'PDF a Word', 'Convierte un PDF en un Word editable'], ['/free-portuguese-paraphrasing-tool.html', 'Parafraseador en portugués', 'Para textos en portugués'], ['/flashcard-quiz-maker.html', 'Flashcards y quiz', 'Tarjetas de estudio con IA']],
    ctaBox: ['Parafrasea en español, gratis', 'Sin límite de palabras y sin registro.'],
  },
  {
    file: 'free-portuguese-paraphrasing-tool.html', lang: 'pt', hreflang: true, crumb: 'Parafraseador em português', category: 'UtilitiesApplication',
    title: 'Parafraseador Grátis em Português — Sem Limite de Palavras',
    desc: 'Parafraseie textos em português grátis com IA: sem limite de palavras e sem cadastro. Cole o texto ou envie um Word, PDF ou PowerPoint e mantenha o formato.',
    app: 'ParaFree — parafraseador', appUrl: SITE + '?lang=portuguese', embed: '/?embed=paraphraser&tool=paraphraser&lang=portuguese', embedHeight: 560,
    tryLabel: 'Experimente aqui — parafraseie em português', openFull: 'Abrir a ferramenta completa', loading: 'Carregando o parafraseador…',
    badge: 'Português · Grátis · Sem cadastro', h1: 'Parafraseador Grátis em Português — Sem Limite de Palavras',
    lede: 'Reescreva frases, parágrafos ou documentos inteiros em português com outras palavras, sem mudar o sentido. Grátis e sem criar conta.',
    cta: { href: '/?lang=portuguese', text: 'Parafrasear em português' },
    define: 'ParaFree é um parafraseador gratuito com IA que reescreve textos em português sem limite de palavras e sem cadastro: cole o texto ou envie um arquivo Word, PDF ou PowerPoint, e a formatação de Word e PowerPoint é mantida.',
    updatedLabel: 'Atualizado', updatedText: '4 de novembro de 2026',
    sections: [
      ['Como parafrasear um texto em português de graça?', '<p>Cole o texto na caixa acima (o idioma já está em português), escolha um modo — Padrão mantém o seu tom; Formal e Simples mudam o registro — e clique em Parafrasear. O ParaFree troca as palavras e a estrutura das frases, mas mantém nomes, números e datas. Não há limite de palavras nem cadastro.</p>'],
      ['Posso parafrasear um documento do Word ou um PowerPoint?', '<p>Sim. Envie o arquivo .docx ou .pptx em vez de copiar o texto: o ParaFree reescreve os parágrafos e os coloca de volta no mesmo documento, então títulos, fontes, tabelas e o design dos slides continuam iguais. PDFs também funcionam, mas o layout não pode ser reconstruído igual; se a formatação importa, converta para Word antes.</p>'],
      ['Parafrasear é plágio?', '<p>Parafrasear sem citar a fonte continua sendo plágio. Use a ferramenta para melhorar a redação dos seus próprios rascunhos, cite sempre as fontes e revise cada frase: uma IA pode mudar um detalhe do sentido. Siga também as regras da sua instituição sobre o uso de IA.</p>'],
    ],
    howName: 'Como parafrasear em português em três passos',
    steps: [['Cole ou envie', 'Cole o texto ou envie um arquivo Word, PDF ou PowerPoint.'], ['Escolha um modo', 'Padrão, Fluência, Criativo, Formal ou Simples.'], ['Revise e baixe', 'Leia o resultado, ajuste o que for preciso e copie ou baixe.']],
    faqTitle: 'Perguntas frequentes',
    faq: [
      ['É grátis?', 'Sim — grátis, sem cadastro e sem marca d’água nos downloads.'],
      ['Tem limite de palavras?', 'Não. Você pode colar um trabalho inteiro ou enviar um documento longo; textos muito longos só demoram um pouco mais.'],
      ['O meu texto fica salvo?', 'Não. O texto é enviado a um provedor de IA para ser reescrito e o ParaFree não o guarda.'],
      ['Funciona com português do Brasil e de Portugal?', 'Sim. A IA respeita o vocabulário do texto que você cola; revise o resultado se precisar de uma variante específica.'],
    ],
    relatedTitle: 'Outras ferramentas grátis',
    related: [['/?lang=portuguese', 'Parafraseador', 'A ferramenta completa em português'], ['/free-spanish-paraphrasing-tool.html', 'Parafraseador em espanhol', 'Para textos em espanhol'], ['/grammar-checker.html', 'Grammar Checker', 'Corretor gramatical'],
      ['/pdf-to-word.html', 'PDF para Word', 'Converta um PDF em Word editável'], ['/compress-pdf.html', 'Comprimir PDF', 'Reduza o tamanho de um PDF'], ['/flashcard-quiz-maker.html', 'Flashcards e quiz', 'Cartões de estudo com IA']],
    ctaBox: ['Parafraseie em português, grátis', 'Sem limite de palavras e sem cadastro.'],
  },
  {
    file: 'free-chinese-paraphrasing-tool.html', lang: 'zh-Hans', hreflang: true, crumb: '中文改写工具', category: 'UtilitiesApplication',
    title: '免费中文改写工具 — 不限字数，无需注册 | ParaFree',
    desc: '免费用 AI 改写中文文本：不限字数，无需注册。粘贴文字或上传 Word、PDF、PowerPoint 文件，Word 和 PowerPoint 的格式保持不变。',
    app: 'ParaFree 改写工具', appUrl: SITE + '?lang=chinese', embed: '/?embed=paraphraser&tool=paraphraser&lang=chinese', embedHeight: 560,
    tryLabel: '在这里试用 — 用中文改写', openFull: '打开完整工具', loading: '正在加载改写工具…',
    badge: '中文 · 免费 · 无需注册', h1: '免费中文改写工具 — 不限字数',
    lede: '用不同的说法改写句子、段落或整篇文档，意思不变。完全免费，不用注册账号。',
    cta: { href: '/?lang=chinese', text: '开始中文改写' },
    define: 'ParaFree 是一个免费的 AI 改写（同义改写）工具，可以改写中文文本，不限字数、无需注册：粘贴文字或上传 Word、PDF、PowerPoint 文件，Word 和 PowerPoint 文件的格式会被保留。',
    updatedLabel: '更新日期', updatedText: '2026年11月4日',
    sections: [
      ['怎样免费改写一段中文？', '<p>把文字粘贴到上面的输入框（语言已设为中文），选择一种模式——“标准”保留你的语气，“正式”和“简单”会改变文风——然后点击改写。ParaFree 会换用不同的词语和句式，但保留人名、数字和日期。没有字数限制，也不需要注册。</p>'],
      ['可以改写 Word 文档或 PPT 吗？', '<p>可以。直接上传 .docx 或 .pptx 文件，而不是复制文字：ParaFree 改写段落后把新文字放回同一个文件，标题、字体、表格和幻灯片设计都保持不变。PDF 也可以上传，但它的版式无法原样重建；如果格式很重要，请先把 PDF 转成 Word。</p>'],
      ['改写算抄袭吗？', '<p>改写后不注明出处，仍然属于抄袭。请用这个工具润色你自己的草稿，始终引用原始来源，并逐句检查结果——AI 可能会改变细微的意思。同时请遵守你所在学校关于使用 AI 工具的规定。</p>'],
    ],
    howName: '三步完成中文改写',
    steps: [['粘贴或上传', '粘贴文字，或上传 Word、PDF、PowerPoint 文件。'], ['选择模式', '标准、流畅、创意、正式或简单。'], ['检查并下载', '阅读结果，修改需要调整的地方，然后复制或下载。']],
    faqTitle: '常见问题',
    faq: [
      ['真的免费吗？', '是的——免费，无需注册，下载的文件没有水印。'],
      ['有字数限制吗？', '没有。可以粘贴整篇论文或上传长文档；很长的文本只是需要多等一会儿。'],
      ['我的文字会被保存吗？', '不会。文字会发送给 AI 服务商进行改写，ParaFree 不会保存。'],
      ['支持繁体中文吗？', '可以改写繁体中文文本，但界面选项是“中文”；请检查结果是否保持了你需要的字体。'],
    ],
    relatedTitle: '其他免费工具',
    related: [['/?lang=chinese', '改写工具', '完整的中文改写工具'], ['/grammar-checker.html', 'Grammar Checker', '语法检查（英文）'], ['/pdf-to-word.html', 'PDF 转 Word', '把 PDF 转成可编辑的 Word'],
      ['/compress-pdf.html', '压缩 PDF', '减小 PDF 文件大小'], ['/flashcard-quiz-maker.html', '学习卡片和测验', '用 AI 制作学习卡片'], ['/ai-summarizer.html', 'AI Summarizer', '生成要点摘要']],
    ctaBox: ['免费中文改写', '不限字数，无需注册。'],
  },
  {
    file: 'free-filipino-paraphrasing-tool.html', lang: 'fil', hreflang: true, crumb: 'Paraphrasing tool sa Filipino', category: 'UtilitiesApplication',
    title: 'Libreng Paraphrasing Tool sa Filipino — Walang Word Limit',
    desc: 'Mag-paraphrase ng tekstong Filipino o Tagalog nang libre gamit ang AI: walang word limit at walang sign-up. Mag-paste o mag-upload ng Word, PDF o PowerPoint.',
    app: 'ParaFree paraphraser', appUrl: SITE + '?lang=tagalog', embed: '/?embed=paraphraser&tool=paraphraser&lang=tagalog', embedHeight: 560,
    tryLabel: 'Subukan dito — mag-paraphrase sa Filipino', openFull: 'Buksan ang buong tool', loading: 'Nilo-load ang paraphraser…',
    badge: 'Filipino · Libre · Walang sign-up', h1: 'Libreng Paraphrasing Tool sa Filipino — Walang Word Limit',
    lede: 'Isulat muli ang pangungusap, talata o buong dokumento sa ibang salita nang hindi nababago ang kahulugan. Libre at hindi kailangang gumawa ng account.',
    cta: { href: '/?lang=tagalog', text: 'Mag-paraphrase sa Filipino' },
    define: 'Ang ParaFree ay libreng AI paraphrasing tool na nagsusulat muli ng tekstong Filipino (Tagalog) nang walang word limit at walang sign-up: i-paste ang teksto o mag-upload ng Word, PDF o PowerPoint, at nananatili ang format ng Word at PowerPoint.',
    updatedLabel: 'Na-update', updatedText: 'Nobyembre 4, 2026',
    sections: [
      ['Paano mag-paraphrase ng tekstong Filipino nang libre?', '<p>I-paste ang teksto sa kahon sa itaas (Tagalog na ang wika), pumili ng mode — pinapanatili ng Standard ang iyong tono, at binabago ng Formal at Simple ang istilo — at pindutin ang Paraphrase. Binabago ng ParaFree ang mga salita at ayos ng pangungusap, pero hindi ginagalaw ang mga pangalan, numero at petsa. Walang word limit at walang sign-up.</p>'],
      ['Puwede ba ang Word document o PowerPoint?', '<p>Oo. I-upload ang .docx o .pptx file sa halip na kopyahin ang teksto: isinusulat muli ng ParaFree ang mga talata at ibinabalik sa parehong file, kaya nananatili ang mga heading, font, table at disenyo ng slides. Puwede rin ang PDF, pero hindi maibabalik nang eksakto ang layout nito; kung mahalaga ang format, i-convert muna sa Word.</p>'],
      ['Plagiarism ba ang pag-paraphrase?', '<p>Plagiarism pa rin ang pag-paraphrase kung hindi mo binabanggit ang pinagmulan. Gamitin ang tool para pagandahin ang sarili mong draft, laging i-cite ang source, at basahin ang bawat pangungusap — puwedeng mabago ng AI ang isang detalye ng kahulugan. Sundin din ang patakaran ng iyong paaralan tungkol sa AI.</p>'],
    ],
    howName: 'Paano mag-paraphrase sa Filipino sa tatlong hakbang',
    steps: [['Mag-paste o mag-upload', 'I-paste ang teksto o mag-upload ng Word, PDF o PowerPoint.'], ['Pumili ng mode', 'Standard, Fluency, Creative, Formal o Simple.'], ['Suriin at i-download', 'Basahin ang resulta, ayusin kung kailangan, at kopyahin o i-download.']],
    faqTitle: 'Mga madalas itanong',
    faq: [
      ['Libre ba ito?', 'Oo — libre, walang sign-up, at walang watermark ang mga download.'],
      ['May word limit ba?', 'Wala. Puwede kang mag-paste ng buong essay o mag-upload ng mahabang dokumento; mas matagal lang nang kaunti ang mahahabang teksto.'],
      ['Itinatago ba ang teksto ko?', 'Hindi. Ipinapadala ang teksto sa isang AI provider para isulat muli at hindi ito itinatago ng ParaFree.'],
      ['Puwede ba ang Taglish?', 'Oo. Sinusunod ng AI ang halo ng wika sa tekstong ipinaste mo; suriin ang resulta kung gusto mong purong Filipino o purong English.'],
    ],
    relatedTitle: 'Iba pang libreng tool',
    related: [['/?lang=tagalog', 'Paraphraser', 'Ang buong tool sa Filipino'], ['/free-paraphrasing-tool-philippines.html', 'Paraphrasing tool sa Pilipinas', 'Para sa mga estudyante sa Pilipinas'], ['/grammar-checker.html', 'Grammar Checker', 'Para sa English na teksto'],
      ['/jpg-to-pdf-for-assignment.html', 'JPG to PDF para sa assignment', 'Isang PDF mula sa mga litrato'], ['/compress-pdf.html', 'Compress PDF', 'Paliitin ang PDF'], ['/flashcard-quiz-maker.html', 'Flashcards at quiz', 'Study cards gamit ang AI']],
    ctaBox: ['Mag-paraphrase sa Filipino, libre', 'Walang word limit at walang sign-up.'],
  },
];

for (const p of PAGES) {
  fs.writeFileSync(path.join(ROOT, p.file), page(p).replace(/\n/g, '\r\n'));
  console.log('wrote ' + p.file);
}

// hreflang: every language page lists the whole cluster (plus en / x-default); regional variants are kept
for (const f of Object.values(LANG_PAGES)) {
  const file = path.join(ROOT, f);
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n');
  const have = new Set([...s.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => m[1] + ' ' + m[2]));
  const add = [];
  for (const [l, pf] of Object.entries(LANG_PAGES)) if (!have.has(l + ' ' + SITE + pf)) add.push(`<link rel="alternate" hreflang="${l}" href="${SITE}${pf}">`);
  if (!have.has('en ' + SITE)) add.push(`<link rel="alternate" hreflang="en" href="${SITE}">`);
  if (!have.has('x-default ' + SITE)) add.push(`<link rel="alternate" hreflang="x-default" href="${SITE}">`);
  if (add.length) {
    s = s.replace(/(<link rel="canonical"[^>]*>\n)/, `$1${add.join('\n')}\n`);
    fs.writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s);
    console.log(`hreflang +${add.length}: ${f}`);
  }
}
