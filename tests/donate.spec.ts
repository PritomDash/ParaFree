import { test, expect } from '@playwright/test';
import fs from 'fs';
const KOFI = 'https://ko-fi.com/parafree';
const pages = fs.readdirSync(process.cwd()).filter(f => f.endsWith('.html') && f !== 'google36f9508fd6ca7a9c.html');

test('every page: donate links open in new tab, tracked, not in schema/meta', async ({ page }) => {
  const problems: string[] = [];
  for (const f of pages) {
    await page.goto('/' + f, { waitUntil: 'domcontentloaded' });
    const info = await page.evaluate((K) => {
      const links = [...document.querySelectorAll(`a[href="${K}"]`)] as HTMLAnchorElement[];
      return {
        n: links.length,
        bad: links.filter(a => a.target !== '_blank' || !a.rel.includes('noopener') || !/donate_click/.test(a.getAttribute('onclick') || '')).length,
        header: links.filter(a => a.closest('nav')).length,
        footer: links.filter(a => a.closest('footer')).length,
        ld: [...document.querySelectorAll('script[type="application/ld+json"]')].some(s => /ko-fi|donat/i.test(s.textContent || '')),
        meta: [...document.querySelectorAll('meta')].some(m => /ko-fi|donat|coffee/i.test(m.getAttribute('content') || '')),
      };
    }, KOFI);
    const needHeader = f !== '404.html';
    if (info.bad || info.ld || info.meta || !info.footer || (needHeader && !info.header)) problems.push(`${f}: ${JSON.stringify(info)}`);
  }
  for (const t of ['llms.txt', 'llms-full.txt']) if (/ko-fi|donat/i.test(fs.readFileSync(t, 'utf8'))) problems.push(t);
  expect(problems).toEqual([]);
});

test('gtag donate_click fires with placement (and no error without gtag)', async ({ page }) => {
  await page.goto('/about.html');
  await page.evaluate(() => { (window as any).__ev = []; (window as any).gtag = (...a: any[]) => (window as any).__ev.push(a); });
  const placements = ['header', 'about', 'footer'];
  for (const p of placements) {
    const a = page.locator(`a[href="${KOFI}"][onclick*="'${p}'"]`).first();
    await a.evaluate((el: HTMLAnchorElement) => { el.addEventListener('click', e => e.preventDefault(), { once: true }); el.click(); });
  }
  const ev = await page.evaluate(() => (window as any).__ev);
  expect(ev.map((e: any) => [e[0], e[1], e[2].placement])).toEqual(placements.map(p => ['event', 'donate_click', p]));
  const errs: string[] = []; page.on('pageerror', e => errs.push(String(e)));
  await page.evaluate(() => { delete (window as any).gtag; });
  await page.locator(`footer a[href="${KOFI}"]`).evaluate((el: HTMLAnchorElement) => { el.addEventListener('click', e => e.preventDefault(), { once: true }); el.click(); });
  expect(errs).toEqual([]);
});

test('about page has support section', async ({ page }) => {
  await page.goto('/about.html');
  await expect(page.getByText('ParaFree runs on free AI capacity, which is limited. Small donations go directly toward a dedicated AI provider so ParaFree can stay free for everyone.')).toBeVisible();
  await expect(page.locator(`.container a[href="${KOFI}"]`)).toHaveText('☕ Support ParaFree');
  await expect(page.getByText('ParaFree is and always will be 100% free')).toBeVisible();
});

// Header check only covers the Support link itself: when it is visible, every nav link
// must stay inside the nav bar and the viewport. General page overflow is covered elsewhere.
for (const w of [1440, 1280, 1024, 900, 820, 768, 414, 375, 320]) {
  test(`header @${w}px: Support link does not break the nav`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    const problems: string[] = [];
    for (const f of pages) {
      await page.goto('/' + f, { waitUntil: 'load' });
      const r = await page.evaluate((K) => {
        const nav = document.querySelector('nav');
        if (!nav) return null;
        const sup = nav.querySelector(`a[href="${K}"]`) as HTMLElement | null;
        if (!sup || sup.offsetParent === null || sup.getBoundingClientRect().width === 0) return null;
        const nb = nav.getBoundingClientRect();
        const out = [...nav.querySelectorAll('a')].filter(a => {
          const b = a.getBoundingClientRect();
          return b.width > 0 && (b.right > window.innerWidth + 1 || b.bottom > nb.bottom + 1 || b.top < nb.top - 1);
        }).map(a => (a.textContent || '').trim());
        const wrapped = sup.getBoundingClientRect().height > 44;
        return out.length || wrapped || nb.height > 90 ? { out, wrapped, navH: nb.height } : null;
      }, KOFI);
      if (r) problems.push(`${f}: ${JSON.stringify(r)}`);
    }
    expect(problems).toEqual([]);
  });
}

test('mobile menu contains support link', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const f of ['index.html', 'about.html', 'ai-rephraser.html', 'free-arabic-paraphrasing-tool.html', 'cv-builder.html']) {
    await page.goto('/' + f);
    await page.locator('nav button').first().click();
    await expect(page.locator(`#mobileMenu a[href="${KOFI}"], #mobDrawer a[href="${KOFI}"]`)).toBeInViewport();
  }
});

const TEXT1 = 'Climate change is one of the most pressing issues facing the world today. Rising temperatures are causing glaciers to melt and sea levels to rise, which threatens coastal communities around the globe.';
const TEXT2 = 'The quick brown fox jumps over the lazy dog. This sentence is often used to test fonts because it contains every letter of the alphabet at least once.';

async function paraphraseAndCheckNote(page: any, text: string) {
  await page.locator('#inputText').fill(text);
  await page.locator('#statusMsg').evaluate((el: HTMLElement) => { el.textContent = ''; });
  await page.locator('#paraphraseBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/Paraphrased successfully|busy|error|failed/i, { timeout: 30000 });
  await expect(page.locator('#statusMsg'), 'paraphrase API must succeed for this test').toContainText('Paraphrased successfully');
  await expect(page.locator('#donateNote')).toBeVisible();
  await expect(page.locator('#donateNote')).toContainText('ParaFree is free forever, with no signup and no limits. If it helped you, you can support it with a small coffee ☕');
  // Measure note and buttons in the same frame (the output typing animation moves the buttons),
  // and check each button is the topmost element at its centre, i.e. nothing covers it.
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const note = document.getElementById('donateNote')!.getBoundingClientRect();
    for (const id of ['copyBtn', 'downloadBtn', 'downloadDOCXBtn']) {
      const btn = document.getElementById(id)!;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      const b = btn.getBoundingClientRect();
      const n = document.getElementById('donateNote')!.getBoundingClientRect();
      if (n.top < b.bottom) out.push(`${id} bottom=${b.bottom} note top=${n.top}`);
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit || !btn.contains(hit)) out.push(`${id} covered by ${hit && hit.outerHTML.slice(0, 80)}`);
    }
    return note ? out : ['no note'];
  });
  expect(problems).toEqual([]);
}

for (const w of [1280, 375]) {
  test(`after-paraphrase note @${w}px: below buttons, shown on every result`, async ({ page }) => {
    // Mock the AI backend: this test checks the note UI, not the providers,
    // and must not spend the free provider quota.
    await page.route('**/api/process', async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      const words = String(body.text || '').split(/\s+/).filter(Boolean);
      const result = words.length ? 'In other words, ' + words.join(' ') : 'Rewritten text.';
      await route.fulfill({ json: { success: true, result, usedApi: 'test' } });
    });
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/');
    await expect(page.locator('#donateNote')).toBeHidden();
    await paraphraseAndCheckNote(page, TEXT1);
    await paraphraseAndCheckNote(page, TEXT2);   // second result, same page
    await page.reload();                          // new page load, same session
    await expect(page.locator('#donateNote')).toBeHidden();
    await paraphraseAndCheckNote(page, TEXT1);
  });
}
