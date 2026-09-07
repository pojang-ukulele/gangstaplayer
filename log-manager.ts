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

    private readonly MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
    private readonly VALID_LEVELS: ReadonlySet<string> = new Set(['INFO', 'WARN', 'ERROR', 'DEBUG']);

    constructor() {
        let userDataPath: string;
        try {
            userDataPath = app.isReady() ? app.getPath('userData') : path.join(os.tmpdir(), 'gangsta-player');
        } catch {
            userDataPath = path.join(os.tmpdir(), 'gangsta-player');
        }
        try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* ignore */ }
        this.logFilePath = path.join(userDataPath, 'gangsta_log.txt');
        // Buffered entries must reach disk even without a crash — otherwise
        // the log file stays empty in normal operation.
        this.flushTimer = setInterval(() => this.flushBuffer(), this.FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
        this.info('=== LOG MANAGER INITIALIZED ===');
    }

    public log(level: LogLevel, source: 'MAIN' | 'RENDERER', message: string) {
        if (!this.VALID_LEVELS.has(level as string)) level = 'INFO';
        if (source !== 'MAIN' && source !== 'RENDERER') source = 'MAIN';
        let msg = String(message ?? '')
            .replace(/[\r\n\x00-\x1F\x7F]+/g, ' ')
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b\([0-9A-Z]/g, '')
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .slice(0, 2000);
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] [${source}] [${level}] ${msg}\n`;

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
            // Rotation: unbounded gangsta_log.txt was a renderer-spammable disk-fill.
            try {
                const st = fs.statSync(this.logFilePath);
                if (st.size > this.MAX_LOG_FILE_BYTES) {
                    const backup = `${this.logFilePath}.1`;
                    try { fs.renameSync(this.logFilePath, backup); } catch { /* ignore */ }
                }
            } catch { /* file may not exist yet */ }
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
        // Unique filename — same-ms parallel calls previously collided/overwrote.
        const reportId = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
        const reportPath = path.join(userDataPath, `crash_report_${reportId}.json`);
        // Prune old reports: unbounded crash_report_*.json was a disk-fill vector.
        try {
            const files = fs.readdirSync(userDataPath)
                .filter(f => f.startsWith('crash_report_') && f.endsWith('.json'))
                .map(f => ({ f, t: fs.statSync(path.join(userDataPath, f)).mtimeMs }))
                .sort((a, b) => b.t - a.t);
            for (const old of files.slice(10)) {
                try { fs.unlinkSync(path.join(userDataPath, old.f)); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        let snapshotJson = '{}';
        try {
            const s = JSON.stringify(stateSnapshot ?? {});
            snapshotJson = s.length > 256 * 1024 ? s.slice(0, 256 * 1024) + '...[truncated]' : s;
        } catch {
            snapshotJson = '{"error":"snapshot not serializable"}';
        }
        let cpus: os.CpuInfo[] = [];
        try { cpus = os.cpus(); } catch { cpus = []; }

        const systemSpecs = {
            os: {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                uptime: os.uptime(),
            },
            cpu: {
                model: cpus.length > 0 ? cpus[0].model : 'unknown',
                cores: cpus.length,
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
            appState: snapshotJson,
            logs: this.getBufferContents().slice(-512 * 1024)
        };

        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        // Return path for UI/User to find
        return reportPath;
    }
}

export const logManager = new LogManager();
