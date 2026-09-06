import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import { MAX_PLAYLIST_SEARCH_RESULTS } from './js/constants';

function safeParse(json: string | null | undefined, fallback: any): any {
    if (!json) return fallback;
    if (typeof json !== 'string' || json.length > 1024 * 1024) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
}

function finiteNum(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export class DatabaseManager {
    private db: Database.Database;

    constructor() {
        const userDataPath = app.getPath('userData');
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
                name = excluded.name,
                duration = excluded.duration,
                bpm = excluded.bpm,
                metadata = excluded.metadata,
                last_analyzed = CURRENT_TIMESTAMP
        `);
        return stmt.run({
            id: String(track.id).slice(0, 256),
            path: track.path,
            name: String(track.name ?? '').slice(0, 512),
            duration: finiteNum(track.duration, 0),
            bpm: finiteNum(track.bpm, 0),
            metadata: metadataJson
        });
    }

    public getTrackByPath(path: string) {
        const stmt = this.db.prepare('SELECT * FROM tracks WHERE path = ?');
        const row: any = stmt.get(path);
        if (row && row.metadata) row.metadata = safeParse(row.metadata, {});
        return row;
    }

    public getAllTracks(limit = 5000) {
        const safeLimit = Math.max(1, Math.min(20000, Math.floor(Number(limit) || 5000)));
        const stmt = this.db.prepare(`SELECT * FROM tracks ORDER BY name ASC LIMIT ${safeLimit}`);
        return stmt.all().map((row: any) => {
            if (row.metadata) row.metadata = safeParse(row.metadata, {});
            return row;
        });
    }

    // KIT OPERATIONS
    public saveKit(id: string, name: string, path: string, data: any) {
        if (typeof id !== 'string' || typeof name !== 'string' || typeof path !== 'string') {
            throw new Error('saveKit: invalid args');
        }
        if (id.length > 256 || name.length > 512 || path.length > 32760) {
            throw new Error('saveKit: field too long');
        }
        let dataJson = '{}';
        try {
            const s = JSON.stringify(data ?? {});
            if (s.length > 1024 * 1024) throw new Error('saveKit: data too large');
            dataJson = s;
        } catch (e: any) {
            if (String(e?.message ?? '').includes('too large')) throw e;
            throw new Error('saveKit: data not serializable');
        }
        const stmt = this.db.prepare(`
            INSERT INTO kits (id, name, path, data)
            VALUES (@id, @name, @path, @data)
            ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                data = excluded.data,
                last_saved = CURRENT_TIMESTAMP
        `);
        return stmt.run({ id, name, path, data: dataJson });
    }

    public loadKit(path: string) {
        const stmt = this.db.prepare('SELECT * FROM kits WHERE path = ?');
        const row: any = stmt.get(path);
        if (row && row.data) row.data = safeParse(row.data, null);
        return row;
    }

    // SEARCH / FILTER
    public searchTracks(query: string) {
        // Escape LIKE wildcards so user input like "50%" doesn't match everything
        const escaped = String(query ?? '').slice(0, 256).replace(/[\\%_]/g, ch => '\\' + ch);
        const wildcard = `%${escaped}%`;
        const stmt = this.db.prepare(
            `SELECT * FROM tracks WHERE name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
             ORDER BY name ASC LIMIT ${MAX_PLAYLIST_SEARCH_RESULTS}`
        );
        return stmt.all(wildcard, wildcard).map((row: any) => {
            if (row.metadata) row.metadata = safeParse(row.metadata, {});
            return row;
        });
    }

    public close() {
        try {
            try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
            this.db.close();
        } finally { _instance = null; }
    }
}

// Lazy singleton: constructing pre-`whenReady` relies on Electron internals.
// Main process creates the DB only when the first IPC handler needs it.
let _instance: DatabaseManager | null = null;
let _constructing = false;

export function getDbManager(): DatabaseManager | null {
    if (_instance) return _instance;
    // Unsynchronized lazy init previously double-opened the same SQLite file
    // under concurrent IPC. Second caller gets null (caller already null-guards).
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
