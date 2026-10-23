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
 * @param {Record<string,string>} [o.headers] extra HTTP headers (e.g. Vercel protection bypass). Sent only to the
 *   preview's own origin, never to third parties the page loads (fonts, analytics, CDNs) or redirects to.
 * @param {'light'|'dark'} [o.colorScheme]
 */
/** Turn Playwright's multi-line navigation errors into one actionable sentence. */
export function describeNavigationError(url, err) {
    const msg = String(err?.message || err);
    const code = msg.match(/net::(ERR_[A-Z_]+)/)?.[1];
    if (code) {
        const hints = {
            ERR_CONNECTION_REFUSED: 'nothing is listening there — is the preview/dev server running?',
            ERR_NAME_NOT_RESOLVED: 'the host name does not resolve — check the URL (has the preview deployment finished?)',
            ERR_CONNECTION_TIMED_OUT: 'the connection timed out',
            ERR_CERT_AUTHORITY_INVALID: 'the TLS certificate is not trusted',
            ERR_INTERNET_DISCONNECTED: 'this machine is offline',
        };
        return `Could not reach preview ${url}: ${code}${hints[code] ? ` (${hints[code]})` : ''}`;
    }
    if (err?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) return `Preview ${url} did not finish loading in time (${msg.match(/Timeout (\d+)ms/)?.[1] || '?'} ms)`;
    if (/Cannot navigate to invalid URL|invalid URL/i.test(msg)) return `Invalid preview URL: ${url}`;
    return `Could not load preview ${url}: ${msg.split('\n')[0]}`;
}

async function waitForSelectorOrExplain(page, selector, option) {
    try {
        return await page.waitForSelector(selector, { timeout: 15000 });
    } catch (e) {
        throw new Error(`${option} "${selector}" did not appear on ${page.url()} within 15s${/Timeout/.test(e.message) ? '' : `: ${e.message.split('\n')[0]}`}`);
    }
}

/**
 * Add `headers` to requests for `previewUrl`'s exact origin (scheme + host + port) only.
 * Not extraHTTPHeaders: that would hand secrets such as the Vercel bypass token to every host the page touches.
 * Not route.continue({ headers }) either: Chromium keeps those headers when it follows a redirect, so a 3xx from the
 * preview to another host would receive the secret. Instead, same-origin requests are fetched with redirects off and
 * the response is handed to the browser; the browser follows any redirect itself, and that request is checked again.
 */
export async function scopeHeadersToOrigin(context, previewUrl, headers) {
    if (!headers || !Object.keys(headers).length) return;
    const origin = new URL(previewUrl).origin;
    await context.route('**/*', async (route) => {
        const req = route.request();
        let sameOrigin = false;
        try { sameOrigin = new URL(req.url()).origin === origin; } catch { /* data:, blob: etc. */ }
        if (!sameOrigin) return route.continue();
        let response;
        try {
            // allHeaders() (not headers()) keeps the browser's Cookie header, e.g. Vercel's bypass cookie.
            response = await route.fetch({ headers: { ...(await req.allHeaders()), ...headers }, maxRedirects: 0 });
        } catch {
            // Network failure: let the browser retry without the headers so it reports its own net:: error.
            return route.continue();
        }
        return route.fulfill({ response });
    });
}

export async function capturePage(browser, o) {
    const context = await browser.newContext({
        viewport: { width: Math.round(o.width), height: Math.round(o.height) },
        deviceScaleFactor: o.scale || 1,
        reducedMotion: 'reduce',
        colorScheme: o.colorScheme || 'light',
        ignoreHTTPSErrors: false,
        // Service-worker fetches bypass context.route(); block service workers so every request goes through the scope check.
        serviceWorkers: o.headers && Object.keys(o.headers).length ? 'block' : 'allow',
    });
    await scopeHeadersToOrigin(context, o.url, o.headers);
    const page = await context.newPage();
    try {
        let resp;
        try {
            resp = await page.goto(o.url, { waitUntil: 'load', timeout: o.timeoutMs || 45000 });
        } catch (e) {
            throw new Error(describeNavigationError(o.url, e));
        }
        const status = resp ? resp.status() : null;
        if (status && status >= 400) {
            const hint = status === 401 || status === 403 ? ' (Vercel Deployment Protection? pass a protection bypass secret: --vercel-bypass / VERCEL_AUTOMATION_BYPASS_SECRET)' : '';
            throw new Error(`Preview URL answered HTTP ${status}${hint}`);
        }
        await page.addStyleTag({ content: STABILIZE_CSS });
        if (o.hide?.length) await page.addStyleTag({ content: `${o.hide.join(', ')} { visibility: hidden !important; }` });
        if (o.waitFor) await waitForSelectorOrExplain(page, o.waitFor, '--wait-for');
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(o.delayMs ?? 300);
        let png;
        if (o.selector) {
            const el = await waitForSelectorOrExplain(page, o.selector, '--selector');
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
