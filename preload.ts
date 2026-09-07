import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  close: () => ipcRenderer.send('app:close'),
  saveKit: () => ipcRenderer.invoke('dialog:save-kit'),
  saveSessionDialog: () => ipcRenderer.invoke('dialog:save-session'),
  loadKit: () => ipcRenderer.invoke('dialog:load-kit'),
  saveAudioDialog: () => ipcRenderer.invoke('dialog:save-audio'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  setFullScreen: (flag: boolean) => ipcRenderer.send('app:set-fullscreen', flag),
  openSampleDialog: () => ipcRenderer.invoke('dialog:open-sample'),
  appReadyToShow: () => ipcRenderer.send('app:ready-to-show'),
  openExternal: (path: string) => ipcRenderer.invoke('app:open-external', path),
  generateCrashReport: (state: any) => ipcRenderer.invoke('app:generate-crash-report', state)
});

contextBridge.exposeInMainWorld('fileSystem', {
  saveFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('fs:save-file', path, data),
  readFile: (path: string) => ipcRenderer.invoke('fs:read-file', path),
  ensureRecordingsDir: () => ipcRenderer.invoke('fs:ensure-recordings-dir'),
  saveRecording: (buffer: ArrayBuffer, filename: string) => ipcRenderer.invoke('fs:save-recording', buffer, filename),
  showItemInFolder: (path: string) => ipcRenderer.invoke('fs:show-item-in-folder', path),
  appendLog: (level: string, message: string) => ipcRenderer.invoke('fs:append-log', level, message),
  getLogPath: () => ipcRenderer.invoke('fs:get-log-path')
});

// Sonetra AI Mixer Bridge
contextBridge.exposeInMainWorld('sonetra', {
  startServer: () => ipcRenderer.invoke('sonetra:start-server'),
  stopServer: () => ipcRenderer.invoke('sonetra:stop-server'),
  restartServer: () => ipcRenderer.invoke('sonetra:restart-server'),
  getStatus: () => ipcRenderer.invoke('sonetra:get-status'),
  createTransition: (track1Path: string, track2Path: string, style: string) => 
    ipcRenderer.invoke('sonetra:create-transition', track1Path, track2Path, style),
  analyzeTrack: (trackPath: string) => ipcRenderer.invoke('sonetra:analyze-track', trackPath),
  // For pre-computed transitions cache
  getCachedTransition: (track1Path: string, track2Path: string) => 
    ipcRenderer.invoke('sonetra:get-cached-transition', track1Path, track2Path),
  precomputeTransition: (track1Path: string, track2Path: string) =>
    ipcRenderer.invoke('sonetra:precompute-transition', track1Path, track2Path),
  // Listen for restart/status events from main process.
  // Returns an unsubscribe function so callers don't leak listeners.
  onRestartStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('sonetra:restart-status', handler);
    return () => {
      ipcRenderer.removeListener('sonetra:restart-status', handler);
    };
  }
});
// Database Bridge
contextBridge.exposeInMainWorld('database', {
  upsertTrack: (track: any) => ipcRenderer.invoke('db:upsert-track', track),
  getTrack: (path: string) => ipcRenderer.invoke('db:get-track', path),
  searchTracks: (query: string) => ipcRenderer.invoke('db:search-tracks', query),
  getAllTracks: () => ipcRenderer.invoke('db:get-all-tracks')
});
