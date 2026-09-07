/**
 * Gangsta Logger Module
 * Features:
 *   - Runtime log level switching (no restart needed)
 *   - In-memory ring buffer for the Console UI
 *   - Disk persistence via Electron Bridge
 */

import './types';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const MAX_LOG_ENTRIES = 500;

interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
}

class GangstaLogger {
    private ringBuffer: LogEntry[] = [];
    private minLevel: LogLevel = 'DEBUG';
    private sessionId: string;
    private _lastDiskWrite = 0;
    private _diskDropped = 0;

    constructor() {
        this.sessionId = this._generateSessionId();
        this.info('=== GANGSTA PLAYER SESSION STARTED ===');
    }

    // ==================== PUBLIC API ====================

    /** Set minimum log level at runtime (blocks lower severity) */
    setLogLevel(level: LogLevel): void {
        this.minLevel = level;
    }

    /** Get current minimum log level */
    getLogLevel(): LogLevel {
        return this.minLevel;
    }

    /** Returns a copy of the in-memory ring buffer */
    getLogs(): LogEntry[] {
        return [...this.ringBuffer];
    }

    /** Clears the in-memory ring buffer */
    clearLogs(): void {
        this.ringBuffer = [];
    }

    /** Returns log entries formatted as plain text for copying */
    getLogsAsText(): string {
        return this.ringBuffer.map(e =>
            `[${e.timestamp}] [${e.level}] ${e.message}`
        ).join('\n');
    }

    // ==================== LOGGING METHODS ====================

    info(msg: string): void {
        this._log('INFO', msg);
    }

    warn(msg: string, meta?: unknown): void {
        const text = meta !== undefined ? `${msg} ${this._stringify(meta)}` : msg;
        this._log('WARN', text);
    }

    error(msg: string, meta?: unknown): void {
        const text = meta !== undefined ? `${msg} ${this._stringify(meta)}` : msg;
        this._log('ERROR', text);
    }

    debug(msg: string, meta?: unknown): void {
        if (meta !== undefined) console.debug(msg, meta);
        const text = meta !== undefined ? `${msg} ${this._stringify(meta)}` : msg;
        this._log('DEBUG', text);
    }

    async getLogPath(): Promise<string> {
        if (window.fileSystem?.getLogPath) {
            return await window.fileSystem.getLogPath();
        }
        return 'UNKNOWN';
    }

    async generateCrashReport(stateSnapshot: Record<string, unknown>): Promise<string | null | undefined> {
        if (window.electronAPI?.generateCrashReport) {
            try {
                const reportPath = await window.electronAPI.generateCrashReport(stateSnapshot);
                this.error('CRITICAL: Render process crash detected. Diagnostic report generated.');
                return reportPath;
            } catch (e) {
                console.error('[Logger] Failed to generate crash report', e);
            }
        }
        return undefined;
    }

    // ==================== PRIVATE IMPLEMENTATION ====================

    private _stringify(value: unknown): string {
        if (value instanceof Error) return value.stack || value.message;
        try {
            return typeof value === 'object' ? JSON.stringify(value) : String(value);
        } catch {
            return String(value);
        }
    }

    private _shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[this.minLevel];
    }

    private _log(level: LogLevel, message: string): void {
        if (!this._shouldLog(level)) {
            return;
        }

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const entry: LogEntry = { level, message, timestamp };
        this._storeLog(entry);
        this._writeLog(entry);
    }

    private _storeLog(entry: LogEntry): void {
        this.ringBuffer.push(entry);
        if (this.ringBuffer.length > MAX_LOG_ENTRIES) {
            this.ringBuffer.shift();
        }
    }

    private _writeLog(entry: LogEntry): void {
        // Console fallback for immediate dev feedback
        const consoleMethod = entry.level === 'ERROR' ? 'error' :
            (entry.level === 'WARN' ? 'warn' : 'log');
        const consoleFn = console[consoleMethod as keyof Console] as ((...args: any[]) => void) | undefined;
        if (typeof consoleFn === 'function') consoleFn(`[${entry.level}] ${entry.message}`);

        // Persist to disk via Electron Bridge (skip DEBUG — high-frequency
        // debug spam previously IPC-flooded the main process on every frame).
        // Throttle INFO: drum-roll mousedown/click storms emit one IPC each.
        if (entry.level !== 'DEBUG' && window.fileSystem?.appendLog) {
            if (entry.level === 'INFO') {
                const now = Date.now();
                if (now - this._lastDiskWrite < 200) {
                    this._diskDropped++;
                    if (this._diskDropped === 1) {
                        window.fileSystem.appendLog('INFO', `[Logger] ... throttling INFO burst`).catch(() => undefined);
                    }
                    return;
                }
                if (this._diskDropped > 0) {
                    const n = this._diskDropped;
                    this._diskDropped = 0;
                    this._lastDiskWrite = now;
                    window.fileSystem.appendLog('INFO', `[Logger] dropped ${n} INFO message(s) during burst`).catch(() => undefined);
                }
                this._lastDiskWrite = now;
            }
            window.fileSystem.appendLog(entry.level, entry.message).catch(() => undefined);
        }
    }

    private _generateSessionId(): string {
        return `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    }
}

// ==================== SINGLETON EXPORT ====================

export const logger = new GangstaLogger();
