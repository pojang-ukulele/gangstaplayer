import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

class LogManager {
    private readonly MAX_BUFFER_SIZE = 1 * 1024 * 1024; // 1MB
    private readonly FLUSH_INTERVAL_MS = 10_000;
    private buffer: string[] = [];
    private currentBufferSize = 0;
    private logFilePath: string;
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        const userDataPath = app.getPath('userData');
        this.logFilePath = path.join(userDataPath, 'gangsta_log.txt');
        // Buffered entries must reach disk even without a crash — otherwise
        // the log file stays empty in normal operation.
        this.flushTimer = setInterval(() => this.flushBuffer(), this.FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
        this.info('=== LOG MANAGER INITIALIZED ===');
    }

    public log(level: LogLevel, source: 'MAIN' | 'RENDERER', message: string) {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] [${source}] [${level}] ${message}\n`;

        // Add to ring buffer
        this.addToBuffer(entry);

        // Immediate flush for High Interest events, but KEEP them in the
        // ring buffer — post-mortem bundles are built from the buffer and
        // previously every ERROR/WARN was deleted before a crash report.
        if (level === 'ERROR' || level === 'WARN') {
            this.flushEntryToDisk(entry);
        }
    }

    private flushBuffer(): void {
        if (this.buffer.length === 0) return;
        const batch = this.buffer.join('');
        this.buffer = [];
        this.currentBufferSize = 0;
        this.flushEntryToDisk(batch);
    }

    private addToBuffer(entry: string) {
        this.buffer.push(entry);
        this.currentBufferSize += Buffer.byteLength(entry, 'utf8');

        // Ring buffer logic: remove oldest entries if size exceeded
        while (this.currentBufferSize > this.MAX_BUFFER_SIZE && this.buffer.length > 0) {
            const removed = this.buffer.shift();
            if (removed) {
                this.currentBufferSize -= Buffer.byteLength(removed, 'utf8');
            }
        }
    }

    private flushEntryToDisk(entry: string) {
        try {
            fs.appendFileSync(this.logFilePath, entry);
        } catch (e) {
            console.error('Failed to flush log entry to disk', e);
        }
    }

    public info(msg: string) { this.log('INFO', 'MAIN', msg); }
    public error(msg: string) { this.log('ERROR', 'MAIN', msg); }

    public close(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushBuffer();
    }

    public getBufferContents(): string {
        return this.buffer.join('');
    }

    public getLogPath(): string {
        return this.logFilePath;
    }

    /**
     * Generates a Post-Mortem Report Bundle
     */
    public async generatePostMortem(stateSnapshot: any = {}): Promise<string> {
        const userDataPath = app.getPath('userData');
        const reportId = Date.now();
        const reportPath = path.join(userDataPath, `crash_report_${reportId}.json`);

        const systemSpecs = {
            os: {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                uptime: os.uptime(),
            },
            cpu: {
                model: os.cpus()[0].model,
                cores: os.cpus().length,
            },
            memory: {
                totalGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
                freeGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
            },
            electron: {
                version: process.versions.electron,
                chrome: process.versions.chrome,
                node: process.versions.node,
            }
        };

        const report = {
            timestamp: new Date().toISOString(),
            systemSpecs,
            appState: stateSnapshot,
            logs: this.getBufferContents()
        };

        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        // Return path for UI/User to find
        return reportPath;
    }
}

export const logManager = new LogManager();
