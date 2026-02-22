/**
 * Sonetra Bridge - Manages the Python FastAPI backend for AI-powered transitions
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';

class SonetraBridge {
    serverProcess: ChildProcess | null = null;
    serverPort: number = 8765;
    serverHost: string = 'localhost';
    isRunning: boolean = false;
    sonetraPath: string | null = null;
    config: any;

    constructor() {
        this.config = this._loadConfig();
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
            path.join((process as any).resourcesPath || '', 'Sonetra-AI-Mixer-main'),
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

        const pythonCmd = this._resolvePythonCmd();

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

            } catch (err: any) {
                console.error('[Sonetra] Spawn error:', err);
                resolve({ success: false, error: err.message });
            }
        });
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
            path.join(__dirname, 'python-embed', 'python.exe'),
            path.join((process as any).resourcesPath || '', 'python-embed', 'python.exe'),
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
     * Check if server is healthy
     */
    async _checkHealth(): Promise<boolean> {
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
        }
        return { success: true };
    }

    /**
     * Create a transition between two audio files
     */
    async createTransition(track1Path: string, track2Path: string, style = 'smooth'): Promise<{ success: boolean, audioBuffer?: Buffer, error?: string }> {
        if (!this.isRunning) {
            return { success: false, error: 'Sonetra server not running' };
        }

        return new Promise((resolve) => {
            const FormData = require('form-data');
            const formData = new FormData();
            
            try {
                formData.append('file1', fs.createReadStream(track1Path));
                formData.append('file2', fs.createReadStream(track2Path));
            } catch (err: any) {
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
        });
    }

    /**
     * Analyze a single track for BPM, key, etc.
     */
    async analyzeTrack(trackPath: string): Promise<{ success: boolean, analysis?: any, error?: string }> {
        if (!this.isRunning) {
            return { success: false, error: 'Sonetra server not running' };
        }

        return new Promise((resolve) => {
            const FormData = require('form-data');
            const formData = new FormData();
            
            try {
                formData.append('file', fs.createReadStream(trackPath));
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
            sonetraPath: this.sonetraPath
        };
    }
}

// Singleton instance
const sonetraBridge = new SonetraBridge();

export default sonetraBridge;
