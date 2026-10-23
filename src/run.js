// Run several frame comparisons against one base URL (used by `framedrift run` and the Action).
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { compareOne, slugify } from './compare.js';
import { FigmaClient, redactToken } from './figma.js';
import { joinUrl, checkNumbers, assertSafeBase, assertBypassTarget, DEFAULT_PREVIEW_HOSTS } from './config.js';
import { UsageError } from './args.js';
import { FREE_FRAME_LIMIT } from './license.js';
import { upgradeUrl } from './launch-config.js';
import { writeReport } from './report.js';
import { displayUrl, redactText, registerSecret } from './redact.js';

/**
 * Precedence for failOn / threshold (most specific wins): frame in .framedrift.json > explicit CLI flag / Action
 * input (`failOn`, `threshold` here) > `defaults` in .framedrift.json > built-in (2 / 0.1).
 * `rejected` are pre-made error rows (e.g. frames outside the figma-files allowlist); they count as errors.
 * `allowLoopback`: allow a localhost / 127.0.0.1 base (CLI local dev). Link-local and metadata hosts are always refused.
 * `previewHosts`: hosts the Vercel bypass secret may go to (default `*.vercel.app`; see config.resolvePreviewHosts);
 * checked only when it is set, together with https on the default port (R4-03).
 */
export async function runFrames({ baseUrl, frames, figmaToken, tier = 'free', failOn, threshold, outDir, headers = {}, scale = 1, log = console.error, defaults = {}, rejected = [], allowLoopback = false, previewHosts = DEFAULT_PREVIEW_HOSTS }) {
    // R68-02: the public API validates its settings, like the CLI and .framedrift.json do (a typo must not
    // silently become "never fails").
    failOn = failOn ?? undefined; threshold = threshold ?? undefined; // null = "not set", like undefined
    checkNumbers({ failOn, threshold }, 'runFrames options', '');
    checkNumbers(defaults, 'defaults', '');
    for (const [i, f] of (frames || []).entries()) checkNumbers(f, `frames[${i}]`, '');
    // R68-03: header values are secrets; every later log line and report string is scrubbed of them.
    for (const v of Object.values(headers || {})) if (v !== 'true') registerSecret(String(v));
    log = ((raw) => (m) => raw(redactText(m)))(log);
    // N1: never aim the runner at loopback / link-local / metadata hosts, and never send the bypass secret to a
    // host outside the allowlist.
    let base;
    try { base = assertSafeBase(baseUrl, { allowLoopback }); } catch (e) { throw new UsageError(redactText(e.message)); }
    if (headers?.['x-vercel-protection-bypass']) assertBypassTarget(base.href, previewHosts, 'Set vercel-project / vercel-team or preview-hosts (Action), --vercel-project / --vercel-team or --preview-host (CLI).');
    failOn = failOn ?? defaults.failOn ?? 2;
    threshold = threshold ?? defaults.threshold ?? 0.1;
    // Headers (Vercel bypass secret, --header) are only ever sent to the preview base origin.
    const headerOrigin = new URL(baseUrl).origin;
    const notes = [];
    let todo = frames;
    if (tier !== 'pro' && frames.length > FREE_FRAME_LIMIT) {
        todo = frames.slice(0, FREE_FRAME_LIMIT);
        notes.push(`Free tier compares up to ${FREE_FRAME_LIMIT} frames per run; ${frames.length - FREE_FRAME_LIMIT} more were skipped. framedrift Pro ($12/month per repo) removes the limit: ${upgradeUrl()}`);
    }
    const needsFigma = todo.some((f) => f.figma);
    if (needsFigma && !figmaToken) throw new UsageError('A Figma token is required (FIGMA_TOKEN or --figma-token). Create a read-only personal access token with the file_content:read scope.');
    const client = needsFigma ? new FigmaClient({ token: figmaToken, onLog: log }) : null;
    const { browser, via } = await launchBrowser();
    log(`browser: ${via}`);
    const results = [...rejected];
    try {
        for (const [i, f] of todo.entries()) {
            const name = f.name || `${f.path || '/'}`;
            // R4-02: the folder name ends up in the artifact and in results.json `files`; redact before slugging.
            const dir = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${slugify(redactText(name))}`);
            let url = null;
            try {
                url = joinUrl(baseUrl, f.path || '/', { allowLoopback });
                log(`[${i + 1}/${todo.length}] ${displayUrl(url)}  vs  ${f.figma || f.design}`);
                const r = await compareOne({
                    browser, client, url, figma: f.figma, design: f.design, outDir: dir,
                    name: f.name, scale: f.scale ?? defaults.scale ?? scale,
                    threshold: f.threshold ?? threshold,
                    viewportHeight: f.viewportHeight ?? defaults.viewportHeight,
                    hide: [...(defaults.hide || []), ...(f.hide || [])],
                    waitFor: f.waitFor ?? defaults.waitFor, delayMs: f.delayMs ?? defaults.delayMs,
                    selector: f.selector, headers, headerOrigin, colorScheme: f.colorScheme ?? defaults.colorScheme,
                });
                r.path = f.path || '/';
                r.failOn = f.failOn ?? failOn;
                results.push(r);
                log(`    ${r.mismatchPercent}% different, ${r.hotspots.length} region(s)`);
            } catch (e) {
                const msg = redactText(redactToken(String(e.message || e)).split('\n')[0]);
                log(`    error: ${msg}`);
                results.push({ name: f.name || f.path || '/', path: f.path || '/', url: displayUrl(url), error: msg, figma: null });
            }
        }
    } finally {
        await browser.close();
    }
    const report = writeReport(outDir, results, { failOn, tier, notes, previewUrl: baseUrl, title: 'framedrift · design drift report' });
    const failing = results.filter((r) => !r.error && r.mismatchPercent > (r.failOn ?? failOn));
    const errors = results.filter((r) => r.error);
    const maxMismatch = Math.max(0, ...results.filter((r) => !r.error).map((r) => r.mismatchPercent));
    return { results, report, notes, failing, errors, maxMismatch, skipped: frames.length - todo.length };
}
