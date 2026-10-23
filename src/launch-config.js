// LAUNCH CONFIG — the only values that change when framedrift goes public.
// Each one is a placeholder until Sherzod creates the account (see LAUNCH-CHECKLIST.md).
// The code works without them: no Polar org → every run is Free tier; no checkout URL → the
// upgrade hint points at the README instead of a broken link.
//
// Environment overrides exist for testing and self-hosting; end users never need to set them.

/** GitHub "owner/repo". TODO(launch): replace OWNER after creating the GitHub repo. */
export const REPO_SLUG = 'sherzodmax/framedrift';

/** Polar checkout link for framedrift Pro. TODO(launch): paste from Polar → Products → Checkout link. */
export const POLAR_CHECKOUT_URL = process.env.FRAMEDRIFT_CHECKOUT_URL || '';

/** Polar organization id (public, not a secret). TODO(launch): Polar → Settings → Organization ID. */
export const POLAR_ORGANIZATION_ID = process.env.FRAMEDRIFT_POLAR_ORG_ID || '00000000-0000-0000-0000-000000000000';

export const isPlaceholderOrg = (id) => !id || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id);
export const isRepoConfigured = () => REPO_SLUG.split('/')[0] !== 'OWNER';
// Unconfigured fallback: the upstream repo. (framedrift is not on npm yet, so an npmjs.com link would 404.)
export const repoUrl = () => `https://github.com/${isRepoConfigured() ? REPO_SLUG : 'sherzodmax/framedrift'}`;

/** Where to send someone who wants Pro. Never returns a placeholder. */
export function upgradeUrl() {
    if (/^https:\/\//.test(POLAR_CHECKOUT_URL)) return POLAR_CHECKOUT_URL;
    return `${repoUrl()}#free-and-pro`;
}
