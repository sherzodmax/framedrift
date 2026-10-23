// Regression tests for the round-6 review (qa-proof/codex-review-2026-10-22.md: "Round 6 re-check"), Action / host part.
// Each test names its finding and failed before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fd-r6a-'));
const DESIGN = path.join(root, 'test/fixtures/example-design-with-h1.png');
const SECRET = 'bypass-R6-secret-7q';

function runNode(file, env, cwd) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [file], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
}
async function runAction(inputs, event, eventName = 'deployment_status') {
    const dir = tmpDir();
    const ev = path.join(dir, 'event.json'); fs.writeFileSync(ev, JSON.stringify(event));
    const outFile = path.join(dir, 'out'); fs.writeFileSync(outFile, '');
    const cfg = path.join(dir, '.framedrift.json'); fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', design: 'x.png' }] }));
    const env = { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: ev, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), RUNNER_TEMP: dir, INPUT_CONFIG: cfg, INPUT_GITHUB_TOKEN: '' };
    for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, '_')}`] = v;
    const r = await runNode(path.join(root, 'src/action.js'), env, dir);
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { ...r, outputs };
}
// http:// stops every run at the https check that follows the host / creator checks, so nothing is fetched.
const URL_ = 'http://myproj-a1b2c3d4e-acme.vercel.app/';
const ev = (login, url = URL_) => ({ deployment_status: { state: 'success', environment: 'Preview', target_url: url, creator: login ? { login } : undefined }, deployment: { sha: 'abc' } });
const reachedHttps = (r) => /::error::.*https/.test(r.out);

// ---------- R6-04: vercel-project without vercel-team ----------
test('R6-04: with a bypass secret, vercel-project without vercel-team fails the check (any team could own that project name)', async () => {
    const r = await runAction({ 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj' }, ev('vercel[bot]'));
    assert.equal(r.outputs.gate, 'error', r.out);
    assert.match(r.out, /::error::.*vercel-team/);
    assert.ok(!reachedHttps(r), 'stops before anything else');
    const withTeam = await runAction({ 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme' }, ev('vercel[bot]'));
    assert.ok(reachedHttps(withTeam), withTeam.out);
    const hosts = await runAction({ 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'preview-hosts': 'myproj-a1b2c3d4e-acme.vercel.app' }, ev('vercel[bot]'));
    assert.ok(reachedHttps(hosts), 'preview-hosts replaces the project patterns, so no team is needed');
    for (const x of [r, withTeam, hosts]) assert.ok(!x.out.includes(SECRET));
});

test('R6-04: without a bypass secret, vercel-project without vercel-team only warns', async () => {
    // A loopback preview URL is refused right after the host setup, so nothing is fetched.
    const r = await runAction({ 'vercel-project': 'myproj' }, ev('vercel[bot]', 'http://127.0.0.1:9/'));
    assert.match(r.out, /::warning::.*vercel-project.*vercel-team.*any team/, r.out);
    assert.doesNotMatch(r.out, /::error::.*vercel-team/);
});

test('R6-04: CLI --vercel-bypass with --vercel-project but no --vercel-team is a usage error', async () => {
    const err = []; const oe = console.error; const ol = console.log; console.error = (...a) => err.push(a.join(' ')); console.log = () => {};
    let code;
    try { code = await main(['compare', '--url', 'https://myproj-a1b2c3d4e-acme.vercel.app:8443/', /* port 8443 is refused later anyway: nothing is fetched */ '--design', DESIGN, '--vercel-bypass', SECRET, '--vercel-project', 'myproj']); } finally { console.error = oe; console.log = ol; }
    assert.equal(code, 2, err.join('\n'));
    assert.match(err.join('\n'), /--vercel-team/);
    assert.ok(!err.join('\n').includes(SECRET));
});

// ---------- Design (a): trusted-deployment-creators replaces the preview-url skip ----------
test('Round 6 (a): preview-url set to the event URL no longer skips the creator check', async () => {
    const base = { 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme' };
    const r = await runAction({ ...base, 'preview-url': URL_ }, ev('mallory'));
    assert.equal(r.outputs.gate, 'error');
    assert.match(r.out, /::error::.*created by "mallory".*trusted-deployment-creators/);
    assert.ok(!reachedHttps(r));
    const other = await runAction({ ...base, 'preview-url': 'http://myproj-git-main-acme.vercel.app/' }, ev('mallory'));
    assert.match(other.out, /created by "mallory"/, 'any preview-url on a deployment_status event is checked');
});

test('Round 6 (a): trusted-deployment-creators lists other deploy bots; default is vercel[bot]; other events are not checked', async () => {
    const base = { 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme' };
    const netlify = await runAction({ ...base, 'trusted-deployment-creators': 'vercel[bot], netlify[bot]' }, ev('netlify[bot]'));
    assert.ok(reachedHttps(netlify), netlify.out);
    const notListed = await runAction({ ...base, 'trusted-deployment-creators': 'netlify[bot]' }, ev('vercel[bot]'));
    assert.match(notListed.out, /created by "vercel\[bot\]"/, 'the list replaces the default');
    const dflt = await runAction(base, ev('vercel[bot]'));
    assert.ok(reachedHttps(dflt));
    const dispatch = await runAction({ ...base, 'preview-url': URL_ }, {}, 'workflow_dispatch');
    assert.ok(reachedHttps(dispatch), 'workflow_dispatch has no deployment_status to check');
    assert.match(read('action.yml'), /trusted-deployment-creators:[\s\S]*?default: 'vercel\[bot\]'[\s\S]*INPUT_TRUSTED_DEPLOYMENT_CREATORS/);
    const sec = read('README.md').split(/^### Security\b/m)[1] || '';
    assert.match(sec, /trusted-deployment-creators/);
    assert.match(sec, /vercel-team[^.]*required/i);
    for (const x of [netlify, notListed, dflt, dispatch]) assert.ok(!x.out.includes(SECRET));
});
