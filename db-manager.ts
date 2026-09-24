import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { VALID_AUDIO_EXTENSIONS } from './js/constants';

function safeParse(json: string | null | undefined, fallback: any): any {
    if (!json) return fallback;
    if (typeof json !== 'string' || json.length > 1024 * 1024) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
}

function finiteNum(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function canonicalizeTrackPath(p: string): string {
    let resolved: string;
    try {
        resolved = path.resolve(p);
    } catch {
        resolved = p;
    }
    resolved = resolved.replace(/\\/g, '/');
    if (process.platform === 'win32' || process.platform === 'darwin') {
        resolved = resolved.toLowerCase();
    }
    return resolved;
}

// ==================== AUDIO CONSENT ALLOWLIST ====================
// Relocated VERBATIM from sonetra-bridge.ts (bridge deleted; local DSP
// engine is the mixer now). These gates back main.ts isReadPathAllowed and
// the upsert consent check below — behavior is identical: deleting the
// bridge must NOT silently widen the DB gate to extension-only.
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm']);

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

// Per-file user consent store (drag-and-drop / dialog picks).
// DnD files live in arbitrary folders (Downloads/Desktop) that can never be
// allowlisted by directory without opening drive roots — so the renderer
// registers the EXACT dropped file path via fs:consent-file and the gate
// honors only that file, never its parent directory.
const ALLOWED_AUDIO_FILES = new Map<string, number>();
const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONSENTED_FILES = 5000;
const MAX_PERSISTED_CONSENT_FILES = 5000;

function canonicalAudioKey(p: string): string {
    try {
        const r = path.resolve(p);
        return (process.platform === 'win32' || process.platform === 'darwin') ? r.toLowerCase() : r;
    } catch { return p; }
}

/** True when the resolved path sits inside one of the allowed directories. */
export function isAllowedAudioDirForPath(filePath: string): boolean {
    try {
        // Case-insensitive only where the FS is (Windows/macOS); Linux stays exact.
        const insensitive = process.platform === 'win32' || process.platform === 'darwin';
        const resolved = path.resolve(filePath);
        const insideDir = (dir: string): boolean => {
            const d = path.resolve(dir);
            const dc = insensitive ? d.toLowerCase() : d;
            const fc = insensitive ? resolved.toLowerCase() : resolved;
            return fc === dc || fc.startsWith(dc + path.sep);
        };
        if (ALLOWED_AUDIO_DIRS.some(allowed => allowed && insideDir(allowed))) return true;
        const devDir = path.join(__dirname, '..', 'recordings');
        if (insideDir(devDir)) return true;
        return false;
    } catch { return false; }
}

/**
 * Register a single user-consented audio file (DnD drop or dialog pick).
 * Validates existence, audio extension, and size before storing — a renderer
 * string alone never grants access. Returns true when consent was recorded.
 */
interface ValidatedAudioPath {
    resolved: string;
    real: string;
}

function validateAudioPath(filePath: string): ValidatedAudioPath | null {
    if (!filePath || typeof filePath !== 'string') return null;
    if (filePath.includes('\0') || filePath.length > 32760) return null;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(filePath)) return null;
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return null;
    if (!path.isAbsolute(filePath)) return null;
    if (filePath.includes(':') && !/^[a-zA-Z]:[\\/]/.test(filePath)) return null;
    let resolved: string;
    try { resolved = path.resolve(path.normalize(filePath)); } catch { return null; }
    const ext = path.extname(resolved).replace('.', '').toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return null;
    try {
        let real = resolved;
        try { real = fs.realpathSync.native(resolved); } catch { return null; }
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > 100 * 1024 * 1024) return null;
        return { resolved, real };
    } catch { return null; }
}

function registerAllowedAudioFile(filePath: string, persist: boolean, expectedReal?: string): boolean {
    const validated = validateAudioPath(filePath);
    if (!validated) return false;
    if (expectedReal && canonicalAudioKey(validated.real) !== canonicalAudioKey(expectedReal)) return false;
    let persistent = false;
    if (persist) {
        try { persistent = getDbManager()?.saveAllowedAudioFile(validated.resolved, validated.real) === true; } catch { /* best effort */ }
    }
    const stamp = persistent || !persist ? 0 : Date.now();
    const now = Date.now();
    for (const [k, t] of Array.from(ALLOWED_AUDIO_FILES)) {
        if (t !== 0 && now - t > CONSENT_TTL_MS) ALLOWED_AUDIO_FILES.delete(k);
    }
    const resolvedKey = canonicalAudioKey(validated.resolved);
    ALLOWED_AUDIO_FILES.set(resolvedKey, stamp);
    const realKey = canonicalAudioKey(validated.real);
    if (realKey !== resolvedKey) ALLOWED_AUDIO_FILES.set(realKey, stamp);
    while (ALLOWED_AUDIO_FILES.size > MAX_CONSENTED_FILES) {
        const oldest = ALLOWED_AUDIO_FILES.keys().next().value;
        if (!oldest) break;
        ALLOWED_AUDIO_FILES.delete(oldest);
    }
    return true;
}

export function addAllowedAudioFile(filePath: string): boolean {
    return registerAllowedAudioFile(filePath, true);
}

export function isAllowedAudioFile(filePath: string): boolean {
    try {
        const key = canonicalAudioKey(path.resolve(filePath));
        const t = ALLOWED_AUDIO_FILES.get(key);
        if (t !== undefined) {
            if (t === 0 || Date.now() - t <= CONSENT_TTL_MS) return true;
            ALLOWED_AUDIO_FILES.delete(key);
        }
        try {
            const real = fs.realpathSync.native(path.resolve(filePath));
            const rk = canonicalAudioKey(real);
            const rt = ALLOWED_AUDIO_FILES.get(rk);
            if (rt !== undefined) {
                if (rt === 0 || Date.now() - rt <= CONSENT_TTL_MS) return true;
                ALLOWED_AUDIO_FILES.delete(rk);
            }
        } catch { /* dangling — not consented */ }
        return false;
    } catch { return false; }
}

export class DatabaseManager {
    private db: Database.Database;

    constructor() {
        const userDataPath = app.getPath('userData');
        try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* ignore */ }
        const dbPath = path.join(userDataPath, 'gangsta.db');

        this.db = new Database(dbPath);
        // Corrupt DB must not brick main — caller (getDbManager) handles failure.
        this.initSchema();
    }

    private initSchema() {
        // High-performance PRAGMA settings
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        try { this.db.pragma('busy_timeout = 5000'); } catch { /* older sqlite */ }
        try { this.db.pragma('foreign_keys = ON'); } catch { /* ignore */ }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                path TEXT UNIQUE,
                name TEXT,
                duration REAL,
                bpm REAL,
                last_analyzed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS kits (
                id TEXT PRIMARY KEY,
                name TEXT,
                path TEXT UNIQUE,
                data TEXT,
                last_saved TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS allowed_audio_files (
                path TEXT PRIMARY KEY,
                real_path TEXT NOT NULL,
                consented_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
            CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
        `);
    }

    // TRACK OPERATIONS
    public upsertTrack(track: any) {
        if (!track || typeof track.path !== 'string' || !track.path || typeof track.id !== 'string' || !track.id) {
            throw new Error('upsertTrack: id and path are required');
        }
        if (track.path.length > 32760 || String(track.name ?? '').length > 512) {
            throw new Error('upsertTrack: field too long');
        }
        if (String(track.id).length > 256) throw new Error('upsertTrack: id too long');
        // Ext gate: DB tracks must be audio (plus ADS/UNC rejection).
        const ext = path.extname(track.path).replace('.', '').toLowerCase();
        if (!(VALID_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
            throw new Error(`upsertTrack: non-audio extension (.${ext})`);
        }
        if (track.path.includes('\0')) throw new Error('upsertTrack: illegal path');
        const drive = /^[a-zA-Z]:[\\/]/.exec(track.path);
        const rest = drive ? track.path.slice(drive[0].length) : track.path;
        if (rest.includes(':') || track.path.includes(':$DATA')) throw new Error('upsertTrack: ADS path rejected');
        if (track.path.startsWith('\\\\') || track.path.startsWith('//')) throw new Error('upsertTrack: UNC path rejected');
        // Consent gate (best-effort in main without IPC round-trip): allow
        // only consented files, dialog approvals, recordings, or allowlisted
        // audio dirs. Helpers live in this module (relocated from the deleted
        // sonetra-bridge) — fail closed on any unexpected error.
        try {
            const consented = isAllowedAudioFile(track.path) || isAllowedAudioDirForPath(track.path);
            if (!consented) {
                // Recordings + dialog paths are also legit; check lexically.
                let inRecordings = false;
                try {
                    const userDataPath = app.getPath('userData');
                    const recDir = path.resolve(path.join(userDataPath, 'recordings'));
                    const rel = path.relative(recDir, path.resolve(track.path));
                    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
                    const relCmp = insensitive ? rel.toLowerCase() : rel;
                    inRecordings = !!rel && !relCmp.startsWith('..') && !path.isAbsolute(rel);
                } catch { /* ignore */ }
                if (!inRecordings) throw new Error('upsertTrack: file not consented');
            }
        } catch (e: any) {
            if (String(e?.message ?? '').includes('not consented')) throw e;
            throw new Error('upsertTrack: file not consented');
        }
        let metadataJson = '{}';
        try {
            const md = track.metadata ?? {};
            const s = JSON.stringify(md);
            if (s.length > 256 * 1024) throw new Error('upsertTrack: metadata too large');
            metadataJson = s;
        } catch (e: any) {
            if (String(e?.message ?? '').includes('too large')) throw e;
            throw new Error('upsertTrack: metadata not serializable');
        }
        const stmt = this.db.prepare(`
            INSERT INTO tracks (id, path, name, duration, bpm, metadata)
            VALUES (@id, @path, @name, @duration, @bpm, @metadata)
            ON CONFLICT(path) DO UPDATE SET
                name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE tracks.name END,
                duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE tracks.duration END,
                bpm = CASE WHEN excluded.bpm > 0 THEN excluded.bpm ELSE tracks.bpm END,
                metadata = CASE WHEN excluded.metadata <> '{}' THEN excluded.metadata ELSE tracks.metadata END,
                last_analyzed = CURRENT_TIMESTAMP
        `);
        return stmt.run({
            id: String(track.id).slice(0, 256),
            path: canonicalizeTrackPath(track.path),
            name: String(track.name ?? '').slice(0, 512),
            duration: finiteNum(track.duration, 0),
            bpm: finiteNum(track.bpm, 0),
            metadata: metadataJson
        });
    }

    public getTrackByPath(path: string) {
        const stmt = this.db.prepare('SELECT * FROM tracks WHERE path = ?');
        let row: any = stmt.get(canonicalizeTrackPath(path));
        if (!row) row = stmt.get(path);
        if (row && row.metadata) row.metadata = safeParse(row.metadata, {});
        return row;
    }

    public getAllTracks(limit = 5000) {
        const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 5000)));
        // Bulk path excludes metadata: 5000 rows x 256KB metadata = GBs over
        // IPC (freeze/OOM). Single-track getTrackByPath keeps metadata for
        // callers that need it (track-info).
        const stmt = this.db.prepare(`SELECT id, path, name, duration, bpm, last_analyzed FROM tracks ORDER BY name ASC LIMIT ${safeLimit}`);
        return stmt.all();
    }

    // SEARCH / FILTER
    public searchTracks(query: string) {
        const raw = String(query ?? '').slice(0, 256).trim();
        if (raw.replace(/[\\%_]/g, '').length < 2) return [];
        // Escape LIKE wildcards so user input like "50%" doesn't match everything
        const escaped = raw.replace(/[\\%_]/g, ch => '\\' + ch);
        const wildcard = `%${escaped}%`;
        // Bulk surface excludes metadata (256KB x rows = IPC OOM) and caps
        // at 200 rows — getTrackByPath keeps metadata for single-track needs.
        const stmt = this.db.prepare(
            `SELECT id, path, name, duration, bpm FROM tracks WHERE name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
             ORDER BY name ASC LIMIT 200`
        );
        return stmt.all(wildcard, wildcard);
    }

    public saveAllowedAudioFile(filePath: string, realPath: string): boolean {
        try {
            const key = canonicalAudioKey(filePath);
            const realKey = canonicalAudioKey(realPath);
            if (!key || !realKey) return false;
            const now = Date.now();
            this.db.prepare(`
                INSERT INTO allowed_audio_files (path, real_path, consented_at, last_used_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    real_path = excluded.real_path,
                    last_used_at = excluded.last_used_at
            `).run(key, realKey, now, now);
            this.db.prepare(`
                DELETE FROM allowed_audio_files
                WHERE path NOT IN (
                    SELECT path FROM allowed_audio_files
                    ORDER BY last_used_at DESC LIMIT ?
                )
            `).run(MAX_PERSISTED_CONSENT_FILES);
            return true;
        } catch {
            return false;
        }
    }

    public getAllowedAudioFiles(): Array<{ path: string; realPath: string }> {
        try {
            return this.db.prepare('SELECT path, real_path FROM allowed_audio_files ORDER BY last_used_at DESC')
                .all()
                .map((row: any) => ({ path: String(row.path ?? ''), realPath: String(row.real_path ?? '') }))
                .filter((row: { path: string; realPath: string }) => row.path && row.realPath);
        } catch {
            return [];
        }
    }

    public close() {
        try {
            try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
            this.db.close();
        } finally {
            _instance = null;
            ALLOWED_AUDIO_FILES.clear();
        }
    }
}

// Lazy singleton: constructing pre-`whenReady` relies on Electron internals.
// Main process creates the DB eagerly on whenReady and on first IPC use.
// Concurrent first-use while init is in flight returns null immediately —
// every db:* handler already null-checks, so callers retry/degrade instead
// of the old 2s busy-spin that froze the entire main loop (C4).
let _instance: DatabaseManager | null = null;
let _constructing = false;

export function getDbManager(): DatabaseManager | null {
    if (_instance) return _instance;
    if (_constructing) return null;
    _constructing = true;
    try {
        _instance = new DatabaseManager();
    } catch (e) {
        console.error('[DB] Failed to initialize database:', e);
        _instance = null;
    } finally {
        _constructing = false;
    }
    return _instance;
}

/** Eager init, safe to call once from app.whenReady(). Returns null on failure. */
export function initDbManager(): DatabaseManager | null {
    return getDbManager();
}

export function loadAllowedAudioFiles(): number {
    const db = getDbManager();
    if (!db) return 0;
    let loaded = 0;
    for (const row of db.getAllowedAudioFiles()) {
        if (registerAllowedAudioFile(row.path, false, row.realPath)) loaded++;
    }
    return loaded;
}
