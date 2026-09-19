# How I Made an AI Tool Reliable Using Free API Fallback Chains

Reliability is invisible when it works. Nobody notices a tool that just works every time — they only notice when it breaks. That invisibility is exactly what I was chasing when I built ParaFree's provider system, and it's one of the parts of the tool I'm most quietly proud of.

I'm Pritom Dash, a student in Australia building software on free tiers and a tight budget. Making an AI tool feel reliable when it's built entirely on free, unreliable pieces was a real challenge. Here's how I approached it.

## The problem with free AI providers

ParaFree uses artificial intelligence to reword text, and that intelligence comes from external AI providers. The catch is that the free tiers of these providers are, by their nature, unreliable. Not because the companies are bad, but because "free" comes with strings: limits on how many requests you can make per minute and per day, occasional downtime, and rules that can change without much warning.

I've personally experienced all of these. A provider quietly reduced its free limit. Another one moved its best models behind a paywall overnight. One returns errors when you send requests too quickly. If I had built ParaFree to depend on a single provider, then every one of these hiccups would have become a ParaFree outage. Your paraphrase would just fail, and you'd have no idea why.

For a tool that's supposed to feel reliable and free, depending on one shaky provider was not an option.

## The relay-team approach

The solution was to never depend on any single provider. Instead, ParaFree has a chain of them, and it treats them like a relay team.

When you ask for a paraphrase, the tool sends your request to the first provider. If that one succeeds, you get your result and you're done. But if the first provider is rate-limited, or down, or returns something empty, the tool doesn't surface an error to you. It quietly passes your request to the second provider. If that fails too, it tries the third. It keeps going down the chain until one of them completes the job.

From your side, none of this is visible. You click "paraphrase," you get your result. You never see that your request might have bounced off two providers before the third one handled it. That's the entire goal — the messy reality of unreliable free tiers should be my problem to manage, not yours to experience.

## Spreading the load so limits don't bite

There was a subtlety I had to handle beyond just falling back on failure.

If every single request always started at the same first provider, that provider would burn through its per-minute limit quickly while the others sat unused. So instead of always starting at provider one, the tool rotates the starting point. One request starts at the first provider, the next request starts at the second, the next at the third, and so on, cycling around.

This spreads the load evenly. No single provider gets hammered while the rest idle. It means the combined free limits of all the providers stretch much further than any one of them could on its own. It's the difference between one person trying to carry everything and a team sharing the weight.

## The rule I made for myself: never return half

There's one design decision I feel strongly about. When things do go wrong — when a request genuinely can't be completed even after trying every provider — the tool must never hand you a half-finished result and pretend it's done.

Early on, failures could produce partial output: half your document reworded, half untouched, presented as if it were complete. That's worse than a clear error, because you might not notice, and you'd walk away with a broken result thinking it was fine. So I built the system to either complete the job fully or tell you clearly that it's under heavy demand and to try again in a moment. Full result, or honest message. Never a silent half.

Getting this right mattered more to me than squeezing out a few extra successful requests. A tool that occasionally says "try again in a moment" is trustworthy. A tool that sometimes silently gives you broken output is not, even if it "works" more often on paper.

## Why this is a bridge

I'm honest with myself that this whole approach is a bridge rather than a permanent foundation. Stacking free tiers is a clever way to run a small tool for free and let it grow, but free tiers are fundamentally not something you'd build a serious long-term business on, precisely because they're unreliable and can change.

The plan is to use this free foundation to grow ParaFree to the point where it can fund one solid, paid, reliable AI service out of its own earnings rather than my student budget. Until then, the chain of free providers, with rotation and full fallback, does the job well enough that the tool feels reliable even though every piece underneath it is not.

## What you can borrow from this

If you're building anything that depends on external services — AI or otherwise — assume those services will fail. Not maybe. Will. Design for it. Have a fallback. Spread your load. And decide in advance what your tool does when everything fails, because it will happen, and "silently return something broken" is the wrong answer.

Building for failure is one of the most useful habits I've developed. It's the difference between a tool that feels reliable and one that only works when everything else is having a good day.

ParaFree, held together by exactly this kind of quiet reliability engineering, is at parafree.app.

— Pritom Dash
