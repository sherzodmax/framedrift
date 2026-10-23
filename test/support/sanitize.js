// Strip machine-specific absolute paths from committed test evidence (test/e2e/LAST_RUN.md, artifacts).
export function sanitizePaths(text, { root, tmp }) {
    let s = String(text);
    if (root) s = s.split(root).join('<repo>');
    if (tmp) s = s.replace(new RegExp(`${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/)`, 'g'), '$TMPDIR');
    return s;
}
