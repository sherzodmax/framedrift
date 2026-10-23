// framedrift CLI
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseViewport, parseHeaders, parseNumber, UsageError } from './args.js';
import { launchBrowser } from './browser.js';
import { compareOne } from './compare.js';
import { FigmaClient, redactToken } from './figma.js';
import { writeReport } from './report.js';
import { loadConfigFile, assertSafeBase, assertBypassTarget, parseHostList, resolvePreviewHosts } from './config.js';
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
  --vercel-project Vercel project name: the bypass secret only goes to its preview URLs (or FRAMEDRIFT_VERCEL_PROJECT)
  --vercel-team    Vercel team / account slug, narrows that to <project>-<hash>-<team> / <project>-git-*-<team>.vercel.app (or FRAMEDRIFT_VERCEL_TEAM)
  --preview-host   Host the bypass secret may be sent to, repeatable; replaces the default, e.g. preview.acme.dev
                   (default: the --vercel-project hosts, else any *.vercel.app; https on port 443 is always required)
  --out            Output directory (default ./framedrift-report)
  --json           Print the result as JSON

run options
  --base-url       Preview deployment base URL; frame paths from the config are joined to it
  --config         Config file (default .framedrift.json)
  --license-key    framedrift Pro license key (or FRAMEDRIFT_LICENSE_KEY) — removes the 3-frame limit

Exit codes: 0 ok · 1 drift above --fail-on · 2 usage/config error · 3 runtime error
Docs: ${repoUrl()}`;

// C70-01: every line the CLI prints (usage errors, paths, frame and Figma layer names, logs, the summary) goes through
// the shared redactor. File paths stay raw for file I/O and are only redacted here, on the way out (R5-04).
const say = (...a) => console.log(redactText(a.join(' ')));
const warn = (...a) => console.error(redactText(a.join(' ')));

function bypassHeaders(args) {
    const secret = args.vercelBypass || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return secret ? { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' } : {};
}

// R4-03: --preview-host replaces the default; else the Vercel project's own hosts; else *.vercel.app (with a warning).
function previewHosts(args) {
    const r = resolvePreviewHosts({ hosts: (args.previewHost || []).flatMap(parseHostList), project: args.vercelProject || process.env.FRAMEDRIFT_VERCEL_PROJECT, team: args.vercelTeam || process.env.FRAMEDRIFT_VERCEL_TEAM });
    if (r.source === 'default' && Object.keys(bypassHeaders(args)).length) warn('framedrift: warning: the bypass secret may go to any Vercel project (*.vercel.app); pass --vercel-project/--vercel-team or --preview-host to narrow it.');
    return r.hosts;
}

/** N1 for `compare`: same rules as runFrames (loopback is fine on the CLI; metadata / link-local never are). */
function checkCompareTarget(url, headers, hosts) {
    if (!URL.canParse(url)) return; // capture reports "Invalid preview URL" itself
    assertSafeBase(url, { allowLoopback: true });
    if (headers['x-vercel-protection-bypass']) assertBypassTarget(url, hosts, 'Pass --vercel-project / --vercel-team or --preview-host <host>.');
}

export async function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parseArgs(argv, { booleans: ['json', 'help', 'version', 'full-page'], arrays: ['hide', 'header', 'preview-host'], aliases: { h: 'help', v: 'version' } });
    } catch (e) { warn(`framedrift: ${e.message}`); return 2; }
    if (args.version) { say(VERSION); return 0; }
    const cmd = args._[0];
    if (args.help || !cmd) { say(help()); return cmd || args.help ? 0 : 2; }
    const out = path.resolve(args.out || 'framedrift-report');
    const token = args.figmaToken || process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN;
    try {
        const failOn = parseNumber(args.failOn, 'fail-on', { min: 0, max: 100 }) ?? null;
        const threshold = parseNumber(args.threshold, 'threshold', { min: 0, max: 1 });
        const scale = parseNumber(args.scale, 'scale', { min: 0.01, max: 4 }) ?? 1;
        const viewportHeight = parseNumber(args.viewportHeight, 'viewport-height', { min: 1, max: 20000 });
        if (cmd === 'demo') {
            const { result: r, report: rep } = await runDemo({ outDir: out });
            if (args.json) say(JSON.stringify(redactDeep({ ...r, report: rep }), null, 2));
            else printResult(r, rep);
            return 0;
        }
        if (cmd === 'compare') {
            if (!args.url) { warn('framedrift: --url is required'); return 2; }
            if (!args.figma && !args.design) { warn('framedrift: --figma <frame link> or --design <png> is required'); return 2; }
            if (args.figma && !token) { warn('framedrift: a Figma token is required for --figma (FIGMA_TOKEN or --figma-token)'); return 2; }
            if (args.design && !fs.existsSync(args.design)) { warn(`framedrift: design file not found: ${args.design}`); return 2; }
            const headers = { ...parseHeaders(args.header), ...bypassHeaders(args) };
            for (const v of Object.values(headers)) if (v !== 'true') registerSecret(v);
            checkCompareTarget(args.url, headers, previewHosts(args));
            const { browser, via } = await launchBrowser();
            let r;
            try {
                if (!args.json) warn(`browser: ${via}`);
                r = await compareOne({
                    browser, client: args.figma ? new FigmaClient({ token, onLog: (m) => warn(m) }) : null,
                    url: args.url, figma: args.figma, design: args.design, outDir: out,
                    scale, threshold: threshold ?? 0.1,
                    viewport: parseViewport(args.viewport), viewportHeight,
                    hide: args.hide, waitFor: args.waitFor, selector: args.selector, fullPage: args.fullPage,
                    headers,
                });
            } finally { await browser.close(); }
            const rep = writeReport(out, [r], { failOn: failOn ?? 2, tier: 'free' });
            if (args.json) say(JSON.stringify(redactDeep({ ...r, report: rep }), null, 2));
            else printResult(r, rep);
            return failOn !== null && r.mismatchPercent > failOn ? 1 : 0;
        }
        if (cmd === 'run') {
            if (!args.baseUrl) { warn('framedrift: --base-url is required'); return 2; }
            const cfgPath = path.resolve(args.config || '.framedrift.json');
            if (!fs.existsSync(cfgPath)) { warn(`framedrift: config file not found: ${cfgPath}`); return 2; }
            const { frames, defaults } = loadConfigFile(cfgPath);
            if (!frames.length) { warn(`framedrift: no frames in ${cfgPath}`); return 2; }
            if (frames.some((f) => f.figma) && !token) { warn('framedrift: a Figma token is required for Figma frames (FIGMA_TOKEN or --figma-token)'); return 2; }
            const lic = await resolveTier(args.licenseKey || process.env.FRAMEDRIFT_LICENSE_KEY);
            warn(`tier: ${lic.tier} (${lic.reason})`);
            const res = await runFrames({ baseUrl: args.baseUrl, frames, defaults, figmaToken: token, tier: lic.tier, failOn: failOn ?? undefined, threshold, scale, outDir: out, headers: { ...parseHeaders(args.header), ...bypassHeaders(args) }, log: (m) => warn(m), allowLoopback: true, previewHosts: previewHosts(args) });
            say(fs.readFileSync(res.report.markdown, 'utf8'));
            say(`\nreport: ${res.report.html}`);
            // Any failed comparison is a runtime error (exit 3), even if other frames were clean.
            if (res.errors.length) return 3;
            return failOn !== null && res.failing.length ? 1 : 0;
        }
        warn(`framedrift: unknown command "${cmd}"\n\n${help()}`);
        return 2;
    } catch (e) {
        if (e instanceof UsageError || e.message?.startsWith('Invalid viewport') || e.message?.startsWith('Invalid header')) { warn(`framedrift: ${redactToken(e.message)}`); return 2; }
        warn(`framedrift: ${redactToken(e.message)}`);
        return 3;
    }
}

function printResult(r, rep) {
    const size = r.sizeMismatch ? ` — size differs: design ${r.designSize.width}×${r.designSize.height}, page ${r.actualSize.width}×${r.actualSize.height}` : '';
    say(`${r.mismatchPercent}% of pixels differ (${r.mismatchedPixels.toLocaleString('en-US')} px)${size}`);
    for (const [i, h] of r.hotspots.slice(0, 8).entries()) {
        const where = `${Math.round(h.x / r.scale)},${Math.round(h.y / r.scale)} ${Math.round(h.width / r.scale)}×${Math.round(h.height / r.scale)}`;
        say(`  ${i + 1}. ${h.layer ? `${h.layer.path}${h.layer.component ? ` (${h.layer.component})` : ''}` : 'region'} @ ${where} — ${h.pixels} px`);
    }
    say(`report: ${rep.html}`);
}
