"""Link-preview images (og:image / twitter:image), 1200×630, one per tool page: og/<page>.png.
Simple branded design: ParaFree wordmark, the tool name, one factual line, a few chips.
Fonts: Syne and DM Sans (the site's fonts, SIL Open Font License), downloaded once from the Google Fonts
repository into a temp folder.
    python scripts/build-og-images.py
"""
import os, tempfile, urllib.request
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'og')
W, H = 1200, 630
FONTS = {
    'Syne.ttf': 'https://github.com/google/fonts/raw/main/ofl/syne/Syne%5Bwght%5D.ttf',
    'DMSans.ttf': 'https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz,wght%5D.ttf',
}
PDF_CHIPS = ['Free', 'No signup', 'No watermark', 'Files stay on your device']
IMAGES = {  # file: (title, line, chips)
    'pdf-to-word': ('PDF to Word', 'Editable .docx — fonts, columns and tables kept', PDF_CHIPS),
    'word-to-pdf': ('Word to PDF', 'DOCX to PDF with selectable text', PDF_CHIPS),
    'jpg-to-pdf': ('JPG to PDF', 'Photos of your notes into one PDF', PDF_CHIPS),
    'compress-pdf': ('Compress PDF', 'To 100 KB, 200 KB, 500 KB, 1 MB or your own size', PDF_CHIPS),
    'merge-pdf': ('Merge PDF', 'Cover sheet, assignment and appendix in one file', PDF_CHIPS),
    'pdf-to-jpg': ('PDF to JPG', 'PDF pages as JPG or PNG images', PDF_CHIPS),
    'compress-pdf-to-100kb': ('Compress PDF to 100 KB', 'For form and portal upload limits', PDF_CHIPS),
    'compress-pdf-to-200kb': ('Compress PDF to 200 KB', 'For job portals and applications', PDF_CHIPS),
    'jpg-to-pdf-for-assignment': ('JPG to PDF for Assignments', 'Photos of your work into one A4 PDF', PDF_CHIPS),
    'cv-builder': ('Free CV Builder', '54 templates · ATS-readable PDF · cover letter', ['Free', 'No signup', 'No watermark']),
    'home': ('Free AI Writing Suite', 'Paraphraser that keeps formatting · CV builder · PDF tools', ['Free', 'No signup', 'No word limit']),
}


def font(name, size, weight):
    cache = os.path.join(tempfile.gettempdir(), 'parafree-og-fonts')
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        urllib.request.urlretrieve(FONTS[name], path)
    f = ImageFont.truetype(path, size)
    f.set_variation_by_name(weight)
    return f


def wrap(draw, text, f, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=f) <= width or not cur: cur = t
        else: lines.append(cur); cur = w
    lines.append(cur)
    return lines


def make(slug, title, line, chips):
    img = Image.new('RGB', (W, H))
    px = img.load()
    a, b = (15, 31, 23), (45, 106, 79)                     # #0f1f17 → #2d6a4f, diagonal
    for y in range(H):
        for x in range(W):
            t = (x / W * 0.6 + y / H * 0.4)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    d = ImageDraw.Draw(img, 'RGBA')
    d.ellipse((820, -220, 1420, 380), fill=(82, 183, 136, 38))     # soft accent circles
    d.ellipse((960, 360, 1360, 760), fill=(82, 183, 136, 26))
    # wordmark
    fw = font('Syne.ttf', 46, b'ExtraBold')
    d.text((72, 60), 'Para', font=fw, fill='white')
    d.text((72 + d.textlength('Para', font=fw), 60), 'Free', font=fw, fill=(82, 183, 136))
    d.rounded_rectangle((72, 122, 72 + 64, 128), 3, fill=(82, 183, 136))
    # title (wraps; shrinks if needed)
    size = 92
    while True:
        ft = font('Syne.ttf', size, b'ExtraBold')
        lines = wrap(d, title, ft, W - 144)
        if len(lines) <= 2 or size <= 60: break
        size -= 6
    y = 200 if len(lines) == 1 else 172
    for ln in lines:
        d.text((72, y), ln, font=ft, fill='white')
        y += int(size * 1.08)
    fl = font('DMSans.ttf', 36, b'Medium')
    d.text((72, y + 18), line, font=fl, fill=(216, 243, 220))
    # chips
    fc = font('DMSans.ttf', 26, b'SemiBold')
    x, cy = 72, H - 112
    for c in chips:
        w = d.textlength(c, font=fc) + 40
        d.rounded_rectangle((x, cy, x + w, cy + 50), 25, fill=(255, 255, 255, 30), outline=(255, 255, 255, 90), width=2)
        d.text((x + 20, cy + 9), c, font=fc, fill='white')
        x += w + 14
    fu = font('DMSans.ttf', 28, b'Bold')
    u = 'parafree.app'
    d.text((W - 72 - d.textlength(u, font=fu), 66), u, font=fu, fill=(216, 243, 220))
    os.makedirs(OUT, exist_ok=True)
    img.save(os.path.join(OUT, slug + '.png'), optimize=True)


if __name__ == '__main__':
    for slug, (t, l, c) in IMAGES.items():
        make(slug, t, l, c)
        print('og/' + slug + '.png', os.path.getsize(os.path.join(OUT, slug + '.png')), 'bytes')
