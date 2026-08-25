import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import sonetraBridge from './sonetra-bridge';
import { getDbManager } from './db-manager';
import { logManager, LogLevel } from './log-manager';
import { MAX_FILE_SIZE_BYTES, VALID_AUDIO_EXTENSIONS } from './js/constants';

const READABLE_EXTENSIONS = new Set([...VALID_AUDIO_EXTENSIONS, 'm4a', 'aac', 'json']);

// Transition cache for pre-computed transitions (byte-budgeted)
const MAX_CACHE_ENTRIES = 50;
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const transitionCache = new Map<string, { buffer: Buffer; bytes: number }>();
let transitionCacheBytes = 0;

function addToCache(key: string, value: Buffer) {
  const bytes = value.byteLength;
  if (bytes > MAX_CACHE_BYTES) return;
  while (
    (transitionCache.size >= MAX_CACHE_ENTRIES || transitionCacheBytes + bytes > MAX_CACHE_BYTES) &&
    transitionCache.size > 0
  ) {
    const firstKey = transitionCache.keys().next().value;
    if (!firstKey) break;
    transitionCacheBytes -= transitionCache.get(firstKey)!.bytes;
    transitionCache.delete(firstKey);
  }
  transitionCache.set(key, { buffer: value, bytes });
  transitionCacheBytes += bytes;
}

/**
 * Tracks paths returned by native save dialogs so fs:save-file
 * only permits writing to user-approved locations.
 */
const dialogReturnedPaths = new Set<string>();

/**
 * Validates that a path is safe to read/write.
 * - Must be a non-empty string
 * - Must not contain null bytes
 * - Must be absolute
 * - Must not contain directory traversal (after normalization, resolved path must match)
 */
function validatePath(p: string): string | null {
  if (!p || typeof p !== 'string') return null;
  const normalized = path.normalize(p);
  if (normalized.includes('\0')) return null;
  if (!path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(normalized);
  if (resolved !== normalized) return null;
  return resolved;
}

/**
 * Returns true if the path is allowed for writing.
 * Path is allowed if it:
 *   1) Was returned by a native save dialog (user-approved), OR
 *   2) Resides under app.getPath('userData')
 */
function isSavePathAllowed(p: string): boolean {
  if (dialogReturnedPaths.has(p)) return true;
  const userDataPath = app.getPath('userData');
  const relative = path.relative(userDataPath, p);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  return false;
}

/**
 * Restricts reads to plausibly-media/kit files. Prevents a compromised
 * renderer from exfiltrating arbitrary secrets (keys, wallets, docs).
 * Legit flows only ever read: audio samples/tracks and JSON kits/sessions.
 */
function isReadPathAllowed(p: string): boolean {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  return READABLE_EXTENSIONS.has(ext);
}

function getMainWindow(): BrowserWindow | null {
  const [win] = BrowserWindow.getAllWindows();
  return win && !win.isDestroyed() ? win : null;
}

function logToDisk(level: string, message: string) {
  logManager.log(level as LogLevel, 'MAIN', message);
}

// FORCE AUTOPLAY
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Single instance: two processes would fight over SQLite WAL and the Sonetra port
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function registerIpcHandlers(): void {
  // ==================== WINDOW CONTROL HANDLERS ====================
  ipcMain.on('app:minimize', () => { getMainWindow()?.minimize(); });
  ipcMain.on('app:maximize', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('app:close', () => { getMainWindow()?.close(); });
  ipcMain.on('app:set-fullscreen', (_event, flag) => { getMainWindow()?.setFullScreen(flag); });
  ipcMain.on('app:ready-to-show', () => { getMainWindow()?.show(); });

  ipcMain.handle('app:open-external', async (_event, relativePath) => {
    // Whitelist: only the bundled README may be opened externally
    if (typeof relativePath !== 'string' || path.basename(relativePath) !== 'README.md') {
      logToDisk('ERROR', `Security: Blocked openExternal for ${relativePath}`);
      return;
    }
    const fullPath = app.isPackaged
      ? path.join(process.resourcesPath, relativePath)
      : path.join(app.getAppPath(), relativePath);
    if (!fs.existsSync(fullPath)) return;
    if (process.platform === 'win32') {
      try {
        const { execFile } = require('child_process');
        execFile('notepad.exe', [fullPath], (err: any) => {
          if (err) shell.openPath(fullPath);
        });
        return;
      } catch {
        // Fall through to shell.openPath
      }
    }
    await shell.openPath(fullPath);
  });

  ipcMain.handle('dialog:save-kit', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save MPC Kit',
      defaultPath: 'MyBeatKit.json',
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    dialogReturnedPaths.add(filePath);
    return filePath;
  });

  // Dedicated session dialog: default filename carries .session.json so the
  // renderer never has to mutate the dialog-returned path (which would
  // desync it from the write allowlist).
  ipcMain.handle('dialog:save-session', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Session',
      defaultPath: `GangstaSession_${Date.now()}.session.json`,
      filters: [{ name: 'Session File', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    dialogReturnedPaths.add(filePath);
    return filePath;
  });

  ipcMain.handle('dialog:load-kit', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load MPC Kit',
      properties: ['openFile'],
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    });
    if (canceled) return null;
    return filePaths[0];
  });

  ipcMain.handle('dialog:save-audio', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Master Recording',
      defaultPath: `Master_Rec_${Date.now()}.wav`,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
    });
    if (canceled || !filePath) return null;
    dialogReturnedPaths.add(filePath);
    return filePath;
  });

  // Secure File System Handlers
  ipcMain.handle('fs:save-file', async (_event, pathStr: string, data: Uint8Array) => {
    const validated = validatePath(pathStr);
    if (!validated) {
      logToDisk('ERROR', `Security: Blocked illegal write attempt to ${pathStr}`);
      return false;
    }
    if (!isSavePathAllowed(validated)) {
      logToDisk('ERROR', `Security: Blocked write to non-sandboxed path ${validated}`);
      return false;
    }
    if (!data || !(data instanceof Uint8Array) || data.byteLength > MAX_FILE_SIZE_BYTES) {
      logToDisk('ERROR', `Security: Blocked write with invalid or oversized payload (${data?.byteLength ?? 'n/a'} bytes)`);
      return false;
    }
    try {
      fs.writeFileSync(validated, data);
      dialogReturnedPaths.delete(validated);
      return true;
    } catch (err) {
      logToDisk('ERROR', `Security: Write failed for ${validated}: ${err}`);
      return false;
    }
  });

  ipcMain.handle('fs:read-file', async (_event, pathStr: string) => {
    const validated = validatePath(pathStr);
    if (!validated) {
      logToDisk('ERROR', `Security: Blocked illegal read attempt from ${pathStr}`);
      return null;
    }
    if (!isReadPathAllowed(validated)) {
      logToDisk('ERROR', `Security: Blocked read of non-media file ${validated}`);
      return null;
    }
    try {
      if (!fs.existsSync(validated)) {
        logToDisk('ERROR', `Security: Blocked read of non-existent path ${validated}`);
        return null;
      }
      const stat = fs.statSync(validated);
      if (!stat.isFile()) {
        logToDisk('ERROR', `Security: Blocked read of non-file path ${validated}`);
        return null;
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        logToDisk('ERROR', `Security: Blocked read of oversized file ${validated}`);
        return null;
      }
      const buffer = fs.readFileSync(validated);
      return buffer;
    } catch (err) {
      logToDisk('ERROR', `Security: Read failed for ${validated}: ${err}`);
      return null;
    }
  });

  ipcMain.handle('fs:ensure-recordings-dir', async () => {
    const userDataPath = app.getPath('userData');
    const recPath = path.join(userDataPath, 'recordings');
    if (!fs.existsSync(recPath)) {
      fs.mkdirSync(recPath, { recursive: true });
    }
    return recPath;
  });

  ipcMain.handle('fs:save-recording', async (_event, buffer: ArrayBuffer, filename: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const recPath = path.join(userDataPath, 'recordings', path.basename(filename));
      fs.writeFileSync(recPath, Buffer.from(buffer));
      return recPath;
    } catch (err) {
      logToDisk('ERROR', `Failed to save recording: ${err}`);
      return null;
    }
  });

  // Persistent Logging Handlers
  ipcMain.handle('fs:append-log', async (_event, level: string, message: string) => {
    logManager.log(level as LogLevel, 'RENDERER', message);
    return true;
  });

  ipcMain.handle('fs:get-log-path', async () => {
    return logManager.getLogPath();
  });

  ipcMain.handle('app:generate-crash-report', async (_event, stateSnapshot) => {
    return await logManager.generatePostMortem(stateSnapshot);
  });

  ipcMain.handle('dialog:open-sample', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Audio Sample',
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'flac'] }]
    });
    if (canceled) return null;
    return filePaths[0];
  });

  // ==================== SONETRA AI MIXER HANDLERS ====================

  ipcMain.handle('sonetra:start-server', async () => {
    logToDisk('INFO', 'Starting Sonetra backend server...');
    return await sonetraBridge.startServer();
  });

  ipcMain.handle('sonetra:stop-server', async () => {
    return await sonetraBridge.stopServer();
  });

  ipcMain.handle('sonetra:restart-server', async () => {
    logToDisk('INFO', 'Manual Sonetra server restart requested...');
    return await sonetraBridge.restartServer();
  });

  ipcMain.handle('sonetra:get-status', async () => {
    return sonetraBridge.getStatus();
  });

  ipcMain.handle('sonetra:create-transition', async (_event, track1Path: string, track2Path: string, style: string) => {
    return await sonetraBridge.createTransition(track1Path, track2Path, style || 'smooth');
  });

  ipcMain.handle('sonetra:analyze-track', async (_event, trackPath: string) => {
    return await sonetraBridge.analyzeTrack(trackPath);
  });

  ipcMain.handle('sonetra:get-cached-transition', async (_event, track1Path: string, track2Path: string) => {
    const cacheKey = `${track1Path}||${track2Path}`;
    const cached = transitionCache.get(cacheKey);
    if (cached) {
      return { success: true, audioBuffer: cached.buffer };
    }
    return { success: false, error: 'No cached transition found' };
  });

  ipcMain.handle('sonetra:precompute-transition', async (_event, track1Path: string, track2Path: string) => {
    const cacheKey = `${track1Path}||${track2Path}`;
    if (transitionCache.has(cacheKey)) {
      return { success: true, cached: true };
    }

    const result = await sonetraBridge.createTransition(track1Path, track2Path, 'smooth');
    if (result.success && result.audioBuffer) {
      addToCache(cacheKey, result.audioBuffer);
      return { success: true, cached: false };
    }
    return result;
  });

  // Forward bridge status events to the renderer
  sonetraBridge.onStatusChange((status) => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send('sonetra:restart-status', status);
    }
  });

  // ==================== DATABASE HANDLERS ====================

  ipcMain.handle('db:upsert-track', async (_event, track) => {
    try {
      const db = getDbManager();
      if (!db) return null;
      return db.upsertTrack(track);
    } catch (e) {
      logToDisk('ERROR', `DB Upsert failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:get-track', async (_event, trackPath) => {
    try {
      const db = getDbManager();
      if (!db) return null;
      return db.getTrackByPath(trackPath);
    } catch (e) {
      logToDisk('ERROR', `DB get-track failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:search-tracks', async (_event, query) => {
    try {
      const db = getDbManager();
      if (!db) return [];
      return db.searchTracks(query);
    } catch (e) {
      logToDisk('ERROR', `DB search failed: ${e}`);
      return [];
    }
  });

  ipcMain.handle('db:get-all-tracks', async (_event) => {
    try {
      const db = getDbManager();
      if (!db) return [];
      return db.getAllTracks();
    } catch (e) {
      logToDisk('ERROR', `DB get-all failed: ${e}`);
      return [];
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1050,
    height: 900,
    frame: false,
    backgroundColor: '#111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      webSecurity: true
    },
    autoHideMenuBar: true,
    icon: path.resolve(__dirname, 'icon.png'),
    show: false,
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('close', async () => {
    dialogReturnedPaths.clear();
    try {
      getDbManager()?.close();
    } catch (e) {
      logToDisk('ERROR', `DB close failed: ${e}`);
    }
    await sonetraBridge.stopServer();
  });

  return win;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
});

// GURU CRASH PROTECTION — registered once; report is written before exit.
process.on('uncaughtException', (error) => {
  logToDisk('ERROR', `UNCAUGHT EXCEPTION: ${error.stack || error}`);
  logManager.generatePostMortem({ type: 'CRASH_UNCAUGHT_EXCEPTION' })
    .then((report) => console.error(`GURU ERROR: Crash report generated at ${report}`))
    .catch(() => console.error('GURU ERROR: Failed to write crash report'))
    .finally(() => app.exit(1));
});
