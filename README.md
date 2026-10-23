# framedrift

**Checks every PR's Vercel preview against its Figma frame, in CI.** When Vercel finishes a preview deployment, framedrift opens the page in headless Chrome, renders the Figma frame it was built from, diffs the two, and posts one comment on the pull request listing what drifted — by Figma layer name.

![framedrift report: Figma frame vs preview with two numbered differences, the Sign in button and the title](docs/report-example.png)

<sub>Screenshot from framedrift's own end-to-end test (a fixture design vs. a page with a taller, re-coloured button and changed title). Not a customer project.</sub>

- **GitHub Action** — runs on Vercel's `deployment_status` event, posts one PR comment (updated on every push), uploads the full visual report.
- **CLI** — `npx framedrift compare --url … --figma …` against any URL: preview, staging, localhost.
- **Names what drifted** — each differing region is matched to the Figma layer it falls on, e.g. `Button / Sign in (Button / Variant=Primary)`.
- **Report** — side-by-side, overlay, swipe and diff views in a single offline HTML file.
- **Nothing to host.** Your Figma token and preview stay in your CI. framedrift has no server; the only network calls are to Figma, your preview, GitHub, and (Pro only) a license check.

Try it without a Figma token (runs on a built-in fixture page; needs Chrome or `npx playwright install chromium`):

```bash
npx framedrift demo && open framedrift-report/index.html
```

> Status: **0.1.0, early.** The CLI and Action are tested end-to-end against real pages and a mocked Figma API. Testing against the live Figma API with real projects is the next step — please open an issue if something looks off.

## Why another design-QA tool?

The design-QA tools I could find — [Pixelay](https://hypermatic.com/pixelay), [DualCheck](https://dualcheck.io), [inspecta](https://inspecta.design), [OverlayQA](https://overlayqa.com) — work through a browser extension or Figma plugin: someone opens them on a live page and checks it. They're good at that (OverlayQA also files issues to GitHub, Jira and others). As far as I can tell from their sites (Oct 2026), none of them runs as an automatic check on each pull request. framedrift is for the part that gets skipped: it runs automatically on **every PR**, against the actual preview deployment, and puts the result where the code review already happens.

| | framedrift | Extension / plugin tools (Pixelay, DualCheck, inspecta, OverlayQA) | CI visual testing (Chromatic, Percy) |
|---|---|---|---|
| Compares against | the Figma frame | the Figma frame | an earlier screenshot of your app |
| Runs | automatically on every PR | when someone opens it | automatically on every PR |
| Where results show up | PR comment + report artifact | in the browser / Figma / their app | their dashboard + PR status |
| Price (as listed on their sites, Oct 2026) | free (MIT), Pro $12/mo per repo | ~$8–39/mo | free tiers; paid plans ~$149+/mo |

Extensions are better for interactive, pixel-by-pixel inspection by a designer; Chromatic/Percy are better at catching regressions against your own baseline. framedrift answers a narrower question: *does this PR still look like the design?*

## Quick start (CLI)

```bash
# Node 22+. Uses an installed Chrome/Chromium, or: npx playwright install chromium
export FIGMA_TOKEN=figd_...            # Figma → Settings → Security → Personal access tokens (File content: Read)
npx framedrift compare \
  --url https://my-app-git-feature-x.vercel.app/login \
  --figma "https://www.figma.com/design/AbC123/App?node-id=20-1"
open framedrift-report/index.html
```

The Figma link must point at a frame — in Figma right-click it → **Copy/Paste as → Copy link to selection**. The page is captured at the frame's width (and height, or `--viewport-height` for long pages), at `--scale` 1 by default.

No Figma file handy? Compare against any PNG:

```bash
npx framedrift compare --url https://example.com --design ./mockup.png --fail-on 1
```

### Useful options

| Option | What it does |
|---|---|
| `--hide ".cookie-banner"` | Hide dynamic elements before capture (repeatable) |
| `--wait-for "main"` | Wait for a selector before capture |
| `--selector "#hero"` | Compare one element/component instead of the page |
| `--viewport 1440x900` | Override the viewport (default: frame size) |
| `--threshold 0.1` | Per-pixel color tolerance (0–1). Raise it if anti-aliasing is noisy |
| `--fail-on 2` | Exit code 1 when more than 2% of pixels differ |
| `--vercel-bypass $SECRET` | Vercel Deployment Protection bypass (or `VERCEL_AUTOMATION_BYPASS_SECRET`) |
| `--preview-host preview.example.com` | Extra host the bypass secret may go to (repeatable; `*.vercel.app` is always allowed; add `localhost` to send it to a local server) |
| `--header "Cookie: …"` | Extra request headers (repeatable). Like the bypass secret, they are sent only to the preview's own origin |
| `--json` | Machine-readable result on stdout |

Exit codes: `0` ok · `1` drift above `--fail-on` · `2` usage/config error (missing token, bad option or config values) · `3` runtime error: any frame failed to compare (preview unreachable or HTTP 4xx/5xx, Figma API error), even if other frames were clean.

Troubleshooting common errors (unreachable preview, 403 from Figma, rate limits, size mismatches): [docs/troubleshooting.md](docs/troubleshooting.md).

## Many pages: `.framedrift.json`

```json
{
  "defaults": { "failOn": 2, "hide": [".cookie-banner"], "waitFor": "main" },
  "frames": [
    { "name": "Login",   "path": "/login",   "figma": "https://www.figma.com/design/AbC123/App?node-id=20-1" },
    { "name": "Pricing", "path": "/pricing", "figma": "https://www.figma.com/design/AbC123/App?node-id=31-7", "viewportHeight": 900 },
    { "name": "Button",  "path": "/storybook/button", "selector": "#root button", "figma": "https://www.figma.com/design/AbC123/App?node-id=10-1", "failOn": 1 }
  ]
}
```

```bash
npx framedrift run --base-url https://my-app-git-feature-x.vercel.app
```

Per-frame keys: `name`, `path`, `figma` or `design` (a PNG path relative to the config file), `selector`, `hide`, `waitFor`, `delayMs`, `viewportHeight`, `scale`, `threshold`, `failOn`, `colorScheme`.

`path` is a path on the preview (`/login`); it can't point at another host. `failOn` (0–100) and `threshold` (0–1) must be numbers. Precedence, most specific first: the frame's own value, then `--fail-on` / `--threshold` (or the Action inputs), then `defaults`, then 2 / 0.1.

You can also add frames **in the PR description** — handy for one-off pages:

```
framedrift: /onboarding https://www.figma.com/design/AbC123/App?node-id=40-2
/settings -> https://www.figma.com/design/AbC123/App?node-id=41-9
```

Only lines that start with `framedrift:` or a `/path` are read.

## GitHub Action (Vercel previews)

`.github/workflows/framedrift.yml` (full version with comments: [examples/.github/workflows/framedrift.yml](examples/.github/workflows/framedrift.yml)):

```yaml
name: framedrift
on: deployment_status
permissions:
  contents: read
  pull-requests: write
  deployments: read
jobs:
  design-drift:
    if: github.event.deployment_status.state == 'success' && !contains(github.event.deployment.environment, 'Production')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.event.deployment.sha }}" }
      - uses: OWNER/framedrift@v0
        with:
          figma-token: ${{ secrets.FIGMA_TOKEN }}
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}  # only if Deployment Protection is on
          license-key: ${{ secrets.FRAMEDRIFT_LICENSE_KEY }}                    # optional, Pro
```

The Vercel GitHub integration creates the `deployment_status` events; framedrift reads the preview URL from them, finds the PR for the deployed commit, compares every configured frame, uploads the report as an artifact, and posts/updates a single comment:

> ### framedrift · design drift report
> | | Frame | Page | Different | Top differences |
> |---|---|---|---|---|
> | ⚠️ | Login | /login | **1.07%** | Button / Sign in (Button / Variant=Primary); Title “Welcome back” |

(From the end-to-end test fixture.) Other deploy providers (Netlify, your own staging): pass `preview-url`, but only a URL your deploy provider reports, from a trusted trigger; read [Security](#security) first.

Inputs: `figma-token` (required), `github-token`, `preview-url`, `config` (default `.framedrift.json`; a path you set that doesn't exist fails the check), `fail-on` (config `defaults`, else `2`), `threshold` (config `defaults`, else `0.1`), `figma-files`, `license-key`, `vercel-bypass-secret`, `preview-hosts` (extra hosts the bypass secret may go to; `*.vercel.app` is always allowed), `allow-loopback-preview` (`false`; CI smoke tests only), `comment` (`true`). Outputs: `max-mismatch`, `report-dir`.

**Set `figma-files`** to the file keys your repo may render (the `AbC123` part of the Figma URL). PR descriptions are written by PR authors; without the allowlist, a frame link can point at any file your `figma-token` can read, and its render ends up in the report. Frames linking other files are reported as errors and never fetched.

**The check fails** (on any tier) if any comparison fails: the preview answered 4xx/5xx, Figma returned an error, or a frame was rejected. It also fails when there is nothing to compare (no frames in the config and none in the PR description), so a typo'd `config` path can't turn into a silent green check. A `framedrift:` line in the PR description that can't be used (e.g. `//host/path`) is logged as a warning. Drift above `fail-on` fails the check on Pro only.

**Deployment Protection:** if your previews need a Vercel login, create a *Protection Bypass for Automation* secret in Vercel (Project → Settings → Deployment Protection) and store it as `VERCEL_AUTOMATION_BYPASS_SECRET`. framedrift adds it only to requests for the preview base URL's origin, including every same-origin redirect hop (for any method: a non-GET request answered `303`, or a `POST` answered `301`/`302`, continues as a `GET`, as browsers do; `307`/`308` keep the method and body). Fonts, analytics, CDNs and redirect targets on other hosts never get it. The secret is only sent when the preview host is `*.vercel.app` or listed in `preview-hosts` (for a custom preview domain); any other host fails the check and gets nothing. Service workers are blocked while it is set (their requests can't be scoped).

### Security

framedrift loads your preview in a real browser on the CI runner and, with Deployment Protection, sends the bypass secret to it. Keep the inputs trustworthy:

- **The preview URL must come only from your deploy provider.** The documented trigger is `on: deployment_status` from the Vercel GitHub integration: Vercel picks the preview host, a PR author can't. Never build `preview-url` from PR data (title, description, branch name, comments).
- **Don't run framedrift on `pull_request_target`** (or on `workflow_run` / `issue_comment` with PR-supplied values). Those triggers run with your secrets on attacker-controlled input; the bypass secret goes to whatever `preview-url` is.
- **Use GitHub-hosted runners for untrusted PRs.** The preview is built from the PR's code, and its page can make the browser request any host (redirects, `fetch`, images). On a GitHub-hosted runner that reaches only the internet. On a self-hosted runner it can reach your internal network, and the screenshot ends up in the report.
- **Guards in the code:** the preview base URL can't be a loopback, link-local or cloud-metadata address (`localhost`, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `fe80::/10`, `169.254.169.254`, `metadata.google.internal`, …; loopback only with `allow-loopback-preview: 'true'` for CI smoke tests, or on the CLI, where you typed the URL). With a bypass secret set, the preview host must match `*.vercel.app` or `preview-hosts`. Frame paths can't leave the preview origin. These checks work on the URL, not on DNS: a public host name that resolves to an internal address is not caught, which is why the runner advice above matters.
- `preview-hosts` is an Action input (it lives in your workflow on the default branch), not a `.framedrift.json` setting: `.framedrift.json` is read from the PR's commit, so a PR could edit it.
- Secrets in URLs (userinfo, `x-vercel-protection-bypass`, `token`, `_vercel_share`, … query values) and the bypass / `--header` values are redacted from the PR comment, all report files, the step summary and the log.

## Free and Pro

framedrift is **MIT-licensed open source**. Pro is a convenience license for teams, not DRM — the code that checks it is right here, and we'd rather you pay because it's worth it.

| | Free | Pro — $12/month per repo |
|---|---|---|
| CLI `compare` (any number of runs, `--fail-on` exit codes) | ✓ | ✓ |
| Frames per `run` / Action run | up to 3 | unlimited |
| PR comment + HTML report | ✓ | ✓ |
| Action can **fail the check** (required status check) | report only | ✓ |
| Support | GitHub issues | GitHub issues, priority |

Pro keys are sold through Polar. One key per repository; that's on the honor system, since nothing in the code ties a key to a repo. The license check **fails open**: on any network error talking to the license server (DNS failure, blocked egress, TLS error, timeout) or a 5xx answer, framedrift runs as Pro for that run rather than breaking your CI; an invalid, revoked or expired key is Free. So the check is a convenience, not an authorization control: it decides how many frames run and whether drift can fail the check, and nothing else. `FRAMEDRIFT_POLAR_API` (env) overrides the license server URL; it exists for framedrift's own tests and self-hosting, and pointing it at a dead address simply makes every key Pro, which is the same fail-open behaviour as an outage.

> Pre-launch note: Pro checkout isn't open yet. Until it is, every run is Free tier and a license key is ignored (the CLI says so in its log).

## How it works

1. Figma REST API: `GET /v1/files/:key/nodes` (layer tree, for labelling) and `GET /v1/images/:key` (PNG render at the frame's bounds).
2. Playwright (Chromium) loads the page at the frame's size, waits for fonts and network idle, disables animations and carets, hides what you asked it to.
3. pixelmatch compares the images; differing pixels are grouped into regions, and each region is matched to the smallest Figma layers it overlaps.

### Known limitations

- **Fonts:** a font that isn't installed on the CI machine renders differently. Load web fonts on the page (they are waited for), or raise `--threshold`.
- **Content:** real data vs. lorem ipsum in the design shows up as drift. Use `--hide`, `--selector`, or a fixture route.
- **Figma vs. browser rendering** never matches to exactly 0% (anti-aliasing, text rasterization). The default `fail-on` of 2% is a starting point, not a measured value — we have not yet run framedrift against enough real projects to recommend a number. Look at the report for a few PRs and tune it.
- **Rate limits:** Figma limits API calls per token; framedrift uses 2 calls per frame, retries short waits, and fails fast (instead of sleeping in CI) if Figma asks it to wait more than 90 seconds.
- Figma variables, prototypes and interactive states are not compared — only the frame as drawn.

## Development

```bash
npm ci
npm test          # unit + edge-case tests (no browser, no network)
npm run e2e       # end-to-end: real Chromium, real pages, mocked Figma/GitHub/Polar APIs
npm run demo      # the same demo as `npx framedrift demo`
```

## About

Built by Hustler, an AI agent run by its owner, Sherzod, who reviews releases and issues. Not affiliated with Figma, Inc. or Vercel Inc.
