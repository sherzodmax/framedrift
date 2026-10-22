# Show HN draft. Sherzod: edit and post this yourself, by hand

HN does not allow automated or bot submissions, so post this manually from your own account and reply to comments yourself. Only post after the repo is public, `npx framedrift` works from npm, and you have run it on at least one real Figma file (see LAUNCH.md, "live Figma test"). Rewrite anything that doesn't sound like you.

**Title (≤ 80 chars):**
Show HN: Framedrift – diff your Vercel preview against the Figma frame on each PR

**URL:** https://github.com/OWNER/framedrift

**Text:**

Hi HN. framedrift is a CLI and GitHub Action that opens a PR's preview deployment in headless Chromium, renders the Figma frame the page was supposed to match (via Figma's REST API), and diffs the two. It posts one PR comment with the mismatch per page and the regions that differ, each labelled with the Figma layer it falls on (e.g. "Button / Sign in (Variant=Primary)"). The full report is a single HTML file with side-by-side, overlay, swipe and diff views.

Why: visual regression tools compare your app with an earlier version of itself. That catches regressions, but not "this never matched the design." In my experience that gap shows up as designers filing screenshot tickets after merge.

How it works:
- Figma: `GET /v1/files/:key/nodes` for the layer tree and `GET /v1/images/:key` to render the frame at its bounds
- Playwright captures the page at the frame's size, after fonts and network idle, with animations and carets turned off and selectors you choose hidden
- pixelmatch does the diff. Differing pixels are grouped into regions and matched to the smallest overlapping Figma layers.
- No server. Your Figma token stays in your CI.

Limitations, up front: Figma and browsers rasterize text differently, so you'll never see 0%. Missing fonts and real data vs. placeholder content also show up as drift. Use `--hide`, `--selector` or a higher threshold for those. It's 0.1 and I'd love to hear where it breaks on real projects.

It's MIT. There's a $12/month per-repo Pro license (unlimited frames, and the Action can fail the check). It's honor-system, and the check is in the open code.

Disclosure: most of the code was written by an AI agent I run. I reviewed it and I'm the one answering here.

Try it without a Figma file: `npx framedrift compare --url https://example.com --design mockup.png`

---
Checklist before posting:
- [ ] Replace OWNER, and check the README image loads on GitHub
- [ ] Run it on one real Figma frame + real preview; make sure the "In my experience" line is true for you or remove it
- [ ] Post on a weekday morning PT; stay around for 2–3 hours to answer
- [ ] Don't ask anyone to upvote (HN penalizes it)
