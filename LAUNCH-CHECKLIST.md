# framedrift — launch checklist

State on 2026-10-22: **launch-ready, nothing published.** No GitHub repo, no npm package, no Polar product exists yet. Everything below needs an account or a credential only Sherzod can create. QA evidence: `../qa-proof/framedrift/QA.md`.

Rough time: 1.5–2.5 hours, most of it account setup and one real-world test.

## What you need

| # | Account / credential | Why | Where it ends up |
|---|---|---|---|
| A | GitHub account with 2FA | Public repo + Action + Marketplace listing | `gh auth login` on your machine |
| B | npm account with 2FA | `npm publish` | `npm login` on your machine (never in this repo) |
| C | Figma personal access token (*File content: Read*) | One live test against a real frame before launch | `FIGMA_TOKEN` env var in your shell / repo secret in a test repo. Never commit it. |
| D | A Vercel project with PR previews (yours) | One live end-to-end test of the Action | Repo secrets `FIGMA_TOKEN` (+ `VERCEL_AUTOMATION_BYPASS_SECRET` if Deployment Protection is on) |
| E | Polar organization + Stripe payout | Selling Pro at $12/month per repo | Org ID + checkout URL go into the code via the script below (both are public values) |

You can launch the free version without E. Until Polar is configured, every run is Free tier, license keys are ignored with a log line, and the landing page's Pro button reads "Pro checkout opens soon".

Also decide: the Show HN text says "I'm a product designer" and "most of the code was written by an AI agent I run". Keep, edit or remove. And confirm your employment agreement allows a side project in design-QA tooling.

## 1. Name check (2 min, right before publishing)

On 2026-10-22: `framedrift` → **available** on npm (registry 404, no search hits); github.com/framedrift → available; `framedrift.com` is a parked domain **for sale** (not needed — the landing page can live on Vercel/GitHub Pages).

```bash
npm view framedrift name 2>&1 | grep -q E404 && echo "still free"
```

If it's taken by then, use one of these (all free on 2026-10-22): `@<your-npm-user>/framedrift` (scoped, always available to you), `framedrift-cli`, `figdrift`, `previewdrift`. Change `name` in `package.json`, the `npx framedrift` lines in README/landing/Show HN, and keep the binary name `framedrift`.

## 2. Fill in the placeholders (1 command)

All placeholders are listed in `src/launch-config.js`. One script fills them in everywhere (README, landing page, package.json, example workflow, Show HN draft, code):

```bash
cd devtool
node scripts/launch-config.mjs --owner <github-user-or-org> --dry-run   # preview
node scripts/launch-config.mjs --owner <github-user-or-org>             # now
# later, after step 6 (Polar):
node scripts/launch-config.mjs --checkout <polar-checkout-url> --polar-org <polar-org-uuid>
```

It refuses bad values, is safe to re-run, and prints anything still left as a placeholder.

## 3. One real-world test (do not skip)

framedrift has only been tested against a **mocked** Figma API (shapes from Figma's docs) and real pages. Before telling anyone about it:

```bash
cd devtool && npm ci
FIGMA_TOKEN=figd_xxx node bin/framedrift.js compare \
  --url https://<a-real-preview-or-site>/<page> \
  --figma '<Copy link to selection of the matching frame>'
open framedrift-report/index.html
```

Check: the Figma render looks right, hotspots are labelled with your layer names, the % is plausible. If not, send the report folder to Hustler (it contains screenshots of your page; no token).

## 4. GitHub repo + Action

`action.yml` must be at a repo root, so `devtool/` becomes its own repository. Don't push `/workspace/hustler-build` (it has no remote on purpose).

```bash
cp -r devtool ~/framedrift && cd ~/framedrift && rm -rf node_modules
git init -b main && git add -A && git commit -m "framedrift 0.1.0"
gh repo create <owner>/framedrift --public --source . --push
git tag v0.1.0 && git tag v0 && git push origin v0.1.0 v0
```

- Check the **ci** workflow goes green (`.github/workflows/ci.yml`: unit + E2E on Node 20/22, demo, pack, and an Action smoke test using `uses: ./`). It hasn't run on GitHub yet; the steps were simulated locally.
- **Live Action test** in a repo with Vercel previews: add secret `FIGMA_TOKEN`, copy `examples/.github/workflows/framedrift.yml` (replace `OWNER` if you skipped step 2) and `examples/.framedrift.json` (your frame links), open a PR, check the comment + artifact. This flow is only tested with mocked GitHub/Vercel events.
- **Marketplace:** Releases → Draft release v0.1.0 → tick "Publish this Action to the GitHub Marketplace" (2FA + Marketplace agreement). Category: Continuous integration. GitHub requires the `name` in `action.yml` to be unique on the Marketplace; if "framedrift — Figma vs preview visual diff" is rejected, shorten it.

## 5. npm

```bash
cd ~/framedrift
npm login                     # your account, 2FA on
npm test && npm run e2e       # must be green (E2E needs Chrome; checks 1-2 fetch example.com)
npm publish                   # publishConfig.access=public; prepublishOnly runs npm test
npx framedrift@latest demo    # smoke test from the registry
```

Optional but recommended later: publish from GitHub Actions with `npm publish --provenance` (needs an npm automation token as a repo secret).

## 6. Polar (Pro, $12/month per repo) — can be after launch

1. polar.sh → create organization → connect Stripe payouts (KYC).
2. Product **framedrift Pro**, recurring **$12/month**. Benefit: **License keys** (prefix e.g. `FRAMEDRIFT`, no activation limit; description: "one key per repository").
3. Copy the **Organization ID** and the product's **checkout link**, then:
   `node scripts/launch-config.mjs --checkout <url> --polar-org <uuid>`
4. Test: buy your own product with a 100% discount code, then
   `FRAMEDRIFT_LICENSE_KEY=<key> node bin/framedrift.js run --base-url https://example.com --config examples/.framedrift.json`
   → first log line must be `tier: pro (valid license)`. A wrong key must log `tier: free (license key not found…)`. (The example config's Figma links will then error; that's expected.) The license code is only tested against a mocked Polar API.
5. Commit, `npm version patch && npm publish`, tag `v0.1.1`, move `v0`: `git tag -f v0 && git push -f origin v0` (standard for Actions' floating major tag).

## 7. Landing page + Show HN (manual)

- Deploy `landing/` (static: `index.html` + `report-example.png`) to Vercel or GitHub Pages.
- Edit and post `SHOW_HN_DRAFT.md` **yourself** (HN forbids automated submissions), only after steps 3–5. Re-check the competitor sentence that day.

## What is already done

- CLI (`compare`, `run`, `demo`), GitHub Action, Polar licensing that degrades to Free when unconfigured or fails open to Pro if Polar is down.
- Tests: `npm test` (38 unit/edge-case tests) and `npm run e2e` (16 end-to-end checks) — counts and logs in `../qa-proof/framedrift/`.
- `npm pack` tarball installed into a clean temp project and run (`--version`, `--help`, `demo`, `compare` against a local page, library import).
- README (CI-first positioning, honest comparison), `docs/troubleshooting.md`, landing page, Show HN draft, LICENSE (MIT, © Sherzod), CHANGELOG, CI workflow, example workflow + config, demo fixture.
