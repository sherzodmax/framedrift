// Self-contained HTML report + Markdown summary (for PR comments / step summaries).
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from './version.js';
import { displayUrl, redactText, redactDeep, safeHref } from './redact.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

/** A frame's own failOn (from .framedrift.json) wins over the run-wide one. */
export function verdict(r, failOn) {
    if (r.error) return 'error';
    return r.mismatchPercent > (r.failOn ?? failOn) ? 'drift' : 'ok';
}

/** Link markup only for http(s) URLs; anything else is shown as text. */
const htmlLink = (url, label) => { const href = safeHref(url); return href ? `<a href="${esc(href)}">${label}</a>` : label; };

const hotspotLabel = (h) => {
    if (!h.layer) return `area at ${Math.round(h.x)},${Math.round(h.y)}`;
    let s = h.layer.path || h.layer.name;
    if (h.layer.component) s += ` (${h.layer.component})`;
    if (h.layer.text) s += ` “${h.layer.text.slice(0, 40)}”`;
    return s;
};

export function renderHtml(results, { failOn = 2, title = 'framedrift report', generatedAt = new Date().toISOString(), tier = 'free', notes = [] } = {}) {
    // R68-03: every string (names, paths, URLs, errors, layer text, notes) goes through the shared redactor first.
    results = redactDeep(results); notes = redactDeep(notes); title = redactText(title);
    const cards = results.map((r, i) => {
        if (r.error) return `<section class="card"><h2>${esc(r.name)} <span class="badge error">error</span></h2><p class="err">${esc(r.error)}</p><p class="meta">${esc(displayUrl(r.url))}</p></section>`;
        const v = verdict(r, failOn);
        const boxes = (r.hotspots || []).slice(0, 15).map((h, n) => `<div class="hs" style="left:${(h.x / r.designSize.width) * 100}%;top:${(h.y / r.designSize.height) * 100}%;width:${(h.width / r.designSize.width) * 100}%;height:${(h.height / r.designSize.height) * 100}%"><span>${n + 1}</span></div>`).join('');
        const rows = (r.hotspots || []).slice(0, 15).map((h, n) => `<tr><td>${n + 1}</td><td>${esc(hotspotLabel(h))}</td><td>${Math.round(h.x / r.scale)},${Math.round(h.y / r.scale)} · ${Math.round(h.width / r.scale)}×${Math.round(h.height / r.scale)}</td><td>${h.pixels.toLocaleString('en-US')}</td></tr>`).join('');
        const design = dataUri(r.files.design); const actual = dataUri(r.files.actual); const diff = dataUri(r.files.diff);
        return `<section class="card" id="f${i}">
  <h2>${esc(r.name)} <span class="badge ${v}">${r.mismatchPercent}% different</span></h2>
  <p class="meta">Page: ${htmlLink(displayUrl(r.finalUrl || r.url), esc(displayUrl(r.finalUrl || r.url)))}${r.figma ? ` · Figma: ${htmlLink(r.figma.url, `${esc(r.figma.fileName)} → ${esc(r.figma.frameName)}`)}` : ''} · viewport ${r.viewport.width}×${r.viewport.height} @${r.scale}x</p>
  ${r.sizeMismatch ? `<p class="warn">Size mismatch: design ${r.designSize.width}×${r.designSize.height}px, page capture ${r.actualSize.width}×${r.actualSize.height}px. Missing page area is shown magenta and counts as different.</p>` : ''}
  <div class="tabs" data-i="${i}">
    <button class="on" data-v="side">Side by side</button><button data-v="overlay">Overlay</button><button data-v="swipe">Swipe</button><button data-v="diff">Diff</button>
  </div>
  <div class="view side on" data-i="${i}"><figure><figcaption>${r.figma ? 'Figma' : 'Design'}</figcaption><div class="wrap"><img src="${design}" alt="design">${boxes}</div></figure><figure><figcaption>Preview</figcaption><div class="wrap"><img src="${actual}" alt="preview">${boxes}</div></figure></div>
  <div class="view overlay" data-i="${i}"><input type="range" min="0" max="100" value="50" class="op"><div class="wrap stack"><img src="${design}" alt="design"><img src="${actual}" class="top" style="opacity:.5" alt="preview"></div></div>
  <div class="view swipe" data-i="${i}"><input type="range" min="0" max="100" value="50" class="sw"><div class="wrap stack"><img src="${design}" alt="design"><img src="${actual}" class="top clip" style="clip-path:inset(0 0 0 50%)" alt="preview"></div></div>
  <div class="view diff" data-i="${i}"><div class="wrap"><img src="${diff}" alt="diff">${boxes}</div></div>
  ${rows ? `<h3>Where it differs</h3><table><thead><tr><th>#</th><th>${r.figma ? 'Figma layer' : 'Region'}</th><th>Position (CSS px)</th><th>Pixels</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No differing regions above the noise floor.</p>'}
</section>`;
    }).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--fg:#111827;--mut:#6b7280;--bd:#e5e7eb;--ok:#047857;--bad:#b91c1c;--warn:#92400e}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);margin:0;background:#f9fafb}
header{padding:20px 28px;background:#fff;border-bottom:1px solid var(--bd)}h1{margin:0;font-size:20px}
main{padding:20px 28px;max-width:1400px}.card{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:22px}
h2{font-size:17px;margin:0 0 4px}.meta{color:var(--mut);margin:0 0 10px}.badge{font-size:12px;padding:2px 8px;border-radius:99px;margin-left:6px;vertical-align:middle}
.badge.ok{background:#d1fae5;color:var(--ok)}.badge.drift{background:#fee2e2;color:var(--bad)}.badge.error{background:#fef3c7;color:var(--warn)}
.warn{background:#fffbeb;border:1px solid #fde68a;padding:8px 10px;border-radius:6px}.err{color:var(--bad)}
.tabs button{border:1px solid var(--bd);background:#fff;padding:5px 12px;border-radius:6px;cursor:pointer;margin-right:4px}.tabs button.on{background:var(--fg);color:#fff}
.view{display:none;margin-top:12px}.view.on{display:block}.view.side.on{display:flex;gap:16px;align-items:flex-start}
figure{margin:0;flex:1}figcaption{color:var(--mut);margin-bottom:4px}.wrap{position:relative;display:inline-block;max-width:100%}.wrap img{display:block;max-width:100%;border:1px solid var(--bd)}
.stack img.top{position:absolute;inset:0;width:100%}.hs{position:absolute;border:2px solid #ff0050;box-sizing:border-box;pointer-events:none}.hs span{position:absolute;top:-2px;left:-2px;background:#ff0050;color:#fff;font-size:11px;padding:0 4px}
table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left}input[type=range]{width:320px}
footer{color:var(--mut);padding:0 28px 28px}
</style></head><body>
<header><h1>${esc(title)}</h1><div class="meta">${results.length} frame(s) · fail threshold ${failOn}% · ${esc(generatedAt)} · framedrift ${VERSION} (${esc(tier)})</div>${notes.map((n) => `<p class="warn">${esc(n)}</p>`).join('')}</header>
<main>${cards}</main>
<footer>Pixel comparison of the live page against the Figma frame render (pixelmatch, threshold ${results[0]?.threshold ?? 0.1}). Font rendering and anti-aliasing differ slightly between Figma and browsers, so small non-zero percentages are normal; look at the hotspots.</footer>
<script>
document.querySelectorAll('.tabs').forEach(t=>t.addEventListener('click',e=>{const v=e.target.dataset.v;if(!v)return;const i=t.dataset.i;t.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));document.querySelectorAll('.view[data-i="'+i+'"]').forEach(x=>x.classList.toggle('on',x.classList.contains(v)))}));
document.querySelectorAll('.op').forEach(r=>r.addEventListener('input',()=>{r.parentElement.querySelector('img.top').style.opacity=r.value/100}));
document.querySelectorAll('.sw').forEach(r=>r.addEventListener('input',()=>{r.parentElement.querySelector('img.top').style.clipPath='inset(0 0 0 '+r.value+'%)'}));
</script></body></html>`;
}

/**
 * Make untrusted text (frame names, Figma layer names/text, error messages) inert inside a Markdown table cell:
 * no table breaks, no @mentions (zero-width space after @), no HTML, no links/images, and no GFM autolinks
 * (N4): a zero-width space goes inside `scheme://`, `www.`, `mailto:` / `xmpp:`, so GitHub does not turn bare URLs
 * into links. The text still reads the same.
 */
const ZWSP = '\u200b';
export const cell = (s) => String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\\`*_[\]|<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c] || `\\${c}`))
    .replace(/@/g, `@${ZWSP}`)
    .replace(/([a-z][a-z0-9+.-]*):(?=\/\/)/gi, `$1${ZWSP}:`)
    .replace(/\b(mailto|xmpp):/gi, `$1${ZWSP}:`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`);

export const COMMENT_MARKER = '<!-- framedrift-report -->';

export function renderMarkdown(results, { failOn = 2, reportUrl = null, tier = 'free', notes = [], previewUrl = null } = {}) {
    results = redactDeep(results); notes = redactDeep(notes);
    const icon = { ok: '✅', drift: '⚠️', error: '❌' };
    const lines = [COMMENT_MARKER, '### framedrift · design drift report', ''];
    if (previewUrl) {
        // Our own (trusted, redacted) preview URL is an explicit link; untrusted cells below never autolink.
        const shown = displayUrl(previewUrl);
        const href = safeHref(shown);
        lines.push(`Preview: ${href ? `[${cell(shown)}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)` : cell(shown)}`, '');
    }
    lines.push('| | Frame | Page | Different | Top differences |', '|---|---|---|---|---|');
    for (const r of results) {
        if (r.error) { lines.push(`| ${icon.error} | ${cell(r.name)} | ${cell(r.path || displayUrl(r.url))} | — | ${cell(r.error.slice(0, 160))} |`); continue; }
        const v = verdict(r, failOn);
        const tops = (r.hotspots || []).slice(0, 3).map(hotspotLabel).map(cell).join('; ') || '—';
        const href = r.figma && safeHref(r.figma.url);
        const frame = href ? `[${cell(r.name)}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)` : cell(r.name);
        lines.push(`| ${icon[v]} | ${frame} | ${cell(r.path || displayUrl(r.url))} | **${r.mismatchPercent}%**${r.sizeMismatch ? ' (size differs)' : ''} | ${tops} |`);
    }
    lines.push('');
    if (reportUrl) lines.push(`Full visual report (side-by-side, overlay, swipe, diff): ${reportUrl}`, '');
    for (const n of notes) lines.push(`> ${n}`, '');
    lines.push(`<sub>Threshold ${failOn}% · framedrift ${VERSION} · ${tier === 'pro' ? 'Pro' : 'Free'} · small differences from font anti-aliasing are normal.</sub>`);
    return lines.join('\n');
}

export function writeReport(dir, results, opts) {
    fs.mkdirSync(dir, { recursive: true });
    const html = renderHtml(results, opts);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    // Paths in results.json are relative to the report (no runner paths); URLs are display-safe.
    // R68-03: the whole row (name, path, error, layer text, …) is redacted, not just url / finalUrl.
    const json = redactDeep(results.map(({ files, ...r }) => ({ ...r, url: displayUrl(r.url), finalUrl: displayUrl(r.finalUrl), design: r.design ? path.basename(r.design) : r.design, files: files ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.relative(dir, v)])) : undefined })));
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ version: VERSION, failOn: opts.failOn, results: json }, null, 2));
    const md = renderMarkdown(results, opts);
    fs.writeFileSync(path.join(dir, 'summary.md'), md);
    return { html: path.join(dir, 'index.html'), json: path.join(dir, 'results.json'), markdown: path.join(dir, 'summary.md') };
}
