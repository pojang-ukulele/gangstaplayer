/**
 * P0 repro (audit-sweep Phase P0 — FAILING, no prod fix yet; path checks only,
 * no build is executed).
 *
 * Gap: scripts/build.js emits the worker bundles but (a) silently SKIPS them
 * when an entry is missing (`if (fs.existsSync(...))` with no else) instead
 * of failing loud, so a typo ships a build with no audio-worker and the
 * renderer dies packaged-only; and (b) the emitted
 * js/workers/audio-worker.js stays inside the asar (package.json asarUnpack
 * covers only better-sqlite3), where `new Worker(...)` cannot load it at
 * runtime — dev passes, packaged fails. The P3-I lane must add a fail-loud
 * post-build existence check for all worker outputs and unpack (or
 * otherwise load) the worker scripts.
 */
const fs = require('fs');
const path = require('path');

function readBuildScript() {
    return fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build.js'), 'utf8');
}
function readPackageJson() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

describe('worker packaging (path checks only)', () => {
    test('build emits js/workers/audio-worker.js', () => {
        expect(readBuildScript()).toMatch(/js['"]?\s*,\s*['"]workers['"]\s*,\s*['"]audio-worker\.js['"]/);
    });

    test('build emits gangsta + recorder processors', () => {
        const src = readBuildScript();
        expect(src).toMatch(/gangsta-processor\.js/);
        expect(src).toMatch(/recorder-processor\.js/);
    });

    test('build copies required renderer assets', () => {
        const src = readBuildScript();
        for (const asset of ['index.html', 'styles.css', 'icon.png']) {
            expect(src).toContain(asset);
        }
    });

    test('P0 repro (FAILS now): build fails loud when a worker output is missing', () => {
        const src = readBuildScript();
        // BUG: worker entries are guarded by bare `if (fs.existsSync(...))`
        // with no else — a missing entry is silently skipped. There must be
        // a post-build existence verification for every worker output.
        expect(src).toMatch(/audio-worker\.js[\s\S]{0,2000}(existsSync|statSync)[\s\S]{0,200}throw/);
    });

    test('P0 repro (FAILS now): packaged app can load js/workers at runtime', () => {
        const pkg = readPackageJson();
        const unpacked = JSON.stringify(pkg.asarUnpack || []);
        const files = JSON.stringify(pkg.build?.files || []);
        // BUG: asarUnpack covers only the better-sqlite3 native binding, so
        // the bundled worker scripts stay inside the asar where Worker /
        // addModule cannot load them (dev passes, packaged fails).
        expect(files).toMatch(/js\/workers|js\/\*\*/);
        expect(unpacked).toMatch(/worker/);
    });
});
