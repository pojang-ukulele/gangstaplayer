/**
 * Sonetra Auto-Setup Script
 * Downloads portable Python + installs AI deps — no manual Python install needed.
 * 
 * Usage:  node scripts/setup-sonetra.js
 * Called: automatically by sonetra-bridge when Python is not found
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const PYTHON_VERSION = '3.12.4';
const PYTHON_BASE = `python-${PYTHON_VERSION}-embed-amd64`;
const EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_BASE}.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const APP_DIR = path.resolve(__dirname, '..');
const EMBED_DIR = path.join(APP_DIR, 'python-embed');
const PYTHON_EXE = path.join(EMBED_DIR, 'python.exe');
const ZIP_PATH = path.join(APP_DIR, `${PYTHON_BASE}.zip`);
const REQS_PATH = path.join(APP_DIR, 'sonetra-requirements.txt');

const vlog = (msg) => console.log(`[Sonetra-Setup] ${msg}`);
const verr = (msg) => console.error(`[Sonetra-Setup] ERROR: ${msg}`);

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        });
        req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
    });
}

function extractZip(zipPath, dest) {
    return new Promise((resolve, reject) => {
        // Use PowerShell's Expand-Archive (available on Win10+)
        const ps = spawn('powershell', [
            '-NoProfile', '-NonInteractive',
            '-Command',
            `Expand-Archive -Path "${zipPath}" -DestinationPath "${dest}" -Force`
        ]);
        let stderr = '';
        ps.stderr.on('data', (d) => { stderr += d; });
        ps.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Extract failed (code ${code}): ${stderr}`));
        });
        ps.on('error', reject);
    });
}

function uncommentPth(embedDir) {
    // Enable pip by editing the _pth file
    const pthFile = fs.readdirSync(embedDir).find(f => f.endsWith('._pth'));
    if (!pthFile) return;
    const pthPath = path.join(embedDir, pthFile);
    let content = fs.readFileSync(pthPath, 'utf8');
    // Uncomment the import site line so pip works
    if (content.includes('#import site')) {
        content = content.replace('#import site', 'import site');
        fs.writeFileSync(pthPath, content);
        vlog(`Uncommented 'import site' in ${pthFile}`);
    }
}

function runPython(args, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PYTHON_EXE, args, { cwd: cwd || APP_DIR, stdio: ['pipe', 'inherit', 'inherit'] });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Python exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

async function ensurePython() {
    // Already have it?
    if (fs.existsSync(PYTHON_EXE)) {
        vlog('Portable Python already exists at python-embed/');
        return true;
    }

    vlog(`Downloading portable Python ${PYTHON_VERSION}...`);
    try {
        await download(EMBED_URL, ZIP_PATH);
        vlog('Download complete.');
    } catch (e) {
        verr(`Failed to download Python: ${e.message}`);
        return false;
    }

    vlog('Extracting...');
    try {
        fs.mkdirSync(EMBED_DIR, { recursive: true });
        await extractZip(ZIP_PATH, EMBED_DIR);
    } catch (e) {
        verr(`Failed to extract: ${e.message}`);
        return false;
    } finally {
        try { fs.unlinkSync(ZIP_PATH); } catch (_) {}
    }

    // Enable pip by editing ._pth file
    uncommentPth(EMBED_DIR);

    vlog('Portable Python ready.');
    return fs.existsSync(PYTHON_EXE);
}

async function ensurePip() {
    // Check if pip is already installed
    try {
        await runPython(['-m', 'pip', '--version']);
        return true;
    } catch (_) {
        // Not installed, bootstrap it
    }

    const getPipPath = path.join(APP_DIR, 'get-pip.py');
    vlog('Downloading pip bootstrap...');
    try {
        await download(GET_PIP_URL, getPipPath);
    } catch (e) {
        verr(`Failed to download get-pip.py: ${e.message}`);
        return false;
    }

    vlog('Bootstrapping pip...');
    try {
        await runPython([getPipPath, '--no-warn-script-location']);
        return true;
    } catch (e) {
        verr(`Failed to bootstrap pip: ${e.message}`);
        return false;
    } finally {
        try { fs.unlinkSync(getPipPath); } catch (_) {}
    }
}

async function ensureDeps() {
    if (!fs.existsSync(REQS_PATH)) {
        verr('sonetra-requirements.txt not found');
        return false;
    }

    vlog('Installing Sonetra AI dependencies (this may take a moment)...');
    try {
        await runPython(['-m', 'pip', 'install', '-r', REQS_PATH, '--quiet']);
        vlog('Dependencies installed.');
        return true;
    } catch (e) {
        verr(`Failed to install dependencies: ${e.message}`);
        return false;
    }
}

async function main() {
    vlog('Starting auto-setup...');

    const ok = await ensurePython();
    if (!ok) {
        verr('Could not set up portable Python');
        process.exit(1);
    }

    const pipOk = await ensurePip();
    if (!pipOk) {
        verr('Could not set up pip');
        process.exit(1);
    }

    const depsOk = await ensureDeps();
    if (!depsOk) {
        verr('Could not install Sonetra dependencies');
        process.exit(1);
    }

    vlog('Setup complete! Sonetra AI is ready.');
    process.exit(0);
}

main().catch((e) => {
    verr(`Unexpected error: ${e.message}`);
    process.exit(1);
});
