// A page that navigates again right after "load" (script redirect to /login, auto-submitted form) used to crash the
// capture with "page.addStyleTag: Execution context was destroyed" (seen on GitHub's runners in capture-headers'
// R4-01 test; with an immediate script redirect it failed every time). capturePage now waits for the new document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PNG } from 'pngjs';
import { launchBrowser } from '../src/browser.js';
import { capturePage } from '../src/capture.js';

let browser; let server; let base;
before(async () => {
    server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        res.writeHead(200, { 'content-type': 'text/html' });
        if (u.pathname === '/now') return res.end(`<body>old<script>addEventListener('load', () => { location.href = '/landed'; })</script></body>`);
        if (u.pathname === '/later') return res.end(`<body>old<script>addEventListener('load', () => setTimeout(() => { location.href = '/landed'; }, 100))</script></body>`);
        if (u.pathname === '/form') return res.end(`<body><form method="post" action="/landed"><input name="a" value="1"></form><script>addEventListener('load', () => document.forms[0].submit())</script></body>`);
        if (u.pathname === '/loop') return res.end(`<body><script>addEventListener('load', () => { location.href = '/loop?n=' + Math.random(); })</script></body>`);
        // The landing page is red under a blue #cover; the capture hides #cover (--hide), so it must come out red.
        return res.end(`<style>html,body{margin:0;height:100%}body{background:rgb(255,0,0)}#cover{position:fixed;inset:0;background:rgb(0,0,255)}</style><body><div id="cover"></div></body>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    ({ browser } = await launchBrowser());
});
after(async () => { await browser?.close(); server?.close(); });

const centre = (png) => { const p = PNG.sync.read(png); const i = (p.width * Math.floor(p.height / 2) + Math.floor(p.width / 2)) * 4; return [...p.data.slice(i, i + 3)]; };

for (const [path, what] of [['/now', 'script redirect on load'], ['/later', 'script redirect 100 ms after load (during the waits)'], ['/form', 'form auto-submitted on load (POST)']]) {
    test(`a page that navigates after load (${what}) is captured on the page it lands on, with --hide applied there`, async () => {
        const r = await capturePage(browser, { url: base + path, width: 200, height: 120, delayMs: 400, hide: ['#cover'] });
        assert.equal(new URL(r.finalUrl).pathname, '/landed');
        assert.deepEqual(centre(r.png), [255, 0, 0]);
    });
}

test('a page that never stops navigating fails with a plain error instead of a Playwright stack', async () => {
    await assert.rejects(capturePage(browser, { url: `${base}/loop`, width: 200, height: 120, delayMs: 0 }), /kept navigating after it loaded/);
});
