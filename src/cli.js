// framedrift CLI
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseViewport, parseHeaders, parseNumber, UsageError } from './args.js';
import { launchBrowser } from './browser.js';
import { compareOne } from './compare.js';
import { FigmaClient, redactToken } from './figma.js';
import { writeReport } from './report.js';
import { loadConfigFile, assertSafeBase, previewHostAllowed, parseHostList, DEFAULT_PREVIEW_HOSTS } from './config.js';
import { redactText, redactDeep, registerSecret } from './redact.js';
import { runFrames } from './run.js';
import { resolveTier } from './license.js';
import { VERSION } from './version.js';
import { repoUrl } from './launch-config.js';
import { runDemo } from './demo.js';

const help = () => `framedrift ${VERSION} — diff a live page against the Figma frame it was built from

Usage
  framedrift compare --url <page-url> --figma <figma-frame-link> [options]
  framedrift compare --url <page-url> --design <design.png> [options]
  framedrift run --base-url <preview-url> [--config .framedrift.json] [options]
  framedrift demo     try it on a built-in fixture page (no Figma token, no network)

compare options
  --url            Page to capture (your Vercel preview, localhost, anything reachable)
  --figma          Figma frame link with node-id ("Copy link to selection" in Figma)
  --design         Local PNG to compare against instead of Figma
  --figma-token    Figma personal access token (or FIGMA_TOKEN env). Read-only scope is enough.
  --scale          Render scale for Figma export and browser DPR (default 1)
  --viewport       Override viewport, e.g. 1440x900 (default: the frame's size)
  --viewport-height  Real viewport height for tall frames (page captured full-length)
  --hide           CSS selector to hide before capture (repeatable), e.g. ".cookie-banner"
  --wait-for       CSS selector to wait for before capture
  --selector       Capture only this element (compare a component, not the whole page)
  --threshold      Per-pixel color tolerance 0..1 (default 0.1)
  --fail-on        Exit 1 when more than this % of pixels differ (default: never fail)
  --header         Extra HTTP header for the page, repeatable: "Name: value"
  --vercel-bypass  Vercel Deployment Protection bypass secret (or VERCEL_AUTOMATION_BYPASS_SECRET)
  --preview-host   Host the bypass secret may be sent to, repeatable (default *.vercel.app), e.g. preview.acme.dev
  --out            Output directory (default ./framedrift-report)
  --json           Print the result as JSON

run options
  --base-url       Preview deployment base URL; frame paths from the config are joined to it
  --config         Config file (default .framedrift.json)
  --license-key    framedrift Pro license key (or FRAMEDRIFT_LICENSE_KEY) — removes the 3-frame limit

Exit codes: 0 ok · 1 drift above --fail-on · 2 usage/config error · 3 runtime error
Docs: ${repoUrl()}`;

function bypassHeaders(args) {
    const secret = args.vercelBypass || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return secret ? { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' } : {};
}

const previewHosts = (args) => [...DEFAULT_PREVIEW_HOSTS, ...(args.previewHost || []).flatMap(parseHostList)];

/** N1 for `compare`: same rules as runFrames (loopback is fine on the CLI; metadata / link-local never are). */
function checkCompareTarget(url, headers, hosts) {
    if (!URL.canParse(url)) return; // capture reports "Invalid preview URL" itself
    assertSafeBase(url, { allowLoopback: true });
    if (headers['x-vercel-protection-bypass'] && !previewHostAllowed(url, hosts)) {
        throw new UsageError(`Refusing to send the Vercel bypass secret to ${new URL(url).hostname}: not in the preview host allowlist (${hosts.join(', ')}). Add --preview-host <host>.`);
    }
}

export async function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parseArgs(argv, { booleans: ['json', 'help', 'version', 'full-page'], arrays: ['hide', 'header', 'preview-host'], aliases: { h: 'help', v: 'version' } });
    } catch (e) { console.error(`framedrift: ${e.message}`); return 2; }
    if (args.version) { console.log(VERSION); return 0; }
    const cmd = args._[0];
    if (args.help || !cmd) { console.log(help()); return cmd || args.help ? 0 : 2; }
    const out = path.resolve(args.out || 'framedrift-report');
    const token = args.figmaToken || process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN;
    try {
        const failOn = parseNumber(args.failOn, 'fail-on', { min: 0, max: 100 }) ?? null;
        const threshold = parseNumber(args.threshold, 'threshold', { min: 0, max: 1 });
        const scale = parseNumber(args.scale, 'scale', { min: 0.01, max: 4 }) ?? 1;
        const viewportHeight = parseNumber(args.viewportHeight, 'viewport-height', { min: 1, max: 20000 });
        if (cmd === 'demo') {
            const { result: r, report: rep } = await runDemo({ outDir: out });
            if (args.json) console.log(JSON.stringify(redactDeep({ ...r, report: rep }), null, 2));
            else printResult(r, rep);
            return 0;
        }
        if (cmd === 'compare') {
            if (!args.url) { console.error('framedrift: --url is required'); return 2; }
            if (!args.figma && !args.design) { console.error('framedrift: --figma <frame link> or --design <png> is required'); return 2; }
            if (args.figma && !token) { console.error('framedrift: a Figma token is required for --figma (FIGMA_TOKEN or --figma-token)'); return 2; }
            if (args.design && !fs.existsSync(args.design)) { console.error(`framedrift: design file not found: ${args.design}`); return 2; }
            const headers = { ...parseHeaders(args.header), ...bypassHeaders(args) };
            for (const v of Object.values(headers)) if (v !== 'true') registerSecret(v);
            checkCompareTarget(args.url, headers, previewHosts(args));
            const { browser, via } = await launchBrowser();
            let r;
            try {
                if (!args.json) console.error(`browser: ${via}`);
                r = await compareOne({
                    browser, client: args.figma ? new FigmaClient({ token, onLog: (m) => console.error(m) }) : null,
                    url: args.url, figma: args.figma, design: args.design, outDir: out,
                    scale, threshold: threshold ?? 0.1,
                    viewport: parseViewport(args.viewport), viewportHeight,
                    hide: args.hide, waitFor: args.waitFor, selector: args.selector, fullPage: args.fullPage,
                    headers,
                });
            } finally { await browser.close(); }
            const rep = writeReport(out, [r], { failOn: failOn ?? 2, tier: 'free' });
            if (args.json) console.log(JSON.stringify(redactDeep({ ...r, report: rep }), null, 2));
            else printResult(r, rep);
            return failOn !== null && r.mismatchPercent > failOn ? 1 : 0;
        }
        if (cmd === 'run') {
            if (!args.baseUrl) { console.error('framedrift: --base-url is required'); return 2; }
            const cfgPath = path.resolve(args.config || '.framedrift.json');
            if (!fs.existsSync(cfgPath)) { console.error(`framedrift: config file not found: ${cfgPath}`); return 2; }
            const { frames, defaults } = loadConfigFile(cfgPath);
            if (!frames.length) { console.error(`framedrift: no frames in ${cfgPath}`); return 2; }
            if (frames.some((f) => f.figma) && !token) { console.error('framedrift: a Figma token is required for Figma frames (FIGMA_TOKEN or --figma-token)'); return 2; }
            const lic = await resolveTier(args.licenseKey || process.env.FRAMEDRIFT_LICENSE_KEY);
            console.error(`tier: ${lic.tier} (${lic.reason})`);
            const res = await runFrames({ baseUrl: args.baseUrl, frames, defaults, figmaToken: token, tier: lic.tier, failOn: failOn ?? undefined, threshold, scale, outDir: out, headers: { ...parseHeaders(args.header), ...bypassHeaders(args) }, log: (m) => console.error(m), allowLoopback: true, previewHosts: previewHosts(args) });
            console.log(fs.readFileSync(res.report.markdown, 'utf8'));
            console.log(`\nreport: ${res.report.html}`);
            // Any failed comparison is a runtime error (exit 3), even if other frames were clean.
            if (res.errors.length) return 3;
            return failOn !== null && res.failing.length ? 1 : 0;
        }
        console.error(`framedrift: unknown command "${cmd}"\n\n${help()}`);
        return 2;
    } catch (e) {
        if (e instanceof UsageError || e.message?.startsWith('Invalid viewport') || e.message?.startsWith('Invalid header')) { console.error(`framedrift: ${redactText(redactToken(e.message))}`); return 2; }
        console.error(`framedrift: ${redactText(redactToken(e.message))}`);
        return 3;
    }
}

function printResult(r, rep) {
    const size = r.sizeMismatch ? ` — size differs: design ${r.designSize.width}×${r.designSize.height}, page ${r.actualSize.width}×${r.actualSize.height}` : '';
    console.log(`${r.mismatchPercent}% of pixels differ (${r.mismatchedPixels.toLocaleString('en-US')} px)${size}`);
    for (const [i, h] of r.hotspots.slice(0, 8).entries()) {
        const where = `${Math.round(h.x / r.scale)},${Math.round(h.y / r.scale)} ${Math.round(h.width / r.scale)}×${Math.round(h.height / r.scale)}`;
        console.log(`  ${i + 1}. ${h.layer ? `${h.layer.path}${h.layer.component ? ` (${h.layer.component})` : ''}` : 'region'} @ ${where} — ${h.pixels} px`);
    }
    console.log(`report: ${rep.html}`);
}
