import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export class DatabaseManager {
    private db: Database.Database;

    constructor() {
        const userDataPath = app.getPath('userData');
        const dbPath = path.join(userDataPath, 'gangsta.db');
        
        this.db = new Database(dbPath);
        this.initSchema();
    }

    private initSchema() {
        // High-performance PRAGMA settings
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

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
            id: track.id,
            path: track.path,
            name: track.name,
            duration: track.duration || 0,
            bpm: track.bpm || 0,
            metadata: JSON.stringify(track.metadata || {})
        });
    }

    public getTrackByPath(path: string) {
        const stmt = this.db.prepare('SELECT * FROM tracks WHERE path = ?');
        const row: any = stmt.get(path);
        if (row && row.metadata) row.metadata = JSON.parse(row.metadata);
        return row;
    }

    public getAllTracks() {
        const stmt = this.db.prepare('SELECT * FROM tracks ORDER BY name ASC');
        return stmt.all().map((row: any) => {
            if (row.metadata) row.metadata = JSON.parse(row.metadata);
            return row;
        });
    }

    // KIT OPERATIONS
    public saveKit(id: string, name: string, path: string, data: any) {
        const stmt = this.db.prepare(`
            INSERT INTO kits (id, name, path, data)
            VALUES (@id, @name, @path, @data)
            ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                data = excluded.data,
                last_saved = CURRENT_TIMESTAMP
        `);
        return stmt.run({ id, name, path, data: JSON.stringify(data) });
    }

    public loadKit(path: string) {
        const stmt = this.db.prepare('SELECT * FROM kits WHERE path = ?');
        const row: any = stmt.get(path);
        if (row && row.data) row.data = JSON.parse(row.data);
        return row;
    }

    // SEARCH / FILTER
    public searchTracks(query: string) {
        const stmt = this.db.prepare('SELECT * FROM tracks WHERE name LIKE ? OR path LIKE ?');
        const wildcard = `%${query}%`;
        return stmt.all(wildcard, wildcard).map((row: any) => {
            if (row.metadata) row.metadata = JSON.parse(row.metadata);
            return row;
        });
    }

    public close() {
        this.db.close();
    }
}

export const dbManager = new DatabaseManager();
