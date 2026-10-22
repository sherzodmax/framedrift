// Build the E2E design fixtures deterministically by rendering HTML with the same browser
// framedrift uses. (Stand-ins for Figma renders: we cannot call Figma without a token.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../src/browser.js';
import { LOGIN_HTML } from './pages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'fixtures');
fs.mkdirSync(out, { recursive: true });
const { browser } = await launchBrowser();
async function render(html, width, height, file) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(out, file), await page.screenshot({ type: 'png' }));
    await ctx.close();
    console.log(`wrote ${file}`);
}
// 1) "Designer's version" of example.com: same layout plus an H1 the live page does not have.
const live = await (await fetch('https://example.com/')).text();
const designed = live.replace('<body>', '<body><h1 style="margin:0 0 12px;font:600 28px/1.2 system-ui,sans-serif">Example Domain</h1>');
await render(designed, 1280, 720, 'example-design-with-h1.png');
// 2) Truth for the mocked Figma "Login" frame (fixture node 20:1, 390×844).
await render(LOGIN_HTML({ drift: false }), 390, 844, 'login-figma-render.png');
await browser.close();
