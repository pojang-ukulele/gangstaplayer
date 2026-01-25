const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outDir = 'dist_source';

// 1. Clean/Create Directory
if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir);

console.log('Build: Directory created.');

// 2. Minify JS Files
// We don't bundle because we want to keep the electron main/renderer structure simple for now
// and avoid bundling node_modules (native deps issues)
const filesToMinify = ['main.js', 'renderer.js', 'preload.js', 'sonetra-bridge.js'];

esbuild.buildSync({
    entryPoints: filesToMinify,
    outdir: outDir,
    platform: 'node', // Electron main/renderer are node-like
    target: 'node16', // Electron 30 runs Node 20 usually, but 16 is safe
    minify: true,
    bundle: false, // Don't bundle node_modules, just minify source code
    keepNames: true, // Safer for some reflection/class usage
    sourcemap: false
});

console.log('Build: JS Minified.');

// 3. Copy Assets
const assets = ['index.html', 'styles.css', 'icon.png', 'package.json', 'wallpaper.jpg', 'gun-load.wav'];
assets.forEach(file => {
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(outDir, file));
    }
});

// Copy Soundpacks if they existed (user deleted them, so skip)

console.log('Build: Assets Copied.');

// 4. Install Dependencies in dist_source
// We need node_modules for electron-builder to see them
console.log('Build: Installing production dependencies...');
try {
    execSync('npm install --production', { cwd: outDir, stdio: 'inherit' });
} catch (e) {
    console.error('Build: Failed to install dependencies.', e);
    process.exit(1);
}

console.log('Build: Production preparation complete.');
