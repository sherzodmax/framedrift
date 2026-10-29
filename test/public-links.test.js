// The npm package does not exist yet, so no user-facing text may link to npmjs.com (those links 404), and the
// Free-tier upgrade note must point at the public GitHub repo's "Free and Pro" section.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoUrl, upgradeUrl, REPO_SLUG, POLAR_CHECKOUT_URL } from '../src/launch-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('no npmjs.com links to framedrift itself in shipped or public files (the package is not on npm; they 404)', () => {
    const files = [...walk('src'), ...walk('bin'), ...walk('scripts'), 'README.md', 'action.yml', 'CHANGELOG.md', 'landing/index.html', 'test/e2e/LAST_RUN.md']
        .filter((f) => fs.existsSync(path.join(root, f)));
    const hits = files.filter((f) => /npmjs\.com\/package\/framedrift\b/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    assert.deepEqual(hits, []);
});

test('Free-tier upgrade note links to the GitHub README "Free and Pro" section', () => {
    assert.equal(REPO_SLUG, 'sherzodmax/framedrift');
    assert.equal(repoUrl(), 'https://github.com/sherzodmax/framedrift');
    if (!POLAR_CHECKOUT_URL) assert.equal(upgradeUrl(), 'https://github.com/sherzodmax/framedrift#free-and-pro');
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /^## Free and Pro$/m, 'the #free-and-pro anchor exists');
});
