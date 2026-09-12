/**
 * Shared Type Definitions for Gangsta Player Pro 3
 * Single source of truth for IPC contracts and global augmentations.
 */

// === Electron IPC API ===
// Mirrors preload.ts bridges exactly (see preload.ts for validation caps).
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

// === Global Window Augmentation ===
// Bridges are guaranteed in Electron; renderer guards with `?.`/try-catch at
// call sites that also run in browser/test boots (see js/main.ts initApp).
declare global {
    interface Window {
        electronAPI: ElectronAPI;
        fileSystem: FileSystemAPI;
        sonetra: SonetraAPI;
        database: DatabaseAPI;
    }
}

// === IPC Channels ===
// Must match main.ts registerIpcHandlers + preload.ts invokes.
export type IpcChannels = 
    | 'app:minimize'
    | 'app:maximize'
    | 'app:close'
    | 'app:set-fullscreen'
    | 'app:ready-to-show'
    | 'app:open-external'
    | 'app:generate-crash-report'
    | 'dialog:save-kit'
    | 'dialog:load-kit'
    | 'dialog:save-audio'
    | 'dialog:open-sample'
    | 'dialog:save-session'
    | 'fs:save-file'
    | 'fs:read-file'
    | 'fs:consent-file'
    | 'fs:show-item-in-folder'
    | 'fs:append-log'
    | 'fs:get-log-path'
    | 'sonetra:get-cached-transition'
    | 'sonetra:precompute-transition'
    | 'sonetra:restart-status'
    | 'db:upsert-track'
    | 'db:get-track'
    | 'db:search-tracks'
    | 'db:get-all-tracks';

export {};
