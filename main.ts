import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import sonetraBridge from './sonetra-bridge';
import { dbManager } from './db-manager';
import { logManager, LogLevel } from './log-manager';

// Transition cache for pre-computed transitions
const MAX_CACHE_SIZE = 50;
const transitionCache = new Map<string, any>();

function addToCache(key: string, value: any) {
  if (transitionCache.size >= MAX_CACHE_SIZE) {
    const firstKey = transitionCache.keys().next().value;
    if (firstKey) transitionCache.delete(firstKey);
  }
  transitionCache.set(key, value);
}

/**
 * Validates that a path is not attempting to escape safe boundaries
 * and is a valid system path.
 */
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

function logToDisk(level: string, message: string) {
  logManager.log(level as LogLevel, 'MAIN', message);
}

// FORCE AUTOPLAY
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
    icon: 'icon.png',
    show: false, 
  });

  ipcMain.on('app:ready-to-show', () => {
    win.show();
  });

  win.loadFile('index.html');

  ipcMain.on('app:minimize', () => { win.minimize(); });
  ipcMain.on('app:maximize', () => { 
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on('app:close', () => { win.close(); });
  ipcMain.on('app:set-fullscreen', (_event, flag) => { win.setFullScreen(flag); })
  
  ipcMain.handle('app:open-external', async (_event, relativePath) => {
    let fullPath: string;
    if (app.isPackaged) {
        fullPath = path.join(process.resourcesPath, relativePath);
    } else {
        fullPath = path.join(app.getAppPath(), relativePath);
    }
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
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save MPC Kit',
      defaultPath: 'MyBeatKit.json',
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    })
    if (canceled) return null
    dialogReturnedPaths.add(filePath);
    return filePath
  })

  ipcMain.handle('dialog:load-kit', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load MPC Kit',
      properties: ['openFile'],
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    })
    if (canceled) return null
    return filePaths[0]
  })

  ipcMain.handle('dialog:save-audio', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Master Recording',
      defaultPath: `Master_Rec_${Date.now()}.wav`,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
    })
    if (canceled) return null
    dialogReturnedPaths.add(filePath);
    return filePath
  })

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
    const userDataPath = app.getPath('userData');
    const safeFilename = path.basename(filename);
    const recPath = path.join(userDataPath, 'recordings', safeFilename);
    fs.writeFileSync(recPath, Buffer.from(buffer));
    return recPath;
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
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Audio Sample',
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'flac'] }]
    })
    
    if (canceled) return null
    return filePaths[0]
  });

  // ==================== SONETRA AI MIXER HANDLERS ====================
  
  ipcMain.handle('sonetra:start-server', async () => {
    if (!sonetraBridge) {
        logToDisk('ERROR', 'Sonetra bridge failure: Module not found');
        return { success: false, error: 'Sonetra bridge not loaded' };
    }
    logToDisk('INFO', 'Starting Sonetra backend server...');
    return await sonetraBridge.startServer();
  });

  ipcMain.handle('sonetra:stop-server', async () => {
    if (!sonetraBridge) return { success: false };
    return await sonetraBridge.stopServer();
  });

  ipcMain.handle('sonetra:restart-server', async () => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    logToDisk('INFO', 'Manual Sonetra server restart requested...');
    return await sonetraBridge.restartServer();
  });

  ipcMain.handle('sonetra:get-status', async () => {
    if (!sonetraBridge) return { isRunning: false, error: 'Bridge not loaded' };
    return sonetraBridge.getStatus();
  });

  ipcMain.handle('sonetra:create-transition', async (_event, track1Path: string, track2Path: string, style: string) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    return await sonetraBridge.createTransition(track1Path, track2Path, style || 'smooth');
  });

  ipcMain.handle('sonetra:analyze-track', async (_event, trackPath: string) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    return await sonetraBridge.analyzeTrack(trackPath);
  });

  ipcMain.handle('sonetra:get-cached-transition', async (_event, track1Path: string, track2Path: string) => {
    const cacheKey = `${track1Path}||${track2Path}`;
    const cached = transitionCache.get(cacheKey);
    if (cached) {
      return { success: true, audioBuffer: cached };
    }
    return { success: false, error: 'No cached transition found' };
  });

  ipcMain.handle('sonetra:precompute-transition', async (_event, track1Path: string, track2Path: string) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    
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

  // Wire up sonetraBridge status events to forward to renderer
  sonetraBridge.onStatusChange((status) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sonetra:restart-status', status);
    }
  });

  // ==================== DATABASE HANDLERS ====================
  
  ipcMain.handle('db:upsert-track', async (_event, track) => {
    try {
      return dbManager.upsertTrack(track);
    } catch (e) {
      logToDisk('ERROR', `DB Upsert failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:get-track', async (_event, path) => {
    return dbManager.getTrackByPath(path);
  });

  ipcMain.handle('db:search-tracks', async (_event, query) => {
    return dbManager.searchTracks(query);
  });

  ipcMain.handle('db:get-all-tracks', async (_event) => {
    return dbManager.getAllTracks();
  });

  win.on('close', async () => {
    dbManager.close();
    if (sonetraBridge) {
      await sonetraBridge.stopServer();
    }
  });

  // GURU CRASH PROTECTION
  process.on('uncaughtException', async (error) => {
    logToDisk('ERROR', `UNCAUGHT EXCEPTION: ${error.stack || error}`);
    const report = await logManager.generatePostMortem({ type: 'CRASH_UNCAUGHT_EXCEPTION' });
    console.error(`GURU ERROR: Crash report generated at ${report}`);
    app.exit(1);
  });
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
