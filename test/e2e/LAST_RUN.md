# framedrift E2E run — 2026-10-29T20:13:07.521Z

Node v22.23.4 · 16/16 passed · Figma/GitHub/Polar are LOCAL MOCKS in 3-16 (5-14 use a local preview server) (no live credentials); 1-2 hit the real https://example.com/.

## ✅ 1. real URL: https://example.com/ vs designer PNG with an extra H1 → drift found, exit 1 with --fail-on 0.5

```
mismatch 1.71% (15794 px), 5 hotspots, top at {"x":432,"y":136,"width":416,"height":200,"pixels":7061,"layer":null}; exit=1
```

## ✅ 2. real URL: example.com vs its own capture from run 1 → near-zero drift, exit 0

```
mismatch 0% (0 px); exit=0
```

## ✅ 3. run: drifted preview vs Figma frame (mock API) → hotspots named after Figma layers; the 404 frame makes the run exit 3

```
Login: 1.07%; hotspots → Button / Sign in (Button / Variant=Primary) | Title
Missing page: Preview URL answered HTTP 404
Figma API calls: 4
```

## ✅ 4. run: matching preview vs same Figma frame → below threshold, exit 0

```
Login: 0% different; exit=0
```

## ✅ 5. unreachable preview (closed port): compare exits 3 with a one-line, actionable error

```
browser: Playwright-managed Chromium
framedrift: Could not reach preview http://127.0.0.1:35279/: ERR_CONNECTION_REFUSED (nothing is listening there — is the preview/dev server running?)
```

## ✅ 6. unreachable preview in `run`: every frame errors → exit 3, report still written with the error row

```
| ❌ | Login | /login | — | Could not reach preview http​://127.0.0.1:35279/login: ERR\_CONNECTION\_REFUSED (nothing is listening there — is the preview/dev server running?) |
```

## ✅ 7. Figma rate limit with a long Retry-After: fails fast (no sleeping) with a clear message

```
exit=3 after 547 ms
error: Figma rate limit hit (429) and Figma asked to wait 7200s (limit type: low). Your Figma plan/seat has a low REST API quota for this endpoint; try again later or use a token from a Full/Dev seat.
```

## ✅ 8. Figma rate limit with Retry-After: 1 → retried once, comparison completes

```
Figma API 429 on /v1/files/RATELIMIT1SEC/nodes; retrying in 1s (attempt 1/4)
    0% different, 0 region(s)
```

## ✅ 9. mismatched sizes: --viewport narrower than the frame → size mismatch reported, missing area counted

```
design 390×844 vs page 300×844: 22.92% different, sizeMismatch=true
```

## ✅ 10. `framedrift demo`: no token, no network → 2 regions named after the fixture layers

```
1.07% of pixels differ (3,521 px)
  1. Button / Sign in (Button / Variant=Primary) @ 24,416 344×40 — 2857 px
  2. Title @ 168,64 80×32 — 664 px
report: $TMPDIR/framedrift-e2e-l4zH03/demo/index.html
```

## ✅ 11. Free tier: 5 frames → 3 compared, note links to a real upgrade URL (no placeholder)

```
> Free tier compares up to 3 frames per run; 2 more were skipped. framedrift Pro ($12/month per repo) removes the limit: https://buy.polar.sh/polar_cl_nKj8a32u9m2Rk2An3VNLHUlv7Z6deSvuAhXWH3pAGyc
```

## ✅ 12. Action, free tier: finds PR via commit SHA, reads frames from PR body, posts comment, does NOT fail the job

```
gate=pass, max-mismatch=1.07%, comment created on PR #7; GitHub calls: GET /repos/acme/web/commits/abc123/pulls, GET /repos/acme/web/pulls/7, GET /repos/acme/web/issues/7/comments?per_page=100&page=1, POST /repos/acme/web/issues/7/comments
```

## ✅ 13. Action, Pro tier: same drift → gate=fail, job fails; comment is updated in place (sticky)

```
gate=fail, gate step exit=1; GitHub calls: GET /repos/acme/web/commits/abc123/pulls, GET /repos/acme/web/pulls/7, GET /repos/acme/web/issues/7/comments?per_page=100&page=1, GET /user, POST /graphql, PATCH /repos/acme/web/issues/comments/100
```

## ✅ 14. Action: non-success deployment_status is skipped cleanly

```
Deployment state is "pending"; waiting for a successful deployment.
```

## ✅ 15. Action: empty figma-token → step fails with a "create the FIGMA_TOKEN secret" error, no crash

```
::error::framedrift: figma-token is empty. Create a read-only Figma personal access token, save it as the FIGMA_TOKEN repository secret, and pass `figma-token: ${{ secrets.FIGMA_TOKEN }}`.
```

## ✅ 16. Action: invalid fail-on input → clear error instead of silently never failing

```
::error::framedrift: invalid fail-on "two" or threshold "" (fail-on: percent 0..100, threshold: 0..1).
```
