// Security regression test: extra headers (the Vercel protection-bypass secret, --header values) must reach the
// preview origin only, never third-party hosts the page loads or redirects to. Uses a real headless browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/browser.js';
import { capturePage } from '../src/capture.js';

const SECRET = 'bypass-secret-1234567890';
const headers = { 'x-vercel-protection-bypass': SECRET, 'x-vercel-set-bypass-cookie': 'true', authorization: 'Bearer preview-only' };
const seen = []; // { server, path, headers }
let preview, thirdParty, browser;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function serve(name, handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => { seen.push({ server: name, path: req.url, headers: req.headers }); handler(req, res); });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}
// Different host names (localhost vs 127.0.0.1) and ports, so the third party is a different origin on every count.
const previewOrigin = () => `http://localhost:${preview.address().port}`;
const thirdOrigin = () => `http://127.0.0.1:${thirdParty.address().port}`;

before(async () => {
    thirdParty = await serve('third', (req, res) => {
        if (req.url.startsWith('/font.css')) { res.writeHead(200, { 'content-type': 'text/css', 'access-control-allow-origin': '*' }); return res.end('body{margin:0}'); }
        if (req.url.startsWith('/analytics.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(`fetch(${JSON.stringify(thirdOrigin())} + '/collect', { mode: 'no-cors' })`); }
        if (req.url.startsWith('/landing')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>elsewhere</title><p>elsewhere</p>'); }
        res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }); res.end(PNG);
    });
    preview = await serve('preview', (req, res) => {
        if (req.url === '/chain') { res.writeHead(302, { location: '/chain2' }); return res.end(); }
        if (req.url === '/chain2') { res.writeHead(307, { location: '/chain3' }); return res.end(); }
        if (req.url === '/chain3') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><h1>end of chain</h1><img src="/img-hop" width="1" height="1">'); }
        if (req.url === '/img-hop') { res.writeHead(302, { location: '/img-hop2' }); return res.end(); }
        if (req.url === '/chain-out') { res.writeHead(302, { location: '/chain-out2' }); return res.end(); }
        if (req.url === '/chain-out2') { res.writeHead(302, { location: `${thirdOrigin()}/landing` }); return res.end(); }
        if (req.url === '/redirect-out') { res.writeHead(302, { location: `${thirdOrigin()}/landing` }); return res.end(); }
        if (req.url === '/app.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('h1{color:#111}'); }
        if (req.url === '/') {
            res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': '_vercel_jwt=from-bypass; Path=/; HttpOnly' });
            const t = thirdOrigin();
            return res.end(`<!doctype html><html><head>
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="${t}/font.css">
<script src="${t}/analytics.js"></script>
</head><body><h1>Preview</h1><img src="${t}/cdn/pixel.png" width="1" height="1"><img src="/logo.png" width="1" height="1">
<iframe src="${t}/landing" width="10" height="10"></iframe></body></html>`);
        }
        res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG);
    });
    // Test-only flag: both fake hosts are loopback, and Chrome's Local Network Access check treats an intercepted
    // (fulfilled) document as public, which would block its loopback third-party requests before they reach the server.
    // Real previews are public URLs, so this check never triggers there.
    ({ browser } = await launchBrowser({ extraArgs: ['--disable-features=LocalNetworkAccessChecks'] }));
});

after(async () => {
    await browser?.close();
    preview?.close();
    thirdParty?.close();
});

const leaked = (r) => Object.keys(r.headers).filter((h) => h in headers || String(r.headers[h]).includes(SECRET) || String(r.headers[h]).includes('preview-only'));

test('bypass secret and --header values go to the preview origin only, never to third parties', async () => {
    seen.length = 0;
    await capturePage(browser, { url: `${previewOrigin()}/`, width: 320, height: 240, headers, delayMs: 200 });

    const previewReqs = seen.filter((r) => r.server === 'preview');
    const thirdReqs = seen.filter((r) => r.server === 'third');
    assert.deepEqual(previewReqs.map((r) => r.path).sort(), ['/', '/app.css', '/logo.png']);
    for (const r of previewReqs) {
        assert.equal(r.headers['x-vercel-protection-bypass'], SECRET, `preview ${r.path} is missing the bypass header`);
        assert.equal(r.headers.authorization, 'Bearer preview-only', `preview ${r.path} is missing --header`);
    }
    // Subresource requests after the first response carry the cookie the preview set (Vercel's bypass-cookie flow still works).
    assert.match(previewReqs.find((r) => r.path === '/app.css').headers.cookie || '', /_vercel_jwt=from-bypass/);

    // Font CSS, analytics script, the fetch it makes, the CDN image and the iframe: every third-party request is clean.
    assert.deepEqual([...new Set(thirdReqs.map((r) => r.path.split('?')[0]))].sort(), ['/analytics.js', '/cdn/pixel.png', '/collect', '/font.css', '/landing']);
    for (const r of thirdReqs) assert.deepEqual(leaked(r), [], `third-party ${r.path} received ${leaked(r).join(', ')}`);
});

test('a preview that redirects to another origin does not forward the secret there', async () => {
    seen.length = 0;
    await capturePage(browser, { url: `${previewOrigin()}/redirect-out`, width: 320, height: 240, headers, delayMs: 50 });
    const hop = seen.find((r) => r.server === 'preview' && r.path === '/redirect-out');
    assert.equal(hop.headers['x-vercel-protection-bypass'], SECRET);
    const landing = seen.find((r) => r.server === 'third' && r.path === '/landing');
    assert.ok(landing, 'redirect target was not requested');
    assert.deepEqual(leaked(landing), []);
});

test('no headers → no interception (requests are untouched)', async () => {
    seen.length = 0;
    await capturePage(browser, { url: `${previewOrigin()}/`, width: 320, height: 240, delayMs: 50 });
    assert.ok(seen.length >= 3);
    for (const r of seen) assert.deepEqual(leaked(r), []);
});

test('F1 (review): every hop of a same-origin redirect chain keeps the headers (document and subresource)', async () => {
    seen.length = 0;
    const shot = await capturePage(browser, { url: `${previewOrigin()}/chain`, width: 320, height: 240, headers, delayMs: 50 });
    assert.equal(new URL(shot.finalUrl).pathname, '/chain3');
    for (const p of ['/chain', '/chain2', '/chain3', '/img-hop', '/img-hop2']) {
        const hop = seen.find((r) => r.server === 'preview' && r.path === p);
        assert.ok(hop, `${p} was not requested`);
        assert.equal(hop.headers['x-vercel-protection-bypass'], SECRET, `${p} lost the bypass header`);
    }
});

test('F1 (review): a same-origin hop that then redirects to another origin still keeps the secret away from it', async () => {
    seen.length = 0;
    await capturePage(browser, { url: `${previewOrigin()}/chain-out`, width: 320, height: 240, headers, delayMs: 50 });
    assert.equal(seen.find((r) => r.path === '/chain-out2')?.headers['x-vercel-protection-bypass'], SECRET);
    const landing = seen.find((r) => r.server === 'third' && r.path === '/landing');
    assert.ok(landing, 'redirect target was not requested');
    assert.deepEqual(leaked(landing), []);
});

test('F1 (review): headers are scoped to the preview BASE origin, not to whatever URL is captured', async () => {
    seen.length = 0;
    // e.g. a frame whose URL somehow points at another host: the secret must not follow it.
    await capturePage(browser, { url: `${thirdOrigin()}/landing`, headerOrigin: previewOrigin(), width: 320, height: 240, headers, delayMs: 50 });
    const landing = seen.find((r) => r.server === 'third' && r.path === '/landing');
    assert.ok(landing);
    assert.deepEqual(leaked(landing), []);
});
