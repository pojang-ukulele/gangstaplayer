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
        target: 'node24',
        outfile: path.join(BUILD_DIR, 'main.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
        external: ['electron', 'fsevents', 'better-sqlite3']
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
    // Fail loud: a missing entry previously skipped silently and shipped a
    // build with no audio-worker (renderer dies packaged-only).
    const workerOutputs = [];
    const workerEntry = resolveEntry('js/workers/audio-worker.js');
    if (!fs.existsSync(workerEntry)) {
        throw new Error(`Build entry missing: audio-worker at ${workerEntry}`);
    }
    await esbuild.build({
        entryPoints: [workerEntry],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(BUILD_DIR, 'js', 'workers', 'audio-worker.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
    });
    workerOutputs.push(path.join(BUILD_DIR, 'js', 'workers', 'audio-worker.js'));

    const processorEntry = resolveEntry('js/workers/gangsta-processor.js');
    if (!fs.existsSync(processorEntry)) {
        throw new Error(`Build entry missing: gangsta-processor at ${processorEntry}`);
    }
    await esbuild.build({
        entryPoints: [processorEntry],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(BUILD_DIR, 'js', 'workers', 'gangsta-processor.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
    });
    workerOutputs.push(path.join(BUILD_DIR, 'js', 'workers', 'gangsta-processor.js'));

    const recorderEntry = resolveEntry('js/workers/recorder-processor.js');
    if (!fs.existsSync(recorderEntry)) {
        throw new Error(`Build entry missing: recorder-processor at ${recorderEntry}`);
    }
    await esbuild.build({
        entryPoints: [recorderEntry],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(BUILD_DIR, 'js', 'workers', 'recorder-processor.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
    });
    workerOutputs.push(path.join(BUILD_DIR, 'js', 'workers', 'recorder-processor.js'));

    // Post-build existence verification: every worker output must exist and
    // be non-empty, or the packaged app fails at `new Worker` (dev passes).
    for (const out of workerOutputs) {
        let ok = false;
        try {
            const st = fs.statSync(out);
            ok = st.isFile() && st.size > 0;
        } catch { ok = false; }
        if (!ok) {
            throw new Error(`Worker output missing or empty after build: ${out}`);
        }
    }
    console.log(`Verified ${workerOutputs.length} worker output(s).`);

    console.log('Building Boot Fallback...');
    // CSP-safe classic script (no imports): copied verbatim so a main-module
    // load failure still surfaces #bootError instead of a blank deck.
    const bootEntry = resolveEntry('js/boot-fallback.js');
    if (!fs.existsSync(bootEntry)) {
        throw new Error(`Build entry missing: boot fallback at ${bootEntry}`);
    }
    await esbuild.build({
        entryPoints: [bootEntry],
        bundle: false,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(BUILD_DIR, 'js', 'boot-fallback.js'),
        minify: MINIFY,
        sourcemap: SOURCEMAP,
    });
    {
        const st = fs.statSync(path.join(BUILD_DIR, 'js', 'boot-fallback.js'));
        if (!st.isFile() || st.size === 0) {
            throw new Error('Worker output missing or empty after build: js/boot-fallback.js');
        }
    }

    console.log('Copying Assets...');
    // 7. Copy Assets
    const filesToCopy = [
        'index.html',
        'styles.css',
        'icon.png',
        'package.json',
        'README.md'
    ];

    if (!fs.existsSync(path.join(BUILD_DIR, 'assets'))) {
        fs.mkdirSync(path.join(BUILD_DIR, 'assets'));
    }

    const assetsDir = 'assets';
    if (fs.existsSync(assetsDir)) {
        // Copy only needed assets: dotfiles/.DS_Store/Thumbs.db never ship,
        // and heavy unreferenced media (e.g. wallpaper.jpg ~2MB) ships only
        // when actually referenced by index.html/styles.css.
        let refs = '';
        try { refs += fs.readFileSync('index.html', 'utf8'); } catch { /* ignore */ }
        try { refs += fs.readFileSync('styles.css', 'utf8'); } catch { /* ignore */ }
        const assets = fs.readdirSync(assetsDir);
        const copyAssetRecursive = (src, dest) => {
            const st = fs.statSync(src);
            if (st.isDirectory()) {
                fs.mkdirSync(dest, { recursive: true });
                for (const entry of fs.readdirSync(src)) {
                    if (entry === '.DS_Store' || entry === 'Thumbs.db' || entry.startsWith('.')) continue;
                    copyAssetRecursive(path.join(src, entry), path.join(dest, entry));
                }
                return;
            }
            if (!st.isFile()) return;
            fs.copyFileSync(src, dest);
        };
        for (const asset of assets) {
            if (asset === '.DS_Store' || asset === 'Thumbs.db' || asset.startsWith('.')) continue;
            const src = path.join(assetsDir, asset);
            let st;
            try { st = fs.statSync(src); } catch { continue; }
            if (st.isDirectory()) {
                copyAssetRecursive(src, path.join(BUILD_DIR, 'assets', asset));
                continue;
            }
            if (!st.isFile()) continue;
            if (asset === 'wallpaper.jpg' && !refs.includes('wallpaper.jpg')) {
                console.log('Skipping unreferenced wallpaper.jpg (2MB).');
                continue;
            }
            fs.copyFileSync(src, path.join(BUILD_DIR, 'assets', asset));
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
        } else if (file === 'icon.png') {
            // Missing icon breaks installer branding — hard error, not warn.
            throw new Error('Build asset missing: icon.png is required for packaging.');
        } else {
            console.warn(`Warning: Asset ${file} not found.`);
        }
    }

    // 8. Stage external native/runtime deps into the bundle.
    // Main keeps better-sqlite3 external (native binding
    // can't be bundled), and electron-builder only packs what's inside
    // app-build — so copy it here or getDbManager() dies packaged.
    stageExternalDeps();

    console.log('--- BUILD COMPLETE ---');
    console.log(`Ready to package in: ${BUILD_DIR}`);
}

/**
 * Copies external runtime deps (native binding) into app-build/node_modules
 * so the packaged app can require() them.
 */
function stageExternalDeps() {
    const deps = [
        'better-sqlite3',
        // better-sqlite3 native binding loader chain — missing packaged
        // kills getDbManager() (require('bindings') throws in main).
        'bindings',
        'file-uri-to-path',
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
    // Sanity: a native binding must exist or the packaged DB is dead.
    // v13 ships N-API prebuilds in prebuilds/ (no build/Release tree).
    const prebuildDir = path.join(destRoot, 'better-sqlite3', 'prebuilds');
    let bindingFound = false;
    try {
        bindingFound = fs.existsSync(prebuildDir) &&
            fs.readdirSync(prebuildDir).some(f => f.endsWith('.node'));
    } catch { /* treat as missing */ }
    const binding = path.join(prebuildDir, 'binding-check');
    if (!bindingFound) {
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
        // Fresh regexes per file: a shared /g regex corrupts lastIndex across
        // the recursive walk and silently drops most of the closure.
        // Covers CJS require(), require.resolve(), ESM static imports and
        // dynamic import() — a hardcoded staged list breaks packaged-only
        // when `npm update` adds an ESM-only transitive dep (dev passes).
        const patterns = [
            new RegExp(requireSrc, 'g'),
            /require\s*\.\s*resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /(?:^|[;\s{}])import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /export\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
        ];
        for (const re of patterns) {
            for (const m of src.matchAll(re)) {
            const spec = m[1];
            if (!spec) continue;
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
        }
    };
    for (const root of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
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
