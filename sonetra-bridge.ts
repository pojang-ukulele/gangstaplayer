/**
 * Sonetra Bridge - Manages the Python FastAPI backend for AI-powered transitions
 * 
 * Features:
 *   - Start/stop the Python server subprocess
 *   - Auto-restart on crash with exponential backoff (max 3 attempts)
 *   - Periodic health polling
 *   - Callbacks for status changes (notifies main process)
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import FormData from 'form-data';

const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm']);

function execFileAsync(cmd: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ==================== PATH WHITELISTING ====================
// List of allowed directories for audio file access.
// Prevents path traversal attacks accessing arbitrary system files.
const ALLOWED_AUDIO_DIRS: string[] = [
    // App data recordings directory (resolved at runtime)
    process.env.APPDATA ? path.join(process.env.APPDATA, 'GangstaPlayer', 'recordings') : null,
    // User's standard music folders
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Music') : null,
    process.env.HOME ? path.join(process.env.HOME, 'Music') : null,
].filter(Boolean) as string[];

/**
 * Validates that a file path is within one of the allowed audio directories
 * and contains no path traversal or null byte injection.
 * SECURITY: This is the primary defense against arbitrary file read attacks.
 */
function isSafeAudioPath(filePath: string): { safe: boolean; resolved?: string; error?: string } {
    if (!filePath || typeof filePath !== 'string') {
        return { safe: false, error: 'Path must be a non-empty string' };
    }

    // Block null byte injection + explicit traversal segments (resolve() collapses them).
    if (filePath.includes('\0')) {
        return { safe: false, error: 'Path contains illegal characters' };
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(filePath)) {
        return { safe: false, error: 'Path traversal detected' };
    }

    try {
        const resolved = path.resolve(filePath);

        // Check resolved path is within an allowed directory (separator-boundary match).
        const insideDir = (dir: string): boolean => {
            const d = path.resolve(dir).toLowerCase();
            const f = resolved.toLowerCase();
            return f === d || f.startsWith(d + path.sep);
        };
        const isAllowed = ALLOWED_AUDIO_DIRS.some(allowed => allowed && insideDir(allowed));

        // Also allow __dirname/recordings for development
        const devDir = path.join(__dirname, '..', 'recordings');
        const isInDevDir = insideDir(devDir);

        if (isAllowed || isInDevDir) {
            // Whitelist branch must enforce the same guarantees as fallback:
            // real file, audio extension, bounded size, symlink target stays inside.
            let real = resolved;
            try { real = fs.realpathSync.native(resolved); } catch { /* use resolved */ }
            if (!insideDir(path.dirname(real)) && real.toLowerCase() !== resolved.toLowerCase()) {
                // Symlink escapes the allowed tree — fall through to strict fallback checks.
            } else {
                const ext = path.extname(real).replace('.', '').toLowerCase();
                if (!AUDIO_EXTENSIONS.has(ext)) {
                    return { safe: false, error: `Non-audio file type rejected (.${ext})` };
                }
                try {
                    const st = fs.statSync(real);
                    if (!st.isFile()) return { safe: false, error: 'Not a file' };
                    if (st.size > 100 * 1024 * 1024) return { safe: false, error: 'File too large' };
                } catch {
                    return { safe: false, error: 'File does not exist' };
                }
                return { safe: true, resolved: real };
            }
        }

        // FALLBACK: Paths that arrive here come from native file dialogs or
        // drag-drop in the renderer (user-consented sources). The whitelist
        // cannot enumerate every music folder, so consented paths are accepted
        // — but only if they exist, look like audio files, and are bounded.
        const ext = path.extname(resolved).replace('.', '').toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext)) {
            return { safe: false, error: `Non-audio file type rejected (.${ext})` };
        }
        try {
            const st = fs.statSync(resolved);
            if (!st.isFile()) return { safe: false, error: 'Not a file' };
            if (st.size > 100 * 1024 * 1024) return { safe: false, error: 'File too large' };
        } catch {
            return { safe: false, error: 'File does not exist' };
        }
        if (!fs.existsSync(resolved)) {
            return { safe: false, error: 'File does not exist' };
        }
        console.warn('[Sonetra] Path outside whitelist accepted via user-consent fallback');
        return { safe: true, resolved };

    } catch (err: any) {
        return { safe: false, error: `Path resolution error: ${err.message}` };
    }
}

// Allow directory list to be extended at runtime (e.g., from config)
export function addAllowedAudioDir(dir: string): void {
    if (typeof dir !== 'string' || !dir || dir.length > 32760) return;
    if (dir.includes('\0')) return;
    let resolved: string;
    try { resolved = path.resolve(path.normalize(dir)); } catch { return; }
    try {
        const st = fs.statSync(resolved);
        if (!st.isDirectory()) return;
    } catch { return; }
    // Refuse system roots and cap list size — one dialog pick must not whitelist System32.
    const lower = resolved.toLowerCase();
    const blocked = ['c:\\windows', 'c:\\windows\\system32', 'c:\\program files', '/etc', '/sys', '/proc'];
    if (blocked.some(b => lower === b || lower.startsWith(b + path.sep))) return;
    if (ALLOWED_AUDIO_DIRS.length >= 64) return;
    if (ALLOWED_AUDIO_DIRS.some(d => path.resolve(d).toLowerCase() === lower)) return;
    ALLOWED_AUDIO_DIRS.push(resolved);
}

/** Callback signature for restart/status events */
export type SonetraStatusCallback = (status: { 
    event: 'started' | 'stopped' | 'crashed' | 'restarting' | 'restarted' | 'failed';
    attempt?: number;
    maxAttempts?: number;
    message?: string;
}) => void;

class SonetraBridge {
    serverProcess: ChildProcess | null = null;
    serverPort: number = 8765;
    serverHost: string = 'localhost';
    isRunning: boolean = false;
    sonetraPath: string | null = null;
    config: any;

    // Restart tracking
    private _restartCount = 0;
    private readonly _maxRestartAttempts = 3;
    private readonly _restartCooldownMs = 2000;
    private _healthPollTimer: ReturnType<typeof setInterval> | null = null;
    private readonly _healthPollIntervalMs = 30_000; // Check health every 30s
    private _statusCallbacks: SonetraStatusCallback[] = [];
    private _lastStartAttemptMs = 0;
    private readonly _startCooldownMs = 10_000;

    constructor() {
        this.config = this._loadConfig();
    }

    /** Register a callback for restart/status events */
    onStatusChange(cb: SonetraStatusCallback): void {
        this._statusCallbacks.push(cb);
    }

    /** Remove a previously registered status callback */
    offStatusChange(cb: SonetraStatusCallback): void {
        this._statusCallbacks = this._statusCallbacks.filter(c => c !== cb);
    }

    /** Fire status event to all registered callbacks */
    private _fireStatus(event: string, extra: Record<string, any> = {}): void {
        const payload = { event, maxAttempts: this._maxRestartAttempts, ...extra };
        for (const cb of this._statusCallbacks) {
            try { cb(payload as any); } catch (e) { /* ignore callback error */ }
        }
    }

    /** Safe accessor for Electron's resourcesPath, avoiding (process as any) casts */
    private _getResourcesPath(): string {
        return (process as any).resourcesPath || path.join(__dirname, '..', 'resources');
    }

    /**
     * Ensure all required Python packages are installed.
     * Runs `pip install -r requirements.txt` if the requirements file exists.
     * Returns true if dependencies are satisfied (or were already satisfied).
     */
    private async _ensureDependencies(pythonCmd: string): Promise<{ ok: boolean; error?: string }> {
        // Check if uvicorn is already importable (fast path)
        try {
            await execFileAsync(pythonCmd, ['-c', 'import uvicorn; import fastapi'], 10_000);
            return { ok: true }; // Already installed
        } catch {
            // Not installed — do NOT auto-install. Renderer-triggered pip install
            // is a supply-chain RCE vector (network fetch + setup.py exec as user).
            // Require explicit manual install via setup script.
            return {
                ok: false,
                error: 'Python packages (uvicorn, fastapi) are not installed. ' +
                      'Run: npm run setup:sonetra (or setup:sonetra:win on Windows)'
            };
        }
    }

    _loadConfig(): any {
        try {
            const configPath = path.join(__dirname, 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
                const out: any = {};
                // Schema-validate: only known string fields, bounded length, no null bytes.
                for (const key of ['pythonPath', 'sonetraPath']) {
                    const v = (raw as any)[key];
                    if (typeof v === 'string' && v && v.length <= 32760 && !v.includes('\0')) {
                        out[key] = v;
                    }
                }
                if (typeof (raw as any).port === 'number' && Number.isFinite((raw as any).port)) {
                    out.port = Math.max(1024, Math.min(65535, Math.floor((raw as any).port)));
                }
                return out;
            }
        } catch (e) {
            console.error('[Sonetra] Failed to load config.json', e);
        }
        return {};
    }

    /**
     * Find the Sonetra directory path
     */
    _findSonetraPath(): string | null {
        if (typeof this.config.sonetraPath === 'string' && this.config.sonetraPath) {
            try {
                const resolved = path.resolve(this.config.sonetraPath);
                // Trust only dirs that actually contain the API entry — prevents
                // cwd/DLL hijack via a planted config path.
                if (fs.existsSync(path.join(resolved, 'src', 'api', 'main.py')) ||
                    fs.existsSync(path.join(resolved, 'src', 'api', 'main_lite.py'))) {
                    return resolved;
                }
            } catch { /* fall through */ }
        }

        const possiblePaths = [
            path.join(__dirname, 'Sonetra-AI-Mixer-main'),
            path.join(this._getResourcesPath(), 'Sonetra-AI-Mixer-main'),
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(path.join(p, 'src', 'api', 'main.py'))) {
                return p;
            }
        }
        return null;
    }

    /**
     * Start the Sonetra Python server
     */
    async startServer(): Promise<{ success: boolean; message?: string, port?: number, error?: string }> {
        if (this.isRunning) {
            console.log('[Sonetra] Server already running');
            return { success: true, message: 'Server already running' };
        }
        // Cooldown: renderer-triggerable start (incl. pip install) must not
        // be spammable into a fork/pip-install DoS loop.
        const now = Date.now();
        if (now - this._lastStartAttemptMs < this._startCooldownMs) {
            return { success: false, error: 'Server start rate-limited — try again shortly' };
        }
        this._lastStartAttemptMs = now;
        // Re-entry guard: during the 3–8 s health-check window isRunning is
        // still false; without this a second caller spawns a duplicate uvicorn.
        if ((this as any)._starting) {
            return { success: false, error: 'Server start already in progress' };
        }
        (this as any)._starting = true;
        try {
            return await this._startServerInner();
        } finally {
            (this as any)._starting = false;
        }
    }

    private async _startServerInner(): Promise<{ success: boolean; message?: string, port?: number, error?: string }> {
        this.sonetraPath = this._findSonetraPath();
        if (!this.sonetraPath) {
            return {
                success: false,
                error: 'Sonetra AI Mixer not found. Please ensure the Sonetra-AI-Mixer-main folder is in the app directory.'
            };
        }

        let pythonCmd = this._resolvePythonCmd();

        // Auto-setup: if Python doesn't exist or isn't usable, run the setup script
        const pythonOk = await this._checkPythonAvailable(pythonCmd);
        if (!pythonOk) {
            console.log('[Sonetra] Python not found — running auto-setup...');
            const setupScript = path.join(__dirname, '..', 'scripts', 'setup-sonetra.js');
            if (fs.existsSync(setupScript)) {
                try {
                    await execFileAsync(process.execPath, [setupScript], 120_000);
                    console.log('[Sonetra] Auto-setup succeeded — re-resolving Python');
                    pythonCmd = this._resolvePythonCmd();
                } catch (e: any) {
                    console.warn('[Sonetra] Auto-setup failed — will try system Python:', e.message);
                }
            }
        }

        // Ensure Python dependencies are installed before spawning
        let depsOk: { ok: boolean; error?: string } = { ok: false, error: 'Unknown error during dependency check' };
        try {
            depsOk = await this._ensureDependencies(pythonCmd);
        } catch (e: any) {
            console.warn('[Sonetra] Dependency check failed:', e.message);
            depsOk.error = `Dependency check failed: ${e.message}`;
        }
        
        if (!depsOk.ok) {
            this._fireStatus('failed', { message: depsOk.error });
            return { success: false, error: depsOk.error };
        }

        return new Promise((resolve) => {
            const srcPath = path.join(this.sonetraPath!, 'src');

            // Spawn uvicorn to run FastAPI (using lite version)
            const args = [
                '-m', 'uvicorn',
                'api.main_lite:app',  // Use lightweight API
                '--host', this.serverHost,
                '--port', String(this.serverPort)
            ];

            console.log(`[Sonetra] Starting server with: ${pythonCmd} ${args.join(' ')}`);
            console.log(`[Sonetra] Working directory: ${srcPath}`);

            try {
                // Minimal env: never inherit secrets into the child; truncate child
                // output to blunt log-spam/ANSI forgery from a compromised server.
                const cleanEnv: NodeJS.ProcessEnv = {
                    PATH: process.env.PATH,
                    SYSTEMROOT: process.env.SYSTEMROOT,
                    TEMP: process.env.TEMP,
                    TMP: process.env.TMP,
                    PYTHONUNBUFFERED: '1',
                    PYTHONNOUSERSITE: '1',
                };
                this.serverProcess = spawn(pythonCmd, args, {
                    cwd: srcPath,
                    shell: false,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: cleanEnv
                });

                this.serverProcess.stdout?.on('data', (data) => {
                    console.log(`[Sonetra] ${String(data).slice(0, 2000).trim()}`);
                });

                this.serverProcess.stderr?.on('data', (data) => {
                    const msg = String(data).slice(0, 2000).trim();
                    console.log(`[Sonetra ERR] ${msg}`);
                    // Uvicorn logs to stderr, check for startup message
                    if (msg.includes('Application startup complete') || msg.includes('Uvicorn running')) {
                        this.isRunning = true;
                    }
                });

                this.serverProcess.on('error', (err) => {
                    console.error('[Sonetra] Process error:', err);
                    this.isRunning = false;
                    this._fireStatus('crashed', { message: `Process error: ${err.message}` });
                    resolve({ success: false, error: `Failed to start Python: ${err.message}` });
                });

                this.serverProcess.on('close', (code) => {
                    const wasRunning = this.isRunning;
                    console.log(`[Sonetra] Server stopped with code ${code}`);
                    this.isRunning = false;
                    this.serverProcess = null;
                    this._stopHealthPolling();

                    if (wasRunning && (code === null || code !== 0)) {
                        // Unexpected crash (non-zero exit or signal kill) — attempt auto-restart
                        this._fireStatus('crashed', { 
                            message: `Server exited with code ${code}`, 
                            attempt: this._restartCount + 1 
                        });
                        this._attemptRestart();
                    } else {
                        // Intentional stop or zero exit
                        this._restartCount = 0;
                        this._fireStatus('stopped', { message: `Server exited with code ${code}` });
                    }
                });

                // Wait a bit and check if server is responsive (cancellable timers).
                const t1 = setTimeout(async () => {
                    if (!this.serverProcess) {
                        resolve({ success: false, error: 'Server stopped during startup' });
                        return;
                    }
                    const healthy = await this._checkHealth();
                    if (healthy) {
                        this.isRunning = true;
                        this._restartCount = 0;
                        this._startHealthPolling();
                        this._fireStatus('started', { port: this.serverPort });
                        resolve({ success: true, port: this.serverPort });
                    } else {
                        // Give it more time
                        const t2 = setTimeout(async () => {
                            const healthy2 = await this._checkHealth();
                            this.isRunning = healthy2;
                            if (healthy2) {
                                this._restartCount = 0;
                                this._startHealthPolling();
                                this._fireStatus('started', { port: this.serverPort });
                            } else {
                                this._fireStatus('failed', { message: 'Server did not respond in time' });
                            }
                            resolve(healthy2
                                ? { success: true, port: this.serverPort }
                                : {
                                    success: false,
                                    error: `Sonetra server failed to start. This usually means Python dependencies are missing. ` +
                                           `Ensure Python 3.9+ is installed, then run npm run setup:sonetra`
                                }
                            );
                        }, 5000);
                        (t2 as any)?.unref?.();
                    }
                }, 3000);
                (t1 as any)?.unref?.();

            } catch (err: any) {
                console.error('[Sonetra] Spawn error:', err);
                this._fireStatus('failed', { message: err.message });
                resolve({ success: false, error: err.message });
            }
        });
    }

    /**
     * Attempt to restart the server after a crash, with exponential backoff
     */
    private async _attemptRestart(): Promise<void> {
        if (this._restartCount >= this._maxRestartAttempts) {
            console.error(`[Sonetra] Max restart attempts (${this._maxRestartAttempts}) reached. Giving up.`);
            this._fireStatus('failed', { 
                message: `Max restart attempts (${this._maxRestartAttempts}) reached.`,
                attempt: this._restartCount
            });
            this._restartCount = 0;
            return;
        }

        this._restartCount++;
        const delay = this._restartCooldownMs * this._restartCount; // Linear backoff: 2s, 4s, 6s
        console.log(`[Sonetra] Auto-restart attempt ${this._restartCount}/${this._maxRestartAttempts} in ${delay}ms...`);
        
        this._fireStatus('restarting', { 
            attempt: this._restartCount,
            message: `Restart attempt ${this._restartCount}/${this._maxRestartAttempts}`
        });

        await new Promise(r => setTimeout(r, delay));

        const result = await this.startServer();
        if (result.success) {
            console.log(`[Sonetra] Auto-restart attempt ${this._restartCount} succeeded.`);
            this._fireStatus('restarted', { 
                attempt: this._restartCount,
                port: result.port,
                message: `Restart succeeded on attempt ${this._restartCount}`
            });
        } else {
            console.error(`[Sonetra] Auto-restart attempt ${this._restartCount} failed:`, result.error);
            // _attemptRestart will be called again by the close handler if the process fails again
            // This happens because startServer spawns a new process whose close handler runs _attemptRestart
        }
    }

    /**
     * Public method to manually trigger a restart
     */
    async restartServer(): Promise<{ success: boolean; message?: string; error?: string }> {
        console.log('[Sonetra] Manual restart requested...');
        this._restartCount = 0;
        await this.stopServer();
        return await this.startServer();
    }

    /**
     * Start periodic health polling
     */
    private _startHealthPolling(): void {
        this._stopHealthPolling();
        this._healthPollTimer = setInterval(async () => {
            if (!this.isRunning || !this.serverProcess) return;
            const healthy = await this._checkHealth();
            if (!healthy) {
                console.warn('[Sonetra] Health check failed — server is unresponsive.');
                this._fireStatus('crashed', { message: 'Health check failed' });
                // Kill the process WITHOUT clearing isRunning first — the close
                // handler must see wasRunning=true so it triggers _attemptRestart.
                this._forceKill();
            }
        }, this._healthPollIntervalMs);
    }

    /**
     * Kill the running process while preserving "was running" state, so the
     * close handler treats it as a crash and auto-restarts.
     */
    private _forceKill(): void {
        const proc = this.serverProcess;
        if (!proc) return;
        this.serverProcess = null;
        this._stopHealthPolling();
        if (process.platform === 'win32' && proc.pid) {
            const killer = spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
            killer.on('error', (e) => {
                console.warn('[Sonetra] taskkill failed:', e.message);
                try { proc.kill(); } catch { /* already dead */ }
            });
        } else {
            try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        }
    }

    /**
     * Stop periodic health polling
     */
    private _stopHealthPolling(): void {
        if (this._healthPollTimer) {
            clearInterval(this._healthPollTimer);
            this._healthPollTimer = null;
        }
    }

    private _resolvePythonCmd(): string {
        let pythonCmd = '';

        if (typeof this.config.pythonPath === 'string' && this.config.pythonPath) {
            try {
                const resolved = path.resolve(this.config.pythonPath);
                // Validate it is an actual file (not a dir / planted shim path).
                if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                    pythonCmd = resolved;
                    console.log(`[Sonetra] Using config Python: ${pythonCmd}`);
                    return pythonCmd;
                }
            } catch { /* fall through to bundled/system */ }
        }

        const venvPythonPaths = [
            path.join(this.sonetraPath!, 'venv', 'Scripts', 'python.exe'),  // Windows venv
            path.join(this.sonetraPath!, 'venv', 'bin', 'python'),          // Unix venv
        ];
        
        for (const p of venvPythonPaths) {
            if (fs.existsSync(p)) {
                pythonCmd = p;
                console.log(`[Sonetra] Using venv Python: ${p}`);
                return pythonCmd;
            }
        }

        const portablePythonPaths = [
            path.join(__dirname, '..', 'python-embed', 'python.exe'),   // Project root (dev mode)
            path.join(__dirname, 'python-embed', 'python.exe'),         // Build dir (packaged)
            path.join(this._getResourcesPath(), 'python-embed', 'python.exe'), // Resources (packaged)
            path.join(__dirname, 'python', 'python.exe'),
        ];

        for (const p of portablePythonPaths) {
            if (fs.existsSync(p)) {
                pythonCmd = p;
                console.log(`[Sonetra] Using portable Python: ${p}`);
                return pythonCmd;
            }
        }

        pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
        console.log(`[Sonetra] Using system Python: ${pythonCmd}`);
        return pythonCmd;
    }

    /**
     * Check if the resolved Python command is actually usable.
     * For file paths (portable/venv), checks file existence.
     * For system commands ('py', 'python3'), tries to run --version.
     */
    private async _checkPythonAvailable(cmd: string): Promise<boolean> {
        if (!cmd) return false;
        // If it's a file path, check the file exists
        if (cmd.includes(path.sep) || cmd.includes('/')) {
            return fs.existsSync(cmd);
        }
        // It's a system command (e.g. 'py', 'python3') — try to run it
        try {
            await execFileAsync(cmd, ['--version'], 5000);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if server is healthy via HTTP GET /health
     */
    async _checkHealth(): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.serverHost,
                port: this.serverPort,
                path: '/health',
                method: 'GET',
                timeout: 5000
            }, (res) => {
                resolve(res.statusCode === 200);
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    /**
     * Stop the server
     */
    async stopServer(): Promise<{ success: boolean }> {
        if (this.serverProcess) {
            console.log('[Sonetra] Stopping server...');
            const proc = this.serverProcess;
            this._stopHealthPolling();
            this._restartCount = 0;
            // Await termination so fast restart can't double-spawn on port 8765.
            const exited = new Promise<void>((resolve) => {
                const to = setTimeout(resolve, 5000);
                (to as any)?.unref?.();
                try {
                    proc.once('close', () => { clearTimeout(to); resolve(); });
                    proc.once('exit', () => { clearTimeout(to); resolve(); });
                } catch { clearTimeout(to); resolve(); }
            });
            if (process.platform === 'win32') {
                if (proc?.pid) {
                    await new Promise<void>((resolve) => {
                        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
                        killer.on('error', () => { try { proc.kill(); } catch { /* dead */ } resolve(); });
                        killer.on('close', () => resolve());
                        setTimeout(resolve, 4000).unref?.();
                    });
                }
            } else {
                try { proc.kill('SIGTERM'); } catch { /* already dead */ }
                await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000).unref?.() ?? r())]);
                // Escalate: SIGTERM-immune child must not linger as a port zombie.
                try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
            }
            await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000).unref?.() ?? r())]);
            this.serverProcess = null;
            this.isRunning = false;
        }
        return { success: true };
    }

    // ==================== CIRCUIT BREAKER ====================
    private _failureCount = 0;
    private readonly _maxFailures = 5;
    private readonly _circuitOpenMs = 60_000; // Stay open for 1 min
    private _circuitOpenUntil = 0;

    /**
     * Execute an HTTP operation with exponential backoff and circuit breaker.
     * After `maxFailures` consecutive failures, the circuit opens and all
     * subsequent calls fail fast without hitting the server for `circuitOpenMs`.
     */
    private async _executeWithBackoff<T>(
        operation: () => Promise<T>,
        maxRetries = 3,
        baseDelayMs = 1000
    ): Promise<T> {
        // Check circuit breaker
        if (this._failureCount >= this._maxFailures && Date.now() < this._circuitOpenUntil) {
            const secondsLeft = Math.ceil((this._circuitOpenUntil - Date.now()) / 1000);
            throw new Error(`Circuit breaker open — too many failures. Retry in ${secondsLeft}s`);
        }

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Exponential backoff: delay = baseDelay * 2^attempt
                if (attempt > 0) {
                    const delay = baseDelayMs * Math.pow(2, attempt - 1);
                    console.log(`[Sonetra] Retry attempt ${attempt}/${maxRetries} after ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                const result = await operation();
                // A 5xx marker is a retryable failure, not a success.
                if ((result as any)?.__retry) {
                    throw new Error(`Server error: ${(result as any).status}`);
                }
                // Success! Reset failure count (one logical operation == one count)
                if (this._failureCount > 0) {
                    console.log(`[Sonetra] Circuit reset after successful request`);
                    this._failureCount = 0;
                    this._circuitOpenUntil = 0;
                }
                return result;
            } catch (err) {
                lastError = err as Error;
                console.warn(`[Sonetra] Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
                if (attempt >= maxRetries) break;
            }
        }

        // Count one logical operation as one failure for the circuit breaker.
        this._failureCount++;
        if (this._failureCount >= this._maxFailures) {
            this._circuitOpenUntil = Date.now() + this._circuitOpenMs;
            console.error(`[Sonetra] Circuit breaker OPEN for ${this._circuitOpenMs / 1000}s after ${this._failureCount} failures`);
            throw new Error(`Circuit breaker open after ${this._maxFailures} consecutive failures`);
        }

        throw lastError || new Error('Operation failed with unknown error');
    }

    /**
     * Create a transition between two audio files
     * Uses circuit breaker + exponential backoff for resilience.
     */
    async createTransition(track1Path: string, track2Path: string, style = 'smooth'): Promise<{ success: boolean, audioBuffer?: Buffer, error?: string }> {
        const ALLOWED_STYLES = new Set(['smooth', 'chopped', 'screwed', 'blend']);
        const safeStyle = ALLOWED_STYLES.has(style) ? style : 'smooth';
        // Validate paths before any operation (SECURITY)
        const path1 = isSafeAudioPath(track1Path);
        if (!path1.safe) {
            return { success: false, error: `Security: Track 1 path rejected - ${path1.error}` };
        }
        const path2 = isSafeAudioPath(track2Path);
        if (!path2.safe) {
            return { success: false, error: `Security: Track 2 path rejected - ${path2.error}` };
        }

        if (!this.isRunning) {
            const startResult = await this.startServer();
            if (!startResult.success) {
                return { success: false, error: 'Sonetra server not running and could not be started' };
            }
        }

        // Execute HTTP request with circuit breaker + exponential backoff
        try {
            const raw = await this._executeWithBackoff(() => {
                return new Promise((resolve, reject) => {
                    try {
                        const formData = new FormData();
                        const s1 = fs.createReadStream(path1.resolved!);
                        const s2 = fs.createReadStream(path2.resolved!);
                        // Deleted-file race must fail fast, not hang to the 60s timeout.
                        s1.on('error', (err) => { try { s1.destroy(); } catch { /* ignore */ } reject(err); });
                        s2.on('error', (err) => { try { s2.destroy(); } catch { /* ignore */ } reject(err); });
                        formData.append('file1', s1);
                        formData.append('file2', s2);

                        const requestOptions = {
                            hostname: this.serverHost,
                            port: this.serverPort,
                            path: `/transition/create?style=${encodeURIComponent(safeStyle)}`,
                            method: 'POST',
                            headers: formData.getHeaders(),
                            timeout: 60000
                        };

                        const req = http.request(requestOptions, (res) => {
                            const chunks: Buffer[] = [];
                            let bytes = 0;
                            const MAX_RESP_BYTES = 100 * 1024 * 1024;
                            res.on('data', (chunk: Buffer) => {
                                bytes += chunk.length;
                                if (bytes > MAX_RESP_BYTES) {
                                    req.destroy();
                                    resolve({ success: false, error: 'Response too large' });
                                    return;
                                }
                                chunks.push(chunk);
                            });
                            res.on('end', () => {
                                if (res.statusCode === 200) {
                                    const audioBuffer = Buffer.concat(chunks);
                                    resolve({ success: true, audioBuffer });
                                } else if (res.statusCode !== undefined && res.statusCode !== null && res.statusCode >= 500) {
                                    // 5xx must reject so _executeWithBackoff actually retries.
                                    (resolve as any)({ __retry: true, status: res.statusCode });
                                } else {
                                    const errorBody = Buffer.concat(chunks).toString().slice(0, 2000);
                                    resolve({ success: false, error: `Server error: ${res.statusCode} - ${errorBody}` });
                                }
                            });
                        });
                        // Stream errors (e.g. file deleted mid-upload) must not hang to timeout.
                        try {
                            formData.on('error', (err) => {
                                try { req.destroy(); } catch { /* ignore */ }
                                resolve({ success: false, error: `Request failed: ${(err as Error).message}` });
                            });
                        } catch { /* ignore */ }

                        req.on('error', (err) => {
                            reject(err);
                        });

                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error('Request timed out'));
                        });

                        formData.pipe(req);

                    } catch (err: any) {
                        reject(err);
                    }
                });
            }, 2, 1500); // max 2 retries, start at 1.5s delay
            if ((raw as any)?.__retry) throw new Error(`Server error: ${(raw as any).status}`);
            return raw as { success: boolean; audioBuffer?: Buffer; error?: string };

        } catch (err: any) {
            return { success: false, error: `Circuit breaker active: ${err.message}` };
        }
    }

    /**
     * Analyze a single track for BPM, key, etc.
     */
    async analyzeTrack(trackPath: string): Promise<{ success: boolean, analysis?: any, error?: string }> {
        // Validate path before any operation (SECURITY)
        const checkedPath = isSafeAudioPath(trackPath);
        if (!checkedPath.safe) {
            return { success: false, error: `Security: Track path rejected - ${checkedPath.error}` };
        }

        if (!this.isRunning) {
            const startResult = await this.startServer();
            if (!startResult.success) {
                return { success: false, error: 'Sonetra server not running and could not be started' };
            }
        }

        return new Promise((resolve) => {
            const formData = new FormData();

            try {
                const rs = fs.createReadStream(checkedPath.resolved!);
                rs.on('error', (err) => {
                    try { rs.destroy(); } catch { /* ignore */ }
                    resolve({ success: false, error: `Failed to read audio file: ${(err as Error).message}` });
                });
                formData.append('file', rs);
            } catch (err: any) {
                resolve({ success: false, error: `Failed to read audio file: ${err.message}` });
                return;
            }
            try {
                formData.on('error', (err) => {
                    resolve({ success: false, error: `Request failed: ${(err as Error).message}` });
                });
            } catch { /* ignore */ }

            const requestOptions = {
                hostname: this.serverHost,
                port: this.serverPort,
                path: '/analyze/track',
                method: 'POST',
                headers: formData.getHeaders(),
                timeout: 30000
            };

            const req = http.request(requestOptions, (res) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                const MAX_JSON_BYTES = 4 * 1024 * 1024;

                res.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > MAX_JSON_BYTES) {
                        req.destroy();
                        resolve({ success: false, error: 'Response too large' });
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const text = Buffer.concat(chunks).toString().slice(0, MAX_JSON_BYTES);
                            const analysis = JSON.parse(text);
                            resolve({ success: true, analysis });
                        } catch (err) {
                            resolve({ success: false, error: 'Failed to parse response' });
                        }
                    } else {
                        resolve({ success: false, error: `Server error: ${res.statusCode}` });
                    }
                });
            });

            req.on('error', (err) => {
                resolve({ success: false, error: `Request failed: ${err.message}` });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, error: 'Request timed out' });
            });

            formData.pipe(req);
        });
    }

    /**
     * Get server status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            port: this.serverPort,
            hasSonetraPath: !!this.sonetraPath,
            restartCount: this._restartCount,
            maxRestartAttempts: this._maxRestartAttempts
        };
    }
}

// Singleton instance
const sonetraBridge = new SonetraBridge();

export default sonetraBridge;
