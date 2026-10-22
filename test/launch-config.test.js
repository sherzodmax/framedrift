// scripts/launch-config.mjs fills every launch placeholder; run it on a throwaway copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src', 'scripts', 'package.json', 'README.md', 'SHOW_HN_DRAFT.md', 'landing/index.html', 'examples/.github/workflows/framedrift.yml'];

function copy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-launch-'));
    for (const f of FILES) fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
    return dir;
}
const run = (dir, args) => spawnSync(process.execPath, [path.join(dir, 'scripts/launch-config.mjs'), ...args], { encoding: 'utf8' });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('repo ships with placeholders and the code treats them as "not configured"', async () => {
    const lc = await import('../src/launch-config.js');
    assert.equal(lc.isRepoConfigured(), false);
    assert.ok(lc.isPlaceholderOrg(lc.POLAR_ORGANIZATION_ID));
    assert.match(read(root, 'landing/index.html'), /Pro checkout opens soon/);
});

test('fills OWNER, checkout URL and Polar org everywhere; leaves no placeholder behind', async () => {
    const dir = copy();
    const r = run(dir, ['--owner', 'acme-design', '--checkout', 'https://buy.polar.sh/polar_cl_abc', '--polar-org', '11111111-2222-4333-8444-555555555555']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Still placeholder/);
    for (const f of FILES.slice(2)) assert.doesNotMatch(read(dir, f), /OWNER\/|Pro checkout opens soon/, f);
    assert.match(read(dir, 'landing/index.html'), /<a class="cta" href="https:\/\/buy\.polar\.sh\/polar_cl_abc">Get Pro<\/a>/);
    assert.equal(JSON.parse(read(dir, 'package.json')).repository.url, 'git+https://github.com/acme-design/framedrift.git');
    const lc = await import(path.join(dir, 'src/launch-config.js'));
    assert.equal(lc.repoUrl(), 'https://github.com/acme-design/framedrift');
    assert.equal(lc.upgradeUrl(), 'https://buy.polar.sh/polar_cl_abc');
    assert.equal(lc.POLAR_ORGANIZATION_ID, '11111111-2222-4333-8444-555555555555');
    assert.equal(run(dir, ['--owner', 'acme-design']).stdout.trim(), '0 file(s) changed.', 'idempotent');
});

test('--dry-run changes nothing; bad values are rejected with exit 2', () => {
    const dir = copy();
    const before = read(dir, 'README.md');
    assert.match(run(dir, ['--owner', 'x', '--dry-run']).stdout, /would update README\.md/);
    assert.equal(read(dir, 'README.md'), before);
    assert.equal(run(dir, ['--owner', 'bad owner']).status, 2);
    assert.equal(run(dir, ['--checkout', 'http://insecure']).status, 2);
    assert.equal(run(dir, ['--polar-org', 'nope']).status, 2);
    assert.equal(run(dir, []).status, 2);
});
