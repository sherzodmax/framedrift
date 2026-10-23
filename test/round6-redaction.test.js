// Regression tests for the round-6 review (qa-proof/codex-review-2026-10-22.md: "Round 6 re-check"), CLI output part.
// Each test names its finding and failed before the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { redactText } from '../src/redact.js';
import { parseHeaders } from '../src/args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(root, 'test/fixtures/example-design-with-h1.png');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fd-r6-'));

let page; let U;
before(async () => {
    page = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<body style="margin:0;background:#fff"><h1>hi</h1></body>'); });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    U = `http://127.0.0.1:${page.address().port}`;
});
after(() => page?.close());

async function runMain(argv) {
    const out = []; const err = []; const ol = console.log; const oe = console.error;
    console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '));
    let code;
    try { code = await main(argv); } finally { console.log = ol; console.error = oe; }
    return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---------- R6-01: a malformed --header is never echoed, not even its first word ----------
test('R6-01: --header "$TOKEN" (no colon) never prints any part of the token', async () => {
    const tokens = ['ghp_RAWHDR1abcdefgh', 'eyJhbGciOiJIUzI1NiJ9.e30.sig', 'sk-live-RAW6abc', 'plainwordsecret', 'Authorization Bearer HDR6abcdef'];
    const bad = [];
    for (const tok of tokens) {
        const r = await runMain(['compare', '--url', `${U}/`, '--design', DESIGN, '--header', 'X-Ok: fine', '--header', tok]);
        const pieces = tok.split(/[\s.:]+/).filter((p) => p.length >= 4);
        const seen = pieces.filter((p) => r.out.includes(p) || r.err.includes(p));
        if (r.code !== 2 || seen.length) bad.push(`${tok}: exit ${r.code}, printed ${JSON.stringify(seen)}: ${r.err}`);
        if (!/Invalid header #2\b/.test(r.err)) bad.push(`${tok}: the error should name the header by position: ${r.err}`);
    }
    assert.deepEqual(bad, []);
    assert.throws(() => parseHeaders(['ghp_RAWHDR1abcdefgh']), (e) => !e.message.includes('ghp_') && /#1/.test(e.message));
});

// ---------- R6-02: a frame name with ":" keeps its whole summary row in CLI stdout ----------
test('R6-02: frame names like "Token: colors" do not cut off the CLI summary row', async () => {
    const work = tmpDir();
    const cfg = path.join(work, 'frames.json');
    fs.writeFileSync(cfg, JSON.stringify({ frames: [
        { name: 'Token: colors', path: '/tokens', design: DESIGN },
        { name: 'Session: checkout flow', path: '/checkout', design: DESIGN },
    ] }));
    const r = await runMain(['run', '--base-url', `${U}/`, '--config', cfg, '--out', path.join(work, 'out')]);
    const rows = r.out.split('\n').filter((l) => /^\| .* \| \/(tokens|checkout) \|/.test(l));
    assert.equal(rows.length, 2, r.out);
    for (const row of rows) assert.match(row, /\| \/(tokens|checkout) \| \*\*[\d.]+%\*\* \|/, row);
    assert.equal(redactText('| ❌ | Token: colors | /tokens | **41.0%** | area at 1,1 |'), '| ❌ | Token: REDACTED | /tokens | **41.0%** | area at 1,1 |');
});

// ---------- Info items from the Round 6 redactor table ----------
test('Round 6 Info: Digest, percent-encoded headers, *-Key headers and short Basic values are redacted', () => {
    const cases = {
        'Authorization: Digest username="u", realm="r", nonce="N0NCE6abc", response="DIG1abc"': ['DIG1abc', 'N0NCE6abc'],
        'authorization%3A%20Bearer%20PCT1abc': ['PCT1abc'],
        'x%3Fauthorization%253A%2520Bearer%2520PCT2abcdef': ['PCT2abcdef'],
        'Ocp-Apim-Subscription-Key: SUBKEY6abc': ['SUBKEY6abc'],
        'Authorization: Basic dTpw': ['dTpw'],
        'curl -H "Basic dTpw"': ['dTpw'],
    };
    for (const [input, secrets] of Object.entries(cases)) {
        const out = redactText(input);
        for (const s of secrets) assert.ok(!out.includes(s), `${JSON.stringify(input)} → ${JSON.stringify(out)}`);
    }
});

test('Round 6 Info: ordinary words after "Bearer" / "Basic" are not redacted', () => {
    for (const keep of ['Bearer of bad news page', 'Basic information form', 'Basic plan', 'Bearer Bonds screen', 'Basic auth is not supported']) {
        assert.equal(redactText(keep), keep);
    }
    for (const [input, secret] of [['Bearer abcDEF123xyz', 'abcDEF123xyz'], ['Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig', 'eyJhbGci'], ['Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'], ['Bearer abcdefghijklmnopqrstu', 'abcdefghijklmnopqrstu']]) {
        assert.ok(!redactText(input).includes(secret), input);
    }
});
