// Which pages to compare with which Figma frames.
// Sources (merged): .framedrift.json in the repo, and lines in the PR description like
//   framedrift: /login https://www.figma.com/design/KEY/File?node-id=12-34
//   /pricing -> https://www.figma.com/design/KEY/File?node-id=56-78
import fs from 'node:fs';
import path from 'node:path';
import { parseFigmaUrl } from './figma.js';
import { UsageError } from './args.js';

const FIGMA_RE = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+[^\s)>\]"']*/;

export function parsePrBody(body) {
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
        if (!m) continue;
        if (/^\s*(?:[-*]\s*)?(?:framedrift:\s*)?\/\//i.test(line)) continue;
        frames.push({ path: m[1] || '/', figma: m[2].replace(/[.,;]+$/, ''), source: 'pr-body' });
    }
    return frames;
}

const LIMITS = { failOn: [0, 100, 'a percentage 0..100'], threshold: [0, 1, 'a number 0..1'] };

/** failOn / threshold must be real numbers in range; a typo must not silently become a permissive default. */
function checkNumbers(obj, where, file) {
    for (const [key, [min, max, what]] of Object.entries(LIMITS)) {
        if (obj?.[key] === undefined) continue;
        const v = obj[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new UsageError(`${file}: ${where}.${key} must be ${what} (got ${JSON.stringify(v)})`);
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

/**
 * Join a frame path onto the preview base URL. The result always stays on the base origin: the preview's
 * headers (e.g. the Vercel bypass secret) are scoped to that origin, and frames must not be able to aim the
 * browser at other hosts (internal addresses, attacker servers).
 */
export function joinUrl(base, p) {
    const u = new URL(base);
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
