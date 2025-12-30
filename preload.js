const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  close: () => ipcRenderer.send('app:close'),
  saveKit: () => ipcRenderer.invoke('dialog:save-kit'),
  loadKit: () => ipcRenderer.invoke('dialog:load-kit'),
  saveAudioDialog: () => ipcRenderer.invoke('dialog:save-audio'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  setFullScreen: (flag) => ipcRenderer.send('app:set-fullscreen', flag),
  openSampleDialog: () => ipcRenderer.invoke('dialog:open-sample'),
  appReadyToShow: () => ipcRenderer.send('app:ready-to-show')
});

// We also need to expose 'fs' functionality but securely.
// The original code used fs.readFileSync and fs.writeFileSync in the renderer.
// THIS IS DANGEROUS. 
// However, since this is a refactor without changing logic, we should move file I/O to the main process
// and expose it via invoke/handle.
// BUT, to keep it simple and match the plan, I will expose a restricted set of FS operations 
// OR better, move the logic to main.js. 
//
// Looking at the original code:
// 1. loadSampleFromPath uses fs.readFileSync
// 2. saveKit uses fs.writeFileSync
// 3. loadKitDialog uses fs.readFileSync
//
// I will create specific IPC handlers for these in main.js and expose them here.

contextBridge.exposeInMainWorld('fileSystem', {
  saveFile: (path, data) => ipcRenderer.invoke('fs:save-file', path, data),
  readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  ensureRecordingsDir: () => ipcRenderer.invoke('fs:ensure-recordings-dir'),
  saveRecording: (buffer, filename) => ipcRenderer.invoke('fs:save-recording', buffer, filename)
});

// Sonetra AI Mixer Bridge
contextBridge.exposeInMainWorld('sonetra', {
  startServer: () => ipcRenderer.invoke('sonetra:start-server'),
  stopServer: () => ipcRenderer.invoke('sonetra:stop-server'),
  getStatus: () => ipcRenderer.invoke('sonetra:get-status'),
  createTransition: (track1Path, track2Path, style) => 
    ipcRenderer.invoke('sonetra:create-transition', track1Path, track2Path, style),
  analyzeTrack: (trackPath) => ipcRenderer.invoke('sonetra:analyze-track', trackPath),
  // For pre-computed transitions cache
  getCachedTransition: (track1Path, track2Path) => 
    ipcRenderer.invoke('sonetra:get-cached-transition', track1Path, track2Path),
  precomputeTransition: (track1Path, track2Path) =>
    ipcRenderer.invoke('sonetra:precompute-transition', track1Path, track2Path)
});
