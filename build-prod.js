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
// 2. Minify Root JS Files
const rootFiles = ['main.js', 'preload.js', 'sonetra-bridge.js'];
esbuild.buildSync({
    entryPoints: rootFiles,
    outdir: outDir,
    platform: 'node',
    target: 'node16',
    minify: true,
    bundle: false,
    keepNames: true,
    sourcemap: false
});

// 2b. Minify Renderer JS Files (in js/ folder)
// Ensure output dir exists
if (!fs.existsSync(path.join(outDir, 'js'))) {
    fs.mkdirSync(path.join(outDir, 'js'));
}

const jsDir = 'js';
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).map(f => path.join(jsDir, f));

esbuild.buildSync({
    entryPoints: jsFiles,
    outdir: path.join(outDir, 'js'),
    platform: 'browser', // Renderer is browser
    target: 'es2022',
    minify: true,
    bundle: false,
    keepNames: true,
    sourcemap: false
});

console.log('Build: JS Minified.');

// 3. Copy Assets
const assets = ['index.html', 'styles.css', 'icon.png'];
assets.forEach(file => {
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(outDir, file));
    } else {
        console.warn('Warning: Asset not found:', file);
    }
});

// 3a. Copy Assets folder
const assetsFolder = 'assets';
if (fs.existsSync(assetsFolder)) {
    if (!fs.existsSync(path.join(outDir, assetsFolder))) {
        fs.mkdirSync(path.join(outDir, assetsFolder));
    }
    const files = fs.readdirSync(assetsFolder);
    files.forEach(file => {
        fs.copyFileSync(path.join(assetsFolder, file), path.join(outDir, assetsFolder, file));
    });
}

// 3b. Copy and Transform package.json
const pkgPath = 'package.json';
if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    
    // Inject electronVersion to build config so builder can work without installing electron in dist_source
    if (!pkg.build) pkg.build = {};
    pkg.build.electronVersion = "30.0.0"; 

    // Also remove scripts that might fail or be irrelevant
    delete pkg.scripts;

    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));
}

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
