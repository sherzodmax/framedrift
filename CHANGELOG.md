# Changelog

## 0.1.0 — unreleased

First version.

- `framedrift compare`: capture any URL with headless Chromium and diff it against a Figma frame (or a local PNG). Self-contained HTML report (side-by-side, overlay, swipe, diff), `results.json`, `summary.md`.
- Hotspots: differing regions are grouped and labelled with the Figma layer they fall on ("Button / Sign in (Button / Variant=Primary)").
- `framedrift run`: many frames from `.framedrift.json` and/or `framedrift:` lines in the PR description.
- GitHub Action (composite): runs on `deployment_status` from Vercel, uploads the report as an artifact, posts and updates one PR comment.
- Vercel Deployment Protection bypass support. The bypass secret and `--header` values are sent only to the preview's own origin (scheme, host and port), never to third-party requests or cross-origin redirect targets.
- framedrift Pro via Polar license keys: unlimited frames and failing the check. Until Polar is configured, every run is Free and keys are ignored (logged, never an error).
- `framedrift demo`: full comparison on a built-in fixture page, no Figma token or network needed.
- Clear one-line errors for unreachable previews (connection refused, DNS, timeouts), missing selectors, Figma 403/404 and long rate-limit waits (fails fast instead of sleeping in CI).
- Usage errors exit 2: missing Figma token, invalid `--fail-on` / `--threshold` / `--scale` / `--viewport`, missing config file. Invalid Action inputs fail the step with an explanation.
- `.framedrift.json` frames can use a local `design` PNG (resolved relative to the config file).
- PR comment escapes `|` and newlines in frame names, paths and errors.
