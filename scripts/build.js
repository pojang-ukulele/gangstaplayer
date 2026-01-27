const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = 'app-build';

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
        entryPoints: ['main.js'],
        bundle: true,
        platform: 'node',
        target: 'node14', // Electron 30 uses Node 20 usually, but 14+ is safe baseline or matching. Electron 30 -> Node 20.
        outfile: path.join(BUILD_DIR, 'main.js'),
        minify: true,
        external: ['electron', 'fsevents'] // electron is always external
    });

    console.log('Building Renderer Process...');
    // 3. Bundle Renderer (js/main.js -> js/main.js bundled)
    // Note: our index.html imports 'js/main.js' as type="module".
    // We will output as ESM so it works drop-in.
    await esbuild.build({
        entryPoints: ['js/main.js'],
        bundle: true,
        platform: 'browser',
        format: 'esm', // Keep as module so index.html works without modification
        outfile: path.join(BUILD_DIR, 'js', 'main.js'),
        minify: true,
        keepNames: true, // Sometimes helps with class issues, though we heavily use functional.
        // We need to verify if 'webmidi' bundles correctly. It should.
    });

    console.log('Copying Assets...');
    // 4. Copy Assets
    const filesToCopy = [
        'index.html',
        'styles.css',
        'icon.png',
        'preload.js', // Forgot this in check!
        'package.json',
        'sonetra-bridge.js', // Optional bridge
        'gun-load.wav',
        'wallpaper.jpg'
    ];

    for (const file of filesToCopy) {
        if (file === 'package.json') {
            // Special handling: Clean package.json
            const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            delete pkg.build;
            delete pkg.scripts;
            delete pkg.devDependencies;
            // Optionally keep dependencies if they are native, but we bundled everything?
            // If native modules exist, we need them. 'webmidi' is JS.
            // Safe to keep 'dependencies' just in case or empty it if we are sure.
            // Let's keep dependencies for now but strip build config.
            fs.writeFileSync(path.join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
            continue;
        }

        if (fs.existsSync(file)) {
            fs.copyFileSync(file, path.join(BUILD_DIR, file));
        } else {
            console.warn(`Warning: Asset ${file} not found.`);
        }
    }

    // 5. Copy Preload? 
    if (fs.existsSync(path.join(__dirname, '../preload.js'))) {
        console.log('Building Preload...');
        await esbuild.build({
            entryPoints: ['preload.js'],
            bundle: true,
            platform: 'node',
            outfile: path.join(BUILD_DIR, 'preload.js'),
            minify: true,
            external: ['electron']
        });
    } else {
        console.log("No preload.js found, skipping.");
    }

    console.log('--- BUILD COMPLETE ---');
    console.log(`Ready to package in: ${BUILD_DIR}`);
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
