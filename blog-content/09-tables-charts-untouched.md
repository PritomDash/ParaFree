# Why I Keep Tables and Charts Untouched When Paraphrasing Documents

Here's a design decision in ParaFree that might seem counterintuitive at first: when you paraphrase a document, the tool deliberately does not touch your tables, charts, or graphs at all. It reworths the body text around them and leaves them exactly as they were. This was a deliberate choice, and I want to explain the reasoning, because it says something about what a good document tool should and shouldn't do.

I'm Pritom Dash, a student in Australia who built ParaFree, and I spent real time figuring out where the line should be between "reword this" and "leave this alone."

## The instinct to change everything is wrong

When you build a paraphrasing tool, there's a natural instinct to reword absolutely everything — every piece of text in the document, no exceptions. More rewording feels like more value. But that instinct is wrong, and tables are the clearest example of why.

Think about what a table actually contains. A financial table has numbers: revenue figures, percentages, dates, totals. A data table has labels and values that mean something precise. If a paraphrasing tool "rewords" the contents of a table, what exactly is it supposed to do? Reword "Revenue" into "Income generated"? Change "$31.2M" into "approximately thirty-one million dollars"? Turn "Q3" into "the third quarter"?

None of that helps. In most cases it actively hurts. The whole point of a table is precise, structured data. Rewording it damages the precision without adding anything. A table isn't prose that benefits from being rephrased. It's information that needs to stay exactly as it is.

## The technical reason it's also cleaner

Beyond it being the right thing for the user, leaving tables and charts alone also made the tool more reliable, and this is a lesson worth sharing.

When I was solving the hardest problem in ParaFree — keeping document formatting intact while rewording the text — a huge source of difficulty was keeping the reworded pieces aligned with their correct slots in the document. Every extra thing the tool tried to process was another opportunity for that alignment to slip.

Tables are structurally complicated. They have rows, cells, nested content, merged cells. If I tried to send table contents through the rewording process along with the body text, I'd have introduced a whole category of alignment problems and edge cases. By deciding early that tables and charts simply never enter the rewording process — the tool skips right over them and leaves their original content in place — I eliminated an entire class of potential bugs.

So the decision served two goals at once. It's better for the user, because their data stays precise. And it's better for the tool, because it's simpler and more reliable. When a design choice is both more correct and more robust, that's usually a sign you've found the right answer.

## Charts and graphs: the same logic, stronger

Charts and graphs follow the same reasoning, even more strongly. A chart is a visual representation of data. Its labels, its values, its structure — all of it is precise information that shouldn't be reworded. And technically, charts are embedded objects with their own internal structure that has nothing to do with the flowing text of the document.

ParaFree leaves them completely alone. When you paraphrase a document with charts, those charts come out the other side byte-for-byte identical to how they went in. Same data, same colors, same positions. The tool reads right past them and focuses only on the actual prose.

I tested this thoroughly, including on deliberately brutal documents packed with many chart types, and confirmed that the charts pass through untouched every time. That reliability is a direct result of the decision to never process them in the first place.

## Restraint as a feature

I've come to think that restraint is an underrated feature in a tool. It's tempting to make a tool "do more" — process everything, change everything, touch everything. But a good document tool is defined as much by what it refuses to touch as by what it changes.

Your headings stay as headings. Your tables stay as tables with their exact data. Your charts stay as charts. The tool changes the words in your paragraphs, which is the part that actually benefits from rewording, and it leaves the structured, precise parts of your document exactly as you built them.

When you use ParaFree on a document with tables and charts, you're seeing this restraint at work. The prose gets reworded; the data stays perfect. That's not the tool being lazy. That's the tool knowing where the line is.

## What this means for you

If you have a report, a financial document, a data-heavy presentation, or anything with tables and charts, you can paraphrase the writing around your data without worrying that your data will get mangled. The numbers stay the numbers. The tables stay the tables. Only the prose changes.

That's a promise I could only make confidently because I decided, from the start, that some things in a document should never be touched — and built the tool to honor that.

Try it with a data-heavy document at parafree.app and watch your tables come through perfectly intact.

— Pritom Dash
