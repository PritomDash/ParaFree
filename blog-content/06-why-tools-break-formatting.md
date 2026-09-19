# Why Paraphrasing Tools Break Your Word Formatting (and How I Fixed It)

If you've ever uploaded a Word document to a paraphrasing tool and gotten back a wall of plain text with all your headings, tables, and colors gone, you've hit the exact problem that made me build ParaFree. I want to explain why this happens, because once you understand it, you'll see why most tools get it wrong — and you'll understand what it actually takes to get it right.

I'm Pritom Dash, an international student in Australia studying IT and cyber security. Keeping formatting intact while paraphrasing turned out to be the single hardest technical problem I've worked on, and I learned a lot getting it to work.

## What a Word document really is

Most people picture a Word document as the page they see: text, headings, a table, maybe some colored titles. But underneath, a .docx file is not a page. It's a structured package of instructions. The text lives in one place, and the formatting — this heading is navy and bold, this paragraph is justified, this is a table with these cells — lives as a separate layer of rules wrapped around that text.

When a naive paraphrasing tool processes your document, here's what it does: it rips out all the text, throws away the formatting layer entirely because it doesn't know what to do with it, sends the plain text to be reworded, and hands you back the result as plain text. The rewording might even be fine. But every instruction about how your document should look is gone, because the tool never tried to preserve it.

That's why you get a wall of undifferentiated text back. The tool took the easy path: extract text, ignore structure.

## The hard path, and why it's hard

The right way is to leave the entire formatting layer untouched and surgically replace only the text inside it, putting each reworded paragraph back into exactly the slot its original came from. Keep the navy heading navy. Keep the table a table. Keep the justified paragraph justified. Just change the words.

This sounds simple. It is not, and I can tell you precisely where it gets brutal.

The core difficulty is alignment. Your document has, say, forty paragraphs of body text. You send those to be reworded and you get reworded text back. Now you have to put paragraph one's rewrite into paragraph one's slot, paragraph two's into two's, and so on, perfectly, all the way down. If that alignment slips by even one — if the tool loses track of which rewrite belongs in which slot — everything after that point lands in the wrong place, and the tail of your document either fills with the wrong text or silently keeps its original wording.

I lost real time to exactly this. Documents would come out with the first half perfectly reworded and the second half untouched. It looked like the tool was giving up halfway. The actual cause was that the mapping between reworded text and original slots was drifting, and once it ran off the end, the remaining paragraphs just kept their originals.

## The things that quietly break alignment

Several things conspire to break that alignment, and each one cost me time to figure out.

The AI doing the rewording sometimes merges paragraphs. You send it nine paragraphs and it returns five, because it decided some belonged together. Now you have five rewrites for nine slots, and the last four slots have nothing to fill them. Headings and short lines cause trouble too — if the tool treats a one-word heading the same as a full paragraph, it consumes a rewrite that was meant for real body text, shifting everything after it.

The fix I landed on was to stop relying on position and counting, and instead lock each paragraph to an explicit identity. Send the paragraphs numbered, require the same numbers back, and put each numbered rewrite into its matching numbered slot. If the AI drops one, only that single paragraph keeps its original — everything else stays correctly aligned, because the alignment is anchored to identity, not to a running count that can drift.

## The decision to leave some things alone

One more thing I learned: not everything should be reworded, and trying to reword everything is a source of bugs.

Tables and charts, I leave completely untouched. The tool never sends them to be reworded at all. Partly this is correct behavior — you don't want your data table's contents rephrased — and partly it sidesteps a whole category of alignment problems. Headings and short titles I also leave alone, because "Executive Summary" doesn't become better if it's reworded into "Overview of Executive Matters." It just becomes wrong.

Deciding what to deliberately not touch turned out to be as important as deciding what to change. A good document tool is defined partly by its restraint.

## What this means for you as a user

If you use a paraphrasing tool and your formatting survives, that tool did the hard work of preserving the structure layer and surgically replacing only the text. If your formatting is destroyed, the tool took the easy path.

I built ParaFree specifically because I wanted the hard path to be the free, default experience. You upload a Word document, you get back a Word document — same headings, same tables, same colors — with the words reworded. That's the whole promise, and getting it to work reliably taught me more about how documents actually work than I ever expected to learn.

You can try it at parafree.app. Upload something with real formatting and see if it survives. That test is exactly the one I built the tool to pass.

— Pritom Dash
