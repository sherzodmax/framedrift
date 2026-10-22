# framedrift — landing page copy

(Draft for Sherzod. No testimonials, logos or usage numbers until they are real. `index.html` in this folder is the same copy as a static page you can deploy on Vercel/GitHub Pages.)

## Hero
**Headline:** Checks every PR's Vercel preview against its Figma frame.
**Subhead:** framedrift runs in CI when Vercel finishes a preview, diffs the page with the Figma frame it was built from, and posts one PR comment naming the layers that drifted. No extension to remember to open.
**Primary CTA:** Add the GitHub Action → (links to README#github-action)
**Secondary CTA:** Try it: `npx framedrift demo` (no Figma token), then `npx framedrift compare --url … --figma …`

## Problem
Design review happens in screenshots, after merge, if at all. "The button is 4px taller than in Figma" gets found by the designer two sprints later — or by nobody. Visual regression tools compare the app with *itself*; they can't tell you it never matched the design in the first place.

## Why not a browser extension?
Pixelay, DualCheck, inspecta and OverlayQA ($8–39/month) overlay Figma on a live page through a browser extension or Figma plugin. They work when someone opens them. framedrift runs on every preview deployment automatically and puts the result in the PR. (Comparison table on the page; based on the tools' own sites, Oct 2026.)

## How it works (3 steps)
1. **Map pages to frames.** A `.framedrift.json` in the repo, or a `framedrift: /login <figma link>` line in the PR description.
2. **Vercel deploys a preview.** The Action renders each Figma frame and captures the preview at the same size in headless Chromium.
3. **Get one PR comment.** Mismatch per page, the regions that differ with Figma layer names ("Button / Sign in (Variant=Primary)"), and a full report with side-by-side, overlay, swipe and diff views.

## Features
- Works with any URL — previews, staging, localhost (CLI)
- Element-level checks with `selector` (compare one component)
- Hide cookie banners and live data; wait for selectors
- Vercel Deployment Protection bypass
- Self-contained HTML report you can download and share
- No framedrift server: your Figma token and code never leave your CI

## Pricing
- **Free (MIT open source):** CLI with unlimited compares; Action and `run` up to 3 frames per run; report-only PR comments.
- **Pro — $12/month per repo:** unlimited frames, and the Action can fail the check so drift blocks merge. Billed through Polar; cancel anytime. (Button reads "Pro checkout opens soon" until Polar is set up.)

Honest note shown on the page: "framedrift is MIT-licensed. Pro is an honor-system license for teams — the check is in the open source code. Pay if it saves you review time."

## FAQ
- **Will it ever be 0%?** No — browsers and Figma rasterize text differently. Start with a 2% threshold and tune from real PRs.
- **Does it need Figma Dev Mode / a paid seat?** It needs a personal access token with read access to the file.
- **Netlify / other hosts?** Pass `preview-url` to the Action, or use the CLI anywhere.
- **What leaves my CI?** Calls to Figma's API, your preview, GitHub's API, and for Pro a license-key check to Polar. Nothing else.

## Footer
Built by an AI agent (Hustler) and its owner, Sherzod. Not affiliated with Figma or Vercel.
