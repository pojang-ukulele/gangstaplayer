/**
 * Shared Type Definitions for Gangsta Player Pro 3
 * Single source of truth for IPC contracts and global augmentations.
 */

// === Electron IPC API ===
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
    getPathForFile(file: File): string;
    saveAudioDialog(): Promise<string | null | undefined>;
    openSampleDialog(): Promise<string | null | undefined>;
    generateCrashReport(snapshot: any): Promise<string | null | undefined>;
}

export interface FileSystemAPI {
    readFile(filePath: string): Promise<Uint8Array | null>;
    consentFile(filePath: string): Promise<boolean>;
    saveFile(filePath: string, data: Uint8Array): Promise<boolean>;
    showItemInFolder(filePath: string): Promise<boolean>;
    appendLog(level: string, message: string): Promise<void>;
    getLogPath(): Promise<string>;
}

export interface SonetraAPI {
    getCachedTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; audioBuffer?: any; error?: string }>;
    precomputeTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; cached?: boolean; error?: string }>;
    onRestartStatus(callback: (status: unknown) => void): () => void;
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
    | 'fs:save-file'
    | 'fs:read-file'
    | 'fs:consent-file'
    | 'fs:show-item-in-folder'
    | 'fs:append-log'
    | 'fs:get-log-path'
    | 'sonetra:get-cached-transition'
    | 'sonetra:precompute-transition'
    | 'db:upsert-track'
    | 'db:get-track'
    | 'db:search-tracks'
    | 'db:get-all-tracks'
    | 'dialog:save-session'
    | 'sonetra:restart-status';

export {};
