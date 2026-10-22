# Troubleshooting

Every error framedrift prints is one line. This page lists the common ones and what to do.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Compared; nothing above `--fail-on` (or no `--fail-on` given) |
| 1 | At least one frame differs by more than `--fail-on` % |
| 2 | Usage or config problem — nothing was compared (missing token, bad option, missing file) |
| 3 | Runtime problem — e.g. the preview could not be reached, or every frame errored |

In `framedrift run` and the Action, a frame that errors is shown as ❌ in the report; the run only exits 3 if **every** frame errored.

## Figma

**`a Figma token is required`** — set `FIGMA_TOKEN` (or `--figma-token`). Create one in Figma → Settings → Security → Personal access tokens with *File content: Read*. In the Action, save it as the `FIGMA_TOKEN` repository secret and pass `figma-token: ${{ secrets.FIGMA_TOKEN }}`. Frames that use a local `design` PNG don't need a token.

**`Figma API 403 … lacks the needed scope, or cannot access this file`** — the token's owner can't open the file, or the token lacks *File content: Read*. Open the link in a browser while logged in as the token's owner.

**`Figma API 404`** — wrong file key, or the file is in a team the token can't see.

**`Figma link has no node-id`** — you copied the file link. Select the frame, right-click → *Copy/Paste as → Copy link to selection*.

**`has no bounds; link a FRAME, COMPONENT or SECTION`** — the link points at a page (canvas) or a group without bounds.

**`Figma rate limit hit (429) and Figma asked to wait 7200s`** — Figma's REST quota depends on the plan and seat of the token's owner, and some endpoints have low limits for View/Collab seats. framedrift retries short waits (up to 4 times) but gives up instead of sleeping for minutes in CI. Use a token from a Full or Dev seat, or run fewer frames per PR. framedrift makes 2 Figma calls per frame.

## Preview

**`Could not reach preview … ERR_CONNECTION_REFUSED`** — nothing is listening at that URL. For localhost, start your dev server first.

**`… ERR_NAME_NOT_RESOLVED`** — the host doesn't exist (typo, or the preview deployment hasn't been created yet).

**`Preview URL answered HTTP 401`/`403`** — Vercel Deployment Protection. Create a *Protection Bypass for Automation* secret (Vercel → Project → Settings → Deployment Protection) and pass it with `--vercel-bypass` / `VERCEL_AUTOMATION_BYPASS_SECRET` / the `vercel-bypass-secret` input.

**`did not finish loading in time`** — the page took more than 45 s to fire `load`. Check for a hanging request (analytics, a websocket) on the preview.

**`--wait-for ".x" did not appear`** / **`--selector ".x" did not appear`** — the selector never matched within 15 s.

## Results

**Size mismatch** (`size differs` in the comment, a yellow note in the report) — the captured page or element isn't the frame's size. framedrift sets the viewport to the frame's width and height, so this usually means `--viewport` overrides it, or `--selector` captured an element that is a different size from the frame. Missing area is drawn magenta and counts as different; extra page area beyond the frame is ignored. A page that is simply longer than the frame is not a mismatch.

**Always a few % different, even when it looks right** — text anti-aliasing differs between Figma and Chrome, and fonts that aren't installed on the CI machine fall back. Load web fonts on the page, raise `--threshold` (per-pixel tolerance), or raise `fail-on`.

**Real data vs. placeholder content** — hide it with `--hide`, compare one component with `--selector`, or point the frame at a fixture route.
