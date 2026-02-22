import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import sonetraBridge from './sonetra-bridge';

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
    await shell.openPath(fullPath);
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
    if (!pathStr || typeof pathStr !== 'string') return false;
    const normalized = path.normalize(pathStr);
    fs.writeFileSync(normalized, data);
    return true;
  });

  ipcMain.handle('fs:read-file', async (_event, pathStr: string) => {
    if (!pathStr || typeof pathStr !== 'string') return null;
    const normalized = path.normalize(pathStr);
    const buffer = fs.readFileSync(normalized);
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
    const recPath = path.join(userDataPath, 'recordings', filename);
    fs.writeFileSync(recPath, Buffer.from(buffer));
    return recPath;
  });

  // Persistent Logging Handlers
  ipcMain.handle('fs:append-log', async (_event, level: string, message: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const logPath = path.join(userDataPath, 'gangsta_log.txt');
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
      fs.appendFileSync(logPath, logEntry);
      return true;
    } catch (e) {
      console.error('Failed to write log', e);
      return false;
    }
  });

  ipcMain.handle('fs:get-log-path', async () => {
    return path.join(app.getPath('userData'), 'gangsta_log.txt');
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
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
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

  win.on('close', async () => {
    if (sonetraBridge) {
      await sonetraBridge.stopServer();
    }
  });
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
