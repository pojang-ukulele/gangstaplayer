const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = 'app-build';

const resolveEntry = (filePath) => {
    const tsPath = filePath.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    return filePath;
};

async function build() {
    console.log('--- STARTING OBFUSCATED BUILD ---');

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
        minify: true,
        external: ['electron', 'fsevents']
    });

    console.log('Building Preload...');
    // 3. Bundle Preload
    await esbuild.build({
        entryPoints: [resolveEntry('preload.js')],
        bundle: true,
        platform: 'node',
        outfile: path.join(BUILD_DIR, 'preload.js'),
        minify: true,
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
            minify: true,
            external: ['electron', 'form-data'] // form-data is a dependency we might want to keep external or bundle? 
            // Better bundle it since it's a small utility and makes the build more portable.
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
        minify: true,
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
            minify: true,
        });
    }

    console.log('Copying Assets...');
    // 7. Copy Assets
    const filesToCopy = [
        'index.html',
        'styles.css',
        'icon.png',
        'package.json'
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
