// End-to-end checks that need no credentials:
//  1-2  real public URL (example.com) vs a design PNG, through the real CLI binary
//  3-4  `framedrift run` against a local "preview" server + OFFLINE Figma API mock (fixtures)
//  5-11 edge cases: unreachable preview, Figma rate limits, mismatched sizes, `framedrift demo`, free-tier limit
//  12-14 the GitHub Action scripts against mock GitHub + mock Polar APIs (free vs Pro gate, sticky comment)
//  15-16 Action input errors (missing Figma token, invalid fail-on)
// Writes test/e2e/LAST_RUN.md with the evidence. Live Figma / GitHub / Polar are NOT exercised here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockFigma, TEST_TOKEN } from '../support/mock-figma.js';
import { LOGIN_HTML } from '../../src/demo-page.js';
import { sanitizePaths } from '../support/sanitize.js';

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

await check('3. run: drifted preview vs Figma frame (mock API) → hotspots named after Figma layers; the 404 frame makes the run exit 3', async () => {
    const out = path.join(tmp, 'login-drift');
    const r = await run(['run', '--base-url', previewUrl, '--config', path.join(cfgDir, '.framedrift.json'), '--out', out, '--fail-on', '1'], figEnv);
    assert.equal(r.status, 3, r.stderr + r.stdout); // any failed comparison is exit 3 (review R63-03), even next to a drifted frame
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

// ---------- 5-11: edge cases through the real CLI + browser ----------
const closedPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
await check('5. unreachable preview (closed port): compare exits 3 with a one-line, actionable error', async () => {
    const r = await run(['compare', '--url', `http://127.0.0.1:${closedPort}/`, '--design', figmaRender, '--out', path.join(tmp, 'unreachable')]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Could not reach preview http:\/\/127\.0\.0\.1:\d+\/: ERR_CONNECTION_REFUSED/);
    assert.doesNotMatch(r.stderr, /Call log/);
    return r.stderr.trim();
});
await check('6. unreachable preview in `run`: every frame errors → exit 3, report still written with the error row', async () => {
    const out = path.join(tmp, 'unreachable-run');
    const r = await run(['run', '--base-url', `http://127.0.0.1:${closedPort}`, '--config', path.join(cfgDir, 'ok.json'), '--out', out], figEnv);
    assert.equal(r.status, 3, r.stderr);
    const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
    assert.match(md, /❌ \| Login \| \/login \| — \| Could not reach preview/);
    return md.split('\n').find((l) => l.startsWith('| ❌'));
});
await check('7. Figma rate limit with a long Retry-After: fails fast (no sleeping) with a clear message', async () => {
    const cfg = path.join(cfgDir, 'ratelimit.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ name: 'Login', path: '/login', figma: FIGMA_LINK.replace('FIXTUREFILEKEY01', 'RATELIMITHOURS') }] }));
    const t0 = Date.now();
    const r = await run(['run', '--base-url', previewUrl, '--config', cfg, '--out', path.join(tmp, 'rl')], figEnv);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Figma rate limit hit \(429\) and Figma asked to wait 7200s/);
    assert.ok(Date.now() - t0 < 30000);
    return `exit=${r.status} after ${Date.now() - t0} ms\n${r.stderr.split('\n').find((l) => /rate limit/.test(l)).trim()}`;
});
await check('8. Figma rate limit with Retry-After: 1 → retried once, comparison completes', async () => {
    const cfg = path.join(cfgDir, 'ratelimit-short.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ name: 'Login', path: '/login', figma: FIGMA_LINK.replace('FIXTUREFILEKEY01', 'RATELIMIT1SEC') }] }));
    const r = await run(['run', '--base-url', previewUrl, '--config', cfg, '--out', path.join(tmp, 'rl1')], figEnv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Figma API 429 .*retrying in 1s/);
    return r.stderr.split('\n').filter((l) => /429|different/.test(l)).join('\n');
});
await check('9. mismatched sizes: --viewport narrower than the frame → size mismatch reported, missing area counted', async () => {
    const out = path.join(tmp, 'size');
    const r = await run(['compare', '--url', `${previewUrl}/login`, '--design', figmaRender, '--viewport', '300x844', '--out', out, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.sizeMismatch, true);
    assert.deepEqual(j.designSize, { width: 390, height: 844 });
    assert.equal(j.actualSize.width, 300);
    // 90 of 390 columns are missing (23.1%); pixelmatch's anti-aliasing filter forgives a few edge pixels.
    assert.ok(j.mismatchPercent >= 22 && j.mismatchPercent <= 24, `missing 90/390 columns should be ~23%, got ${j.mismatchPercent}`);
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /Size mismatch: design 390×844px, page capture 300×844px/);
    return `design ${j.designSize.width}×${j.designSize.height} vs page ${j.actualSize.width}×${j.actualSize.height}: ${j.mismatchPercent}% different, sizeMismatch=${j.sizeMismatch}`;
});
await check('10. `framedrift demo`: no token, no network → 2 regions named after the fixture layers', async () => {
    const out = path.join(tmp, 'demo');
    const r = await run(['demo', '--out', out], { FIGMA_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Button \/ Sign in \(Button \/ Variant=Primary\)/);
    assert.match(r.stdout, /Title @/);
    fs.cpSync(out, path.join(here, 'artifacts', 'demo'), { recursive: true });
    return r.stdout.trim();
});
await check('11. Free tier: 5 frames → 3 compared, note links to a real upgrade URL (no placeholder)', async () => {
    const cfg = path.join(cfgDir, 'five.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [1, 2, 3, 4, 5].map((n) => ({ name: `F${n}`, path: '/login', design: figmaRender })) }));
    const out = path.join(tmp, 'five');
    const r = await run(['run', '--base-url', previewUrl, '--config', cfg, '--out', out], { FIGMA_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results;
    assert.equal(res.length, 3);
    assert.match(r.stdout, /2 more were skipped.*https:\/\//);
    assert.doesNotMatch(r.stdout, /POLAR_CHECKOUT_URL|OWNER\//);
    return r.stdout.split('\n').find((l) => /skipped/.test(l)).trim();
});

// ---------- 12-16: GitHub Action flow (mock GitHub + mock Polar) ----------
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
    if (req.url === '/repos/acme/web/issues/7/comments' && req.method === 'POST') { const c = { id: 100 + comments.length, body: JSON.parse(body).body, user: { login: 'github-actions[bot]', type: 'Bot' } }; comments.push(c); return j(201, c); }
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
// A config with no frames: the Action takes its frames from the PR description. (A missing config path is an error
// since round 3 N6, and the local preview is on loopback, so allow-loopback-preview is set as in the CI smoke job.)
const emptyCfg = path.join(cfgDir, 'empty.json');
fs.writeFileSync(emptyCfg, JSON.stringify({ frames: [] }));
const eventPath = path.join(tmp, 'event.json');
fs.writeFileSync(eventPath, JSON.stringify({ deployment_status: { state: 'success', environment_url: previewUrl, target_url: 'https://vercel.com/acme/web/xyz' }, deployment: { sha: 'abc123', environment: 'Preview' } }));
async function actionRun(label, licenseKey) {
    const outFile = path.join(tmp, `gh-output-${label}`);
    const summary = path.join(tmp, `gh-summary-${label}`);
    fs.writeFileSync(outFile, ''); fs.writeFileSync(summary, '');
    const env = {
        ...figEnv, GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`,
        GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: path.join(tmp, `runner-${label}`),
        INPUT_FIGMA_TOKEN: TEST_TOKEN, INPUT_GITHUB_TOKEN: 'ghs_test', INPUT_CONFIG: emptyCfg, INPUT_ALLOW_LOOPBACK_PREVIEW: 'true', INPUT_FAIL_ON: '1', INPUT_LICENSE_KEY: licenseKey,
        FRAMEDRIFT_POLAR_API: `http://127.0.0.1:${polar.address().port}`, FRAMEDRIFT_POLAR_ORG_ID: '11111111-2222-4333-8444-555555555555',
    };
    const a = await runAsync(path.join(root, 'src/action.js'), env);
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const c = await runAsync(path.join(root, 'src/action-comment.js'), { INPUT_GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: env.GITHUB_API_URL, FRAMEDRIFT_REPORT_DIR: outputs['report-dir'], FRAMEDRIFT_ARTIFACT_URL: 'https://github.com/acme/web/actions/runs/1/artifacts/2' });
    const g = await runAsync(path.join(root, 'src/action-gate.js'), { FRAMEDRIFT_GATE: outputs.gate });
    return { a, c, g, outputs };
}
await check('12. Action, free tier: finds PR via commit SHA, reads frames from PR body, posts comment, does NOT fail the job', async () => {
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
await check('13. Action, Pro tier: same drift → gate=fail, job fails; comment is updated in place (sticky)', async () => {
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
await check('14. Action: non-success deployment_status is skipped cleanly', async () => {
    const ev2 = path.join(tmp, 'event-pending.json');
    fs.writeFileSync(ev2, JSON.stringify({ deployment_status: { state: 'pending' }, deployment: { sha: 'abc123' } }));
    const outFile = path.join(tmp, 'gh-output-pending'); fs.writeFileSync(outFile, '');
    const a = await runAsync(path.join(root, 'src/action.js'), { GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: ev2, GITHUB_OUTPUT: outFile, INPUT_GITHUB_TOKEN: 'x', RUNNER_TEMP: tmp });
    assert.equal(a.code, 0);
    assert.match(fs.readFileSync(outFile, 'utf8'), /skipped=true/);
    return a.out.trim();
});

await check('15. Action: empty figma-token → step fails with a "create the FIGMA_TOKEN secret" error, no crash', async () => {
    const outFile = path.join(tmp, 'gh-output-notoken'); fs.writeFileSync(outFile, '');
    const a = await runAsync(path.join(root, 'src/action.js'), { GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`, GITHUB_OUTPUT: outFile, RUNNER_TEMP: path.join(tmp, 'runner-notoken'), INPUT_GITHUB_TOKEN: 'ghs_test', INPUT_FIGMA_TOKEN: '', INPUT_CONFIG: emptyCfg, INPUT_ALLOW_LOOPBACK_PREVIEW: 'true' });
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /::error::framedrift: figma-token is empty/);
    assert.match(fs.readFileSync(outFile, 'utf8'), /gate=error/);
    return a.out.trim().split('\n').pop();
});
await check('16. Action: invalid fail-on input → clear error instead of silently never failing', async () => {
    const outFile = path.join(tmp, 'gh-output-badfail'); fs.writeFileSync(outFile, '');
    const a = await runAsync(path.join(root, 'src/action.js'), { ...figEnv, GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`, GITHUB_OUTPUT: outFile, RUNNER_TEMP: path.join(tmp, 'runner-badfail'), INPUT_GITHUB_TOKEN: 'ghs_test', INPUT_FIGMA_TOKEN: TEST_TOKEN, INPUT_CONFIG: emptyCfg, INPUT_ALLOW_LOOPBACK_PREVIEW: 'true', INPUT_FAIL_ON: 'two' });
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /::error::framedrift: invalid fail-on "two"/);
    return a.out.trim().split('\n').pop();
});

await mock.close(); preview.close(); gh.close(); polar.close();
const passed = evidence.filter((e) => e.ok).length;
const md = [`# framedrift E2E run — ${new Date().toISOString()}`, '', `Node ${process.version} · ${passed}/${evidence.length} passed · Figma/GitHub/Polar are LOCAL MOCKS in 3-16 (5-14 use a local preview server) (no live credentials); 1-2 hit the real https://example.com/.`, '', ...evidence.map((e) => `## ${e.ok ? '✅' : '❌'} ${e.name}\n\n\`\`\`\n${e.details}\n\`\`\`\n`)].join('\n');
// Committed evidence must not carry this machine's paths (review F16).
const clean = (text) => sanitizePaths(text, { root, tmp: os.tmpdir() });
fs.writeFileSync(path.join(here, 'LAST_RUN.md'), clean(md));
for (const f of fs.readdirSync(path.join(here, 'artifacts'), { recursive: true })) {
    const file = path.join(here, 'artifacts', f);
    if (/\.(json|md|html)$/.test(f)) fs.writeFileSync(file, clean(fs.readFileSync(file, 'utf8')));
}
console.log(`\n${passed}/${evidence.length} E2E checks passed → test/e2e/LAST_RUN.md`);
process.exitCode = passed === evidence.length ? 0 : 1;
