// The built-in demo page for `framedrift demo` and the E2E tests.
// HTML matching the fixture Figma frame "Login" (demo/frame.json, node 20:1, 390×844):
// absolute positions mirror the fixture's absoluteBoundingBox values (frame origin 1000,0).
// drift=true introduces the kind of mistakes framedrift should catch:
// a taller, re-coloured primary button and a changed title.
export const LOGIN_HTML = ({ drift }) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f8fafc;font-family:system-ui,sans-serif;width:390px;height:844px;position:relative;overflow:hidden}
.abs{position:absolute;box-sizing:border-box}
.title{left:24px;top:64px;width:300px;height:40px;font:700 32px/40px system-ui,sans-serif;letter-spacing:-0.64px;color:#111827}
.sub{left:24px;top:128px;width:300px;height:24px;font:400 16px/24px system-ui,sans-serif;color:#6b7280}
.card{left:24px;top:176px;width:342px;height:200px;background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:24px}
.card h2{margin:0;font:700 24px/40px system-ui,sans-serif;color:#111827}.card p{margin:12px 0 0;font:400 16px/24px system-ui,sans-serif;color:#6b7280}
.btn{left:24px;width:342px;border-radius:8px;display:flex;align-items:center;justify-content:center;font:600 14px/20px system-ui,sans-serif}
.primary{top:400px;height:${drift ? 52 : 44}px;background:${drift ? '#2563eb' : '#1a73e8'};color:#fff}
.secondary{top:468px;height:44px;background:#fff;color:#1a73e8;border:1px solid #e5e7eb}
</style></head><body>
<div class="abs title">${drift ? 'Welcome!' : 'Welcome back'}</div>
<div class="abs sub">Sign in to continue</div>
<div class="abs card"><h2>Card title</h2><p>Supporting text</p></div>
<div class="abs btn primary">Sign in</div>
<div class="abs btn secondary">Create account</div>
</body></html>`;
