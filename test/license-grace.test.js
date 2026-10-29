// The license check fails closed with a short grace period (review: "never unlimited free Pro while the server is down").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTier, GRACE_HOURS, defaultCacheFile } from '../src/license.js';

const org = '11111111-2222-4333-8444-555555555555';
const H = 3_600_000;
const T0 = Date.parse('2026-10-29T12:00:00Z');
const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-grace-')), 'sub', 'license.json');
const granted = (expires_at = null) => async () => new Response(JSON.stringify({ status: 'granted', expires_at }), { status: 200 });
const down = async () => { throw new TypeError('fetch failed'); };
const err5xx = async () => new Response('', { status: 502 });

test('grace period is a short, bounded window (72h)', () => {
    assert.equal(GRACE_HOURS, 72);
});

test('outage without any prior validation → Free, never Pro', async () => {
    const cacheFile = tmpCache();
    for (const f of [down, err5xx]) {
        const r = await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: f, now: T0 });
        assert.equal(r.tier, 'free');
        assert.match(r.reason, /not been validated on this machine/);
    }
});

test('outage within the grace window after a validation → Pro (grace); after it → Free', async () => {
    const cacheFile = tmpCache();
    assert.equal((await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: granted(), now: T0 })).tier, 'pro');
    const inGrace = await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: err5xx, now: T0 + 71 * H });
    assert.equal(inGrace.tier, 'pro');
    assert.equal(inGrace.grace, true);
    assert.match(inGrace.reason, /grace period \(0h left\)|grace period \(1h left\)/);
    const after = await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + 73 * H });
    assert.equal(after.tier, 'free');
    assert.match(after.reason, /outside the 72h grace period/);
});

test('a fresh validation renews the window; a different key gets no grace from another key', async () => {
    const cacheFile = tmpCache();
    await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: granted(), now: T0 });
    await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: granted(), now: T0 + 60 * H });
    assert.equal((await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + 100 * H })).tier, 'pro');
    assert.equal((await resolveTier('OTHER', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + 61 * H })).tier, 'free');
});

test('grace never outlives the license expiry; revoked keys lose their grace record', async () => {
    const cacheFile = tmpCache();
    await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: granted(new Date(T0 + 10 * H).toISOString()), now: T0 });
    assert.equal((await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + 5 * H })).tier, 'pro');
    assert.equal((await resolveTier('K', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + 11 * H })).tier, 'free');
    const c2 = tmpCache();
    await resolveTier('K', { organizationId: org, cacheFile: c2, fetchImpl: granted(), now: T0 });
    await resolveTier('K', { organizationId: org, cacheFile: c2, fetchImpl: async () => new Response(JSON.stringify({ status: 'revoked' }), { status: 200 }), now: T0 + H });
    assert.equal((await resolveTier('K', { organizationId: org, cacheFile: c2, fetchImpl: down, now: T0 + 2 * H })).tier, 'free');
});

test('the cache stores a hash, not the key; a future-dated or corrupt record grants nothing', async () => {
    const cacheFile = tmpCache();
    await resolveTier('SECRET-KEY-123', { organizationId: org, cacheFile, fetchImpl: granted(), now: T0 });
    const raw = fs.readFileSync(cacheFile, 'utf8');
    assert.ok(!raw.includes('SECRET-KEY-123'));
    const rec = JSON.parse(raw);
    fs.writeFileSync(cacheFile, JSON.stringify({ ...rec, validatedAt: new Date(T0 + 1000 * H).toISOString() }));
    assert.equal((await resolveTier('SECRET-KEY-123', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + H })).tier, 'free');
    fs.writeFileSync(cacheFile, '{not json');
    assert.equal((await resolveTier('SECRET-KEY-123', { organizationId: org, cacheFile, fetchImpl: down, now: T0 + H })).tier, 'free');
});

test('cache location honours FRAMEDRIFT_CACHE_DIR, then XDG_CACHE_HOME', () => {
    assert.equal(defaultCacheFile({ FRAMEDRIFT_CACHE_DIR: '/x/y' }), path.join('/x/y', 'license.json'));
    assert.equal(defaultCacheFile({ XDG_CACHE_HOME: '/c' }), path.join('/c', 'framedrift', 'license.json'));
});
