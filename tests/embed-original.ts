// The landing-embeds round's additions, removed again: what index.html, cv-builder.html and the landing pages
// were before it. Used to prove that, without ?embed, nothing else changed (landing-embeds.spec.ts) and to keep
// the PDF round's homepage size budget about the PDF tools only (pdf-home.spec.ts).
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
// the commit this round started from (pdf-seo, ad6dbe5): the "before" for every file touched here
export const BASE = 'ad6dbe5';
export const lf = (s: string) => s.split('\r\n').join('\n');
const read = (f: string) => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'));

function cut(s: string, a: string, b: string, what: string) {
  if (s.split(a).length !== 2) throw new Error(`${what}: expected exactly one ${JSON.stringify(a.slice(0, 60))}`);
  return s.replace(a, b);
}

export const INDEX_GA_NOW = "  // ?embed=paraphraser (the tool inside a landing page): the landing page already sent the page view\n" +
  "  if (/[?&]embed=paraphraser(&|$)/.test(location.search)) gtag('config', 'G-0QEEGS0DZQ', { send_page_view: false });\n" +
  "  else gtag('config', 'G-0QEEGS0DZQ');";

export function indexWithoutEmbed(s = read('index.html')) {
  s = lf(s);
  const a = s.indexOf('<!-- EMBED MODE (?embed=paraphraser)'), end = '<!-- /EMBED MODE -->\n', b = s.indexOf(end);
  if (a < 0 || b < a) throw new Error('index.html: embed block not found');
  s = s.slice(0, a) + s.slice(b + end.length);
  s = cut(s, INDEX_GA_NOW, "  gtag('config', 'G-0QEEGS0DZQ');", 'index GA');
  s = cut(s, 'if(window.PF_EMBED||c&&(c.saveData', 'if(c&&(c.saveData', 'index prefetch');
  s = cut(s, '  if (!window.PF_EMBED) try {\n', '  try {\n', 'index rating');
  // the ?lang= fix: the handler runs at DOMContentLoaded (it used to run before #outputText existed)
  s = cut(s, "// (runs once the page is parsed: #outputText comes after this script)\ndocument.addEventListener('DOMContentLoaded', function() {\n  var RTL_LANGS",
    "(function() {\n  var RTL_LANGS", 'index lang start');
  s = cut(s, "        applyDir();\n        break;\n      }\n    }\n  }\n});\n</script>", "        applyDir();\n        break;\n      }\n    }\n  }\n})();\n</script>", 'index lang end');
  return s;
}

export function cvBuilderWithoutEmbedChanges(s = read('cv-builder.html')) {
  s = lf(s);
  s = cut(s, '<!-- EMBED MODE (?embed=1): the homepage "CV Builder" tab and the CV landing pages show this page in an iframe.',
    '<!-- EMBED MODE (?embed=1): the homepage "CV Builder" tab shows this page in an iframe.', 'cv comment');
  s = cut(s, "  // GA: tool events fire as normal; embed_page = the page showing the builder (homepage tab or a landing page)\n" +
    "  try { if (typeof gtag === 'function') gtag('set', { embed_page: parent.location.pathname }); } catch (e) {}\n", '', 'cv GA set');
  return s;
}

// a landing page without its one "try it here" block
export const EMBED_BLOCK = /\n\n<!-- TRY THE TOOL HERE[\s\S]*?<!-- \/TRY THE TOOL HERE -->\n/g;
export function pageWithoutEmbed(f: string, s = read(f)) {
  const m = lf(s).match(EMBED_BLOCK);
  if (!m || m.length !== 1) throw new Error(`${f}: expected one embed block, found ${m ? m.length : 0}`);
  return lf(s).replace(EMBED_BLOCK, '\n');
}
