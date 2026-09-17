/**
 * Shared Type Definitions for Gangsta Player Pro 3
 * Single source of truth for IPC contracts and global augmentations.
 */

// Dialog throttle sentinel: main returns this string (NOT null) when a
// dialog open is rate-limited. Real user-cancel / missing window stay null.
// Callers must check `=== DIALOG_THROTTLED` before truthiness (it is truthy).
export const DIALOG_THROTTLED = '__THROTTLED__';

// === Electron IPC API ===
// Mirrors preload.ts bridges exactly (see preload.ts for validation caps).
// Dialog methods resolve DIALOG_THROTTLED on rate-limit, null on real cancel.
export interface ElectronAPI {
    minimize(): void;
    maximize(): void;
    close(): void;
    setFullScreen(flag: boolean): void;
    appReadyToShow(): void;
    openExternal(relativePath: string): Promise<void>;
    saveKit(): Promise<string | null | undefined>;
    saveSessionDialog(): Promise<string | null | undefined>;
    loadKit(): Promise<string | null | undefined>;
    // Bounded path disclosure only for user-picked File objects (dialog/DnD).
    getPathForFile(file: File): string;
    saveAudioDialog(): Promise<string | null | undefined>;
    openSampleDialog(): Promise<string | null | undefined>;
    generateCrashReport(snapshot: unknown): Promise<string | null | undefined>;
}

export interface FileSystemAPI {
    // main returns Buffer|null (Node); renderer sees Uint8Array|null.
    readFile(filePath: string): Promise<Uint8Array | null>;
    // Metadata-only (SAME gates as readFile); null on reject/rate-limit.
    statFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null>;
    consentFile(filePath: string): Promise<boolean>;
    // main returns boolean success (false on reject/rate-limit).
    saveFile(filePath: string, data: Uint8Array): Promise<boolean>;
    showItemInFolder(filePath: string): Promise<boolean>;
    appendLog(level: string, message: string): Promise<boolean>;
    getLogPath(): Promise<string>;
}

export interface SonetraAPI {
    getCachedTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; audioBuffer?: Uint8Array | null; error?: string }>;
    precomputeTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; cached?: boolean; error?: string }>;
    onRestartStatus(callback: (status: unknown) => void): () => void;
    // Main-owned lifecycle (no renderer IPC — main process only).
    // Declared for main-process typing, not exposed via preload (H4).
    startServer?(): Promise<{ success: boolean; port?: number; error?: string }>;
    stopServer?(): Promise<{ success: boolean }>;
    restartServer?(): Promise<{ success: boolean; error?: string }>;
    analyzeTrack?(trackPath: string): Promise<{ success: boolean; analysis?: unknown; error?: string }>;
    createTransition?(a: string, b: string, style?: string): Promise<{ success: boolean; audioBuffer?: Uint8Array | null; error?: string }>;
}

export interface DatabaseAPI {
    upsertTrack(track: any): Promise<any>;
    getTrack(path: string): Promise<any>;
    searchTracks(query: string): Promise<any[]>;
    getAllTracks(): Promise<any[]>;
}

export interface PcmCacheAPI {
    // main returns Buffer|null (Node); renderer sees Uint8Array|null.
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, data: Uint8Array): Promise<boolean>;
}

// === Global Window Augmentation ===
// Bridges are guaranteed in Electron; renderer guards with `?.`/try-catch at
// call sites that also run in browser/test boots (see js/main.ts initApp).
declare global {
    interface Window {
        electronAPI: ElectronAPI;
        fileSystem: FileSystemAPI;
        sonetra: SonetraAPI;
        database: DatabaseAPI;
        pcmCache: PcmCacheAPI;
    }
}

export {};
