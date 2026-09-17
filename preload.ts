import { contextBridge, ipcRenderer, webUtils } from 'electron';

const MAX_PATH_LEN = 32760;
const MAX_IPC_BYTES = 100 * 1024 * 1024;
const MAX_CRASH_SNAPSHOT_BYTES = 256 * 1024;
const MAX_LOG_MESSAGE = 2000;
const MAX_SEARCH_QUERY = 256;

function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH_LEN) return null;
  return p;
}

function cleanData(d: unknown): Uint8Array | null {
  if (!(d instanceof Uint8Array)) return null;
  if (d.byteLength === 0 || d.byteLength > MAX_IPC_BYTES) return null;
  return d;
}

function cleanPcmKey(k: unknown): string | null {
  if (typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) return null;
  return k;
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('app:minimize'),
  maximize: () => ipcRenderer.send('app:maximize'),
  close: () => ipcRenderer.send('app:close'),
  saveKit: () => ipcRenderer.invoke('dialog:save-kit'),
  saveSessionDialog: () => ipcRenderer.invoke('dialog:save-session'),
  loadKit: () => ipcRenderer.invoke('dialog:load-kit'),
  saveAudioDialog: () => ipcRenderer.invoke('dialog:save-audio'),
  // Bounded path disclosure: only for user-picked File objects from
  // dialog/DnD (Electron File with a real disk path). Never call with
  // renderer-crafted strings — returns '' for anything else so the bridge
  // cannot be used as an unbounded path oracle.
  getPathForFile: (file: File) => {
    try {
      if (!file || typeof file !== 'object') return '';
      // Must look like a user-picked File (name + size + Electron path).
      const f = file as File & { path?: unknown };
      if (typeof f.name !== 'string' || !f.name) return '';
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  setFullScreen: (flag: boolean) => ipcRenderer.send('app:set-fullscreen', flag),
  openSampleDialog: () => ipcRenderer.invoke('dialog:open-sample'),
  appReadyToShow: () => ipcRenderer.send('app:ready-to-show'),
  openExternal: (path: string) => {
    if (path !== 'README.md') return Promise.resolve();
    return ipcRenderer.invoke('app:open-external', path);
  },
  generateCrashReport: (state: any) => {
    // Pre-clone cap: main's check runs AFTER structured-clone, so an
    // unbounded object OOMs before it is ever measured. Estimate here.
    try {
      const s = JSON.stringify(state ?? {});
      if (s.length > MAX_CRASH_SNAPSHOT_BYTES) return Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke('app:generate-crash-report', state);
  }
});

contextBridge.exposeInMainWorld('fileSystem', {
  saveFile: (path: string, data: Uint8Array) => {
    const p = cleanPath(path);
    const d = cleanData(data);
    if (!p || !d) return Promise.resolve(false);
    return ipcRenderer.invoke('fs:save-file', p, d);
  },
  readFile: (path: string) => {
    const p = cleanPath(path);
    if (!p) return Promise.resolve(null);
    return ipcRenderer.invoke('fs:read-file', p);
  },
  statFile: (path: string) => {
    const p = cleanPath(path);
    if (!p) return Promise.resolve(null);
    return ipcRenderer.invoke('fs:stat-file', p);
  },
  consentFile: (path: string) => {
    const p = cleanPath(path);
    if (!p) return Promise.resolve(false);
    return ipcRenderer.invoke('fs:consent-file', p);
  },
  showItemInFolder: (path: string) => {
    const p = cleanPath(path);
    if (!p) return Promise.resolve(false);
    return ipcRenderer.invoke('fs:show-item-in-folder', p);
  },
  appendLog: (level: string, message: string) => {
    const lvl = typeof level === 'string' ? level.slice(0, 16) : 'INFO';
    const msg = typeof message === 'string' ? message.slice(0, MAX_LOG_MESSAGE) : String(message ?? '').slice(0, MAX_LOG_MESSAGE);
    return ipcRenderer.invoke('fs:append-log', lvl, msg);
  },
  getLogPath: () => ipcRenderer.invoke('fs:get-log-path')
});

// Sonetra AI Mixer Bridge (only live handlers are exposed — H4)
contextBridge.exposeInMainWorld('sonetra', {
  // For pre-computed transitions cache
  getCachedTransition: (track1Path: string, track2Path: string) => {
    const a = cleanPath(track1Path);
    const b = cleanPath(track2Path);
    if (!a || !b) return Promise.resolve({ success: false, error: 'Bad paths' });
    return ipcRenderer.invoke('sonetra:get-cached-transition', a, b);
  },
  precomputeTransition: (track1Path: string, track2Path: string) => {
    const a = cleanPath(track1Path);
    const b = cleanPath(track2Path);
    if (!a || !b) return Promise.resolve({ success: false, error: 'Bad paths' });
    return ipcRenderer.invoke('sonetra:precompute-transition', a, b);
  },
  // Listen for restart/status events from main process.
  // Returns an unsubscribe function so callers don't leak listeners.
  onRestartStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => {
      try { callback(status); } catch { /* never let renderer callback break IPC */ }
    };
    ipcRenderer.on('sonetra:restart-status', handler);
    return () => {
      ipcRenderer.removeListener('sonetra:restart-status', handler);
    };
  }
});
// Persistent decoded-audio (PCM) disk cache (narrow IPC: hex key + ≤100MB data)
contextBridge.exposeInMainWorld('pcmCache', {
  get: (key: string) => {
    const k = cleanPcmKey(key);
    if (!k) return Promise.resolve(null);
    return ipcRenderer.invoke('pcmcache:get', k);
  },
  put: (key: string, data: Uint8Array) => {
    const k = cleanPcmKey(key);
    const d = cleanData(data);
    if (!k || !d) return Promise.resolve(false);
    return ipcRenderer.invoke('pcmcache:put', k, d);
  }
});
// Database Bridge
contextBridge.exposeInMainWorld('database', {
  upsertTrack: (track: any) => {
    try {
      const s = JSON.stringify(track ?? {});
      if (s.length > 512 * 1024) return Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke('db:upsert-track', track);
  },
  getTrack: (path: string) => {
    const p = cleanPath(path);
    if (!p) return Promise.resolve(null);
    return ipcRenderer.invoke('db:get-track', p);
  },
  searchTracks: (query: string) => {
    const q = typeof query === 'string' ? query.slice(0, MAX_SEARCH_QUERY) : '';
    return ipcRenderer.invoke('db:search-tracks', q);
  },
  getAllTracks: () => ipcRenderer.invoke('db:get-all-tracks')
});
