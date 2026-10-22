// Tiny argv parser: --flag value, --flag=value, --bool, repeated flags collected into arrays.
export function parseArgs(argv, { booleans = [], arrays = [], aliases = {} } = {}) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('-') || a === '-') { out._.push(a); continue; }
        if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
        let val;
        if (a.includes('=')) { [a, val] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]; }
        let key = a.replace(/^--?/, '');
        key = aliases[key] || key;
        const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (booleans.includes(key)) { out[camel] = val === undefined ? true : !['false', '0', 'no'].includes(val); continue; }
        if (val === undefined) {
            val = argv[i + 1];
            if (val === undefined || (val.startsWith('--') && val.length > 2)) throw new Error(`Missing value for --${key}`);
            i++;
        }
        if (arrays.includes(key)) (out[camel] = out[camel] || []).push(val); else out[camel] = val;
    }
    return out;
}

export function parseViewport(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d+)\s*[x×]\s*(\d+)?$/i);
    if (!m) throw new Error(`Invalid viewport "${s}" (use e.g. 1440x900 or 390x)`);
    return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}

export function parseHeaders(list = []) {
    const h = {};
    for (const line of list) {
        const i = line.indexOf(':');
        if (i <= 0) throw new Error(`Invalid header "${line}" (use "Name: value")`);
        h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return h;
}
