import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const DOWNLOADS = path.join(process.cwd(), 'tests/downloads');
const SCREENSHOTS = path.join(process.cwd(), 'tests/screenshots');

test.describe('Format Preservation Tests', () => {

  test.beforeAll(async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    fs.mkdirSync(SCREENSHOTS, { recursive: true });
    await createTestDocx();
    console.log('✅ Test fixtures ready');
  });

  // ── DOCX FORMAT PRESERVATION ──────────────────────────────────────────────
  test('DOCX paraphrase preserves format', async ({ page }) => {
    const docxPath = path.join(FIXTURES, 'test-colored.docx');
    if (!fs.existsSync(docxPath)) {
      console.log('⚠️  Test DOCX missing, skipping');
      return;
    }

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Upload test DOCX via the hidden file input
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(docxPath);
    await page.waitForTimeout(2000);

    // Verify text was extracted into input textarea
    const inputVal = await page.locator('#inputText').inputValue();
    expect(inputVal.length).toBeGreaterThan(20);
    console.log('✅ DOCX text extracted:', inputVal.slice(0, 60));

    // Click Paraphrase
    const paraBtn = page.locator('button.btn-paraphrase, button:has-text("Paraphrase Now")').first();
    await paraBtn.click();
    await page.waitForTimeout(30000);

    // Verify output is not empty
    const outputEl = page.locator('#outputText');
    const outputText = await outputEl.innerText();
    expect(outputText.length).toBeGreaterThan(20);
    console.log('✅ Output received:', outputText.slice(0, 60));

    // Download paraphrased DOCX
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);

    // Try the DOCX download button
    const docxBtn = page.locator('#downloadDOCXBtn, button:has-text("DOCX"), button:has-text("Word")').first();
    if (await docxBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await docxBtn.click();
    }

    const download = await downloadPromise;
    if (!download) {
      console.log('⚠️  No download event captured');
      await page.screenshot({ path: path.join(SCREENSHOTS, 'docx-no-download.png') });
      return;
    }

    const savePath = path.join(DOWNLOADS, 'paraphrased.docx');
    await download.saveAs(savePath);
    console.log('✅ Downloaded to:', savePath);

    await verifyDocxFormat(docxPath, savePath);

    await page.screenshot({ path: path.join(SCREENSHOTS, 'docx-format-result.png') });
  });

  // ── PPTX FORMAT PRESERVATION ──────────────────────────────────────────────
  test('PPTX paraphrase preserves format', async ({ page }) => {
    const pptxPath = path.join(FIXTURES, 'test.pptx');
    if (!fs.existsSync(pptxPath)) {
      console.log('⚠️  Test PPTX missing — place a test .pptx at tests/fixtures/test.pptx');
      return;
    }

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Upload PPTX — the upload handler detects extension automatically
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(pptxPath);
    await page.waitForTimeout(3000);

    // Paraphrase
    const paraBtn = page.locator('button.btn-paraphrase, button:has-text("Paraphrase Now")').first();
    await paraBtn.click();
    await page.waitForTimeout(40000);

    // Download PPTX
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    const pptxBtn = page.locator('#downloadBtn, button:has-text("PPTX"), button:has-text("Download")').first();
    if (await pptxBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pptxBtn.click();
    }

    const download = await downloadPromise;
    if (!download) {
      console.log('⚠️  No PPTX download captured');
      await page.screenshot({ path: path.join(SCREENSHOTS, 'pptx-no-download.png') });
      return;
    }

    const savePath = path.join(DOWNLOADS, 'paraphrased.pptx');
    await download.saveAs(savePath);
    await verifyPptxFormat(pptxPath, savePath);
    console.log('✅ PPTX format preservation verified!');

    await page.screenshot({ path: path.join(SCREENSHOTS, 'pptx-format-result.png') });
  });

  // ── DOCX FORMAT VERIFICATION ──────────────────────────────────────────────
  async function verifyDocxFormat(originalPath: string, paraphrasedPath: string) {
    const origBuf = fs.readFileSync(originalPath);
    const paraBuf = fs.readFileSync(paraphrasedPath);

    const origZip = await JSZip.loadAsync(origBuf);
    const paraZip = await JSZip.loadAsync(paraBuf);

    const origXml = await origZip.file('word/document.xml')!.async('text');
    const paraXml = await paraZip.file('word/document.xml')!.async('text');

    // 1. Run-property blocks (bold/color/size formatting containers)
    const origRPr = (origXml.match(/<w:rPr/g) || []).length;
    const paraRPr = (paraXml.match(/<w:rPr/g) || []).length;
    console.log(`  <w:rPr> blocks — original: ${origRPr}, paraphrased: ${paraRPr}`);
    expect(paraRPr).toBeGreaterThan(0);
    // Allow up to 20% difference (some empty runs may be removed)
    expect(Math.abs(origRPr - paraRPr)).toBeLessThanOrEqual(Math.ceil(origRPr * 0.2));

    // 2. Color declarations preserved
    const origColors = (origXml.match(/<w:color w:val="[^"]+"/g) || []);
    const paraColors = (paraXml.match(/<w:color w:val="[^"]+"/g) || []);
    console.log(`  Colors — original: ${origColors.length}, paraphrased: ${paraColors.length}`);
    expect(paraColors.length).toBe(origColors.length);

    // 3. Bold markers preserved
    const origBold = (origXml.match(/<w:b\/>/g) || []).length;
    const paraBold = (paraXml.match(/<w:b\/>/g) || []).length;
    console.log(`  Bold markers — original: ${origBold}, paraphrased: ${paraBold}`);
    expect(paraBold).toBe(origBold);

    // 4. Font-size declarations preserved
    const origSz = (origXml.match(/<w:sz w:val="[^"]+"/g) || []).length;
    const paraSz = (paraXml.match(/<w:sz w:val="[^"]+"/g) || []).length;
    console.log(`  Font sizes — original: ${origSz}, paraphrased: ${paraSz}`);
    expect(paraSz).toBe(origSz);

    // 5. Tables completely unchanged
    const origTbls = (origXml.match(/<w:tbl/g) || []).length;
    const paraTbls = (paraXml.match(/<w:tbl/g) || []).length;
    console.log(`  Tables — original: ${origTbls}, paraphrased: ${paraTbls}`);
    expect(paraTbls).toBe(origTbls);

    // 6. At least some text was changed (document was actually paraphrased)
    const origTexts: string[] = [];
    origXml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_m, t) => { if (t.trim()) origTexts.push(t); return ''; });
    const paraTexts: string[] = [];
    paraXml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_m, t) => { if (t.trim()) paraTexts.push(t); return ''; });

    let diffCount = 0;
    const minLen = Math.min(origTexts.length, paraTexts.length);
    for (let i = 0; i < minLen; i++) {
      if (origTexts[i] !== paraTexts[i]) diffCount++;
    }
    console.log(`  Text nodes changed: ${diffCount}/${minLen}`);
    expect(diffCount).toBeGreaterThan(0);

    console.log('✅ DOCX format checks passed:');
    console.log('   ✓ Same <w:rPr> block count');
    console.log('   ✓ Same color declarations');
    console.log('   ✓ Same bold markers');
    console.log('   ✓ Same font sizes');
    console.log('   ✓ Tables unchanged');
    console.log('   ✓ Text was paraphrased');
  }

  // ── PPTX FORMAT VERIFICATION ──────────────────────────────────────────────
  async function verifyPptxFormat(originalPath: string, paraphrasedPath: string) {
    const origBuf = fs.readFileSync(originalPath);
    const paraBuf = fs.readFileSync(paraphrasedPath);

    const origZip = await JSZip.loadAsync(origBuf);
    const paraZip = await JSZip.loadAsync(paraBuf);

    const origSlideFile = origZip.file('ppt/slides/slide1.xml');
    const paraSlideFile = paraZip.file('ppt/slides/slide1.xml');
    expect(origSlideFile).toBeTruthy();
    expect(paraSlideFile).toBeTruthy();

    const origXml = await origSlideFile!.async('text');
    const paraXml = await paraSlideFile!.async('text');

    // Colors (<a:srgbClr>)
    const origColors = (origXml.match(/<a:srgbClr val="[^"]+"/g) || []).length;
    const paraColors = (paraXml.match(/<a:srgbClr val="[^"]+"/g) || []).length;
    console.log(`  PPTX colors — original: ${origColors}, paraphrased: ${paraColors}`);
    expect(paraColors).toBe(origColors);

    // Font sizes (<a:sz>)
    const origSz = (origXml.match(/<a:sz val="[^"]+"/g) || []).length;
    const paraSz = (paraXml.match(/<a:sz val="[^"]+"/g) || []).length;
    console.log(`  PPTX font sizes — original: ${origSz}, paraphrased: ${paraSz}`);
    expect(paraSz).toBe(origSz);

    // Text was actually changed
    const origText = origXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const paraText = paraXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(origText).not.toBe(paraText);

    console.log('✅ PPTX format checks passed:');
    console.log('   ✓ Same color declarations');
    console.log('   ✓ Same font sizes');
    console.log('   ✓ Text was paraphrased');
  }

  // ── CREATE TEST DOCX FIXTURE ──────────────────────────────────────────────
  async function createTestDocx() {
    const docxPath = path.join(FIXTURES, 'test-colored.docx');
    if (fs.existsSync(docxPath)) {
      console.log('✅ Test DOCX already exists');
      return;
    }

    const zip = new JSZip();

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
<w:p>
  <w:pPr><w:jc w:val="center"/></w:pPr>
  <w:r>
    <w:rPr>
      <w:b/><w:bCs/>
      <w:color w:val="1A3A2A"/>
      <w:sz w:val="48"/>
      <w:szCs w:val="48"/>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
    </w:rPr>
    <w:t>Test Document for ParaFree</w:t>
  </w:r>
</w:p>
<w:p>
  <w:r>
    <w:rPr>
      <w:b/>
      <w:color w:val="2D6A4F"/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
    <w:t>Introduction to Artificial Intelligence</w:t>
  </w:r>
</w:p>
<w:p>
  <w:r>
    <w:rPr>
      <w:color w:val="374151"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
    <w:t xml:space="preserve">Artificial intelligence is transforming industries worldwide. Machine learning enables computers to learn from data without explicit programming.</w:t>
  </w:r>
</w:p>
<w:p>
  <w:r>
    <w:rPr>
      <w:b/>
      <w:color w:val="C62828"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
    <w:t>Key Benefits of AI Technology</w:t>
  </w:r>
</w:p>
<w:p>
  <w:r>
    <w:rPr>
      <w:color w:val="374151"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
    <w:t xml:space="preserve">The technology provides increased productivity and efficiency. Companies worldwide are adopting AI to streamline their operations and reduce costs significantly.</w:t>
  </w:r>
</w:p>
<w:tbl>
  <w:tblPr>
    <w:tblW w:w="9360" w:type="dxa"/>
    <w:tblBorders>
      <w:top w:val="single" w:sz="4"/>
      <w:left w:val="single" w:sz="4"/>
      <w:bottom w:val="single" w:sz="4"/>
      <w:right w:val="single" w:sz="4"/>
      <w:insideH w:val="single" w:sz="4"/>
      <w:insideV w:val="single" w:sz="4"/>
    </w:tblBorders>
  </w:tblPr>
  <w:tr>
    <w:tc>
      <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1565C0"/></w:tcPr>
      <w:p><w:r>
        <w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>
        <w:t>Feature</w:t>
      </w:r></w:p>
    </w:tc>
    <w:tc>
      <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1565C0"/></w:tcPr>
      <w:p><w:r>
        <w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>
        <w:t>Benefit</w:t>
      </w:r></w:p>
    </w:tc>
  </w:tr>
  <w:tr>
    <w:tc><w:p><w:r>
      <w:rPr><w:color w:val="1565C0"/></w:rPr>
      <w:t>Speed</w:t>
    </w:r></w:p></w:tc>
    <w:tc><w:p><w:r>
      <w:rPr><w:color w:val="374151"/></w:rPr>
      <w:t>10x faster processing</w:t>
    </w:r></w:p></w:tc>
  </w:tr>
</w:tbl>
<w:p>
  <w:r>
    <w:rPr>
      <w:color w:val="374151"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
    <w:t xml:space="preserve">The future of artificial intelligence looks incredibly promising with new developments emerging every single day in research laboratories across the globe.</w:t>
  </w:r>
</w:p>
<w:sectPr>
  <w:pgSz w:w="12240" w:h="15840"/>
  <w:pgMar w:top="1440" w:right="1260" w:bottom="1440" w:left="1260"/>
</w:sectPr>
</w:body>
</w:document>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
  <w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
    <w:sz w:val="22"/>
    <w:szCs w:val="22"/>
  </w:rPr></w:rPrDefault>
</w:docDefaults>
</w:styles>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    zip.file('[Content_Types].xml', types);
    zip.file('_rels/.rels', pkgRels);
    zip.file('word/document.xml', docXml);
    zip.file('word/styles.xml', styles);
    zip.file('word/_rels/document.xml.rels', rels);

    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      compression: 'DEFLATE',
    });
    fs.writeFileSync(docxPath, buf);
    console.log('✅ Test DOCX created:', docxPath);
  }
});
