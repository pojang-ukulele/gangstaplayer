/**
 * Gangsta Logger Module
 * Features:
 *   - In-memory ring buffer for the Console UI
 *   - Disk persistence via Electron Bridge
 */

import './types';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const MAX_LOG_ENTRIES = 500;

interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    sessionId: string;
}

class GangstaLogger {
    private ringBuffer: LogEntry[] = [];
    private sessionId: string;
    /** DEBUG disk writes stay off unless explicitly enabled (flag). */
    private debugDiskEnabled = false;
    private _lastDiskWrite = 0;
    private _diskDropped = 0;
    // H31: per-level disk throttle for WARN/ERROR (same IPC-flood class as
    // the DEBUG/INFO fixes). Bursts are coalesced and summarized.
    private _lastDiskWriteByLevel: Partial<Record<LogLevel, number>> = {};
    private _diskDroppedByLevel: Partial<Record<LogLevel, number>> = {};
    private _lastMsgByLevel: Partial<Record<LogLevel, string>> = {};
    private _repeatByLevel: Partial<Record<LogLevel, number>> = {};
    // Disk-failure signal: every appendLog rejection was previously swallowed,
    // so a dead main log pipe left a silent disk gap. Streaks surface once via
    // console + a ring marker (memory copy is intact — only disk is blind).
    private _diskFailStreak = 0;

    private _persist(level: string, message: string, isRetry = false): void {
        try {
            const fs = (window as unknown as { fileSystem?: { appendLog: (l: string, m: string) => Promise<unknown> } }).fileSystem;
            if (!fs?.appendLog) return;
            // Attach sessionId to every persisted line (never bare counts).
            // A resolved `false` means main rate-limited the write: treat as
            // disk failure (streak++, ring entry kept) and retry once. Only a
            // truthy resolve resets the streak.
            fs.appendLog(level, `[${this.sessionId}] ${message}`).then(
                (ok: unknown) => {
                    if (ok === false) {
                        this._noteDiskFailure();
                        if (!isRetry) {
                            try { setTimeout(() => this._persist(level, message, true), 250); } catch { /* ignore */ }
                        }
                    } else {
                        this._diskFailStreak = 0;
                    }
                },
                () => { this._noteDiskFailure(); }
            );
        } catch { this._noteDiskFailure(); }
    }

    private _noteDiskFailure(): void {
        this._diskFailStreak++;
        if (this._diskFailStreak === 3) {
            try { console.error('[Logger] disk persistence failing — logs are memory-only'); } catch { /* ignore */ }
            try {
                const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
                this.ringBuffer.push({ level: 'WARN', message: '[Logger] disk persistence failing — logs are memory-only', timestamp, sessionId: this.sessionId });
                if (this.ringBuffer.length > MAX_LOG_ENTRIES) this.ringBuffer.shift();
            } catch { /* ignore */ }
        }
    }

    constructor() {
        this.sessionId = this._generateSessionId();
        this.info('=== GANGSTA PLAYER SESSION STARTED ===');
    }

    // ==================== PUBLIC API ====================

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
            `[${e.timestamp}] [${e.level}] [${e.sessionId}] ${e.message}`
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

    /** Log file path, or null when the bridge is unavailable (callers handle null). */
    async getLogPath(): Promise<string | null> {
        try {
            if (window.fileSystem?.getLogPath) {
                const p = await window.fileSystem.getLogPath();
                return typeof p === 'string' && p.length > 0 ? p : null;
            }
        } catch { /* bridge down */ }
        return null;
    }

    async generateCrashReport(stateSnapshot: Record<string, unknown>): Promise<string | null | undefined> {
        if (window.electronAPI?.generateCrashReport) {
            try {
                const reportPath = await window.electronAPI.generateCrashReport(stateSnapshot);
                this.error('CRITICAL: Render process crash detected. Diagnostic report generated.');
                return reportPath;
            } catch (e) {
                console.error('[Logger] Failed to generate crash report', e);
                try { this.error('CRASH REPORT FAILED — see log', e); } catch { /* ignore */ }
                // Dynamic import: toast.ts imports logger, so a static import
                // here would cycle. Failure toast is best-effort only.
                try {
                    void import('./toast').then((m) => {
                        try { m.toast.error('CRASH REPORT FAILED — see log'); } catch { /* ignore */ }
                    }).catch(() => undefined);
                } catch { /* ignore */ }
            }
        }
        return undefined;
    }

    // ==================== PRIVATE IMPLEMENTATION ====================

    private static readonly STRINGIFY_CAP = 2000;

    private _stringify(value: unknown): string {
        if (value instanceof Error) {
            const s = value.stack || value.message;
            return s.length > GangstaLogger.STRINGIFY_CAP
                ? s.slice(0, GangstaLogger.STRINGIFY_CAP) + '…(truncated)'
                : s;
        }
        try {
            const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
            return s.length > GangstaLogger.STRINGIFY_CAP
                ? s.slice(0, GangstaLogger.STRINGIFY_CAP) + '…(truncated)'
                : s;
        } catch {
            try {
                const s = String(value);
                return s.length > GangstaLogger.STRINGIFY_CAP
                    ? s.slice(0, GangstaLogger.STRINGIFY_CAP) + '…(truncated)'
                    : s;
            } catch {
                return '[unstringifiable]';
            }
        }
    }

    private _log(level: LogLevel, message: string): void {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const entry: LogEntry = { level, message, timestamp, sessionId: this.sessionId };
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

        // Persist to disk via Electron Bridge. DEBUG is flag-gated (default
        // off — high-frequency debug spam previously IPC-flooded main).
        // Burst policy is first-N + sampled, never pure counts: the first
        // messages in a window persist verbatim, then one sampled message per
        // window persists WITH its text, so disk always holds real errors.
        if (typeof window === 'undefined' || !(window as unknown as { fileSystem?: unknown }).fileSystem) return;
        if (entry.level === 'DEBUG' && !this.debugDiskEnabled) return;
        if (entry.level === 'INFO') {
            const now = Date.now();
            if (now - this._lastDiskWrite < 200) {
                this._diskDropped++;
                // Sample the burst: persist the sampled INFO text (not a bare
                // count) so disk holds evidence, throttled to one per window.
                if (this._diskDropped === 2) {
                    this._persist('INFO', `[Logger] INFO burst sample: ${entry.message.slice(0, 200)}`);
                }
                return;
            }
            if (this._diskDropped > 0) {
                const n = this._diskDropped;
                this._diskDropped = 0;
                this._lastDiskWrite = now;
                this._persist('INFO', `[Logger] INFO burst: ${n} dropped, resuming with sample: ${entry.message.slice(0, 200)}`);
            }
            this._lastDiskWrite = now;
        } else if (entry.level === 'WARN' || entry.level === 'ERROR') {
            const now = Date.now();
            const lvl = entry.level;
            const last = this._lastDiskWriteByLevel[lvl] ?? 0;
            if (now - last < 500) {
                this._diskDroppedByLevel[lvl] = (this._diskDroppedByLevel[lvl] ?? 0) + 1;
                if (entry.message === (this._lastMsgByLevel[lvl] ?? '')) {
                    this._repeatByLevel[lvl] = (this._repeatByLevel[lvl] ?? 0) + 1;
                } else if ((this._diskDroppedByLevel[lvl] ?? 0) === 1) {
                    this._lastMsgByLevel[lvl] = entry.message;
                    this._repeatByLevel[lvl] = 0;
                    this._persist(lvl, `[Logger] ${lvl} burst sample: ${entry.message.slice(0, 200)}`);
                }
                return;
            }
            const dropped = this._diskDroppedByLevel[lvl] ?? 0;
            if (dropped > 0) {
                const repeats = this._repeatByLevel[lvl] ?? 0;
                const sample = (this._lastMsgByLevel[lvl] ?? entry.message).slice(0, 160);
                this._diskDroppedByLevel[lvl] = 0;
                this._repeatByLevel[lvl] = 0;
                this._lastDiskWriteByLevel[lvl] = now;
                this._lastMsgByLevel[lvl] = entry.message;
                const summary = repeats > 0
                    ? `[Logger] ${lvl} burst: ${dropped} dropped (x${repeats + 1} repeats of '${sample}'), resuming with: ${entry.message.slice(0, 200)}`
                    : `[Logger] ${lvl} burst: ${dropped} dropped, resuming with: ${entry.message.slice(0, 200)}`;
                this._persist(lvl, summary);
            } else {
                this._lastDiskWriteByLevel[lvl] = now;
                this._lastMsgByLevel[lvl] = entry.message;
                this._repeatByLevel[lvl] = 0;
            }
        }
        this._persist(entry.level, entry.message);
    }

    private _generateSessionId(): string {
        return `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    }
}

// ==================== SINGLETON EXPORT ====================

export const logger = new GangstaLogger();
