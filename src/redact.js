// The one redactor for everything framedrift prints or writes (PR comment, HTML report, results.json, summary.md,
// notes.json, Action outputs, logs): no URL userinfo, no secret-looking query values, no registered secret values.
// It works on free text, so a URL is covered wherever it ends up: a frame name, a path, an error message.
const SECRET_PARAM = /bypass|token|secret|password|passwd|auth|key|sig|signature|share|jwt|session|credential/i;
const REDACTED = 'REDACTED';

/** Secret values seen at runtime (bypass secret, --header values); redacted from every string, even outside a URL. */
const registered = new Set();
export function registerSecret(value) {
    if (typeof value === 'string' && value.length >= 4) registered.add(value);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Redact secrets inside any text:
 * - `scheme://user:pw@host` → `scheme://host`
 * - `?key=value` / `&key=value` / `;key=value` where the key looks secret (token, sig, _vercel_share, …)
 * - every registered secret value, plus `opts.secrets`
 */
export function redactText(text, { secrets = [] } = {}) {
    if (text === null || text === undefined) return text;
    let s = String(text);
    s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, '$1');
    s = s.replace(/([?&;])([^=&;#\s"'<>?]+)=([^&;#\s"'<>)]*)/g, (m, sep, k, v) => {
        let key = k;
        try { key = decodeURIComponent(k); } catch { /* keep raw */ }
        return SECRET_PARAM.test(key) && v !== REDACTED ? `${sep}${k}=${REDACTED}` : m;
    });
    for (const v of [...registered, ...secrets]) {
        if (!v) continue;
        s = s.replace(new RegExp(escRe(v), 'g'), REDACTED);
        const enc = encodeURIComponent(v);
        if (enc !== v) s = s.replace(new RegExp(escRe(enc), 'g'), REDACTED);
    }
    return s;
}

/** redactText applied to every string in a JSON-like value (results rows, notes, outputs). */
export function redactDeep(value, opts) {
    if (typeof value === 'string') return redactText(value, opts);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, opts)]));
    return value;
}

/** A URL made safe to display (same rules as redactText, normalised through the URL parser when it parses). */
export function displayUrl(u) {
    if (!u) return u;
    let url;
    try { url = new URL(String(u)); } catch { return redactText(String(u)); }
    if (url.username || url.password) { url.username = ''; url.password = ''; }
    for (const k of [...url.searchParams.keys()]) if (SECRET_PARAM.test(k)) url.searchParams.set(k, REDACTED);
    return redactText(url.href);
}

/** Only http(s) URLs become links; anything else (javascript:, data:, …) is rendered as text. */
export function safeHref(u) {
    try { const p = new URL(String(u)).protocol; return p === 'https:' || p === 'http:' ? String(u) : null; } catch { return null; }
}

/** Kept for existing callers: same as redactText. */
export const redactUrls = (text) => redactText(String(text ?? ''));
