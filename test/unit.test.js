import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pngjs from 'pngjs';
import { compareImages, findHotspots, padTo } from '../src/diff.js';
import { flattenLayers, attributeHotspots } from '../src/layers.js';
import { parsePrBody, mergeFrames, joinUrl, loadConfigFile } from '../src/config.js';
import { resolveTier } from '../src/license.js';
import { renderMarkdown, COMMENT_MARKER } from '../src/report.js';
import { parseArgs, parseViewport, parseHeaders } from '../src/args.js';

const { PNG } = pngjs;
function solid(w, h, rgb, rect) {
    const p = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const inR = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        const c = inR ? rect.rgb : rgb;
        p.data.set([...c, 255], (y * w + x) * 4);
    }
    return PNG.sync.write(p);
}

test('identical images: 0% and no hotspots', () => {
    const a = solid(100, 80, [255, 255, 255]);
    const r = compareImages(a, a);
    assert.equal(r.mismatchPercent, 0);
    assert.equal(r.hotspots.length, 0);
});

test('one changed rectangle -> one hotspot at the right place', () => {
    const a = solid(200, 100, [255, 255, 255], { x: 20, y: 30, w: 40, h: 20, rgb: [26, 115, 232] });
    const b = solid(200, 100, [255, 255, 255], { x: 20, y: 30, w: 40, h: 20, rgb: [220, 38, 38] });
    const r = compareImages(a, b);
    assert.equal(r.mismatchedPixels, 800);
    assert.equal(r.hotspots.length, 1);
    const h = r.hotspots[0];
    assert.ok(h.x <= 20 && h.y <= 30 && h.x + h.width >= 60 && h.y + h.height >= 50, JSON.stringify(h));
});

test('shorter page is padded and flagged as size mismatch', () => {
    const r = compareImages(solid(50, 100, [255, 255, 255]), solid(50, 60, [255, 255, 255]));
    assert.equal(r.sizeMismatch, true);
    assert.equal(r.mismatchedPixels, 50 * 40);
    assert.equal(r.actualSize.height, 60);
});

test('findHotspots merges nearby pixels and separates far ones', () => {
    const w = 100; const h = 100; const m = new Uint8Array(w * h);
    for (let x = 10; x < 14; x++) m[10 * w + x] = 1; // cluster A
    for (let x = 80; x < 90; x++) m[80 * w + x] = 1; // cluster B
    const hs = findHotspots(m, w, h, { minPixels: 1 });
    assert.equal(hs.length, 2);
    assert.equal(padTo(new PNG({ width: 2, height: 2 }), 4, 4).width, 4);
});

test('hotspots are attributed to the most specific Figma layer', () => {
    const file = JSON.parse(fs.readFileSync(new URL('./fixtures/figma/file.json', import.meta.url)));
    const login = file.document.children[2].children[0];
    const layers = flattenLayers(login);
    const btn = layers.find((l) => l.name === 'Button / Sign in');
    assert.deepEqual([btn.x, btn.y, btn.width, btn.height], [24, 400, 342, 44]);
    const components = { '10:1': { name: 'Button / Variant=Primary' } };
    const [a, b] = attributeHotspots([{ x: 30, y: 404, width: 300, height: 40, pixels: 999 }, { x: 24, y: 64, width: 120, height: 40, pixels: 50 }], layers, components);
    assert.equal(a.layer.name, 'Button / Sign in');
    assert.equal(a.layer.component, 'Button / Variant=Primary');
    assert.equal(b.layer.name, 'Title');
    assert.equal(b.layer.text, 'Welcome back');
    const scaled = flattenLayers(login, { scale: 2 }).find((l) => l.name === 'Button / Sign in');
    assert.equal(scaled.y, 800);
});

test('PR body parsing is opt-in and tolerant', () => {
    const body = `Implements login.\n\nSee https://www.figma.com/design/ABC123/x?node-id=1-2 for context (ignored: not opted in)\n\nframedrift: /login https://www.figma.com/design/ABC123/App?node-id=20-1\n- /pricing -> https://www.figma.com/design/ABC123/App?node-id=30-5&t=xyz.\n* framedrift: https://www.figma.com/file/ABC123/App?node-id=40-1`;
    const f = parsePrBody(body);
    assert.deepEqual(f.map((x) => x.path), ['/login', '/pricing', '/']);
    assert.equal(f[1].figma, 'https://www.figma.com/design/ABC123/App?node-id=30-5&t=xyz');
    assert.deepEqual(parsePrBody(''), []);
    const merged = mergeFrames([{ path: '/login', figma: f[0].figma, hide: ['.x'] }], f);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged[0].hide, ['.x']);
});

test('joinUrl keeps preview host and query', () => {
    assert.equal(joinUrl('https://app-git-x.vercel.app', '/login?next=/a'), 'https://app-git-x.vercel.app/login?next=/a');
    assert.equal(joinUrl('https://a.vercel.app/base/', '/p'), 'https://a.vercel.app/base/p');
    // Paths can't leave the preview origin (review F1); see review-fixes.test.js.
    assert.throws(() => joinUrl('https://a.vercel.app', 'https://other.dev/x'), /preview origin/);
    assert.deepEqual(loadConfigFile('/nonexistent.json'), { frames: [], defaults: {} });
});

test('license: free without key, pro on granted, free on 404, grace on outage', async () => {
    const org = '11111111-2222-4333-8444-555555555555';
    const fake = (status, body) => async (url, init) => {
        assert.match(url, /\/v1\/customer-portal\/license-keys\/validate$/);
        assert.deepEqual(JSON.parse(init.body), { key: 'K', organization_id: org });
        return new Response(JSON.stringify(body), { status });
    };
    assert.equal((await resolveTier('')).tier, 'free');
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: fake(200, { status: 'granted', expires_at: null }) })).tier, 'pro');
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: fake(200, { status: 'granted', expires_at: '2020-01-01T00:00:00Z' }) })).tier, 'free');
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: fake(404, { error: 'ResourceNotFound' }) })).tier, 'free');
    const down = await resolveTier('K', { organizationId: org, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(down.tier, 'pro');
    assert.equal(down.grace, true);
    // N3: pass the placeholder explicitly. Relying on the module default broke after launch-config.mjs set a real org
    // (the fake fetch then saw another org, threw, and resolveTier failed open to Pro).
    let called = false;
    const placeholder = await resolveTier('K', { organizationId: '00000000-0000-0000-0000-000000000000', fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }); } });
    assert.equal(placeholder.tier, 'free', 'unconfigured org id never grants pro');
    assert.equal(called, false, 'an unconfigured org makes no license request');
});

test('markdown comment has marker, verdict icons and escapes pipes', () => {
    const md = renderMarkdown([
        { name: 'Login', path: '/login', url: 'u', mismatchPercent: 3.2, hotspots: [{ x: 0, y: 0, width: 1, height: 1, pixels: 1, layer: { name: 'B', path: 'Button | Sign in', component: 'Button' } }], figma: { url: 'https://figma.com/x' } },
        { name: 'Home', path: '/', url: 'u', mismatchPercent: 0.4, hotspots: [] },
        { name: 'Err', path: '/e', url: 'u', error: 'boom' },
    ], { failOn: 2 });
    assert.ok(md.startsWith(COMMENT_MARKER));
    assert.match(md, /⚠️ \| \[Login\]/);
    assert.match(md, /✅ \| Home/);
    assert.match(md, /❌ \| Err/);
    assert.match(md, /Button \\\| Sign in \(Button\)/);
});

test('args parsing', () => {
    const a = parseArgs(['compare', '--url', 'x', '--hide', '.a', '--hide=.b', '--json', '--fail-on', '2'], { booleans: ['json'], arrays: ['hide'] });
    assert.deepEqual(a, { _: ['compare'], url: 'x', hide: ['.a', '.b'], json: true, failOn: '2' });
    assert.throws(() => parseArgs(['--url']), /Missing value/);
    assert.deepEqual(parseViewport('1440x900'), { width: 1440, height: 900 });
    assert.deepEqual(parseHeaders(['X-A: 1']), { 'x-a': '1' });
});
