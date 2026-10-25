// CV builder quality fixes (branch cv-quality-fixes): AI generators use only the user's data (no invented facts or
// figures, placeholders instead, no third person), the cover letter keeps the CV's numbers, skills with commas inside
// brackets stay one skill, optional education details, section Move up / Move down, opt-in references, date hints.
// Pages are served from THIS checkout; /api/process is MOCKED (never the live API); GA, ads and fonts are BLOCKED;
// CDN libraries are cached on disk. Run: npx playwright test tests/cv-quality.spec.ts --workers=1
import { test, expect, Page, Route } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = process.cwd();
const CDN_CACHE = path.join(os.tmpdir(), 'parafree-cdn-cache');
const BLOCKED = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const NOTE = 'AI drafts may include placeholder figures like [X]% — replace them with your real numbers.';
test.setTimeout(180000);

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
// /api/process is mocked: `replies` are the AI answers in order (the last one repeats); every request body is kept
async function setup(page: Page, replies: string[] = []) {
  const ctx = page.context(), errors: string[] = [], calls: any[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(BLOCKED, (r) => r.abort());
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//, cdnRoute);
  await ctx.route('https://parafree.app/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/process') {
      const body = JSON.parse(route.request().postData() || '{}');
      const ai = body.type === 'cv_build' || body.type === 'cover_letter';
      if (ai) calls.push(body);
      const result = replies[Math.min(calls.length, replies.length) - 1];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ai && result ? { success: true, result } : { success: false }) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return { errors, calls };
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/cv-builder.html');
  await page.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} (window as any).pfResetSectionOrder(); });
}
const TEMPLATES = (page: Page) => page.evaluate(() => Object.keys((0, eval)('RENDER_MAP')) as string[]);
const FULL: Record<string, string> = {
  '#f-name': 'Jordan Rivers', '#f-jobtitle': 'Cybersecurity Analyst', '#f-email': 'jordan@example.com', '#f-location': 'Sydney',
  '#f-summary': 'Analyst focused on detection and response.',
  '.exp-role': 'Security Analyst', '.exp-company': 'Telstra', '.exp-start': 'Jan 2021', '.exp-end': 'Present',
  '.exp-bullets': 'Mentored four junior analysts\nReduced triage time from 45 minutes to under 10\nFound 30+ vulnerabilities in client networks',
  '.edu-degree': 'BSc Computer Science', '.edu-school': 'University of Sydney', '.edu-start': '2017', '.edu-end': '2020',
  '#f-skills': 'SIEM (Splunk, Sentinel), Python, Cloud Security (AWS, Azure)', '#f-certs': 'CompTIA Security+',
};
// fills the form like a user would (input events on the fields; the first experience / education card)
async function fill(page: Page, v: Record<string, string> = FULL) {
  await page.evaluate((v) => {
    const w = window as any;
    if (!document.querySelector('.exp-entry')) w.addExp();
    if (!document.querySelector('.edu-entry')) w.addEdu();
    for (const [sel, val] of Object.entries(v)) {
      const el = document.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, v);
}
const val = (page: Page, sel: string) => page.evaluate((s) => (document.querySelector(s) as HTMLInputElement).value, sel);
const previewText = (page: Page) => page.evaluate(() => document.getElementById('cv-preview')!.innerText);

// ─────────────────────────────────────────────────────────────
test.describe('AI generators use only what the user entered', () => {
  test('summary from a job title only: strict rules sent, invented figures become placeholders, honest-draft note', async ({ page }) => {
    const net = await setup(page, ['I bring three years of hands-on experience with SIEM tools and cut alert noise by 15%.']);
    await open(page);
    await page.evaluate(() => { for (const id of ['f-name', 'f-jobtitle']) { const el = document.getElementById(id) as HTMLInputElement; el.value = id === 'f-name' ? 'Jordan Rivers' : 'Cybersecurity Analyst'; el.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.evaluate(() => (window as any).toggleSection('summary'));
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#summary-status')).toContainText('Add your experience and skills for a more specific summary.');
    expect(net.calls.length).toBe(1);
    const sent = net.calls[0];
    expect(sent.type).toBe('cv_build');
    expect(sent.prompt).toBeUndefined();                                     // the backend's strict system prompt is used
    expect(sent.text).toContain('Only a target role was entered');
    expect(sent.text).toContain('FACT RULES');
    expect(sent.text).toContain('Never invent a number');
    expect(sent.text).toContain('[X]%');
    expect(sent.text).toContain('Candidate data:\nTarget / current role: Cybersecurity Analyst');
    expect(sent.text).not.toContain('Jordan');                               // the name is not part of the facts
    expect(sent.text).toMatch(/Never use he, she, they/);
    expect(await val(page, '#f-summary')).toBe('I bring [N] years of hands-on experience with SIEM tools and cut alert noise by [X]%.');
    await expect(page.locator('#ai-summary-btn')).toContainText('Generate with AI');   // label restored
    expect(net.errors).toEqual([]);
  });

  test('summary: third-person reply is retried once; the CV facts (roles, dates, bullets, education) are sent, the old summary is not', async ({ page }) => {
    const net = await setup(page, ['She excels at threat hunting. Her expertise spans detection.', 'Security analyst at Telstra who mentored four junior analysts and cut triage time from 45 minutes to under 10.']);
    await open(page);
    await fill(page);
    await page.evaluate(() => (window as any).aiGenSummary());
    await expect.poll(() => val(page, '#f-summary')).toBe('Security analyst at Telstra who mentored four junior analysts and cut triage time from 45 minutes to under 10.');
    expect(net.calls.length).toBe(2);
    expect(net.calls[1].text).toContain('your previous draft described the candidate as he/she');
    const facts = net.calls[0].text;
    for (const f of ['- Security Analyst at Telstra (Jan 2021 – Present)', '    • Mentored four junior analysts', '    • Reduced triage time from 45 minutes to under 10',
      '- BSc Computer Science at University of Sydney (2017 – 2020)', 'Skills: SIEM (Splunk, Sentinel), Python, Cloud Security (AWS, Azure)', 'Certifications: CompTIA Security+'])
      expect(facts).toContain(f);
    expect(facts).not.toContain('Analyst focused on detection and response.');
    expect(facts).toContain('implied first person');
    expect(net.errors).toEqual([]);
  });

  test('bullets for an intern with no duties: generic placeholders, no invented metrics, note asking for duties', async ({ page }) => {
    const net = await setup(page, ['Monitored 200 daily alerts\nReduced false positives by 15%\nResponded to 30+ incidents']);
    await open(page);
    await fill(page, { '#f-name': 'Sam Lee', '#f-jobtitle': 'Cybersecurity Intern', '.exp-role': 'Cybersecurity Intern', '.exp-company': 'Acme', '.exp-bullets': '' });
    await page.evaluate(() => (window as any).toggleSection('experience'));
    await page.locator('.exp-entry button', { hasText: 'Generate with AI' }).click();
    await expect.poll(() => val(page, '.exp-bullets')).toBe('Monitored [N] daily alerts\nReduced false positives by [X]%\nResponded to [N]+ incidents');
    await expect(page.locator('.exp-entry .cv-status')).toContainText('These are generic placeholders — add your actual duties for accurate bullets.');
    expect(net.calls[0].text).toContain('No duties were entered for this role');
    expect(net.calls[0].text).toContain('Duties / notes entered by the candidate: (none)');
    expect(net.calls[0].text).toContain('claim no results, numbers or achievements');
    expect(net.errors).toEqual([]);
  });

  test('bullets from notes keep the user\'s figures exactly; a new figure becomes a placeholder', async ({ page }) => {
    const net = await setup(page, ['Mentored 4 junior analysts\nCut triage time from 45 minutes to under 10\nLed a team of 12 engineers']);
    await open(page);
    await fill(page, { '#f-name': 'Jordan Rivers', '.exp-role': 'Security Analyst', '.exp-company': 'Telstra',
      '.exp-bullets': 'mentored four junior analysts, cut triage time from 45 minutes to under 10' });
    await page.evaluate(() => (window as any).toggleSection('experience'));
    await page.locator('.exp-entry button', { hasText: 'Generate with AI' }).click();
    await expect.poll(() => val(page, '.exp-bullets')).toBe('Mentored 4 junior analysts\nCut triage time from 45 minutes to under 10\nLed a team of [N] engineers');
    await expect(page.locator('.exp-entry .cv-status')).toContainText('Replace the placeholders like [X] with your real figures.');
    expect(net.calls[0].text).toContain('Every bullet must come from the notes');
    expect(net.errors).toEqual([]);
  });

  test('cover letter keeps every CV number: invented / altered metrics are removed, the CV\'s own figures stay', async ({ page }) => {
    const reply = [
      'In my role at Telstra I led a team of 15 engineers and cut response times from 4 hours to under 30 minutes.',
      'I found 120 high-risk vulnerabilities and improved detection by 42%.',
      'I mentored four junior analysts, reduced triage time from 45 minutes to under 10 and found 30+ vulnerabilities in client networks.',
    ].join('\n\n');
    const net = await setup(page, [reply]);
    await open(page);
    await fill(page);
    await page.evaluate(() => (window as any).switchTab('cover'));
    const jd = Array.from({ length: 60 }, (_, i) => `Requirement ${i + 1}: 5+ years of SOC experience with incident response and threat hunting.`).join('\n\n');
    await page.evaluate((jd) => {
      (document.getElementById('clCompany') as HTMLInputElement).value = 'Atlassian';
      (document.getElementById('clJobTitle') as HTMLInputElement).value = 'Senior Security Analyst';
      (document.getElementById('clJobDesc') as HTMLTextAreaElement).value = jd;
    }, jd);
    await page.locator('#cover-btn').click();
    await expect(page.locator('#cover-status')).toContainText('Replace the placeholders like [X] with your real figures.');
    const letter: string = await page.evaluate('coverLetterText');
    expect(letter).toBe([
      'In my role at Telstra I led a team of [N] engineers and cut response times from [N] hours to under [N] minutes.',
      'I found [N] high-risk vulnerabilities and improved detection by [X]%.',
      'I mentored four junior analysts, reduced triage time from 45 minutes to under 10 and found 30+ vulnerabilities in client networks.',
    ].join('\n\n'));
    for (const bad of ['15 engineers', '4 hours', '30 minutes', '120', '42%']) expect(letter).not.toContain(bad);
    // the request: one call with the full CV facts, the consistency rules, first person; the JD is marked as not-facts
    expect(net.calls.length).toBe(1);
    const t = net.calls[0].text;
    expect(net.calls[0].type).toBe('cover_letter');
    for (const f of ['- Security Analyst at Telstra (Jan 2021 – Present)', '    • Mentored four junior analysts', '    • Found 30+ vulnerabilities in client networks',
      'must appear in the candidate data EXACTLY as written', 'never move an achievement to a different employer', 'NOT facts about the applicant', 'Voice: first person'])
      expect(t).toContain(f);
    expect(net.errors).toEqual([]);
  });

  test('LinkedIn summary: CV facts + rules (no prompt override), first person enforced, reply shown as text (not HTML)', async ({ page }) => {
    const net = await setup(page, ['He is a security analyst with 10 years of experience.', 'I am a security analyst at Telstra <b>who</b> mentored four junior analysts.']);
    await open(page);
    await fill(page);
    await page.evaluate(() => (window as any).generateLinkedIn());
    await expect(page.locator('#linkedinText')).toHaveText('I am a security analyst at Telstra <b>who</b> mentored four junior analysts.');
    expect(await page.locator('#linkedinText b').count()).toBe(0);
    expect(net.calls.length).toBe(2);
    expect(net.calls[0].type).toBe('cv_build');
    expect(net.calls[0].prompt).toBeUndefined();
    expect(net.calls[0].text).toContain('FACT RULES');
    expect(net.calls[0].text).toContain('Voice: first person');
    expect(net.calls[0].text).toContain('    • Mentored four junior analysts');
    expect(net.errors).toEqual([]);
  });

  test('the placeholder warning sits under every AI button (summary + LinkedIn, each job, cover letter)', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    const jobs = await page.locator('.exp-entry').count();
    await page.evaluate(() => { const w = window as any; w.addExp(); w.addExp(); w.toggleSection('summary'); w.toggleSection('experience'); });
    await expect(page.locator('#section-summary .pf-ai-note')).toHaveText(NOTE);
    await expect(page.locator('#section-summary .pf-ai-note')).toBeVisible();
    await expect(page.locator('.exp-entry')).toHaveCount(jobs + 2);
    await expect(page.locator('.exp-entry .pf-ai-note')).toHaveCount(jobs + 2);
    await expect(page.locator('.exp-entry .pf-ai-note').first()).toBeVisible();
    await page.evaluate(() => (window as any).switchTab('cover'));
    await expect(page.locator('#cover-btn + .pf-ai-note')).toHaveText(NOTE);
    await expect(page.locator('#cover-btn + .pf-ai-note')).toBeVisible();
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('skills', () => {
  test('commas inside brackets stay in one skill — exactly three skills, on all 54 templates', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    expect(await page.evaluate(() => (window as any).pfSplitSkills('SIEM (Splunk, Sentinel), Python, Cloud Security (AWS, Azure)')))
      .toEqual(['SIEM (Splunk, Sentinel)', 'Python', 'Cloud Security (AWS, Azure)']);
    expect(await page.evaluate(() => (window as any).pfSplitSkills('Excel, , Git [CLI, GUI],Agile ')))
      .toEqual(['Excel', 'Git [CLI, GUI]', 'Agile']);
    await fill(page);
    const tpls = await TEMPLATES(page);
    expect(tpls.length).toBe(54);
    const bad: string[] = [];
    for (const tpl of tpls) {
      const r = await page.evaluate((t) => {
        (window as any).setTemplate(t);
        const p = document.getElementById('cv-preview')!;
        const own = [...p.querySelectorAll('*')].map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim()).filter(Boolean);
        return { fragments: own.filter((x) => /^(SIEM \(Splunk|Sentinel\)|Cloud Security \(AWS|Azure\))$/.test(x)), text: p.innerText };
      }, tpl);
      if (r.fragments.length || !/SIEM \(Splunk, Sentinel\)/i.test(r.text) || !/Cloud Security \(AWS, Azure\)/i.test(r.text)) bad.push(tpl + ': ' + r.fragments.join(' / '));
    }
    expect(bad).toEqual([]);
    // pill / tag templates (one- and two-column): one element per skill
    for (const tpl of ['classic', 'modern', 'tech', 'color-sidebar', 'skill-bubbles', 'midnight']) {
      const pills = await page.evaluate((t) => {
        (window as any).setTemplate(t);
        const want = ['SIEM (Splunk, Sentinel)', 'Python', 'Cloud Security (AWS, Azure)'];
        return want.map((w) => [...document.querySelectorAll('#cv-preview *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue!.trim() === w)).length);
      }, tpl);
      expect(pills, tpl).toEqual([1, 1, 1]);
    }
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('education details', () => {
  test('GPA, coursework and honours are optional (folded away), shown on all 54 templates only when filled', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    expect(await page.locator('.edu-entry details.edu-more').evaluate((d: HTMLDetailsElement) => d.open)).toBe(false);
    await expect(page.locator('.edu-entry .edu-more summary')).toHaveText('+ GPA, coursework & honours (optional)');
    // existing fields unchanged
    for (const c of ['.edu-degree', '.edu-school', '.edu-start', '.edu-end']) await expect(page.locator('.edu-entry ' + c)).toHaveCount(1);
    const tpls = await TEMPLATES(page);
    const has = (t: string) => /GPA \/ Grade|Relevant coursework|Honours:/i.test(t);
    for (const tpl of tpls) {
      await page.evaluate((t) => (window as any).setTemplate(t), tpl);
      expect(has(await previewText(page)), tpl + ' (empty)').toBe(false);
    }
    await fill(page, { '.edu-gpa': '3.8/4.0', '.edu-coursework': 'Network Security, Cryptography', '.edu-honours': "Dean's List" });
    const missing: string[] = [];
    for (const tpl of tpls) {
      await page.evaluate((t) => (window as any).setTemplate(t), tpl);
      const t = (await previewText(page)).replace(/\s+/g, ' ');
      for (const want of ['GPA / Grade: 3.8/4.0', 'Relevant coursework: Network Security, Cryptography', "Honours: Dean's List"])
        if (!t.toLowerCase().includes(want.toLowerCase())) missing.push(`${tpl}: ${want}`);
    }
    expect(missing).toEqual([]);
    // only the filled ones show
    await fill(page, { '.edu-coursework': '', '.edu-honours': '' });
    await page.evaluate(() => (window as any).setTemplate('classic'));
    const t = await previewText(page);
    expect(t).toContain('GPA / Grade: 3.8/4.0');
    expect(t).not.toMatch(/Relevant coursework|Honours:/i);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// position of a section in the preview (its first node), for comparisons
const secBefore = (page: Page, a: string, b: string) => page.evaluate(([a, b]) => {
  const w = window as any, p = document.getElementById('cv-preview')!;
  const first = (k: string) => { const g = w.pfSectionGroups(p).find((g: any) => g.key === k); return g ? g.nodes[0] : null; };
  const x = first(a), y = first(b);
  return !!(x && y && (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING));
}, [a, b]);

test.describe('section order', () => {
  test('Move up on every template: the section passes the one above it in its column; no text is lost or duplicated', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    const problems: string[] = [], movedPastExperience: string[] = [];
    for (const tpl of await TEMPLATES(page)) {
      await page.evaluate((t) => { const w = window as any; w.pfResetSectionOrder(); w.setTemplate(t); }, tpl);
      const r = await page.evaluate(() => {
        const w = window as any, p = document.getElementById('cv-preview')!;
        const chars = () => [...p.innerText.replace(/\s+/g, '')].sort().join('');
        const unitOf = (k: string) => { let col: any = null, u: any = null;
          w.pfSectionUnits(p).forEach((us: any[]) => us.forEach((x: any) => { if (x.keys.includes(k) && (!u || x.nodes[0].contains(u.nodes[0]))) { u = x; col = us; } }));
          return { u, col }; };
        const before = chars();
        const { u, col } = unitOf('education');
        const above = col[col.indexOf(u) - 1];
        const aboveKeys = above ? above.keys : [];
        w.pfMoveSection('education', -1);
        const after = unitOf('education');
        const now = after.col.map((x: any) => x.keys.join('+'));
        const iE = now.findIndex((k: string) => k.split('+').includes('education'));
        const iA = above ? now.indexOf(aboveKeys.join('+')) : -1;
        return { same: chars() === before, hadAbove: !!above, ok: !above || iE < iA, aboveKeys };
      });
      if (!r.same) problems.push(tpl + ': text changed');
      if (!r.ok) problems.push(tpl + ': did not move above ' + r.aboveKeys.join('+'));
      if (r.aboveKeys.includes('experience')) movedPastExperience.push(tpl);
    }
    expect(problems).toEqual([]);
    // single-column and main-column layouts: Education can be put above Experience (Classic, Modern Blue's Education|Skills row, …)
    for (const t of ['classic', 'modern', 'minimal', 'executive', 'tech', 'modern-blue', 'elegant-gold', 'timeline-cv', 'monogram', 'swiss', 'standard-plus'])
      expect(movedPastExperience, t).toContain(t);
    expect(movedPastExperience.length).toBeGreaterThanOrEqual(35);
    expect(net.errors).toEqual([]);
  });

  test('⋮ menu → Move up / Move down / Reset; the order is kept (also in the PDF text) and "Start on new page" still works', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    const menu = page.locator('#sec-education .pf-brk');
    await menu.locator('.pf-brk-btn').click();
    await expect(menu.locator('.pf-mv-reset')).toBeHidden();
    await expect(menu.locator('.pf-mv')).toHaveText(['↑ Move up', '↓ Move down', '↺ Reset section order']);
    await expect(menu.locator('label')).toHaveText('Start on new page');
    expect(await secBefore(page, 'experience', 'education')).toBe(true);
    await menu.locator('.pf-mv[data-mv="-1"]').click();
    expect(await secBefore(page, 'education', 'experience')).toBe(true);
    expect(await secBefore(page, 'summary', 'education')).toBe(true);
    await expect(menu.locator('.pf-mv-reset')).toBeVisible();
    // the order follows template switches and is saved
    await page.evaluate(() => (window as any).setTemplate('minimal'));
    expect(await secBefore(page, 'education', 'experience')).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pf_cv_order')!).slice(0, 3))).toEqual(['summary', 'education', 'experience']);
    // the PDF text layer has Education before Experience
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.evaluate(() => (window as any).downloadPDF())]);
    const items = await pdfItems(page, fs.readFileSync((await dl.path())!));
    const iEdu = items.findIndex((t) => /^education$/i.test(t.trim())), iExp = items.findIndex((t) => /^(work |professional )?experience$/i.test(t.trim()));
    expect(iEdu, items.join(' | ')).toBeGreaterThanOrEqual(0);
    expect(iExp).toBeGreaterThan(iEdu);
    expect(items.findIndex((t) => t.includes('University of Sydney'))).toBeLessThan(iExp);
    // "Start on new page" on the moved section: its heading starts page 2
    await page.evaluate(() => (window as any).pfToggleBreak('education', true));
    const top = await page.evaluate(() => {
      const w = window as any, p = document.getElementById('cv-preview')!;
      const g = w.pfSectionGroups(p).find((g: any) => g.key === 'education');
      const u = p.getBoundingClientRect().width / p.offsetWidth;
      return (g.nodes[0].getBoundingClientRect().top - p.getBoundingClientRect().top) / u;
    });
    expect(top).toBeGreaterThanOrEqual(1123);
    expect(top).toBeLessThan(1123 + 120);
    await page.evaluate(() => (window as any).pfToggleBreak('education', false));
    // Move down puts it back below Experience; Reset restores the template's order
    await menu.locator('.pf-mv[data-mv="1"]').click();
    expect(await secBefore(page, 'experience', 'education')).toBe(true);
    await menu.locator('.pf-mv[data-mv="-1"]').click();
    await menu.locator('.pf-mv-reset').click();
    expect(await secBefore(page, 'experience', 'education')).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('pf_cv_order'))).toBe('null');
    expect(net.errors).toEqual([]);
  });

  test('saved order is applied after a reload; an empty section or the top section gives a hint instead of moving', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    await page.evaluate(() => (window as any).pfMoveSection('skills', -1));
    expect(await secBefore(page, 'skills', 'education')).toBe(true);
    await page.reload();
    await page.waitForFunction(() => typeof (window as any).downloadPDF === 'function' && document.readyState === 'complete');
    await fill(page);
    expect(await secBefore(page, 'skills', 'education')).toBe(true);
    await page.evaluate(() => (window as any).pfMoveSection('projects', -1));
    await expect(page.locator('#cv-toast').filter({ hasText: 'Add content to this section first' }).first()).toBeAttached();
    await page.evaluate(() => (window as any).pfMoveSection('summary', -1));
    await expect(page.locator('#cv-toast').filter({ hasText: 'Already at the top of its column' }).first()).toBeAttached();
    expect(net.errors).toEqual([]);
  });
});

// PDF text items, read back with pdf.js in a blank tab
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
async function pdfItems(page: Page, buf: Buffer): Promise<string[]> {
  const reader = await page.context().newPage();
  await reader.goto('about:blank');
  await reader.addScriptTag({ url: PDFJS + 'pdf.min.js' });
  const out = await reader.evaluate(async ([b64, base]) => {
    const lib = (window as any).pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
    const doc = await lib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const items: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) items.push(...(await (await doc.getPage(i)).getTextContent()).items.map((t: any) => t.str).filter((x: string) => x.trim()));
    return items;
  }, [buf.toString('base64'), PDFJS] as [string, string]);
  await reader.close();
  return out;
}

// ─────────────────────────────────────────────────────────────
test.describe('references', () => {
  test('not shown by default; shown when "Available upon request" is chosen or a reference is added', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    const refs = () => page.evaluate(() => /References/.test(document.getElementById('cv-preview')!.innerText) || /upon request/i.test(document.getElementById('cv-preview')!.innerText));
    for (const tpl of ['classic', 'modern', 'minimal', 'academic', 'gradient']) {
      await page.evaluate((t) => (window as any).setTemplate(t), tpl);
      expect(await refs(), tpl).toBe(false);
    }
    expect(await page.locator('input[name="references"]:checked').getAttribute('value')).toBe('none');
    await page.evaluate(() => (window as any).toggleSection('references'));
    await page.locator('input[name="references"][value="Available upon request"]').check();
    expect(await previewText(page)).toContain('Available upon request');
    await page.locator('input[name="references"][value="custom"]').check();
    expect(await refs()).toBe(false);                                            // "Add references" but none added yet
    await page.locator('#refSection button', { hasText: '+ Add Reference' }).click();
    await page.locator('#referencesList input').first().fill('Dr Jane Smith');
    expect(await previewText(page)).toContain('Dr Jane Smith');
    expect((await previewText(page)).toLowerCase()).toContain('references');
    await page.locator('input[name="references"][value="none"]').check();
    expect(await refs()).toBe(false);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('dates', () => {
  test('format hints under work and education dates; free-text values still render as typed', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    await expect(page.locator('.exp-entry .pf-date-hint')).toHaveText('Dates: month and year, e.g. Jan 2022 – or "Present" if you still work here.');
    await expect(page.locator('.edu-entry .pf-date-hint')).toContainText('Years: four digits');
    const t = await previewText(page);
    expect(t).toMatch(/Jan 2021/i);
    expect(t).toMatch(/Present/i);
    expect(net.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
test.describe('still working', () => {
  test('all 54 templates render the full CV (with languages + levels) without errors; PDF downloads on one- and two-column templates', async ({ page }) => {
    const net = await setup(page);
    await open(page);
    await fill(page);
    await page.evaluate(() => {
      const w = window as any;
      w.addLanguage();
      const e = document.querySelector('#languagesList .language-entry')!;
      (e.querySelector('input') as HTMLInputElement).value = 'Spanish';
      const s = e.querySelector('select') as HTMLSelectElement;
      s.value = s.options[s.options.length - 1].value;
      w.updatePreview();
    });
    const level = await page.evaluate(() => (document.querySelector('#languagesList select') as HTMLSelectElement).value);
    const missing: string[] = [];
    for (const tpl of await TEMPLATES(page)) {
      await page.evaluate((t) => (window as any).setTemplate(t), tpl);
      const t = (await previewText(page)).replace(/\s+/g, ' ').toLowerCase();
      for (const want of ['jordan rivers', 'telstra', 'university of sydney', 'python']) if (!t.includes(want)) missing.push(`${tpl}: ${want}`);
    }
    expect(missing).toEqual([]);
    await page.evaluate(() => (window as any).setTemplate('classic'));
    const t = await previewText(page);
    expect(t).toContain('Spanish');
    if (level) expect(t).toContain(level);
    for (const tpl of ['classic', 'color-sidebar']) {
      await page.evaluate((t) => (window as any).setTemplate(t), tpl);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.evaluate(() => (window as any).downloadPDF())]);
      expect(fs.readFileSync((await dl.path())!).subarray(0, 5).toString(), tpl).toBe('%PDF-');
    }
    expect(net.errors).toEqual([]);
  });
});
