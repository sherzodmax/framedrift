// Which pages to compare with which Figma frames.
// Sources (merged): .framedrift.json in the repo, and lines in the PR description like
//   framedrift: /login https://www.figma.com/design/KEY/File?node-id=12-34
//   /pricing -> https://www.figma.com/design/KEY/File?node-id=56-78
import fs from 'node:fs';
import path from 'node:path';

const FIGMA_RE = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+[^\s)>\]"']*/;

export function parsePrBody(body) {
    const frames = [];
    if (!body) return frames;
    const lineRe = new RegExp(String.raw`^\s*(?:[-*]\s*)?(?:framedrift:\s*)?(\/[^\s]*)?\s*(?:->|=>|→|:)?\s*(${FIGMA_RE.source})`, 'gmi');
    // Only lines that opt in: start with "framedrift:" or a path followed by a Figma link.
    for (const line of String(body).split(/\r?\n/)) {
        const optedIn = /^\s*(?:[-*]\s*)?(framedrift:|\/)/i.test(line);
        if (!optedIn) continue;
        lineRe.lastIndex = 0;
        const m = lineRe.exec(line);
        if (!m) continue;
        frames.push({ path: m[1] || '/', figma: m[2].replace(/[.,;]+$/, ''), source: 'pr-body' });
    }
    return frames;
}

export function loadConfigFile(file) {
    if (!file || !fs.existsSync(file)) return { frames: [], defaults: {} };
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
    if (cfg.frames !== undefined && !Array.isArray(cfg.frames)) throw new Error(`${file}: "frames" must be an array`);
    const frames = (cfg.frames || []).map((f, i) => {
        if (!f || (!f.figma && !f.design)) throw new Error(`${file}: frames[${i}] needs a "figma" frame link or a "design" PNG path`);
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

export function joinUrl(base, p) {
    if (/^https?:\/\//.test(p)) return p;
    const u = new URL(base);
    const [pathname, query] = p.split('?');
    u.pathname = `${u.pathname.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
    if (query) u.search = query;
    return u.href;
}
