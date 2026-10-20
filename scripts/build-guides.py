"""Builds the three guide posts from the existing blog post shell (blog-paraphrase-pdf-right-way.html):
same head, nav, styles and footer; new title, description, canonical, JSON-LD and article.
    python scripts/build-guides.py
"""
import html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://parafree.app'
DATE, DATE_TEXT = '2026-10-21', 'October 21, 2026'
ENTITY = ('ParaFree is a free AI writing suite with a document paraphraser that keeps formatting, a CV builder with '
          'ATS-readable PDFs, and in-browser PDF tools (PDF to Word, Word to PDF, JPG to PDF, compress and merge).')

POSTS = [
dict(slug='blog-pdf-to-word-without-losing-formatting',
  title='How to Convert PDF to Word Without Losing Formatting (Free, 2026)',
  desc='Why PDF to Word conversions break layouts, how to keep headings, fonts, lists, tables and two-column pages, what to do with scanned PDFs, and how to check the result before you submit.',
  cta=('Convert a PDF to Word free — no signup, your file stays on your device.', '/pdf-to-word.html', 'Open PDF to Word →'),
  body='''
<p>You have a PDF and you need to change it: an assignment template, last year’s report, a handout you want to adapt, or your own work that survived just as a PDF. You convert it to Word — and the result is a mess of broken lines, wrong fonts and columns mixed together. Here is why that happens, and how to get a Word file that actually looks like the PDF.</p>
<h2>Why PDFs are hard to turn back into Word</h2>
<p>A Word document knows its structure: this is a heading, this is a list, this is a table, this paragraph continues on the next page. A PDF mostly does not. It stores where each piece of text is drawn on the page — “these letters, in this font, at this position” — because its job is to look identical everywhere, not to be edited.</p>
<p>So a converter has to rebuild the structure from the layout. It has to work out which lines belong to one paragraph, which text is a heading because it is bigger and bold, which rows of text form a table, and in which order to read two columns. When a converter skips that work and copies line by line, you get the familiar broken result: a hard line break at the end of every line, headings that are just big normal text, and the left and right columns of a research paper woven together.</p>
<h2>What a good conversion keeps</h2>
<p>When you choose a PDF to Word converter, check that it keeps these:</p>
<ul>
<li><strong>Paragraphs</strong>, joined back together instead of one line per paragraph.</li>
<li><strong>Headings</strong> as real Word headings, so the navigation pane and a table of contents work.</li>
<li><strong>Bold, italic, font sizes and font families</strong>, at least where the PDF names its fonts.</li>
<li><strong>Bullet and numbered lists</strong> as Word lists, not as lines that start with a symbol.</li>
<li><strong>Tables</strong> as editable Word tables.</li>
<li><strong>Two-column pages</strong> in reading order — left column first, then right.</li>
<li><strong>Images</strong> in the right place.</li>
</ul>
<p>ParaFree’s <a href="/pdf-to-word.html">PDF to Word converter</a> does all of these and shows you the result in an editor before you download the .docx, so you can fix anything it got wrong. It runs in your browser — no upload, no waiting — and is free with no signup.</p>
<h2>Step by step</h2>
<ol>
<li><strong>Check what kind of PDF you have.</strong> Open it and try to select a sentence with your mouse. If you can, it is a text PDF and converts most accurately. If you can’t, it is a scan or a picture, and the converter needs OCR (see below).</li>
<li><strong>Convert it.</strong> Choose the PDF in the converter and wait while each page is read. Text pages are quick; scanned pages take longer.</li>
<li><strong>Read through the result.</strong> Look at the headings, lists and tables, and at the page breaks where paragraphs continue. Fix small things in the editor.</li>
<li><strong>Download the .docx</strong> and open it in Word, Google Docs or LibreOffice.</li>
</ol>
<h2>Fonts: why some look different</h2>
<p>If the PDF uses a font that is not installed on your computer, Word shows a similar font instead. The size and style are still right, so the layout stays close, but lines can break in slightly different places. If the exact font matters, install it or pick a similar one in Word. This is the most common reason a converted document has one more or one fewer page than the PDF.</p>
<h2>Two-column research papers</h2>
<p>Journal articles are the classic failure case. A careless converter reads across the whole page, so the first line of the left column is followed by the first line of the right column. A good converter detects the columns and keeps each as normal paragraphs in reading order. Footnotes, captions and references come along as text. Complicated equations usually need tidying by hand in any converter.</p>
<h2>Scanned PDFs need OCR</h2>
<p>A scan has no text inside — every page is a photo. To get editable text, the converter has to read the letters with OCR (optical character recognition). ParaFree does this in your browser automatically when a page has no text layer. OCR is accurate on clear, straight, printed English text, and much weaker on handwriting, small print, coloured backgrounds and other languages, so proofread the result. A sharp, straight scan helps more than anything else.</p>
<h2>What no converter does perfectly</h2>
<p>Some PDFs are closer to posters than documents: text boxes placed over images, forms with fields, magazine-style layouts. No converter rebuilds these exactly, because the original structure simply is not in the PDF. For those, convert to get the text out, then lay it out again in Word.</p>
<h2>Before you submit</h2>
<p>Always open the Word file once from start to finish before you hand it in. Check headings, numbered lists, tables and references, and make sure nothing went missing at page breaks. If you edited the document and need a PDF again, convert it back with <a href="/word-to-pdf.html">Word to PDF</a>.</p>
<p>If you are adapting someone else’s text, cite the source. ParaFree’s <a href="/">document paraphraser</a> can reword the converted Word file while keeping its formatting — use it to help with your own writing, and check the result yourself.</p>
'''),
dict(slug='blog-compress-pdf-upload-limits',
  title='How to Compress a PDF for University and Job Portal Upload Limits (Free)',
  desc='Upload portals cap PDFs at 1–5 MB, forms at 100–500 KB. How PDF compression works, when your text stays selectable, how to hit an exact target size, and what to do when it will not fit.',
  cta=('Compress a PDF to a target size free — your file stays on your device.', '/compress-pdf.html', 'Open Compress PDF →'),
  body='''
<p>You finish the assignment, export the PDF, go to upload it — and the portal says the file is too big. Or an application form wants your certificates “in PDF, max 200 KB”. Here is how to make a PDF small enough without making it unreadable, and how to keep the text selectable when that matters.</p>
<h2>Why PDFs get big</h2>
<p>Text is tiny. A 20-page essay with no pictures is usually well under 1 MB. What makes PDFs big is images: photos, scanned pages, screenshots and high-resolution charts. A single phone photo can be 3–5 MB, and a scanned document is one large image per page. So compressing a PDF is almost always about the images in it.</p>
<h2>The two ways to compress</h2>
<p><strong>Shrink the images and keep everything else.</strong> Each oversized image is resized to the resolution it actually needs at the size it is shown — about 150 DPI is sharp on screen and in print — and saved as an efficient JPEG. Text, links and vector graphics are untouched, so the text stays selectable and searchable. This is what ParaFree calls <strong>Light</strong>.</p>
<p><strong>Turn every page into one image.</strong> Each page is rendered as a picture at a lower resolution and saved as a JPEG. This makes the smallest file, but the text is no longer real text: you cannot select it, search it or have it read by a screen reader. ParaFree calls this <strong>Strong</strong>.</p>
<h2>When selectable text matters</h2>
<p>For a CV, keep the text selectable. Applicant tracking systems read the text in your PDF; a CV that is just an image of text may be read as empty. The same goes for anything that will be searched, run through a similarity checker or read aloud. For a scanned certificate or a page of photos, it does not matter — the page was already an image.</p>
<h2>Compressing to an exact target size</h2>
<p>Upload pages usually tell you the limit: 1 MB, 2 MB, 5 MB, or for forms 100 KB, 200 KB or 500 KB. ParaFree’s <a href="/compress-pdf.html">Compress PDF</a> has a <strong>Target size</strong> option for exactly this. Pick 100 KB, 200 KB, 500 KB, 1 MB or 2 MB, or type your own limit, and it:</p>
<ol>
<li>keeps your original if it is already under the limit;</li>
<li>tries Light first, so your text stays selectable if that is enough;</li>
<li>otherwise turns the pages into images and searches for the highest resolution and quality that still fits;</li>
<li>stops at about 72 DPI rather than make the pages unreadable — and if even that is too big, gives you the smallest file it made and says so.</li>
</ol>
<p>The result always tells you the size before and after, and whether the text is still selectable. It runs in your browser: no upload, no waiting — your file is processed on your device.</p>
<h2>KB and MB are counted in two ways</h2>
<p>Most websites and phones count 1 MB as 1,000,000 bytes. Windows File Explorer counts 1 MB as 1,048,576 bytes, so it shows a slightly smaller number for the same file. ParaFree uses the first way, like most upload pages. If a limit is very tight, aim a little below it.</p>
<h2>When it will not fit</h2>
<p>A 40-page scan will not fit under 200 KB at a readable quality — there is simply too much on the pages. If the tool tells you the target cannot be reached, try:</p>
<ul>
<li><strong>Removing pages you don’t need</strong>, such as blank backs of scanned pages.</li>
<li><strong>Splitting the upload</strong> if the form allows several files.</li>
<li><strong>Scanning again in black and white or greyscale</strong> at a lower resolution — colour scans of text are much bigger than they need to be.</li>
<li><strong>Exporting from the original</strong>: if you have the Word file, export a fresh PDF with <a href="/word-to-pdf.html">Word to PDF</a> instead of compressing a scan of it.</li>
</ul>
<h2>Check before you upload</h2>
<p>Open the compressed PDF and zoom in on the smallest text — a signature, a seal, a table. If you can read it comfortably, so can the person checking it. If not, choose a larger target and try again.</p>
<p>Need to put several files together first? Use <a href="/merge-pdf.html">Merge PDF</a>, then compress the merged file. Photos of documents? Make them into one PDF with <a href="/jpg-to-pdf.html">JPG to PDF</a> before compressing.</p>
'''),
dict(slug='blog-ats-friendly-cv-guide',
  title='How to Make an ATS-Friendly CV That Recruiters’ Systems Can Read (Free, 2026)',
  desc='What applicant tracking systems read, why an image-only PDF CV can come through empty, how to check your PDF in ten seconds, and whether your CV should be one page or two.',
  cta=('Build a CV with an ATS-readable PDF — free, no signup, 54 templates.', '/cv-builder.html', 'Open the CV Builder →'),
  body='''
<p>Many employers do not read your CV first — software does. An applicant tracking system (ATS) takes the file you upload, pulls the text out, and turns it into a record a recruiter can search: name, contact details, job titles, dates, skills. If the software cannot read your CV properly, a good application can look empty or jumbled. Here is how to avoid that.</p>
<h2>What an ATS actually reads</h2>
<p>An ATS reads the <strong>text</strong> in your file. It does not look at your design the way a person does. It looks for your name and contact details near the top, section headings it recognises (Experience, Education, Skills), job titles, employers and dates, and words that match the job advert. Then a recruiter searches and filters those records.</p>
<p>So an ATS-friendly CV is one whose text is real, in a sensible order, under clear headings. A beautiful design is fine — as long as the text underneath it is there and reads in the right order.</p>
<h2>Image PDFs versus text PDFs</h2>
<p>This is the most important and least known point. A PDF can contain real text, or it can contain a picture of text. They look identical on screen.</p>
<ul>
<li><strong>Text PDF:</strong> the letters are stored as text. You can select a word, copy it, search for it. An ATS can read it.</li>
<li><strong>Image PDF:</strong> each page is one picture. Some CV builders and some “print to PDF” or screenshot routes produce this. There is no text to read unless the ATS runs OCR, and many do not — so your CV may come through as blank, or with recognition errors in your name or email.</li>
</ul>
<p>ParaFree’s <a href="/cv-builder.html">CV builder</a> makes text PDFs: each page shows your chosen design, and underneath it is a layer of real, selectable text in reading order, with your email, phone and LinkedIn as working links. For sidebar templates, the sidebar and the main column are kept as separate blocks, so the text does not get mixed line by line.</p>
<h2>How to check your PDF in ten seconds</h2>
<ol>
<li>Open your CV PDF in a browser or PDF reader.</li>
<li>Try to select a line of text with your mouse, or press Ctrl+A (Cmd+A on a Mac).</li>
<li>Copy it and paste it into a plain text editor or an email.</li>
</ol>
<p>If you can select the text and it pastes in a sensible order — name, contact details, then each section — an ATS can read it. If nothing gets selected, or the whole page is selected as one image, it is an image PDF. Rebuild it as a text PDF before you apply.</p>
<h2>Layout choices that help</h2>
<ul>
<li><strong>Use normal section headings:</strong> “Work Experience”, “Education”, “Skills”. Clever headings like “My Journey” are harder to recognise.</li>
<li><strong>Put contact details in the body</strong>, not just in a page header or footer, which some systems skip.</li>
<li><strong>Write dates consistently</strong>, such as “Jan 2023 – Present”.</li>
<li><strong>Use the words from the advert</strong> where they are true for you — the software and the recruiter search for them.</li>
<li><strong>Single-column templates are the safest choice</strong> for strict portals. Two-column designs work when their text is in a sensible order, which you can check with the copy-paste test.</li>
<li><strong>Keep the file small.</strong> If a portal has a size limit, compress with a method that keeps text selectable — see <a href="/blog-compress-pdf-upload-limits.html">compressing a PDF for upload limits</a>.</li>
</ul>
<h2>One page or two?</h2>
<p>For students and recent graduates, one page is usually right: it forces you to keep the strongest points, and recruiters read fast. Two pages are normal and fine for experienced roles, academic CVs or jobs that ask for detail. Three pages are rare outside academia and senior roles.</p>
<p>What looks bad is a CV that spills two or three lines onto a second page. In ParaFree you choose 1, 2 or 3 pages yourself, and the builder shows exactly which lines do not fit. One click on <strong>Fit to 1 page</strong> tightens spacing, line height and margins in small steps — and after that the font, never below 9.5 pt — until it fits. If it cannot fit without going smaller, it tells you, and you can add a page instead. The PDF never contains blank pages.</p>
<h2>Word or PDF?</h2>
<p>Upload whatever the employer asks for. If they accept either, a text PDF keeps your layout exactly as you designed it on every computer. ParaFree CVs download as PDF; cover letters download as PDF or Word.</p>
<h2>A quick checklist</h2>
<ul>
<li>The text in your PDF can be selected and pastes in a sensible order.</li>
<li>Your name, email and phone are in the body of the CV.</li>
<li>Headings are plain: Experience, Education, Skills.</li>
<li>Dates are consistent and job titles are clear.</li>
<li>It is one page if you are a student or graduate, unless the role asks for more — and no page is just a few stray lines.</li>
<li>The file is under the portal’s size limit.</li>
</ul>
'''),
]

def build(post, shell):
    s = shell
    url = f"{SITE}/{post['slug']}.html"
    t, d = post['title'], post['desc']
    e = lambda x: html.escape(x, quote=True)
    s = re.sub(r'<title>.*?</title>', f'<title>{e(t)} | ParaFree</title>', s, count=1)
    s = re.sub(r'(<meta name="description" content=")[^"]*(">)', lambda m: m.group(1) + e(d) + m.group(2), s, count=1)
    s = re.sub(r'(<link rel="canonical" href=")[^"]*(">)', lambda m: m.group(1) + url + m.group(2), s, count=1)
    for prop in ('og:title', 'og:description', 'og:url'):
        val = {'og:title': f'{t} | ParaFree', 'og:description': d, 'og:url': url}[prop]
        s = re.sub(rf'(<meta property="{prop}" content=")[^"]*(">)', lambda m: m.group(1) + e(val) + m.group(2), s, count=1)
    for prop in ('twitter:title', 'twitter:description'):
        val = {'twitter:title': f'{t} | ParaFree', 'twitter:description': d}[prop]
        s = re.sub(rf'(<meta name="{prop}" content=")[^"]*(">)', lambda m: m.group(1) + e(val) + m.group(2), s, count=1)
    article = {'@context': 'https://schema.org', '@type': 'Article', 'headline': t, 'description': d,
               'author': {'@type': 'Person', 'name': 'Pritom Dash'}, 'datePublished': DATE, 'dateModified': DATE,
               'publisher': {'@type': 'Organization', 'name': 'ParaFree', 'url': SITE}, 'mainEntityOfPage': url, 'url': url}
    crumbs = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
        {'@type': 'ListItem', 'position': 2, 'name': 'Blog', 'item': SITE + '/blog.html'},
        {'@type': 'ListItem', 'position': 3, 'name': t, 'item': url}]}
    s = re.sub(r'<script type="application/ld\+json">.*?</script>',
               lambda m: '<script type="application/ld+json">' + json.dumps(article, ensure_ascii=False) + '</script>\n'
                         '<script type="application/ld+json">' + json.dumps(crumbs, ensure_ascii=False) + '</script>', s, count=1, flags=re.S)
    cta_p, cta_href, cta_txt = post['cta']
    art = (f'''  <article>
    <h1>{e(t)}</h1>
    <p class="article-meta">By Pritom Dash &middot; Published {DATE_TEXT}</p>
{post['body'].strip()}
<p><em>{e(ENTITY)}</em></p>
<p class="author-sig">— Pritom Dash</p>
    <div class="cta-box">
      <p>{e(cta_p)}</p>
      <a href="{cta_href}">{e(cta_txt)}</a>
    </div>
  </article>''')
    s = re.sub(r'  <article>.*?</article>', lambda m: art, s, count=1, flags=re.S)
    return s

if __name__ == '__main__':
    shell = open(os.path.join(ROOT, 'blog-paraphrase-pdf-right-way.html'), 'rb').read().decode('utf-8').replace('\r\n', '\n')
    for post in POSTS:
        out = build(post, shell)
        open(os.path.join(ROOT, post['slug'] + '.html'), 'wb').write(out.replace('\n', '\r\n').encode('utf-8'))
        body = re.sub(r'<[^>]+>', ' ', out.split('<article>')[1].split('</article>')[0])
        print(post['slug'] + '.html', len(body.split()), 'words')
