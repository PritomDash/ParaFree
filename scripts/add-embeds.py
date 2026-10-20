# Adds the "try it here" embeds to the landing pages (landing-embeds round). Idempotent: a page that already
# has the block is skipped. Additive only: nothing in the page is changed, one block is inserted.
#   (a) paraphraser pages + (b) CV pages: the real tool (lazy iframe) right after the hero (H1 + intro)
#   (d) comparison pages and topical blog posts: a compact "Try it free here" box after the intro, with the
#       tool (lazy iframe) or, for story / PDF / CV posts, a button
# The iframe is created by lib/embed-host.js only when the box comes near the screen.
# Run from the repo root: python scripts/add-embeds.py   (again after scripts/build-guides.py)
import html as H
import re
import sys
from html.parser import HTMLParser

MARK = '<!-- TRY THE TOOL HERE'
END = '<!-- /TRY THE TOOL HERE -->'
HOST = '<script src="/lib/embed-host.js" defer></script>'
P = '/?embed=paraphraser'

# page: (kind, embed query (paraphraser presets) or button target, heading, "Open full tool" href)
LANG = {'bengali': 'Bengali', 'hindi': 'Hindi', 'urdu': 'Urdu', 'arabic': 'Arabic', 'tagalog': 'Filipino / Tagalog', 'english': 'English'}
def lang_page(code, heading=None):
    return ('para', f'&tool=paraphraser&lang={code}', heading or f'Try it here — paraphrase in {LANG[code]}', f'/?lang={code}')
PAGES = {
    # (a) paraphraser / tool landing pages: full embed after the hero
    'ai-rephraser.html': ('para', '&tool=paraphraser', 'Try it here — paste text or upload a file', '/'),
    'paraphrase-essay.html': ('para', '&tool=paraphraser&mode=formal', 'Try it here — paste your essay (Formal mode)', '/'),
    'paraphrasing-tool-no-word-limit.html': ('para', '&tool=paraphraser', 'Try it here — paste as much text as you like', '/'),
    'paraphrase-document-online-keep-format.html': ('para', '&tool=paraphraser', 'Try it here — upload a Word, PDF or PowerPoint file', '/'),
    'paraphrase-pdf.html': ('para', '&tool=paraphraser', 'Try it here — upload your PDF', '/'),
    'paraphrase-powerpoint.html': ('para', '&tool=paraphraser', 'Try it here — upload your PowerPoint (.pptx)', '/'),
    'paraphrase-word-document.html': ('para', '&tool=paraphraser', 'Try it here — upload your Word document', '/'),
    'paraphrase-word-document-keep-formatting.html': ('para', '&tool=paraphraser', 'Try it here — upload your Word document', '/'),
    'free-paraphrasing-tool-students.html': ('para', '&tool=paraphraser', 'Try it here — paste text or upload your assignment', '/'),
    'free-arabic-paraphrasing-tool.html': lang_page('arabic'),
    'free-bengali-paraphrasing-tool.html': lang_page('bengali'),
    'free-hindi-paraphrasing-tool.html': lang_page('hindi'),
    'free-urdu-paraphrasing-tool.html': lang_page('urdu'),
    'free-french-paraphrasing-tool.html': ('para', '&tool=paraphraser&lang=french', 'Essayez ici — paraphrasez en français', '/?lang=french'),
    'free-paraphrasing-tool-australia.html': ('para', '&tool=paraphraser', 'Try it here — paste text or upload your assignment', '/'),
    'free-paraphrasing-tool-usa.html': ('para', '&tool=paraphraser', 'Try it here — paste text or upload your assignment', '/'),
    'free-paraphrasing-tool-bangladesh.html': lang_page('bengali'),
    'free-paraphrasing-tool-egypt.html': lang_page('arabic'),
    'free-paraphrasing-tool-india.html': lang_page('hindi', 'Try it here — paraphrase in Hindi (or pick another language)'),
    'free-paraphrasing-tool-pakistan.html': lang_page('urdu', 'Try it here — paraphrase in Urdu (or pick English)'),
    'free-paraphrasing-tool-philippines.html': lang_page('tagalog'),
    'free-paraphrasing-tool-kenya.html': lang_page('english'),
    'free-paraphrasing-tool-nigeria.html': lang_page('english'),
    'free-paraphrasing-tool-south-africa.html': lang_page('english'),
    # (b) CV landing pages: the CV builder after the hero
    'ai-cv-builder.html': ('cv', '', 'Try it here — build your CV', '/cv-builder.html'),
    'ats-resume-builder.html': ('cv', '', 'Try it here — build an ATS-readable CV', '/cv-builder.html'),
    'cv-builder-no-signup.html': ('cv', '', 'Try it here — no signup, start typing', '/cv-builder.html'),
    'cv-maker-free-download.html': ('cv', '', 'Try it here — build your CV and download the PDF', '/cv-builder.html'),
    'cv-templates.html': ('cv', '', 'Try it here — pick a template and fill it in', '/cv-builder.html'),
    'student-cv-builder.html': ('cv', '', 'Try it here — write your first CV', '/cv-builder.html'),
    'free-cv-builder-australia.html': ('cv', '', 'Try it here — build your resume', '/cv-builder.html'),
    'free-cv-builder-canada.html': ('cv', '', 'Try it here — build your resume', '/cv-builder.html'),
    'free-cv-builder-international-students.html': ('cv', '', 'Try it here — build your CV', '/cv-builder.html'),
    'free-cv-builder-uk.html': ('cv', '', 'Try it here — build your CV', '/cv-builder.html'),
    'free-cv-builder-usa.html': ('cv', '', 'Try it here — build your resume', '/cv-builder.html'),
    # (d) comparison pages: compact box with the tool
    'best-free-paraphrasing-tool.html': ('para-compact', '&tool=paraphraser', 'Try it free here', '/'),
    'quillbot-alternative.html': ('para-compact', '&tool=paraphraser', 'Try it free here', '/'),
    'wordtune-alternative.html': ('para-compact', '&tool=paraphraser', 'Try it free here', '/'),
    'best-free-cv-builder.html': ('button', '/cv-builder.html', 'Try it free here — the CV builder, 54 templates, no signup', 'Open the CV builder →'),
}
# (d) blog posts about paraphrasing: compact box with the tool (preset where the post is about one)
for f in ['academic-papers-citations', 'are-tools-cheating', 'check-natural-reading', 'common-mistakes', 'free-vs-paid-comparison',
          'keep-meaning-when-paraphrasing', 'paraphrase-pdf-right-way', 'paraphrase-powerpoint-safely', 'paraphrase-word-keep-formatting',
          'paraphrasing-long-documents', 'powerpoint-design-intact', 'tables-charts-untouched', 'why-formatting-matters',
          'why-no-word-limit', 'why-tools-break-formatting']:
    PAGES[f'blog-{f}.html'] = ('para-compact', '&tool=paraphraser', 'Try it free here', '/')
PAGES['blog-paraphrasing-for-esl-students.html'] = ('para-compact', '&tool=paraphraser&mode=simple', 'Try it free here (Simplify mode)', '/')
PAGES['blog-problem-with-ai-humanizers.html'] = ('para-compact', '&tool=humanizer', 'Try it free here — the AI humanizer', '/')
PAGES['blog-truth-about-ai-detectors.html'] = ('para-compact', '&tool=detector', 'Try it free here — the AI detector', '/')
# (d) story / build-log posts and the PDF and CV guides: a clear button, no embed
for f in ['api-fallback-chains', 'building-for-global-users', 'building-taught-me-more-than-uni', 'free-forever-sustainable',
          'future-of-free-ai-tools', 'growing-indie-tool-organically', 'parallel-processing-explained', 'self-hosting-vs-cdn',
          'student-built-free-ai-tool', 'ten-second-problem', 'why-free-forever', 'zero-budget-free-apis']:
    PAGES[f'blog-{f}.html'] = ('button', '/', 'Try it free here — the paraphraser, no word limit, no signup', 'Open the paraphraser →')
for f in ['ats-friendly-cv-guide', 'cv-builder-that-finds-jobs-for-you', 'why-i-built-a-truly-free-cv-builder']:
    PAGES[f'blog-{f}.html'] = ('button', '/cv-builder.html', 'Try it free here — the CV builder, 54 templates, no signup', 'Open the CV builder →')
PAGES['blog-pdf-to-word-without-losing-formatting.html'] = ('button', '/pdf-to-word.html', 'Try it free here — PDF to Word in your browser', 'Open PDF to Word →')
PAGES['blog-compress-pdf-upload-limits.html'] = ('button', '/compress-pdf.html', 'Try it free here — compress a PDF to a target size', 'Open Compress PDF →')

TITLE = {'paraphraser': 'ParaFree paraphraser', 'humanizer': 'ParaFree AI humanizer', 'detector': 'ParaFree AI detector'}
LINK = "font-size:13px;font-weight:700;color:#2d6a4f;text-decoration:none;white-space:nowrap;"
HEAD = "font:700 17px Syne,'DM Sans',sans-serif;color:#1a1814;"


def embed_block(kind, query, heading, full):
    e = H.escape
    if kind == 'button':
        return (f'{MARK}: a clear button to the tool (no embed on this post) -->\n'
                f'<div class="pf-try pf-try-btn" style="margin:22px 0;padding:14px 16px;border:1px solid #b7e4c7;background:#f0fdf4;border-radius:12px;'
                f'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;font-family:\'DM Sans\',sans-serif;">'
                f'<span style="font-size:15px;font-weight:600;color:#1a1814;">{e(heading)}</span>'
                f'<a href="{e(query)}" style="display:inline-block;background:#2d6a4f;color:#fff;border-radius:20px;padding:8px 18px;font-size:14px;font-weight:700;text-decoration:none;">{e(full)}</a></div>\n')
    cv = kind == 'cv'
    compact = kind == 'para-compact'
    src = '/cv-builder.html?embed=1' if cv else P + query + ('&size=compact' if compact else '')
    tool = 'cv' if cv else re.search(r'tool=(\w+)', query).group(1)
    what = 'the CV builder' if cv else {'paraphraser': 'the paraphraser', 'humanizer': 'the AI humanizer', 'detector': 'the AI detector'}[tool]
    box = ("margin:22px auto;max-width:800px;padding:14px 0 4px;border:1px solid #e2ddd4;border-radius:14px;background:#fff;" if compact
           else "max-width:1100px;margin:28px auto;padding:0;")
    return (f'{MARK}: {what} itself ({src}) in an iframe, created by lib/embed-host.js only when it comes near the screen -->\n'
            f'<section class="pf-try{" pf-try-compact" if compact else ""}" aria-label="{e(heading)}" style="{box}font-family:\'DM Sans\',sans-serif;box-sizing:border-box;">\n'
            f'  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 16px;margin:0 16px 8px;">'
            f'<span style="{HEAD}">{e(heading)}</span>'
            f'<a class="pf-try-full" href="{e(full)}" target="_blank" rel="noopener" style="{LINK}">Open full tool ↗</a></div>\n'
            f'  <div data-pf-embed="{e(src)}" data-pf-title="{"ParaFree CV Builder" if cv else TITLE[tool]}" style="position:relative;min-height:{760 if cv else 560}px;">'
            f'<p class="pf-embed-loading" style="position:absolute;top:0;left:0;right:0;margin:0;padding:40px 16px;text-align:center;color:#6b6660;font-size:14px;">Loading {what}…</p>'
            f'<noscript><p style="padding:16px;text-align:center;"><a href="{e(full)}">Open {what}</a></p></noscript></div>\n'
            f'</section>\n{HOST}\n')


VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
class Locate(HTMLParser):
    """End offset of the body-level element (or main/article child) containing the first <h1>."""
    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src, self.st, self.chain, self.end, self.depth = src, [], None, None, None
        self.lo = [0]
        for l in src.split('\n'): self.lo.append(self.lo[-1] + len(l) + 1)
    def pos(self): l, c = self.getpos(); return self.lo[l - 1] + c
    def handle_starttag(self, t, a):
        if t in VOID: return
        self.st.append(t)
        if t == 'h1' and self.chain is None:
            self.chain = list(self.st)
            b = self.chain.index('body')
            self.depth = b + 2 if self.chain[b + 1] == 'main' and len(self.chain) > b + 2 else b + 1
    def handle_endtag(self, t):
        if t in VOID: return
        while self.st:
            if self.st.pop() == t: break
        if self.chain and self.end is None and len(self.st) == self.depth:
            self.end = self.src.index('>', self.pos()) + 1


def insert(s, f, block, kind):
    if kind in ('para', 'cv') or not f.startswith('blog-'):
        p = Locate(s); p.feed(s)
        at = p.end
    else:                                                    # blog post: after the first paragraph of the article
        h1 = s.index('<h1')
        m = re.compile(r'<p(?![^>]*class="article-meta")[^>]*>').search(s, s.index('</h1>', h1))
        at = s.index('</p>', m.start()) + 4
    assert at, f
    nl = '\n' if s[at:at + 1] != '\n' else ''
    return s[:at] + '\n\n' + block.rstrip('\n') + nl + s[at:]


def main(files):
    for f, (kind, query, heading, full) in PAGES.items():
        if files and f not in files: continue
        raw = open(f, 'rb').read().decode('utf-8')
        crlf = '\r\n' in raw
        s = raw.replace('\r\n', '\n')
        if MARK in s:
            print('skip', f); continue
        block = embed_block(kind, query, heading, full)
        if kind in ('para-compact', 'button') and not f.startswith('blog-'):   # body level: same width and gutter as an article
            block = block.replace('\n<', '\n<div class="pf-try-wrap" style="max-width:832px;margin:0 auto;padding:0 16px;box-sizing:border-box;">\n<', 1)
            block = block.replace('\n' + HOST, '\n</div>\n' + HOST) if HOST in block else block.rstrip('\n') + '\n</div>\n'
        s = insert(s, f, block.rstrip('\n') + '\n' + END + '\n', kind)
        open(f, 'wb').write((s.replace('\n', '\r\n') if crlf else s).encode('utf-8'))
        print('added', kind, f)


if __name__ == '__main__':
    main(sys.argv[1:])
