/**
 * Gangsta Logger Module
 * Categorizes and persists logs to a local disk file for easier debugging.
 */

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

class GangstaLogger {
    private isReady = false;

    constructor() {
        // Initialize by appending a startup entry
        this.info('=== GANGSTA PLAYER SESSION STARTED ===');
    }

    private async log(level: LogLevel, ...args: any[]) {
        const message = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');

        // Console fallback for immediate dev feedback
        const consoleMethod = level === 'ERROR' ? 'error' : (level === 'WARN' ? 'warn' : 'log');
        (console as any)[consoleMethod](`[${level}] ${message}`);

        // Persist to disk via Electron Bridge
        if ((window as any).fileSystem && (window as any).fileSystem.appendLog) {
            try {
                await (window as any).fileSystem.appendLog(level, message);
            } catch (e) {
                console.warn('[Logger] Failed to persist log entry', e);
            }
        }
    }

    info(...args: any[]) { this.log('INFO', ...args); }
    warn(...args: any[]) { this.log('WARN', ...args); }
    error(...args: any[]) { this.log('ERROR', ...args); }
    debug(...args: any[]) { this.log('DEBUG', ...args); }

    async getLogPath(): Promise<string> {
        if ((window as any).fileSystem && (window as any).fileSystem.getLogPath) {
            return await (window as any).fileSystem.getLogPath();
        }
        return 'UNKNOWN';
    }

    async generateCrashReport(stateSnapshot: any) {
        if ((window as any).electronAPI && (window as any).electronAPI.generateCrashReport) {
            try {
                const reportPath = await (window as any).electronAPI.generateCrashReport(stateSnapshot);
                this.error('CRITICAL: Render process crash detected. Diagnostic report generated at:', reportPath);
                return reportPath;
            } catch (e) {
                console.error('[Logger] Failed to generate crash report', e);
            }
        }
    }
}

export const logger = new GangstaLogger();
