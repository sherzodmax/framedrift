// Which pages to compare with which Figma frames.
// Sources (merged): .framedrift.json in the repo, and lines in the PR description like
//   framedrift: /login https://www.figma.com/design/KEY/File?node-id=12-34
//   /pricing -> https://www.figma.com/design/KEY/File?node-id=56-78
import fs from 'node:fs';
import path from 'node:path';
import { parseFigmaUrl } from './figma.js';
import { UsageError } from './args.js';

const FIGMA_RE = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+[^\s)>\]"']*/;

/**
 * Frames from the PR description. `onIgnored(line, reason)` is called for an opted-in line that is dropped (e.g. a
 * protocol-relative `framedrift: //host/x` path), so the Action can warn instead of skipping it silently (N6).
 */
export function parsePrBody(body, { onIgnored = () => {} } = {}) {
    const frames = [];
    if (!body) return frames;
    // The path must be root-relative ("/x", never "//host/x"), so a PR description can't point the run at another host.
    const lineRe = new RegExp(String.raw`^\s*(?:[-*]\s*)?(?:framedrift:\s*)?(\/(?!\/)[^\s]*)?\s*(?:->|=>|→|:)?\s*(${FIGMA_RE.source})`, 'gmi');
    // Only lines that opt in: start with "framedrift:" or a path followed by a Figma link.
    for (const line of String(body).split(/\r?\n/)) {
        const optedIn = /^\s*(?:[-*]\s*)?(framedrift:|\/)/i.test(line);
        if (!optedIn) continue;
        lineRe.lastIndex = 0;
        const m = lineRe.exec(line);
        if (/^\s*(?:[-*]\s*)?(?:framedrift:\s*)?\/\//i.test(line)) { onIgnored(line.trim(), 'the path must start with a single "/" (a path on the preview), not "//host"'); continue; }
        if (!m) {
            if (/^\s*(?:[-*]\s*)?framedrift:/i.test(line)) onIgnored(line.trim(), 'expected "framedrift: /path https://www.figma.com/design/…?node-id=…"');
            continue;
        }
        frames.push({ path: m[1] || '/', figma: m[2].replace(/[.,;]+$/, ''), source: 'pr-body' });
    }
    return frames;
}

const LIMITS = { failOn: [0, 100, 'a percentage 0..100'], threshold: [0, 1, 'a number 0..1'] };

/** failOn / threshold must be real numbers in range; a typo must not silently become a permissive default. */
export function checkNumbers(obj, where, file) {
    for (const [key, [min, max, what]] of Object.entries(LIMITS)) {
        if (obj?.[key] === undefined) continue;
        const v = obj[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new UsageError(`${file ? `${file}: ` : ''}${where}.${key} must be ${what} (got ${Number.isNaN(v) ? 'NaN' : JSON.stringify(v)})`);
    }
}

/** A frame path is root-relative ("/login"). Absolute URLs are only accepted when they stay on `base`'s origin. */
export function isRootRelative(p) {
    return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\');
}

export function loadConfigFile(file) {
    if (!file || !fs.existsSync(file)) return { frames: [], defaults: {} };
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`${file} is not valid JSON: ${e.message}`); }
    if (cfg.frames !== undefined && !Array.isArray(cfg.frames)) throw new UsageError(`${file}: "frames" must be an array`);
    checkNumbers(cfg.defaults, 'defaults', file);
    const frames = (cfg.frames || []).map((f, i) => {
        if (!f || (!f.figma && !f.design)) throw new UsageError(`${file}: frames[${i}] needs a "figma" frame link or a "design" PNG path`);
        if (f.path !== undefined && !isRootRelative(f.path)) throw new UsageError(`${file}: frames[${i}].path must start with "/" (a path on the preview, e.g. "/login"); got ${JSON.stringify(f.path)}. Frames can't point at other hosts.`);
        checkNumbers(f, `frames[${i}]`, file);
        // Design PNG paths are relative to the config file, not the working directory.
        const design = f.design ? path.resolve(path.dirname(file), f.design) : undefined;
        return { path: f.path || '/', ...f, ...(design ? { design } : {}), source: 'config' };
    });
    return { frames, defaults: cfg.defaults || {} };
}

/** Merge config + PR body; PR body entries override config entries with the same path+figma. */
export function mergeFrames(configFrames, prFrames) {
    const key = (f) => `${f.path}|${f.figma}`;
    const map = new Map(configFrames.map((f) => [key(f), f]));
    for (const f of prFrames) map.set(key(f), { ...(map.get(key(f)) || {}), ...f });
    return [...map.values()];
}

// ---------- N1: what a preview base URL may be ----------
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'metadata.azure.internal', 'instance-data', 'instance-data.ec2.internal']);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254']);

function ipv4Of(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host.split('.').map(Number);
    // IPv4-mapped IPv6 as the URL parser prints it: ::ffff:7f00:1
    const m = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (m) { const a = parseInt(m[1], 16); const b = parseInt(m[2], 16); return [a >> 8, a & 255, b >> 8, b & 255]; }
    const d = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return d ? d[1].split('.').map(Number) : null;
}

/** 'loopback' | 'link-local' | 'metadata' | null for a URL hostname (WHATWG-normalised, so 2130706433 is 127.0.0.1). */
export function classifyHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (METADATA_HOSTS.has(host) || METADATA_IPS.has(host)) return 'metadata';
    const v4 = ipv4Of(host);
    if (v4) {
        if (METADATA_IPS.has(v4.join('.'))) return 'metadata';
        if (v4[0] === 127 || v4.join('.') === '0.0.0.0') return 'loopback';
        if (v4[0] === 169 && v4[1] === 254) return 'link-local';
        return null;
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return 'loopback';
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return 'link-local';
    return null;
}

/**
 * The preview base must not be a loopback, link-local or cloud-metadata address: on a CI runner those reach the
 * runner itself and the cloud metadata service. Loopback is allowed only on explicit opt-in (`allowLoopback`:
 * the CLI for local dev servers, the Action's `allow-loopback-preview` input for CI smoke tests). Link-local and
 * metadata hosts are never allowed. Host names that only RESOLVE to such addresses are not caught here (no DNS
 * lookups; rebinding would defeat them anyway) — see README "Security".
 */
export function assertSafeBase(base, { allowLoopback = false } = {}) {
    const u = base instanceof URL ? base : new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError(`Preview URL must be http(s); got ${u.protocol}`);
    const kind = classifyHost(u.hostname);
    if (kind === 'metadata' || kind === 'link-local') throw new UsageError(`Preview URL host ${u.hostname} is a ${kind} address (cloud metadata / runner-internal); refusing to load it`);
    if (kind === 'loopback' && !allowLoopback) throw new UsageError(`Preview URL host ${u.hostname} is a loopback address; refusing to load it (CLI runs allow localhost; in the Action set allow-loopback-preview: 'true' only for CI smoke tests)`);
    return u;
}

/** Fallback hosts the Vercel bypass secret may be sent to when nothing narrower is known (any Vercel project). */
export const DEFAULT_PREVIEW_HOSTS = ['*.vercel.app'];

/** Parse a comma/space-separated `preview-hosts` list ("*.vercel.app, preview.acme.dev"). */
export const parseHostList = (v) => String(v || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

const VERCEL_SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * R4-03: the hosts the bypass secret may go to.
 * - `hosts` (Action `preview-hosts`, CLI `--preview-host`) set: exactly those (an explicit list replaces the default).
 * - else `project` (Action `vercel-project`, CLI `--vercel-project`, env `FRAMEDRIFT_VERCEL_PROJECT`): that Vercel
 *   project's own preview URLs, `<project>-<hash>-<team>.vercel.app` / `<project>-git-<branch>-<team>.vercel.app`
 *   (and `<project>-<team>.vercel.app`) when `team` (`vercel-team`, the team / account slug) is known, else
 *   `<project>-*.vercel.app`.
 * - else `*.vercel.app` (any Vercel project); callers warn about it.
 */
export function resolvePreviewHosts({ hosts = [], project, team } = {}) {
    if (hosts.length) return { hosts: [...hosts], source: 'preview-hosts' };
    const p = String(project || '').trim().toLowerCase();
    const t = String(team || '').trim().toLowerCase();
    if (p) {
        if (!VERCEL_SLUG.test(p)) throw new UsageError(`Invalid vercel-project ${JSON.stringify(project)}: use the project name as it appears in its *.vercel.app URLs (letters, digits, "-")`);
        if (t && !VERCEL_SLUG.test(t)) throw new UsageError(`Invalid vercel-team ${JSON.stringify(team)}: use the team / account slug from the *.vercel.app URLs`);
        return { hosts: t ? [`${p}-*-${t}.vercel.app`, `${p}-${t}.vercel.app`] : [`${p}-*.vercel.app`], source: 'vercel-project' };
    }
    return { hosts: [...DEFAULT_PREVIEW_HOSTS], source: 'default' };
}

/**
 * Does `url`'s host match one of `patterns`?
 * - `*.x.dev` matches any subdomain of x.dev (not x.dev itself);
 * - a `*` anywhere else matches one or more characters inside one DNS label (`app-*-acme.vercel.app` matches
 *   `app-1a2b-acme.vercel.app`, never a name with an extra dot);
 * - other entries are exact.
 */
export function previewHostAllowed(url, patterns = DEFAULT_PREVIEW_HOSTS) {
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
    return patterns.some((p) => {
        const pat = String(p).toLowerCase().replace(/\.$/, '');
        if (pat.startsWith('*.') && !pat.slice(2).includes('*')) return host.endsWith(pat.slice(1)) && host.length > pat.length - 1;
        if (pat.includes('*')) return new RegExp(`^${pat.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`).test(host);
        return host === pat;
    });
}

/**
 * R4-03: with a bypass secret set, the preview must be https on the default port and on an allowlisted host.
 * Throws a UsageError naming the problem; returns nothing when the secret may be sent.
 */
export function assertBypassTarget(url, hosts, hint) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new UsageError(`Refusing to send the Vercel bypass secret over ${u.protocol.replace(':', '')}: the preview URL must be https when a bypass secret is set`);
    if (u.port) throw new UsageError(`Refusing to send the Vercel bypass secret to port ${u.port}: the preview URL must use the default https port when a bypass secret is set`);
    if (!previewHostAllowed(u.href, hosts)) throw new UsageError(`Refusing to send the Vercel bypass secret to ${u.hostname}: it is not in the preview host allowlist (${hosts.join(', ')}). ${hint}`);
}

/**
 * Join a frame path onto the preview base URL. The result always stays on the base origin: the preview's
 * headers (e.g. the Vercel bypass secret) are scoped to that origin, and frames must not be able to aim the
 * browser at other hosts (internal addresses, attacker servers).
 */
export function joinUrl(base, p, { allowLoopback = false } = {}) {
    const u = new URL(base);
    assertSafeBase(u, { allowLoopback });
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) {
        let abs;
        try { abs = new URL(p); } catch { throw new Error(`Invalid frame path ${JSON.stringify(p)}`); }
        if (abs.origin !== u.origin) throw new Error(`Frame path ${JSON.stringify(p)} is outside the preview origin ${u.origin}; use a path like "/login"`);
        return abs.href;
    }
    if (!isRootRelative(p)) throw new Error(`Frame path ${JSON.stringify(p)} must be root-relative (start with a single "/") so it stays on the preview origin ${u.origin}`);
    const [pathname, query] = p.split('?');
    u.pathname = `${u.pathname.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
    if (query) u.search = query;
    if (u.origin !== new URL(base).origin) throw new Error(`Frame path ${JSON.stringify(p)} resolves outside the preview origin`);
    return u.href;
}

/**
 * F2: optional allowlist of Figma file keys (Action input `figma-files`). Frames that link any other file are
 * returned as error rows and never fetched, so a PR description can't make CI render files the token can see.
 */
export function applyFigmaAllowlist(frames, list) {
    const keys = String(list || '').split(/[\s,]+/).filter(Boolean);
    if (!keys.length) return { allowed: frames, rejected: [] };
    const allowed = [];
    const rejected = [];
    for (const f of frames) {
        if (!f.figma) { allowed.push(f); continue; }
        let key = null;
        try { const p = parseFigmaUrl(f.figma); key = [p.fileKey, p.mainFileKey]; } catch { /* reported by compare */ }
        if (!key || key.some((k) => k && keys.includes(k))) allowed.push(f);
        else rejected.push({ name: f.name || f.path || '/', path: f.path || '/', url: null, error: `Figma file ${key[1] || key[0]} is not in the figma-files allowlist; not fetched`, figma: null });
    }
    return { allowed, rejected };
}
