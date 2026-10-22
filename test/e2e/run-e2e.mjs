// End-to-end checks that need no credentials:
//  1-2  real public URL (example.com) vs a design PNG, through the real CLI binary
//  3-4  `framedrift run` against a local "preview" server + OFFLINE Figma API mock (fixtures)
//  5-7  the GitHub Action scripts against mock GitHub + mock Polar APIs (free vs Pro gate, sticky comment)
// Writes test/e2e/LAST_RUN.md with the evidence. Live Figma / GitHub / Polar are NOT exercised here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockFigma, TEST_TOKEN } from '../support/mock-figma.js';
import { LOGIN_HTML } from './pages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const bin = path.join(root, 'bin', 'framedrift.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framedrift-e2e-'));
const evidence = [];
const record = (name, ok, details) => { evidence.push({ name, ok, details }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${details.split('\n').join('\n      ')}`); };
// Async on purpose: the mock servers live in this process, so a sync spawn would deadlock.
const run = (args, env = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    const t = setTimeout(() => c.kill('SIGKILL'), 180000);
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
const runAsync = (file, env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [file], { env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
});
async function check(name, fn) {
    try { const d = await fn(); record(name, true, d || ''); } catch (e) { record(name, false, e.stack || String(e)); }
}

// ---------- 1-2: real public URL ----------
await check('1. real URL: https://example.com/ vs designer PNG with an extra H1 → drift found, exit 1 with --fail-on 0.5', async () => {
    const out = path.join(tmp, 'example');
    const r = await run(['compare', '--url', 'https://example.com/', '--design', path.join(root, 'test/fixtures/example-design-with-h1.png'), '--out', out, '--fail-on', '0.5', '--json']);
    assert.equal(r.status, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.mismatchPercent > 0.5, `mismatch ${j.mismatchPercent}`);
    assert.ok(j.hotspots.length >= 1);
    assert.equal(j.httpStatus, 200);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    fs.cpSync(out, path.join(here, 'artifacts', 'example-com'), { recursive: true });
    return `mismatch ${j.mismatchPercent}% (${j.mismatchedPixels} px), ${j.hotspots.length} hotspots, top at ${JSON.stringify(j.hotspots[0])}; exit=${r.status}`;
});
await check('2. real URL: example.com vs its own capture from run 1 → near-zero drift, exit 0', async () => {
    const out = path.join(tmp, 'example-self');
    const r = await run(['compare', '--url', 'https://example.com/', '--design', path.join(tmp, 'example', 'actual.png'), '--out', out, '--fail-on', '0.5', '--json']);
    const j = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `exit ${r.status}, mismatch ${j.mismatchPercent}`);
    return `mismatch ${j.mismatchPercent}% (${j.mismatchedPixels} px); exit=${r.status}`;
});

// ---------- 3-4: Figma (mock) vs local preview ----------
const figmaRender = path.join(root, 'test/fixtures/login-figma-render.png');
const mock = await startMockFigma({ renders: { '20:1': figmaRender } });
let drift = true;
const preview = http.createServer((req, res) => {
    if (req.url.startsWith('/login')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LOGIN_HTML({ drift })); }
    res.writeHead(404); res.end('not found');
});
await new Promise((r) => preview.listen(0, '127.0.0.1', r));
const previewUrl = `http://127.0.0.1:${preview.address().port}`;
const cfgDir = path.join(tmp, 'repo');
fs.mkdirSync(cfgDir, { recursive: true });
const FIGMA_LINK = 'https://www.figma.com/design/FIXTUREFILEKEY01/Acme-Design-System?node-id=20-1';
fs.writeFileSync(path.join(cfgDir, '.framedrift.json'), JSON.stringify({ frames: [{ name: 'Login', path: '/login', figma: FIGMA_LINK }, { name: 'Missing page', path: '/nope', figma: FIGMA_LINK }] }, null, 2));
const figEnv = { FIGMA_API_BASE: mock.baseUrl, FIGMA_TOKEN: TEST_TOKEN };

await check('3. run: drifted preview vs Figma frame (mock API) → hotspots named after Figma layers', async () => {
    const out = path.join(tmp, 'login-drift');
    const r = await run(['run', '--base-url', previewUrl, '--config', path.join(cfgDir, '.framedrift.json'), '--out', out, '--fail-on', '1'], figEnv);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results;
    const login = res.find((x) => x.name === 'Login');
    const names = login.hotspots.map((h) => h.layer?.name);
    assert.ok(names.includes('Title'), names.join(','));
    assert.ok(names.includes('Button / Sign in') || names.includes('Label'), names.join(','));
    const missing = res.find((x) => x.name === 'Missing page');
    assert.match(missing.error, /HTTP 404/);
    assert.ok(!mock.hits.some((h) => h.includes(TEST_TOKEN)));
    fs.cpSync(out, path.join(here, 'artifacts', 'login-drift'), { recursive: true });
    return `Login: ${login.mismatchPercent}%; hotspots → ${login.hotspots.slice(0, 4).map((h) => `${h.layer?.path}${h.layer?.component ? ` (${h.layer.component})` : ''}`).join(' | ')}\nMissing page: ${missing.error}\nFigma API calls: ${mock.hits.filter((h) => h.startsWith('GET /v1')).length}`;
});
await check('4. run: matching preview vs same Figma frame → below threshold, exit 0', async () => {
    drift = false;
    fs.writeFileSync(path.join(cfgDir, 'ok.json'), JSON.stringify({ frames: [{ name: 'Login', path: '/login', figma: FIGMA_LINK }] }));
    const out = path.join(tmp, 'login-ok');
    const r = await run(['run', '--base-url', previewUrl, '--config', path.join(cfgDir, 'ok.json'), '--out', out, '--fail-on', '1'], figEnv);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results;
    return `Login: ${res[0].mismatchPercent}% different; exit=${r.status}`;
});

// ---------- 5-7: GitHub Action flow (mock GitHub + mock Polar) ----------
drift = true;
const ghLog = [];
const comments = [];
const gh = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    ghLog.push(`${req.method} ${req.url}`);
    const j = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer ghs_test') return j(401, { message: 'Bad credentials' });
    if (req.url === '/repos/acme/web/commits/abc123/pulls') return j(200, [{ number: 7, state: 'open' }]);
    if (req.url === '/repos/acme/web/pulls/7') return j(200, { number: 7, body: `Login screen.\n\nframedrift: /login ${FIGMA_LINK}` });
    if (req.url.startsWith('/repos/acme/web/issues/7/comments') && req.method === 'GET') return j(200, comments);
    if (req.url === '/repos/acme/web/issues/7/comments' && req.method === 'POST') { const c = { id: 100 + comments.length, body: JSON.parse(body).body }; comments.push(c); return j(201, c); }
    const m = req.url.match(/^\/repos\/acme\/web\/issues\/comments\/(\d+)$/);
    if (m && req.method === 'PATCH') { const c = comments.find((x) => x.id === Number(m[1])); c.body = JSON.parse(body).body; return j(200, c); }
    return j(404, { message: 'Not Found' });
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
const polar = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { key } = JSON.parse(body || '{}');
    res.writeHead(key === 'PRO-KEY' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(key === 'PRO-KEY' ? { status: 'granted', expires_at: null } : { error: 'ResourceNotFound', detail: 'License key not found' }));
});
await new Promise((r) => polar.listen(0, '127.0.0.1', r));
const eventPath = path.join(tmp, 'event.json');
fs.writeFileSync(eventPath, JSON.stringify({ deployment_status: { state: 'success', environment_url: previewUrl, target_url: 'https://vercel.com/acme/web/xyz' }, deployment: { sha: 'abc123', environment: 'Preview' } }));
async function actionRun(label, licenseKey) {
    const outFile = path.join(tmp, `gh-output-${label}`);
    const summary = path.join(tmp, `gh-summary-${label}`);
    fs.writeFileSync(outFile, ''); fs.writeFileSync(summary, '');
    const env = {
        ...figEnv, GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`,
        GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: path.join(tmp, `runner-${label}`),
        INPUT_FIGMA_TOKEN: TEST_TOKEN, INPUT_GITHUB_TOKEN: 'ghs_test', INPUT_CONFIG: path.join(cfgDir, 'none.json'), INPUT_FAIL_ON: '1', INPUT_LICENSE_KEY: licenseKey,
        FRAMEDRIFT_POLAR_API: `http://127.0.0.1:${polar.address().port}`, FRAMEDRIFT_POLAR_ORG_ID: '11111111-2222-4333-8444-555555555555',
    };
    const a = await runAsync(path.join(root, 'src/action.js'), env);
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const c = await runAsync(path.join(root, 'src/action-comment.js'), { INPUT_GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: env.GITHUB_API_URL, FRAMEDRIFT_REPORT_DIR: outputs['report-dir'], FRAMEDRIFT_ARTIFACT_URL: 'https://github.com/acme/web/actions/runs/1/artifacts/2' });
    const g = await runAsync(path.join(root, 'src/action-gate.js'), { FRAMEDRIFT_GATE: outputs.gate });
    return { a, c, g, outputs };
}
await check('5. Action, free tier: finds PR via commit SHA, reads frames from PR body, posts comment, does NOT fail the job', async () => {
    const { a, c, g, outputs } = await actionRun('free', 'WRONG-KEY');
    assert.equal(a.code, 0, a.out);
    assert.equal(outputs.gate, 'pass');
    assert.equal(g.code, 0);
    assert.match(c.out, /comment created/);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /framedrift-report/);
    assert.match(comments[0].body, /framedrift Pro can fail this check/);
    assert.match(a.out, /tier: free \(license key not found/);
    fs.writeFileSync(path.join(here, 'artifacts', 'pr-comment-free.md'), comments[0].body);
    return `gate=${outputs.gate}, max-mismatch=${outputs['max-mismatch']}%, comment created on PR #7; GitHub calls: ${ghLog.join(', ')}`;
});
await check('6. Action, Pro tier: same drift → gate=fail, job fails; comment is updated in place (sticky)', async () => {
    ghLog.length = 0;
    const { a, c, g, outputs } = await actionRun('pro', 'PRO-KEY');
    assert.equal(a.code, 0, a.out);
    assert.equal(outputs.gate, 'fail');
    assert.equal(g.code, 1);
    assert.match(g.out, /::error::/);
    assert.match(c.out, /comment updated/);
    assert.equal(comments.length, 1, 'no duplicate comment');
    assert.doesNotMatch(comments[0].body, /Pro can fail/);
    fs.writeFileSync(path.join(here, 'artifacts', 'pr-comment-pro.md'), comments[0].body);
    return `gate=${outputs.gate}, gate step exit=${g.code}; GitHub calls: ${ghLog.join(', ')}`;
});
await check('7. Action: non-success deployment_status is skipped cleanly', async () => {
    const ev2 = path.join(tmp, 'event-pending.json');
    fs.writeFileSync(ev2, JSON.stringify({ deployment_status: { state: 'pending' }, deployment: { sha: 'abc123' } }));
    const outFile = path.join(tmp, 'gh-output-pending'); fs.writeFileSync(outFile, '');
    const a = await runAsync(path.join(root, 'src/action.js'), { GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: ev2, GITHUB_OUTPUT: outFile, INPUT_GITHUB_TOKEN: 'x', RUNNER_TEMP: tmp });
    assert.equal(a.code, 0);
    assert.match(fs.readFileSync(outFile, 'utf8'), /skipped=true/);
    return a.out.trim();
});

await mock.close(); preview.close(); gh.close(); polar.close();
const passed = evidence.filter((e) => e.ok).length;
const md = [`# framedrift E2E run — ${new Date().toISOString()}`, '', `Node ${process.version} · ${passed}/${evidence.length} passed · Figma/GitHub/Polar are LOCAL MOCKS in 3-7 (no live credentials); 1-2 hit the real https://example.com/.`, '', ...evidence.map((e) => `## ${e.ok ? '✅' : '❌'} ${e.name}\n\n\`\`\`\n${e.details}\n\`\`\`\n`)].join('\n');
fs.writeFileSync(path.join(here, 'LAST_RUN.md'), md);
console.log(`\n${passed}/${evidence.length} E2E checks passed → test/e2e/LAST_RUN.md`);
process.exitCode = passed === evidence.length ? 0 : 1;
