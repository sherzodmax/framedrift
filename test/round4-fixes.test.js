// Regression tests for the round-4 review (qa-proof/codex-review-2026-10-22.md: "Round 4 re-check (a23cfda)").
// Each test names its finding and failed before the fix. R4-01 lives in capture-headers.test.js (browser fixture).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import * as config from '../src/config.js';
import * as run from '../src/run.js';
import * as redact from '../src/redact.js';
import { UsageError } from '../src/args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fd-r4-'));
const { PNG } = pngjs;
const whitePng = (w, h) => { const p = new PNG({ width: w, height: h }); p.data.fill(255); return PNG.sync.write(p); };

function runNode(file, env, args = [], cwd) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [file, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
}
async function runAction(inputs) {
    const dir = tmpDir();
    const ev = path.join(dir, 'event.json'); fs.writeFileSync(ev, '{}');
    const outFile = path.join(dir, 'out'); const summary = path.join(dir, 'summary');
    fs.writeFileSync(outFile, ''); fs.writeFileSync(summary, '');
    const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: ev, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir };
    for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, '_')}`] = v;
    const r = await runNode(path.join(root, 'src/action.js'), env, [], dir);
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { ...r, outputs };
}

let page;
before(async () => {
    page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body style="margin:0;background:#fff"></body>'); });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
});
after(() => page?.close());

/** Every path (files and folders) under dir, and the text of every file. */
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        out.push({ rel: path.relative(dir, p), p, isDir: e.isDirectory() });
        if (e.isDirectory()) walk(p, out);
    }
    return out;
}

// ---------- R4-02: secrets in artifact folder names, results.json `files`, and redactor edge cases ----------
test('R4-02: no secret anywhere in the artifact tree: file and folder names, results.json files paths, every file, the log', async () => {
    const S = ['SEC1qtok', 'SEC2qkey', 'SEC3qsig', 'SEC4bkey', 'SEC5bsig', 'SEC6frag', 'SEC7penc', 'SEC8pseg', 'SEC9share'];
    const dir = tmpDir();
    const design = path.join(dir, 'd.png'); fs.writeFileSync(design, whitePng(40, 30));
    const out = path.join(dir, 'out');
    const logs = [];
    const res = await run.runFrames({
        baseUrl: `http://127.0.0.1:${page.address().port}/`,
        frames: [
            { name: `Login ?token=${S[0]}`, path: `/login?token=${S[0]}`, design },
            { path: `/keys?api_key=${S[1]}&signature=${S[2]}`, design }, // name comes from the path
            { name: `Bare api_key=${S[3]} signature=${S[4]}`, path: '/b', design },
            { name: `Frag #access_token=${S[5]}`, path: `/f#access_token=${S[5]}`, design },
            { name: `Enc %3Ftoken%3D${S[6]}`, path: '/e', design },
            { path: `/token=${S[7]}/page`, design },
            { path: `/s?_vercel_share=${S[8]}`, design },
        ],
        outDir: out, allowLoopback: true, log: (m) => logs.push(m),
    });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    const hits = [];
    const has = (t) => S.filter((s) => t.toLowerCase().includes(s.toLowerCase())); // folder slugs are lower-case
    for (const e of walk(out)) {
        for (const s of has(e.rel)) hits.push(`${e.isDir ? 'folder' : 'file'} name ${e.rel} contains ${s}`);
        if (!e.isDir) for (const s of has(fs.readFileSync(e.p, 'latin1'))) hits.push(`${e.rel} contains ${s}`);
    }
    for (const s of has(logs.join('\n'))) hits.push(`log contains ${s}`);
    assert.deepEqual(hits, []);
    const json = JSON.parse(fs.readFileSync(res.report.json, "utf8")).results;
    assert.match(json[0].files.design, /^01-login-token-redacted\//, 'folder names stay readable: the secret becomes "redacted"');
});

test('R4-02: redactText also covers fragments, bare key=value pairs, percent-encoded params and path segments', () => {
    const { redactText } = redact;
    assert.equal(redactText('/cb#access_token=FRAGTOK777&state=1'), '/cb#access_token=REDACTED&state=1');
    assert.equal(redactText('Login api_key=BAREKEY555 signature=BARESIG556 ok'), 'Login api_key=REDACTED signature=REDACTED ok');
    assert.equal(redactText('token=LEAD1234 at start'), 'token=REDACTED at start');
    assert.equal(redactText('/x%3Ftoken%3DENCTOK2%26page%3D2'), '/x%3Ftoken%3DREDACTED%26page%3D2');
    assert.equal(redactText('https://h.dev/a?next=%2Fb%3Fsig%3DENCSIG9'), 'https://h.dev/a?next=%2Fb%3Fsig%3DREDACTED');
    assert.equal(redactText('/token=PATHSEGTOK/page'), '/token=REDACTED/page');
    assert.equal(redactText('/a;jsessionid=SESS1234/b'), '/a;jsessionid=REDACTED/b');
    assert.equal(redactText('/p?token=a/b/c&x=1'), '/p?token=REDACTED&x=1', 'a raw "/" inside a query value is part of the value');
    // Non-secret pairs and ordinary text are untouched.
    assert.equal(redactText('/list?page=2&sort=asc#top'), '/list?page=2&sort=asc#top');
    assert.equal(redactText('width=390 height=844'), 'width=390 height=844');
});

// ---------- R4-03: bypass secret scope ----------
test('R4-03: with a bypass secret set, the preview must be https on the default port', async () => {
    const H = { 'x-vercel-protection-bypass': 'S3cr3t-r4-03' };
    const frames = [{ path: '/', design: 'x.png' }];
    for (const [baseUrl, re] of [['http://app-git-x-acme.vercel.app/', /https/], ['https://app-git-x-acme.vercel.app:8443/', /port/], ['http://app-git-x-acme.vercel.app:443/', /https/]]) {
        await assert.rejects(run.runFrames({ baseUrl, frames, outDir: tmpDir(), headers: H, log: () => {} }), (e) => e instanceof UsageError && re.test(e.message), baseUrl);
    }
    // Without a secret, http and other ports are still fine (nothing secret is sent): the R4-02 test above runs on
    // http://127.0.0.1:<port>.
});

test('R4-03: preview host patterns: "*" inside a label matches one label only; project-scoped defaults', () => {
    const { previewHostAllowed, resolvePreviewHosts } = config;
    assert.equal(typeof resolvePreviewHosts, 'function', 'config.resolvePreviewHosts missing');
    const P = ['myproj-*-acme.vercel.app'];
    assert.equal(previewHostAllowed('https://myproj-abc123-acme.vercel.app/', P), true);
    assert.equal(previewHostAllowed('https://myproj-git-feat-x-acme.vercel.app/', P), true);
    assert.equal(previewHostAllowed('https://attacker-abc-acme.vercel.app/', P), false);
    assert.equal(previewHostAllowed('https://myproj-abc-evil.vercel.app/', P), false);
    assert.equal(previewHostAllowed('https://myproj-a.b-acme.vercel.app/', P), false, '"*" never matches a dot');
    assert.equal(previewHostAllowed('https://myproj--acme.vercel.app/', P), false, '"*" matches at least one character');
    assert.deepEqual(resolvePreviewHosts({ project: 'MyProj', team: 'acme' }), { hosts: ['myproj-*-acme.vercel.app', 'myproj-acme.vercel.app'], source: 'vercel-project' });
    assert.deepEqual(resolvePreviewHosts({ project: 'myproj' }), { hosts: ['myproj-*.vercel.app'], source: 'vercel-project' });
    assert.deepEqual(resolvePreviewHosts({ hosts: ['preview.acme.dev'], project: 'myproj' }), { hosts: ['preview.acme.dev'], source: 'preview-hosts' }, 'an explicit list replaces the default');
    assert.deepEqual(resolvePreviewHosts({}), { hosts: ['*.vercel.app'], source: 'default' });
    assert.throws(() => resolvePreviewHosts({ project: 'my proj' }), /vercel-project/);
});

test('R4-03: the Action narrows the allowlist to vercel-project / vercel-team and warns when it can only use *.vercel.app', async () => {
    const SECRET = 'bypass-R4-03-77ab1c';
    const cfg = path.join(tmpDir(), '.framedrift.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', design: 'x.png' }] }));
    const r = await runAction({ 'preview-url': 'https://attacker-proj-abc-evil.vercel.app/', 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme', config: cfg, 'github-token': '' });
    assert.equal(r.outputs.gate, 'error', r.out);
    assert.match(r.out, /::error::.*myproj-\*-acme\.vercel\.app/);
    assert.ok(!r.out.includes(SECRET));
    const r2 = await runAction({ 'preview-url': 'http://myproj-abc-acme.vercel.app/', 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme', config: cfg, 'github-token': '' });
    assert.equal(r2.outputs.gate, 'error', r2.out);
    assert.match(r2.out, /::error::.*https/);
    const r3 = await runAction({ 'preview-url': 'http://other.vercel.app:1/', 'vercel-bypass-secret': SECRET, config: cfg, 'github-token': '' });
    assert.match(r3.out, /::warning::.*any Vercel project.*vercel-project/);
    for (const k of ['vercel-project', 'vercel-team']) assert.match(read('action.yml'), new RegExp(`^  ${k}:`, 'm'));
});

test('R4-03: the CLI refuses http / other ports / other projects before sending the secret', async () => {
    const cli = path.join(root, 'bin/framedrift.js');
    const env = { VERCEL_AUTOMATION_BYPASS_SECRET: 'cli-secret-r403' };
    const design = path.join(tmpDir(), 'x.png'); fs.writeFileSync(design, whitePng(8, 8));
    const a = await runNode(cli, env, ['compare', '--url', 'http://app-abc-acme.vercel.app/', '--design', design]);
    assert.notEqual(a.code, 0); assert.match(a.out, /https/);
    const b = await runNode(cli, env, ['compare', '--url', 'https://other-abc-evil.vercel.app/', '--design', design, '--vercel-project', 'app', '--vercel-team', 'acme']);
    assert.notEqual(b.code, 0); assert.match(b.out, /app-\*-acme\.vercel\.app/);
    assert.ok(!(a.out + b.out).includes('cli-secret-r403'));
});

test('R4-03: README and CHANGELOG document the narrowed default and the https requirement', () => {
    const sec = read('README.md').split(/^### Security\b/m)[1]?.split(/^##/m)[0] || '';
    assert.match(sec, /vercel-project/);
    assert.match(sec, /https/);
    assert.match(read('CHANGELOG.md'), /vercel-project/);
});

// ---------- README: license key destination ----------
test('README: the license key is sent to FRAMEDRIFT_POLAR_API (http accepted); any "granted" answer makes the run Pro', () => {
    const md = read('README.md');
    const para = md.split('\n').find((l) => l.includes('FRAMEDRIFT_POLAR_API')) || '';
    assert.match(para, /license key is sent to/i);
    assert.match(para, /http:\/\//);
    assert.match(para, /granted/);
});
