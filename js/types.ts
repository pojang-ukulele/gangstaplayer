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
    saveKit(): Promise<string | undefined>;
    saveSessionDialog(): Promise<string | undefined>;
    loadKit(): Promise<string | undefined>;
    getPathForFile(file: File): string;
    saveAudioDialog(): Promise<string | undefined>;
    openSampleDialog(): Promise<string | undefined>;
    generateCrashReport(snapshot: any): Promise<string>;
}

export interface FileSystemAPI {
    readFile(filePath: string): Promise<Uint8Array>;
    saveFile(filePath: string, data: Uint8Array): Promise<boolean>;
    saveRecording(fileName: string, data: ArrayBuffer): Promise<string>;
    appendLog(level: string, message: string): Promise<void>;
    getLogPath(): Promise<string>;
    ensureRecordingsDir(): Promise<void>;
}

export interface SonetraAPI {
    startServer(): Promise<{ success: boolean; error?: string }>;
    stopServer(): Promise<{ success: boolean }>;
    restartServer(): Promise<{ success: boolean; error?: string }>;
    getStatus(): Promise<{ isRunning: boolean; port?: number; sonetraPath?: string; error?: string }>;
    createTransition(track1Path: string, track2Path: string, style: string): Promise<{ success: boolean; audioBuffer?: any; error?: string }>;
    analyzeTrack(trackPath: string): Promise<any>;
    getCachedTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; audioBuffer?: any; error?: string }>;
    precomputeTransition(track1Path: string, track2Path: string): Promise<{ success: boolean; cached?: boolean; error?: string }>;
    onRestartStatus(callback: (isRunning: boolean) => void): () => void;
}

export interface DatabaseAPI {
    upsertTrack(track: any): Promise<any>;
    getTrack(path: string): Promise<any>;
    searchTracks(query: string): Promise<any[]>;
    getAllTracks(): Promise<any[]>;
}

// === Global Window Augmentation ===
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
    | 'fs:ensure-recordings-dir'
    | 'fs:save-recording'
    | 'fs:append-log'
    | 'fs:get-log-path'
    | 'sonetra:start-server'
    | 'sonetra:stop-server'
    | 'sonetra:restart-server'
    | 'sonetra:get-status'
    | 'sonetra:create-transition'
    | 'sonetra:analyze-track'
    | 'sonetra:get-cached-transition'
    | 'sonetra:precompute-transition'
    | 'db:upsert-track'
    | 'db:get-track'
    | 'db:search-tracks'
    | 'db:get-all-tracks'
    | 'dialog:save-session';

export {};
