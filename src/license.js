// framedrift Pro licensing via Polar license keys.
// The code is MIT: this is an honest paywall for convenience features, not DRM.
// Fails OPEN (treats the key as valid for this run) if Polar is unreachable, so CI never
// breaks because of our billing provider.

import { POLAR_ORGANIZATION_ID, isPlaceholderOrg } from './launch-config.js';

export const FREE_FRAME_LIMIT = 3;
export { POLAR_ORGANIZATION_ID };
const POLAR_API = process.env.FRAMEDRIFT_POLAR_API || 'https://api.polar.sh';

/**
 * @returns {Promise<{tier:'pro'|'free', reason:string, expiresAt?:string|null, grace?:boolean}>}
 */
export async function resolveTier(key, { fetchImpl = fetch, organizationId = POLAR_ORGANIZATION_ID, apiBase = POLAR_API, timeoutMs = 8000 } = {}) {
    if (!key) return { tier: 'free', reason: 'no license key' };
    if (isPlaceholderOrg(organizationId)) return { tier: 'free', reason: 'Pro licensing is not set up in this build yet (no Polar organization configured); running Free' };
    let res;
    try {
        res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/v1/customer-portal/license-keys/validate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ key, organization_id: organizationId }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        return { tier: 'pro', reason: `license server unreachable (${e.name}); allowing Pro for this run`, grace: true };
    }
    if (res.status >= 500) return { tier: 'pro', reason: `license server error ${res.status}; allowing Pro for this run`, grace: true };
    if (res.status === 404) return { tier: 'free', reason: 'license key not found, revoked or expired' };
    if (!res.ok) return { tier: 'free', reason: `license check failed (HTTP ${res.status})` };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'granted') return { tier: 'free', reason: `license status ${body.status || 'unknown'}` };
    if (body.expires_at && Date.parse(body.expires_at) < Date.now()) return { tier: 'free', reason: 'license expired' };
    return { tier: 'pro', reason: 'valid license', expiresAt: body.expires_at || null };
}
