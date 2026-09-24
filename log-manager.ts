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
    private redactionEntries: Array<{ pattern: RegExp; replacement: string }> = [];

    private readonly MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
    private readonly VALID_LEVELS: ReadonlySet<string> = new Set(['INFO', 'WARN', 'ERROR', 'DEBUG']);

    private rebuildRedactionEntries(currentLogDir: string): void {
        const platform = os.platform();
        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const addEntry = (dir: string, replacement: string) => {
            if (!dir) return;
            const normalized = path.normalize(dir);
            const variants = [...new Set([dir, normalized, dir.replace(/\\/g, '/'), normalized.replace(/\\/g, '/')])]
                .filter(Boolean)
                .sort((a, b) => b.length - a.length);
            const alternatives = variants.map(escapeRegExp).join('|');
            const flags = `${platform === 'win32' || platform === 'darwin' ? 'i' : ''}g`;
            this.redactionEntries.push({
                pattern: new RegExp(`(?:${alternatives})(?=$|[\\\\/])`, flags),
                replacement
            });
        };

        this.redactionEntries = []; // Clear existing entries

        // User Data Path
        addEntry(currentLogDir, '<userData>');

        // Home Directory
        addEntry(os.homedir(), '<home>');

        // Temp Directory
        addEntry(os.tmpdir(), '<tmp>');
    }

    constructor() {
        let userDataPath: string;
        try {
            userDataPath = app.isReady() ? app.getPath('userData') : path.join(os.tmpdir(), 'gangsta-player');
        } catch {
            userDataPath = path.join(os.tmpdir(), 'gangsta-player');
        }
        try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* ignore */ }
        this.logFilePath = path.join(userDataPath, 'gangsta_log.txt');
        this.rebuildRedactionEntries(userDataPath);
        // Buffered entries must reach disk even without a crash — otherwise
        // the log file stays empty in normal operation.
        this.flushTimer = setInterval(() => this.flushBuffer(), this.FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
        this.info('=== LOG MANAGER INITIALIZED ===');
    }

    public log(level: LogLevel, source: 'MAIN' | 'RENDERER', message: string) {
        if (!this.VALID_LEVELS.has(level as string)) level = 'INFO';
        if (source !== 'MAIN' && source !== 'RENDERER') source = 'MAIN';
        let msg = String(message ?? '');

        // Apply redaction before stripping/capping
        for (const { pattern, replacement } of this.redactionEntries) {
            msg = msg.replace(pattern, replacement);
        }

        msg = msg.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ')
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

    private flushBuffer(keepBuffer = false): void {
        if (this.buffer.length === 0) return;
        const batch = this.buffer.join('');
        if (!keepBuffer) {
            this.buffer = [];
            this.currentBufferSize = 0;
        }
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

    private _lastRotationCheck = 0;
    private readonly ROTATION_CHECK_MS = 30_000;

    private flushEntryToDisk(entry: string) {
        try {
            // Rotation check throttled (H7): two sync stats per ERROR/WARN
            // stalled the main thread under renderer log spam. Size moves
            // slowly — recheck at most every 30s; the byte cap stays exact.
            const now = Date.now();
            if (now - this._lastRotationCheck >= this.ROTATION_CHECK_MS) {
                this._lastRotationCheck = now;
                try {
                    const st = fs.statSync(this.logFilePath);
                    if (st.size > this.MAX_LOG_FILE_BYTES) {
                        const backup = `${this.logFilePath}.1`;
                        try { fs.renameSync(this.logFilePath, backup); } catch { /* ignore */ }
                    }
                } catch { /* file may not exist yet */ }
            }
            fs.appendFileSync(this.logFilePath, entry);
        } catch (e) {
            console.error('Failed to flush log entry to disk', e);
        }
    }

    public info(msg: string) { this.log('INFO', 'MAIN', msg); }
    public error(msg: string) { this.log('ERROR', 'MAIN', msg); }

    /**
     * Move the log file into the ready userData dir. The constructor runs
     * pre-whenReady (tmpdir fallback) while post-mortems use userData — logs
     * and reports were split across dirs with tmp world-readable. Call once
     * from app.whenReady(); the ring buffer is untouched, only future
     * flushes go to the new path.
     */
    public relocateToUserData(): void {
        try {
            const userDataPath = app.getPath('userData');
            try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* ignore */ }
            const next = path.join(userDataPath, 'gangsta_log.txt');
            if (next === this.logFilePath) return;
            this.logFilePath = next;
            this._lastRotationCheck = 0;
            this.rebuildRedactionEntries(userDataPath);
        } catch { /* keep current path */ }
    }

    public close(keepBuffer = false): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushBuffer(keepBuffer);
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
        let userDataPath: string;
        try {
            userDataPath = app.getPath('userData');
        } catch {
            userDataPath = path.join(os.tmpdir(), 'gangsta-player');
            try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* ignore */ }
        }
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

        let logs = '';
        try {
            logs = this.getBufferContents().slice(-512 * 1024);
        } catch { logs = ''; }
        if (!logs) {
            try {
                const fd = fs.openSync(this.logFilePath, 'r');
                try {
                    const st = fs.fstatSync(fd);
                    const tail = Math.min(st.size, 512 * 1024);
                    const buf = Buffer.alloc(tail);
                    fs.readSync(fd, buf, 0, tail, Math.max(0, st.size - tail));
                    logs = buf.toString('utf8');
                } finally {
                    try { fs.closeSync(fd); } catch { /* ignore */ }
                }
            } catch { /* no disk tail available */ }
        }
        const report = {
            timestamp: new Date().toISOString(),
            systemSpecs,
            appState: snapshotJson,
            logs
        };

        try {
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            try { fs.chmodSync(reportPath, 0o600); } catch { /* Windows ignores */ }
        } catch (e) {
            const fallback = path.join(os.tmpdir(), `gangsta_crash_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}.json`);
            try {
                fs.writeFileSync(fallback, JSON.stringify(report, null, 2));
                try { fs.chmodSync(fallback, 0o600); } catch { /* Windows ignores */ }
                return fallback;
            } catch {
                throw e instanceof Error ? e : new Error(String(e));
            }
        }

        // Return path for UI/User to find
        return reportPath;
    }
}

export const logManager = new LogManager();
