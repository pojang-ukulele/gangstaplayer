const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// Sonetra Bridge - optional, won't crash app if it fails
let sonetraBridge = null;
try {
    sonetraBridge = require('./sonetra-bridge');
} catch (err) {
    console.error('[Sonetra] Failed to load bridge module:', err.message);
}

// Transition cache for pre-computed transitions
const transitionCache = new Map();


// FORCE AUTOPLAY
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  const win = new BrowserWindow({
    width: 1050,
    height: 900,
    frame: false,
    backgroundColor: '#111',
    webPreferences: {
      nodeIntegration: false, // SECURITY FIX
      contextIsolation: true, // SECURITY FIX
      autoplayPolicy: 'no-user-gesture-required', // Allow boot sound
      preload: path.join(__dirname, 'preload.js'), // BRIDGE
      sandbox: false, // Necessary for some file access patterns in this simple refactor, though true is better long term.
      webSecurity: true // Re-enabling web security is good practice, but might block local resource loading if not careful. 
      // However, we are loading file:// protocol so usually fine. 
      // If users drag-drop files, webUtils/File object works.
      // For loading samples from unknown paths via kit load, we might need to bypass csp or use custom protocol.
      // For now, let's keep it simple.
    },
    autoHideMenuBar: true,
    icon: 'icon.png'
  })

  win.loadFile('index.html')

  ipcMain.on('app:minimize', () => { win.minimize() })
  ipcMain.on('app:maximize', () => { 
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  })
  ipcMain.on('app:close', () => { win.close() })
  ipcMain.on('app:set-fullscreen', (event, flag) => { win.setFullScreen(flag); })

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

  // NEW: Secure File System Handlers
  ipcMain.handle('fs:save-file', async (event, path, data) => {
    fs.writeFileSync(path, data);
    return true;
  });

  ipcMain.handle('fs:read-file', async (event, path) => {
    // Return file as base64 or buffer equivalent array to renderer?
    // Or just return text for JSON?
    // The app does two things with fs:
    // 1. loadKitDialog -> reads JSON text (utf-8)
    // 2. loadSampleFromPath -> reads Binary audio to buffer.

    // We need to differentiate. 
    // A simple way is to check extension or have two methods.
    // But looking at usage: 
    // JSON load calls readFileSync(path).
    // Audio load calls readFileSync(path) then grabs buffer.

    // I'll stick to returning the raw buffer (as Uint8Array or similar structure that Electron passes).
    const buffer = fs.readFileSync(path);
    return buffer; // Electron serialization handles Buffer <-> Uint8Array
  });

  // NEW: Recording Handlers
  ipcMain.handle('fs:ensure-recordings-dir', async () => {
    const userDataPath = app.getPath('userData');
    const recPath = path.join(userDataPath, 'recordings');
    if (!fs.existsSync(recPath)) {
      fs.mkdirSync(recPath, { recursive: true });
    }
    return recPath;
  });

  ipcMain.handle('fs:save-recording', async (event, buffer, filename) => {
    const userDataPath = app.getPath('userData');
    const recPath = path.join(userDataPath, 'recordings', filename);
    // Buffer comes as Uint8Array/ArrayBuffer from renderer
    fs.writeFileSync(recPath, Buffer.from(buffer));
    return recPath;
  });

  // NEW: Soundpack Helper
  ipcMain.handle('dialog:open-sample', async () => {
    // Determine soundpacks path (bundled vs dev)
    let resourcesPath = process.resourcesPath;
    if (!app.isPackaged) {
      resourcesPath = __dirname; // In dev, soundpacks is in root
    }
    
    // In built app: resources/soundpacks
    // In dev: ./soundpacks
    const soundpacksPath = path.join(resourcesPath, 'soundpacks');

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Audio Sample',
      defaultPath: fs.existsSync(soundpacksPath) ? soundpacksPath : undefined,
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'flac'] }]
    })
    
    if (canceled) return null
    return filePaths[0]
  });

  // ==================== SONETRA AI MIXER HANDLERS ====================
  
  // Start the Sonetra Python server
  ipcMain.handle('sonetra:start-server', async () => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    return await sonetraBridge.startServer();
  });

  // Stop the Sonetra server
  ipcMain.handle('sonetra:stop-server', async () => {
    if (!sonetraBridge) return { success: false };
    return await sonetraBridge.stopServer();
  });

  // Get server status
  ipcMain.handle('sonetra:get-status', async () => {
    if (!sonetraBridge) return { isRunning: false, error: 'Bridge not loaded' };
    return sonetraBridge.getStatus();
  });

  // Create a transition between two tracks
  ipcMain.handle('sonetra:create-transition', async (event, track1Path, track2Path, style) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    return await sonetraBridge.createTransition(track1Path, track2Path, style || 'smooth');
  });

  // Analyze a single track
  ipcMain.handle('sonetra:analyze-track', async (event, trackPath) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    return await sonetraBridge.analyzeTrack(trackPath);
  });

  // Get cached transition (for pre-computed transitions)
  ipcMain.handle('sonetra:get-cached-transition', async (event, track1Path, track2Path) => {
    const cacheKey = `${track1Path}||${track2Path}`;
    const cached = transitionCache.get(cacheKey);
    if (cached) {
      return { success: true, audioBuffer: cached };
    }
    return { success: false, error: 'No cached transition found' };
  });

  // Precompute and cache a transition (called when songs are added to playlist)
  ipcMain.handle('sonetra:precompute-transition', async (event, track1Path, track2Path) => {
    if (!sonetraBridge) return { success: false, error: 'Sonetra bridge not loaded' };
    
    const cacheKey = `${track1Path}||${track2Path}`;
    
    // Check if already cached
    if (transitionCache.has(cacheKey)) {
      return { success: true, cached: true };
    }

    // Generate the transition
    const result = await sonetraBridge.createTransition(track1Path, track2Path, 'smooth');
    
    if (result.success && result.audioBuffer) {
      // Store in cache
      transitionCache.set(cacheKey, result.audioBuffer);
      return { success: true, cached: false };
    }
    
    return result;
  });

  // Clean up Sonetra server when window closes
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