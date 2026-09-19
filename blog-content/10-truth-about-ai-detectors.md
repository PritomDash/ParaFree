# The Truth About AI Content Detectors, From Someone Who Built One

There's a lot of anxiety right now about AI content detectors — tools that claim to tell you whether a piece of writing was produced by a human or by artificial intelligence. Students worry about being falsely accused. Writers worry about being flagged. And a whole industry has sprung up selling detection as if it were a solved, reliable science.

I want to offer a perspective you don't often hear, because I built an AI detection feature into my own tool and then made a deliberate decision about it. I'm Pritom Dash, a student in Australia, and I'm going to be honest with you about what these detectors can and cannot actually do.

## What I learned building one

When I was developing ParaFree, I included an AI-detection style feature — something that would analyze text and give a sense of how it read. Building it taught me something important, and it wasn't what I expected.

The uncomfortable truth I ran into is that reliable AI detection, especially the kind that runs quickly in a web browser, is essentially not possible to do accurately. The signals these tools rely on — patterns in sentence structure, word choice, predictability — are genuinely weak indicators. Human writing can look "AI-like" by these measures, and AI writing can look "human." The overlap is enormous.

This isn't just my opinion as a solo builder. The most telling piece of evidence is that even the largest AI company in the world, the one that makes some of the most well-known AI systems, built its own AI-text detector and then shut it down — because it wasn't accurate enough to be trustworthy. If the organization with the most resources and the deepest understanding of how these systems work couldn't build a reliable detector, that should tell you something about the state of the field.

## Why detectors get it wrong so often

The core problem is that "was this written by AI" is not a question with a clean signal to detect. Good human writing and good AI writing increasingly look the same, because the AI was trained on human writing and is genuinely good at imitating it.

Detectors end up guessing based on surface features. Does the text have varied sentence lengths? Does it use certain phrasings? Is it a bit too smooth, or a bit too predictable? But plenty of humans write smoothly and predictably. Plenty of careful human writing has even sentence lengths. And plenty of AI writing is deliberately varied and rough. So the detectors produce false positives — flagging human work as AI — and false negatives — missing AI work — at rates that make them unreliable for any decision that actually matters.

The consequences of trusting them anyway can be serious. Students have been wrongly accused based on detector outputs. That's a real harm caused by treating an unreliable guess as if it were reliable evidence.

## The decision I made

Because of what I learned, I made a deliberate choice about how to present this feature in ParaFree. Rather than claiming to precisely detect AI — a claim I knew I couldn't honestly back up — I reframed the feature around readability and naturalness. How does the text read? Does it flow naturally? That's something you can genuinely estimate, and it's honest.

I did not want to put a confident "this is X percent AI" number in front of users, because I knew that number would be misleading. It would give people false confidence in a measurement that isn't trustworthy. Being honest about what the tool can actually tell you mattered more to me than having a flashy, authoritative-sounding feature that would occasionally mislead someone into a bad decision.

That decision came directly from building the thing and seeing its limits up close. It's easy to sell AI detection as reliable when you haven't tried to build it. Once you have, the honest position is a lot more humble.

## What this means for you

If you're worried about AI detectors — as a student, a writer, or anyone whose work might be run through one — here's what I'd want you to understand. These tools are not the reliable arbiters they present themselves as. They produce false results in both directions, frequently. A flag from one is not proof of anything, and their outputs should be treated as a weak, fallible signal, not as evidence.

And if you're building a tool and thinking about adding AI detection, I'd urge you to be honest about its limits rather than overselling it. An unreliable feature presented as reliable doesn't just look bad when it's wrong — it can cause real harm to real people who trusted it.

The whole experience reinforced something I believe about building products: it's better to tell people the honest truth about what your tool can do than to impress them with a claim you can't stand behind. Being trustworthy is worth more than being impressive.

You can see how I handle this at parafree.app, where the tool tells you about readability honestly rather than pretending to detect AI with a precision that doesn't exist.

— Pritom Dash
