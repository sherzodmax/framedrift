// GENERATED COPY of apify/shared/mock-figma.js — edit the shared file and run `npm run sync-shared`.
// Offline stand-in for api.figma.com used by tests and local runs.
// It serves recorded-shape fixtures (apify/fixtures/figma) and mimics Figma's
// auth, error and rate-limit behaviour closely enough to exercise client code.
//
// NOT a substitute for a live test against Figma — see LAUNCH.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// apify/shared/testing -> apify/fixtures/figma ; devtool/test/support -> devtool/test/fixtures/figma
export const FIXTURE_DIR = [path.resolve(here, '..', '..', 'fixtures', 'figma'), path.resolve(here, '..', 'fixtures', 'figma')].find((d) => fs.existsSync(path.join(d, 'file.json')));
export const TEST_TOKEN = 'figd_TESTTOKEN_0123456789';
export const FILE_KEY = 'FIXTUREFILEKEY01';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
/** Encode an RGBA PNG; pixel(x,y) -> [r,g,b,a]. Dependency-free. */
export function encodePng(width, height, pixel) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); const o = y * (width * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const load = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, n), 'utf8'));

function findNode(node, id) {
    if (node.id === id) return node;
    for (const c of node.children || []) { const f = findNode(c, id); if (f) return f; }
    return null;
}
function trimDepth(node, depth) {
    if (depth === undefined) return node;
    const copy = { ...node };
    if (depth <= 0) delete copy.children;
    else if (copy.children) copy.children = copy.children.map((c) => trimDepth(c, depth - 1));
    return copy;
}

/**
 * Start the mock. Options:
 *  - renders: { [nodeId]: absolutePathToPng } to serve real images for specific nodes
 *  - variablesForbidden: true -> /variables/local answers 403 like non-Enterprise plans
 * Special file keys: RATELIMIT1SEC (429 once, Retry-After 1), RATELIMITHOURS (429, Retry-After 7200),
 * NOTFOUNDFILEKEY (404). Any other key serves the fixture file.
 */
export async function startMockFigma({ port = 0, renders = {}, variablesForbidden = false, log = false } = {}) {
    const file = load('file.json');
    const hits = [];
    let rlCount = 0;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        hits.push(`${req.method} ${u.pathname}${u.search}`);
        if (log) console.error(`[mock-figma] ${req.method} ${u.pathname}${u.search}`);
        const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
        // Rendered images are "pre-signed S3 URLs": no auth.
        const rm = u.pathname.match(/^\/render\/([^/]+)\.(png|jpg|svg|pdf)$/);
        if (rm) {
            const id = decodeURIComponent(rm[1]);
            if (renders[id] && fs.existsSync(renders[id])) return send(200, fs.readFileSync(renders[id]), { 'content-type': 'image/png' });
            const node = findNode(file.document, id);
            const bb = node?.absoluteBoundingBox || { width: 100, height: 100 };
            const scale = Number(u.searchParams.get('scale') || 1);
            if (rm[2] === 'svg') return send(200, `<svg xmlns="http://www.w3.org/2000/svg" width="${bb.width}" height="${bb.height}"><rect width="100%" height="100%" fill="#1a73e8"/></svg>`, { 'content-type': 'image/svg+xml' });
            if (rm[2] === 'pdf') return send(200, '%PDF-1.4\n% mock\n', { 'content-type': 'application/pdf' });
            const w = Math.max(1, Math.round(bb.width * scale)); const h = Math.max(1, Math.round(bb.height * scale));
            return send(200, encodePng(Math.min(w, 2000), Math.min(h, 2000), (x, y) => ((x + y) % 40 < 20 ? [26, 115, 232, 255] : [255, 255, 255, 255])), { 'content-type': 'image/png' });
        }
        if (req.headers['x-figma-token'] !== TEST_TOKEN && req.headers.authorization !== `Bearer ${TEST_TOKEN}`) return send(403, { status: 403, err: 'Invalid token' });
        const m = u.pathname.match(/^\/v1\/(files|images)\/([^/]+)(\/[a-z_/]+)?$/);
        if (!m) return send(404, { status: 404, err: 'Not found' });
        const [, kind, key, sub = ''] = m;
        if (key === 'NOTFOUNDFILEKEY') return send(404, { status: 404, err: 'Not found' });
        if (key === 'RATELIMITHOURS') return send(429, { status: 429, err: 'Rate limit exceeded' }, { 'retry-after': '7200', 'x-figma-rate-limit-type': 'low' });
        if (key === 'RATELIMIT1SEC' && rlCount++ === 0) return send(429, { status: 429, err: 'Rate limit exceeded' }, { 'retry-after': '1' });
        if (kind === 'images') {
            const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
            const format = u.searchParams.get('format') || 'png';
            const scale = u.searchParams.get('scale') || '1';
            const base = `http://${req.headers.host}`;
            const images = Object.fromEntries(ids.map((id) => [id, findNode(file.document, id) ? `${base}/render/${encodeURIComponent(id)}.${format}?scale=${scale}` : null]));
            return send(200, { err: null, images, status: 200 });
        }
        if (sub === '') {
            const depth = u.searchParams.get('depth') ? Number(u.searchParams.get('depth')) : undefined;
            return send(200, { ...file, document: trimDepth(file.document, depth) });
        }
        if (sub === '/nodes') {
            const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
            const depth = u.searchParams.get('depth') ? Number(u.searchParams.get('depth')) : undefined;
            const nodes = {};
            for (const id of ids) {
                const n = findNode(file.document, id);
                nodes[id] = n ? { document: trimDepth(n, depth), components: file.components, componentSets: file.componentSets, styles: file.styles, schemaVersion: 0 } : null;
            }
            return send(200, { name: file.name, lastModified: file.lastModified, thumbnailUrl: file.thumbnailUrl, version: file.version, role: file.role, editorType: file.editorType, nodes });
        }
        if (sub === '/comments') return send(200, load('comments.json'));
        if (sub === '/components') return send(200, load('components.json'));
        if (sub === '/variables/local') {
            if (variablesForbidden) return send(403, { status: 403, error: true, message: 'Limited by Figma plan' });
            return send(200, load('variables-local.json'));
        }
        return send(404, { status: 404, err: 'Not found' });
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { baseUrl, hits, close: () => new Promise((r) => server.close(r)) };
}
