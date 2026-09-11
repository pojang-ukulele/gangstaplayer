const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = 'app-build';

// Conditional minification: `node scripts/build.js` = dev, `node scripts/build.js --prod` = production
const IS_PROD = process.argv.includes('--prod');
const MINIFY = IS_PROD;
const SOURCEMAP = !IS_PROD ? 'inline' : false;

const resolveEntry = (filePath) => {
    const tsPath = filePath.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    // Silent .js fallback previously built stale JS on typos — fail loud.
    if (!fs.existsSync(filePath)) throw new Error(`Build entry missing: ${filePath} (and ${tsPath})`);
    return filePath;
};

async function build() {
    const mode = IS_PROD ? 'PRODUCTION (minified)' : 'DEVELOPMENT (with sourcemaps)';
    console.log(`--- STARTING ${mode} BUILD ---`);

    // 1. Clean / Create Build Dir
    if (fs.existsSync(BUILD_DIR)) {
        fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BUILD_DIR);
    fs.mkdirSync(path.join(BUILD_DIR, 'js'));

    console.log('Building Main Process...');
    // 2. Bundle Main Process
    await esbuild.build({
        entryPoints: [resolveEntry('main.js')],
        bundle: true,
        platform: 'node',
        target: 'node20',
        outfile: path.join(BUILD_DIR, 'main.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
        external: ['electron', 'fsevents', 'better-sqlite3', 'form-data']
    });

    console.log('Building Preload...');
    // 3. Bundle Preload
    await esbuild.build({
        entryPoints: [resolveEntry('preload.js')],
        bundle: true,
        platform: 'node',
        outfile: path.join(BUILD_DIR, 'preload.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
        external: ['electron']
    });

    console.log('Building Sonetra Bridge...');
    // 4. Bundle Sonetra Bridge
    const sonetraEntry = resolveEntry('sonetra-bridge.js');
    if (fs.existsSync(sonetraEntry)) {
        await esbuild.build({
            entryPoints: [sonetraEntry],
            bundle: true,
            platform: 'node',
            outfile: path.join(BUILD_DIR, 'sonetra-bridge.js'),
            minify: MINIFY,
            sourcemap: SOURCEMAP,
            external: ['electron', 'form-data', 'better-sqlite3']
        });
    }

    console.log('Building Renderer Process...');
    // 5. Bundle Renderer
    await esbuild.build({
        entryPoints: [resolveEntry('js/main.js')],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        outfile: path.join(BUILD_DIR, 'js', 'main.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
        keepNames: true,
    });

    console.log('Building Workers...');
    // 6. Bundle Worker
    // Worklets/workers must stay classic scripts (registerProcessor / Worker
    // entry) — pin iife explicitly so an esbuild default change can't ship ESM.
    const workerEntry = resolveEntry('js/workers/audio-worker.js');
    if (fs.existsSync(workerEntry)) {
        await esbuild.build({
            entryPoints: [workerEntry],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            outfile: path.join(BUILD_DIR, 'js', 'workers', 'audio-worker.js'),
            minify: MINIFY,
            sourcemap: SOURCEMAP,
        });
    }

    const processorEntry = resolveEntry('js/workers/gangsta-processor.js');
    if (fs.existsSync(processorEntry)) {
        await esbuild.build({
            entryPoints: [processorEntry],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            outfile: path.join(BUILD_DIR, 'js', 'workers', 'gangsta-processor.js'),
            minify: MINIFY,
            sourcemap: SOURCEMAP,
        });
    }

    const recorderEntry = resolveEntry('js/workers/recorder-processor.js');
    if (fs.existsSync(recorderEntry)) {
        await esbuild.build({
            entryPoints: [recorderEntry],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            outfile: path.join(BUILD_DIR, 'js', 'workers', 'recorder-processor.js'),
            minify: MINIFY,
            sourcemap: SOURCEMAP,
        });
    }

    console.log('Copying Assets...');
    // 7. Copy Assets
    const filesToCopy = [
        'index.html',
        'styles.css',
        'icon.png',
        'package.json',
        'README.md',
        'sonetra-requirements.txt'
    ];

    if (!fs.existsSync(path.join(BUILD_DIR, 'assets'))) {
        fs.mkdirSync(path.join(BUILD_DIR, 'assets'));
    }

    const assetsDir = 'assets';
    if (fs.existsSync(assetsDir)) {
        const assets = fs.readdirSync(assetsDir);
        for (const asset of assets) {
            fs.copyFileSync(path.join(assetsDir, asset), path.join(BUILD_DIR, 'assets', asset));
        }
    }
    for (const file of filesToCopy) {
        if (file === 'package.json') {
            const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            delete pkg.build;
            delete pkg.scripts;
            delete pkg.devDependencies;
            fs.writeFileSync(path.join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
            continue;
        }

        if (fs.existsSync(file)) {
            fs.copyFileSync(file, path.join(BUILD_DIR, file));
        } else {
            console.warn(`Warning: Asset ${file} not found.`);
        }
    }

    // 8. Bundle portable Python + AI deps if present (Sonetra)
    const embedDir = 'python-embed';
    const embedDest = path.join(BUILD_DIR, embedDir);
    if (fs.existsSync(embedDir) && !fs.existsSync(embedDest)) {
        console.log('Copying portable Python environment...');
        fs.cpSync(embedDir, embedDest, { recursive: true });
        console.log('Portable Python bundled.');
    } else if (fs.existsSync(embedDest)) {
        console.log('Portable Python already present in build.');
    } else {
        console.log('Portable Python not found — Sonetra AI will auto-setup on first use.');
    }

    // 9. Stage external native/runtime deps into the bundle.
    // Main/Sonetra keep better-sqlite3 + form-data external (native binding
    // can't be bundled), and electron-builder only packs what's inside
    // app-build — so copy them here or getDbManager() dies packaged.
    stageExternalDeps();

    console.log('--- BUILD COMPLETE ---');
    console.log(`Ready to package in: ${BUILD_DIR}`);
}

/**
 * Copies external runtime deps (native binding + pure-JS form-data tree)
 * into app-build/node_modules so the packaged app can require() them.
 */
function stageExternalDeps() {
    const deps = [
        'better-sqlite3',
        // better-sqlite3 native binding loader chain — missing packaged
        // kills getDbManager() (require('bindings') throws in main).
        'bindings',
        'file-uri-to-path',
        'form-data',
        // form-data transitive tree (bundled copies stay consistent).
        // form-data v4 requires es-set-tostringtag + hasown at top level,
        // which pull a deeper es-shims closure — every entry must be
        // staged or require(form-data) throws packaged-only before
        // createWindow (7 dirs is NOT enough).
        'asynckit',
        'combined-stream',
        'delayed-stream',
        'mime-types',
        'mime-db',
        'es-set-tostringtag',
        'hasown',
        'get-intrinsic',
        'es-errors',
        'es-object-atoms',
        'es-define-property',
        'gopd',
        'dunder-proto',
        'get-proto',
        'has-symbols',
        'has-tostringtag',
        'function-bind',
        'call-bind-apply-helpers',
        'math-intrinsics',
    ];
    const destRoot = path.join(BUILD_DIR, 'node_modules');
    let staged = 0;
    for (const dep of deps) {
        const src = path.join('node_modules', dep);
        const dest = path.join(destRoot, dep);
        try {
            if (!fs.existsSync(src)) continue;
            if (fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.cpSync(src, dest, { recursive: true });
            staged++;
        } catch (e) {
            console.warn(`Warning: failed to stage ${dep}: ${e?.message || e}`);
        }
    }
    // Sanity: the native binding must exist or the packaged DB is dead.
    const binding = path.join(destRoot, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(binding)) {
        console.warn('Warning: better-sqlite3 native binding not staged — packaged getDbManager() will fail. Run `npm install` then rebuild.');
    } else {
        console.log(`Staged ${staged} external dep(s) including better-sqlite3 native binding.`);
    }
    // Closure verification: the staged list is hardcoded, so a `npm update`
    // adding a new transitive dep breaks packaged-only (dev passes). Walk the
    // static require() closure from each staged root and fail loud on gaps.
    verifyStagedClosure(deps, destRoot);
}

/**
 * Collects bare-specifier require() targets reachable from a package's entry
 * files (depth-bounded walk). Only runtime requires count — install-time-only
 * trees (e.g. prebuild-install, never require()d by better-sqlite3/lib) are
 * correctly ignored, unlike a package.json dependency walk.
 */
function verifyStagedClosure(staged, destRoot) {
    const stagedSet = new Set(staged);
    const needed = new Set();
    const visitedFiles = new Set();
    const requireSrc = /require\(\s*['"]([^'"]+)['"]\s*\)/g.source;
    const pkgOf = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const tryFile = (p) => {
        if (fs.existsSync(p)) {
            try { if (fs.statSync(p).isFile()) return p; } catch { return null; }
        }
        for (const cand of [p + '.js', path.join(p, 'index.js')]) {
            try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* next */ }
        }
        return null;
    };
    const entryOf = (pkg) => {
        try {
            const pj = JSON.parse(fs.readFileSync(path.join('node_modules', pkg, 'package.json'), 'utf8'));
            return tryFile(path.join('node_modules', pkg, pj.main || 'index.js'));
        } catch { return null; }
    };
    const walkFile = (file, depth) => {
        if (depth > 24 || visitedFiles.has(file)) return;
        visitedFiles.add(file);
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
        // Fresh regex per file: a shared /g regex corrupts lastIndex across
        // the recursive walk and silently drops most of the closure.
        for (const m of src.matchAll(new RegExp(requireSrc, 'g'))) {
            const spec = m[1];
            if (spec.startsWith('.')) {
                // Relative file in the same package — its bare requires still
                // count toward the closure.
                const rel = tryFile(path.resolve(path.dirname(file), spec));
                if (rel) walkFile(rel, depth + 1);
                continue;
            }
            const pkg = pkgOf(spec);
            if (pkg === 'electron' || pkg === 'fsevents') continue;
            // Node builtins (fs, path, ...) have no package dir — skip.
            let resolved;
            try { resolved = require.resolve(pkg, { paths: [path.dirname(file)] }); }
            catch { continue; }
            if (!resolved.includes('node_modules')) continue; // relative/builtin
            needed.add(pkg);
            walkFile(resolved, depth + 1);
        }
    };
    for (const root of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'form-data']) {
        const entry = entryOf(root);
        if (entry) walkFile(entry, 0);
    }
    const missing = [...needed].filter((p) => !stagedSet.has(p));
    if (missing.length > 0) {
        throw new Error(
            `Staged externals are missing runtime deps (packaged app would crash on require): ${missing.join(', ')}. ` +
            `Add them to the deps list in stageExternalDeps().`
        );
    }
    console.log(`Staged closure verified (${needed.size} runtime dep(s) covered).`);
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
