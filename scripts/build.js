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
            external: ['electron']
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
    const workerEntry = resolveEntry('js/workers/audio-worker.js');
    if (fs.existsSync(workerEntry)) {
        await esbuild.build({
            entryPoints: [workerEntry],
            bundle: true,
            platform: 'browser',
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

    console.log('--- BUILD COMPLETE ---');
    console.log(`Ready to package in: ${BUILD_DIR}`);
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
