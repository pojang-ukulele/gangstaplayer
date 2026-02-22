import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  close: () => ipcRenderer.send('app:close'),
  saveKit: () => ipcRenderer.invoke('dialog:save-kit'),
  loadKit: () => ipcRenderer.invoke('dialog:load-kit'),
  saveAudioDialog: () => ipcRenderer.invoke('dialog:save-audio'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  setFullScreen: (flag: boolean) => ipcRenderer.send('app:set-fullscreen', flag),
  openSampleDialog: () => ipcRenderer.invoke('dialog:open-sample'),
  appReadyToShow: () => ipcRenderer.send('app:ready-to-show'),
  openExternal: (path: string) => ipcRenderer.invoke('app:open-external', path)
});

contextBridge.exposeInMainWorld('fileSystem', {
  saveFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('fs:save-file', path, data),
  readFile: (path: string) => ipcRenderer.invoke('fs:read-file', path),
  ensureRecordingsDir: () => ipcRenderer.invoke('fs:ensure-recordings-dir'),
  saveRecording: (buffer: ArrayBuffer, filename: string) => ipcRenderer.invoke('fs:save-recording', buffer, filename)
});

// Sonetra AI Mixer Bridge
contextBridge.exposeInMainWorld('sonetra', {
  startServer: () => ipcRenderer.invoke('sonetra:start-server'),
  stopServer: () => ipcRenderer.invoke('sonetra:stop-server'),
  getStatus: () => ipcRenderer.invoke('sonetra:get-status'),
  createTransition: (track1Path: string, track2Path: string, style: string) => 
    ipcRenderer.invoke('sonetra:create-transition', track1Path, track2Path, style),
  analyzeTrack: (trackPath: string) => ipcRenderer.invoke('sonetra:analyze-track', trackPath),
  // For pre-computed transitions cache
  getCachedTransition: (track1Path: string, track2Path: string) => 
    ipcRenderer.invoke('sonetra:get-cached-transition', track1Path, track2Path),
  precomputeTransition: (track1Path: string, track2Path: string) =>
    ipcRenderer.invoke('sonetra:precompute-transition', track1Path, track2Path)
});
