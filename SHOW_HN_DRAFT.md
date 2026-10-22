# Show HN draft. Sherzod: edit and post this yourself, by hand

HN does not allow automated or bot submissions, so post this manually from your own account and reply to comments yourself. Only post after the repo is public, `npx framedrift demo` works from npm, and you have run it on at least one real Figma file (LAUNCH-CHECKLIST.md, step 5). Rewrite anything that doesn't sound like you.

**Title (≤ 80 chars):**
Show HN: Framedrift – check every PR's Vercel preview against its Figma frame

**URL:** https://github.com/OWNER/framedrift

**Text:**

Hi HN. framedrift is a GitHub Action (and CLI) that runs when Vercel finishes a preview deployment. It opens the preview in headless Chrome, renders the Figma frame the page was built from via Figma's REST API, diffs the two, and posts one PR comment: the mismatch per page and the regions that differ, each labelled with the Figma layer it falls on (e.g. "Button / Sign in (Variant=Primary)"). The full report is a single HTML file with side-by-side, overlay, swipe and diff views.

Why: I'm a product designer. There are good tools for comparing Figma with a live page — Pixelay, DualCheck, inspecta, OverlayQA — but they're browser extensions or plugins, so they only help when someone remembers to open them. Visual regression tools like Chromatic and Percy do run on every PR, but they compare the app with an earlier version of itself, so they can't tell you a page never matched the design. framedrift is the boring middle: a design check that runs in CI on every PR.

How it works:
- Figma: `GET /v1/files/:key/nodes` for the layer tree, `GET /v1/images/:key` to render the frame at its bounds
- Playwright captures the page at the frame's size, after fonts and network idle, with animations and carets off and any selectors you choose hidden
- pixelmatch does the diff; differing pixels are grouped into regions and matched to the smallest overlapping Figma layers
- No server. Your Figma token stays in your CI.

Limitations, up front: Figma and browsers rasterize text differently, so you'll never see 0%. Missing fonts and real data vs. placeholder content also show up as drift; `--hide`, `--selector` or a higher threshold handle most of it. The default 2% fail threshold is a guess, not a measured number. It's 0.1 and I'd like to hear where it breaks on real projects.

It's MIT. There's a $12/month per-repo Pro license (more than 3 frames per run, and the Action can fail the check so drift blocks merge). It's honor-system; the license check is in the open code.

Disclosure: most of the code was written by an AI agent I run. I reviewed it and I'm the one answering here.

Try it without a Figma file or token: `npx framedrift demo` (compares a built-in page that has two deliberate mistakes).

---
Checklist before posting:
- [ ] `node scripts/launch-config.mjs --owner <you> …` has been run, and the README image loads on GitHub
- [ ] Run it on one real Figma frame + real preview; make sure the "Why" paragraph is true for you, or rewrite it
- [ ] Re-check the competitor sentence against their sites the day you post (it was accurate on Oct 22, 2026)
- [ ] Post on a weekday morning PT; stay around for 2–3 hours to answer
- [ ] Don't ask anyone to upvote (HN penalizes it)
