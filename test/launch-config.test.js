// scripts/launch-config.mjs fills every launch placeholder; run it on a throwaway copy.
// These tests must keep passing AFTER the real repo has been configured (review R63-06), so every copy is first
// put back into the unconfigured state using the values found in src/launch-config.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src', 'scripts', 'package.json', 'README.md', 'SHOW_HN_DRAFT.md', 'landing/index.html', 'examples/.github/workflows/framedrift.yml'];
const TEXT_FILES = ['src/launch-config.js', ...FILES.slice(2)];
const PLACEHOLDER_ORG = '00000000-0000-0000-0000-000000000000';
const LANDING_TODO = '  <!-- TODO(launch): set href to the Polar checkout link and remove the "coming soon" text (LAUNCH-CHECKLIST.md). -->';
const LANDING_CTA = '  <a class="cta" href="https://github.com/OWNER/framedrift#free-and-pro">Pro checkout opens soon</a>';

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Values the repo is configured with right now (placeholders before launch). */
function currentLaunchValues(dir) {
    const src = read(dir, 'src/launch-config.js');
    return {
        owner: src.match(/REPO_SLUG = '([^/']+)\/framedrift'/)[1],
        checkout: src.match(/FRAMEDRIFT_CHECKOUT_URL \|\| '([^']*)'/)[1],
        org: src.match(/FRAMEDRIFT_POLAR_ORG_ID \|\| '([^']*)'/)[1],
    };
}

/** Undo scripts/launch-config.mjs in a copy, so the tests start from the pre-launch state either way. */
function unconfigure(dir) {
    const { owner, checkout, org } = currentLaunchValues(dir);
    for (const f of TEXT_FILES) {
        let s = read(dir, f);
        if (checkout) {
            s = s.replace(`FRAMEDRIFT_CHECKOUT_URL || '${checkout}'`, "FRAMEDRIFT_CHECKOUT_URL || ''");
            s = s.replace(new RegExp(`^ *<a class="cta" href="${escRe(checkout)}">Get Pro</a>`, 'm'), `${LANDING_TODO}\n${LANDING_CTA}`);
        }
        if (org !== PLACEHOLDER_ORG) s = s.split(`'${org}'`).join(`'${PLACEHOLDER_ORG}'`);
        if (owner !== 'OWNER') s = s.replace(new RegExp(`\\b${escRe(owner)}/framedrift`, 'g'), 'OWNER/framedrift');
        fs.writeFileSync(path.join(dir, f), s);
    }
}

function copy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-launch-'));
    for (const f of FILES) fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
    unconfigure(dir);
    return dir;
}
const run = (dir, args) => spawnSync(process.execPath, [path.join(dir, 'scripts/launch-config.mjs'), ...args], { encoding: 'utf8' });

test('an unconfigured copy has placeholders and the code treats them as "not configured"', async () => {
    const dir = copy();
    const lc = await import(path.join(dir, 'src/launch-config.js'));
    assert.equal(lc.isRepoConfigured(), false);
    assert.ok(lc.isPlaceholderOrg(lc.POLAR_ORGANIZATION_ID));
    assert.match(read(dir, 'landing/index.html'), /Pro checkout opens soon/);
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

// R63-06: configure a full copy of the repo the way the owner will at launch, then run the test suites that used to
// assume placeholders inside it. Before the fix this went 0/3 (launch-config) and failed the Polar edge case.
test('R63-06/N3: the whole npm test suite still passes after `launch-config.mjs --owner/--checkout/--polar-org`', { skip: process.env.FD_LAUNCH_NESTED === '1' && 'nested run' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-launched-'));
    for (const f of fs.readdirSync(root)) {
        if (['node_modules', '.git', 'framedrift-report'].includes(f)) continue;
        fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    const cfg = run(dir, ['--owner', 'acme-design', '--checkout', 'https://buy.polar.sh/polar_cl_abc', '--polar-org', '9f3c2a71-5b4e-4d8a-a6c1-2e7f0b9d4c13']);
    assert.equal(cfg.status, 0, cfg.stderr);
    const env = { ...process.env, FD_LAUNCH_NESTED: '1' };
    delete env.NODE_TEST_CONTEXT;
    // N3 (round 3): the WHOLE suite (`npm test`, which prepublishOnly runs), not just two files: unit.test.js used to
    // assert the placeholder org id and went 68/69 after launch setup.
    const files = fs.readdirSync(path.join(dir, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`);
    // --test-reporter=tap: Node 23+ defaults to the "spec" reporter even when piped, which has no "# fail 0" line.
    const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(t.status, 0, t.stdout.split('\n').filter((l) => /^not ok|error:/.test(l.trim())).join('\n') || t.stderr);
    assert.match(t.stdout, /# fail 0/);
});
