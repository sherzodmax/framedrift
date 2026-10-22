// Edge cases that should fail clearly (or degrade gracefully) instead of crashing or hanging.
// No browser and no network: Figma, Polar and the CLI's early validation are exercised with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pngjs from 'pngjs';
import { FigmaClient, FigmaApiError, redactToken } from '../src/figma.js';
import { fetchFigmaFrame } from '../src/compare.js';
import { compareImages } from '../src/diff.js';
import { describeNavigationError } from '../src/capture.js';
import { parseNumber, UsageError } from '../src/args.js';
import { runFrames } from '../src/run.js';
import { resolveTier } from '../src/license.js';
import { upgradeUrl, isPlaceholderOrg, POLAR_ORGANIZATION_ID } from '../src/launch-config.js';
import { renderMarkdown } from '../src/report.js';
import { parsePrBody, loadConfigFile } from '../src/config.js';

const { PNG } = pngjs;
const bin = new URL('../bin/framedrift.js', import.meta.url).pathname;
const TOKEN = 'figd_SECRETSECRET_abcdefghijkl';
const png = (w, h, rgb = [255, 255, 255]) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4); return PNG.sync.write(p); };
const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
/** Fake fetch that answers from a queue and records calls. */
function queue(...responses) {
    const calls = [];
    const f = async (url, init) => { calls.push({ url, init }); const r = responses.shift(); if (r instanceof Error) throw r; return typeof r === 'function' ? r() : r; };
    f.calls = calls;
    return f;
}
const cli = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 30000 });

// ---------- Missing / bad Figma token ----------
test('missing Figma token: client refuses to construct with a NO_TOKEN error', () => {
    assert.throws(() => new FigmaClient({ token: '' }), (e) => e instanceof FigmaApiError && e.code === 'NO_TOKEN' && /access token is required/.test(e.message));
});

test('missing Figma token: `compare --figma` exits 2 before launching a browser', () => {
    const r = cli(['compare', '--url', 'http://127.0.0.1:9/', '--figma', 'https://www.figma.com/design/AbC1234567/x?node-id=1-2']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Figma token is required/);
    assert.doesNotMatch(r.stderr, /browser:/);
});

test('missing Figma token: `run` with Figma frames exits 2 with a usage message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-edge-'));
    const cfg = path.join(dir, '.framedrift.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', figma: 'https://www.figma.com/design/AbC1234567/x?node-id=1-2' }] }));
    const r = cli(['run', '--base-url', 'http://127.0.0.1:9', '--config', cfg]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Figma token is required/);
});

test('missing Figma token: runFrames throws a UsageError (library use)', async () => {
    await assert.rejects(runFrames({ baseUrl: 'http://x', frames: [{ path: '/', figma: 'https://www.figma.com/design/K/x?node-id=1-2' }], outDir: os.tmpdir() }), UsageError);
});

test('rejected token: 403 gives a scope/access hint and never echoes the token', async () => {
    const c = new FigmaClient({ token: TOKEN, fetchImpl: queue(reply(403, { status: 403, err: `Invalid token ${TOKEN}` })) });
    await assert.rejects(c.getNodes('KEY', ['1:2']), (e) => {
        assert.equal(e.code, 'HTTP_403');
        assert.match(e.message, /lacks the needed scope|cannot access/);
        assert.ok(!e.message.includes(TOKEN), e.message);
        return true;
    });
});

test('token is sent only as X-Figma-Token and redacted from any string', async () => {
    const f = queue(reply(200, { ok: true }));
    await new FigmaClient({ token: TOKEN, fetchImpl: f }).get('/v1/me');
    assert.equal(f.calls[0].init.headers['X-Figma-Token'], TOKEN);
    assert.ok(!f.calls[0].url.includes(TOKEN));
    assert.equal(redactToken(`x ${TOKEN} y`), 'x [redacted-token] y');
    assert.ok(!JSON.stringify(new FigmaClient({ token: TOKEN })).includes(TOKEN));
});

// ---------- Rate limits ----------
test('rate limit: long Retry-After fails fast with RATE_LIMITED (no hour-long sleep in CI)', async () => {
    const f = queue(reply(429, { err: 'Rate limit exceeded' }, { 'retry-after': '7200', 'x-figma-rate-limit-type': 'low' }));
    const started = Date.now();
    await assert.rejects(new FigmaClient({ token: TOKEN, fetchImpl: f }).getNodes('KEY', ['1:2']), (e) => {
        assert.equal(e.code, 'RATE_LIMITED');
        assert.equal(e.retryAfterSecs, 7200);
        assert.match(e.message, /wait 7200s.*limit type: low/);
        return true;
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.calls.length, 1);
});

test('rate limit: short Retry-After is honoured, then the request succeeds', async () => {
    const logs = [];
    const f = queue(reply(429, { err: 'slow down' }, { 'retry-after': '0.01' }), reply(200, { nodes: {} }));
    const r = await new FigmaClient({ token: TOKEN, fetchImpl: f, onLog: (m) => logs.push(m) }).getNodes('KEY', ['1:2']);
    assert.deepEqual(r, { nodes: {} });
    assert.equal(f.calls.length, 2);
    assert.match(logs[0], /429.*retrying/);
});

test('rate limit: persistent 429s give up after maxRetries with RATE_LIMITED', async () => {
    const f = queue(...Array.from({ length: 3 }, () => reply(429, {}, { 'retry-after': '0.01' })));
    await assert.rejects(new FigmaClient({ token: TOKEN, fetchImpl: f, maxRetries: 2 }).get('/v1/x'), (e) => e.code === 'RATE_LIMITED' && /after 2 retries/.test(e.message));
    assert.equal(f.calls.length, 3);
});

test('Figma 5xx and network failures surface as SERVER / NETWORK errors', async () => {
    await assert.rejects(new FigmaClient({ token: TOKEN, maxRetries: 0, fetchImpl: queue(reply(502, 'Bad gateway')) }).get('/v1/x'), (e) => e.code === 'SERVER');
    await assert.rejects(new FigmaClient({ token: TOKEN, maxRetries: 0, fetchImpl: queue(new TypeError('fetch failed')) }).get('/v1/x'), (e) => e.code === 'NETWORK' && /Network error/.test(e.message));
    await assert.rejects(new FigmaClient({ token: TOKEN, fetchImpl: queue(reply(200, '<html>')) }).get('/v1/x'), (e) => e.code === 'BAD_JSON');
});

// ---------- Bad Figma links / frames ----------
test('Figma frame problems give actionable errors', async () => {
    const client = (nodes, images = { '1:2': 'https://s3/x.png' }) => new FigmaClient({ token: TOKEN, fetchImpl: queue(reply(200, { name: 'F', nodes }), reply(200, { images })) });
    await assert.rejects(fetchFigmaFrame(client({}), 'https://www.figma.com/design/AbC1234567/x'), /no node-id.*Copy link to selection/);
    await assert.rejects(fetchFigmaFrame(client({ '1:2': null }), 'https://www.figma.com/design/AbC1234567/x?node-id=1-2'), /Node 1:2 not found/);
    await assert.rejects(fetchFigmaFrame(client({ '1:2': { document: { id: '1:2', type: 'CANVAS' } } }), 'https://www.figma.com/design/AbC1234567/x?node-id=1-2'), /has no bounds/);
    const box = { document: { id: '1:2', type: 'FRAME', name: 'Hidden', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } } };
    await assert.rejects(fetchFigmaFrame(client({ '1:2': box }, { '1:2': null }), 'https://www.figma.com/design/AbC1234567/x?node-id=1-2'), /could not render node 1:2/);
    await assert.rejects(fetchFigmaFrame(client({}), 'https://evil.example/design/AbC1234567/x?node-id=1-2'), /Not a figma.com URL/);
});

// ---------- Unreachable preview ----------
test('unreachable preview: Playwright errors become one actionable sentence', () => {
    const e = (m, name) => Object.assign(new Error(m), name ? { name } : {});
    assert.equal(describeNavigationError('http://127.0.0.1:9/', e('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/\nCall log:\n  - navigating')),
        'Could not reach preview http://127.0.0.1:9/: ERR_CONNECTION_REFUSED (nothing is listening there — is the preview/dev server running?)');
    assert.match(describeNavigationError('https://nope.invalid', e('net::ERR_NAME_NOT_RESOLVED')), /does not resolve/);
    assert.match(describeNavigationError('https://slow.dev', e('page.goto: Timeout 45000ms exceeded.', 'TimeoutError')), /did not finish loading in time \(45000 ms\)/);
    assert.match(describeNavigationError('notaurl', e('page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL')), /Invalid preview URL/);
    assert.doesNotMatch(describeNavigationError('x', e('weird\nmultiline')), /\n/);
});

// ---------- Mismatched frame sizes ----------
test('size mismatch: page narrower than the frame → missing columns count as drift', () => {
    const r = compareImages(png(100, 50), png(80, 50));
    assert.equal(r.sizeMismatch, true);
    assert.equal(r.mismatchedPixels, 20 * 50);
    assert.deepEqual(r.actualSize, { width: 80, height: 50 });
    assert.equal(r.hotspots[0].x, 80);
});

test('size mismatch: page wider than the frame → flagged, extra area ignored', () => {
    const r = compareImages(png(100, 50), png(130, 50));
    assert.equal(r.sizeMismatch, true);
    assert.equal(r.mismatchedPixels, 0);
});

test('page taller than the frame (normal long page) is not a mismatch', () => {
    const r = compareImages(png(100, 50), png(100, 400));
    assert.equal(r.sizeMismatch, false);
    assert.equal(r.mismatchedPixels, 0);
    assert.deepEqual(r.designSize, { width: 100, height: 50 });
});

test('size mismatch shows up in the PR comment', () => {
    const md = renderMarkdown([{ name: 'A', path: '/', mismatchPercent: 20, sizeMismatch: true, hotspots: [] }], { failOn: 2 });
    assert.match(md, /\*\*20%\*\* \(size differs\)/);
});

test('fully transparent design (frame without fill) is flattened onto white', () => {
    const p = new PNG({ width: 4, height: 4 }); // all zeros = transparent black
    const r = compareImages(PNG.sync.write(p), png(4, 4));
    assert.equal(r.mismatchedPixels, 0);
});

// ---------- Input validation ----------
test('numeric options reject garbage instead of silently never failing', () => {
    assert.equal(parseNumber(undefined, 'x'), undefined);
    assert.equal(parseNumber('2.5', 'fail-on', { min: 0, max: 100 }), 2.5);
    assert.throws(() => parseNumber('abc', 'fail-on', { min: 0, max: 100 }), UsageError);
    assert.throws(() => parseNumber('1.5', 'threshold', { min: 0, max: 1 }), /between 0 and 1/);
    assert.throws(() => parseNumber('-1', 'scale', { min: 0.01, max: 4 }), UsageError);
    for (const [flag, v] of [['--fail-on', 'abc'], ['--threshold', '7'], ['--scale', '0'], ['--viewport', 'wide']]) {
        const r = cli(['compare', '--url', 'http://127.0.0.1:9/', '--design', bin, flag, v]);
        assert.equal(r.status, 2, `${flag} ${v}: ${r.stderr}`);
    }
});

test('CLI usage errors: unknown command, missing --url, missing design file, missing config', () => {
    assert.equal(cli(['frobnicate']).status, 2);
    assert.match(cli(['compare', '--design', 'x.png']).stderr, /--url is required/);
    assert.match(cli(['compare', '--url', 'http://x', '--design', '/nope.png']).stderr, /design file not found/);
    const r = cli(['run', '--base-url', 'http://x', '--config', '/nope/.framedrift.json']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /config file not found/);
    assert.equal(cli(['--version']).stdout.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
});

test('config: invalid JSON, bad shapes, and design paths resolved relative to the config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cfg-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ frames: [');
    assert.throws(() => loadConfigFile(path.join(dir, 'bad.json')), /bad\.json is not valid JSON/);
    fs.writeFileSync(path.join(dir, 'nofig.json'), JSON.stringify({ frames: [{ path: '/' }] }));
    assert.throws(() => loadConfigFile(path.join(dir, 'nofig.json')), /frames\[0\] needs a "figma" frame link or a "design" PNG path/);
    fs.writeFileSync(path.join(dir, 'obj.json'), JSON.stringify({ frames: { path: '/' } }));
    assert.throws(() => loadConfigFile(path.join(dir, 'obj.json')), /"frames" must be an array/);
    fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify({ frames: [{ path: '/', design: 'shots/home.png' }] }));
    assert.equal(loadConfigFile(path.join(dir, 'design.json')).frames[0].design, path.join(dir, 'shots/home.png'));
});

test('PR body: look-alike hosts are not treated as Figma links', () => {
    assert.deepEqual(parsePrBody('framedrift: /x https://figma.com.evil.dev/design/ABC123/x?node-id=1-2'), []);
    assert.deepEqual(parsePrBody('framedrift: /x https://notfigma.com/design/ABC123/x?node-id=1-2'), []);
});

test('PR comment escapes pipes and newlines from user-controlled names', () => {
    const md = renderMarkdown([{ name: 'a|b\nc', path: '/p|q', error: 'x' }], { failOn: 2 });
    const row = md.split('\n').find((l) => l.startsWith('| ❌'));
    assert.equal(row, '| ❌ | a\\|b c | /p\\|q | — | x |');
});

// ---------- Licensing without Polar configured ----------
test('no Polar org configured (pre-launch build): a key never grants Pro and makes no network call', async () => {
    assert.ok(isPlaceholderOrg(POLAR_ORGANIZATION_ID), 'repo should ship with the placeholder until launch');
    const f = queue();
    const r = await resolveTier('SOME-KEY', { fetchImpl: f });
    assert.equal(r.tier, 'free');
    assert.match(r.reason, /not set up/);
    assert.equal(f.calls.length, 0);
});

test('license server slow/down: times out into a Pro grace run; garbage body → free', async () => {
    const org = '11111111-2222-4333-8444-555555555555';
    // AbortSignal.timeout() timers are unref'd, so keep the event loop alive while we wait for it.
    const hang = (url, init) => new Promise((_, rej) => {
        const keepAlive = setTimeout(() => {}, 5000);
        init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); rej(init.signal.reason); });
    });
    const r = await resolveTier('K', { organizationId: org, fetchImpl: hang, timeoutMs: 50 });
    assert.equal(r.tier, 'pro');
    assert.equal(r.grace, true);
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: queue(reply(200, 'not json')) })).tier, 'free');
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: queue(reply(503, '')) })).tier, 'pro');
    assert.equal((await resolveTier('K', { organizationId: org, fetchImpl: queue(reply(422, {})) })).tier, 'free');
});

test('upgrade link never contains a placeholder', () => {
    const u = upgradeUrl();
    assert.match(u, /^https:\/\//);
    assert.doesNotMatch(u, /POLAR_CHECKOUT_URL|OWNER/);
});
