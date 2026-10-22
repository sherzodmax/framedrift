// Screenshot a page so it is comparable with a Figma frame render.
// Deterministic-ish: animations/transitions/caret off, fonts awaited, fixed DPR.

const STABILIZE_CSS = `
*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }
`;

/**
 * @param {import('playwright-core').Browser} browser
 * @param {object} o
 * @param {string} o.url
 * @param {number} o.width   CSS px viewport width (= Figma frame width)
 * @param {number} o.height  CSS px viewport height (= Figma frame height)
 * @param {number} [o.scale=1] deviceScaleFactor (= Figma export scale)
 * @param {boolean} [o.fullPage=false] capture the whole page instead of the first viewport
 * @param {string} [o.selector] capture only this element
 * @param {string[]} [o.hide] CSS selectors to hide (visibility:hidden) before capture
 * @param {string} [o.waitFor] CSS selector to wait for
 * @param {number} [o.delayMs=300]
 * @param {Record<string,string>} [o.headers] extra HTTP headers (e.g. Vercel protection bypass)
 * @param {'light'|'dark'} [o.colorScheme]
 */
export async function capturePage(browser, o) {
    const context = await browser.newContext({
        viewport: { width: Math.round(o.width), height: Math.round(o.height) },
        deviceScaleFactor: o.scale || 1,
        reducedMotion: 'reduce',
        colorScheme: o.colorScheme || 'light',
        extraHTTPHeaders: o.headers || {},
        ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    try {
        const resp = await page.goto(o.url, { waitUntil: 'load', timeout: o.timeoutMs || 45000 });
        const status = resp ? resp.status() : null;
        if (status && status >= 400) {
            const hint = status === 401 || status === 403 ? ' (Vercel Deployment Protection? pass a protection bypass secret: --vercel-bypass / VERCEL_AUTOMATION_BYPASS_SECRET)' : '';
            throw new Error(`Preview URL answered HTTP ${status}${hint}`);
        }
        await page.addStyleTag({ content: STABILIZE_CSS });
        if (o.hide?.length) await page.addStyleTag({ content: `${o.hide.join(', ')} { visibility: hidden !important; }` });
        if (o.waitFor) await page.waitForSelector(o.waitFor, { timeout: 15000 });
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(o.delayMs ?? 300);
        let png;
        if (o.selector) {
            const el = await page.waitForSelector(o.selector, { timeout: 15000 });
            png = await el.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
        } else {
            png = await page.screenshot({ type: 'png', fullPage: Boolean(o.fullPage), animations: 'disabled', caret: 'hide' });
        }
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        return { png, status, finalUrl: page.url(), pageHeight };
    } finally {
        await context.close().catch(() => {});
    }
}
