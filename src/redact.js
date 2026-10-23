// Make URLs safe to show in PR comments, reports and logs: no userinfo, no secret-looking query values.
const SECRET_PARAM = /bypass|token|secret|password|passwd|auth|key|sig|signature|share|jwt|session|credential/i;

export function displayUrl(u) {
    if (!u) return u;
    let url;
    try { url = new URL(String(u)); } catch { return String(u); }
    if (url.username || url.password) { url.username = ''; url.password = ''; }
    for (const k of [...url.searchParams.keys()]) if (SECRET_PARAM.test(k)) url.searchParams.set(k, 'REDACTED');
    return url.href;
}

/** Only http(s) URLs become links; anything else (javascript:, data:, …) is rendered as text. */
export function safeHref(u) {
    try { const p = new URL(String(u)).protocol; return p === 'https:' || p === 'http:' ? String(u) : null; } catch { return null; }
}

/** Apply displayUrl to every URL inside free text (error messages, notes). */
export function redactUrls(text) {
    return String(text ?? '').replace(/\bhttps?:\/\/[^\s"'<>)]+/g, (u) => displayUrl(u));
}
