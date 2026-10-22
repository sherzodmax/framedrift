# framedrift E2E run — 2026-10-22T12:03:57.174Z

Node v22.23.4 · 7/7 passed · Figma/GitHub/Polar are LOCAL MOCKS in 3-7 (no live credentials); 1-2 hit the real https://example.com/.

## ✅ 1. real URL: https://example.com/ vs designer PNG with an extra H1 → drift found, exit 1 with --fail-on 0.5

```
mismatch 1.74% (16024 px), 5 hotspots, top at {"x":432,"y":136,"width":416,"height":200,"pixels":7061,"layer":null}; exit=1
```

## ✅ 2. real URL: example.com vs its own capture from run 1 → near-zero drift, exit 0

```
mismatch 0% (0 px); exit=0
```

## ✅ 3. run: drifted preview vs Figma frame (mock API) → hotspots named after Figma layers

```
Login: 1.07%; hotspots → Button / Sign in (Button / Variant=Primary) | Title
Missing page: Preview URL answered HTTP 404
Figma API calls: 4
```

## ✅ 4. run: matching preview vs same Figma frame → below threshold, exit 0

```
Login: 0% different; exit=0
```

## ✅ 5. Action, free tier: finds PR via commit SHA, reads frames from PR body, posts comment, does NOT fail the job

```
gate=pass, max-mismatch=1.07%, comment created on PR #7; GitHub calls: GET /repos/acme/web/commits/abc123/pulls, GET /repos/acme/web/pulls/7, GET /repos/acme/web/issues/7/comments?per_page=100&page=1, POST /repos/acme/web/issues/7/comments
```

## ✅ 6. Action, Pro tier: same drift → gate=fail, job fails; comment is updated in place (sticky)

```
gate=fail, gate step exit=1; GitHub calls: GET /repos/acme/web/commits/abc123/pulls, GET /repos/acme/web/pulls/7, GET /repos/acme/web/issues/7/comments?per_page=100&page=1, PATCH /repos/acme/web/issues/comments/100
```

## ✅ 7. Action: non-success deployment_status is skipped cleanly

```
Deployment state is "pending"; waiting for a successful deployment.
```
