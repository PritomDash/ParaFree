# Self-Hosting vs CDN: A Lesson I Learned the Hard Way

This one is about a small technical decision that taught me a big lesson about reliability. It involves something called a CDN, and a moment where relying on one nearly caused a problem for the people using my tool. I'm Pritom Dash, a student in Australia building software, and this is the kind of thing you only learn by getting caught out.

## What a CDN is, briefly

When a website needs a piece of software — a library that does some specific job, like generating a Word document — it usually loads that library from a CDN, which stands for content delivery network. A CDN is a service that hosts common libraries and serves them to any website that asks. It's convenient. You add one line pointing to the CDN, and the library loads. You don't have to store it yourself. Almost everyone does it this way, because it's easy and it usually just works.

ParaFree needed a library to build the Word documents it hands back to you after paraphrasing. So, like everyone, I loaded that library from a CDN. Two CDNs, actually, with one as a backup for the other. Convenient, standard, done.

## The moment it almost bit me

During a test of the tool, I noticed something alarming in the technical logs. Both of the CDNs I was relying on for that Word-document library had returned errors at the same time. Both were temporarily unavailable.

Think about what that meant. That library is what powers the "download as Word" feature — the whole point of the tool for a lot of people. If both CDNs were down and someone tried to download their reworded document as a Word file, it could fail. The core feature, broken, not because of anything wrong in my code, but because I'd outsourced a critical piece to external services that both happened to have a bad moment at the same time.

It didn't cause a visible disaster that day, because there was a fallback chain and the outage was brief. But it exposed a real weakness. I had made one of my most important features depend entirely on external services staying up, and I had no control over whether they did.

## The lesson: don't outsource your critical pieces

The lesson landed hard: for the parts of your tool that are genuinely critical, depending on external services you don't control is a real risk, not a theoretical one.

CDNs are reliable most of the time. But "most of the time" isn't good enough for the feature your tool is built around. And the failure I saw wasn't even one CDN having a bad day — it was two, simultaneously, both of which I'd chosen specifically for reliability. If the backup can fail at the same time as the primary, the backup isn't really protecting you.

The fix was to stop depending on external CDNs for that critical library and instead host it myself, served directly from my own site. Now, when someone downloads a Word document, the library that builds it comes from ParaFree's own server. It doesn't matter if external CDNs are having a bad day, because ParaFree isn't relying on them for this anymore. The critical piece is under my control.

## The nuance: it's a trade-off, not a rule

I want to be honest that "always self-host everything" is not the correct lesson. CDNs exist for good reasons. They're fast, they're convenient, and for non-critical things they're perfectly fine. If a library powers some minor, optional feature, loading it from a CDN and accepting the tiny risk is a reasonable choice.

The real lesson is more nuanced: understand which of your dependencies are critical, and treat those differently. For the piece that powers your core feature — the thing that, if it breaks, breaks your whole tool — the convenience of a CDN isn't worth the loss of control. Host it yourself. For everything else, use your judgment.

I now think about my dependencies in terms of "what happens if this fails." If the answer is "a minor feature is briefly unavailable," a CDN is fine. If the answer is "the core of my tool breaks for users," I want that under my own control.

## Why I'm sharing a near-miss

I could have kept quiet about this, since it never turned into a visible outage. But I think near-misses are some of the most valuable things to learn from, precisely because they show you a weakness before it hurts anyone. I got lucky that the moment I noticed both CDNs failing was during a test and not during a busy day with real users trying to download their work.

That luck is exactly why I fixed it. You don't want your reliability to depend on getting lucky. The whole point of good engineering is to remove the luck — to make sure that when external things fail, and they will, your tool keeps working anyway.

## What you can take from this

If you're building anything, ask yourself which of your dependencies are critical and what happens when they fail. Test for it. And for the pieces your tool truly can't function without, seriously consider keeping them under your own control rather than trusting that external services will always be up.

Reliability isn't about hoping nothing breaks. It's about making sure that when things break — and they will — the important stuff keeps working.

ParaFree, now serving its critical library from its own server, is at parafree.app.

— Pritom Dash
