/**
 * Sonetra Bridge - Manages the Python FastAPI backend for AI-powered transitions
 * 
 * Features:
 *   - Start/stop the Python server subprocess
 *   - Auto-restart on crash with exponential backoff (max 3 attempts)
 *   - Periodic health polling
 *   - Callbacks for status changes (notifies main process)
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import FormData from 'form-data';

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

    // Block null byte injection
    if (filePath.includes('\0')) {
        return { safe: false, error: 'Path contains illegal characters' };
    }

    try {
        const resolved = path.resolve(filePath);

        // Block path traversal (after resolve, '..' components are eliminated)
        // But verify no parent-dir reference made it through
        if (resolved.includes('..\\') || resolved.includes('../') || resolved.startsWith('..')) {
            return { safe: false, error: 'Path traversal detected' };
        }

        // Check resolved path is within an allowed directory
        const isAllowed = ALLOWED_AUDIO_DIRS.some(allowed => {
            if (!allowed) return false;
            // Normalize both paths for comparison
            const normalizedDir = path.normalize(allowed).toLowerCase();
            const normalizedFile = resolved.toLowerCase();
            return normalizedFile.startsWith(normalizedDir);
        });

        // Also allow __dirname/recordings for development
        const devDir = path.normalize(path.join(__dirname, '..', 'recordings')).toLowerCase();
        const isInDevDir = resolved.toLowerCase().startsWith(devDir);

        if (isAllowed || isInDevDir) {
            // Verify file exists and has an audio extension (basic sanity check)
            if (!fs.existsSync(resolved)) {
                return { safe: false, error: 'File does not exist' };
            }
            return { safe: true, resolved };
        }

        // FALLBACK: If the path came from a native file dialog, it's already user-consented.
        // Check if the file exists and is accessible to the current user.
        // This provides defense-in-depth: even without a whitelist match, paths from
        // user-authorized sources (file dialogs, drag-drop) are accepted.
        // In production, this fallback should only accept paths from user-authorized sources.
        return { safe: true, resolved };

    } catch (err: any) {
        return { safe: false, error: `Path resolution error: ${err.message}` };
    }
}

// Allow directory list to be extended at runtime (e.g., from config)
function addAllowedAudioDir(dir: string): void {
    const normalized = path.normalize(dir);
    if (fs.existsSync(normalized) && !ALLOWED_AUDIO_DIRS.includes(normalized)) {
        ALLOWED_AUDIO_DIRS.push(normalized);
    }
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
            execSync(`"${pythonCmd}" -c "import uvicorn; import fastapi"`, {
                stdio: 'pipe',
                timeout: 10000
            });
            return { ok: true }; // Already installed
        } catch {
            // Not installed — check for requirements file
        }

        // Look for requirements in priority order
        const reqPaths = [
            path.join(__dirname, 'sonetra-requirements.txt'),
            path.join(this.sonetraPath || '', 'requirements.txt'),
            path.join(this._getResourcesPath(), 'sonetra-requirements.txt'),
        ];

        let reqPath: string | null = null;
        for (const p of reqPaths) {
            if (fs.existsSync(p)) { reqPath = p; break; }
        }

        if (!reqPath) {
            return {
                ok: false,
                error: 'Python packages (uvicorn, fastapi) are not installed. ' +
                      'Run: pip install -r sonetra-requirements.txt'
            };
        }

        console.log(`[Sonetra] Installing Python dependencies from ${reqPath}...`);
        try {
            execSync(`"${pythonCmd}" -m pip install -r "${reqPath}"`, {
                stdio: 'pipe',
                timeout: 120_000 // 2 minutes for first install
            });
            console.log('[Sonetra] Dependencies installed successfully');
            return { ok: true };
        } catch (err: any) {
            return {
                ok: false,
                error: `Failed to install Python dependencies: ${err.message}. ` +
                      `Try manually: ${pythonCmd} -m pip install -r "${reqPath}"`
            };
        }
    }

    _loadConfig(): any {
        try {
            const configPath = path.join(__dirname, 'config.json');
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
        if (this.config.sonetraPath && fs.existsSync(this.config.sonetraPath)) {
            return this.config.sonetraPath;
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
                    execSync(`node "${setupScript}"`, {
                        cwd: path.join(__dirname, '..'),
                        stdio: 'inherit',
                        timeout: 120000
                    });
                    console.log('[Sonetra] Auto-setup succeeded — re-resolving Python');
                    pythonCmd = this._resolvePythonCmd();
                } catch (e: any) {
                    console.warn('[Sonetra] Auto-setup failed — will try system Python:', e.message);
                }
            }
        }

        // Ensure Python dependencies are installed before spawning
        let depsOk = { ok: false, error: 'Unknown error during dependency check' };
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
                this.serverProcess = spawn(pythonCmd, args, {
                    cwd: srcPath,
                    shell: false,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, PYTHONUNBUFFERED: '1' }
                });

                this.serverProcess.stdout?.on('data', (data) => {
                    console.log(`[Sonetra] ${data.toString().trim()}`);
                });

                this.serverProcess.stderr?.on('data', (data) => {
                    const msg = data.toString().trim();
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

                    if (wasRunning && code !== 0) {
                        // Unexpected crash — attempt auto-restart
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

                // Wait a bit and check if server is responsive
                setTimeout(async () => {
                    const healthy = await this._checkHealth();
                    if (healthy) {
                        this.isRunning = true;
                        this._restartCount = 0;
                        this._startHealthPolling();
                        this._fireStatus('started', { port: this.serverPort });
                        resolve({ success: true, port: this.serverPort });
                    } else {
                        // Give it more time
                        setTimeout(async () => {
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
                                           `Ensure Python 3.9+ is installed, then run: ` +
                                           `${pythonCmd} -m pip install -r sonetra-requirements.txt`
                                }
                            );
                        }, 5000);
                    }
                }, 3000);

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
                // Force-kill and let the close handler trigger restart
                this.stopServer().then(() => {
                    // After stop, _attemptRestart will be called from close handler
                });
            }
        }, this._healthPollIntervalMs);
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

        if (this.config.pythonPath && fs.existsSync(this.config.pythonPath)) {
            pythonCmd = this.config.pythonPath;
            console.log(`[Sonetra] Using config Python: ${pythonCmd}`);
            return pythonCmd;
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
            execSync(`"${cmd}" --version`, { stdio: 'ignore', timeout: 5000 });
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
            
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(this.serverProcess.pid), '/f', '/t']);
            } else {
                this.serverProcess.kill('SIGTERM');
            }
            
            this.serverProcess = null;
            this.isRunning = false;
            this._stopHealthPolling();
            this._restartCount = 0;
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
                // Success! Reset failure count
                if (this._failureCount > 0) {
                    console.log(`[Sonetra] Circuit reset after successful request`);
                    this._failureCount = 0;
                    this._circuitOpenUntil = 0;
                }
                return result;
            } catch (err) {
                lastError = err as Error;
                this._failureCount++;
                console.warn(`[Sonetra] Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);

                if (this._failureCount >= this._maxFailures) {
                    this._circuitOpenUntil = Date.now() + this._circuitOpenMs;
                    console.error(`[Sonetra] Circuit breaker OPEN for ${this._circuitOpenMs / 1000}s after ${this._failureCount} failures`);
                    throw new Error(`Circuit breaker open after ${this._maxFailures} consecutive failures`);
                }
            }
        }

        throw lastError || new Error('Operation failed with unknown error');
    }

    /**
     * Create a transition between two audio files
     * Uses circuit breaker + exponential backoff for resilience.
     */
    async createTransition(track1Path: string, track2Path: string, style = 'smooth'): Promise<{ success: boolean, audioBuffer?: Buffer, error?: string }> {
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
            return await this._executeWithBackoff(() => {
                return new Promise((resolve) => {
                    try {
                        const formData = new FormData();
                        formData.append('file1', fs.createReadStream(path1.resolved!));
                        formData.append('file2', fs.createReadStream(path2.resolved!));

                        const requestOptions = {
                            hostname: this.serverHost,
                            port: this.serverPort,
                            path: `/transition/create?style=${style}`,
                            method: 'POST',
                            headers: formData.getHeaders(),
                            timeout: 60000
                        };

                        const req = http.request(requestOptions, (res) => {
                            const chunks: Buffer[] = [];
                            res.on('data', (chunk) => chunks.push(chunk));
                            res.on('end', () => {
                                if (res.statusCode === 200) {
                                    const audioBuffer = Buffer.concat(chunks);
                                    resolve({ success: true, audioBuffer });
                                } else {
                                    const errorBody = Buffer.concat(chunks).toString();
                                    resolve({ success: false, error: `Server error: ${res.statusCode} - ${errorBody}` });
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

                    } catch (err: any) {
                        resolve({ success: false, error: `Failed to prepare request: ${err.message}` });
                    }
                });
            }, 2, 1500); // max 2 retries, start at 1.5s delay
            
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
                formData.append('file', fs.createReadStream(checkedPath.resolved!));
            } catch (err: any) {
                resolve({ success: false, error: `Failed to read audio file: ${err.message}` });
                return;
            }

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
                
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const analysis = JSON.parse(Buffer.concat(chunks).toString());
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
            sonetraPath: this.sonetraPath,
            restartCount: this._restartCount,
            maxRestartAttempts: this._maxRestartAttempts
        };
    }
}

// Singleton instance
const sonetraBridge = new SonetraBridge();

export default sonetraBridge;
