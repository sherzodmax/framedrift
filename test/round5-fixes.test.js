// Regression tests for the round-5 review (qa-proof/codex-review-2026-10-22.md: "Round 5 re-check (1ea438d)").
// Each test names its finding and failed before the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { redactText } from '../src/redact.js';
import { resolvePreviewHosts, previewHostAllowed } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fd-r5-'));
const DESIGN = path.join(root, 'test/fixtures/example-design-with-h1.png');

// A private copy of the Figma mock whose frame 20:1 has secret-looking layer names (Figma layer names are untrusted).
const SECRETS = ['DESIGNTOK5abc', 'CFGTOK5abc', 'OUTTOK5abc', 'LAYERTOK5abc', 'HDRBEARER5abc', 'URLTOK5abc', 'HDRCOLON5abc', 'FRAMETOK5abc'];
let mock; let page; let U; let work; let TEST_TOKEN;
before(async () => {
    work = tmpDir();
    fs.mkdirSync(path.join(work, 't/support'), { recursive: true });
    fs.mkdirSync(path.join(work, 't/fixtures'), { recursive: true });
    fs.copyFileSync(path.join(root, 'test/support/mock-figma.js'), path.join(work, 't/support/mock-figma.js'));
    fs.cpSync(path.join(root, 'test/fixtures/figma'), path.join(work, 't/fixtures/figma'), { recursive: true });
    const fj = path.join(work, 't/fixtures/figma/file.json');
    const file = JSON.parse(fs.readFileSync(fj, 'utf8'));
    const visit = (n, inFrame) => { if (inFrame && n.id !== '20:1') n.name = `${n.name} ?token=LAYERTOK5abc`; for (const c of n.children || []) visit(c, inFrame || n.id === '20:1'); };
    visit(file.document, false);
    fs.writeFileSync(fj, JSON.stringify(file));
    const m = await import(path.join(work, 't/support/mock-figma.js'));
    TEST_TOKEN = m.TEST_TOKEN;
    mock = await m.startMockFigma({});
    page = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<body style="margin:0;background:#fff"><h1>hi</h1></body>'); });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    U = `http://127.0.0.1:${page.address().port}`;
});
after(async () => { page?.close(); mock?.server?.close?.(); await mock?.close?.(); });

/** Run main() with console.log / console.error captured; FIGMA_API_BASE points at the mock. */
async function runMain(argv) {
    const env = { FIGMA_API_BASE: process.env.FIGMA_API_BASE, FIGMA_TOKEN: process.env.FIGMA_TOKEN };
    process.env.FIGMA_API_BASE = mock.baseUrl; process.env.FIGMA_TOKEN = TEST_TOKEN;
    const out = []; const err = []; const ol = console.log; const oe = console.error;
    console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '));
    let code;
    try { code = await main(argv); } finally {
        console.log = ol; console.error = oe;
        for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return { code, out: out.join('\n'), err: err.join('\n') };
}
const leaks = (r) => [...SECRETS, TEST_TOKEN].filter((s) => r.out.includes(s) || r.err.includes(s));

// ---------- C70-01: every CLI line goes through the redactor ----------
test('C70-01: design path, config path, invalid --header, frame names and Figma layer names never reach stdout / stderr', async (t) => {
    const cfg = path.join(work, 'frames.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ name: 'Login ?token=FRAMETOK5abc', path: '/x?token=FRAMETOK5abc', design: DESIGN }] }));
    const runs = {
        'design not found (cli.js:99)': ['compare', '--url', `${U}/`, '--design', `${work}/missing.png?token=DESIGNTOK5abc`],
        'config not found (cli.js:124)': ['run', '--base-url', `${U}/`, '--config', `${work}/cfg.json?token=CFGTOK5abc`],
        'invalid header, no colon (args.js:35 via cli.js:140)': ['compare', '--url', `${U}/`, '--design', DESIGN, '--header', 'Authorization Bearer HDRBEARER5abc'],
        'invalid header, empty name': ['compare', '--url', `${U}/`, '--design', DESIGN, '--header', ': X-Api-Key HDRCOLON5abc'],
        'figma layer paths (printResult, cli.js:151)': ['compare', '--url', `${U}/login?token=URLTOK5abc`, '--figma', 'https://www.figma.com/design/FIXTUREFILEKEY01/Acme?node-id=20-1', '--out', `${work}/out-fig`],
        'figma --json': ['compare', '--json', '--url', `${U}/login?token=URLTOK5abc`, '--figma', 'https://www.figma.com/design/FIXTUREFILEKEY01/Acme?node-id=20-1', '--out', `${work}/out-fig2`],
        'run log + summary (runFrames log, summary.md)': ['run', '--base-url', `${U}/`, '--config', cfg, '--out', `${work}/out-run`],
    };
    const bad = [];
    for (const [label, argv] of Object.entries(runs)) {
        const r = await runMain(argv);
        const l = leaks(r);
        if (l.length) bad.push(`${label} (exit ${r.code}): ${l.join(', ')}\n  stdout: ${r.out.slice(0, 400)}\n  stderr: ${r.err.slice(0, 400)}`);
        t.diagnostic(`${label}: exit ${r.code}, ${l.length ? `LEAK ${l.join(',')}` : 'clean'}`);
        const expect = (ok, what) => { if (!ok) bad.push(`${label}: ${what} (exit ${r.code})`); };
        if (label.startsWith('figma layer')) { expect(r.code === 0, 'exit 0'); expect(/token=REDACTED/.test(r.out), 'layer names are still shown, redacted'); }
        if (label.startsWith('design not found') || label.startsWith('config not found')) { expect(r.code === 2, 'exit 2'); expect(/not found: .*token=REDACTED/.test(r.err), 'path shown redacted'); }
        if (label.startsWith('invalid header')) { expect(r.code === 2, 'exit 2'); expect(/Invalid header/.test(r.err), 'names the problem'); }
    }
    assert.deepEqual(bad, []);
});

test('C70-01: --help is printed unchanged through the redactor', async () => {
    const r = await runMain(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /--header {9}Extra HTTP header for the page, repeatable: "Name: value"/);
    assert.ok(!r.out.includes('REDACTED'));
});

test('C70-01: the redactor knows Bearer / Basic credentials and secret "Name: value" headers', () => {
    const cases = {
        'Invalid header "Authorization Bearer abcDEF123xyz"': 'abcDEF123xyz',
        'authorization: bearer abcDEF123xyz': 'abcDEF123xyz',
        'Authorization: Basic dXNlcjpwYXNzd29yZA==': 'dXNlcjpwYXNzd29yZA==',
        'proxy-authorization: Token abcDEF123xyz': 'abcDEF123xyz',
        'X-Api-Key: k3y-VALUE-123 (from --header)': 'k3y-VALUE-123',
        'Cookie: sid=abc; theme=dark': 'sid=abc',
        'x-vercel-protection-bypass: bypassVALUE123': 'bypassVALUE123',
        '{"authorization":"Bearer abcDEF123xyz"}': 'abcDEF123xyz',
        "headers: { 'X-Auth-Token': 'tokVALUE123' }": 'tokVALUE123',
        'curl -H "Authorization: Bearer abcDEF123xyz" https://x': 'abcDEF123xyz',
    };
    for (const [input, secret] of Object.entries(cases)) {
        const out = redactText(input);
        assert.ok(!out.includes(secret), `${JSON.stringify(input)} → ${JSON.stringify(out)}`);
        assert.match(out, /REDACTED/);
    }
    // Non-secret "Name: value" text and URLs are left alone.
    for (const keep of ['framedrift: design file not found: /tmp/a.png', 'Content-Type: text/html', 'error: page returned 500', 'https://example.com/a?page=2', 'design: 390×844', 'Name: value', 'Basic auth is not supported', 'Token budget: 20']) {
        assert.equal(redactText(keep), keep);
    }
});

// ---------- R5-04: raw paths for I/O, redacted ones for display ----------
test('R5-04: --out with a secret-looking query string works; the printed path is redacted', async () => {
    const out = `${work}/out?token=OUTTOK5abc`;
    const r = await runMain(['compare', '--url', `${U}/?token=URLTOK5abc`, '--design', DESIGN, '--out', out]);
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.ok(fs.existsSync(path.join(out, 'index.html')), 'index.html is written to the real --out path');
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /data:image\/png;base64,/, 'the report embeds the images read from the real paths');
    assert.ok(!fs.existsSync(`${work}/out?token=REDACTED`), 'nothing is written to the redacted path');
    assert.deepEqual(leaks(r), []);
    assert.match(r.out + r.err, /out\?token=REDACTED/);
});

test('R5-04: run --out with a secret-looking path writes every artifact there', async () => {
    const cfg = path.join(work, 'frames2.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', design: DESIGN }] }));
    const out = `${work}/run?sig=OUTTOK5abc`;
    const r = await runMain(['run', '--base-url', `${U}/`, '--config', cfg, '--out', out]);
    assert.equal(r.code, 0, r.err);
    for (const f of ['index.html', 'summary.md', 'results.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.deepEqual(leaks(r), []);
});

test('Round 5 probe table: fullwidth "？token＝" is redacted like "?token="', () => {
    const out = redactText('/p？token＝FW1abcdef');
    assert.ok(!out.includes('FW1abcdef'), out);
    assert.ok(!redactText('/p?tökén=UNIK1abc').includes('UNIK1abc'), 'accented key');
});

// ---------- R5-01 / R5-02 ----------
test('R5-01: percent-encoding is decoded until stable (any depth up to the cap), so a quadruple-encoded pair is caught', () => {
    let enc = '?token=QUADSECRET1abc';
    for (let i = 0; i < 4; i++) enc = encodeURIComponent(enc);
    const out = redactText(`https://a.test/r?next=${enc}`);
    assert.ok(!out.includes('QUADSECRET1abc'), out);
    let six = 'sig=SIXSECRET1abc'; for (let i = 0; i < 6; i++) six = encodeURIComponent(six);
    assert.ok(!redactText(`/x?n=${six}`).includes('SIXSECRET1abc'));
    assert.doesNotMatch(read('src/redact.js'), /any depth\)/, 'the comment no longer claims "any depth" without a loop that does it');
});

test('R5-02: code, pwd, pass and otp parameters are secrets; zipcode, passage and footprint are not', () => {
    for (const k of ['code', 'oauth_code', 'auth-code', 'pwd', 'pass', 'passphrase', 'otp', 'totp_otp', 'OTP']) {
        assert.ok(!redactText(`https://a.test/cb?${k}=VAL${k}123456`).includes(`VAL${k}123456`), k);
    }
    for (const k of ['zipcode', 'passage', 'footprint', 'codec', 'qrcode']) {
        const s = `https://a.test/x?${k}=keepme`;
        assert.equal(redactText(s), s, k);
    }
});

// ---------- R4-03 tightened ----------
test('R4-03: vercel-project + vercel-team allow only <p>-<9 chars>-<t> and <p>-git-*-<t>', () => {
    const { hosts, source } = resolvePreviewHosts({ project: 'myproj', team: 'acme' });
    assert.equal(source, 'vercel-project');
    assert.deepEqual(hosts, ['myproj-?????????-acme.vercel.app', 'myproj-git-*-acme.vercel.app']);
    const ok = ['myproj-a1b2c3d4e-acme.vercel.app', 'myproj-git-main-acme.vercel.app', 'myproj-git-feat-x-acme.vercel.app'];
    const no = ['myproj-acme.vercel.app', 'myproj-a1b2c3d4-acme.vercel.app', 'myproj-a1b2c3d4ef-acme.vercel.app', 'myproj-a1b2-c3d4-acme.vercel.app', 'myproj-a1b2c3d4e-x-acme.vercel.app', 'myproj-a1b2c3d4e-acme2.vercel.app', 'myproj-git--acme.vercel.app', 'myproj.vercel.app', 'evil-myproj-a1b2c3d4e-acme.vercel.app'];
    for (const h of ok) assert.equal(previewHostAllowed(`https://${h}/`, hosts), true, h);
    for (const h of no) assert.equal(previewHostAllowed(`https://${h}/`, hosts), false, h);
    const solo = resolvePreviewHosts({ project: 'myproj' }).hosts;
    assert.deepEqual(solo, ['myproj-?????????-*.vercel.app', 'myproj-git-*.vercel.app']);
    assert.equal(previewHostAllowed('https://myproj-a1b2c3d4e-acme.vercel.app/', solo), true);
    assert.equal(previewHostAllowed('https://myproj-anything.vercel.app/', solo), false);
    assert.equal(previewHostAllowed('https://app-1-x.dev/', ['app-?-x.dev']), true, '"?" is one letter or digit');
    assert.equal(previewHostAllowed('https://app---x.dev/', ['app-?-x.dev']), false, '"?" is never "-"');
});

function runNode(file, env, args = [], cwd) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [file, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
}
async function runAction(inputs, event, eventName = 'deployment_status') {
    const dir = tmpDir();
    const ev = path.join(dir, 'event.json'); fs.writeFileSync(ev, JSON.stringify(event));
    const outFile = path.join(dir, 'out'); fs.writeFileSync(outFile, '');
    const env = { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: ev, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), RUNNER_TEMP: dir };
    for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, '_')}`] = v;
    const r = await runNode(path.join(root, 'src/action.js'), env, [], dir);
    const outputs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { ...r, outputs };
}

test('R4-03: with a bypass secret, a deployment_status not created by vercel[bot] gets nothing', async () => {
    const SECRET = 'bypass-R5-creator-9z';
    const cfg = path.join(tmpDir(), '.framedrift.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [{ path: '/', design: 'x.png' }] }));
    // http:// makes the run stop at the https check right after the creator check, so nothing is fetched.
    const ev = (login) => ({ deployment_status: { state: 'success', environment: 'Preview', target_url: 'http://myproj-a1b2c3d4e-acme.vercel.app/', creator: { login } }, deployment: { sha: 'abc' } });
    const base = { 'vercel-bypass-secret': SECRET, 'vercel-project': 'myproj', 'vercel-team': 'acme', config: cfg, 'github-token': '' };
    const evil = await runAction(base, ev('mallory'));
    assert.equal(evil.outputs.gate, 'error', evil.out);
    assert.match(evil.out, /::error::.*created by "mallory".*vercel\[bot\]/);
    const missing = await runAction(base, { deployment_status: { state: 'success', target_url: 'https://myproj-a1b2c3d4e-acme.vercel.app/' } });
    assert.match(missing.out, /::error::.*vercel\[bot\]/);
    const good = await runAction(base, ev('vercel[bot]'));
    assert.doesNotMatch(good.out, /vercel\[bot\]/, good.out);
    assert.match(good.out, /::error::.*https/, 'the next check (https) is reached');
    const dflt = await runAction({ 'vercel-bypass-secret': SECRET, config: cfg, 'github-token': '' }, ev('mallory'));
    assert.match(dflt.out, /::error::.*vercel\[bot\]/, 'the default allowlist checks the creator too');
    assert.match(dflt.out, /::warning::.*any Vercel project/, 'the fallback warning stays');
    const noSecret = await runAction({ config: cfg, 'github-token': '' }, ev('mallory'));
    assert.doesNotMatch(noSecret.out, /vercel\[bot\]/, 'without a bypass secret there is nothing to protect');
    const explicit = await runAction({ ...base, 'preview-url': 'http://myproj-a1b2c3d4e-acme.vercel.app/' }, ev('mallory'));
    // Round 6 (a): an explicit preview-url on a deployment_status event is checked too (it usually is the event's URL).
    assert.match(explicit.out, /::error::.*created by "mallory"/);
    for (const r of [evil, missing, good, dflt, explicit]) assert.ok(!r.out.includes(SECRET));
});

test('R4-03: README recommends preview-hosts on a domain you own and documents the spoof cases and the creator check', () => {
    const md = read('README.md');
    const sec = md.split(/^### Security\b/m)[1]?.split(/^## /m)[0] || '';
    assert.match(sec, /preview-hosts[^.]*domain you own/i);
    assert.match(sec, /x-<team>/);
    assert.match(sec, /production alias/i);
    assert.match(sec, /<project>-<team>\.vercel\.app/);
    assert.match(sec, /vercel\[bot\]/);
    assert.match(sec, /<project>-\?{9}-<team>\.vercel\.app|9-character/);
    assert.match(read('CHANGELOG.md'), /vercel\[bot\]/);
});
