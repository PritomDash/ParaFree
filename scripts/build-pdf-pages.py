"""Builds the six PDF tool landing pages (pdf-to-word.html, word-to-pdf.html, jpg-to-pdf.html,
compress-pdf.html, merge-pdf.html, pdf-to-jpg.html) and three task pages that open one of those tools with
its options set (compress-pdf-to-100kb.html, compress-pdf-to-200kb.html, jpg-to-pdf-for-assignment.html) from one shell, so nav, footer, scripts and JSON-LD stay identical.
Each page embeds the real tool (lib/pdf-tools, same modules as pdf-tools.html) opened on its own tab.
    python scripts/build-pdf-pages.py
then: node tests/pdf-tools-version.js --write   (stamps ?v= on the lib/pdf-tools URLs)
"""
import html, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://parafree.app'
ENTITY = ('ParaFree is a free AI writing suite with a document paraphraser that keeps formatting, a CV builder with '
          'ATS-readable PDFs, and in-browser PDF tools (PDF to Word, Word to PDF, JPG to PDF, PDF to JPG, compress and merge).')
SPEED = 'No upload, no waiting — your file is processed on your device.'
TOOLS = [  # slug (= page and tab id), short name, emoji
    ('pdf-to-word', 'PDF to Word', '📄'), ('word-to-pdf', 'Word to PDF', '📝'), ('jpg-to-pdf', 'JPG to PDF', '🖼'),
    ('compress-pdf', 'Compress PDF', '🗜'), ('merge-pdf', 'Merge PDF', '➕'), ('pdf-to-jpg', 'PDF to JPG', '🖼'),
]
LIMIT_COMMON = '50 MB per file, 200 MB per task'
UPDATED = 'October 22, 2026'                      # shown as "Last updated" on every page
L = lambda href, text: f'<a href="{href}">{text}</a>'

PAGES = {
'pdf-to-word': dict(
  title='Free PDF to Word Converter — Editable, Keeps Fonts & Columns | No Signup',
  desc='Convert PDF to an editable Word file free: text, headings, fonts, lists, tables and two-column layouts carry across, scanned pages are read with OCR. No signup, no watermark, runs in your browser.',
  h1='Free PDF to Word Converter',
  lead='Turn a PDF into an editable Word document (.docx) — text, headings, bold and italic, fonts, lists, tables, images and two-column layouts carry across, and scanned pages are read with OCR. Free, no signup, no watermark.',
  limits=LIMIT_COMMON + '; up to 50 pages per conversion',
  steps=['Choose your PDF (or drag it into the box).', 'Wait while each page is read — scanned pages go through OCR, which takes a little longer.',
         'Check the result in the editor and fix anything you like.', 'Download the Word file (.docx).'],
  sections=[
    ('PDF to Word without losing formatting', [
      'Most of the time you want the Word file to look like the PDF, not just contain the same words. The converter reads each page and rebuilds it as real Word content: headings stay headings, bold and italic stay bold and italic, bullet and numbered lists become Word lists, and tables become Word tables you can edit cell by cell.',
      'Font families and sizes are carried across where the PDF names them, so a heading in a large serif font stays large and serif. If the PDF uses a font your computer does not have, Word shows a similar font instead — the text and its size are still right.',
      'Pages with complex layouts, such as forms, text boxes placed on top of images or heavily designed posters, may not match the original exactly. That is true of every PDF converter, because a PDF stores where each letter is drawn, not how the document was built. Look over the result before you submit it.']),
    ('Scanned PDF to Word (OCR)', [
      'A scanned PDF, or a PDF made from phone photos, has no real text inside — each page is a picture. When the converter finds a page like that, it reads it with OCR (optical character recognition) right in your browser and turns it into text you can edit.',
      'OCR is most accurate on clear, straight, printed English text. Handwriting, very small print, coloured backgrounds and other languages are read less accurately or not at all, so read the result carefully. A sharper scan gives a much better result than a blurry one.']),
    ('PDF to editable Word for assignments', [
      'Students often get a PDF they need to change: an assignment template, an old report you want to update, a handout you want to annotate, or your own work that survived just as a PDF. Converting it to Word lets you edit it in Word, Google Docs or LibreOffice like any other document.',
      'If you want to reword the text as well, use the <strong>Paraphrase the Word file</strong> button that appears after the conversion. It sends the new Word file straight to ParaFree’s document paraphraser, which keeps the formatting while it rewrites the text — always check the rewritten text and cite your sources.']),
    ('Two-column research papers', [
      'Journal articles and conference papers are usually set in two columns. A simple converter reads straight across the page and mixes the two columns into nonsense. This converter detects columns and keeps them in reading order, so the left column comes first and the right column second, each as normal paragraphs.',
      'Equations, footnotes and figure captions are kept as text where the PDF stores them as text. Complicated equations may need tidying by hand.']),
    ('PDF to Word on your phone', [
      'The converter works in the browser on Android phones and iPhones, so you can turn a PDF from your email or downloads into a Word file without installing an app. Choose the file, wait for the pages to be read and download the .docx — open it in Word, Google Docs or WPS Office on the phone.',
      'Long or scanned PDFs take longer on a phone than on a laptop, because the work is done on the device itself. ' + SPEED]),
    ('What it can and can’t do', [
      'It handles the PDFs students meet most: typed assignments, reports, journal articles, lecture handouts and scans of printed pages. It keeps the order of the text, headings, lists, tables, images and the look of the fonts, and it gives you an editor to fix anything before you download.',
      'Edited the Word file and need a PDF again for submission? ' + L('/word-to-pdf.html', 'Turn the .docx back into a PDF') + ', and if it is over the portal’s size limit, ' + L('/compress-pdf.html', 'shrink the PDF to a target size') + ' before you upload it.',
      'It does not rebuild page furniture such as text boxes floating over images, form fields, comments or tracked changes, and its OCR reads English. Password-protected PDFs need the password removed first. Each conversion handles up to 50 pages — split a longer PDF and convert it in parts.']),
    ('Why your PDF stays on your device', [
      'Many online converters upload your file to a server, convert it there and send it back. That means waiting for the upload and trusting someone else with your work. Here the conversion runs in your browser tab: ' + SPEED,
      'The tool’s code comes from ParaFree and a public CDN the first time you use it; after that it is cached by your browser. Nothing you convert is stored, and closing the tab clears it.']),
  ],
  faq=[
    ('Is this PDF to Word converter free?', 'Yes. It is free with no signup, no watermark and no daily limit. Each conversion can be up to 50 pages and 50 MB.'),
    ('Will the Word file keep my fonts and columns?', 'Font families and sizes are kept where the PDF names them, and two-column pages are kept in reading order. Very complex layouts such as forms or designed posters may not match exactly, so check the file before you use it.'),
    ('Can it convert a scanned PDF?', 'Yes. Pages without a text layer are read with OCR in your browser. OCR is most accurate on clear, printed English text; handwriting and other languages are read less accurately.'),
    ('Is my PDF uploaded anywhere?', 'No. ' + SPEED + ' The page downloads the free open-source code it needs the first time you use it; your file is not part of that.'),
    ('Can I reword the converted document?', 'Yes. After converting, use “Paraphrase the Word file” to open it in ParaFree’s document paraphraser, which keeps the formatting while it rewrites the text.'),
    ('Why are some lines in a different order?', 'A PDF stores where each word is drawn, not the reading order. The converter rebuilds the order from the layout, including two-column pages; unusual layouts such as text boxes or sidebars can still come out in a different order, so read through the result.'),
    ('How do I convert a PDF to Word without losing formatting for free?', 'Upload it to ParaFree’s PDF to Word converter: it rebuilds headings, fonts, lists, tables, images and two-column pages as real Word content, free and in your browser. Check the result in the built-in editor before you download the .docx.'),
    ('Can I convert a PDF to Word on my phone without an app?', 'Yes. Open the PDF to Word page in your phone’s browser, choose the PDF and download the .docx. Long or scanned PDFs take longer on a phone, because the work happens on the device.'),
    ('How do I edit a scanned PDF in Word?', 'Convert it with PDF to Word: pages without a text layer are read with OCR (English) in your browser and become editable text. Read the result carefully, as OCR can misread unclear print.'),
  ]),
'word-to-pdf': dict(
  title='Free Word to PDF Converter — DOCX to PDF for Assignment Submission',
  desc='Convert a Word document (.docx) to PDF free for Moodle, Canvas or Turnitin uploads. Fonts, images and tables kept, text stays selectable. No signup, no watermark, runs in your browser.',
  h1='Free Word to PDF Converter',
  lead='Turn a Word document (.docx) into a PDF for assignment submission — fonts, headings, images and tables kept, with real selectable text. Free, no signup, no watermark.',
  limits=LIMIT_COMMON + '; .docx files',
  steps=['Choose your Word file (.docx).', 'Check the preview — you can fix a last typo right there.',
         'Click “Download PDF”, or use “Print / Save as PDF” if you prefer your browser’s own PDF.', 'Upload the PDF to your course portal.'],
  sections=[
    ('DOCX to PDF for Moodle, Canvas and Turnitin uploads', [
      'Many course portals ask for a PDF so your work looks the same on every computer. Moodle, Canvas, Blackboard and Turnitin all accept PDFs, and a PDF with real, selectable text is the safest kind: the marker can search it, and similarity checkers can read it.',
      'This converter makes exactly that — a PDF whose text you can select and copy, not a picture of your pages. Upload your .docx, check the preview and download the PDF. Before you submit, open the PDF once and check the page count and the first and last pages.']),
    ('Keeps fonts, images and tables', [
      'Headings, bold and italic, font sizes, bullet and numbered lists, tables and images are carried into the PDF. Pages are A4 or Letter, as set in the document.',
      'Fonts are embedded so the PDF looks the same everywhere: each piece of text uses the closest of three built-in font families — a sans-serif, a serif or a monospace font — at the size you set. If the exact font matters, use “Print / Save as PDF”: your browser then draws the document with the fonts installed on your device.']),
    ('Bengali, Hindi and Arabic documents', [
      'Scripts such as Bengali, Hindi (Devanagari) and Arabic need special letter shaping that the built-in PDF writer does not do. For these documents the tool uses the print method: it opens your document in a print view and you choose “Save as PDF” as the printer. The browser shapes the text correctly, and the PDF keeps real, selectable text.',
      'The same applies to Chinese, Japanese and Korean. Check the saved PDF once — especially line breaks in mixed-language documents.']),
    ('Word to PDF on your phone', [
      'On an Android phone or iPhone, choose the .docx from your files, downloads or email attachment, check the preview and download the PDF. On iPhone, look for the PDF in the Files app under Downloads.',
      SPEED + ' That also means it works on slow connections once the page has loaded.']),
    ('Check your PDF before you submit', [
      'Open the PDF once before you upload it. Check that the page count is what you expect, that tables and images did not move to the next page in an awkward place, and that footnotes and page numbers are there. The preview in the tool shows each page so you can catch problems first.',
      'Track changes and comments are not included in the PDF — accept or remove them in Word first so the PDF shows the final text. Fields such as a table of contents show the text they last displayed in Word, so update them in Word before converting.']),
    ('What it can and can’t do', [
      'It converts .docx files with headings, styles, lists, tables, images, page breaks and headers or footers, and gives a PDF with real text. It does not convert old .doc files, macros, embedded videos or form controls.',
      'Very long documents with many images take longer, because the PDF is made on your device. ' + SPEED]),
    ('Why submit a PDF instead of a Word file?', [
      'A Word file can look different on the marker’s computer: a missing font, a different version of Word or another page size can move headings, push a table onto the next page or change the page count. A PDF fixes the layout, so what you checked is what they see.',
      'A PDF also cannot be changed by accident after you submit it, opens on any device without Word, and is usually smaller than the .docx with its images. Keep the .docx too — it is the file you edit if you need to make changes later.',
      'If the course wants one file with a cover sheet or declaration in front, ' + L('/merge-pdf.html', 'merge the PDFs in the right order') + '; if the portal has a size limit, ' + L('/compress-pdf.html', 'compress the PDF under that limit') + '.']),
  ],
  faq=[
    ('Is the Word to PDF converter free?', 'Yes. It is free, with no signup and no watermark. Files can be up to 50 MB.'),
    ('Will Turnitin or Moodle accept the PDF?', 'The PDF has real, selectable text, which is what course portals and similarity checkers expect. Always check your course’s own upload rules, such as file size limits.'),
    ('Does it keep my fonts?', 'Sizes, bold, italic and layout are kept, and each font is matched to the closest built-in sans-serif, serif or monospace font. Use “Print / Save as PDF” to keep the exact fonts installed on your device.'),
    ('Can it convert Bengali, Hindi or Arabic documents?', 'Yes, through the print method: the document opens in a print view and you save it as a PDF from your browser, which shapes these scripts correctly.'),
    ('Can I convert .doc files?', 'No — .docx files. Open an old .doc in Word, LibreOffice or Google Docs and save it as .docx first.'),
    ('Why does my PDF have a different number of pages?', 'Fonts are matched to built-in fonts, which can be slightly wider or narrower than yours, so a line or a picture can move to the next page. Check the preview, or use “Print / Save as PDF” to use your own fonts.'),
    ('How do I convert a Word document to PDF for free without Microsoft Word?', 'Upload the .docx to ParaFree’s Word to PDF converter in any browser and download a PDF with selectable text — no Word installation, signup or watermark needed.'),
    ('How do I make a PDF from a .docx for Turnitin or Moodle?', 'Convert the .docx with Word to PDF, open the PDF once to check the page count and layout, then upload it. The PDF has real, selectable text, which is what course portals and similarity checkers expect.'),
    ('Can I convert Word to PDF on an iPhone?', 'Yes. Choose the .docx in Safari or Chrome, check the preview and download; the PDF is in the Files app under Downloads.'),
  ]),
'jpg-to-pdf': dict(
  title='Free JPG to PDF — Combine Photos of Notes into One PDF',
  desc='Turn phone photos of handwritten notes, worksheets and screenshots into one PDF free. JPG, PNG and WebP, A4 or Letter pages, photos turned upright automatically. No signup, no watermark.',
  h1='Free JPG to PDF Converter',
  lead='Combine photos of your notes, worksheets and screenshots into one PDF, in the order you choose — JPG, PNG and WebP, on A4 or Letter pages. Free, no signup, no watermark.',
  limits=LIMIT_COMMON + '; JPG, PNG and WebP images',
  steps=['Choose your photos — several at once is fine.', 'Drag them (or use the arrows) into the right order.',
         'Pick A4 or Letter and the page orientation.', 'Click “Create PDF” and download it.'],
  sections=[
    ('Handwritten notes photos to PDF', [
      'Photographed your handwritten notes, a whiteboard or a printed worksheet? Many teachers and portals want one PDF, not ten separate photos. Choose the photos, put them in order and create a single PDF with one photo per page.',
      'For the clearest result, photograph each page flat, in good light, filling most of the frame. The tool does not straighten tilted pages or remove shadows, so a careful photo makes a better PDF.',
      'Handing in homework this way? ' + L('/jpg-to-pdf-for-assignment.html', 'The assignment version of this tool') + ' opens with A4 portrait pages and small margins already set. If the typed part of the assignment is a separate PDF, ' + L('/merge-pdf.html', 'merge it with the photo PDF') + ' so you upload one file.']),
    ('Multiple images to one PDF', [
      'You can choose many images in one go. Each image becomes its own page, scaled to fit the page with no, a small or a large margin. Drag the images into order, or use the up and down arrows, and remove any you picked by mistake with ✕ before you create the PDF.',
      'Very large photos are scaled down to 3,000 pixels on the long side, which is still sharp when printed, and keeps the PDF a sensible size. If the PDF is still too big for an upload limit, ' + L('/compress-pdf.html', 'compress the finished PDF to a target size') + '.']),
    ('PNG and screenshots', [
      'Screenshots of online quizzes, receipts or slides are usually PNG files. They work just like photos: PNG images stay lossless, so text in a screenshot stays crisp. WebP images, common from websites, are converted to PNG inside the PDF.',
      'iPhone HEIC photos are not supported yet. Most iPhones save JPG when you share or export a photo, or you can set Camera → Formats → Most Compatible.']),
    ('A4 from phone photos — and auto-rotate', [
      'Phone photos come in many shapes. Choose A4 or Letter — or “Fit to image” for pages exactly the size of each photo — and portrait, landscape or auto orientation. Each photo is fitted onto the page without being stretched or cropped.',
      'Phones store which way up a photo was taken in a hidden tag. The tool reads it and turns every photo the right way up, so portrait shots of your notes are not sideways in the PDF. ' + SPEED]),
    ('Tips for clear photos of notes', [
      'Photograph pages one at a time, straight from above, in daylight or under an even light. Fill the frame with the page and tap to focus on the writing. Dark or blurry photos stay dark or blurry in the PDF — the tool does not enhance them.',
      'Name or order your photos before you start, then check the order in the list. For a long set of notes, make the PDF in sections and merge them afterwards with Merge PDF.']),
    ('What it can and can’t do', [
      'It makes a clean PDF from your images, one image per page, upright, at the page size and margin you choose. It does not crop, straighten, remove shadows or turn the handwriting into typed text.',
      'If you need the text, convert the finished PDF with PDF to Word, which reads printed English with OCR (handwriting is read poorly). ' + SPEED]),
    ('Documents for applications', [
      'Scholarship, job and visa forms often ask for copies of certificates, transcripts or ID pages as one PDF. Photograph each page flat, put them in the order the form asks for and create the PDF. Use “Fit to image” if you want the pages exactly the size of your photos, or A4 if the form expects printable pages.',
      'Forms usually have a size limit as well. If the PDF is too big, open Compress PDF and choose a target size such as 500 KB or 1 MB. Check that every page is still easy to read before you upload it.']),
    ('Group work and shared notes', [
      'When everyone in a study group photographs their own pages, collect the photos, put them in order once and make a single PDF to share. One file is easier to send, print and search than a folder of photos.',
      'If some parts are already PDFs, make a PDF from the photos first, then join everything with Merge PDF in the order you want.']),
  ],
  faq=[
    ('Is JPG to PDF free?', 'Yes. It is free, with no signup and no watermark, for as many images as fit in 200 MB per PDF.'),
    ('Which image types can I use?', 'JPG, PNG and WebP. iPhone HEIC photos are not supported yet — share or export them as JPG first.'),
    ('Will my photos be the right way up?', 'Yes. The tool reads the orientation your phone saved and turns each photo upright automatically.'),
    ('Can I choose the page size?', 'Yes — A4, Letter or “Fit to image”, with portrait, landscape or automatic orientation and a choice of margins. Each photo is fitted to the page without stretching.'),
    ('Are my photos uploaded?', 'No. ' + SPEED),
    ('Can I turn the PDF into editable text?', 'Not directly — each page is an image. Run the PDF through PDF to Word, which reads clear printed English with OCR; handwriting is read much less accurately.'),
    ('How do I combine multiple photos into one PDF for free?', 'Choose all the photos in ParaFree’s JPG to PDF tool, drag them into order and click Create PDF — each photo becomes one page, with no signup or watermark.'),
    ('How do I turn photos of handwritten notes into a PDF on my phone?', 'Open the JPG to PDF page in your phone’s browser, pick the photos from your gallery, put them in order and create the PDF. Photos are turned the right way up automatically.'),
    ('Can I convert iPhone HEIC photos to PDF?', 'Not directly — HEIC is not supported yet. Share or export the photos as JPG (or set Camera → Formats → Most Compatible), then convert them.'),
  ]),
'compress-pdf': dict(
  title='Compress PDF to 100KB, 200KB, 500KB or 1MB — Free, No Signup',
  desc='Compress a PDF to a target size — 100 KB, 200 KB, 500 KB, 1 MB, 2 MB or your own — for university, job and form upload limits. Free, no signup, no watermark, and your file stays on your device.',
  h1='Compress PDF to a Target Size',
  lead='Shrink a PDF to fit an upload limit — pick 100 KB, 200 KB, 500 KB, 1 MB, 2 MB or type your own size. Free, no signup, no watermark, and you always see the size before and after.',
  limits=LIMIT_COMMON + '; up to 300 pages',
  steps=['Choose your PDF.', 'Pick a mode: Light, Strong, or Target size with the limit you need.',
         'Click “Compress PDF” and read the result: the new size, and whether the text is still selectable.', 'Download the compressed PDF.'],
  sections=[
    ('Upload limits on university and job portals', [
      'Assignment portals, job application sites and scholarship forms often cap uploads at 1 MB, 2 MB or 5 MB, and a PDF full of photos or scans is easily bigger. Choose “Target size”, pick the limit and the tool does the rest.',
      'It tries Light compression first, because that keeps your text selectable. If that is not small enough, it switches to Strong and searches for the highest quality that still fits under your target. Sizes use 1 MB = 1,000,000 bytes, as most upload pages count them.']),
    ('Government and application form size limits', [
      'Online application forms often ask for scanned documents — certificates, ID pages, letters — under a small limit such as 100 KB, 200 KB or 500 KB. Pick the matching target. A one-page scan usually fits under 200 KB; many pages may not fit under a very small limit at a readable quality.',
      'If a target cannot be reached, the tool says so plainly and offers the smallest version it could make, with its size. Then you can remove pages you don’t need, upload pages separately, or scan at a lower resolution.',
      'There are step-by-step pages for the two most common limits: ' + L('/compress-pdf-to-100kb.html', 'getting a scanned form under 100 KB') + ' and ' + L('/compress-pdf-to-200kb.html', 'getting a CV or application PDF under 200 KB') + '.']),
    ('Compress scanned PDFs', [
      'Scanned PDFs are big because every page is a photo. Light mode resizes those photos to about 150 DPI at the size they are shown — sharp on screen and in print — and saves them as efficient JPEG. That alone often makes a scanned PDF several times smaller.',
      'Strong mode turns every page into one image at a lower resolution. That gives the smallest file, but the text can no longer be selected or searched.',
      'If your “scan” is really a set of phone photos, ' + L('/jpg-to-pdf.html', 'turn the photos into one PDF') + ' first. Several documents for the same form can be ' + L('/merge-pdf.html', 'merged into a single PDF') + ' and then compressed together.']),
    ('Keep text selectable (Light)', [
      'Light mode changes images and nothing else. Text, links and vector graphics are left exactly as they were, so the text stays selectable and searchable — important for applicant tracking systems, similarity checkers and screen readers. If Light cannot make the file smaller, the tool tells you and offers your original instead.',
      'Target size uses Light whenever Light is enough, and the result always tells you which method was used.']),
    ('Compress a PDF on your phone', [
      'It works in the browser on Android and iPhone. Choose the PDF from your files or downloads, pick a target and download the smaller file — no app needed.',
      SPEED + ' Large scanned PDFs take longer on a phone than on a laptop because the phone does the work.']),
    ('Light, Strong and Target size — which to choose', [
      '<strong>Light</strong> keeps everything except oversized images, so the PDF looks the same and its text stays selectable. Use it first. <strong>Strong</strong> turns each page into one image: smallest file, but no selectable or searchable text. <strong>Target size</strong> chooses for you — Light if that is small enough, otherwise Strong at the highest quality that fits.',
      'For a CV or anything read by an applicant tracking system, keep the text selectable: use Light, or a target that Light can reach. For scans and photo-heavy coursework, Strong or a target size is usually fine.']),
    ('What it can and can’t do', [
      'It shrinks images and, if needed, rebuilds pages as images. It does not remove pages, fonts or attachments for you, and a PDF that is mostly text is often already as small as it can be — the tool tells you when that happens.',
      'Very small targets for long documents may not be reachable at a readable quality; the tool stops at about 72 DPI rather than make pages unreadable, and tells you the smallest size it reached. ' + SPEED]),
  ],
  faq=[
    ('Can I compress a PDF to exactly 100 KB or 200 KB?', 'You can set a target and the tool makes the file as good as possible while staying under it. It cannot always reach very small targets for long or detailed PDFs; then it tells you and offers the smallest version it made.'),
    ('Will my text stay selectable?', 'Yes with Light mode, and with Target size whenever Light is enough. Strong mode turns pages into images, so the text is no longer selectable; the result always tells you which was used.'),
    ('Is compressing a PDF free?', 'Yes. It is free with no signup and no watermark. Files can be up to 50 MB and 300 pages.'),
    ('Is my PDF uploaded to a server?', 'No. ' + SPEED),
    ('Why did my PDF not get smaller?', 'If a PDF is mostly text, or its images are already small, there is little to remove. The tool then says it is already well compressed and offers your original file.'),
    ('How does Target size decide?', 'It tries Light first. If that is still above your target, it rebuilds the pages as images and searches for the highest resolution and quality that stays under the target, down to about 72 DPI. If even that is too big, you get the smallest version and a clear message.'),
    ('Can I compress a PDF to under 100 KB on my phone?', 'Often, yes: choose Target size → 100 KB on the Compress PDF page in your phone’s browser. Text PDFs of a few pages usually fit; long scans may not, and the tool then tells you the smallest size it reached.'),
    ('How do I reduce a PDF’s size without losing quality?', 'Use Light mode first: it shrinks large images to about 150 DPI and keeps text, vector graphics and fonts exactly as they were, so text stays sharp and selectable.'),
    ('How do I compress a PDF for a job application?', 'Pick a target such as 200 KB or 1 MB. Light mode is tried first, so the text in your CV stays selectable for applicant tracking systems.'),
  ]),
'merge-pdf': dict(
  title='Merge PDF Files Free — Combine Assignment, Cover Sheet & Appendix',
  desc='Merge PDF files into one free: put your cover sheet, assignment and appendix together, or join lecture slides into one study pack. Reorder by drag and drop. No signup, no watermark.',
  h1='Merge PDF Files Free',
  lead='Combine PDFs into one file — a cover sheet, your assignment and an appendix, or a term of lecture slides — in the order you choose. Free, no signup, no watermark.',
  limits=LIMIT_COMMON + '; up to 300 pages in the merged PDF',
  steps=['Choose two or more PDFs.', 'Drag them (or use the arrows) into the right order.',
         'Click “Merge PDFs”.', 'Download the merged PDF and check the page order.'],
  sections=[
    ('Combine PDFs for assignment submission', [
      'Many courses want one file: a signed cover sheet or declaration first, then your assignment, then appendices or a reference list exported separately. Choose the PDFs, put them in that order and merge them into a single PDF ready to upload.',
      'Pages are copied exactly as they are, so text stays selectable. Page sizes are kept too, so an A4 assignment and a Letter cover sheet each keep their own size.']),
    ('Merge lecture slides into one study pack', [
      'Downloaded a PDF of slides for every week? Merge them into one file in week order, and you can search the whole term at once and print it as a single document.',
      'If the merged file is too big to email or upload, compress it afterwards with a target size.']),
    ('Reorder the files', [
      'After choosing your files you see them in a list. Drag a file to move it, or use the up and down arrows, which also work well on a phone. Remove a file with its × button. The merged PDF follows the order of the list exactly.',
      'Password-protected PDFs cannot be merged until the password is removed — the tool tells you which file it is.']),
    ('Merge PDFs on your phone', [
      'It works in the browser on Android and iPhone: choose the PDFs from your files, arrange them with the arrows and merge. ' + SPEED,
      'Very large merges (hundreds of pages) take longer on a phone, and the merged PDF is limited to 300 pages.']),
    ('Tips before you merge', [
      'Name your files so you can tell them apart in the list, for example “1 cover”, “2 essay”, “3 appendix”. Check that each file is the final version — merging does not change the pages, so a typo in one file stays in the merged PDF.',
      'If your course asks for a specific order, such as declaration first and references last, set it in the list before you merge, then scroll through the merged PDF once to confirm it.',
      'Still have one part as a Word file? ' + L('/word-to-pdf.html', 'Convert the .docx to PDF') + ' first, then add it to the list. If the merged file is too large to upload, ' + L('/compress-pdf.html', 'compress it to the portal’s limit') + '.']),
    ('What it can and can’t do', [
      'It joins whole PDFs in the order you choose and keeps each page exactly as it was, including its size and selectable text. It does not pick out single pages, rotate pages or remove pages — merge first, then use another tool if you need those.',
      'Password-protected PDFs must be unlocked first, and the merged file is limited to 300 pages and 200 MB in total. ' + SPEED]),
    ('Mixing scans and typed documents', [
      'You can merge any PDFs together: a typed essay exported from Word, a scanned signed declaration and a PDF of photos made with JPG to PDF. Each page keeps its own content and size — a scanned page stays an image and a typed page keeps selectable text.',
      'If the merged file ends up too large for the upload limit, the scanned pages are usually the reason. Compress the merged PDF with a target size, or compress the scan alone with Light before merging so the typed pages are not touched.']),
    ('Group projects', [
      'In a group assignment, each person often writes a part in their own file. Ask everyone to export their part as a PDF, put the parts in order with the title page first, and merge them into the one file you submit.',
      'Check the merged PDF for consistent page sizes and that nobody’s pages are missing before the deadline. Page numbers printed inside each part stay as they were, because merging does not change the pages.']),
  ],
  faq=[
    ('Is merging PDFs free?', 'Yes. It is free with no signup and no watermark.'),
    ('Can I change the order of the files?', 'Yes. Drag files into order or use the arrows; the merged PDF follows the list exactly.'),
    ('Will the merged PDF keep selectable text?', 'Yes. Pages are copied as they are, so text stays selectable and page sizes are kept.'),
    ('How many files can I merge?', 'As many as fit in 200 MB, with up to 300 pages in the merged PDF.'),
    ('Are my files uploaded?', 'No. ' + SPEED),
    ('Can I merge some of the pages of a PDF?', 'Not yet — whole files are merged. Save the pages you need as a separate PDF first, then merge.'),
    ('How do I combine a cover sheet and an assignment into one PDF for free?', 'Choose both PDFs in Merge PDF, put the cover sheet first and click Merge — you get one PDF with every page unchanged, free and without signup.'),
    ('Can I merge PDFs on my phone?', 'Yes. Choose the PDFs from your files in the phone’s browser, set the order with the arrows and merge; nothing is uploaded.'),
    ('Will merging make my PDF too big to upload?', 'The merged PDF is about the sizes of the parts added together. If it is over the limit, compress it with a target size before you upload.'),
  ]),
'pdf-to-jpg': dict(
  title='Free PDF to JPG Converter — Convert PDF Pages to Images | No Signup',
  desc='Convert PDF pages to JPG or PNG images free: pick the pages, choose the quality, download one image or a ZIP. Runs in your browser — no signup, no watermark, nothing uploaded.',
  h1='Free PDF to JPG Converter',
  lead='Turn the pages of a PDF into JPG or PNG images — all pages or just the ones you pick, in low, medium or high quality. One page downloads as an image, several as a ZIP. Free, no signup, no watermark.',
  limits=LIMIT_COMMON + '; up to 300 pages per PDF',
  steps=['Choose your PDF (or drag it into the box) — a thumbnail of every page appears.', 'Pick the pages: click thumbnails, use “Select all”, or type a range such as 1-3, 5.',
         'Choose JPG or PNG and Low, Medium or High quality.', 'Click “Convert” and download the image, or the ZIP with one image per page.'],
  sections=[
    ('PDF pages to JPG images', [
      'A PDF is great for printing and submitting, but sometimes you need a picture of a page: to send it in a chat, drop it into a slide, or upload it to a form that wants an image. This converter draws each page you choose as an image, exactly as it looks in the PDF, and saves it as a JPG or a PNG.',
      'You decide which pages become images. Every page is shown as a thumbnail — click a thumbnail to leave it out or put it back, use “Select all” and “Select none”, or type the pages you want, such as <strong>1-3, 5</strong>. The images always come out in page order, named after your file and the page number, for example <em>notes-p3.jpg</em>.']),
    ('Lecture slides and notes as images', [
      'Lecture slides exported as a PDF are easier to revise from when each slide is an image you can flick through in your phone’s gallery, add to a flashcard app or annotate with a drawing app. Convert the slides you need and keep them next to your photos of the whiteboard.',
      'The same works for typed notes, worksheets and past papers: convert one question or one page and you have an image you can crop, mark up or print on its own.']),
    ('Share a page on WhatsApp or social media', [
      'Chat apps and social media show images straight away, while a PDF has to be downloaded and opened first. To share one page of a timetable, a results notice or a page of notes with your class group, convert that page to JPG and send the image.',
      'Medium quality is usually right for sharing: the text is readable when zoomed in and the file stays small. Chat apps often compress images again, so if small text needs to stay sharp, use High quality or send the PNG as a document.']),
    ('Put a PDF page into PowerPoint or Word', [
      'PowerPoint, Word and Google Slides cannot place a PDF page on a slide or in a document, but they can insert an image. Convert the page — a chart from a report, a diagram from an article or a page of a handout — and insert the JPG or PNG like any other picture, then crop or resize it.',
      'For diagrams, tables and anything with fine lines, choose PNG and High quality: PNG keeps edges crisp, and 220 DPI is sharp enough to fill a slide. If you need to edit the text itself rather than show the page, ' + L('/pdf-to-word.html', 'convert the PDF to an editable Word file') + ' instead.',
      'Going the other way — photos or screenshots that should become one document? ' + L('/jpg-to-pdf.html', 'Combine the images into a PDF') + ', one image per page.']),
    ('Upload a page as an image', [
      'Some forms and portals want a JPG or PNG file rather than a PDF — for example, a profile document, an ID page, a certificate or a signed form you scanned as a PDF. Convert the page you need and upload the image.',
      'If the portal also has a file size limit, Low or Medium quality gives a smaller image. The result shows the size of every image, so you can check it before you upload.']),
    ('JPG or PNG — and which quality?', [
      'JPG makes smaller files and suits pages with photos or coloured backgrounds. PNG is lossless: text and lines stay perfectly sharp, but files are larger, especially for photo-heavy pages. When unsure, use JPG for sharing and PNG for slides and printing.',
      'Low quality renders pages at about 100 DPI, Medium at 150 DPI and High at 220 DPI. JPG files use a compression quality of 0.75, 0.85 or 0.92 for the three settings.']),
    ('PDF to JPG on your phone', [
      'The converter runs in the browser on Android phones and iPhones. Choose the PDF from your files or downloads, pick the pages and convert. A single page downloads as an image; several pages download as one ZIP. On iPhone, open the ZIP in the Files app to unpack it, or save single pages with the links that appear under the ZIP button.',
      'Pages are drawn one at a time and each one is cleared from memory before the next, so long PDFs work on phones too — they just take a little longer. ' + SPEED]),
    ('What it can and can’t do', [
      'It turns any page of an ordinary PDF — typed documents, slides, scans and forms — into an image that looks like the page. Text in the image is part of the picture, so it cannot be selected or searched; to get editable text, use PDF to Word.',
      'It handles PDFs up to 50 MB and 300 pages. Password-protected PDFs need the password removed first. Very large pages, such as posters, are scaled down to about 16 megapixels so they do not run out of memory on phones. It does not crop, rotate or edit the pages.']),
  ],
  faq=[
    ('Is the PDF to JPG converter free?', 'Yes. It is free with no signup, no watermark and no daily limit. PDFs can be up to 50 MB and 300 pages.'),
    ('Can I convert just some pages?', 'Yes. Click the thumbnails to choose pages, use Select all or Select none, or type a range such as 1-3, 5. Images always come out in page order.'),
    ('How do I get several pages at once?', 'Several pages download as one ZIP file with one image per page, named after your file and the page number. Each page also has its own download link.'),
    ('Should I choose JPG or PNG?', 'JPG gives smaller files and suits photos and sharing. PNG keeps text and lines perfectly sharp and suits slides, diagrams and printing, but the files are larger.'),
    ('Is my PDF uploaded anywhere?', 'No. ' + SPEED + ' The page downloads the free open-source code it needs the first time you use it; your file is not part of that.'),
    ('Can I copy the text from the images?', 'No — the text becomes part of the picture. To get editable text, use PDF to Word, which also reads scanned pages with OCR.'),
    ('How do I convert one page of a PDF to a JPG for free?', 'Choose the PDF in ParaFree’s PDF to JPG tool, type the page number in the Pages box and click Convert — that page downloads as a JPG.'),
    ('How do I put a PDF page into a PowerPoint slide?', 'Convert the page to PNG at High quality with PDF to JPG, then insert the image into the slide like any other picture.'),
    ('Can I convert a PDF to JPG on my phone?', 'Yes, in the phone’s browser. One page downloads as an image; several pages download as a ZIP, which the Files app on iPhone or Android can open.'),
  ]),
}

# ── task pages: one tool, opened with its options set (data-pf-preset), and their own guidance ──
TARGET = lambda v: {'input[name=pf-compress-mode][value=target]': True, '[data-role=target]': v}
PAGES.update({
'compress-pdf-to-100kb': dict(
  tool='compress-pdf', name='Compress PDF to 100 KB', preset=TARGET('100000'),
  title='Compress PDF to 100 KB — Free, for Form and Portal Upload Limits',
  desc='Get a PDF under 100 KB for government, scholarship and admission form uploads. The tool opens set to 100 KB, runs in your browser and tells you honestly if 100 KB is not possible.',
  h1='Compress a PDF to 100 KB',
  lead='Online forms that ask for documents “under 100 KB” are common — and strict. This page opens the compressor already set to 100 KB, keeps text selectable whenever it can, and tells you plainly if your file cannot get that small.',
  limits=LIMIT_COMMON + '; target preset to 100 KB (change it any time)',
  steps=['Choose your PDF — the target is already set to 100 KB.', 'Click “Compress PDF”.',
         'Read the result: it says whether the file is under 100 KB and how it got there.', 'Download it, or follow the tips below if 100 KB was out of reach.'],
  sections=[
    ('Why so many forms ask for 100 KB', [
      'Government services, scholarship portals, exam registrations and admission systems often set tiny limits for each attachment: an ID page, a birth certificate, a mark sheet, a photo of a signature. The limit protects old systems from huge uploads, but it means a phone scan of a single page — often 1 to 3 MB — has to shrink by ten to thirty times.',
      'The limit is usually per file, not per form. Read the instructions once: if each document can be uploaded separately, compress each one on its own; that makes 100 KB much easier to reach than squeezing several pages into one file.']),
    ('How the tool gets under 100 KB', [
      'It first tries <strong>Light</strong> compression, which shrinks the images inside the PDF and leaves text untouched, so a typed letter stays sharp and selectable. If that is not enough, it rebuilds each page as an image and searches for the highest resolution and quality that still fits, down to about 72 DPI.',
      'The result always says which method was used and the exact size, using 1 KB = 1,000 bytes as upload pages count it. If a portal is stricter than that, set a custom target of 95 KB to leave a small margin.']),
    ('Tips for scanned documents', [
      'Most 100 KB problems are scans. If you can scan again, a few settings make a big difference: scan or photograph at about 150 DPI rather than 300 or more, use grayscale for black-and-white documents, crop away the table or desk around the page, and keep the page flat and evenly lit so the background stays white instead of grey.',
      'A clean, white background compresses far better than a shadowy one. If your scan has dark edges or a coloured tint, rescanning in better light usually beats any compression setting.']),
    ('What to do if 100 KB is impossible', [
      'Some files simply cannot be readable at 100 KB — for example a ten-page scan, which would leave about 10 KB per page. When that happens the tool says so and offers the smallest version it could make. Then you have honest options:',
      '<strong>Upload fewer pages.</strong> Remove pages the form does not ask for, or upload each page as a separate document if the form allows it. <strong>Rescan</strong> in grayscale at a lower resolution. <strong>Send an image instead</strong>: if the form accepts JPG, ' + L('/pdf-to-jpg.html', 'save the page as a JPG at Low quality') + ' — a single page is often smaller as an image. And if nothing works, contact the office: many accept documents by email or in person when a file cannot fit.']),
    ('Check the file before you upload it', [
      'Open the compressed PDF and zoom in on the smallest text: names, dates, ID numbers, stamps and signatures must still be readable, or the document may be rejected later. If they are blurry, try a slightly larger custom target that still meets the limit, or rescan.',
      'Give the file a clear name, such as <em>surname-birth-certificate.pdf</em>, so you can tell your uploads apart. ' + SPEED]),
    ('On your phone', [
      'Many forms are filled in on a phone. The compressor works in the phone’s browser: choose the PDF from your files or downloads, and the 100 KB target is already set. Photos of documents? ' + L('/jpg-to-pdf.html', 'Make them into a PDF') + ' first, then compress.']),
  ],
  faq=[
    ('Can I compress any PDF to under 100 KB?', 'No. A text PDF of a few pages usually fits easily, but long or detailed scans may not stay readable at 100 KB. The tool tells you when the target cannot be reached and offers the smallest version it could make.'),
    ('Will my PDF still be readable at 100 KB?', 'A one-page document usually is. Always open the result and zoom in on names, numbers and signatures before you upload it.'),
    ('Is 100 KB here the same as 100 KB on the upload form?', 'Yes. Sizes use 1 KB = 1,000 bytes, as upload forms count them. For a little extra margin, set a custom target such as 95 KB.'),
    ('Does compressing to 100 KB keep text selectable?', 'Yes, whenever Light compression is enough. If pages have to become images to fit, the result says so and the text is no longer selectable.'),
    ('Is my document uploaded to a server?', 'No. ' + SPEED),
    ('Can I compress to a different size here?', 'Yes. The target is preset to 100 KB, but you can choose 200 KB, 500 KB, 1 MB, 2 MB or a custom size in the same box.'),
  ]),
'compress-pdf-to-200kb': dict(
  tool='compress-pdf', name='Compress PDF to 200 KB', preset=TARGET('200000'),
  title='Compress PDF to 200 KB — Free, for Job Portals and Applications',
  desc='Shrink a CV, cover letter or certificate PDF under 200 KB for job portals and applications. Opens set to 200 KB, keeps CV text selectable for applicant tracking systems whenever possible.',
  h1='Compress a PDF to 200 KB',
  lead='Job portals, graduate schemes and application systems often cap each upload at 200 KB. This page opens the compressor already set to 200 KB and keeps your CV’s text selectable — which applicant tracking systems need — whenever it can.',
  limits=LIMIT_COMMON + '; target preset to 200 KB (change it any time)',
  steps=['Choose your CV, cover letter or certificate PDF — the target is already 200 KB.', 'Click “Compress PDF”.',
         'Check the result line: under 200 KB, and whether text is still selectable.', 'Download it and upload it to the application.'],
  sections=[
    ('Job portals and their upload limits', [
      'Career sites, government job portals and some graduate schemes limit each attachment, and 200 KB is a common figure for CVs, cover letters and certificates. A normal text CV is usually far below that; the files that go over are CVs with a large photo or logo, CVs exported as images, and scanned certificates or transcripts.',
      'If the portal lists the limit in MB, remember that 0.2 MB is the same as 200 KB here: sizes use 1 MB = 1,000,000 bytes, as upload pages count them.']),
    ('Keep your CV readable by applicant tracking systems', [
      'Applicant tracking systems read the text inside your PDF. A compressor that turns every page into a picture makes a small file the system cannot read. This tool tries <strong>Light</strong> compression first: it shrinks the images and leaves your text, fonts and links as they are, so the CV stays selectable and searchable.',
      'If Light is not enough and the pages have to become images, the result tells you. For a CV, that is a sign to fix the cause instead — usually an oversized photo — and export the CV again. A CV made with ParaFree’s ' + L('/cv-builder.html', 'free CV builder') + ' already downloads as a text PDF, typically well under 200 KB.']),
    ('Why is my CV PDF so big?', [
      'The usual reasons are a high-resolution profile photo, a decorative background image, a logo pasted in at full size, or a CV that was printed to PDF as an image. Fonts rarely matter. Replacing the photo with a smaller one, or removing it if the country does not expect photos, often takes a CV from megabytes to under 100 KB.',
      'If your CV started as a Word file, ' + L('/word-to-pdf.html', 'convert the .docx to a fresh text PDF') + ' rather than compressing a scan or screenshot of it.']),
    ('Certificates, transcripts and ID scans', [
      'Scanned documents are pictures anyway, so turning their pages into images costs nothing: compress them to 200 KB with confidence, then zoom in to check names, grades and stamps are readable. A one-page certificate fits easily; a long transcript may need a larger limit, or uploading just the pages asked for.']),
    ('Several documents for one application', [
      'Some applications want one file with everything; others want each document separately. For one file, ' + L('/merge-pdf.html', 'merge the CV, cover letter and certificates') + ' in the order requested, then compress the merged PDF. For separate uploads, compress each file on its own — each gets the full 200 KB.']),
    ('Check before you submit', [
      'Open the compressed CV, select a line of text to confirm it is still text, and check that links such as your email or LinkedIn still work. Name the file clearly, for example <em>firstname-lastname-cv.pdf</em>. ' + SPEED]),
  ],
  faq=[
    ('How do I compress my CV to under 200 KB for a job portal?', 'Choose the CV here — the target is already 200 KB — and click Compress PDF. Light compression is tried first, so the CV’s text stays selectable for applicant tracking systems.'),
    ('Will compressing my CV stop applicant tracking systems reading it?', 'Not with Light compression, which keeps the text layer. If pages have to become images to fit, the result tells you; then shrink the photo in your CV and export it again instead.'),
    ('My CV is already under 200 KB — should I compress it?', 'No. If it is under the limit, upload it as it is; the tool also tells you when a file is already small enough.'),
    ('Can I compress a scanned certificate to 200 KB?', 'Usually, yes — a one-page scan fits easily. Zoom in afterwards to check that names, grades and stamps are readable.'),
    ('Is my CV uploaded anywhere?', 'No. ' + SPEED),
    ('Can I pick a different limit?', 'Yes. The target is preset to 200 KB, but you can choose 100 KB, 500 KB, 1 MB, 2 MB or a custom size.'),
  ]),
'jpg-to-pdf-for-assignment': dict(
  tool='jpg-to-pdf', name='JPG to PDF for Assignments',
  preset={'[data-role=opt-size]': 'a4', '[data-role=opt-orientation]': 'portrait', '[data-role=opt-margin]': 'small'},
  title='JPG to PDF for Assignments — Photos of Handwritten Work into One A4 PDF',
  desc='Turn photos of handwritten homework, worksheets and lab notes into one A4 PDF for submission. Opens set to A4 portrait with small margins; tips on photos, page order, file names and size limits.',
  h1='JPG to PDF for Assignments',
  lead='Handwritten homework, maths working, worksheets and lab notes often have to be handed in as one PDF. This page opens the converter set up for that — A4, portrait, small margins — with tips for photos a marker can actually read.',
  limits=LIMIT_COMMON + '; JPG, PNG and WebP; preset to A4 portrait, small margins',
  steps=['Photograph each page (tips below) and choose all the photos.', 'Put them in page order — drag them, or use the arrows.',
         'Leave A4, portrait and small margins as set, unless your course says otherwise.', 'Click “Create PDF”, check it, and upload it.'],
  sections=[
    ('Photograph your work so it can be marked', [
      'A marker who cannot read your working cannot give you the marks. Put the page on a plain, dark surface, in daylight or under an even light, and hold the phone straight above it so the page is a rectangle, not a trapezium. Fill most of the frame with the page and tap to focus on the writing before you take the photo.',
      'Avoid your own shadow by standing with the light in front of you, not behind. Turn off the flash if it makes a bright spot on shiny paper. Check each photo once at full size — a blurry page is much easier to retake now than after the deadline.']),
    ('Get the pages in the right order', [
      'Number your pages before you photograph them, then take the photos in that order — most galleries keep the order you took them in, so they arrive in the tool already sorted. If a page is out of place, drag it, or use the up and down arrows, before you create the PDF. Remove any photo you picked by mistake with ✕.',
      'If the assignment has a typed part as well, create the photo PDF here and ' + L('/merge-pdf.html', 'merge it with the typed PDF') + ', with the cover sheet first.']),
    ('A4, portrait, small margins — why', [
      'Most courses print or annotate submissions on A4, so A4 pages print at the right size and markers can write comments in the margin. Portrait matches handwritten pages; small margins keep your writing large without touching the edge. These options are already set on this page, and you can change them in the boxes above the Create PDF button if your course asks for Letter or no margins.',
      'Photos are turned the right way up automatically from the phone’s orientation tag, and each photo is fitted onto its page without being stretched or cropped.']),
    ('Name the file the way your course asks', [
      'Many courses want a specific file name, such as student number, course code and assignment number — for example <em>12345678_MATH101_A2.pdf</em>. Following it helps your work reach the right place, especially when hundreds of files are downloaded at once. If there is no rule, use your name and the assignment title, without special characters.']),
    ('File size limits on Moodle, Canvas and other portals', [
      'Phone photos are large, so a PDF of ten photographed pages can be 20 MB or more. Photos are scaled to 3,000 pixels on the long side, which keeps the PDF reasonable, but some portals still allow less. If yours does, ' + L('/compress-pdf.html', 'compress the PDF to the upload limit') + ' — Light compression keeps handwriting sharp.']),
    ('Before you submit', [
      'Open the PDF and scroll through every page: right order, nothing missing, every page readable, no stray photos of your desk. Check the page count against your work. ' + SPEED]),
  ],
  faq=[
    ('How do I submit handwritten homework as one PDF?', 'Photograph each page, choose all the photos here, put them in order and click Create PDF — you get one A4 PDF with one page per photo, ready to upload.'),
    ('Why A4 portrait with small margins?', 'Most courses print or annotate submissions on A4. Portrait fits handwritten pages, and small margins keep your writing large while leaving room for comments. You can change all three options.'),
    ('How do I make my photos readable?', 'Shoot from straight above in even light, fill the frame with the page, focus on the writing and avoid shadows and flash glare. Check each photo at full size before you convert.'),
    ('My PDF is too big to upload. What now?', 'Compress it with a target size equal to the portal’s limit. Light compression keeps handwriting sharp; check the result before you submit.'),
    ('Can I do this on my phone?', 'Yes. Open this page in your phone’s browser, choose the photos from your gallery, order them and create the PDF. ' + SPEED),
    ('Are my photos uploaded?', 'No. ' + SPEED),
  ]),
})

def esc(s): return html.escape(s, quote=True)

def related(slug):
    own = PAGES[slug].get('tool', slug)
    items = [f'<a href="/{t}.html">{e} {n}</a>' for t, n, e in TOOLS if t != own and t != slug]
    items += ['<a href="/">✍️ Document paraphraser (keeps formatting)</a>', '<a href="/cv-builder.html">📄 Free CV builder (ATS-readable PDF)</a>',
              '<a href="/pdf-tools.html">All PDF tools</a>']
    return '\n      '.join(items)

def page(slug):
    d = PAGES[slug]
    tool = d.get('tool', slug)
    name = d.get('name') or dict((t, n) for t, n, _ in TOOLS)[slug]
    og = f'{SITE}/og/{slug}.png'
    preset = f" data-pf-preset='{esc(json.dumps(d['preset'], ensure_ascii=False))}'" if d.get('preset') else ''
    url = f'{SITE}/{slug}.html'
    faq_ld = {'@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': [
        {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in d['faq']]}
    app_ld = {'@context': 'https://schema.org', '@type': 'WebApplication', 'name': f'ParaFree {name}', 'url': url,
              'description': d['desc'], 'applicationCategory': 'UtilitiesApplication', 'operatingSystem': 'Any (runs in a web browser)',
              'browserRequirements': 'Requires JavaScript', 'isAccessibleForFree': True,
              'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'},
              'publisher': {'@type': 'Organization', 'name': 'ParaFree', 'url': SITE + '/'}}
    crumb_ld = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
        {'@type': 'ListItem', 'position': 2, 'name': 'PDF Tools', 'item': SITE + '/pdf-tools.html'},
        {'@type': 'ListItem', 'position': 3, 'name': name, 'item': url}]}
    ld = '\n'.join(f'<script type="application/ld+json">\n{json.dumps(x, ensure_ascii=False, indent=2)}\n</script>' for x in (app_ld, faq_ld, crumb_ld))
    sections = '\n'.join(
        f'  <section class="pf-section">\n    <h2>{esc(h)}</h2>\n' + ''.join(f'    <p>{p}</p>\n' for p in ps) + '  </section>' for h, ps in d['sections'])
    steps = ''.join(f'<li>{esc(s)}</li>' for s in d['steps'])
    faq = '\n'.join(f'    <div class="faq-item"><p class="faq-q">{esc(q)}</p><p class="faq-a">{esc(a)}</p></div>' for q, a in d['faq'])
    facts = [('Price', 'Free'), ('Signup', 'None needed'), ('Watermark', 'None'), ('File limits', d['limits']),
             ('Where files are processed', 'On your device, in the browser — never uploaded'), ('Works on phone', 'Yes — Android and iPhone browsers')]
    facts_html = ''.join(f'<tr><th scope="row">{esc(k)}</th><td>{esc(v)}</td></tr>' for k, v in facts)
    footer_pdf = '\n'.join(f'    <a href="/{t}.html">{n}</a>' for t, n, _ in TOOLS)
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(d['title'])}</title>
<meta name="description" content="{esc(d['desc'])}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="{url}">
<meta property="og:title" content="{esc(d['title'])}">
<meta property="og:description" content="{esc(d['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ParaFree">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(d['title'])}">
<meta name="twitter:description" content="{esc(d['desc'])}">
<meta name="twitter:image" content="{og}">
<meta name="twitter:site" content="@parafree">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-0QEEGS0DZQ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', 'G-0QEEGS0DZQ');
</script>
{ld}
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#2d6a4f">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/pdf-tools.css">
<link rel="preload" as="script" href="/lib/pdf-tools/{tool}.js?v=0">
</head>
<body data-pf-tool="{tool}"{preset}>

<!-- NAV (same links as the homepage) -->
<div id="mobileMenu" onclick="if(event.target===this)toggleMenu()">
  <div class="pf-menu-inner">
    <button class="pf-menu-close" onclick="toggleMenu()" aria-label="Close menu">×</button>
    <a href="/">Home</a>
    <a href="/cv-builder.html">CV Builder</a>
    <a href="/pdf-tools.html">📄 PDF Tools</a>
    <a href="/code.html">✨ ParaFree AI</a>
    <a href="/blog.html">Blog</a>
    <a href="/about.html">About</a>
    <a href="/faq.html">FAQ</a>
    <a href="/contact.html">Contact</a>
    <a href="/privacy.html">Privacy</a>
    <a href="https://ko-fi.com/parafree" target="_blank" rel="noopener" onclick="if(typeof gtag==='function')gtag('event','donate_click',{{placement:'header'}})">☕ Support ParaFree</a>
  </div>
</div>
<nav id="mainNav">
  <a href="/" style="display:flex;align-items:center;text-decoration:none;">
    <img src="/logo-dark.svg" alt="ParaFree" height="34" style="height:34px;width:auto;" id="navLogo">
  </a>
  <div id="homeNavLinks">
    <a href="/" class="nav-link">Paraphraser</a>
    <a href="/cv-builder.html" class="nav-link">CV Builder</a>
    <a href="/pdf-tools.html" class="nav-link">PDF Tools</a>
    <a href="/code.html" class="nav-link">ParaFree AI</a>
    <a href="/blog.html" class="nav-link">Blog</a>
    <a href="/faq.html" class="nav-link">FAQ</a>
    <a href="/" id="navCta">Try Free →</a>
  </div>
  <button id="menuToggle" aria-label="Open menu" onclick="toggleMenu()"><span></span><span></span><span></span></button>
</nav>

<!-- HERO -->
<header class="pf-hero">
  <div class="pf-hero-inner">
    <nav class="pf-crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span aria-hidden="true">›</span> <a href="/pdf-tools.html">PDF Tools</a> <span aria-hidden="true">›</span> <span aria-current="page">{esc(name)}</span></nav>
    <div class="pf-hero-badge">Free · No Signup · No Watermark</div>
    <h1>{esc(d['h1'])}</h1>
    <p>{esc(d['lead'])}</p>
    <div class="pf-privacy"><span aria-hidden="true">🔒</span> {esc(SPEED)}</div>
    <p class="pf-updated">Last updated: {UPDATED}</p>
  </div>
</header>

<!-- THE TOOL (the same module as pdf-tools.html, opened on this tool) -->
<main class="pf-tools"></main>
<script>window.PFV = '0';</script>
<script src="/lib/pdf-tools/panels.js?v=0"></script>
<script>window.PFPanels.render(document.querySelector('main.pf-tools'));</script>

<div class="pf-content">
  <section class="pf-section pf-howto">
    <h2>How to use it</h2>
    <ol class="pf-steps">{steps}</ol>
  </section>
  <section class="pf-section">
    <h2>Quick facts</h2>
    <table class="pf-facts">{facts_html}</table>
  </section>
{sections}
  <section class="faq" id="faq">
    <h2>Frequently asked questions</h2>
{faq}
  </section>
  <section class="pf-section pf-related">
    <h2>More free tools</h2>
    <p class="pf-related-links">
      {related(slug)}
    </p>
    <p class="pf-entity">{esc(ENTITY)}</p>
  </section>
</div>

<!-- FOOTER (same links as the homepage) -->
<footer class="pf-footer">
  <div class="pf-footer-links">
    <a href="/">Home</a>
    <a href="/about.html">About</a>
    <a href="/blog.html">Blog</a>
    <a href="/cv-builder.html">CV Builder</a>
    <a href="/code.html">ParaFree AI</a>
    <a href="/cv-blog.html">CV Blog</a>
    <a href="/faq.html">FAQ</a>
    <a href="/contact.html">Contact</a>
    <a href="/privacy.html">Privacy</a>
    <a href="/terms.html">Terms</a>
    <a href="https://ko-fi.com/parafree" target="_blank" rel="noopener" onclick="if(typeof gtag==='function')gtag('event','donate_click',{{placement:'footer'}})">☕ Support ParaFree</a>
  </div>
  <div class="pf-footer-group">
    <span class="pf-footer-title">Paraphrase Tools:</span>
    <a href="/paraphrase-powerpoint.html">Paraphrase PowerPoint</a>
    <a href="/paraphrase-word-document.html">Paraphrase Word</a>
    <a href="/paraphrase-pdf.html">Paraphrase PDF</a>
    <a href="/paraphrase-word-document-keep-formatting.html">Word Without Losing Formatting</a>
    <a href="/paraphrase-document-online-keep-format.html">Paraphrase Documents Online</a>
  </div>
  <div class="pf-footer-group">
    <span class="pf-footer-title">PDF Tools:</span>
{footer_pdf}
  </div>
  <div class="pf-footer-group">
    <span class="pf-footer-title">CV Resources:</span>
    <a href="/cv-builder.html">Free CV Builder</a>
    <a href="/ai-cv-builder.html">AI CV Builder</a>
    <a href="/cv-builder-no-signup.html">No Signup CV</a>
    <a href="/ats-resume-builder.html">ATS Templates</a>
    <a href="/student-cv-builder.html">Student CV</a>
    <a href="/cv-maker-free-download.html">Free CV Download</a>
  </div>
  <div class="pf-footer-brand"><img src="/favicon.svg" alt="ParaFree" height="20" style="height:20px;width:auto;"><span>ParaFree</span></div>
  <p>© 2026 ParaFree · Free AI Writing Suite · No limits, no signup, always free</p>
</footer>

<!-- core only; this tool's module loads right away (app.js opens the tool named on <body>) -->
<script src="/lib/pdf-tools/pdf-events.js?v=0"></script>
<script src="/lib/pdf-tools/loader.js?v=0"></script>
<script src="/lib/pdf-tools/common.js?v=0"></script>
<script src="/lib/pdf-tools/app.js?v=0"></script>
</body>
</html>
'''

if __name__ == '__main__':
    for slug in PAGES:
        out = page(slug)
        open(os.path.join(ROOT, slug + '.html'), 'wb').write(out.encode('utf-8'))
        words = len(__import__('re').sub(r'<[^>]+>', ' ', out.split('<main class="pf-tools">')[1].split('<footer')[0]).split())
        print(slug + '.html', words, 'words')
