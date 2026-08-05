/**
 * WORKING PPTX CODE — ParaFree index.html
 * Backed up: 2026-08-05
 * Restore point BEFORE polishing overflow issues.
 *
 * If PPTX breaks after polishing, these are the known-good functions.
 * Locations are line numbers in index.html at the time of backup (main @ a42f4a1).
 *
 * PIPELINE SUMMARY:
 *   handlePPTXUpload  → extracts all slide text boxes via extractSpTextBoxes
 *   paraphrasePPTX    → chunks text boxes, tags them [SLIDE1_BOX1]...[/SLIDE1_BOX1],
 *                       sends to API, parses responses back to slide.textBoxItems[ti].paraphrased
 *   downloadPPTX      → re-reads each slide XML from original zip, calls modifyTextBox
 *                       for each paraphrased text box, writes modified XML back to zip,
 *                       generates blob download
 *
 * NOTE: homeCreatePPTX (line ~5686) is the CV-builder PPTX pipeline — completely
 * separate from the paraphraser. It uses PptxGenJS to build slides from scratch.
 * Not included here as it is not affected by the overflow polishing work.
 */

// ─── GLOBAL STATE (line 4572) ───────────────────────────────────────────────
let pptxMode = false;
let pptxData = null;


// ─── extractSpTextBoxes (line 4576) ─────────────────────────────────────────
// Return array of {spIdx, text} for every <p:sp> with <p:txBody> text >= 10 chars
function extractSpTextBoxes(slideXml) {
  const items = [];
  let spIdx = 0;
  slideXml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, function(spXml) {
    if (spXml.includes('<p:txBody')) {
      const parts = [];
      spXml.replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g, (m, t) => parts.push(pptxDecodeXml(t)));
      const text = parts.join('').trim();
      if (text.length >= 10) items.push({ spIdx, text });
    }
    spIdx++;
  });
  return items;
}


// ─── modifyTextBox (line 4592) ──────────────────────────────────────────────
// Surgically replace text in one <p:sp>: keep first run's rPr, add spAutoFit, one paragraph
function modifyTextBox(spXml, paraphrasedText) {
  const newText = pptxEncodeXml(paraphrasedText.trim());
  return spXml.replace(/(<p:txBody\b[^>]*>)([\s\S]*?)(<\/p:txBody>)/, function(m, open, inner, close) {
    // 1. Rebuild <a:bodyPr> with spAutoFit, keeping all original attributes
    let newBodyPr;
    const bpOpen = inner.match(/<a:bodyPr(\b[^>]*)>([\s\S]*?)<\/a:bodyPr>/);
    const bpSelf = inner.match(/<a:bodyPr(\b[^>]*?)\/>/);
    if (bpOpen) {
      const cleaned = bpOpen[2].replace(/<a:(?:noAutofit|normAutofit|spAutoFit)\s*\/>/g, '');
      newBodyPr = '<a:bodyPr' + bpOpen[1] + '><a:spAutoFit/>' + cleaned + '</a:bodyPr>';
    } else if (bpSelf) {
      newBodyPr = '<a:bodyPr' + bpSelf[1] + '><a:spAutoFit/></a:bodyPr>';
    } else {
      newBodyPr = '<a:bodyPr><a:spAutoFit/></a:bodyPr>';
    }

    // 2. Keep <a:lstStyle> exactly as-is
    const lstStyleM = inner.match(/<a:lstStyle\b[^>]*>[\s\S]*?<\/a:lstStyle>|<a:lstStyle\b[^>]*\/>/);
    const lstStyle = lstStyleM ? lstStyleM[0] : '<a:lstStyle/>';

    // 3. From first <a:p>: extract <a:pPr> and first <a:r>'s <a:rPr>
    let pPr = '', rPr = '';
    const firstParaM = inner.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/);
    if (firstParaM) {
      const pPrM = firstParaM[0].match(/<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>|<a:pPr\b[^>]*\/>/);
      if (pPrM) pPr = pPrM[0];
      const firstRunM = firstParaM[0].match(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>/);
      if (firstRunM) {
        const rPrM = firstRunM[1].match(/<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>|<a:rPr\b[^>]*\/>/);
        if (rPrM) rPr = rPrM[0];
      }
    }

    // 4. One paragraph, one run, paraphrased text
    const newInner = newBodyPr + lstStyle +
      '<a:p>' + pPr + '<a:r>' + rPr + '<a:t>' + newText + '</a:t></a:r></a:p>';
    return open + newInner + close;
  });
}


// ─── pptxDecodeXml (line 4632) ──────────────────────────────────────────────
function pptxDecodeXml(str) {
  return str.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}


// ─── pptxEncodeXml (line 4636) ──────────────────────────────────────────────
function pptxEncodeXml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}


// ─── stripMarkdown (line 4640) ──────────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/_{2}(.+?)_{2}/gs, '$1')
    .replace(/_(.+?)_/gs, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ─── handlePPTXUpload (line 4655) ───────────────────────────────────────────
async function handlePPTXUpload(file) {
  if (typeof JSZip === 'undefined') {
    showStatus("PPTX support is still loading. Please try again.", "error");
    return;
  }
  showStatus("Reading PPTX file...", "info");
  try {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const slides = [];
    let i = 1;
    while (true) {
      const slideFile = zip.file('ppt/slides/slide' + i + '.xml');
      if (!slideFile) break;
      const xml = await slideFile.async('string');
      const textBoxItems = extractSpTextBoxes(xml);
      if (textBoxItems.length > 0) slides.push({ num: i, textBoxItems });
      i++;
    }
    if (slides.length === 0) {
      showStatus("No text found in any PPTX slides.", "error");
      return;
    }
    if (currentTool === 'paraphrase') {
      pptxData = { zip, slides };
      pptxMode = true;
      const preview = slides.map(s =>
        '[Slide ' + s.num + ']\n' + s.textBoxItems.map(it => it.text).join('\n')
      ).join('\n\n');
      inputEl.value = preview;
      document.getElementById('inputCount').textContent = countWords(preview) + ' words';
      const total = slides.reduce((n, s) => n + s.textBoxItems.length, 0);
      showStatus('✓ PPTX loaded — ' + total + ' text box(es) across ' + slides.length + ' slide(s). Click Paraphrase Now.', 'success');
    } else {
      const combined = slides.map(s => s.textBoxItems.map(it => it.text).join('\n')).join('\n\n');
      inputEl.value = combined;
      document.getElementById('inputCount').textContent = countWords(combined) + ' words';
      showStatus('✓ PPTX text extracted from ' + slides.length + ' slide(s). Ready to process.', 'success');
    }
  } catch (e) {
    console.error(e);
    showStatus("Error reading PPTX. Make sure it is a valid .pptx file.", "error");
    pptxMode = false;
    pptxData = null;
  }
}


// ─── paraphrasePPTX (line 4702) ─────────────────────────────────────────────
async function paraphrasePPTX() {
  if (!pptxData) return;
  const { slides } = pptxData;
  const totalItems = slides.reduce((n, s) => n + s.textBoxItems.length, 0);

  setLoading(true);
  resetApiDots();
  hideStatus();
  document.getElementById('outputText').innerHTML = '<span class="output-placeholder">Preparing PPTX for paraphrase...</span>';

  // Flatten all text boxes across slides, then chunk into groups of max 20 items
  const CHUNK_CHAR_LIMIT = 8000;
  const MAX_ITEMS_PER_CHUNK = 20;

  const allItems = [];
  for (const slide of slides) {
    for (let ti = 0; ti < slide.textBoxItems.length; ti++) {
      const tag = 'SLIDE' + slide.num + '_BOX' + (ti + 1);
      allItems.push({ slide, ti, tag, tagged: '[' + tag + ']' + slide.textBoxItems[ti].text + '[/' + tag + ']' });
    }
  }

  const chunks = [];
  let cur = [], curLen = 0;
  for (const item of allItems) {
    if (cur.length >= MAX_ITEMS_PER_CHUNK || (cur.length > 0 && curLen + item.tagged.length > CHUNK_CHAR_LIMIT)) {
      chunks.push(cur); cur = []; curLen = 0;
    }
    cur.push(item); curLen += item.tagged.length;
  }
  if (cur.length > 0) chunks.push(cur);

  const basePrompt = (MODE_PROMPTS[currentMode] || MODE_PROMPTS.standard) +
    '\n\nIMPORTANT: Paraphrase the text inside each tag. Return ALL tags unchanged in your response. Never remove, rename, or modify the tags — only change the text inside them.';

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkText = chunk.map(i => i.tagged).join('\n');
    const partLabel = chunks.length > 1 ? 'part ' + (ci + 1) + ' of ' + chunks.length : '';
    const statusMsg = chunks.length > 1
      ? 'Paraphrasing ' + partLabel + ' (' + chunk.length + ' text boxes)...'
      : 'Paraphrasing ' + totalItems + ' text boxes...';
    showStatus(statusMsg, 'info');
    document.getElementById('outputText').innerHTML =
      '<span class="output-placeholder">' + (chunks.length > 1 ? 'Paraphrasing ' + partLabel + '...' : 'Paraphrasing...') + '</span>';

    const raw = await runAPIChain(chunkText, basePrompt, currentMode, getLang(), 'paraphrase');
    if (!raw) {
      setLoading(false);
      showStatus('Paraphrase failed' + (chunks.length > 1 ? ' on ' + partLabel : '') + '. Please try again.', 'error');
      return;
    }

    // Parse each tagged section back to its item
    for (const { slide, ti, tag } of chunk) {
      const m = raw.match(new RegExp('\\[' + tag + '\\]([\\s\\S]*?)\\[\\/' + tag + '\\]', 'i'));
      slide.textBoxItems[ti].paraphrased = m ? stripMarkdown(m[1].trim()) : slide.textBoxItems[ti].text;
    }

    // 2s delay between chunks — Groq's per-minute token limit needs breathing room
    if (ci < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  setLoading(false);
  pptxData.ready = true;

  const allResults = [];
  for (const slide of slides) {
    for (let ti = 0; ti < slide.textBoxItems.length; ti++) {
      const item = slide.textBoxItems[ti];
      allResults.push('[Slide ' + slide.num + ', Box ' + (ti + 1) + ']\n' + (item.paraphrased || item.text));
    }
  }

  const output = allResults.join('\n\n');
  renderOutput(output);
  document.getElementById('outputCount').textContent = countWords(output) + ' words';
  showStatus('✓ All ' + totalItems + ' text box(es) paraphrased! Download your PPTX below.', 'success');
  showDownloadBtn();
}


// ─── downloadPPTX (line 4785) ───────────────────────────────────────────────
async function downloadPPTX() {
  if (!pptxData || !pptxData.ready) {
    alert('No paraphrased PPTX data. Please upload and paraphrase a PPTX file first.');
    return;
  }
  showPptxOverlay();
  setDlBtnLoading('downloadBtn');
  try {
    const { zip, slides } = pptxData;
    for (const slide of slides) {
      const slideFile = zip.file('ppt/slides/slide' + slide.num + '.xml');
      if (!slideFile) continue;
      let xml = await slideFile.async('string');
      let spIdx = 0;
      xml = xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, function(spXml) {
        const idx = spIdx++;
        const item = slide.textBoxItems.find(it => it.spIdx === idx && it.paraphrased);
        if (item) return modifyTextBox(spXml, item.paraphrased);
        return spXml;
      });
      zip.file('ppt/slides/slide' + slide.num + '.xml', xml);
    }
    const blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      compression: 'DEFLATE'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paraphrased_presentation.pptx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showStatus('✓ PPTX downloaded!', 'success');
  } catch (e) {
    console.error('[downloadPPTX]', e);
    alert('PPTX download failed: ' + (e && e.message ? e.message : String(e)));
    showStatus('PPTX download failed. See popup for details.', 'error');
  } finally {
    hidePptxOverlay();
    restoreDlBtn('downloadBtn');
  }
}
