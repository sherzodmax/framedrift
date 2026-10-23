// The one redactor for everything framedrift prints or writes (PR comment, HTML report, results.json, summary.md,
// notes.json, Action outputs, logs): no URL userinfo, no secret-looking query values, no registered secret values.
// It works on free text, so a URL is covered wherever it ends up: a frame name, a path, an error message.
// R5-02: also `code` (OAuth authorization codes), `pwd`, `pass…` (not `passage`) and `otp`, as whole words inside the
// key (`auth_code`, `totp_otp`) so that `zipcode`, `qrcode`, `codec` and `footprint` stay readable.
const SECRET_PARAM = /bypass|token|secret|password|passwd|pwd|pass(?!age)|auth|key|sig|signature|share|jwt|session|credential|(?<![a-z])(?:code|otp)(?![a-z])/i;
// C70-01: header names whose `Name: value` value is a credential (`Authorization: Bearer …`, `Cookie: …`, `X-Api-Key: …`).
const SECRET_HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie$|token|secret|passw(?:or)?d|api[-_]?key|bypass|credential|session|signature|jwt/i;
const DECODE_CAP = 8; // R5-01: percent-decoding passes; real URLs are encoded once or twice
const REDACTED = 'REDACTED';

/** Secret values seen at runtime (bypass secret, --header values); redacted from every string, even outside a URL. */
const registered = new Set();
export function registerSecret(value) {
    if (typeof value === 'string' && value.length >= 4) registered.add(value);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A secret-looking `key=value` pair: after `?`, `&`, `;`, `#` (query, matrix params, fragment), after `/` (a path
// segment such as `/token=abc/`), or bare at the start of the text / after whitespace and punctuation (a frame name
// like "Login api_key=abc"). Query and fragment values run to the next `&`, `;`, `#`, whitespace or quote (a raw `/`
// is part of a query value); path-segment, `;matrix` and bare values also stop at `/`.
const PAIR = /(^|[?&;#/\s"'(,|[])([^=&;#/\s"'<>?()[\],|]+)=([^&;#\s"'<>)\]]*)/g;
const MIN_GLOBAL = 6; // a value found once is scrubbed everywhere in the text (e.g. its decoded copy), if this long

function safeDecode(t) {
    try { return decodeURIComponent(t); } catch { return t.replace(/%[0-9a-f]{2}/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } }); }
}
// Keys are compared without accents and compatibility forms too ("tökén", "ｔｏｋｅｎ" read as "token").
const isSecretKey = (k) => SECRET_PARAM.test(safeDecode(k).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));

/** Redact secret pairs in t; returns [text, values found]. */
function redactPairs(t, found = []) {
    const out = t.replace(PAIR, (m, sep, k, v) => {
        // A non-secret value can itself hold pairs (`?next=/b?sig=x`): scan it too.
        if (!isSecretKey(k)) return v.includes('=') ? `${sep}${k}=${redactPairs(v, found)[0]}` : m;
        // Only query/fragment values may contain a raw "/"; elsewhere (path segment, `;matrix`, bare) it ends there.
        let val = v; let rest = '';
        if (!sep || !'?&#'.includes(sep)) { const i = v.indexOf('/'); if (i >= 0) { val = v.slice(0, i); rest = v.slice(i); } }
        if (!val || val === REDACTED) return m;
        found.push(val);
        return `${sep}${k}=${REDACTED}${rest}`;
    });
    return [out, found];
}

/**
 * C70-01: credentials outside `key=value` form: `Bearer <token>` / `Basic <base64>` anywhere, and the value of a
 * secret-looking header in `Name: value` (to the end of the line or quote) or quoted `"name": "value"` form.
 * A non-secret `Name:` (e.g. `error: Authorization: Bearer x`) has its value scanned again.
 */
const AUTH_SCHEME = /\b(Bearer)(\s+)([A-Za-z0-9._~+/-]+=*)/gi;
const BASIC_SCHEME = /\b(Basic)(\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;
const QUOTED_HEADER = /(["'])([A-Za-z][\w.-]*)\1(\s*:\s*)(["'])((?:(?!\4)[^\r\n])*)\4/g;
const PLAIN_HEADER = /(^|[\s{,;(\["'])([A-Za-z][\w.-]*)([ \t]*:[ \t]*)(?!\/\/)([^\r\n"'<>]+)/g;
function redactHeaders(t) {
    let s = t.replace(AUTH_SCHEME, (m, w, sp, v) => (v === REDACTED ? m : `${w}${sp}${REDACTED}`))
        .replace(BASIC_SCHEME, (m, w, sp) => `${w}${sp}${REDACTED}`)
        .replace(QUOTED_HEADER, (m, q, k, sep, q2, v) => (SECRET_HEADER.test(k) && v && v !== REDACTED ? `${q}${k}${q}${sep}${q2}${REDACTED}${q2}` : m));
    s = s.replace(PLAIN_HEADER, (m, pre, k, sep, v) => {
        if (!SECRET_HEADER.test(k)) { const inner = redactHeaders(v); return inner === v ? m : `${pre}${k}${sep}${inner}`; }
        return v.trim() === REDACTED ? m : `${pre}${k}${sep}${REDACTED}`;
    });
    return s;
}

/**
 * Redact secrets inside any text:
 * - `scheme://user:pw@host` → `scheme://host`
 * - secret-looking `key=value` pairs (token, sig, _vercel_share, …) in the query, fragment, matrix params,
 *   path segments (`/token=x/`) and bare text (`api_key=x`), also when percent-encoded (`%3Ftoken%3Dx`): the text is
 *   decoded until it stops changing, up to DECODE_CAP (8) times (R5-01)
 * - `Bearer x`, `Basic x`, and secret `Name: value` headers (C70-01)
 * - every registered secret value, plus `opts.secrets`
 */
export function redactText(text, { secrets = [] } = {}) {
    if (text === null || text === undefined) return text;
    let s = String(text);
    s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, '$1');
    s = redactHeaders(s);
    let found;
    [s, found] = redactPairs(s);
    // Fullwidth / compatibility forms ("？token＝x") read as "?token=x" in many viewers: scan an NFKC copy too.
    const nf = s.normalize('NFKC');
    if (nf !== s) found = found.concat(redactPairs(nf)[1]);
    // Percent-encoded pairs: find them in decoded copies, then scrub the values (raw and encoded) from the text.
    let dec = s;
    for (let i = 0; i < DECODE_CAP && /%[0-9a-f]{2}/i.test(dec); i++) {
        const next = safeDecode(dec);
        if (next === dec) break;
        dec = next;
        found = found.concat(redactPairs(dec)[1]);
    }
    for (const v of [...registered, ...secrets, ...found.filter((v) => v.length >= MIN_GLOBAL || !s.includes(v))]) {
        if (!v) continue;
        for (const form of new Set([v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v))])) s = s.replace(new RegExp(escRe(form), 'g'), REDACTED);
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
