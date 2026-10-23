// Regression tests for the 2026-10-22 CTO + Codex review (qa-proof/codex-review-2026-10-22.md).
// Each test names the finding it covers; every one failed on the code before the fix commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { joinUrl, loadConfigFile, parsePrBody } from '../src/config.js';
import * as config from '../src/config.js';
import { renderMarkdown, renderHtml, verdict } from '../src/report.js';
import * as action from '../src/action.js';
import { GitHub } from '../src/github.js';
import { FigmaClient, parseFigmaUrl } from '../src/figma.js';

// Namespace / dynamic imports so each test fails on its own (not the whole file) on pre-fix code.
const { applyFigmaAllowlist } = config;
const { decideGate, findPullRequest } = action;
const { displayUrl } = await import('../src/redact.js').catch(() => ({}));
const { sanitizePaths } = await import('./support/sanitize.js').catch(() => ({}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpFile = (name, body) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-review-')); const f = path.join(d, name); fs.writeFileSync(f, body); return f; };

// ---------- F1 / R63-05: frame paths can't leave the preview origin ----------
test('F1: joinUrl refuses absolute and protocol-relative paths to another origin', () => {
    const base = 'https://app-git-x.vercel.app';
    assert.throws(() => joinUrl(base, 'https://attacker.example/collect'), /preview origin/);
    assert.throws(() => joinUrl(base, 'http://169.254.169.254/latest/meta-data'), /preview origin/);
    assert.throws(() => joinUrl(base, '//attacker.example/x'), /preview origin|root-relative/);
    assert.equal(joinUrl(base, '/login?x=1'), 'https://app-git-x.vercel.app/login?x=1');
    // Same-origin absolute URL is allowed (it's just a verbose path).
    assert.equal(joinUrl(base, 'https://app-git-x.vercel.app/pricing'), 'https://app-git-x.vercel.app/pricing');
});

test('F1: .framedrift.json frames[].path must be root-relative (or same-origin); absolute foreign paths are a config error', () => {
    const f = tmpFile('.framedrift.json', JSON.stringify({ frames: [{ path: 'https://attacker.example/', design: 'x.png' }] }));
    assert.throws(() => loadConfigFile(f), /frames\[0\]\.path/);
    const g = tmpFile('.framedrift.json', JSON.stringify({ frames: [{ path: 'login', design: 'x.png' }] }));
    assert.throws(() => loadConfigFile(g), /frames\[0\]\.path/);
});

test('F1: PR-body lines cannot smuggle a protocol-relative path', () => {
    const frames = parsePrBody('framedrift: //attacker.example/x https://www.figma.com/design/AbC123/App?node-id=1-2');
    assert.ok(frames.every((f) => !f.path.startsWith('//')), JSON.stringify(frames));
});

// ---------- R63-03: a failed comparison fails the gate ----------
test('R63-03: one clean frame + one failed comparison → gate "error", not "pass"', () => {
    const results = [{ name: 'ok', mismatchPercent: 0 }, { name: 'broken', error: 'Preview URL answered HTTP 500' }];
    const res = { results, errors: results.filter((r) => r.error), failing: [] };
    assert.equal(decideGate(res, 'free'), 'error');
    assert.equal(decideGate(res, 'pro'), 'error');
    assert.equal(decideGate({ results: [results[0]], errors: [], failing: [] }, 'free'), 'pass');
    assert.equal(decideGate({ results: [results[0]], errors: [], failing: [results[0]] }, 'pro'), 'fail');
    assert.equal(decideGate({ results: [results[0]], errors: [], failing: [results[0]] }, 'free'), 'pass');
});

// ---------- F3: gate step + entry points ----------
test('F3: an empty/missing gate output fails the job (step 1 crashed)', () => {
    const r = spawnSync(process.execPath, [path.join(root, 'src/action-gate.js')], { env: { ...process.env, FRAMEDRIFT_GATE: '' }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /::error::/);
});

test('F3: action entry points run when the action path contains spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd action path '));
    fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    const r = spawnSync(process.execPath, [path.join(dir, 'src/action.js')], { env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'push' }, encoding: 'utf8', cwd: dir });
    assert.match(r.stdout, /No preview URL/, `action.js did not run: ${r.stdout}${r.stderr}`);
    const c = spawnSync(process.execPath, [path.join(dir, 'src/action-comment.js')], { env: { PATH: process.env.PATH, FRAMEDRIFT_REPORT_DIR: dir }, encoding: 'utf8', cwd: dir });
    assert.match(c.stdout, /No pull request found/, `action-comment.js did not run: ${c.stdout}${c.stderr}`);
});

// ---------- R63-04: invalid thresholds are errors ----------
test('R63-04: invalid failOn / threshold in .framedrift.json is a config error, not a silent permissive default', () => {
    for (const [bad, re] of [
        [{ defaults: { failOn: 'abc' }, frames: [] }, /defaults\.failOn/],
        [{ defaults: { threshold: 3 }, frames: [] }, /defaults\.threshold/],
        [{ frames: [{ design: 'x.png', failOn: -1 }] }, /frames\[0\]\.failOn/],
        [{ frames: [{ design: 'x.png', failOn: 'NaN' }] }, /frames\[0\]\.failOn/],
        [{ frames: [{ design: 'x.png', threshold: '0.1' }] }, /frames\[0\]\.threshold/],
        [{ frames: [{ design: 'x.png', failOn: 101 }] }, /frames\[0\]\.failOn/],
    ]) assert.throws(() => loadConfigFile(tmpFile('.framedrift.json', JSON.stringify(bad))), re, JSON.stringify(bad));
    assert.doesNotThrow(() => loadConfigFile(tmpFile('.framedrift.json', JSON.stringify({ defaults: { failOn: 0, threshold: 0 }, frames: [{ design: 'x.png', failOn: 5, threshold: 1 }] }))));
});

// ---------- F4 / R63-11: per-frame failOn drives the verdict; precedence ----------
test('F4: report verdict uses the frame\'s own failOn, not the global one', () => {
    const r = { name: 'Hero', path: '/', mismatchPercent: 5, failOn: 10, hotspots: [] };
    assert.equal(verdict(r, 2), 'ok');
    const md = renderMarkdown([r], { failOn: 2 });
    assert.match(md, /\| ✅ \| Hero/);
    const strict = { ...r, failOn: 1, mismatchPercent: 1.5 };
    assert.match(renderMarkdown([strict], { failOn: 50 }), /\| ⚠️ \| Hero/);
});

test('F4: action.yml leaves fail-on/threshold empty by default so .framedrift.json defaults are not overridden by a hidden "2"', () => {
    const yml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    const block = (name) => yml.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
    assert.doesNotMatch(block('fail-on'), /default: '2'/);
    assert.doesNotMatch(block('threshold'), /default: '0\.1'/);
});

// ---------- F2: Figma file allowlist ----------
test('F2: figma-files allowlist turns frames from other Figma files into errors (never fetched)', () => {
    const frames = [
        { path: '/a', figma: 'https://www.figma.com/design/AllowedKey1/App?node-id=1-2' },
        { path: '/b', figma: 'https://www.figma.com/design/PrivateHR99/Salaries?node-id=3-4' },
        { path: '/c', design: '/x.png' },
    ];
    const { allowed, rejected } = applyFigmaAllowlist(frames, 'AllowedKey1, other');
    assert.deepEqual(allowed.map((f) => f.path), ['/a', '/c']);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].error, /PrivateHR99.*figma-files/);
    assert.deepEqual(applyFigmaAllowlist(frames, '').allowed.length, 3);
});

// ---------- F8: sticky comment only updates our own comment ----------
test('F8: upsertComment ignores a human comment that quotes the marker', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init.method });
        if (init.method === 'GET') return new Response(JSON.stringify([{ id: 1, body: 'look: <!-- framedrift-report -->', user: { login: 'mallory', type: 'User' } }]), { status: 200 });
        return new Response(JSON.stringify({ id: 2 }), { status: 201 });
    };
    const gh = new GitHub({ token: 't', repository: 'a/b', apiUrl: 'https://api.test', fetchImpl });
    const r = await gh.upsertComment(7, 'body', '<!-- framedrift-report -->');
    assert.equal(r.action, 'created');
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('F8: with a PAT, upsertComment updates the comment written by the token\'s own user', async () => {
    const methods = [];
    const fetchImpl = async (url, init) => {
        methods.push(`${init.method} ${new URL(url).pathname}`);
        if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'sherzod' }), { status: 200 });
        if (init.method === 'GET') return new Response(JSON.stringify([{ id: 9, body: '<!-- framedrift-report -->', user: { login: 'sherzod', type: 'User' } }]), { status: 200 });
        return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    };
    const gh = new GitHub({ token: 't', repository: 'a/b', apiUrl: 'https://api.test', fetchImpl });
    assert.equal((await gh.upsertComment(7, 'body', '<!-- framedrift-report -->')).action, 'updated');
    assert.ok(methods.includes('PATCH /repos/a/b/issues/comments/9'));
});

test('F8: upsertComment still updates the github-actions[bot] comment', async () => {
    const fetchImpl = async (url, init) => {
        if (init.method === 'GET') return new Response(JSON.stringify([{ id: 5, body: '<!-- framedrift-report -->\nold', user: { login: 'github-actions[bot]', type: 'Bot' } }]), { status: 200 });
        return new Response(JSON.stringify({ id: 5 }), { status: 200 });
    };
    const gh = new GitHub({ token: 't', repository: 'a/b', apiUrl: 'https://api.test', fetchImpl });
    assert.equal((await gh.upsertComment(7, 'body', '<!-- framedrift-report -->')).action, 'updated');
});

// ---------- F18: GitHub API failure during PR lookup ----------
test('F18: a GitHub API failure during PR lookup is a warning, not a crash', async () => {
    const logs = [];
    const gh = { pullsForCommit: async () => { throw new Error('GitHub API GET … → 403: Resource not accessible by integration'); } };
    const pr = await findPullRequest({ event: { deployment: { sha: 'abc' } }, gh, log: (m) => logs.push(m) });
    assert.equal(pr, null);
    assert.match(logs.join('\n'), /::warning::.*403/);
});

// ---------- F13: Markdown injection from Figma layer text ----------
test('F13: layer names/text cannot @mention, inject HTML or links in the PR comment', () => {
    const r = { name: 'X', path: '/', mismatchPercent: 9, failOn: 2, hotspots: [{ x: 0, y: 0, width: 1, height: 1, pixels: 1, layer: { path: 'Card', text: '@octocat <img src=x> [click](https://evil.example)' } }] };
    const md = renderMarkdown([r]);
    assert.doesNotMatch(md, /@octocat/);
    assert.doesNotMatch(md, /<img/);
    assert.doesNotMatch(md, /\[click\]\(/);
});

// ---------- R63-07: secrets in displayed URLs ----------
test('R63-07: preview URLs in the comment/report hide userinfo and bypass/token query params', () => {
    const u = 'https://user:pa55@app.vercel.app/login?x-vercel-protection-bypass=SECRET123&_vercel_share=SHARE9&token=T0K&page=2';
    const shown = displayUrl(u);
    for (const s of ['pa55', 'SECRET123', 'SHARE9', 'T0K']) assert.ok(!shown.includes(s), shown);
    assert.match(shown, /page=2/);
    const md = renderMarkdown([{ name: 'X', path: '/', url: u, error: 'boom' }], { previewUrl: u });
    assert.ok(!md.includes('SECRET123') && !md.includes('pa55'), md);
    const html = renderHtml([{ name: 'X', path: '/', url: u, error: 'boom' }]);
    assert.ok(!html.includes('SECRET123') && !html.includes('pa55'));
});

// ---------- R63-08: only https Figma links / http(s) hrefs ----------
test('R63-08: parseFigmaUrl rejects non-https schemes; report hrefs are http(s) only', () => {
    assert.throws(() => parseFigmaUrl('javascript://www.figma.com/design/AbC123/x?node-id=1-2'), /https/);
    assert.throws(() => parseFigmaUrl('http://www.figma.com/design/AbC123/x?node-id=1-2'), /https/);
    assert.equal(parseFigmaUrl('https://www.figma.com/design/AbC123/x?node-id=1-2').fileKey, 'AbC123');
    const r = { name: 'X', path: '/', url: 'javascript:alert(1)', finalUrl: 'javascript:alert(1)', mismatchPercent: 0, figma: { url: 'javascript:alert(2)', fileName: 'f', frameName: 'n' }, hotspots: [], viewport: { width: 1, height: 1 }, scale: 1, designSize: { width: 1, height: 1 } };
    const md = renderMarkdown([r]);
    assert.doesNotMatch(md, /\]\(javascript:/);
});

// ---------- R63-15: Figma requests time out; Retry-After cap applies to 5xx too ----------
test('R63-15: a hung Figma request times out instead of hanging the job', async () => {
    const fetchImpl = (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    const c = new FigmaClient({ token: 't', maxRetries: 0, requestTimeoutMs: 50, fetchImpl });
    const t0 = Date.now();
    const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout timers are unref'd; keep the test process alive
    try { await assert.rejects(c.get('/v1/me'), /timed out after 50 ms/); } finally { clearTimeout(keepAlive); }
    assert.ok(Date.now() - t0 < 2000);
});

test('R63-15: a 503 with Retry-After: 7200 gives up instead of sleeping two hours', async () => {
    const fetchImpl = async () => new Response('down', { status: 503, headers: { 'retry-after': '7200' } });
    const c = new FigmaClient({ token: 't', maxRetries: 3, fetchImpl });
    const t0 = Date.now();
    await assert.rejects(c.get('/v1/me'), /7200/);
    assert.ok(Date.now() - t0 < 2000);
});

// ---------- R63-10 / F10: CI + action dependencies ----------
test('R63-10: CI action-smoke job sets up Node and installs deps before importing playwright', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const job = ci.split(/\n  action-smoke:\n/)[1];
    assert.ok(job, 'no action-smoke job');
    const iSetup = job.indexOf('actions/setup-node');
    const iCi = job.indexOf('npm ci');
    const iPw = job.indexOf("import('./src/browser.js')");
    assert.ok(iSetup !== -1 && iCi !== -1 && iSetup < iCi && iCi < iPw, 'setup-node → npm ci → browser import order missing');
});

test('F10: no deprecated action majors or Node 20 (EOL 2026-04-30) in action.yml / CI', () => {
    const files = ['action.yml', '.github/workflows/ci.yml', 'examples/.github/workflows/framedrift.yml'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    assert.doesNotMatch(files, /actions\/(checkout|setup-node|upload-artifact)@v[1-4]\b/);
    assert.doesNotMatch(files, /node-version: \[?'?20\b/);
});

// ---------- F16: no machine paths in committed e2e evidence ----------
test('F16: sanitizePaths replaces repo root and temp dirs', () => {
    const s = sanitizePaths('report: /tmp/framedrift-e2e-QiCBsy/demo/index.html and /workspace/hustler-build/devtool/test/x.png', { root: '/workspace/hustler-build/devtool', tmp: '/tmp' });
    assert.equal(s, 'report: $TMPDIR/framedrift-e2e-QiCBsy/demo/index.html and <repo>/test/x.png');
});

test('F16: committed e2e evidence has no absolute machine paths', () => {
    const files = ['test/e2e/LAST_RUN.md', ...fs.readdirSync(path.join(root, 'test/e2e/artifacts'), { recursive: true }).filter((f) => /\.(json|md)$/.test(f)).map((f) => `test/e2e/artifacts/${f}`)];
    for (const f of files) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        assert.doesNotMatch(text, /\/workspace\/|\/tmp\/|\/home\//, f);
    }
});
