// R63-03 (review): `framedrift run` must not exit 0 when one comparison failed and another was clean.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
before(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/broken') { res.writeHead(500); return res.end('boom'); }
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body style="margin:0;background:#fff"></body>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(() => server?.close());

function run(args) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(root, 'bin/framedrift.js'), ...args], { env: { ...process.env, FIGMA_TOKEN: '' } });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
    });
}

test('R63-03: run with one clean frame and one HTTP 500 frame exits 3 (not 0)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-run-errors-'));
    const png = new pngjs.PNG({ width: 320, height: 240 }); png.data.fill(255);
    fs.writeFileSync(path.join(dir, 'white.png'), pngjs.PNG.sync.write(png));
    fs.writeFileSync(path.join(dir, '.framedrift.json'), JSON.stringify({ frames: [{ name: 'ok', path: '/', design: 'white.png' }, { name: 'broken', path: '/broken', design: 'white.png' }] }));
    const r = await run(['run', '--base-url', `http://127.0.0.1:${server.address().port}`, '--config', path.join(dir, '.framedrift.json'), '--out', path.join(dir, 'out')]);
    assert.match(r.out, /HTTP 500/);
    assert.equal(r.code, 3, r.out);
});
