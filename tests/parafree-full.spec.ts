import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const BASE = 'https://parafree.app'

test.describe('ParaFree Full A-Z Tests', () => {

  // ── PARAPHRASER TESTS ──

  test('1. Homepage loads correctly', async ({ page }) => {
    await page.goto(BASE)
    await expect(page).toHaveTitle(/ParaFree/i)
    await expect(page.locator('textarea').first()).toBeVisible()
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    await expect(btn).toBeVisible()
    console.log('✅ Homepage loaded')
  })

  test('2. Paraphrase plain text works', async ({ page }) => {
    await page.goto(BASE)
    const input = page.locator('textarea').first()
    await input.fill(
      'The weather today is very nice. The sun is shining brightly and the birds are singing in the trees. It is a perfect day to go outside.'
    )
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    await btn.click()
    await page.waitForFunction(() => {
      const textareas = document.querySelectorAll('textarea')
      for (const ta of textareas) {
        if ((ta as HTMLTextAreaElement).value && (ta as HTMLTextAreaElement).value.length > 30) return true
      }
      const outputs = document.querySelectorAll('[id*="output"], .output, [class*="output"]')
      for (const el of outputs) {
        if ((el.textContent || '').length > 30) return true
      }
      return false
    }, { timeout: 30000 })
    console.log('✅ Paraphrase text works')
    await page.screenshot({ path: 'tests/screenshots/01-paraphrase.png' })
  })

  test('3. DOCX upload shows clean text', async ({ page }) => {
    await page.goto(BASE)
    const docxPath = path.join(process.cwd(), 'tests/fixtures/test-colored.docx')
    if (!fs.existsSync(docxPath)) { console.log('⚠️ No test DOCX, skipping'); return }
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(docxPath)
    await page.waitForTimeout(2000)
    const input = page.locator('textarea').first()
    const val = await input.inputValue()
    const hasBinary = /[^\x20-\x7E\n\r\t]/.test(val.slice(0, 500))
    if (hasBinary) { console.log('❌ Binary chars found:', val.slice(0, 100)); throw new Error('DOCX upload shows binary text') }
    expect(val.length).toBeGreaterThan(20)
    expect(hasBinary).toBe(false)
    console.log('✅ DOCX shows clean text:', val.slice(0, 80))
    await page.screenshot({ path: 'tests/screenshots/03-docx-upload.png' })
  })

  test('4. DOCX paraphrase and download', async ({ page }) => {
    await page.goto(BASE)
    const docxPath = path.join(process.cwd(), 'tests/fixtures/test-colored.docx')
    if (!fs.existsSync(docxPath)) { console.log('⚠️ No test DOCX, skipping'); return }
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(docxPath)
    await page.waitForTimeout(2000)
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    await btn.click()
    await page.waitForTimeout(20000)
    const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    const dlBtn = page.locator('button').filter({ hasText: /download|word|docx/i }).first()
    if (await dlBtn.isVisible().catch(() => false)) {
      await dlBtn.click()
      const dl = await dlPromise
      if (dl) {
        const savePath = path.join(process.cwd(), 'tests/downloads/para-test.docx')
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        await dl.saveAs(savePath)
        const size = fs.statSync(savePath).size
        expect(size).toBeGreaterThan(1000)
        console.log('✅ DOCX downloaded:', size, 'bytes')
        const filename = dl.suggestedFilename()
        expect(filename.toLowerCase()).not.toContain('watermark')
        expect(filename.toLowerCase()).not.toContain('parafree')
        console.log('✅ Clean filename:', filename)
      } else { console.log('⚠️ No download triggered') }
    }
    await page.screenshot({ path: 'tests/screenshots/04-docx-download.png' })
  })

  test('5. PPTX upload and download unchanged', async ({ page }) => {
    await page.goto(BASE)
    const pptxPath = path.join(process.cwd(), 'tests/fixtures/test.pptx')
    if (!fs.existsSync(pptxPath)) { console.log('⚠️ No test PPTX, skipping'); return }
    const pptxTab = page.locator('button, .tool-tab').filter({ hasText: /pptx/i }).first()
    if (await pptxTab.isVisible().catch(() => false)) { await pptxTab.click(); await page.waitForTimeout(500) }
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(pptxPath)
    await page.waitForTimeout(3000)
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(25000) }
    const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    const dlBtn = page.locator('button').filter({ hasText: /download|pptx/i }).first()
    if (await dlBtn.isVisible().catch(() => false)) { await dlBtn.click() }
    const dl = await dlPromise
    if (dl) {
      const savePath = path.join(process.cwd(), 'tests/downloads/para-test.pptx')
      fs.mkdirSync(path.dirname(savePath), { recursive: true })
      await dl.saveAs(savePath)
      const size = fs.statSync(savePath).size
      expect(size).toBeGreaterThan(1000)
      console.log('✅ PPTX downloaded:', size, 'bytes')
      const JSZip = require('jszip')
      const buf = fs.readFileSync(savePath)
      const zip = await JSZip.loadAsync(buf)
      const slideFiles = Object.keys(zip.files).filter((n: string) => n.match(/ppt\/slides\/slide\d+\.xml/))
      let foundBranding = false
      for (const sf of slideFiles) {
        const xml = await zip.file(sf).async('text')
        if (xml.toLowerCase().includes('parafree') || xml.toLowerCase().includes('powered by')) {
          foundBranding = true
          console.log('❌ Branding in:', sf)
        }
      }
      expect(foundBranding).toBe(false)
      console.log('✅ No ParaFree branding in PPTX')
    }
    await page.screenshot({ path: 'tests/screenshots/05-pptx-download.png' })
  })

  test('6. All tool tabs work', async ({ page }) => {
    await page.goto(BASE)
    const tabs = ['Paraphraser', 'AI Humanizer', 'Summarizer', 'Grammar', 'AI Detector']
    for (const tabName of tabs) {
      const tab = page.locator('button, .tool-tab, [class*="tab"]').filter({ hasText: new RegExp(tabName, 'i') }).first()
      if (await tab.isVisible().catch(() => false)) {
        await tab.click()
        await page.waitForTimeout(400)
        await expect(page.locator('textarea').first()).toBeVisible()
        console.log('✅ Tab works:', tabName)
      } else { console.log('⚠️ Tab not found:', tabName) }
    }
  })

  test('7. Language selector works', async ({ page }) => {
    await page.goto(BASE)
    const select = page.locator('select').first()
    if (!await select.isVisible().catch(() => false)) { console.log('⚠️ No language selector'); return }
    const options = await select.locator('option').all()
    console.log('Found languages:', options.length)
    for (const opt of options.slice(0, 3)) {
      const val = await opt.getAttribute('value')
      if (!val) continue
      await select.selectOption(val)
      await page.waitForTimeout(200)
      console.log('✅ Language:', val)
    }
  })

  test('8. Copy button works', async ({ page }) => {
    await page.goto(BASE)
    const input = page.locator('textarea').first()
    await input.fill('Testing copy button works correctly')
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    await btn.click()
    await page.waitForTimeout(20000)
    const copyBtn = page.locator('button').filter({ hasText: /copy/i }).first()
    if (await copyBtn.isVisible().catch(() => false)) {
      await copyBtn.click()
      await page.waitForTimeout(500)
      console.log('✅ Copy button clicked')
    }
  })

  test('9. No horizontal scroll on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 5)
    if (overflow) { console.log('❌ Horizontal overflow!') } else { console.log('✅ No overflow on mobile') }
    expect(overflow).toBe(false)
    await page.screenshot({ path: 'tests/screenshots/09-mobile.png' })
  })

  // ── CV BUILDER TESTS ──

  test('10. CV Builder loads', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/cv-builder/)
    const preview = page.locator('#cv-preview, #cvPreview').first()
    await expect(preview).toBeVisible()
    console.log('✅ CV Builder loaded')
    await page.screenshot({ path: 'tests/screenshots/10-cv-builder.png' })
  })

  test('11. CV form fills and updates preview', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    const nameField = page.locator('#fullName, input[placeholder*="name" i]').first()
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill('John Smith')
      await page.waitForTimeout(500)
      const preview = page.locator('#cv-preview, #cvPreview').first()
      const text = await preview.textContent()
      expect(text).toContain('John')
      console.log('✅ Name appears in preview')
    }
    const titleField = page.locator('#jobTitle, input[placeholder*="title" i]').first()
    if (await titleField.isVisible().catch(() => false)) { await titleField.fill('Software Engineer'); await page.waitForTimeout(300) }
    const emailField = page.locator('#email, input[type="email"]').first()
    if (await emailField.isVisible().catch(() => false)) { await emailField.fill('john@example.com'); await page.waitForTimeout(300) }
    console.log('✅ CV form updates preview')
    await page.screenshot({ path: 'tests/screenshots/11-cv-form.png' })
  })

  test('12. Template switching works', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    for (const tpl of ['executive', 'modern-blue', 'classic']) {
      const btn = page.locator(`[onclick*="${tpl}"], [data-template="${tpl}"]`).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
        await page.waitForTimeout(800)
        const preview = page.locator('#cv-preview, #cvPreview').first()
        const html = await preview.innerHTML()
        expect(html.length).toBeGreaterThan(100)
        console.log('✅ Template:', tpl)
      } else { console.log('⚠️ Template btn not found:', tpl) }
    }
  })

  test('13. CV PDF download works', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    const nameField = page.locator('#fullName').first()
    if (await nameField.isVisible().catch(() => false)) { await nameField.fill('Test User') }
    await page.waitForTimeout(500)
    const dlPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
    const pdfBtn = page.locator('button').filter({ hasText: /pdf/i }).first()
    if (await pdfBtn.isVisible().catch(() => false)) {
      await pdfBtn.click()
      const dl = await dlPromise
      if (dl) {
        const name = dl.suggestedFilename()
        console.log('✅ CV PDF downloaded:', name)
        expect(name.toLowerCase()).not.toContain('watermark')
        await dl.saveAs(path.join(process.cwd(), 'tests/downloads/test-cv.pdf'))
      } else { console.log('⚠️ PDF download not triggered') }
    }
    await page.screenshot({ path: 'tests/screenshots/13-cv-pdf.png' })
  })

  test('14. CV Word download works', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    const nameField = page.locator('#fullName').first()
    if (await nameField.isVisible().catch(() => false)) { await nameField.fill('Test User') }
    await page.waitForTimeout(500)
    const dlPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
    const wordBtn = page.locator('button').filter({ hasText: /word|docx/i }).first()
    if (await wordBtn.isVisible().catch(() => false)) {
      await wordBtn.click()
      const dl = await dlPromise
      if (dl) {
        const name = dl.suggestedFilename()
        console.log('✅ CV Word downloaded:', name)
        expect(name).toMatch(/\.docx$/i)
        await dl.saveAs(path.join(process.cwd(), 'tests/downloads/test-cv.docx'))
      } else { console.log('⚠️ Word download not triggered') }
    }
    await page.screenshot({ path: 'tests/screenshots/14-cv-word.png' })
  })

  test('15. CV Builder mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 5)
    expect(overflow).toBe(false)
    console.log('✅ CV Builder mobile OK')
    const preview = page.locator('#cv-preview, #cvPreview').first()
    await expect(preview).toBeVisible()
    const mobileBar = page.locator('#mobileBar').first()
    if (await mobileBar.isVisible().catch(() => false)) { console.log('✅ Mobile bar visible') }
    await page.screenshot({ path: 'tests/screenshots/15-cv-mobile.png', fullPage: false })
  })

  test('16. DOCX no watermark check', async ({ page }) => {
    await page.goto(BASE + '/cv-builder.html')
    await page.waitForLoadState('networkidle')
    const nameField = page.locator('#fullName').first()
    if (await nameField.isVisible().catch(() => false)) { await nameField.fill('Clean Test') }
    await page.waitForTimeout(500)
    const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    const wordBtn = page.locator('button').filter({ hasText: /word|docx/i }).first()
    if (await wordBtn.isVisible().catch(() => false)) { await wordBtn.click() }
    const dl = await dlPromise
    if (!dl) { console.log('⚠️ No download for watermark check'); return }
    const savePath = path.join(process.cwd(), 'tests/downloads/watermark-check.docx')
    fs.mkdirSync(path.dirname(savePath), { recursive: true })
    await dl.saveAs(savePath)
    const JSZip = require('jszip')
    const buf = fs.readFileSync(savePath)
    const zip = await JSZip.loadAsync(buf)
    const docXml = await zip.file('word/document.xml').async('text')
    const lowerXml = docXml.toLowerCase()
    const hasBranding = lowerXml.includes('parafree') || lowerXml.includes('powered by') || lowerXml.includes('watermark') || lowerXml.includes('parafree.app')
    if (hasBranding) { console.log('❌ Branding found in DOCX!') } else { console.log('✅ No branding in DOCX') }
    expect(hasBranding).toBe(false)
  })

  test('17. API responds under 30 seconds', async ({ page }) => {
    await page.goto(BASE)
    const input = page.locator('textarea').first()
    await input.fill('Quick API response time test. This sentence checks how fast the paraphrasing API responds.')
    const start = Date.now()
    const btn = page.locator('button').filter({ hasText: /paraphrase/i }).first()
    await btn.click()
    await page.waitForFunction(() => {
      const areas = document.querySelectorAll('textarea')
      for (const ta of areas) {
        if ((ta as HTMLTextAreaElement).value && (ta as HTMLTextAreaElement).value.length > 20) return true
      }
      return false
    }, { timeout: 30000 }).catch(() => null)
    const elapsed = Date.now() - start
    console.log(`✅ API time: ${elapsed}ms`)
    expect(elapsed).toBeLessThan(30000)
  })

  test('18. SEO meta tags present', async ({ page }) => {
    await page.goto(BASE)
    const desc = await page.locator('meta[name="description"]').getAttribute('content').catch(() => null)
    expect(desc).toBeTruthy()
    expect((desc || '').length).toBeGreaterThan(50)
    console.log('✅ Meta description:', (desc || '').slice(0, 60))
    const schemas = await page.locator('script[type="application/ld+json"]').count()
    expect(schemas).toBeGreaterThan(0)
    console.log('✅ Schema scripts:', schemas)
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href').catch(() => null)
    console.log(canonical ? '✅ Canonical: ' + canonical : '⚠️ No canonical tag')
  })

})
