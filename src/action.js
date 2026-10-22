// GitHub Action entry point (see action.yml). Step 1 of 3: run comparisons, write report + comment body.
// Never fails the job by itself; the gate is applied in the last step (src/action-gate.js)
// so the report artifact and PR comment are always produced first.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFile, parsePrBody, mergeFrames } from './config.js';
import { runFrames } from './run.js';
import { resolveTier } from './license.js';
import { GitHub } from './github.js';
import { redactToken } from './figma.js';

const input = (name, def = '') => { const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]; return v === undefined || v === '' ? def : v.trim(); };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const log = (m) => console.log(m);

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
    const previewUrl = input('preview-url') || event.deployment_status?.environment_url || event.deployment_status?.target_url || event.deployment?.payload?.web_url;
    if (!previewUrl) { console.log('::error::No preview URL. Run on "deployment_status" (Vercel GitHub integration) or set the preview-url input.'); setOutput('gate', 'error'); return 0; }

    const gh = new GitHub({ token: input('github-token') });
    let pr = event.pull_request || null;
    if (!pr) {
        const sha = event.deployment?.sha || process.env.GITHUB_SHA;
        const prs = sha ? await gh.pullsForCommit(sha) : [];
        if (prs.length) pr = await gh.getPull(prs[0].number);
    }
    const { frames: cfgFrames, defaults } = loadConfigFile(input('config', '.framedrift.json'));
    const frames = mergeFrames(cfgFrames, parsePrBody(pr?.body));
    if (!frames.length) {
        log('No frames to compare: add a .framedrift.json or a line like "framedrift: /login https://www.figma.com/design/…?node-id=1-2" to the PR description.');
        setOutput('skipped', 'true');
        return 0;
    }
    const lic = await resolveTier(input('license-key'));
    log(`framedrift tier: ${lic.tier} (${lic.reason})`);
    const failOn = Number(input('fail-on', String(defaults.failOn ?? 2)));
    const bypass = input('vercel-bypass-secret');
    const headers = bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {};
    const res = await runFrames({ baseUrl: previewUrl, frames, defaults, figmaToken: input('figma-token'), tier: lic.tier, failOn, threshold: Number(input('threshold', String(defaults.threshold ?? 0.1))), outDir, headers, log });

    if (lic.tier !== 'pro' && res.failing.length) res.notes.push(`Drift above ${failOn}% found. framedrift Pro can fail this check (make it a required status check) — free runs only report.`);
    fs.writeFileSync(path.join(outDir, 'pr-number'), pr ? String(pr.number) : '');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${fs.readFileSync(res.report.markdown, 'utf8')}\n`);
    setOutput('max-mismatch', String(res.maxMismatch));
    setOutput('pr-number', pr ? String(pr.number) : '');
    // Gate decision is recorded now and enforced by the last step.
    const gate = res.errors.length === res.results.length ? 'error' : res.failing.length && lic.tier === 'pro' ? 'fail' : 'pass';
    setOutput('gate', gate);
    fs.writeFileSync(path.join(outDir, 'gate'), gate);
    fs.writeFileSync(path.join(outDir, 'notes.json'), JSON.stringify({ notes: res.notes, tier: lic.tier, failOn, previewUrl }));
    log(`max mismatch ${res.maxMismatch}% · ${res.failing.length} frame(s) above ${failOn}% · ${res.errors.length} error(s) · gate=${gate}`);
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runAction().then((c) => { process.exitCode = c; }).catch((e) => { console.log(`::error::framedrift: ${redactToken(e.message)}`); process.exitCode = 1; });
}
