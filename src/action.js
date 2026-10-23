// GitHub Action entry point (see action.yml). Step 1 of 3: run comparisons, write report + comment body.
// Never fails the job by itself; the gate is applied in the last step (src/action-gate.js)
// so the report artifact and PR comment are always produced first.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfigFile, parsePrBody, mergeFrames, applyFigmaAllowlist, parseHostList, resolvePreviewHosts } from './config.js';
import { runFrames } from './run.js';
import { resolveTier } from './license.js';
import { GitHub } from './github.js';
import { redactToken } from './figma.js';
import { upgradeUrl } from './launch-config.js';
import { displayUrl, redactText, registerSecret } from './redact.js';
import { UsageError } from './args.js';

const input = (name, def = '') => { const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]; return v === undefined || v === '' ? def : v.trim(); };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
// Every log line goes through the shared redactor (R68-03): preview URLs, frame paths and errors can carry secrets.
const log = (m) => console.log(redactText(m));
const fail = (m) => { console.log(`::error::framedrift: ${redactText(redactToken(m))}`); setOutput('gate', 'error'); return 1; };

/**
 * Gate recorded for the last step. Any failed comparison (preview 500, Figma error, rejected frame) is an
 * error: a clean frame next to a broken one must not pass the check. Drift fails only on Pro.
 */
export function decideGate(res, tier) {
    if (res.errors.length) return 'error';
    return res.failing.length && tier === 'pro' ? 'fail' : 'pass';
}

/** Find the PR for this run. GitHub API failures (token scope, rate limits, outages) are a warning, not a crash. */
export async function findPullRequest({ event, gh, log = console.log }) {
    if (event.pull_request) return event.pull_request;
    const sha = event.deployment?.sha || process.env.GITHUB_SHA;
    if (!gh || !sha) return null;
    try {
        const prs = await gh.pullsForCommit(sha);
        return prs.length ? await gh.getPull(prs[0].number) : null;
    } catch (e) {
        log(`::warning::framedrift could not look up the pull request (PR-description frames and the PR comment are skipped): ${redactToken(e.message)}`);
        return null;
    }
}

export async function runAction() {
    const event = process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const eventName = process.env.GITHUB_EVENT_NAME || '';
    const outDir = path.resolve(input('report-dir', path.join(process.env.RUNNER_TEMP || '.', 'framedrift-report')));
    setOutput('report-dir', outDir);

    if (eventName === 'deployment_status' && event.deployment_status?.state !== 'success') {
        log(`Deployment state is "${event.deployment_status?.state}"; waiting for a successful deployment.`);
        setOutput('skipped', 'true');
        return 0;
    }
    const bypass = input('vercel-bypass-secret');
    registerSecret(bypass);
    const previewUrl = input('preview-url') || event.deployment_status?.environment_url || event.deployment_status?.target_url || event.deployment?.payload?.web_url;
    if (!previewUrl) { console.log('::error::No preview URL. Run on "deployment_status" (Vercel GitHub integration) or set the preview-url input.'); setOutput('gate', 'error'); return 0; }

    const gh = input('github-token') ? new GitHub({ token: input('github-token') }) : null;
    const pr = await findPullRequest({ event, gh, log });
    // N6: a typo'd `config` path is an error, not "zero frames, skipped". The default path may be absent (frames can
    // come from the PR description only), but then it is said out loud.
    const configInput = input('config');
    const configPath = configInput || '.framedrift.json';
    if (!fs.existsSync(configPath)) {
        if (configInput) return fail(`config file ${configInput} not found (the "config" input). Fix the path or remove the input.`);
        log(`::warning::framedrift: no ${configPath} in the checked-out commit; only frames from the PR description are used.`);
    }
    let cfg;
    try { cfg = loadConfigFile(configPath); } catch (e) { return fail(e.message); }
    const { frames: cfgFrames, defaults } = cfg;
    const prFrames = parsePrBody(pr?.body, { onIgnored: (line, why) => log(`::warning::framedrift: ignored PR-description line ${JSON.stringify(line.slice(0, 200))}: ${why}`) });
    const merged = mergeFrames(cfgFrames, prFrames);
    const { allowed: frames, rejected } = applyFigmaAllowlist(merged, input('figma-files'));
    if (!input('figma-files') && merged.some((f) => f.figma)) log('::notice::framedrift: set the figma-files input to the Figma file keys this repo may render; otherwise any file the figma-token can read can be linked from a PR description.');
    if (!frames.length && !rejected.length) {
        // N6: no silent green. A check that compared nothing must not pass.
        return fail(`no frames to compare (config ${configPath}${fs.existsSync(configPath) ? ' has no frames' : ' not found'}, no framedrift: lines in the PR description). Add frames to .framedrift.json or a line like "framedrift: /login https://www.figma.com/design/…?node-id=1-2" to the PR description.`);
    }
    if (frames.some((f) => f.figma) && !input('figma-token')) {
        console.log('::error::framedrift: figma-token is empty. Create a read-only Figma personal access token, save it as the FIGMA_TOKEN repository secret, and pass `figma-token: ${{ secrets.FIGMA_TOKEN }}`.');
        setOutput('gate', 'error');
        return 1;
    }
    const lic = await resolveTier(input('license-key'));
    log(`framedrift tier: ${lic.tier} (${lic.reason})`);
    // Precedence: frame > input > .framedrift.json defaults > built-in (inputs default to empty in action.yml).
    const failOn = Number(input('fail-on', String(defaults.failOn ?? 2)));
    const threshold = Number(input('threshold', String(defaults.threshold ?? 0.1)));
    if (!Number.isFinite(failOn) || failOn < 0 || failOn > 100 || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return fail(`invalid fail-on "${input('fail-on')}" or threshold "${input('threshold')}" (fail-on: percent 0..100, threshold: 0..1).`);
    }
    const headers = bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {};
    // N1 / R4-03: the bypass secret only goes over https (default port) to allowlisted preview hosts: `preview-hosts`
    // if set, else the `vercel-project` (+ `vercel-team`) preview URLs, else any *.vercel.app (warned). Loopback
    // previews only with allow-loopback-preview (CI smoke tests); metadata / link-local never.
    let previewHosts;
    try {
        const r = resolvePreviewHosts({ hosts: parseHostList(input('preview-hosts')), project: input('vercel-project') || process.env.FRAMEDRIFT_VERCEL_PROJECT, team: input('vercel-team') || process.env.FRAMEDRIFT_VERCEL_TEAM });
        previewHosts = r.hosts;
        if (bypass && r.source === 'default') log('::warning::framedrift: the bypass secret may be sent to any Vercel project (*.vercel.app). Set the vercel-project (and vercel-team) inputs, or preview-hosts, so it only goes to your own previews.');
    } catch (e) { return fail(e.message); }
    const allowLoopback = input('allow-loopback-preview') === 'true';
    let res;
    try {
        res = await runFrames({ baseUrl: previewUrl, frames, rejected, defaults, figmaToken: input('figma-token'), tier: lic.tier, failOn, threshold, outDir, headers, log, previewHosts, allowLoopback });
    } catch (e) {
        if (e instanceof UsageError || e instanceof TypeError) return fail(e.message);
        throw e;
    }

    if (lic.tier !== 'pro' && res.failing.length) res.notes.push(`Drift above ${failOn}% found. framedrift Pro can fail this check (make it a required status check) — free runs only report. ${upgradeUrl()}`);
    fs.writeFileSync(path.join(outDir, 'pr-number'), pr ? String(pr.number) : '');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${fs.readFileSync(res.report.markdown, 'utf8')}\n`);
    setOutput('max-mismatch', String(res.maxMismatch));
    setOutput('pr-number', pr ? String(pr.number) : '');
    // Gate decision is recorded now and enforced by the last step.
    const gate = decideGate(res, lic.tier);
    setOutput('gate', gate);
    fs.writeFileSync(path.join(outDir, 'gate'), gate);
    fs.writeFileSync(path.join(outDir, 'notes.json'), JSON.stringify({ notes: res.notes, tier: lic.tier, failOn, previewUrl: displayUrl(previewUrl) }));
    log(`max mismatch ${res.maxMismatch}% · ${res.failing.length} frame(s) above ${failOn}% · ${res.errors.length} error(s) · gate=${gate}`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAction().then((c) => { process.exitCode = c; }).catch((e) => { process.exitCode = fail(e.message); });
}
