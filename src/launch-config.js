// LAUNCH CONFIG — the only values that change when framedrift goes public.
// All three are set (GitHub repo 2026-10-22, Polar 2026-10-24; see LAUNCH-CHECKLIST.md).
// The code works without them: no Polar org → every run is Free tier; no checkout URL → the
// upgrade hint points at the README instead of a broken link.
//
// Environment overrides exist for testing and self-hosting; end users never need to set them.

/** GitHub "owner/repo". */
export const REPO_SLUG = 'sherzodmax/framedrift';

/** Polar checkout link for framedrift Pro (Polar → Products → Checkout link). */
export const POLAR_CHECKOUT_URL = process.env.FRAMEDRIFT_CHECKOUT_URL || 'https://buy.polar.sh/polar_cl_nKj8a32u9m2Rk2An3VNLHUlv7Z6deSvuAhXWH3pAGyc';

/** Polar organization id (public, not a secret; Polar → Settings → Organization ID). */
export const POLAR_ORGANIZATION_ID = process.env.FRAMEDRIFT_POLAR_ORG_ID || 'ffc5d3e5-4514-4aa6-81c0-e0683650051f';

export const isPlaceholderOrg = (id) => !id || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id);
export const isRepoConfigured = () => REPO_SLUG.split('/')[0] !== 'OWNER';
// Unconfigured fallback: the upstream repo. (framedrift is not on npm yet, so an npmjs.com link would 404.)
export const repoUrl = () => `https://github.com/${isRepoConfigured() ? REPO_SLUG : 'sherzodmax/framedrift'}`;

/** Where to send someone who wants Pro. Never returns a placeholder. */
export function upgradeUrl() {
    if (/^https:\/\//.test(POLAR_CHECKOUT_URL)) return POLAR_CHECKOUT_URL;
    return `${repoUrl()}#free-and-pro`;
}
