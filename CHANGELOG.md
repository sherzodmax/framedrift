# Changelog

## 0.1.0 — unreleased

First version.

- `framedrift compare`: capture any URL with headless Chromium and diff it against a Figma frame (or a local PNG). Self-contained HTML report (side-by-side, overlay, swipe, diff), `results.json`, `summary.md`.
- Hotspots: differing regions are grouped and labelled with the Figma layer they fall on ("Button / Sign in (Button / Variant=Primary)").
- `framedrift run`: many frames from `.framedrift.json` and/or `framedrift:` lines in the PR description.
- GitHub Action (composite): runs on `deployment_status` from Vercel, uploads the report as an artifact, posts and updates one PR comment.
- Vercel Deployment Protection bypass support.
- framedrift Pro via Polar license keys: unlimited frames and failing the check.
