// Study Pack page (studypack.html): every input type routes to the right path and ends in ONE study-pack call;
// the three tabs (Notes / Flashcards / Quiz) come from that one answer; YouTube without captions offers paste /
// AI-on-the-video (and a clear message when the AI can't watch it); audio goes to Groq Whisper first — split into
// pieces in the browser (MP3 at frame boundaries, other formats re-encoded as 16 kHz mono WAV), one request per
// piece, then one pack call — with Gemini (chunked upload + processing poll) only when Whisper is unavailable;
// the length limit / "too long" messages, the audio switch and the daily cap; error answers never render a partial
// pack. Homepage card + nav link.
// Pages are served from THIS checkout; /api/process and YouTube are MOCKED (never live); GA, ads, fonts and images
// are BLOCKED; CDN libraries are cached on disk. Run: npx playwright test tests/studypack.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com|ko-fi\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml' };
const FX = (f: string) => path.join(ROOT, 'tests', 'fixtures', f);
test.setTimeout(120000);

const PACK = {
  key_points: ['Photosynthesis turns light into chemical energy.', 'It happens in chloroplasts.', 'Chlorophyll absorbs red and blue light.'],
  flashcards: [{ front: 'Where does photosynthesis happen?', back: 'In chloroplasts.' }, { front: 'What does chlorophyll absorb?', back: 'Red and blue light.' }, { front: 'What fixes CO2?', back: 'The Calvin cycle.' }],
  quiz: [
    { question: 'Where does photosynthesis take place?', options: ['Mitochondria', 'Chloroplasts', 'Nucleus', 'Ribosome'], answer_index: 1, explanation: 'Chloroplasts hold chlorophyll.' },
    { question: 'Which light is reflected?', options: ['Red', 'Blue', 'Green', 'Violet'], answer_index: 2, explanation: 'Green is reflected.' },
    { question: 'What does the Calvin cycle fix?', options: ['O2', 'CO2', 'N2', 'H2O'], answer_index: 1, explanation: 'It fixes carbon dioxide.' },
  ],
};
const CONFIG = { enabled: true, cap: 5, maxBytes: 50 * 1048576, maxSeconds: 3600, chunkBytes: 2359296, pieceBytes: 3 * 1048576, pieceSeconds: 90, gemini: true, whisper: true };
type Reply = { status?: number; body: any };
type Api = (body: any, calls: any[]) => Reply | undefined;

async function cdnRoute(route: Route) {
  const url = route.request().url();
  fs.mkdirSync(CDN_CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const body = path.join(CDN_CACHE, key), meta = body + '.json';
  if (!fs.existsSync(body)) {
    const resp = await route.fetch();
    if (resp.status() !== 200) return route.fulfill({ response: resp });
    fs.writeFileSync(body, await resp.body());
    fs.writeFileSync(meta, JSON.stringify({ ct: resp.headers()['content-type'] || 'application/octet-stream' }));
  }
  const { ct } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return route.fulfill({ status: 200, body: fs.readFileSync(body), headers: { 'content-type': ct, 'access-control-allow-origin': '*' } });
}
// api(): per-test answers; the defaults: config = CONFIG, studypack = PACK. youtube(): caption answer (body text).
async function setup(page: Page, opts: { api?: Api; config?: any; youtube?: (url: string) => string } = {}) {
  const ctx = page.context(), errors: string[] = [], calls: any[] = [], yt: string[] = [], outside: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route(/^https:\/\/(www\.)?youtube\.com\//, (route) => {
    yt.push(route.request().url());
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'https://parafree.app', 'content-type': 'text/html' }, body: opts.youtube ? opts.youtube(route.request().url()) : '' });
  });
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      let r = opts.api ? opts.api(body, calls) : undefined;
      if (!r && body.type === 'studypack_config') r = { body: { success: true, audio: opts.config || CONFIG } };
      if (!r && (body.type === 'studypack' || body.type === 'studypack_youtube')) r = { body: { success: true, pack: PACK } };
      if (!r) r = { status: 400, body: { success: false, error: 'bad_request', message: 'unexpected in test' } };
      return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  page.on('request', (r) => { const u = r.url(); if (!BLOCKED.test(u) && !/^https:\/\/(parafree\.app|cdnjs\.cloudflare\.com|(www\.)?youtube\.com)\//.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) outside.push(u); });
  return { errors, calls, yt, outside };
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/studypack.html');
  await page.waitForFunction(() => !!(window as any).PFStudyPack && !!(window as any).PFTextRank);
}
const packCalls = (calls: any[]) => calls.filter((c) => c.type !== 'studypack_config');
const LONG = Array.from({ length: 14 }, (_, p) => Array.from({ length: 5 }, (_, s) =>
  ['Photosynthesis converts light energy into chemical energy inside the chloroplasts of plant cells.',
    'The Calvin cycle uses ATP and NADPH to fix carbon dioxide into sugars.',
    'Chlorophyll absorbs mostly red and blue light and reflects green light.',
    'Stomata on the leaf surface control gas exchange and water loss.',
    `My cousin played football on weekend number ${p} and enjoyed it a lot.`][(p + s) % 5]).join(' ')).join('\n\n');
async function expectPack(page: Page) {
  await expect(page.locator('#spOut')).toBeVisible();
  await expect(page.locator('#spNotes li')).toHaveText(PACK.key_points);
}
async function docx(paras: string[]) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.slice(0, 20)}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${p.slice(20)}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
  return z.generateAsync({ type: 'nodebuffer' });
}
async function pptx(slides: string[][]) {
  const z = new JSZip();
  slides.forEach((lines, i) => z.file(`ppt/slides/slide${i + 1}.xml`, '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`).join('') + '</p:spTree></p:cSld></p:sld>'));
  return z.generateAsync({ type: 'nodebuffer' });
}

// ─────────────────────────────────────────────────────────────
test.describe('text inputs → TextRank → ONE call', () => {
  test('paste: TextRank trims the text, one call returns notes + flashcards + quiz; tabs switch without new calls', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('#spText').fill(LONG);
    await page.locator('input[name="spMode"][value="exam"]').check();
    await page.locator('#spGo').click();
    await expectPack(page);
    const sent = packCalls(net.calls);
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual({ type: 'studypack', text: sent[0].text, mode: 'exam', inputType: 'text' });   // no prompt field
    const inWords = LONG.split(/\s+/).length, outWords = sent[0].text.split(/\s+/).length;
    expect(outWords / inWords).toBeGreaterThan(0.35);
    expect(outWords / inWords).toBeLessThan(0.65);
    expect(sent[0].text).toContain('Photosynthesis converts light energy');
    await expect(page.locator('#spTrStat')).toContainText('TextRank kept the');
    await expect(page.locator('#spCountNotes')).toHaveText('3');
    // flashcards: flip + next
    await page.locator('.sp-tab[data-view="cards"]').click();
    await expect(page.locator('#spCardFront')).toHaveText('Where does photosynthesis happen?');
    await expect(page.locator('#spCardBack')).toBeHidden();
    await page.locator('#spCard').click();
    await expect(page.locator('#spCardBack')).toHaveText('In chloroplasts.');
    await page.locator('#spNext').click();
    await expect(page.locator('#spCardFront')).toHaveText('What does chlorophyll absorb?');
    await expect(page.locator('#spCardPos')).toHaveText('2 / 3');
    // quiz: one right, one wrong, explanation + score
    await page.locator('.sp-tab[data-view="quiz"]').click();
    await page.locator('.sp-q').nth(0).getByText('Chloroplasts').click();
    await page.locator('.sp-q').nth(1).getByText('Red').click();
    await expect(page.locator('.sp-q').nth(0).locator('.sp-expl')).toHaveText('✓ Correct. Chloroplasts hold chlorophyll.');
    await expect(page.locator('.sp-q').nth(1).locator('.sp-expl')).toHaveText('✗ Not quite. Green is reflected.');
    await expect(page.locator('.sp-q').nth(1).locator('.sp-right')).toHaveText('Green');
    await expect(page.locator('#spScore')).toHaveText('Score: 1 / 2 answered (3 questions)');
    await page.locator('.sp-tab[data-view="notes"]').click();
    expect(packCalls(net.calls).length).toBe(1);                                   // switching tabs never calls the AI
    // download .txt with all three parts
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#spDownload').click()]);
    const txt = fs.readFileSync((await dl.path())!, 'utf8');
    expect(txt).toContain('KEY POINTS');
    expect(txt).toContain('Q: Where does photosynthesis happen?');
    expect(txt).toContain('Answer: B — Chloroplasts hold chlorophyll.');
    expect(net.outside).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  test('PDF, Word and PowerPoint are read in the browser and sent as text with their input type (one call each)', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('.sp-in[data-input="file"]').click();
    const cases: [any, string, string][] = [
      [FX('pdf-tools/text.pdf'), 'pdf', 'Chlorophyll absorbs light'],
      [{ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: await docx(['The mitochondria is the powerhouse of the cell and makes ATP for the cell to use every day.', 'Cellular respiration releases energy from glucose in several connected stages that need oxygen.', 'Glycolysis happens in the cytoplasm and splits one glucose molecule into two pyruvate molecules.']) }, 'docx', 'The mitochondria is the powerhouse of the cell'],
      [{ name: 'lecture.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: await pptx([['Week 3: Plate Tectonics', 'Earth’s lithosphere is divided into large moving plates.'], ['Plates move a few centimetres each year driven by mantle convection.', 'Earthquakes and volcanoes cluster along plate boundaries around the world.']]) }, 'pptx', 'Week 3: Plate Tectonics'],
    ];
    for (const [file, type, phrase] of cases) {
      const n = packCalls(net.calls).length;
      await page.locator('#spFile').setInputFiles(file);
      await page.locator('#spGo').click();
      await expect.poll(() => packCalls(net.calls).length, { timeout: 60000 }).toBe(n + 1);
      const c = packCalls(net.calls)[n];
      expect(c.type, type).toBe('studypack');
      expect(c.inputType, type).toBe(type);
      expect(c.text, type).toContain(phrase);
      await expectPack(page);
    }
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('YouTube', () => {
  test('captions readable in the browser → text path (inputType youtube), no server video job', async ({ page }) => {
    const caption = JSON.stringify({ events: LONG.split('. ').map((s) => ({ segs: [{ utf8: s + '. ' }] })) });
    const net = await setup(page, { youtube: (u) => (/lang=en&fmt=json3/.test(u) ? caption : '') });
    await open(page);
    await page.locator('.sp-in[data-input="youtube"]').click();
    await page.locator('#spYtUrl').fill('https://youtu.be/dQw4w9WgXcQ');
    await page.locator('#spGo').click();
    await expectPack(page);
    expect(net.yt[0]).toBe('https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=json3');
    const c = packCalls(net.calls);
    expect(c.map((x) => x.type)).toEqual(['studypack']);
    expect(c[0].inputType).toBe('youtube');
    expect(c[0].text).toContain('Calvin cycle');
    expect(net.errors).toEqual([]);
  });

  test('no captions → clear message with paste / AI-on-the-video / upload; "Use AI on the video" makes one call', async ({ page }) => {
    const net = await setup(page);                                              // every caption request comes back empty
    await open(page);
    await page.locator('.sp-in[data-input="youtube"]').click();
    await page.locator('#spYtUrl').fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await page.locator('#spGo').click();
    await expect(page.locator('#spYtHelp')).toBeVisible();
    await expect(page.locator('#spYtHelp')).toContainText('We couldn’t read this video’s captions from your browser.');
    await expect(page.locator('#spYtAiNote')).toHaveText('Uses one of today’s 5 audio/video study packs.');
    expect(net.yt.length).toBe(4);                                              // en, en-US, en-GB, auto-captions
    expect(packCalls(net.calls)).toEqual([]);                                   // nothing sent yet
    await page.locator('#spYtAi').click();
    await expectPack(page);
    expect(packCalls(net.calls)).toEqual([{ type: 'studypack_youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'standard' }]);
    // "Paste the transcript" goes to the paste box
    await page.locator('#spGo').click();
    await expect(page.locator('#spYtHelp')).toBeVisible();
    await page.locator('#spYtPaste').click();
    await expect(page.locator('#spIn-paste')).toBeVisible();
    await expect(page.locator('#spText')).toBeFocused();
    expect(net.errors).toEqual([]);
  });

  test('"Use AI on the video" when no Gemini model can watch it → the server’s clear message, no pack', async ({ page }) => {
    const net = await setup(page, { api: (b) => b.type === 'studypack_youtube'
      ? { status: 503, body: { success: false, error: 'ai_unavailable', message: 'The AI can’t watch YouTube videos right now. Paste the transcript instead, or upload the audio.' } } : undefined });
    await open(page);
    await page.locator('.sp-in[data-input="youtube"]').click();
    await page.locator('#spYtUrl').fill('https://youtu.be/dQw4w9WgXcQ');
    await page.locator('#spGo').click();
    await page.locator('#spYtAi').click();
    await expect(page.locator('#spStatus')).toHaveText('The AI can’t watch YouTube videos right now. Paste the transcript instead, or upload the audio.');
    await expect(page.locator('#spOut')).toBeHidden();
    expect(packCalls(net.calls).map((x) => x.type)).toEqual(['studypack_youtube']);
  });

  test('not a YouTube link → message, no requests', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await page.locator('.sp-in[data-input="youtube"]').click();
    await page.locator('#spYtUrl').fill('https://vimeo.com/123');
    await page.locator('#spGo').click();
    await expect(page.locator('#spStatus')).toContainText('Paste a YouTube video link');
    expect(net.yt).toEqual([]);
    expect(packCalls(net.calls)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('audio / video', () => {
  const audioFile = (bytes: number) => ({ name: 'lecture.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(bytes, 7) });
  // MP3-like stream: a frame header (FF FB 90 64) every 417 bytes, as in 128 kbps / 44.1 kHz MPEG-1 Layer III
  const mp3File = (bytes: number) => {
    const b = Buffer.alloc(bytes, 0x11);
    for (let o = 0; o + 4 <= bytes; o += 417) b.set([0xFF, 0xFB, 0x90, 0x64], o);
    return { name: 'lecture.mp3', mimeType: 'audio/mpeg', buffer: b };
  };
  // a real WAV (8 kHz mono 16-bit tone) that the browser can decode
  const wavFile = (seconds: number) => {
    const n = 8000 * seconds, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), 44 + i * 2);
    return { name: 'lecture.wav', mimeType: 'audio/wav', buffer: b };
  };
  // the Whisper route, answered like the server: one sealed piece per request, then the pack
  const whisperApi = (extra?: Api): Api => (b, calls) => {
    const x = extra && extra(b, calls);
    if (x) return x;
    if (b.type === 'studypack_audio_start') return { body: { success: true, route: 'whisper', job: 'J-1', pieces: b.pieces, remaining: 4 } };
    if (b.type === 'studypack_audio_piece') return { body: { success: true, piece: 'S' + b.index, index: b.index } };
    if (b.type === 'studypack_audio_pack') return { body: { success: true, pack: PACK, via: 'whisper' } };
  };
  const pick = async (page: Page, file: any) => {
    await page.locator('.sp-in[data-input="media"]').click();
    await page.locator('#spMedia').setInputFiles(file);
    await page.locator('#spGo').click();
  };

  test('Whisper first: a small file is ONE piece as it is → sealed piece → ONE pack call; nothing goes to Gemini', async ({ page }) => {
    const net = await setup(page, { api: whisperApi() });
    await open(page);
    await page.locator('.sp-in[data-input="media"]').click();
    await expect(page.locator('#spMediaNote')).toContainText('Up to 50 MB and 60 minutes · 5 audio/video study packs per day. The recording is sent to our AI provider to be transcribed');
    await pick(page, audioFile(3000));
    await expectPack(page);
    const c = packCalls(net.calls);
    expect(c.map((x) => x.type)).toEqual(['studypack_audio_start', 'studypack_audio_piece', 'studypack_audio_pack']);
    expect(c[0]).toEqual({ type: 'studypack_audio_start', pieces: 1, split: true, mime: 'audio/mpeg', size: 3000, name: 'lecture.mp3', seconds: 0, mode: 'standard' });
    expect(c[1]).toMatchObject({ job: 'J-1', index: 0, mime: 'audio/mpeg', name: 'lecture.mp3' });
    expect(Buffer.from(c[1].data, 'base64').length).toBe(3000);
    expect(c[2]).toEqual({ type: 'studypack_audio_pack', job: 'J-1', pieces: ['S0'], mode: 'standard' });
    expect(net.errors).toEqual([]);
  });

  test('chunked transcription: a long MP3 is cut at frame boundaries, pieces go one by one, then ONE pack call', async ({ page }) => {
    const net = await setup(page, { api: whisperApi(), config: Object.assign({}, CONFIG, { pieceBytes: 40000 }) });
    await open(page);
    const f = mp3File(100000);
    await pick(page, f);
    await expectPack(page);
    const c = packCalls(net.calls), pieces = c.filter((x) => x.type === 'studypack_audio_piece');
    expect(c[0]).toMatchObject({ type: 'studypack_audio_start', pieces: pieces.length, split: true, size: 100000 });
    expect(pieces.length).toBeGreaterThanOrEqual(5);                            // 40000 − 16 KiB margin per piece
    expect(pieces.map((p) => p.index)).toEqual(pieces.map((_, i) => i));
    const bufs = pieces.map((p) => Buffer.from(p.data, 'base64'));
    expect(Buffer.concat(bufs).equals(f.buffer)).toBe(true);                    // nothing lost or repeated
    bufs.forEach((b, i) => {
      expect(b.length).toBeLessThanOrEqual(40000 - 16384);
      if (i > 0) expect([b[0], b[1]]).toEqual([0xFF, 0xFB]);                    // every later piece starts on a frame header
    });
    expect(pieces.map((p) => p.name)).toEqual(pieces.map((_, i) => `part-${i + 1}.mp3`));
    expect(c[c.length - 1]).toEqual({ type: 'studypack_audio_pack', job: 'J-1', pieces: pieces.map((_, i) => 'S' + i), mode: 'standard' });
    expect(net.errors).toEqual([]);
  });

  test('chunked transcription: other formats are decoded and re-encoded as 16 kHz mono WAV pieces', async ({ page }) => {
    const net = await setup(page, { api: whisperApi(), config: Object.assign({}, CONFIG, { pieceBytes: 400000 }) });
    await open(page);
    await pick(page, wavFile(25));
    await expectPack(page);
    const c = packCalls(net.calls), pieces = c.filter((x) => x.type === 'studypack_audio_piece');
    expect(c[0]).toMatchObject({ type: 'studypack_audio_start', pieces: 3, split: true, seconds: 25 });
    expect(pieces.map((p) => [p.name, p.mime])).toEqual([['part-1.wav', 'audio/wav'], ['part-2.wav', 'audio/wav'], ['part-3.wav', 'audio/wav']]);
    const bufs = pieces.map((p) => Buffer.from(p.data, 'base64'));
    bufs.forEach((b) => {
      expect(b.toString('latin1', 0, 4)).toBe('RIFF');
      expect(b.readUInt16LE(22)).toBe(1);                                       // mono
      expect(b.readUInt32LE(24)).toBe(16000);                                   // 16 kHz
      expect(b.length).toBeLessThanOrEqual(400000);
    });
    expect(bufs.map((b) => (b.length - 44) / 32000)).toEqual([12, 12, 1]);      // seconds per piece
    expect(net.errors).toEqual([]);
  });

  test('recording longer than the limit → "too long, try a shorter clip" before anything is sent', async ({ page }) => {
    const net = await setup(page, { api: whisperApi(), config: Object.assign({}, CONFIG, { maxSeconds: 120 }) });
    await open(page);
    await pick(page, wavFile(130));
    await expect(page.locator('#spStatus')).toHaveText('This recording is too long — try a shorter clip (up to 2 minutes).');
    await expect(page.locator('#spOut')).toBeHidden();
    expect(packCalls(net.calls)).toEqual([]);
  });

  test('transcription runs out of time on the server → its "too long" message, no pack call, no partial pack', async ({ page }) => {
    const net = await setup(page, { api: whisperApi((b) => b.type === 'studypack_audio_piece' && b.index === 1
      ? { status: 504, body: { success: false, error: 'too_long', message: 'This recording took too long to transcribe — try a shorter clip.' } } : undefined),
    config: Object.assign({}, CONFIG, { pieceBytes: 40000 }) });
    await open(page);
    await pick(page, mp3File(100000));
    await expect(page.locator('#spStatus')).toHaveText('This recording took too long to transcribe — try a shorter clip.');
    await expect(page.locator('#spOut')).toBeHidden();
    expect(packCalls(net.calls).map((x) => x.type)).toEqual(['studypack_audio_start', 'studypack_audio_piece', 'studypack_audio_piece']);
  });

  test('Whisper unavailable mid-job → Gemini (secondary) gets the file, keeping the same job: chunks → poll → pack', async ({ page }) => {
    let polls = 0;
    const net = await setup(page, { api: (b) => {
      if (b.type === 'studypack_audio_start') return { body: b.job ? { success: true, route: 'gemini', token: 'T-upload', chunkBytes: 1024 } : { success: true, route: 'whisper', job: 'J-1', pieces: b.pieces } };
      if (b.type === 'studypack_audio_piece') return { status: 503, body: { success: false, error: 'whisper_unavailable', message: 'busy' } };
      if (b.type === 'studypack_audio_chunk') return { body: b.offset + 1024 >= 3000 ? { success: true, done: true, token: 'T-file' } : { success: true, next: b.offset + 1024 } };
      if (b.type === 'studypack_audio_generate') return ++polls === 1 ? { status: 202, body: { success: false, processing: true } } : { body: { success: true, pack: PACK, via: 'gemini' } };
    } });
    await open(page);
    await pick(page, audioFile(3000));
    await expectPack(page);
    const c = packCalls(net.calls);
    expect(c.map((x) => x.type + (x.offset !== undefined ? '@' + x.offset : ''))).toEqual([
      'studypack_audio_start', 'studypack_audio_piece', 'studypack_audio_start',
      'studypack_audio_chunk@0', 'studypack_audio_chunk@1024', 'studypack_audio_chunk@2048', 'studypack_audio_generate', 'studypack_audio_generate']);
    expect(c[2]).toMatchObject({ split: false, job: 'J-1', size: 3000 });
    expect(Buffer.from(c[5].data, 'base64').length).toBe(3000 - 2048);
    expect(c[6].token).toBe('T-file');
    expect(net.errors).toEqual([]);
  });

  test('Whisper reported unavailable in the config → straight to the Gemini upload (no pieces)', async ({ page }) => {
    const net = await setup(page, { config: Object.assign({}, CONFIG, { whisper: false }), api: (b) => {
      if (b.type === 'studypack_audio_start') return { body: { success: true, route: 'gemini', token: 'T-upload', chunkBytes: 4096 } };
      if (b.type === 'studypack_audio_chunk') return { body: { success: true, done: true, token: 'T-file' } };
      if (b.type === 'studypack_audio_generate') return { body: { success: true, pack: PACK, via: 'gemini' } };
    } });
    await open(page);
    await pick(page, audioFile(3000));
    await expectPack(page);
    const c = packCalls(net.calls);
    expect(c.map((x) => x.type)).toEqual(['studypack_audio_start', 'studypack_audio_chunk', 'studypack_audio_generate']);
    expect(c[0]).toMatchObject({ pieces: 0, split: false });
  });

  test('daily cap reached → the server message is shown, nothing else is sent', async ({ page }) => {
    const net = await setup(page, { api: (b) => b.type === 'studypack_audio_start'
      ? { status: 429, body: { success: false, error: 'audio_cap', message: 'You’ve used today’s 5 audio/video study packs. Paste text or a transcript instead, or come back tomorrow.' } } : undefined });
    await open(page);
    await pick(page, audioFile(3000));
    await expect(page.locator('#spStatus')).toContainText('You’ve used today’s 5 audio/video study packs.');
    await expect(page.locator('#spOut')).toBeHidden();
    expect(packCalls(net.calls).map((x) => x.type)).toEqual(['studypack_audio_start']);
  });

  test('audio switched off (flag) → picker hidden, explanation shown, no upload; YouTube offers no AI option', async ({ page }) => {
    const net = await setup(page, { config: Object.assign({}, CONFIG, { enabled: false }) });
    await open(page);
    await page.locator('.sp-in[data-input="media"]').click();
    await expect(page.locator('#spMediaNote')).toHaveText('Audio and video study packs are switched off right now — paste the text or a transcript instead.');
    await expect(page.locator('#spMediaPick')).toBeHidden();
    await page.locator('#spGo').click();
    await expect(page.locator('#spStatus')).toContainText('Choose an audio or video file first.');
    await page.locator('.sp-in[data-input="youtube"]').click();
    await page.locator('#spYtUrl').fill('https://youtu.be/dQw4w9WgXcQ');
    await page.locator('#spGo').click();
    await expect(page.locator('#spYtHelp')).toBeVisible();
    await expect(page.locator('#spYtAi')).toBeHidden();
    expect(packCalls(net.calls)).toEqual([]);
  });

  test('file over the size limit → message, no upload', async ({ page }) => {
    const net = await setup(page, { config: Object.assign({}, CONFIG, { maxBytes: 2000 }) });
    await open(page);
    await pick(page, audioFile(3000));
    await expect(page.locator('#spStatus')).toContainText('Audio and video files can be up to');
    expect(packCalls(net.calls)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('errors and pages', () => {
  test('unusable AI answer (server 502) → clear message, no partial pack on screen', async ({ page }) => {
    const net = await setup(page, { api: (b) => b.type === 'studypack'
      ? { status: 502, body: { success: false, error: 'invalid_output', message: 'The AI answer could not be turned into a study pack. Please try again.' } } : undefined });
    await open(page);
    await page.locator('#spText').fill(LONG);
    await page.locator('#spGo').click();
    await expect(page.locator('#spStatus')).toHaveText('The AI answer could not be turned into a study pack. Please try again.');
    await expect(page.locator('#spOut')).toBeHidden();
    expect(net.errors).toEqual([]);
  });

  test('study pack page: title, description, canonical, FAQ = its structured data; homepage card + nav entries', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await expect(page).toHaveTitle(/Study Pack Maker/);
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toContain('Turn notes, PDFs, slides, or a YouTube lecture into key points, flashcards, and a quiz — free, no sign-up.');
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://parafree.app/studypack.html');
    const faq = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent!)).find((j) => j['@type'] === 'FAQPage'));
    const visible = await page.locator('.faq-item').evaluateAll((els) => els.map((e) => [e.querySelector('.faq-q')!.textContent, e.querySelector('.faq-a')!.textContent]));
    expect(faq.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text])).toEqual(visible);
    const html = fs.readFileSync(path.join(ROOT, 'studypack.html'), 'utf8');
    expect(html).not.toMatch(/\b(the best|best free|number one|the only|only free)\b|#1\b/i);   // honest copy: no superlatives
    await page.goto('/');
    await expect(page.locator('a.pf-studypack-card')).toContainText('Turn notes, PDFs, slides, or a YouTube lecture into key points, flashcards, and a quiz — free, no sign-up.');
    await expect(page.locator('#homeNavLinks a[href="/studypack.html"]')).toHaveText('Study Pack');
    await expect(page.locator('#mobileMenu a[href="/studypack.html"]')).toHaveCount(1);
    expect(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8')).toContain('<loc>https://parafree.app/studypack.html</loc>');
    expect(net.errors).toEqual([]);
  });
});
