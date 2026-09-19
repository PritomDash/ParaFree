# I'm a Student in Australia Who Built a Free AI Tool. Here's What I Actually Learned

I didn't set out to build a company. I set out to solve a problem that was annoying me, and somewhere along the way it turned into ParaFree — a free AI paraphrasing tool that people in around twenty countries now use every day.

My name is Pritom Dash. I'm from Moulvibazar, a small town in Bangladesh, and right now I'm an international student in Australia studying a Bachelor of Information Technology with a major in Cyber Security at Victoria Institute of Technology. I work part-time while I study. I build software projects in whatever hours are left over. ParaFree is one of those projects, and this blog is where I write about the real experience of building it — the parts that worked, the parts that broke, and the things I got wrong before I got them right.

I want to be honest about why I'm writing this. A lot of "how I built my startup" content online is written by people looking back after they succeeded, smoothing over the messy parts. I'm not doing that. I'm writing while I'm still in the middle of it, still a student, still figuring things out. If that's useful to you, good. If it saves you one of the mistakes I made, even better.

## Why I built it in the first place

Like most useful things, ParaFree started with frustration.

I needed to reword some writing, and every free paraphrasing tool I tried had the same problems. Word limits that cut you off after a hundred words. Sign-up walls. And the one that annoyed me most: you'd upload a Word document and get back plain text with all your formatting destroyed — no headings, no tables, no structure, nothing. If you'd spent an hour formatting a document, the tool just threw all of that away.

I remember thinking, this can't be that hard. Keep the formatting. Don't limit the words. Don't force people to sign up. That was the entire original idea. Three things other tools got wrong that I thought I could get right.

I was wrong about the "can't be that hard" part, by the way. Keeping a document's formatting intact while rewriting the text inside it turned out to be one of the hardest technical problems I've ever worked on. But I didn't know that yet, which is probably the only reason I started.

## Building with no money

Here's a constraint I want to be upfront about: I built ParaFree as a student, which means I built it with basically no budget.

That shaped every single technical decision. I couldn't pay for a powerful AI API, so I built a system that chains together free tiers from multiple providers and falls back automatically when one runs out. I couldn't pay for premium hosting, so I built everything to run inside the strict limits of a free hosting plan — including a hard ten-second cutoff on how long any single operation can take. Every time I hit one of those limits, I had to get creative instead of just paying to make the problem go away.

I actually think this made ParaFree better. When you can't buy your way out of a constraint, you're forced to understand it and engineer around it. Some of the things I'm proudest of — the way the tool spreads work across providers, the way it processes long documents fast enough to beat that ten-second limit — exist only because I couldn't afford the easy option.

If you're a student or someone building on a tight budget, I want you to hear this clearly: the constraint is not only a disadvantage. It teaches you things that money would have let you skip.

## The part nobody tells you

The building was hard, but it wasn't the hardest part. The hardest part was something I didn't expect at all.

I could get the tool working. What I couldn't easily do was get anyone to know it existed.

I spent weeks polishing features, fixing bugs, making the output better — and traffic barely moved. It took me an embarrassingly long time to understand a simple truth: a working product and a used product are two completely different things. You can build something genuinely good and have almost no one use it, purely because they've never heard of it.

That gap — between "it works" and "people use it" — is where most indie projects quietly die. Not because the product was bad, but because the person building it assumed that building was the whole job. It isn't. It's maybe half.

I'm still learning this part. I'm better at writing code than I am at telling people about what I've built. But at least now I know that both matter, and I stopped treating the promotion side as something I'd "get to later."

## Where it is now

As I write this, ParaFree recently had its highest-traffic day so far — thirty-six people in a single day, from countries including India, Nigeria, the Philippines, Kenya, Canada, and Australia. Some of them stayed for over ten minutes, clearly using it for real work.

I know thirty-six users a day is small. I'm not pretending it's a huge number. But every one of those people found a free tool that solved a real problem for them, built by a student on a student's budget, and that means something to me. It's growing on its own, without me spending a dollar on advertising, which tells me the core idea — free, no limits, keeps your formatting — is something people actually want.

## What I'd tell you if you're thinking about building something

Start before you feel ready, because you'll never feel ready. Pick a problem that actually annoys you, because you'll need that annoyance to push through the hard parts. Expect the building to be harder than you think and the promoting to be harder still. And treat your constraints — no money, no time, no team — as a design brief rather than an excuse.

I'm going to keep writing here about the specific things I've learned building ParaFree: the technical problems I solved, the mistakes that cost me days, the decisions I made about keeping it free. Real lessons from an actual project, not recycled advice.

If you want to see the thing itself, it's at parafree.app. It's free, there's no word limit, and it keeps your formatting. That's still the whole idea.

— Pritom Dash
