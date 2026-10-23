# Changelog

## 0.1.0 — unreleased

First version.

- `framedrift compare`: capture any URL with headless Chromium and diff it against a Figma frame (or a local PNG). Self-contained HTML report (side-by-side, overlay, swipe, diff), `results.json`, `summary.md`.
- Hotspots: differing regions are grouped and labelled with the Figma layer they fall on ("Button / Sign in (Button / Variant=Primary)").
- `framedrift run`: many frames from `.framedrift.json` and/or `framedrift:` lines in the PR description.
- GitHub Action (composite): runs on `deployment_status` from Vercel, uploads the report as an artifact, posts and updates one PR comment.
- Vercel Deployment Protection bypass support. The bypass secret and `--header` values are added only to requests for the preview base URL's origin (scheme, host and port), including each same-origin redirect hop. They are not added to third-party requests or to cross-origin redirect targets. Frame paths must stay on that origin (`/login`; absolute URLs to other hosts are rejected). Limits: service workers are blocked while headers are set, and a same-origin redirect inside an iframe is followed by framedrift and served under the original URL.
- Any failed comparison (preview HTTP error, Figma error, rejected frame) fails the run: `framedrift run` exits 3 and the Action gate is `error`, even if other frames were clean.
- Action input `figma-files`: allowlist of Figma file keys a repo may render.
- framedrift Pro via Polar license keys: unlimited frames and failing the check. Until Polar is configured, every run is Free and keys are ignored (logged, never an error).
- `framedrift demo`: full comparison on a built-in fixture page, no Figma token or network needed.
- Clear one-line errors for unreachable previews (connection refused, DNS, timeouts), missing selectors, Figma 403/404 and long rate-limit waits (fails fast instead of sleeping in CI).
- Usage errors exit 2: missing Figma token, invalid `--fail-on` / `--threshold` / `--scale` / `--viewport`, missing config file. Invalid Action inputs fail the step with an explanation.
- `.framedrift.json` frames can use a local `design` PNG (resolved relative to the config file).
- PR comment treats frame names, paths, Figma layer text and errors as plain text (no table breaks, @mentions, HTML or links), only links http(s) URLs, and hides userinfo and secret-looking query values in preview URLs.
- `failOn` / `threshold` in `.framedrift.json` are validated (a typo is a config error, exit 2). Precedence: frame > CLI flag / Action input > `defaults` > built-in.
