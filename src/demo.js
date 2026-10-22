// `framedrift demo`: a full comparison with no Figma token and no network.
// The "design" is the fixture page rendered as intended; the "preview" is the same page with
// two deliberate mistakes, served from a local HTTP server. Hotspots are labelled using the
// fixture's Figma-shaped layer tree (demo/frame.json), exactly as they would be for a real frame.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { compareOne } from './compare.js';
import { LOGIN_HTML } from './demo-page.js';
import { writeReport } from './report.js';

const FRAME = JSON.parse(fs.readFileSync(new URL('../demo/frame.json', import.meta.url), 'utf8'));

export async function runDemo({ outDir, log = console.error }) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML({ drift: true }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/login`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framedrift-demo-'));
    const { browser, via } = await launchBrowser();
    log(`browser: ${via}`);
    try {
        // Render the intended design with the same browser, so only the deliberate mistakes differ.
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        await page.setContent(LOGIN_HTML({ drift: false }), { waitUntil: 'load' });
        const designPath = path.join(tmp, 'design.png');
        fs.writeFileSync(designPath, await page.screenshot({ type: 'png' }));
        await ctx.close();
        log(`demo preview: ${url} (local server; the page has a taller, re-coloured button and a changed title)`);
        const r = await compareOne({ browser, url, design: designPath, designFrame: FRAME, name: FRAME.name, outDir, threshold: 0.1 });
        const report = writeReport(outDir, [r], { failOn: 2, tier: 'free', title: 'framedrift demo · design drift report', notes: ['Demo run on a built-in fixture page, not a real project. Run `framedrift compare --url … --figma …` on your own preview next.'] });
        return { result: r, report };
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
