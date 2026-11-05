'use strict';
// A paraphrase-like answer for mocked providers, so the quality gate in api/_quality.js treats it like a real
// paraphrase: the text that came after the prompt, same paragraphs in the same order, DOCX <<<N>>> markers and PPTX
// [SLIDEn_BOXm] tags kept, about a third of the words changed, and "[provider]" in front so a test can see
// who answered. Never sends anything anywhere.

// Where the user's text starts inside "prompt + \n\n + text"
function textPart(content) {
  const s = String(content || '');
  const m = s.search(/<<<\d+>>>|\[SLIDE\d+_BOX\d+\]/);
  if (m >= 0) return s.slice(m);
  const i = s.indexOf(':\n\n');
  return i >= 0 ? s.slice(i + 3) : s;
}

function change(paragraph) {
  let n = 0;
  return paragraph.replace(/(<<<\d+>>>\s*|\[\/?SLIDE\d+_BOX\d+\])|([A-Za-z]{3,})/g, (all, mark, word) => {
    if (mark) return mark;
    return (n++ % 3 === 0) ? word + 'ed' : word;
  });
}

function fakeAnswer(content, tag) {
  const text = textPart(content);
  const paras = text.split(/\n\s*\n/);
  const out = paras.map(change);
  if (tag) {
    const first = out[0];
    const lead = (first.match(/^(<<<\d+>>>\s*|\[SLIDE\d+_BOX\d+\])/) || [''])[0];
    out[0] = lead + '[' + tag + '] ' + first.slice(lead.length);
  }
  return out.join('\n\n');
}

// The prompt+text a mocked request carried (Groq/OpenAI style, Gemini, Cloudflare)
function contentOf(body) {
  if (!body) return '';
  if (body.messages && body.messages[0]) return body.messages[body.messages.length - 1].content || '';
  if (body.contents && body.contents[0]) return (body.contents[0].parts || []).map((p) => p.text || '').join('');
  return '';
}

module.exports = { fakeAnswer, contentOf, textPart };
