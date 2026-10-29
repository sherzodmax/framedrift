// framedrift Pro licensing via Polar license keys.
// The code is MIT: this is an honest paywall for convenience features, not DRM.
//
// Fails CLOSED, with a short grace period: if Polar can't be reached (network error, timeout or 5xx),
// a key that this machine validated successfully within the last GRACE_HOURS stays Pro for the run.
// A key that was never validated here, or whose last validation is older than that, runs Free until
// the license server answers again. Free never breaks CI: it still compares up to 3 frames and reports.
// The cache stores a SHA-256 hash of the key, never the key itself.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLAR_ORGANIZATION_ID, isPlaceholderOrg } from './launch-config.js';

export const FREE_FRAME_LIMIT = 3;
export const GRACE_HOURS = 72;
export { POLAR_ORGANIZATION_ID };
const POLAR_API = process.env.FRAMEDRIFT_POLAR_API || 'https://api.polar.sh';

/** Where the last successful validation is remembered (FRAMEDRIFT_CACHE_DIR, else $XDG_CACHE_HOME or ~/.cache). */
export function defaultCacheFile(env = process.env) {
    const dir = env.FRAMEDRIFT_CACHE_DIR || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'framedrift');
    return path.join(dir, 'license.json');
}

const keyHash = (key, organizationId) => crypto.createHash('sha256').update(`${organizationId}:${key}`).digest('hex');

function readCache(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeCache(file, entry) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
    } catch { /* a read-only cache dir only costs the grace period */ }
}
function clearCache(file, hash) {
    const c = readCache(file);
    if (c && c.keyHash === hash) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
}

/** Outage path: Pro only for a key validated here within the grace window (and not past its own expiry). */
function outage(why, { file, hash, now, graceMs }) {
    const c = readCache(file);
    const validatedAt = c && c.keyHash === hash ? Date.parse(c.validatedAt) : NaN;
    const expired = c && c.expiresAt && Date.parse(c.expiresAt) < now;
    if (Number.isFinite(validatedAt) && validatedAt <= now && now - validatedAt <= graceMs && !expired) {
        const hoursLeft = Math.max(0, Math.floor((graceMs - (now - validatedAt)) / 3_600_000));
        return { tier: 'pro', reason: `${why}; key was validated ${c.validatedAt}, Pro grace period (${hoursLeft}h left)`, grace: true };
    }
    const tail = Number.isFinite(validatedAt) ? `last successful validation ${c.validatedAt} is outside the ${graceMs / 3_600_000}h grace period` : 'this key has not been validated on this machine before';
    return { tier: 'free', reason: `${why}; ${tail}, so this run is Free`, grace: false };
}

/**
 * @returns {Promise<{tier:'pro'|'free', reason:string, expiresAt?:string|null, grace?:boolean}>}
 */
export async function resolveTier(key, { fetchImpl = fetch, organizationId = POLAR_ORGANIZATION_ID, apiBase = POLAR_API, timeoutMs = 8000, cacheFile = defaultCacheFile(), now = Date.now(), graceHours = GRACE_HOURS } = {}) {
    if (!key) return { tier: 'free', reason: 'no license key' };
    if (isPlaceholderOrg(organizationId)) return { tier: 'free', reason: 'Pro licensing is not set up in this build yet (no Polar organization configured); running Free' };
    const ctx = { file: cacheFile, hash: keyHash(key, organizationId), now, graceMs: graceHours * 3_600_000 };
    let res;
    try {
        res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/v1/customer-portal/license-keys/validate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ key, organization_id: organizationId }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        return outage(`license server unreachable (${e.name})`, ctx);
    }
    if (res.status >= 500) return outage(`license server error ${res.status}`, ctx);
    if (res.status === 404) { clearCache(cacheFile, ctx.hash); return { tier: 'free', reason: 'license key not found, revoked or expired' }; }
    if (!res.ok) return { tier: 'free', reason: `license check failed (HTTP ${res.status})` };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'granted') { if (body.status) clearCache(cacheFile, ctx.hash); return { tier: 'free', reason: `license status ${body.status || 'unknown'}` }; }
    if (body.expires_at && Date.parse(body.expires_at) < now) { clearCache(cacheFile, ctx.hash); return { tier: 'free', reason: 'license expired' }; }
    writeCache(cacheFile, { keyHash: ctx.hash, validatedAt: new Date(now).toISOString(), expiresAt: body.expires_at || null });
    return { tier: 'pro', reason: 'valid license', expiresAt: body.expires_at || null };
}
