# What Building a Real Product Taught Me That University Didn't

I'm studying for a Bachelor of Information Technology, majoring in Cyber Security, at Victoria Institute of Technology in Australia. I value my degree. But if I'm being completely honest, some of the most important things I've learned about building software, I didn't learn in a classroom. I learned them by building ParaFree — a real tool, used by real people, that breaks in real ways.

I'm Pritom Dash, an international student from Bangladesh, and this is an honest reflection on the gap between studying technology and actually shipping it. I don't mean this as a knock on education. I mean it as encouragement to build something real alongside whatever you're studying, because the two teach different things and you need both.

## University teaches you the ideal; building teaches you the mess

In a course, problems are clean. You're given a well-defined task, the tools work, and there's usually a correct answer the instructor already knows. That's good for learning fundamentals. You need that structure to understand how things are supposed to work.

But real projects are not clean. When I was building ParaFree's document handling, the problem wasn't "implement this algorithm correctly." The problem was "sometimes, for reasons that aren't obvious, a document comes out half-processed, and you need to figure out why." No instructor knew the answer. There was no answer key. The bug didn't behave the same way twice. I had to become a detective, not a student following steps.

That experience — sitting with a problem that has no known solution, that behaves inconsistently, that you have to reason your way through from evidence — is something I'm not sure any assignment could have taught me. University gave me the foundation to even understand the problem. Building forced me to solve one that nobody had solved for me.

## The lesson about diagnosing before fixing

Here's a specific thing building taught me that has changed how I work.

Early on, when something broke, my instinct was to immediately start changing code. See a problem, start "fixing." It felt productive. It was usually a mistake. More than once I "fixed" something that wasn't actually broken and created a new problem in the process.

The real skill, which I learned the slow and painful way, is to diagnose before you touch anything. Read the logs. Reproduce the problem. Understand exactly what's happening and why, before you change a single line. One of my worst days building ParaFree was spent hunting for a bug in my own code that turned out not to be in my code at all — it was an external limit I hadn't accounted for. If I'd spent the first ten minutes reading the evidence instead of the first several hours rewriting logic, I'd have found it immediately.

"Diagnose before you fix" sounds obvious written down. It is not obvious in the moment, when something's broken and you feel the urge to do something. Learning to resist that urge and investigate first is a discipline, and I only really learned it because I had my own project where the cost of guessing wrong was mine to pay.

## Protecting your work is a skill nobody teaches

Another thing university never covered, because assignments don't need it: how to not destroy your own working product.

When ParaFree was live and people were actually using it, breaking it had real consequences. A bad change could take the tool offline for real users. I learned — again, the hard way — to never make risky changes directly to the live version. Instead I make changes in a separate, safe copy, test them properly, and only apply them to the real thing once I'm sure they work. I keep backups. I keep a known-good version I can instantly return to if something goes wrong.

This whole discipline of protecting working software while you improve it is essential once real people depend on your product, and it's something you basically never practise on coursework, because coursework doesn't have live users who suffer when you break something. Building a real product taught me to respect the difference between "code that works on my machine" and "code that people are depending on right now."

## Building makes the studying click

I don't want to give the impression that the degree is pointless. The opposite is true. Building ParaFree made my studies make more sense, not less.

Concepts that felt abstract in a lecture suddenly had weight once I'd hit them in the wild. Understanding how systems fail, how to think about limits and reliability, how to reason about security — my cyber security studies connect directly to decisions I make building real tools. The theory and the practice reinforce each other. The classroom gave me the vocabulary and the fundamentals; the project gave me the scars and the intuition. Neither alone would have been enough.

## What I'd tell another student

If you're studying technology, build something real on the side. It doesn't have to be big. It doesn't have to succeed. It just has to be real — something with actual users, or at least something that has to work in the messy real world rather than in the clean world of an assignment.

You'll learn things the curriculum can't teach you: how to diagnose problems nobody has solved, how to protect working systems, how to handle the gap between "it works in theory" and "it works for a stranger in another country at two in the morning." And you'll find that the building and the studying make each other better.

I'm still a student. I'm still building. I'm learning from both, and I'm convinced the combination is worth more than either one alone.

ParaFree, the tool that taught me most of this, is at parafree.app.

— Pritom Dash
