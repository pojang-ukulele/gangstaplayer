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
function validatePath(p: string): string | null {
  if (!p || typeof p !== 'string') return null;
  const normalized = path.normalize(p);
  // Prevent poisoning or illegal characters
  if (normalized.includes('\0')) return null;
  return normalized;
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
    // Try notepad first (Windows), fall back to system default
    try {
        const { execFile } = require('child_process');
        execFile('notepad.exe', [fullPath], (err: any) => {
            if (err) shell.openPath(fullPath);
        });
    } catch {
        await shell.openPath(fullPath);
    }
  });

  ipcMain.handle('dialog:save-kit', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save MPC Kit',
      defaultPath: 'MyBeatKit.json',
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    })
    if (canceled) return null
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
    return filePath
  })

  // Secure File System Handlers
  ipcMain.handle('fs:save-file', async (_event, pathStr: string, data: Uint8Array) => {
    const validated = validatePath(pathStr);
    if (!validated) {
        logToDisk('ERROR', `Security: Blocked illegal write attempt to ${pathStr}`);
        return false;
    }
    fs.writeFileSync(validated, data);
    return true;
  });

  ipcMain.handle('fs:read-file', async (_event, pathStr: string) => {
    const validated = validatePath(pathStr);
    if (!validated) {
        logToDisk('ERROR', `Security: Blocked illegal read attempt from ${pathStr}`);
        return null;
    }
    const buffer = fs.readFileSync(validated);
    return buffer;
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

  ipcMain.on('app:close', () => { 
    dbManager.close();
    win.close(); 
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
