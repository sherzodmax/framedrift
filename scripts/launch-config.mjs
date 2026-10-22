#!/usr/bin/env node
// Fill in the launch placeholders everywhere in one go, after Sherzod creates the accounts.
//   node scripts/launch-config.mjs --owner <github-user-or-org> [--checkout <polar-checkout-url>] [--polar-org <uuid>] [--dry-run]
// Re-runnable: it only touches placeholders that are still present. Prints every file it changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'help'] });
if (args.help || (!args.owner && !args.checkout && !args.polarOrg)) {
    console.log('usage: node scripts/launch-config.mjs --owner <github-owner> [--checkout <https://polar.sh/...>] [--polar-org <uuid>] [--dry-run]');
    process.exit(args.help ? 0 : 2);
}
if (args.owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(args.owner)) { console.error(`invalid GitHub owner: ${args.owner}`); process.exit(2); }
if (args.checkout && !/^https:\/\/[^\s"'<>]+$/.test(args.checkout)) { console.error('--checkout must be an https:// URL'); process.exit(2); }
if (args.polarOrg && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.polarOrg)) { console.error('--polar-org must be a UUID'); process.exit(2); }

const FILES = ['src/launch-config.js', 'package.json', 'README.md', 'SHOW_HN_DRAFT.md', 'landing/index.html', 'examples/.github/workflows/framedrift.yml'];
const edits = [];
if (args.owner) edits.push([/OWNER\/framedrift/g, `${args.owner}/framedrift`]);
if (args.checkout) {
    edits.push([/export const POLAR_CHECKOUT_URL = process\.env\.FRAMEDRIFT_CHECKOUT_URL \|\| '';/, `export const POLAR_CHECKOUT_URL = process.env.FRAMEDRIFT_CHECKOUT_URL || '${args.checkout}';`]);
    edits.push([/ *<!-- TODO\(launch\): set href to the Polar checkout link[^\n]*\n(\s*)<a class="cta" href="[^"]*">Pro checkout opens soon<\/a>/, `$1<a class="cta" href="${args.checkout}">Get Pro</a>`]);
}
if (args.polarOrg) edits.push([/'00000000-0000-0000-0000-000000000000'/, `'${args.polarOrg.toLowerCase()}'`]);

let changed = 0;
for (const rel of FILES) {
    const file = path.join(root, rel);
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const [re, to] of edits) after = after.replace(re, to);
    if (after !== before) {
        changed++;
        console.log(`${args.dryRun ? 'would update' : 'updated'} ${rel}`);
        if (!args.dryRun) fs.writeFileSync(file, after);
    }
}
const left = FILES.flatMap((rel) => (fs.readFileSync(path.join(root, rel), 'utf8').match(/OWNER\/|0{8}-0{4}|Pro checkout opens soon/g) || []).map((m) => `${rel}: ${m}`));
console.log(`${changed} file(s) ${args.dryRun ? 'would change' : 'changed'}.${left.length && !args.dryRun ? `\nStill placeholder:\n  ${left.join('\n  ')}` : ''}`);
