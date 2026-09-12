/**
 * Boot fallback for Gangsta Player Pro 3 (P3-I).
 * Classic CSP-safe script (script-src 'self', no inline handlers) loaded
 * before the main module. Wires a fail-loud path: if js/main.js cannot load
 * (missing file, ESM error, file:// issue), a visible #bootError banner plus
 * a console error replace the previous blank-deck silence.
 */
(function () {
    function showBootError(msg) {
        try {
            var el = document.getElementById('bootError');
            if (!el) {
                el = document.createElement('div');
                el.id = 'bootError';
                el.setAttribute('role', 'alert');
                document.body.insertBefore(el, document.body.firstChild);
            }
            el.hidden = false;
            el.textContent = 'Startup failed: ' + msg + ' — see console / logs.';
        } catch (e) { /* DOM not ready */ }
        try { console.error('[Boot] Startup failed: ' + msg); } catch (e) { /* ignore */ }
        try {
            // Best-effort toast when the toast system already booted.
            var c = document.getElementById('toastContainer');
            if (c) {
                var t = document.createElement('div');
                t.className = 'toast toast-error';
                t.textContent = 'Startup failed: ' + msg;
                c.appendChild(t);
            }
        } catch (e) { /* ignore */ }
    }
    try { window.__ugBootError = showBootError; } catch (e) { /* ignore */ }
    function wire() {
        try {
            var main = document.getElementById('mainScript');
            if (main && !main.__ugBootWired) {
                main.__ugBootWired = true;
                main.addEventListener('error', function () {
                    showBootError('main script failed to load (js/main.js)');
                });
            }
        } catch (e) { /* ignore */ }
        try {
            if (!window.__ugBootCaptureWired) {
                window.__ugBootCaptureWired = true;
                // Capture resource load errors (script targets); module import
                // failures inside main.js surface via its own handlers.
                window.addEventListener('error', function (e) {
                    try {
                        var t = e && e.target;
                        if (t && t.tagName === 'SCRIPT') {
                            showBootError('script failed to load (' + (t.src || t.id || 'unknown') + ')');
                        }
                    } catch (err) { /* ignore */ }
                }, true);
            }
        } catch (e) { /* ignore */ }
    }
    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', wire);
        } else {
            wire();
        }
    } catch (e) { /* ignore */ }
})();
