// GENERATED COPY of apify/shared/figma.js — edit the shared file and run `npm run sync-shared`.
// Minimal, dependency-free Figma REST API client.
// SOURCE OF TRUTH: apify/shared/figma.js (copied into each Figma actor and the dev tool).
//
// - Token is sent only as the X-Figma-Token header to the API host. It is never
//   logged, stored, or included in thrown error messages.
// - Retries 429 / 5xx with Retry-After (capped), fails fast on 400/403/404.
// - FIGMA_API_BASE env var overrides the API host (used by the offline test server).

const DEFAULT_BASE = 'https://api.figma.com';

export class FigmaApiError extends Error {
    constructor(message, { status, code, retryAfterSecs } = {}) {
        super(message);
        this.name = 'FigmaApiError';
        this.status = status;
        this.code = code;
        this.retryAfterSecs = retryAfterSecs;
    }
}

/** Strip anything that looks like a Figma token from a string. */
export function redactToken(s) {
    return String(s).replace(/fig[a-z]_[A-Za-z0-9_-]{8,}/g, '[redacted-token]');
}

/** "1-2" | "1%3A2" | "1:2" -> "1:2". Instance ids like "I1:2;3:4" are kept. */
export function normalizeNodeId(id) {
    if (id == null || id === '') return null;
    let s = String(id).trim();
    try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
    // URLs use dashes between the two numeric halves; the API uses colons.
    return s.replace(/^(I?)(\d+)-(\d+)/, '$1$2:$3').replace(/;(\d+)-(\d+)/g, ';$1:$2');
}

/**
 * Parse a Figma URL or bare file key.
 * Supports /file/, /design/, /proto/, /board/, /slides/, /make/ and branch URLs
 * (/design/<key>/branch/<branchKey>/...), in which case the branch key is the file key the API needs.
 * Returns { fileKey, nodeId|null, branchKey|null, kind }.
 */
export function parseFigmaUrl(input) {
    if (!input || typeof input !== 'string') throw new Error('Figma URL or file key is required');
    const s = input.trim();
    if (/^[A-Za-z0-9]{10,64}$/.test(s)) return { fileKey: s, nodeId: null, branchKey: null, kind: 'key' };
    let u;
    try { u = new URL(s); } catch { throw new Error(`Not a Figma URL or file key: ${s.slice(0, 120)}`); }
    if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error(`Not a figma.com URL: ${u.hostname}`);
    const parts = u.pathname.split('/').filter(Boolean);
    const kinds = ['file', 'design', 'proto', 'board', 'slides', 'make', 'deck', 'site'];
    const i = parts.findIndex((p) => kinds.includes(p));
    if (i === -1 || !parts[i + 1]) throw new Error(`Could not find a file key in ${u.pathname}`);
    const fileKey = parts[i + 1];
    let branchKey = null;
    if (parts[i + 2] === 'branch' && parts[i + 3]) branchKey = parts[i + 3];
    const nodeId = normalizeNodeId(u.searchParams.get('node-id'));
    return { fileKey: branchKey || fileKey, mainFileKey: fileKey, nodeId, branchKey, kind: parts[i] };
}

/** Figma color {r,g,b,a} in 0..1 -> "#rrggbb" or "#rrggbbaa" when alpha < 1. */
export function figmaColorToHex(c, opacity = 1) {
    if (!c) return null;
    const to = (v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, '0');
    const a = (c.a === undefined ? 1 : c.a) * (opacity ?? 1);
    return `#${to(c.r)}${to(c.g)}${to(c.b)}${a < 0.999 ? to(a) : ''}`;
}

export class FigmaClient {
    /**
     * @param {object} opts
     * @param {string} opts.token Figma personal access token or OAuth token
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.maxRetries=4]
     * @param {number} [opts.maxRetryAfterSecs=90] give up instead of sleeping longer than this
     * @param {(msg:string)=>void} [opts.onLog]
     * @param {boolean} [opts.oauth=false] send as Authorization: Bearer instead of X-Figma-Token
     */
    constructor({ token, baseUrl, maxRetries = 4, maxRetryAfterSecs = 90, onLog, oauth = false, fetchImpl } = {}) {
        if (!token) throw new FigmaApiError('A Figma access token is required (personal access token with file_content:read scope).', { code: 'NO_TOKEN' });
        // Keep the token in a closure-like private field; never expose it via toString/JSON.
        Object.defineProperty(this, '_token', { value: token, enumerable: false });
        this.baseUrl = (baseUrl || process.env.FIGMA_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
        this.maxRetries = maxRetries;
        this.maxRetryAfterSecs = maxRetryAfterSecs;
        this.onLog = onLog || (() => {});
        this.oauth = oauth;
        this.fetch = fetchImpl || globalThis.fetch;
        this.requestCount = 0;
    }

    toJSON() { return { baseUrl: this.baseUrl }; }

    async get(path, params = {}) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        const url = `${this.baseUrl}${path}${qs.toString() ? `?${qs}` : ''}`;
        const headers = this.oauth ? { Authorization: `Bearer ${this._token}` } : { 'X-Figma-Token': this._token };
        for (let attempt = 0; ; attempt++) {
            let res;
            try {
                this.requestCount++;
                res = await this.fetch(url, { headers });
            } catch (err) {
                if (attempt < this.maxRetries) {
                    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
                    continue;
                }
                throw new FigmaApiError(`Network error calling Figma API (${path}): ${redactToken(err.message)}`, { code: 'NETWORK' });
            }
            if (res.ok) {
                const text = await res.text();
                try { return JSON.parse(text); } catch { throw new FigmaApiError(`Figma API returned non-JSON for ${path}`, { status: res.status, code: 'BAD_JSON' }); }
            }
            const body = await res.text().catch(() => '');
            let detail = '';
            try { const j = JSON.parse(body); detail = j.err || j.message || j.error || ''; } catch { detail = body.slice(0, 200); }
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
            detail = redactToken(detail);
            const status = res.status;
            if (status === 429 || status >= 500) {
                const ra = Number(res.headers.get('retry-after'));
                const waitSecs = Number.isFinite(ra) && ra > 0 ? ra : Math.min(30, 2 ** attempt);
                if (status === 429 && waitSecs > this.maxRetryAfterSecs) {
                    throw new FigmaApiError(
                        `Figma rate limit hit (429) and Figma asked to wait ${Math.round(waitSecs)}s` +
                        `${res.headers.get('x-figma-rate-limit-type') ? ` (limit type: ${res.headers.get('x-figma-rate-limit-type')})` : ''}. ` +
                        'Your Figma plan/seat has a low REST API quota for this endpoint; try again later or use a token from a Full/Dev seat.',
                        { status, code: 'RATE_LIMITED', retryAfterSecs: waitSecs },
                    );
                }
                if (attempt < this.maxRetries) {
                    this.onLog(`Figma API ${status} on ${path}; retrying in ${waitSecs}s (attempt ${attempt + 1}/${this.maxRetries})`);
                    await new Promise((r) => setTimeout(r, waitSecs * 1000));
                    continue;
                }
                throw new FigmaApiError(`Figma API ${status} on ${path} after ${this.maxRetries} retries${detail ? `: ${detail}` : ''}`, { status, code: status === 429 ? 'RATE_LIMITED' : 'SERVER' });
            }
            const hints = {
                400: 'Bad request — check the node ids / parameters.',
                401: 'Token rejected — check that the Figma token is valid and not expired.',
                403: 'Forbidden — the token is invalid, lacks the needed scope, or cannot access this file.',
                404: 'Not found — the file key is wrong or the token has no access to this file.',
            };
            const hint = hints[status];
            const said = detail && (!hint || !hint.toLowerCase().startsWith(detail.toLowerCase())) ? ` (Figma says: ${detail})` : '';
            throw new FigmaApiError(`Figma API ${status} on ${path}: ${hint || detail || 'request failed'}${hint ? said : ''}`, { status, code: `HTTP_${status}` });
        }
    }

    /** GET /v1/files/:key  (depth optional; ids optional to limit the document) */
    getFile(fileKey, { depth, ids, geometry, branchData } = {}) {
        return this.get(`/v1/files/${encodeURIComponent(fileKey)}`, { depth, ids: Array.isArray(ids) ? ids.join(',') : ids, geometry, branch_data: branchData });
    }

    /** GET /v1/files/:key/nodes?ids=... */
    getNodes(fileKey, ids, { depth, geometry } = {}) {
        return this.get(`/v1/files/${encodeURIComponent(fileKey)}/nodes`, { ids: [].concat(ids).join(','), depth, geometry });
    }

    /**
     * GET /v1/images/:key — render nodes. Batches ids (Figma rejects very long id lists).
     * Returns { [nodeId]: url|null }.
     */
    async getImages(fileKey, ids, { format = 'png', scale = 1, svgOutlineText, svgIncludeId, svgSimplifyStroke, useAbsoluteBounds, batchSize = 50 } = {}) {
        const all = [].concat(ids);
        const out = {};
        for (let i = 0; i < all.length; i += batchSize) {
            const chunk = all.slice(i, i + batchSize);
            const res = await this.get(`/v1/images/${encodeURIComponent(fileKey)}`, {
                ids: chunk.join(','),
                format,
                scale: format === 'svg' || format === 'pdf' ? undefined : scale,
                svg_outline_text: svgOutlineText,
                svg_include_id: svgIncludeId,
                svg_simplify_stroke: svgSimplifyStroke,
                use_absolute_bounds: useAbsoluteBounds,
            });
            if (res.err) throw new FigmaApiError(`Figma could not render images: ${res.err}`, { code: 'RENDER' });
            Object.assign(out, res.images || {});
        }
        return out;
    }

    /** GET /v1/files/:key/comments (as_md returns markdown-formatted messages) */
    getComments(fileKey, { asMd = true } = {}) {
        return this.get(`/v1/files/${encodeURIComponent(fileKey)}/comments`, { as_md: asMd ? 'true' : undefined });
    }

    /** GET /v1/files/:key/components — published components only. */
    getFileComponents(fileKey) { return this.get(`/v1/files/${encodeURIComponent(fileKey)}/components`); }

    /** GET /v1/files/:key/component_sets — published component sets only. */
    getFileComponentSets(fileKey) { return this.get(`/v1/files/${encodeURIComponent(fileKey)}/component_sets`); }

    /** GET /v1/files/:key/styles — published styles only. */
    getFileStyles(fileKey) { return this.get(`/v1/files/${encodeURIComponent(fileKey)}/styles`); }

    /** GET /v1/files/:key/variables/local — Enterprise plan + file_variables:read scope only. */
    getLocalVariables(fileKey) { return this.get(`/v1/files/${encodeURIComponent(fileKey)}/variables/local`); }

    /** Download a rendered image (pre-signed S3 URL, no auth header). Returns Buffer. */
    async download(url, { retries = 3 } = {}) {
        for (let attempt = 0; ; attempt++) {
            try {
                const res = await this.fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
            } catch (err) {
                if (attempt >= retries) throw new FigmaApiError(`Failed to download rendered image: ${err.message}`, { code: 'DOWNLOAD' });
                await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            }
        }
    }
}

/** Depth-first walk over a Figma node tree. visitor(node, ancestors) may return false to skip children. */
export function walk(node, visitor, ancestors = []) {
    if (!node) return;
    const r = visitor(node, ancestors);
    if (r === false || !Array.isArray(node.children)) return;
    const next = ancestors.concat(node);
    for (const c of node.children) walk(c, visitor, next);
}
