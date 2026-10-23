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
 * @param {Record<string,string>} [o.headers] extra HTTP headers (e.g. Vercel protection bypass). Sent only to
 *   `o.headerOrigin`, never to third parties the page loads (fonts, analytics, CDNs) or redirects to.
 * @param {string} [o.headerOrigin] origin the headers are scoped to: the preview base URL's origin (default: o.url's)
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

const MAX_REDIRECTS = 10;
const isRedirect = (status) => status >= 300 && status < 400 && status !== 304;
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } /* data:, blob: */ };

/**
 * Add `headers` to requests for `origin` (scheme + host + port, the preview BASE origin) only.
 * - Not extraHTTPHeaders: that would hand secrets such as the Vercel bypass token to every host the page touches.
 * - Not route.continue({ headers }): Chromium keeps those headers when it follows a redirect, so a 3xx from the
 *   preview to another host would receive the secret.
 * Same-origin requests are fetched here with redirects off. Chromium does not route the hops of a redirect it
 * follows itself, so same-origin hops are followed here too (with the headers); a hop to another origin is handed to
 * the browser as the 3xx response, and the browser follows it without the headers.
 * The top-level document is special: its redirects must change page.url() (relative links, finalUrl), so while
 * `state.navigating` is set a same-origin redirect is recorded in `state.redirect` and capturePage navigates there.
 */
export async function scopeHeadersToOrigin(context, origin, headers, state = {}) {
    if (!headers || !Object.keys(headers).length) return;
    await context.route('**/*', async (route) => {
        const req = route.request();
        if (!sameOrigin(req.url(), origin)) return route.continue();
        // allHeaders() (not headers()) keeps the browser's Cookie header, e.g. Vercel's bypass cookie.
        const base = await req.allHeaders();
        const topLevel = state.navigating && req.isNavigationRequest() && !req.frame().parentFrame();
        let url = req.url();
        let response;
        for (let hop = 0; ; hop++) {
            try {
                response = await route.fetch({ url, headers: { ...base, ...headers }, maxRedirects: 0 });
            } catch {
                // Network failure: let the browser retry without the headers so it reports its own net:: error.
                return hop === 0 ? route.continue() : route.abort();
            }
            const location = isRedirect(response.status()) && response.headers().location;
            if (!location || hop >= MAX_REDIRECTS) break;
            const next = new URL(location, url).href;
            if (!sameOrigin(next, origin)) break; // browser follows it, without our headers
            if (topLevel) {
                state.redirect = next;
                return route.fulfill({ status: 200, contentType: 'text/html', body: '' });
            }
            url = next;
            if (req.method() !== 'GET' && [301, 302, 303].includes(response.status())) break; // let the browser apply method rewriting
        }
        return route.fulfill({ response });
    });
}

export async function capturePage(browser, o) {
    const hasHeaders = Boolean(o.headers && Object.keys(o.headers).length);
    const context = await browser.newContext({
        viewport: { width: Math.round(o.width), height: Math.round(o.height) },
        deviceScaleFactor: o.scale || 1,
        reducedMotion: 'reduce',
        colorScheme: o.colorScheme || 'light',
        ignoreHTTPSErrors: false,
        // Service-worker fetches bypass context.route(); block service workers so every request goes through the scope check.
        serviceWorkers: hasHeaders ? 'block' : 'allow',
    });
    // Scope to the preview base origin (o.headerOrigin), not to whatever URL this frame resolved to.
    const state = { navigating: true, redirect: null };
    if (hasHeaders) await scopeHeadersToOrigin(context, o.headerOrigin || new URL(o.url).origin, o.headers, state);
    const page = await context.newPage();
    try {
        let resp;
        let target = o.url;
        try {
            for (let hop = 0; ; hop++) {
                state.redirect = null;
                resp = await page.goto(target, { waitUntil: 'load', timeout: o.timeoutMs || 45000 });
                if (!state.redirect) break;
                if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
                target = state.redirect;
            }
        } catch (e) {
            throw new Error(describeNavigationError(o.url, e));
        } finally {
            state.navigating = false;
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
