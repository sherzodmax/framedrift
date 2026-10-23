// Regression tests for the round-3 review (qa-proof/codex-review-2026-10-22.md: "Round 3 re-check (757783d)" and
// "Round 3: Codex pass ... with a council"). Each test names its finding; each failed on 757783d before the fix.
// R68-01 lives in capture-headers.test.js (it needs the two-server browser fixture there).
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
import * as report from '../src/report.js';
import * as run from '../src/run.js';
import * as redact from '../src/redact.js';
import { GitHub } from '../src/github.js';
import { UsageError } from '../src/args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fd-r3-'));
const { PNG } = pngjs;
const whitePng = (w, h) => { const p = new PNG({ width: w, height: h }); p.data.fill(255); return PNG.sync.write(p); };

function runNode(file, env, args = []) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
}
const closedPort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

/** Run src/action.js like the composite step does; returns exit code, log, outputs and the report dir. */
async function runAction(inputs, { event = {}, eventName = 'workflow_dispatch', cwd } = {}) {
    const dir = tmpDir();
    const ev = path.join(dir, 'event.json');
    fs.writeFileSync(ev, JSON.stringify(event));
    const outFile = path.join(dir, 'out'); const summary = path.join(dir, 'summary');
    fs.writeFileSync(outFile, ''); fs.writeFileSync(summary, '');
    const env = { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: ev, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir };
    for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, '_')}`] = v;
    const r = await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(root, 'src/action.js')], { cwd: cwd || dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { ...r, outputs, summary: fs.readFileSync(summary, 'utf8'), dir };
}

// ---------- N1: preview URL trust ----------
test('N1: joinUrl rejects loopback, link-local and cloud-metadata preview base URLs', () => {
    const { joinUrl } = config;
    for (const base of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://app.localhost', 'http://[::1]:8080', 'http://0.0.0.0', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/',
        'http://169.254.169.254', 'http://2852039166/', 'http://[fe80::1]/', 'http://metadata.google.internal', 'http://100.100.100.200', 'http://[fd00:ec2::254]']) {
        assert.throws(() => joinUrl(base, '/login'), /loopback|link-local|metadata/, base);
    }
    // Loopback is allowed only on explicit opt-in (CLI local dev, CI smoke tests); link-local / metadata never are.
    assert.equal(joinUrl('http://127.0.0.1:3000', '/login', { allowLoopback: true }), 'http://127.0.0.1:3000/login');
    assert.equal(joinUrl('http://localhost:3000', '/', { allowLoopback: true }), 'http://localhost:3000/');
    for (const base of ['http://169.254.169.254', 'http://metadata.google.internal', 'http://[fe80::1]/']) assert.throws(() => joinUrl(base, '/', { allowLoopback: true }), /link-local|metadata/, base);
    assert.equal(joinUrl('https://app-git-x.vercel.app', '/login'), 'https://app-git-x.vercel.app/login');
});

test('N1: with a bypass secret set, the preview host must match the allowlist (default *.vercel.app)', async () => {
    const { previewHostAllowed } = config;
    assert.equal(typeof previewHostAllowed, 'function', 'config.previewHostAllowed missing');
    assert.equal(previewHostAllowed('https://app-git-x-acme.vercel.app/'), true);
    assert.equal(previewHostAllowed('https://vercel.app.evil.example/'), false);
    assert.equal(previewHostAllowed('https://evilvercel.app/'), false);
    assert.equal(previewHostAllowed('https://vercel.app/'), false, '*.vercel.app is subdomains only');
    assert.equal(previewHostAllowed('https://preview.acme.dev/', ['*.vercel.app', 'preview.acme.dev']), true);
    assert.equal(previewHostAllowed('https://x.preview.acme.dev/', ['preview.acme.dev']), false);
    assert.equal(previewHostAllowed('https://pr-1.staging.acme.dev/', ['*.staging.acme.dev']), true);
    // runFrames refuses before launching a browser, so the secret is never sent.
    await assert.rejects(run.runFrames({ baseUrl: 'https://attacker.example/', frames: [{ path: '/', design: 'x.png' }], outDir: tmpDir(), headers: { 'x-vercel-protection-bypass': 'S' }, log: () => {} }),
        (e) => e instanceof UsageError && /preview-hosts|allowlist/.test(e.message));
});

test('N1: the Action refuses to send the bypass secret to a preview host outside preview-hosts', async () => {
    const SECRET = 'bypass-N1-8c1f0e';
    const cfg = path.join(tmpDir(), '.framedrift.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', design: 'x.png' }] }));
    const r = await runAction({ 'preview-url': 'https://attacker.example/', 'vercel-bypass-secret': SECRET, config: cfg, 'github-token': '' });
    assert.equal(r.outputs.gate, 'error', r.out);
    assert.match(r.out, /::error::.*preview-hosts/);
    assert.ok(!r.out.includes(SECRET));
});

test('N1: README has a Security section and no longer invites "any event"', () => {
    const md = read('README.md');
    assert.doesNotMatch(md, /run it on any event/);
    const sec = md.split(/^### Security\b/m)[1]?.split(/^##/m)[0];
    assert.ok(sec, 'no "### Security" section');
    assert.match(sec, /pull_request_target/);
    assert.match(sec, /GitHub-hosted runners/);
    assert.match(sec, /deploy provider/);
    assert.match(sec, /preview-hosts/);
});

// ---------- R68-03 / N2: one redactor for every output ----------
test('R68-03/N2: secrets in preview/frame URLs never reach results.json, index.html, summary.md or the log', async () => {
    const S = 'Zq9SECRETzz71';
    const port = await closedPort();
    const dir = tmpDir();
    const design = path.join(dir, 'd.png'); fs.writeFileSync(design, whitePng(8, 8));
    const logs = [];
    const res = await run.runFrames({
        baseUrl: `http://user:pw${S}@127.0.0.1:${port}/?x-vercel-protection-bypass=${S}&token=${S}&page=2`,
        frames: [
            { name: `Home https://cdn.example/a.png?sig=${S}`, path: `/p?token=${S}&_vercel_share=${S}`, design },
            { path: `/q?access_token=${S}`, design },
        ],
        outDir: path.join(dir, 'out'), allowLoopback: true, log: (m) => logs.push(m),
    });
    assert.equal(res.errors.length, 2);
    const outputs = { log: logs.join('\n'), 'results.json': fs.readFileSync(res.report.json, 'utf8'), 'index.html': fs.readFileSync(res.report.html, 'utf8'), 'summary.md': fs.readFileSync(res.report.markdown, 'utf8') };
    for (const [name, text] of Object.entries(outputs)) assert.ok(!text.includes(S), `${name} contains the secret:\n${text.split('\n').filter((l) => l.includes(S)).join('\n')}`);
    assert.match(outputs['results.json'], /token=REDACTED/, 'secret params are shown as REDACTED, not dropped');
    assert.match(outputs['summary.md'], /page=2/, 'non-secret params of the preview URL are kept');
});

test('R68-03/N2: the Action log, step summary, notes.json and outputs never contain the secret either', async () => {
    const S = 'Yx4SECRETqq28';
    const port = await closedPort();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.png'), whitePng(8, 8));
    fs.writeFileSync(path.join(dir, '.framedrift.json'), JSON.stringify({ frames: [{ name: `F ?token=${S}`, path: `/x?session=${S}`, design: 'd.png' }] }));
    const r = await runAction({ 'preview-url': `http://u:p${S}@127.0.0.1:${port}/?token=${S}`, config: path.join(dir, '.framedrift.json'), 'allow-loopback-preview': 'true', 'github-token': '' });
    assert.equal(r.outputs.gate, 'error', r.out);
    const reportDir = r.outputs['report-dir'];
    const all = { log: r.out, summary: r.summary, outputs: JSON.stringify(r.outputs), ...Object.fromEntries(fs.readdirSync(reportDir).filter((f) => !f.endsWith('.png')).map((f) => [f, fs.readFileSync(path.join(reportDir, f), 'utf8')])) };
    for (const [name, text] of Object.entries(all)) assert.ok(!text.includes(S), `${name} contains the secret`);
});

test('R68-03/N2: redactText handles absolute URLs, root-relative paths, userinfo and literal secret values', () => {
    const { redactText, redactDeep } = redact;
    assert.equal(typeof redactText, 'function', 'redact.redactText missing');
    assert.equal(redactText('/login?token=abc&x=1'), '/login?token=REDACTED&x=1');
    assert.equal(redactText('see https://u:pw@h.dev/a?sig=zz#f'), 'see https://h.dev/a?sig=REDACTED#f');
    assert.equal(redactText('Frame ?_vercel_share=zz and &api_key=k'), 'Frame ?_vercel_share=REDACTED and &api_key=REDACTED');
    assert.equal(redactText('header value Q1W2E3R4 leaked', { secrets: ['Q1W2E3R4'] }), 'header value REDACTED leaked');
    assert.deepEqual(redactDeep({ a: ['/x?token=1'], b: { c: 'ok' }, n: 3 }), { a: ['/x?token=REDACTED'], b: { c: 'ok' }, n: 3 });
    // Report renderers redact name, path, url and error themselves (library users call them directly).
    const row = { name: 'n?token=T1', path: '/p?secret=T2', url: 'https://h.dev/?bypass=T3', error: 'GET https://h.dev/?jwt=T4 failed', figma: null };
    for (const out of [report.renderMarkdown([row]), report.renderHtml([row])]) for (const t of ['T1', 'T2', 'T3', 'T4']) assert.ok(!out.includes(`=${t}`), t);
});

// ---------- R68-04 / N5: sticky comment matches the exact authenticated identity ----------
function ghFake(comments, { user = null, viewer = null } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const p = new URL(url).pathname;
        calls.push(`${init.method} ${p}`);
        if (p === '/user') return user ? new Response(JSON.stringify({ login: user }), { status: 200 }) : new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
        if (p === '/graphql') return viewer ? new Response(JSON.stringify({ data: { viewer: { login: viewer } } }), { status: 200 }) : new Response('{}', { status: 403 });
        if (init.method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
        if (init.method === 'PATCH') return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    };
    return { gh: new GitHub({ token: 't', repository: 'a/b', apiUrl: 'https://api.test', fetchImpl }), calls };
}
const M = '<!-- framedrift-report -->';

test('R68-04/N5: another app\'s Bot comment quoting the marker is not PATCHed', async () => {
    const { gh, calls } = ghFake([{ id: 3, body: `quote ${M}`, user: { login: 'other-app[bot]', type: 'Bot' } }], { viewer: 'github-actions[bot]' });
    const r = await gh.upsertComment(7, 'body', M);
    assert.equal(r.action, 'created');
    assert.ok(!calls.some((c) => c.startsWith('PATCH')), calls.join('\n'));
});

test('R68-04/N5: the comment by the token\'s own identity is updated (GraphQL viewer for app tokens)', async () => {
    const comments = [
        { id: 3, body: M, user: { login: 'other-app[bot]', type: 'Bot' } },
        { id: 4, body: M, user: { login: 'my-app[bot]', type: 'Bot' } },
    ];
    const { gh, calls } = ghFake(comments, { viewer: 'my-app[bot]' });
    assert.equal((await gh.upsertComment(7, 'body', M)).action, 'updated');
    assert.ok(calls.includes('PATCH /repos/a/b/issues/comments/4'), calls.join('\n'));
    assert.ok(!calls.includes('PATCH /repos/a/b/issues/comments/3'));
});

test('R68-04/N5: identity unknown (no /user, no GraphQL) falls back to github-actions[bot] only', async () => {
    const { gh, calls } = ghFake([{ id: 3, body: M, user: { login: 'other-app[bot]', type: 'Bot' } }, { id: 5, body: M, user: { login: 'github-actions[bot]', type: 'Bot' } }]);
    assert.equal((await gh.upsertComment(7, 'body', M)).action, 'updated');
    assert.ok(calls.includes('PATCH /repos/a/b/issues/comments/5'));
    assert.ok(!calls.includes('PATCH /repos/a/b/issues/comments/3'));
});

// ---------- R68-02: runFrames validates its settings ----------
test('R68-02: runFrames rejects invalid failOn / threshold before doing any work', async () => {
    const base = { baseUrl: 'https://a.vercel.app', frames: [{ path: '/', design: 'x.png' }], outDir: tmpDir(), log: () => {} };
    for (const bad of [{ failOn: 'abc' }, { failOn: '5%' }, { failOn: -1 }, { failOn: 101 }, { failOn: NaN }, { threshold: 2 }, { threshold: 'x' },
        { defaults: { failOn: 'abc' } }, { frames: [{ path: '/', design: 'x.png', failOn: 'abc' }] }, { frames: [{ path: '/', design: 'x.png', threshold: -0.5 }] }]) {
        await assert.rejects(run.runFrames({ ...base, ...bad }), (e) => e instanceof UsageError && /failOn|threshold/.test(e.message), JSON.stringify(bad));
    }
});

// ---------- N4: no autolinks from untrusted text in the PR comment ----------
test('N4: bare URLs and www. hosts in names, layer text and errors are not autolinked by GitHub', () => {
    const rows = [
        { name: 'Go to https://evil.example/p', path: '/', mismatchPercent: 5, failOn: 2, hotspots: [{ x: 0, y: 0, width: 1, height: 1, pixels: 1, layer: { path: 'Card', text: 'visit www.evil.example or ftp://evil.example' } }] },
        { name: 'E', path: '/e', error: 'Could not reach preview http://evil.example/x and mailto:a@b.example' },
    ];
    const md = report.renderMarkdown(rows);
    const bare = md.split('\n').filter((l) => l.startsWith('|')).join('\n');
    assert.doesNotMatch(bare, /(?:https?|ftp):\/\//i, bare);
    assert.doesNotMatch(bare, /\bwww\./i, bare);
    assert.doesNotMatch(bare, /mailto:/i, bare);
    assert.match(bare, /evil\.example/, 'text is still shown');
});

// ---------- N6: no silent green ----------
test('N6: zero frames fails the Action loudly (gate=error, not skipped)', async () => {
    const r = await runAction({ 'preview-url': 'https://a.vercel.app/', 'github-token': '' });
    assert.notEqual(r.outputs.skipped, 'true', r.out);
    assert.equal(r.outputs.gate, 'error', r.out);
    assert.match(r.out, /::error::.*no frames/i);
});

test('N6: a config input pointing at a missing file is an error, even if the PR body has frames', async () => {
    const r = await runAction({ 'preview-url': 'https://a.vercel.app/', config: 'docs/typo.framedrift.json', 'github-token': '' },
        { event: { pull_request: { number: 1, body: 'framedrift: /login https://www.figma.com/design/AbC123/x?node-id=1-2' } } });
    assert.equal(r.outputs.gate, 'error', r.out);
    assert.match(r.out, /::error::.*typo\.framedrift\.json.*not found/);
});

test('N6: a dropped PR-body framedrift line is reported, not silently ignored', () => {
    const ignored = [];
    const frames = config.parsePrBody('framedrift: //evil.example/x https://www.figma.com/design/AbC123/x?node-id=1-2\nframedrift: /ok https://www.figma.com/design/AbC123/x?node-id=1-3', { onIgnored: (l) => ignored.push(l) });
    assert.deepEqual(frames.map((f) => f.path), ['/ok']);
    assert.equal(ignored.length, 1);
    assert.match(ignored[0], /\/\/evil/);
});

// ---------- N7 / N8 / F9: docs and examples ----------
test('N7: the example workflow does not hard-code fail-on (it would override .framedrift.json defaults)', () => {
    assert.doesNotMatch(read('examples/.github/workflows/framedrift.yml'), /^\s*fail-on:\s*\S/m);
});

test('N8: README and examples use the current action majors (checkout@v7)', () => {
    for (const f of ['README.md', 'examples/.github/workflows/framedrift.yml', 'docs/troubleshooting.md']) {
        if (!fs.existsSync(path.join(root, f))) continue;
        assert.doesNotMatch(read(f), /actions\/(checkout|setup-node|upload-artifact)@v[1-6]\b/, f);
    }
    assert.match(read('README.md'), /actions\/checkout@v7/);
});

test('F9/N11: README says the Pro check fails open on any network error and documents FRAMEDRIFT_POLAR_API', () => {
    const md = read('README.md');
    assert.doesNotMatch(md, /timeout or 5xx/);
    assert.match(md, /any network error/);
    assert.match(md, /not (an )?authorization/i);
    assert.match(md, /FRAMEDRIFT_POLAR_API/);
});

// ---------- R68-01 docs ----------
test('R68-01: CHANGELOG and README describe non-GET redirect hops accurately', () => {
    for (const f of ['CHANGELOG.md', 'README.md']) assert.match(read(f), /303[^.]*GET|GET[^.]*303/, f);
});
