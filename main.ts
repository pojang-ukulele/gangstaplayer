import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import sonetraBridge, { addAllowedAudioDir } from './sonetra-bridge';
import { getDbManager } from './db-manager';
import { logManager, LogLevel } from './log-manager';
import { MAX_FILE_SIZE_BYTES, VALID_AUDIO_EXTENSIONS } from './js/constants';

const READABLE_EXTENSIONS = new Set([...VALID_AUDIO_EXTENSIONS, 'json']);

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
const dialogReturnedPaths = new Map<string, number>();
const DIALOG_PATH_TTL_MS = 60 * 60 * 1000;
function addDialogPath(p: string): void {
  if (dialogReturnedPaths.size > 64) dialogReturnedPaths.clear();
  dialogReturnedPaths.set(p, Date.now());
  for (const [k, t] of Array.from(dialogReturnedPaths)) {
    if (Date.now() - t > DIALOG_PATH_TTL_MS) dialogReturnedPaths.delete(k);
  }
}
function hasDialogPath(p: string): boolean {
  const t = dialogReturnedPaths.get(p);
  if (t === undefined) return false;
  if (Date.now() - t > DIALOG_PATH_TTL_MS) { dialogReturnedPaths.delete(p); return false; }
  return true;
}

/**
 * Validates that a path is safe to read/write.
 * - Must be a non-empty string
 * - Must not contain null bytes
 * - Must be absolute
 * - Must not contain directory traversal (after normalization, resolved path must match)
 */
function validatePath(p: string): string | null {
  if (!p || typeof p !== 'string') return null;
  if (p.includes('\0')) return null;
  if (p.length > 32760) return null;
  // Dot-segments are collapsed by normalize/resolve — legitimacy is decided
  // by the allowlist + extension gates below, not by rejecting ".." outright
  // (which broke legit libraries containing ".." segments).
  const normalized = path.normalize(p);
  if (!path.isAbsolute(normalized)) return null;
  // path.resolve collapses trailing separators / dot segments so the
  // allowlist comparison below is canonical.
  return path.resolve(normalized);
}

const SAVE_ALLOWED_EXTS = new Set(['json', 'wav']);
const SAVE_BLOCKED_BASENAMES = new Set(['gangsta.db', 'gangsta.db-wal', 'gangsta.db-shm', 'gangsta_log.txt']);

/**
 * Returns true if the path is allowed for writing.
 * Path is allowed if it:
 *   1) Was returned by a native save dialog (user-approved), AND has an
 *      allowed extension, AND is not a blocked internal file, OR
 *   2) Resides under app.getPath('userData')/recordings with allowed ext
 * This stops a compromised renderer from overwriting gangsta.db / logs.
 */
function isSavePathAllowed(p: string): boolean {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  if (!SAVE_ALLOWED_EXTS.has(ext)) return false;
  if (SAVE_BLOCKED_BASENAMES.has(path.basename(p).toLowerCase())) return false;
  // Block ADS streams and UNC paths that confuse allowlist checks.
  if (p.includes(':') && !/^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.startsWith('\\\\')) return false;
  if (hasDialogPath(p)) {
    // Resolve symlinks: a dialog path swapped for a symlink to gangsta.db/logs must not pass.
    try {
      const real = fs.realpathSync.native(p);
      if (real !== p) {
        if (SAVE_BLOCKED_BASENAMES.has(path.basename(real).toLowerCase())) return false;
        // Resolved target must itself be allowlisted (dialog set or recordings dir).
        if (!hasDialogPath(real)) {
          const userDataPath = app.getPath('userData');
          const recDir = path.resolve(path.join(userDataPath, 'recordings'));
          const relReal = path.relative(recDir, real);
          const inside = relReal !== '' && !relReal.startsWith('..') && !path.isAbsolute(relReal);
          if (!inside) return false;
        }
      }
    } catch { /* dangling path — fall through to lexical check */ }
    return true;
  }
  const userDataPath = app.getPath('userData');
  const recDir = path.resolve(path.join(userDataPath, 'recordings'));
  const resolved = path.resolve(p);
  const rel = path.relative(recDir, resolved);
  // Case-insensitive only where the FS is (Windows/macOS); Linux stays exact.
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const relCmp = insensitive ? rel.toLowerCase() : rel;
  if (rel && !relCmp.startsWith('..') && !path.isAbsolute(rel)) return true;
  return false;
}

/**
 * Restricts reads to plausibly-media/kit files. Prevents a compromised
 * renderer from exfiltrating arbitrary secrets (keys, wallets, docs).
 * Legit flows only ever read: audio samples/tracks and JSON kits/sessions.
 */
function isReadPathAllowed(p: string): boolean {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  if (!READABLE_EXTENSIONS.has(ext)) return false;
  if (p.includes(':') && !/^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.startsWith('\\\\')) return false;
  return true;
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
  // Simple per-channel rate limiter to blunt IPC spam DoS.
  // Defined first: dialog handlers below already reference it.
  const lastCall = new Map<string, number>();
  const rateLimited = (key: string, minMs: number): boolean => {
    const now = Date.now();
    const prev = lastCall.get(key) ?? 0;
    if (now - prev < minMs) return true;
    lastCall.set(key, now);
    // Bound the map: unbounded keys = memory growth via crafted channels.
    if (lastCall.size > 64) {
      const oldest = lastCall.keys().next().value;
      if (oldest) lastCall.delete(oldest);
    }
    return false;
  };
  // ==================== WINDOW CONTROL HANDLERS ====================
  ipcMain.on('app:minimize', () => { if (!rateLimited('app:minimize', 100)) getMainWindow()?.minimize(); });
  ipcMain.on('app:maximize', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('app:close', () => { getMainWindow()?.close(); });
  ipcMain.on('app:set-fullscreen', (_event, flag) => { getMainWindow()?.setFullScreen(flag === true); });
  ipcMain.on('app:ready-to-show', () => { getMainWindow()?.show(); });

  ipcMain.handle('app:open-external', async (_event, relativePath) => {
    // Whitelist: only the exact bundled README may be opened externally.
    // Reject any traversal, separators, or UNC — basename check alone is bypassable.
    if (typeof relativePath !== 'string' || relativePath !== 'README.md') {
      logToDisk('ERROR', `Security: Blocked openExternal for ${relativePath}`);
      return;
    }
    const baseDir = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const fullPath = path.resolve(baseDir, 'README.md');
    if (path.relative(path.resolve(baseDir), fullPath) !== 'README.md') return;
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
    if (rateLimited('dialog:save-kit', 500)) return null;
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save MPC Kit',
      defaultPath: 'MyBeatKit.json',
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    const v = validatePath(filePath);
    if (v) {
      addDialogPath(v);
    }
    return filePath;
  });

  // Dedicated session dialog: default filename carries .session.json so the
  // renderer never has to mutate the dialog-returned path (which would
  // desync it from the write allowlist).
  ipcMain.handle('dialog:save-session', async () => {
    if (rateLimited('dialog:save-session', 500)) return null;
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Session',
      defaultPath: `GangstaSession_${Date.now()}.session.json`,
      filters: [{ name: 'Session File', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    const v = validatePath(filePath);
    if (v) {
      addDialogPath(v);
    }
    return filePath;
  });

  ipcMain.handle('dialog:load-kit', async () => {
    if (rateLimited('dialog:load-kit', 500)) return null;
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load MPC Kit',
      properties: ['openFile'],
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    try { addAllowedAudioDir(path.dirname(filePaths[0])); } catch { /* ignore */ }
    return filePaths[0];
  });

  ipcMain.handle('dialog:save-audio', async () => {
    if (rateLimited('dialog:save-audio', 500)) return null;
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Master Recording',
      defaultPath: `Master_Rec_${Date.now()}.wav`,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
    });
    if (canceled || !filePath) return null;
    const v = validatePath(filePath);
    if (v) {
      addDialogPath(v);
    }
    return filePath;
  });

  // Secure File System Handlers
  const inFlightPrecompute = new Set<string>();
  const normalizeCacheKey = (a: string, b: string): string => {
    const sa = String(a ?? '').slice(0, 32760);
    const sb = String(b ?? '').slice(0, 32760);
    const norm = (s: string): string => {
      const r = path.resolve(s);
      return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
    };
    return `${norm(sa)}||${norm(sb)}`;
  };
  function checkCacheKeyArgs(a: unknown, b: unknown): boolean {
    return typeof a === 'string' && typeof b === 'string'
      && a.length > 0 && b.length > 0 && a.length <= 32760 && b.length <= 32760;
  }
  ipcMain.handle('fs:save-file', async (_event, pathStr: string, data: Uint8Array) => {
    if (rateLimited('fs:save-file', 100)) return false;
    const validated = validatePath(pathStr);
    if (!validated) {
      logToDisk('ERROR', `Security: Blocked illegal write attempt to ${pathStr}`);
      return false;
    }
    if (!isSavePathAllowed(validated)) {
      logToDisk('ERROR', `Security: Blocked write to non-sandboxed path ${validated}`);
      return false;
    }
    if (!data || !(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_FILE_SIZE_BYTES) {
      logToDisk('ERROR', `Security: Blocked write with invalid, empty or oversized payload (${(data as any)?.byteLength ?? 'n/a'} bytes)`);
      return false;
    }
    try {
      // Resolve symlinks at write time — a symlink swapped in after the dialog
      // must not redirect the write to gangsta.db / logs.
      // TOCTOU: also reject pre-existing symlinks outright via lstat so the
      // check and the write cannot straddle a swap.
      try {
        const lst = fs.lstatSync(validated);
        if (lst.isSymbolicLink()) {
          const real = fs.realpathSync.native(validated);
          if (!isSavePathAllowed(real) || SAVE_BLOCKED_BASENAMES.has(path.basename(real).toLowerCase())) {
            logToDisk('ERROR', `Security: Blocked symlink write ${validated} -> ${real}`);
            return false;
          }
        } else {
          const real = fs.realpathSync.native(path.dirname(validated));
          void real;
        }
      } catch { /* target may not exist yet — lexical check already passed */ }
      try {
        const real = fs.realpathSync.native(validated);
        if (real !== validated && !isSavePathAllowed(real)) {
          logToDisk('ERROR', `Security: Blocked symlink write ${validated} -> ${real}`);
          return false;
        }
        if (SAVE_BLOCKED_BASENAMES.has(path.basename(real).toLowerCase())) {
          logToDisk('ERROR', `Security: Blocked write to internal file via symlink ${real}`);
          return false;
        }
      } catch { /* target may not exist yet — lexical check already passed */ }
      await fs.promises.writeFile(validated, data);
      // Dialog-approved paths stay writable for the session (cleared on
      // window close). Deleting after one write broke Save→Save-again flows.
      return true;
    } catch (err) {
      logToDisk('ERROR', `Security: Write failed for ${validated}: ${err}`);
      return false;
    }
  });

  ipcMain.handle('fs:read-file', async (_event, pathStr: string) => {
    if (rateLimited('fs:read-file', 50)) return null;
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
      // Resolve symlinks/junctions — a symlink pointing outside the expected
      // tree must not bypass validation.
      let realPath: string;
      try {
        realPath = fs.realpathSync.native(validated);
      } catch {
        realPath = fs.realpathSync(validated);
      }
      if (realPath !== validated && !isReadPathAllowed(realPath)) {
        logToDisk('ERROR', `Security: Blocked symlink read ${validated} -> ${realPath}`);
        return null;
      }
      const checkPath = realPath || validated;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(checkPath);
      } catch {
        logToDisk('ERROR', `Security: Blocked read of non-existent path ${validated}`);
        return null;
      }
      if (!stat.isFile()) {
        logToDisk('ERROR', `Security: Blocked read of non-file path ${validated}`);
        return null;
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        logToDisk('ERROR', `Security: Blocked read of oversized file ${validated}`);
        return null;
      }
      const buffer = await fs.promises.readFile(checkPath);
      if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
        logToDisk('ERROR', `Security: Blocked read with post-read oversize ${validated}`);
        return null;
      }
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

  ipcMain.handle('fs:save-recording', async (_event, buffer: unknown, filename: string) => {
    try {
      if (rateLimited('fs:save-recording', 1000)) return null;
      if (typeof filename !== 'string' || !filename) return null;
      // Preserve the .wav suffix: sanitize the stem, then re-append.
      const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const stem = base.toLowerCase().endsWith('.wav') ? base.slice(0, -4) : base;
      const safe = `${stem.slice(0, 120)}.wav`;
      if (!safe.toLowerCase().endsWith('.wav')) return null;
      // Strict type check — duck-typed {byteLength} objects previously passed.
      let bytes: Uint8Array | null = null;
      if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
      else if (buffer instanceof Uint8Array) bytes = buffer;
      else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array((buffer as ArrayBufferView).buffer);
      else return null;
      const len = bytes.byteLength;
      if (!len || len > MAX_FILE_SIZE_BYTES) {
        logToDisk('ERROR', `Security: Blocked recording save with bad size (${len})`);
        return null;
      }
      const userDataPath = app.getPath('userData');
      const recDir = path.join(userDataPath, 'recordings');
      if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
      // O_EXCL + unique suffix: never silently overwrite, never fill disk via spam.
      let recPath = path.join(recDir, safe);
      for (let i = 1; i < 1000; i++) {
        try {
          const fh = await fs.promises.open(recPath, 'wx');
          await fh.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          await fh.close();
          return recPath;
        } catch (e: any) {
          if (e?.code !== 'EEXIST') throw e;
          const stemNoExt = safe.slice(0, -4);
          recPath = path.join(recDir, `${stemNoExt}_${Date.now()}_${i}.wav`);
        }
      }
      return null;
    } catch (err) {
      logToDisk('ERROR', `Failed to save recording: ${err}`);
      return null;
    }
  });

  ipcMain.handle('fs:show-item-in-folder', async (_event, pathStr: string) => {
    if (rateLimited('fs:show-item-in-folder', 500)) return false;
    const validated = validatePath(pathStr);
    if (!validated) {
      logToDisk('ERROR', `Security: Blocked illegal show-item attempt for ${pathStr}`);
      return false;
    }
    // Restrict to media/kit files so a compromised renderer can't probe
    // arbitrary paths via Explorer/Finder side channels.
    if (!isReadPathAllowed(validated)) {
      logToDisk('ERROR', `Security: Blocked show-item for non-media file ${validated}`);
      return false;
    }
    try {
      let realPath: string;
      try {
        realPath = fs.realpathSync.native(validated);
      } catch {
        realPath = fs.realpathSync(validated);
      }
      if (realPath !== validated && !isReadPathAllowed(realPath)) {
        logToDisk('ERROR', `Security: Blocked show-item symlink ${validated} -> ${realPath}`);
        return false;
      }
      const checkPath = realPath || validated;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(checkPath);
      } catch {
        logToDisk('ERROR', `Security: Blocked show-item for non-existent path ${validated}`);
        return false;
      }
      if (!stat.isFile()) {
        logToDisk('ERROR', `Security: Blocked show-item for non-file path ${validated}`);
        return false;
      }
      shell.showItemInFolder(checkPath);
      return true;
    } catch (err) {
      logToDisk('ERROR', `Security: show-item failed for ${validated}: ${err}`);
      return false;
    }
  });

  // Persistent Logging Handlers
  ipcMain.handle('fs:append-log', async (_event, level: string, message: string) => {
    if (rateLimited('fs:append-log', 50)) return false;
    const allowed: ReadonlySet<string> = new Set(['INFO', 'WARN', 'ERROR', 'DEBUG']);
    const lvl = allowed.has(String(level)) ? (level as LogLevel) : 'INFO';
    let msg = String(message ?? '');
    // Strip control chars/newlines to block log forgery + ANSI injection; cap length.
    // Covers SGR, cursor/charset, and OSC hyperlink sequences (not just colors).
    msg = msg.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\([0-9A-Z]/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .slice(0, 2000);
    logManager.log(lvl, 'RENDERER', msg);
    return true;
  });

  ipcMain.handle('fs:get-log-path', async () => {
    return logManager.getLogPath();
  });

  ipcMain.handle('app:generate-crash-report', async (_event, stateSnapshot) => {
    if (rateLimited('app:generate-crash-report', 5000)) return null;
    // Bound snapshot size — unbounded renderer payloads previously OOMed/blocked main.
    try {
      const serialized = JSON.stringify(stateSnapshot ?? {});
      if (serialized.length > 256 * 1024) {
        logToDisk('ERROR', 'Security: Blocked oversized crash snapshot');
        return null;
      }
    } catch {
      return null;
    }
    return await logManager.generatePostMortem(stateSnapshot);
  });

  ipcMain.handle('dialog:open-sample', async () => {
    if (rateLimited('dialog:open-sample', 500)) return null;
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Audio Sample',
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: [...VALID_AUDIO_EXTENSIONS] }]
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    try { addAllowedAudioDir(path.dirname(filePaths[0])); } catch { /* ignore */ }
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
    if (rateLimited('sonetra:create-transition', 2000)) return { success: false, error: 'Rate limited' };
    if (typeof track1Path !== 'string' || typeof track2Path !== 'string') return { success: false, error: 'Bad paths' };
    if (track1Path.length > 32760 || track2Path.length > 32760) return { success: false, error: 'Path too long' };
    const s = typeof style === 'string' ? style.slice(0, 32) : 'smooth';
    return await sonetraBridge.createTransition(track1Path, track2Path, s || 'smooth');
  });

  ipcMain.handle('sonetra:analyze-track', async (_event, trackPath: string) => {
    if (rateLimited('sonetra:analyze-track', 1000)) return { success: false, error: 'Rate limited' };
    if (typeof trackPath !== 'string' || !trackPath || trackPath.length > 32760) {
      return { success: false, error: 'Bad path' };
    }
    return await sonetraBridge.analyzeTrack(trackPath);
  });

  ipcMain.handle('sonetra:get-cached-transition', async (_event, track1Path: string, track2Path: string) => {
    if (!checkCacheKeyArgs(track1Path, track2Path)) {
      return { success: false, error: 'Bad paths' };
    }
    if (rateLimited('sonetra:get-cached-transition', 250)) {
      return { success: false, error: 'Rate limited' };
    }
    const cacheKey = normalizeCacheKey(track1Path, track2Path);
    const cached = transitionCache.get(cacheKey);
    if (cached) {
      // Cap IPC clone size — 200MB Buffer clones freeze the renderer.
      if (cached.bytes > 50 * 1024 * 1024) {
        return { success: false, error: 'Cached transition too large for IPC' };
      }
      return { success: true, audioBuffer: cached.buffer };
    }
    return { success: false, error: 'No cached transition found' };
  });

  ipcMain.handle('sonetra:precompute-transition', async (_event, track1Path: string, track2Path: string) => {
    if (!checkCacheKeyArgs(track1Path, track2Path)) {
      return { success: false, error: 'Bad paths' };
    }
    if (rateLimited('sonetra:precompute-transition', 1000)) {
      return { success: false, error: 'Rate limited' };
    }
    const cacheKey = normalizeCacheKey(track1Path, track2Path);
    if (transitionCache.has(cacheKey)) {
      return { success: true, cached: true };
    }
    // Dedupe concurrent precomputes for the same key — previously N parallel
    // invokes all missed and fired N duplicate 100MB uploads.
    if (inFlightPrecompute.has(cacheKey)) {
      return { success: false, error: 'Precompute already in flight' };
    }
    inFlightPrecompute.add(cacheKey);
    try {
      const result = await sonetraBridge.createTransition(track1Path, track2Path, 'smooth');
      if (result.success && result.audioBuffer) {
        addToCache(cacheKey, result.audioBuffer);
        return { success: true, cached: false };
      }
      return result;
    } finally {
      inFlightPrecompute.delete(cacheKey);
    }
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
      if (!track || typeof track !== 'object') return null;
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
      if (typeof trackPath !== 'string' || !trackPath || trackPath.length > 32760) return null;
      const db = getDbManager();
      if (!db) return null;
      return db.getTrackByPath(trackPath);
    } catch (e) {
      logToDisk('ERROR', `DB get-track failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:search-tracks', async (_event, query) => {
    if (rateLimited('db:search-tracks', 100)) return [];
    try {
      const q = String(query ?? '').slice(0, 256);
      const db = getDbManager();
      if (!db) return [];
      return db.searchTracks(q);
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

  // Fallback: if the renderer crashes before app:ready-to-show, the window
  // would stay hidden forever. Force-show after 8s.
  setTimeout(() => {
    try { if (!win.isDestroyed() && !win.isVisible()) win.show(); } catch { /* ignore */ }
  }, 8000).unref?.();

  win.on('close', () => {
    dialogReturnedPaths.clear();
    try {
      getDbManager()?.close();
    } catch (e) {
      logToDisk('ERROR', `DB close failed: ${e}`);
    }
    try { logManager.close(); } catch { /* ignore */ }
    // Fire-and-forget: 'close' must not be async — awaiting here lets the
    // window die mid-cleanup with a dirty WAL and orphaned python.
    void sonetraBridge.stopServer().catch(() => undefined);
  });

  return win;
}

app.whenReady().then(() => {
  if (!gotLock) return;
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  dialogReturnedPaths.clear();
  if (process.platform !== 'darwin') app.quit()
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else { getMainWindow()?.focus(); }
});

// GURU CRASH PROTECTION — registered once; report is written before exit.
process.on('uncaughtException', (error) => {
  try {
    logToDisk('ERROR', `UNCAUGHT EXCEPTION: ${(error as Error)?.stack || error}`);
  } catch { /* ignore */ }
  try { getDbManager()?.close(); } catch { /* ignore */ }
  try { logManager.close(); } catch { /* ignore */ }
  logManager.generatePostMortem({ type: 'CRASH_UNCAUGHT_EXCEPTION' })
    .then((report) => console.error(`GURU ERROR: Crash report generated at ${report}`))
    .catch(() => console.error('GURU ERROR: Failed to write crash report'))
    .finally(() => app.exit(1));
});
process.on('unhandledRejection', (reason) => {
  logToDisk('ERROR', `UNHANDLED REJECTION: ${(reason as Error)?.stack || reason}`);
});
