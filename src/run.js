// Run several frame comparisons against one base URL (used by `framedrift run` and the Action).
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { compareOne, slugify } from './compare.js';
import { FigmaClient, redactToken } from './figma.js';
import { joinUrl } from './config.js';
import { UsageError } from './args.js';
import { FREE_FRAME_LIMIT } from './license.js';
import { upgradeUrl } from './launch-config.js';
import { writeReport } from './report.js';

export async function runFrames({ baseUrl, frames, figmaToken, tier = 'free', failOn = 2, threshold = 0.1, outDir, headers = {}, scale = 1, log = console.error, defaults = {} }) {
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
    const results = [];
    try {
        for (const [i, f] of todo.entries()) {
            const url = joinUrl(baseUrl, f.path || '/');
            const name = f.name || `${f.path || '/'}`;
            const dir = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${slugify(name)}`);
            log(`[${i + 1}/${todo.length}] ${url}  vs  ${f.figma || f.design}`);
            try {
                const r = await compareOne({
                    browser, client, url, figma: f.figma, design: f.design, outDir: dir,
                    name: f.name, scale: f.scale ?? defaults.scale ?? scale,
                    threshold: f.threshold ?? defaults.threshold ?? threshold,
                    viewportHeight: f.viewportHeight ?? defaults.viewportHeight,
                    hide: [...(defaults.hide || []), ...(f.hide || [])],
                    waitFor: f.waitFor ?? defaults.waitFor, delayMs: f.delayMs ?? defaults.delayMs,
                    selector: f.selector, headers, colorScheme: f.colorScheme ?? defaults.colorScheme,
                });
                r.path = f.path || '/';
                r.failOn = f.failOn ?? defaults.failOn ?? failOn;
                results.push(r);
                log(`    ${r.mismatchPercent}% different, ${r.hotspots.length} region(s)`);
            } catch (e) {
                const msg = redactToken(String(e.message || e)).split('\n')[0];
                log(`    error: ${msg}`);
                results.push({ name: f.name || f.path || '/', path: f.path || '/', url, error: msg, figma: f.figma ? { url: f.figma } : null });
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
