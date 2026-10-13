'use strict';
// Generates tests/fixtures/keep-unchanged.pptx — a minimal PPTX used by
// tests/pptx-keep-unchanged.test.js. Only the parts the paraphrase pipeline reads
// (ppt/slides/slideN.xml) carry content; the package parts make it a well-formed OPC zip.
// Run: node tests/fixtures/make-keep-unchanged-pptx.js

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const sp = (id, name, ph, paras, bodyPr = '<a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr>') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/>` +
  `<p:txBody>${bodyPr}<a:lstStyle/>${paras}</p:txBody></p:sp>`;
const pic = (id) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
const run = (t, rPr = '<a:rPr lang="en-GB" dirty="0"/>') => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`;
const slide = (shapes) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
const TITLE = '<p:ph type="title"/>';
const BODY = '<p:ph idx="1"/>';

const slides = [
  // Slide 1 — body box the mock AI rewrites (must change)
  slide(sp(2, 'Title 1', TITLE, `<a:p>${run('Quarterly Results')}</a:p>`) +
        sp(3, 'Content 2', BODY,
          `<a:p><a:pPr marL="0" indent="0"/>${run('Revenue grew strongly ', '<a:rPr lang="en-GB" b="1"/>')}${run('this quarter across all teams.')}</a:p>` +
          `<a:p>${run('Costs fell in every region we operate in.', '<a:rPr lang="en-GB" i="1"/>')}</a:p>`)),
  // Slide 2 — mixed formatting + hyperlink run; mock AI returns it unchanged (must stay byte-identical)
  slide(sp(2, 'Title 1', TITLE, `<a:p>${run('Next Steps')}</a:p>`) + pic(4) +
        sp(3, 'Content 2', BODY,
          `<a:p>${run('Read the full plan on ', '<a:rPr lang="en-GB" sz="2000"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr>')}` +
          `${run('the project site', '<a:rPr lang="en-GB" u="sng"><a:hlinkClick r:id="rId2"/></a:rPr>')}${run(' before Friday &amp; share it.')}</a:p>` +
          `<a:p>${run('Q&amp;A runs every Monday at 10:00.', '<a:rPr lang="en-GB" b="1" i="1"/>')}</a:p>`,
          '<a:bodyPr anchor="ctr"><a:noAutofit/></a:bodyPr>')),
  // Slide 3 — references; mock AI returns it unchanged (must stay byte-identical)
  slide(sp(2, 'Title 1', TITLE, `<a:p>${run('References')}</a:p>`) +
        sp(3, 'Content 2', BODY,
          `<a:p>${run('Smith, J. (2020). ')}${run('Paraphrasing at scale', '<a:rPr lang="en-GB" i="1"/>')}${run('. Journal of Text, 12(3), 45–67.')}</a:p>` +
          `<a:p>${run('Lee, K. (2021). Writing tools. https://doi.org/10.1234/wt.2021')}</a:p>`)),
];

const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
  '</Types>');
zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS}><p:sldIdLst>` +
  slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('') + '</p:sldIdLst></p:presentation>');
zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') + '</Relationships>');
zip.file('ppt/slides/_rels/slide2.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/plan?a=1&amp;b=2" TargetMode="External"/></Relationships>');
slides.forEach((x, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, x));

// Fixed dates so the fixture is byte-stable across regenerations.
zip.forEach((p, f) => { f.date = new Date('2026-01-01T00:00:00Z'); });
zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }).then(buf => {
  const out = path.join(__dirname, 'keep-unchanged.pptx');
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');
});
