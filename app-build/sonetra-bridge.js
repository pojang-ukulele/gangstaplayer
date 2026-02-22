/**
 * Sonetra Bridge - Manages the Python FastAPI backend for AI-powered transitions
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

class SonetraBridge {
    constructor() {
        this.serverProcess = null;
        this.serverPort = 8765;
        this.serverHost = 'localhost';
        this.isRunning = false;
        this.sonetraPath = null;
        this.config = this._loadConfig();
    }

    _loadConfig() {
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
    _findSonetraPath() {
        if (this.config.sonetraPath && fs.existsSync(this.config.sonetraPath)) {
            return this.config.sonetraPath;
        }

        const possiblePaths = [
            path.join(__dirname, 'Sonetra-AI-Mixer-main'),
            path.join(process.resourcesPath || '', 'Sonetra-AI-Mixer-main'),
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
    async startServer() {
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

        return new Promise((resolve) => {
            const apiPath = path.join(this.sonetraPath, 'src', 'api');
            
            // Look for venv Python first (from Sonetra-AI-Mixer-main/venv)
            const venvPythonPaths = [
                path.join(this.sonetraPath, 'venv', 'Scripts', 'python.exe'),  // Windows venv
                path.join(this.sonetraPath, 'venv', 'bin', 'python'),          // Unix venv
            ];
            
            // Then portable Python
            const portablePythonPaths = [
                path.join(__dirname, 'python-embed', 'python.exe'),
                path.join(process.resourcesPath || '', 'python-embed', 'python.exe'),
                path.join(__dirname, 'python', 'python.exe'),
            ];
            
            if (this.config.pythonPath && fs.existsSync(this.config.pythonPath)) {
                pythonCmd = this.config.pythonPath;
                console.log(`[Sonetra] Using config Python: ${pythonCmd}`);
            }

            // Check venv first
            if (!pythonCmd) {
                for (const p of venvPythonPaths) {
                    if (fs.existsSync(p)) {
                        pythonCmd = p;
                        console.log(`[Sonetra] Using venv Python: ${p}`);
                        break;
                    }
                }
            }
            
            // Then check portable
            if (!pythonCmd) {
                for (const p of portablePythonPaths) {
                    if (fs.existsSync(p)) {
                        pythonCmd = p;
                        console.log(`[Sonetra] Using portable Python: ${p}`);
                        break;
                    }
                }
            }
            
            // Fall back to system Python
            if (!pythonCmd) {
                pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
                console.log(`[Sonetra] Using system Python: ${pythonCmd}`);
            }

            // Run from src directory so all modules can be found
            const srcPath = path.join(this.sonetraPath, 'src');

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

                this.serverProcess.stdout.on('data', (data) => {
                    console.log(`[Sonetra] ${data.toString().trim()}`);
                });

                this.serverProcess.stderr.on('data', (data) => {
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
                    resolve({ success: false, error: `Failed to start Python: ${err.message}` });
                });

                this.serverProcess.on('close', (code) => {
                    console.log(`[Sonetra] Server stopped with code ${code}`);
                    this.isRunning = false;
                    this.serverProcess = null;
                });

                // Wait a bit and check if server is responsive
                setTimeout(async () => {
                    const healthy = await this._checkHealth();
                    if (healthy) {
                        this.isRunning = true;
                        resolve({ success: true, port: this.serverPort });
                    } else {
                        // Give it more time
                        setTimeout(async () => {
                            const healthy2 = await this._checkHealth();
                            this.isRunning = healthy2;
                            resolve(healthy2 
                                ? { success: true, port: this.serverPort }
                                : { success: false, error: 'Server did not respond in time. Is Python installed with required packages?' }
                            );
                        }, 5000);
                    }
                }, 3000);

            } catch (err) {
                console.error('[Sonetra] Spawn error:', err);
                resolve({ success: false, error: err.message });
            }
        });
    }

    /**
     * Check if server is healthy
     */
    async _checkHealth() {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.serverHost,
                port: this.serverPort,
                path: '/health',
                method: 'GET',
                timeout: 2000
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
    async stopServer() {
        if (this.serverProcess) {
            console.log('[Sonetra] Stopping server...');
            
            // On Windows, we need to kill the process tree
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', this.serverProcess.pid, '/f', '/t']);
            } else {
                this.serverProcess.kill('SIGTERM');
            }
            
            this.serverProcess = null;
            this.isRunning = false;
        }
        return { success: true };
    }

    /**
     * Create a transition between two audio files
     */
    async createTransition(track1Path, track2Path, style = 'smooth') {
        if (!this.isRunning) {
            return { success: false, error: 'Sonetra server not running' };
        }

        return new Promise((resolve) => {
            const FormData = require('form-data');
            const formData = new FormData();
            
            // Read the audio files
            try {
                formData.append('file1', fs.createReadStream(track1Path));
                formData.append('file2', fs.createReadStream(track2Path));
            } catch (err) {
                resolve({ success: false, error: `Failed to read audio files: ${err.message}` });
                return;
            }

            const requestOptions = {
                hostname: this.serverHost,
                port: this.serverPort,
                path: `/transition/create?style=${style}`,
                method: 'POST',
                headers: formData.getHeaders(),
                timeout: 60000 // 60s timeout for processing
            };

            const req = http.request(requestOptions, (res) => {
                const chunks = [];
                
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        // Return the audio buffer
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
        });
    }

    /**
     * Analyze a single track for BPM, key, etc.
     */
    async analyzeTrack(trackPath) {
        if (!this.isRunning) {
            return { success: false, error: 'Sonetra server not running' };
        }

        return new Promise((resolve) => {
            const FormData = require('form-data');
            const formData = new FormData();
            
            try {
                formData.append('file', fs.createReadStream(trackPath));
            } catch (err) {
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
                const chunks = [];
                
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
            sonetraPath: this.sonetraPath
        };
    }
}

// Singleton instance
const sonetraBridge = new SonetraBridge();

module.exports = sonetraBridge;
