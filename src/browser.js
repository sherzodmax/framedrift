// Find a Chrome/Chromium to drive. Order:
// 1. FRAMEDRIFT_CHROME_PATH / CHROME_PATH   2. Playwright's own browsers (npx playwright install chromium)
// 3. Installed Google Chrome (channel "chrome"; preinstalled on GitHub's ubuntu-latest runners)
import fs from 'node:fs';
import { chromium } from 'playwright-core';

export async function launchBrowser({ headless = true } = {}) {
    const args = ['--disable-dev-shm-usage', '--font-render-hinting=none', '--hide-scrollbars'];
    const explicit = process.env.FRAMEDRIFT_CHROME_PATH || process.env.CHROME_PATH;
    const attempts = [];
    if (explicit) attempts.push({ label: `executable ${explicit}`, opts: { executablePath: explicit } });
    attempts.push({ label: 'Playwright-managed Chromium', opts: {} });
    attempts.push({ label: 'installed Google Chrome', opts: { channel: 'chrome' } });
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
        if (fs.existsSync(p)) attempts.push({ label: p, opts: { executablePath: p } });
    }
    const errors = [];
    for (const a of attempts) {
        try {
            const browser = await chromium.launch({ headless, args, ...a.opts });
            return { browser, via: a.label };
        } catch (e) {
            errors.push(`${a.label}: ${String(e.message).split('\n')[0]}`);
        }
    }
    throw new Error(`Could not start a browser. Install one with "npx playwright install chromium" or set FRAMEDRIFT_CHROME_PATH.\n  ${errors.join('\n  ')}`);
}
