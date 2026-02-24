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
}

// === Global Window Augmentation ===
declare global {
    interface Window {
        electronAPI: ElectronAPI;
        fileSystem: FileSystemAPI;
    }
}

export {};
