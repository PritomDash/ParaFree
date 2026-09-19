# The 10-Second Problem: Building Fast Document Processing on Free Hosting

There's a constraint I built ParaFree around that most people using it will never know exists: every operation the tool performs has to finish in under ten seconds. Not because I chose that number, but because the free hosting ParaFree runs on enforces it. Any single operation that takes longer than ten seconds gets killed, mid-task, with no mercy.

I want to write about this because it's a perfect example of how a constraint you can't remove forces you to build something better than you would have otherwise. I'm Pritom Dash, a student in Australia building tools on a student's budget, and this ten-second wall shaped one of the most important parts of ParaFree.

## Where the limit comes from

Free hosting plans are generous in a lot of ways, but they draw hard lines to keep costs down. One of those lines is a maximum execution time. On the plan I use, no single server operation can run longer than ten seconds. Hit ten seconds and one millisecond, and the operation is terminated. The user gets nothing, or worse, a half-finished result.

The obvious solution is to pay for a plan without that limit. But I'm a student building on no budget, so paying wasn't the answer I wanted to reach for first. And honestly, I've come to believe that reaching for "just pay to remove the limit" too quickly makes you a worse engineer, because you never learn to understand the limit and work within it.

## Where it bit me

Short documents were fine. A quick paraphrase finishes in a couple of seconds, well under the limit. The problem was long documents.

A long document gets split into chunks — pieces small enough to process — and each chunk is handled separately. My original approach processed them one after another. Chunk one, then chunk two, then chunk three, in sequence. For a short document with one or two chunks, fine. But for a long document with five or six chunks, each taking a few seconds, the total time stacked up past ten seconds. The operation got killed partway through. The result: a document that was only partly processed, because the server pulled the plug before the later chunks finished.

This was maddening at first because it was inconsistent. A slightly shorter document would squeak in under ten seconds and work perfectly. A slightly longer one would blow past the limit and fail. Same code, different outcome, depending purely on length. That inconsistency is what eventually pointed me at the real cause.

## The fix that made it faster, not just compliant

The solution was to stop processing chunks one after another and start processing them all at the same time.

Instead of chunk one, then two, then three, the tool now fires all the chunks off together and waits for them to come back. Because they run in parallel rather than in sequence, the total time isn't the sum of all of them — it's roughly the time of the single slowest one. Five chunks that would have taken fifteen seconds in sequence now finish in about three seconds together. Comfortably under the ten-second wall.

What I love about this fix is that it didn't just make the tool comply with the limit. It made the tool genuinely faster for everyone. A long document that used to crawl now processes quickly. The constraint forced me toward a design that was better in every way, not just a workaround that scraped under the line.

There was a catch to handle: firing many requests at once means many simultaneous calls to the AI providers, which could hit their per-minute limits. So I spread the parallel chunks across different providers, so they don't all pile onto the same one at the same moment. The constraint on one side (hosting time) pushed me toward parallelism, and parallelism created a new consideration (provider load) that I then had to design around too. That's how real engineering tends to go — solving one constraint reveals the next.

## Why I'm glad the limit existed

It sounds strange, but I'm genuinely glad I couldn't just pay to remove the ten-second limit.

If I'd had unlimited execution time, I'd have left the slow sequential processing in place, because it worked. The limit forced me to find the parallel approach, which is faster, which is better for every single person who uses ParaFree, whether their document is long or short. The constraint didn't just get worked around; it made the product better.

This is a pattern I've seen again and again building on a budget. The limits you can't buy your way past are the ones that teach you the most and often push you toward genuinely better solutions. Money lets you skip the lesson. No money forces you to learn it.

## The takeaway

If you're building on free or limited infrastructure, don't treat the limits purely as obstacles. Treat them as a design brief. A hard cap on execution time told me exactly what my architecture needed to be: fast, parallel, and efficient. I might never have gotten there if I'd had the option to be lazy and slow.

The next time you hit a wall you can't remove, before you go looking for a way to pay past it, sit with it for a while. There's often a better design hiding on the other side of the constraint.

ParaFree, running fast inside its ten-second walls, is at parafree.app.

— Pritom Dash
