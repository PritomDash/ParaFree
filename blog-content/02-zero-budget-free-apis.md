# How I Built an AI Tool With a $0 Budget (Using Free APIs)

When people find out ParaFree runs on artificial intelligence, one of the first questions I get is some version of "how much does that cost you to run?" They assume there's a big monthly bill behind it.

The honest answer, right now, is close to nothing. I built ParaFree as a student with no budget, and it runs on free tools stitched together carefully. I want to explain exactly how, because when I was starting out I couldn't find a straight answer to this question anywhere, and I think a lot of people assume you need money to build with AI when you often don't — at least not at the start.

I'm Pritom Dash, an international student in Australia studying IT and cyber security, and ParaFree is the project where I learned most of this the hard way. Here's the real setup, minus the parts that would help someone abuse it.

## The core idea: don't rely on one provider

The obvious way to build an AI tool is to sign up for one AI provider, get an API key, and send all your requests there. That works, but it has two problems for someone in my position.

First, the good providers cost money once you go past a small free allowance. Second — and this is the part people underestimate — free tiers are unreliable. They have limits on how many requests you can make per minute and per day. They occasionally go down. They change their rules without much warning. I've had a provider quietly cut its free limit, and I've had one make its best models paid overnight. If your whole tool depends on one provider, the day that provider has a bad day, your tool has a bad day too.

So I didn't build it that way. Instead of relying on one AI provider, ParaFree uses several, chained together.

## How the chain actually works

Think of it like a relay team. When a paraphrasing request comes in, the tool tries the first provider. If that one works, great — you get your result. If it's hit its rate limit, or it's slow, or it returns something empty, the tool doesn't just give up and show you an error. It automatically hands the request to the next provider in the chain. Then the next, and the next, until one of them completes the job.

To the person using ParaFree, this is invisible. They click "paraphrase," they get their result. They have no idea that behind the scenes their request might have bounced off two providers before landing on a third. That invisibility is the point. Reliability shouldn't be the user's problem to notice.

I also spread the load deliberately. If every request started at the same provider, that provider would burn through its per-minute limit fast while the others sat idle. So the tool rotates which provider it tries first. One request starts at provider A, the next starts at provider B, and so on. This keeps any single free tier from being overwhelmed, which means the free limits stretch much further than they would otherwise.

## The lesson that took me a whole day to learn

I want to share one specific mistake, because it taught me something important about debugging.

For a while, long documents would sometimes come out only half-processed. The first half would be perfectly reworded and the second half would be untouched. It looked exactly like a bug in my code, and I spent hours hunting through the logic convinced I'd made a mistake somewhere in how the document was being handled.

The real cause was completely different. My document was being split into chunks, and each chunk was a separate AI request. On a long document with several chunks, I was hitting the free tier's per-minute request limit partway through. The early chunks succeeded; the later chunks got blocked by the rate limit and silently failed. The "bug" wasn't in my document code at all. It was the free tier's limits doing exactly what they're designed to do.

The lesson stuck with me: when something breaks intermittently and inconsistently, look at your infrastructure and its limits before you assume your own code is wrong. I lost a day assuming the problem was me. The logs, once I actually read them properly, told the real story in about five minutes.

## Why this approach makes sense for a bridge, not forever

I'm honest with myself that this free-tier stacking is a bridge, not a permanent foundation. Free tiers are generous enough to get a small tool off the ground and let it grow, but they're not something you'd want to bet a serious business on long-term, precisely because they're unreliable and can change.

My plan has always been to use the free tiers to reach a point where the tool has enough users to justify paying for one solid, reliable AI service — funded by the tool itself rather than out of my student budget. Until then, the chain of free providers does the job, and it does it well enough that most people never notice they're using a tool held together with careful engineering rather than a big cloud bill.

## What you can take from this

If you want to build something with AI and you don't have money yet, you have more options than you might think. The free tiers from major AI providers are real, and they're usable. The trick is not to depend on any single one of them. Build for failure. Assume providers will hit limits, go down, and change their rules — because they will — and design your tool to route around those problems automatically.

That mindset, "assume it will fail and handle it gracefully," is honestly one of the most useful things I've learned building ParaFree. It applies to a lot more than AI.

If you want to see the result of all this, ParaFree is at parafree.app. It's free and has no word limit — and now you know a bit about what's keeping it running underneath.

— Pritom Dash
