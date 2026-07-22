/**
 * Gangsta Logger Module — Enterprise Edition
 * Features:
 *   - Structured JSON logging for SIEM ingestion
 *   - Correlation IDs for request tracing across processes
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
    correlationId?: string;
    metadata?: Record<string, unknown>;
}

interface StructuredLogRecord {
    '@timestamp': string;
    level: LogLevel;
    message: string;
    correlation_id?: string;
    session_id: string;
    source: string;
    metadata?: Record<string, unknown>;
    pid: number;
    _format_version: number;
}

const LOG_FORMAT_VERSION = 1;

class GangstaLogger {
    private ringBuffer: LogEntry[] = [];
    private minLevel: LogLevel = 'DEBUG';
    private sessionId: string;
    private _correlationIdCounter = 0;
    private _structuredMode = false;

    constructor() {
        this.sessionId = this._generateSessionId();
        this.info('=== GANGSTA PLAYER SESSION STARTED ===');
    }

    // ==================== PUBLIC API ====================

    /** Enable/disable structured JSON output for SIEM integration */
    setStructuredMode(enabled: boolean): void {
        this._structuredMode = enabled;
    }

    /** Set minimum log level at runtime (blocks lower severity) */
    setLogLevel(level: LogLevel): void {
        this.minLevel = level;
    }

    /** Get current minimum log level */
    getLogLevel(): LogLevel {
        return this.minLevel;
    }

    /** Generate a new correlation ID for tracing an operation */
    createCorrelationId(): string {
        this._correlationIdCounter++;
        return `${this.sessionId}-${this._correlationIdCounter}`;
    }

    /** Returns a copy of the in-memory ring buffer */
    getLogs(): LogEntry[] {
        return [...this.ringBuffer];
    }

    /** Returns log entries formatted as plain text for copying */
    getLogsAsText(): string {
        return this.ringBuffer.map(e =>
            `[${e.timestamp}] [${e.level}]${e.correlationId ? ` [cid:${e.correlationId}]` : ''} ${e.message}`
        ).join('\n');
    }

    /** Returns structured JSON log export (for external tooling) */
    getLogsAsJSON(): StructuredLogRecord[] {
        return this.ringBuffer.map(e => this._toStructured(e));
    }

    // ==================== LOGGING METHODS ====================

    info(msg: string, meta?: Record<string, unknown>, correlationId?: string): void {
        this._log('INFO', msg, meta, correlationId);
    }

    warn(msg: string, meta?: Record<string, unknown>, correlationId?: string): void {
        this._log('WARN', msg, meta, correlationId);
    }

    error(msg: string, meta?: Record<string, unknown>, correlationId?: string): void {
        this._log('ERROR', msg, meta, correlationId);
    }

    debug(msg: string, meta?: Record<string, unknown>, correlationId?: string): void {
        this._log('DEBUG', msg, meta, correlationId);
    }

    /** Compatibility: allow old-style variadic args (e.g. logger.warn('msg', err)) */
    warnCompat(...args: unknown[]): void {
        const msg = args.map(a => typeof a === 'object' ? String(a) : String(a)).join(' ');
        this._log('WARN', msg);
    }

    errorCompat(...args: unknown[]): void {
        const msg = args.map(a => typeof a === 'object' ? String(a) : String(a)).join(' ');
        this._log('ERROR', msg);
    }

    async getLogPath(): Promise<string> {
        if (window.fileSystem?.getLogPath) {
            return await window.fileSystem.getLogPath();
        }
        return 'UNKNOWN';
    }

    async generateCrashReport(stateSnapshot: Record<string, unknown>): Promise<string | undefined> {
        if (window.electronAPI?.generateCrashReport) {
            try {
                const reportPath = await window.electronAPI.generateCrashReport(stateSnapshot);
                this.error('CRITICAL: Render process crash detected. Diagnostic report generated.', { reportPath });
                return reportPath;
            } catch (e) {
                console.error('[Logger] Failed to generate crash report', e);
            }
        }
        return undefined;
    }

    // ==================== PRIVATE IMPLEMENTATION ====================

    private _shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[this.minLevel];
    }

    private _log(level: LogLevel, message: string, metadata?: Record<string, unknown>, correlationId?: string): void {
        if (!this._shouldLog(level)) {
            return;
        }

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const entry: LogEntry = { level, message, timestamp, correlationId, metadata };
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
        const consoleMessage = this._formatLog(entry);
        // TypeScript 5.5+ supports index types on console; fallback to type assertion for safety
        const consoleFn = console[consoleMethod as keyof Console];
        if (typeof consoleFn === 'function') consoleFn(consoleMessage);

        // Persist to disk via Electron Bridge
        if (window.fileSystem?.appendLog) {
            const payload = this._formatPayload(entry);
            window.fileSystem.appendLog(entry.level, payload).catch(() => {});
        }
    }

    private _formatLog(entry: LogEntry): string {
        const extras = entry.correlationId
            ? ` [correlationId: ${entry.correlationId}]` +
              (entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '')
            : '';

        const structuredMarker = this._structuredMode ? ' [STRUCTURED]' : '';
        return `[${entry.level}]${structuredMarker} ${entry.message}${extras}`;
    }

    private _formatPayload(entry: LogEntry): string {
        if (this._structuredMode) {
            const record = this._toStructured(entry);
            return JSON.stringify(record);
        }
        return entry.message;
    }

    private _toStructured(entry: LogEntry): StructuredLogRecord {
        return {
            '@timestamp': entry.timestamp,
            _format_version: LOG_FORMAT_VERSION,
            level: entry.level,
            message: entry.message,
            correlation_id: entry.correlationId,
            session_id: this.sessionId,
            source: 'GangstaPlayer-Pro3',
            pid: 0, // Browser context - no PID access
            metadata: entry.metadata,
        };
    }

    private _generateSessionId(): string {
        return `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    }
}

// ==================== SINGLETON EXPORT ====================

export const logger = new GangstaLogger();
