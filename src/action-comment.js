// Step 2: post/update the sticky PR comment (after the artifact upload, so it can link to it).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub } from './github.js';
import { renderMarkdown, COMMENT_MARKER } from './report.js';

export async function postComment({ outDir, artifactUrl, token, fetchImpl }) {
    const prNumber = fs.existsSync(path.join(outDir, 'pr-number')) ? fs.readFileSync(path.join(outDir, 'pr-number'), 'utf8').trim() : '';
    if (!prNumber) { console.log('No pull request found for this deployment; skipping PR comment.'); return null; }
    const { results } = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'notes.json'), 'utf8'));
    const reportUrl = artifactUrl ? `[download report artifact](${artifactUrl}) (open \`index.html\`)` : null;
    const body = renderMarkdown(results, { failOn: meta.failOn, tier: meta.tier, notes: meta.notes, previewUrl: meta.previewUrl, reportUrl });
    const gh = new GitHub({ token, fetchImpl });
    const r = await gh.upsertComment(Number(prNumber), body, COMMENT_MARKER);
    console.log(`PR #${prNumber}: comment ${r.action}`);
    return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    postComment({ outDir: process.env.FRAMEDRIFT_REPORT_DIR, artifactUrl: process.env.FRAMEDRIFT_ARTIFACT_URL, token: process.env.INPUT_GITHUB_TOKEN })
        .catch((e) => { console.log(`::warning::framedrift could not comment on the PR: ${e.message}`); });
}
