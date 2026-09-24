import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

import { getDbManager, initDbManager, addAllowedAudioFile, isAllowedAudioDirForPath, isAllowedAudioFile, loadAllowedAudioFiles } from './db-manager';
import { logManager, LogLevel } from './log-manager';
import { MAX_FILE_SIZE_BYTES, MAX_PLAYLIST_SEARCH_RESULTS, VALID_AUDIO_EXTENSIONS } from './js/constants';

const READABLE_EXTENSIONS = new Set([...VALID_AUDIO_EXTENSIONS, 'json']);

/**
 * Tracks paths returned by native save dialogs so fs:save-file
 * only permits writing to user-approved locations.
 */
const dialogReturnedPaths = new Map<string, number>();
const DIALOG_PATH_TTL_MS = 60 * 60 * 1000;
const MAX_DIALOG_PATHS = 64;
function addDialogPath(p: string): void {
  const now = Date.now();
  // Sweep expired entries first so stale paths never force out live ones.
  for (const [k, t] of Array.from(dialogReturnedPaths)) {
    if (now - t > DIALOG_PATH_TTL_MS) dialogReturnedPaths.delete(k);
  }
  // Refresh LRU position for re-approved paths.
  if (dialogReturnedPaths.has(p)) dialogReturnedPaths.delete(p);
  dialogReturnedPaths.set(p, now);
  // LRU evict oldest first — never wipe the whole allowlist (a bulk save
  // flow previously lost every prior approval at 65 entries).
  while (dialogReturnedPaths.size > MAX_DIALOG_PATHS) {
    const oldest = dialogReturnedPaths.keys().next().value;
    if (!oldest) break;
    dialogReturnedPaths.delete(oldest);
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
 * - NOTE: ".." collapse alone never proves safety — validatePath only
 *   canonicalizes; every caller must still pass the result through an
 *   allowlist gate (isSavePathAllowed / isReadPathAllowed / consent).
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

/**
 * ADS + UNC gate (Windows-safe, no flag reliance).
 * Rejects NTFS alternate-data-stream suffixes (`beat.wav:hidden`,
 * `beat.wav:$DATA` via `:$DATA`) and stream dir components
 * (`recordings:evil\beat.wav`), plus UNC (`\\server\share`, `//server/share`).
 * A drive-letter prefix does NOT exempt later colons — any colon past the
 * `C:\` prefix rejects.
 */
function isAdsOrUncPath(p: string): boolean {
  if (p.startsWith('\\\\') || p.startsWith('//')) return true;
  if (p.includes(':$DATA')) return true;
  const m = /^[a-zA-Z]:[\\/]/.exec(p);
  const rest = m ? p.slice(m[0].length) : p;
  if (rest.includes(':')) return true;
  return false;
}

const SAVE_ALLOWED_EXTS = new Set(['json', 'wav']);
// config.json is app config and gangsta.db-journal is live DB state —
// neither may ever be a save target.
const SAVE_BLOCKED_BASENAMES = new Set(['gangsta.db', 'gangsta.db-wal', 'gangsta.db-shm', 'gangsta.db-journal', 'gangsta_log.txt', 'config.json']);
/**
 * Blocked-basename check, OS-canonicalized: Windows silently strips trailing
 * dots/spaces, so `gangsta.db.` / `config.json ` open the internal file.
 * Strip them (plus case-fold) before the Set lookup.
 */
function isBlockedSaveBasename(p: string): boolean {
  return SAVE_BLOCKED_BASENAMES.has(path.basename(p).toLowerCase().replace(/[. ]+$/, ''));
}
// Non-dialog writes into userData/recordings are allowlisted to session-shaped
// names only — arbitrary recordings/*.json/*.wav overwrite without a dialog
// (e.g. clobbering another session) is rejected. Dialog-approved paths bypass
// this (first branch below).
function isSessionShapedSaveName(p: string, ext: string): boolean {
  const base = path.basename(p);
  if (ext === 'json') {
    // Dedicated session dialog emits GangstaSession_<ts>.session.json
    return base.endsWith('.session.json') && base.startsWith('GangstaSession_');
  }
  if (ext === 'wav') {
    return base.startsWith('Master_Rec_');
  }
  return false;
}

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
  if (isBlockedSaveBasename(p)) return false;
  // Block ADS streams (incl. :$DATA past the drive prefix) and UNC paths
  // that confuse allowlist checks (both \\server\share and //server/share forms).
  if (isAdsOrUncPath(p)) return false;
  if (hasDialogPath(p)) {
    // Resolve symlinks: a dialog path swapped for a symlink to gangsta.db/logs must not pass.
    try {
      const real = fs.realpathSync.native(p);
      if (real !== p) {
        if (isBlockedSaveBasename(real)) return false;
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
  let recReal = recDir;
  try { recReal = fs.realpathSync.native(recDir); } catch { /* recDir may not exist yet */ }
  const resolved = path.resolve(p);
  let resolvedReal = resolved;
  try { resolvedReal = fs.realpathSync.native(resolved); } catch { /* use lexical */ }
  const rel = path.relative(recReal, resolvedReal);
  // Case-insensitive only where the FS is (Windows/macOS); Linux stays exact.
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const relCmp = insensitive ? rel.toLowerCase() : rel;
  if (rel && !relCmp.startsWith('..') && !path.isAbsolute(rel)) {
    // Non-dialog recordings writes must be session-shaped (see above).
    if (!isSessionShapedSaveName(resolvedReal, ext)) return false;
    return true;
  }
  return false;
}

/**
 * Per-file read consent for drag-and-dropped / dialog-picked files.
 * DnD files live in arbitrary folders (Downloads/Desktop) that can never be
 * allowlisted by directory without opening drive roots — so the renderer
 * registers the EXACT dropped file via fs:consent-file and reads honor only
 * that file, never its parent directory.
 */
const consentedReadFiles = new Map<string, number>();
const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONSENTED_FILES = 256;
function canonicalReadKey(p: string): string {
  try {
    const r = path.resolve(p);
    return (process.platform === 'win32' || process.platform === 'darwin') ? r.toLowerCase() : r;
  } catch { return p; }
}
function addConsentedReadFile(p: string): boolean {
  const validated = validatePath(p);
  if (!validated) return false;
  const ext = path.extname(validated).replace('.', '').toLowerCase();
  if (!READABLE_EXTENSIONS.has(ext)) return false;
  if (isAdsOrUncPath(validated)) return false;
  try {
    let real = validated;
    try { real = fs.realpathSync.native(validated); } catch { /* use validated */ }
    const st = fs.statSync(real);
    if (!st.isFile()) return false;
    if (st.size > MAX_FILE_SIZE_BYTES) return false;
    const now = Date.now();
    for (const [k, t] of Array.from(consentedReadFiles)) {
      if (now - t > CONSENT_TTL_MS) consentedReadFiles.delete(k);
    }
    consentedReadFiles.set(canonicalReadKey(validated), now);
    const realKey = canonicalReadKey(real);
    if (realKey !== canonicalReadKey(validated)) consentedReadFiles.set(realKey, now);
    while (consentedReadFiles.size > MAX_CONSENTED_FILES) {
      const oldest = consentedReadFiles.keys().next().value;
      if (!oldest) break;
      consentedReadFiles.delete(oldest);
    }
    return true;
  } catch { return false; }
}
function isConsentedReadFile(p: string): boolean {
  try {
    const key = canonicalReadKey(path.resolve(p));
    const t = consentedReadFiles.get(key);
    if (t !== undefined) {
      if (Date.now() - t > CONSENT_TTL_MS) { consentedReadFiles.delete(key); }
      else return true;
    }
    try {
      const real = fs.realpathSync.native(path.resolve(p));
      const rk = canonicalReadKey(real);
      const rt = consentedReadFiles.get(rk);
      if (rt !== undefined) {
        if (Date.now() - rt > CONSENT_TTL_MS) { consentedReadFiles.delete(rk); }
        else return true;
      }
    } catch { /* dangling — not consented */ }
    return false;
  } catch { return false; }
}

function isTrustedAssetPath(p: string): boolean {
    const roots = [path.resolve(__dirname, 'assets')];
    if (!app.isPackaged) {
        roots.push(path.resolve(__dirname, '..', 'assets'));
        try { roots.push(path.resolve(app.getAppPath(), 'assets')); } catch { /* ignore */ }
        roots.push(path.resolve(process.cwd(), 'assets'));
    }
    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
    let realPath: string;
    try { realPath = fs.realpathSync.native(path.resolve(p)); } catch { realPath = path.resolve(p); }
    return roots.some((root) => {
        let realRoot = root;
        try { realRoot = fs.realpathSync.native(root); } catch { /* use lexical */ }
        const rel = path.relative(realRoot, realPath);
        const relCmp = insensitive ? rel.toLowerCase() : rel;
        return !!rel && !relCmp.startsWith('..') && !path.isAbsolute(rel);
    });
}

/**
 * Restricts reads to plausibly-media/kit files. Prevents a compromised
 * renderer from exfiltrating arbitrary secrets (keys, wallets, docs).
 * Legit flows only ever read: audio samples/tracks and JSON kits/sessions.
 */
function isReadPathAllowed(p: string): boolean {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  if (!READABLE_EXTENSIONS.has(ext)) return false;
  if (isAdsOrUncPath(p)) return false;
  // 1) Exact per-file consent (DnD drop registered via fs:consent-file).
  if (isConsentedReadFile(p)) return true;
  try {
    const real = fs.realpathSync.native(p);
    if (real !== p && isConsentedReadFile(real)) return true;
  } catch { /* dangling — fall through */ }
  // 2) Per-file audio consent (audio picks forwarded from fs:consent-file).
  try { if (isAllowedAudioFile(p)) return true; } catch { /* ignore */ }
  // 3) Native dialog approvals (save/load-kit, save-audio, save-session).
  if (hasDialogPath(p)) return true;
  try {
    const real = fs.realpathSync.native(p);
    if (real !== p && hasDialogPath(real)) return true;
  } catch { /* ignore */ }
  // 4) Files inside known-good locations: bundled assets, userData/recordings,
  // standard Music folders, dev recordings, and dialog-approved directories.
  try {
    if (isTrustedAssetPath(p)) return true;
  } catch { /* ignore */ }
  try {
    const userDataPath = app.getPath('userData');
    const recDir = path.resolve(path.join(userDataPath, 'recordings'));
    let recReal = recDir;
    try { recReal = fs.realpathSync.native(recDir); } catch { /* recDir may not exist yet */ }
    const resolved = path.resolve(p);
    let resolvedReal = resolved;
    try { resolvedReal = fs.realpathSync.native(resolved); } catch { /* use lexical */ }
    const rel = path.relative(recReal, resolvedReal);
    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
    const relCmp = insensitive ? rel.toLowerCase() : rel;
    if (rel && !relCmp.startsWith('..') && !path.isAbsolute(rel)) return true;
  } catch { /* ignore */ }
  try { if (isAllowedAudioDirForPath(p)) return true; } catch { /* ignore */ }
  return false;
}

function getMainWindow(): BrowserWindow | null {
  const [win] = BrowserWindow.getAllWindows();
  return win && !win.isDestroyed() ? win : null;
}

const TRUSTED_INDEX_PATH = path.resolve(__dirname, 'index.html');
const TRUSTED_INDEX_URL = pathToFileURL(TRUSTED_INDEX_PATH).toString();
const TRUSTED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'media', 'midi']);

function isTrustedDocumentUrl(url: string): boolean {
  if (url === TRUSTED_INDEX_URL) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return false;
    const filePath = path.resolve(fileURLToPath(parsed));
    const expected = path.resolve(TRUSTED_INDEX_PATH);
    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
    return insensitive ? filePath.toLowerCase() === expected.toLowerCase() : filePath === expected;
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const win = getMainWindow();
  return !!win && event.sender === win.webContents && isTrustedDocumentUrl(event.sender.getURL());
}

function permissionAllowed(contents: Electron.WebContents | null, permission: string, mediaType?: 'video' | 'audio' | 'unknown'): boolean {
  const win = getMainWindow();
  if (!win || !contents || contents !== win.webContents || !isTrustedDocumentUrl(contents.getURL())) return false;
  if (!TRUSTED_PERMISSIONS.has(permission)) return false;
  if (permission === 'media') return mediaType !== 'video';
  return true;
}

function logToDisk(level: string, message: string) {
  logManager.log(level as LogLevel, 'MAIN', message);
}

// FORCE AUTOPLAY
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Single instance: two processes would fight over SQLite WAL
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
  ipcMain.on('app:minimize', (event) => { if (isTrustedIpcSender(event) && !rateLimited('app:minimize', 100)) getMainWindow()?.minimize(); });
  ipcMain.on('app:maximize', (event) => {
    if (!isTrustedIpcSender(event)) return;
    if (rateLimited('app:maximize', 100)) return;
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('app:close', (event) => { if (isTrustedIpcSender(event)) getMainWindow()?.close(); });
  ipcMain.on('app:set-fullscreen', (event, flag) => {
    if (!isTrustedIpcSender(event)) return;
    if (rateLimited('app:set-fullscreen', 100)) return;
    getMainWindow()?.setFullScreen(flag === true);
  });
  ipcMain.on('app:ready-to-show', (event) => { if (isTrustedIpcSender(event)) getMainWindow()?.show(); });

  ipcMain.handle('app:open-external', async (event, relativePath) => {
    if (!isTrustedIpcSender(event)) return;
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
        // Pinned absolute path (L2): bare 'notepad.exe' resolves via %PATH%
        // and is hijackable; fall back to shell.openPath when absent.
        const { execFile } = require('child_process');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const notepad = path.join(systemRoot, 'System32', 'notepad.exe');
        if (fs.existsSync(notepad)) {
          execFile(notepad, [fullPath], (err: any) => {
            if (err) shell.openPath(fullPath);
          });
          return;
        }
      } catch {
        // Fall through to shell.openPath
      }
    }
    await shell.openPath(fullPath);
  });

  // Dialog throttle sentinel: a rate-limited open returns '__THROTTLED__'
  // (NOT null) so the renderer can tell "spam the button again" apart from
  // a real user-cancel. Real cancel / missing window still return null.
  ipcMain.handle('dialog:save-kit', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('dialog:save-kit', 500)) return '__THROTTLED__';
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
      // Gate allowlist ingress: filters are advisory, the user can type any
      // path. Only admit kit-shaped paths so junk picks can't evict legit
      // approvals from the 64-entry LRU.
      const ext = path.extname(v).replace('.', '').toLowerCase();
      if (ext === 'json' && !isBlockedSaveBasename(v)) {
        addDialogPath(v);
      }
    }
    return filePath;
  });

  // Dedicated session dialog: default filename carries .session.json so the
  // renderer never has to mutate the dialog-returned path (which would
  // desync it from the write allowlist).
  // Throttle sentinel '__THROTTLED__' (see dialog:save-kit) — real cancel stays null.
  ipcMain.handle('dialog:save-session', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('dialog:save-session', 500)) return '__THROTTLED__';
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
      const ext = path.extname(v).replace('.', '').toLowerCase();
      if (ext === 'json' && !isBlockedSaveBasename(v)) {
        addDialogPath(v);
      }
    }
    return filePath;
  });

  // Throttle sentinel '__THROTTLED__' (see dialog:save-kit) — real cancel stays null.
  ipcMain.handle('dialog:load-kit', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('dialog:load-kit', 500)) return '__THROTTLED__';
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load MPC Kit',
      properties: ['openFile'],
      filters: [{ name: 'JSON Kit File', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    // Per-file consent only — never whitelist the whole directory (H3: one
    // kit pick must not expose every file in the folder to later reads).
    try { addConsentedReadFile(filePaths[0]); } catch { /* ignore */ }
    return filePaths[0];
  });

  // Throttle sentinel '__THROTTLED__' (see dialog:save-kit) — real cancel stays null.
  ipcMain.handle('dialog:save-audio', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('dialog:save-audio', 500)) return '__THROTTLED__';
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
      const ext = path.extname(v).replace('.', '').toLowerCase();
      if (ext === 'wav' && !isBlockedSaveBasename(v)) {
        addDialogPath(v);
      }
    }
    return filePath;
  });

  // Secure File System Handlers
  ipcMain.handle('fs:save-file', async (event, pathStr: string, data: Uint8Array) => {
    if (!isTrustedIpcSender(event)) return false;
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
          let real: string;
          try { real = fs.realpathSync.native(validated); } catch {
            logToDisk('ERROR', `Security: Blocked dangling symlink write ${validated}`);
            return false;
          }
          if (!isSavePathAllowed(real) || isBlockedSaveBasename(real)) {
            logToDisk('ERROR', `Security: Blocked symlink write ${validated} -> ${real}`);
            return false;
          }
        } else {
          // Parent-dir realpath check: a symlinked recordings subdir
          // (recordings/linkdir -> outside) passes the lexical inside-check
          // while the real path escapes. Enforce realpath containment for
          // non-dialog writes; dialog-approved paths bypass (user-approved).
          // Windows-safe: no O_NOFOLLOW reliance — realpath + post-open
          // fstat + realpath location check below are authoritative.
          try {
            const realParent = fs.realpathSync.native(path.dirname(validated));
            const userDataPath = app.getPath('userData');
            const recDir = path.resolve(path.join(userDataPath, 'recordings'));
            let recReal = recDir;
            try { recReal = fs.realpathSync.native(recDir); } catch { /* ignore */ }
            if (!hasDialogPath(validated)) {
              const relP = path.relative(recReal, realParent);
              const insensitiveP = process.platform === 'win32' || process.platform === 'darwin';
              const relPCmp = insensitiveP ? relP.toLowerCase() : relP;
              // realParent must be recReal itself or inside it; equal-lexical
              // but escaped-real rejects here.
              const parentInside = relP === '' || (!relPCmp.startsWith('..') && !path.isAbsolute(relP));
              if (!parentInside) {
                logToDisk('ERROR', `Security: Blocked write with escaped parent ${validated} (realParent ${realParent})`);
                return false;
              }
            }
          } catch { /* target may not exist yet — lexical check already passed */ }
        }
      } catch { /* target may not exist yet — lexical check already passed */ }
      try {
        const real = fs.realpathSync.native(validated);
        if (real !== validated && !isSavePathAllowed(real)) {
          logToDisk('ERROR', `Security: Blocked symlink write ${validated} -> ${real}`);
          return false;
        }
        if (isBlockedSaveBasename(real)) {
          logToDisk('ERROR', `Security: Blocked write to internal file via symlink ${real}`);
          return false;
        }
      } catch { /* target may not exist yet — lexical check already passed */ }
      // Open + fstat + realpath(fd) location check (Windows-safe: no
      // O_NOFOLLOW reliance — O_NOFOLLOW is a no-op on Windows). Post-open
      // fstat re-verifies target: regular file, non-internal basename, and
      // realpath containment in dialog set or recordings dir. fsync before
      // close for WAL-adjacent durability.
      let targetExists = false;
      try {
        fs.lstatSync(validated);
        targetExists = true;
      } catch { /* target may not exist yet */ }
      let createdTarget = false;
      let writeCommitted = false;
      let fd: number | undefined;
      try {
        const c = fs.constants as unknown as { O_WRONLY?: number; O_CREAT?: number; O_EXCL?: number };
        const flags = (c.O_WRONLY ?? fs.constants.O_WRONLY)
          | (c.O_CREAT ?? fs.constants.O_CREAT)
          | (targetExists ? 0 : (c.O_EXCL ?? fs.constants.O_EXCL));
        fd = fs.openSync(validated, flags, 0o666);
        createdTarget = !targetExists;
        const fst = fs.fstatSync(fd);
        if (!fst.isFile()) {
          logToDisk('ERROR', `Security: Blocked write to non-file ${validated}`);
          return false;
        }
        let openReal = validated;
        try { openReal = fs.realpathSync.native(validated); } catch { /* use validated */ }
        if (isBlockedSaveBasename(openReal)) {
          logToDisk('ERROR', `Security: Blocked write to internal file ${validated}`);
          return false;
        }
        if (!hasDialogPath(validated) && !hasDialogPath(openReal) && !isSavePathAllowed(openReal)) {
          logToDisk('ERROR', `Security: Blocked write with post-open escape ${validated} -> ${openReal}`);
          return false;
        }
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, data, 0, data.byteLength);
        try { fs.fsyncSync(fd); } catch { /* best effort */ }
        writeCommitted = true;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        logToDisk('ERROR', `Security: Write ${code === 'ELOOP' ? 'blocked (symlink)' : 'failed'} for ${validated}: ${err}`);
        return false;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        if (createdTarget && !writeCommitted) {
          try { fs.unlinkSync(validated); } catch { /* ignore */ }
        }
      }
      // Dialog-approved paths stay writable for the session (cleared on
      // window close). Deleting after one write broke Save→Save-again flows.
      return true;
    } catch (err) {
      logToDisk('ERROR', `Security: Write failed for ${validated}: ${err}`);
      return false;
    }
  });

  // Consent burst window (see fs:consent-file): bounded sliding window of
  // request timestamps, pruned on every call so it can't grow unbounded.
  const consentBurst: number[] = [];
  const MAX_CONSENT_BURST = 64;
  const MAX_CONSENT_BURST_TRACKED = 128;
  ipcMain.handle('fs:consent-file', async (event, pathStr: string) => {
    if (!isTrustedIpcSender(event)) return false;
    // Burst-tolerant throttle: a global 100ms gate previously dropped most of
    // a 50-file DnD burst (and let attacker spam starve legit drops). Allow a
    // 64-file burst per second — validation is a statSync + map insert — then
    // throttle. The 256-entry consentedReadFiles cap still bounds memory.
    // Check-before-push: the current request counts against the NEXT window,
    // and the array itself is hard-capped so a burst can't pile entries.
    const now = Date.now();
    while (consentBurst.length > 0 && now - consentBurst[0] > 1000) consentBurst.shift();
    if (consentBurst.length >= MAX_CONSENT_BURST) {
      if (rateLimited('fs:consent-file', 100)) return false;
    }
    consentBurst.push(now);
    if (consentBurst.length > MAX_CONSENT_BURST_TRACKED) {
      consentBurst.splice(0, consentBurst.length - MAX_CONSENT_BURST_TRACKED);
    }
    if (typeof pathStr !== 'string' || !pathStr || pathStr.length > 32760) return false;
    const validated = validatePath(pathStr);
    if (!validated) return false;
    // A renderer string alone never grants access: the file must exist on
    // disk right now, look like media/kit, and fit the size bound.
    const ok = addConsentedReadFile(validated);
    if (!ok) return false;
    // Forward audio picks to the consent store so later disk reads
    // (playback, analysis) can read the same consented file from disk.
    try {
      const ext = path.extname(validated).replace('.', '').toLowerCase();
      if (ext !== 'json') addAllowedAudioFile(validated);
    } catch { /* ignore */ }
    return true;
  });

  ipcMain.handle('fs:read-file', async (event, pathStr: string) => {
    if (!isTrustedIpcSender(event)) return null;
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
      // Single-fd read (M3): open once, fstat the fd, read the fd. The old
      // stat-then-readFile pair let the file grow past the size bound (or be
      // swapped) between the two syscalls.
      let fh: fs.promises.FileHandle | undefined;
      try {
        try {
          fh = await fs.promises.open(checkPath, 'r');
        } catch {
          logToDisk('ERROR', `Security: Blocked read of non-existent path ${validated}`);
          return null;
        }
        let stat: fs.Stats;
        try {
          stat = await fh.stat();
        } catch {
          logToDisk('ERROR', `Security: Blocked unreadable path ${validated}`);
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
        const buffer = Buffer.alloc(stat.size);
        await fh.read(buffer, 0, stat.size, 0);
        if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
          logToDisk('ERROR', `Security: Blocked read with post-read oversize ${validated}`);
          return null;
        }
        return buffer;
      } finally {
        if (fh !== undefined) {
          try { await fh.close(); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      logToDisk('ERROR', `Security: Read failed for ${validated}: ${err}`);
      return null;
    }
  });

  // H4: fs:ensure-recordings-dir + fs:save-recording removed — zero renderer
  // call sites (master recording uses saveAudioDialog + fs:save-file).
  // Orphaned handlers are pure attack surface; re-add with callers if needed.

  // Persistent decoded-audio (PCM) disk cache. fs:save-file's allowlist
  // rejects non-dialog/non-recordings writes, so the cache gets its own
  // narrow channel: fixed dir under userData, hex-only filenames, byte caps.
  const PCM_CACHE_KEY_RE = /^[0-9a-f]{64}$/;
  const PCM_CACHE_ENTRY_MAX_BYTES = 100 * 1024 * 1024;
  const PCM_CACHE_DIR_MAX_BYTES = 500 * 1024 * 1024;
  function getPcmCacheDir(): string {
    return path.join(app.getPath('userData'), 'cache-pcm');
  }
  ipcMain.handle('pcmcache:get', async (event, key: unknown) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('pcmcache:get', 50)) return null;
    if (typeof key !== 'string' || !PCM_CACHE_KEY_RE.test(key)) {
      logToDisk('ERROR', 'Security: Blocked pcmcache:get with invalid key');
      return null;
    }
    try {
      const dir = getPcmCacheDir();
      const fp = path.join(dir, `${key}.pcm`);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(fp);
      } catch {
        return null;
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > PCM_CACHE_ENTRY_MAX_BYTES) return null;
      const data = await fs.promises.readFile(fp);
      if (data.byteLength === 0 || data.byteLength > PCM_CACHE_ENTRY_MAX_BYTES) return null;
      return data;
    } catch (err) {
      logToDisk('ERROR', `pcmcache:get failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('pcmcache:put', async (event, key: unknown, data: unknown) => {
    if (!isTrustedIpcSender(event)) return false;
    if (rateLimited('pcmcache:put', 50)) return false;
    if (typeof key !== 'string' || !PCM_CACHE_KEY_RE.test(key)) {
      logToDisk('ERROR', 'Security: Blocked pcmcache:put with invalid key');
      return false;
    }
    if (!data || !(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > PCM_CACHE_ENTRY_MAX_BYTES) {
      logToDisk('ERROR', `Security: Blocked pcmcache:put with invalid payload (${(data as { byteLength?: unknown })?.byteLength ?? 'n/a'} bytes)`);
      return false;
    }
    try {
      const dir = getPcmCacheDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const fp = path.join(dir, `${key}.pcm`);
      await fs.promises.writeFile(fp, Buffer.from((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength));
      try {
        const entries: { p: string; mtime: number; size: number }[] = [];
        for (const name of await fs.promises.readdir(dir)) {
          if (!/^[0-9a-f]{64}\.pcm$/.test(name)) continue;
          try {
            const st = await fs.promises.stat(path.join(dir, name));
            if (st.isFile()) entries.push({ p: path.join(dir, name), mtime: st.mtimeMs, size: st.size });
          } catch { /* ignore */ }
        }
        let total = entries.reduce((a, e) => a + e.size, 0);
        entries.sort((a, b) => a.mtime - b.mtime);
        for (const e of entries) {
          if (total <= PCM_CACHE_DIR_MAX_BYTES) break;
          try { await fs.promises.unlink(e.p); total -= e.size; } catch { /* ignore */ }
        }
      } catch { /* eviction best effort */ }
      return true;
    } catch (err) {
      logToDisk('ERROR', `pcmcache:put failed: ${err}`);
      return false;
    }
  });

  // Metadata-only read: SAME gates as fs:read-file (ext allowlist via
  // isReadPathAllowed + validatePath + realpath + isFile). statSync only,
  // no content crosses IPC.
  ipcMain.handle('fs:stat-file', async (event, pathStr: unknown) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('fs:stat-file', 50)) return null;
    if (typeof pathStr !== 'string') {
      logToDisk('ERROR', 'Security: Blocked illegal stat attempt');
      return null;
    }
    const validated = validatePath(pathStr);
    if (!validated) {
      logToDisk('ERROR', `Security: Blocked illegal stat attempt from ${pathStr}`);
      return null;
    }
    if (!isReadPathAllowed(validated)) {
      logToDisk('ERROR', `Security: Blocked stat of non-media file ${validated}`);
      return null;
    }
    try {
      let realPath: string;
      try {
        realPath = fs.realpathSync.native(validated);
      } catch {
        realPath = fs.realpathSync(validated);
      }
      if (realPath !== validated && !isReadPathAllowed(realPath)) {
        logToDisk('ERROR', `Security: Blocked symlink stat ${validated} -> ${realPath}`);
        return null;
      }
      const checkPath = realPath || validated;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(checkPath);
      } catch {
        logToDisk('ERROR', `Security: Blocked stat of non-existent path ${validated}`);
        return null;
      }
      if (!stat.isFile()) {
        logToDisk('ERROR', `Security: Blocked stat of non-file path ${validated}`);
        return null;
      }
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (err) {
      logToDisk('ERROR', `Security: Stat failed for ${validated}: ${err}`);
      return null;
    }
  });

  ipcMain.handle('fs:show-item-in-folder', async (event, pathStr: string) => {
    if (!isTrustedIpcSender(event)) return false;
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
  ipcMain.handle('fs:append-log', async (event, level: string, message: string) => {
    if (!isTrustedIpcSender(event)) return false;
    const allowed: ReadonlySet<string> = new Set(['INFO', 'WARN', 'ERROR', 'DEBUG']);
    const lvl = allowed.has(String(level)) ? (level as LogLevel) : 'INFO';
    // ERROR/WARN bypass the IPC-flood gate: disk must hold high-severity
    // lines even in storms (a rate-limited 'false' silently drops them).
    // INFO/DEBUG stay gated.
    if (lvl !== 'ERROR' && lvl !== 'WARN' && rateLimited('fs:append-log', 50)) return false;
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

  ipcMain.handle('fs:get-log-path', async (event) => {
    if (!isTrustedIpcSender(event)) return '';
    return logManager.getLogPath();
  });

  ipcMain.handle('app:generate-crash-report', async (event, stateSnapshot) => {
    if (!isTrustedIpcSender(event)) return null;
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

  // Throttle sentinel '__THROTTLED__' (see dialog:save-kit) — real cancel stays null.
  ipcMain.handle('dialog:open-sample', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('dialog:open-sample', 500)) return '__THROTTLED__';
    const win = getMainWindow();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Audio Sample',
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: [...VALID_AUDIO_EXTENSIONS] }]
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    // Per-file consent only — never whitelist the whole directory (H3).
    try { addConsentedReadFile(filePaths[0]); } catch { /* ignore */ }
    try { addAllowedAudioFile(filePaths[0]); } catch { /* ignore */ }
    return filePaths[0];
  });

  // ==================== DATABASE HANDLERS ====================

  ipcMain.handle('db:upsert-track', async (event, track) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('db:upsert-track', 50)) return null;
    try {
      if (!track || typeof track !== 'object') return null;
      // Ext + consent gate: DB must not become an exfil channel for
      // non-audio paths. Audio ext required; consented file, dialog approval,
      // or allowlisted dir required.
      if (typeof track.path === 'string' && track.path) {
        const ext = path.extname(track.path).replace('.', '').toLowerCase();
        if (!VALID_AUDIO_EXTENSIONS.includes(ext as never)) {
          logToDisk('ERROR', `Security: Blocked db:upsert-track with non-audio ext ${track.path}`);
          return null;
        }
        if (isAdsOrUncPath(track.path)) {
          logToDisk('ERROR', `Security: Blocked db:upsert-track with ADS/UNC ${track.path}`);
          return null;
        }
        const v = validatePath(track.path);
        if (!v || !isReadPathAllowed(v)) {
          logToDisk('ERROR', `Security: Blocked db:upsert-track without consent ${track.path}`);
          return null;
        }
      }
      const db = getDbManager();
      if (!db) return null;
      return db.upsertTrack(track);
    } catch (e) {
      logToDisk('ERROR', `DB Upsert failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:get-track', async (event, trackPath) => {
    if (!isTrustedIpcSender(event)) return null;
    if (rateLimited('db:get-track', 50)) return null;
    try {
      if (typeof trackPath !== 'string' || !trackPath || trackPath.length > 32760) return null;
      const ext = path.extname(trackPath).replace('.', '').toLowerCase();
      if (!VALID_AUDIO_EXTENSIONS.includes(ext as never)) {
        logToDisk('ERROR', `Security: Blocked db:get-track with non-audio ext ${trackPath}`);
        return null;
      }
      if (isAdsOrUncPath(trackPath)) {
        logToDisk('ERROR', `Security: Blocked db:get-track with ADS/UNC ${trackPath}`);
        return null;
      }
      const v = validatePath(trackPath);
      if (!v || !isReadPathAllowed(v)) {
        logToDisk('ERROR', `Security: Blocked db:get-track without consent ${trackPath}`);
        return null;
      }
      const db = getDbManager();
      if (!db) return null;
      return db.getTrackByPath(trackPath);
    } catch (e) {
      logToDisk('ERROR', `DB get-track failed: ${e}`);
      return null;
    }
  });

  ipcMain.handle('db:search-tracks', async (event, query) => {
    if (!isTrustedIpcSender(event)) return [];
    if (rateLimited('db:search-tracks', 100)) return [];
    try {
      const q = String(query ?? '').slice(0, 256);
      const db = getDbManager();
      if (!db) return [];
      // IPC surface cap: the renderer filter view never needs more than the
      // playlist search budget (DB itself caps lower; this is the contract).
      const rows = db.searchTracks(q);
      return Array.isArray(rows) ? rows.slice(0, MAX_PLAYLIST_SEARCH_RESULTS) : [];
    } catch (e) {
      logToDisk('ERROR', `DB search failed: ${e}`);
      return [];
    }
  });

  ipcMain.handle('db:get-all-tracks', async (event) => {
    if (!isTrustedIpcSender(event)) return [];
    if (rateLimited('db:get-all-tracks', 1000)) return [];
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

  try {
    const blockNavigation = (event: Electron.Event, url: string, source: string): void => {
      if (isTrustedDocumentUrl(url)) return;
      event.preventDefault();
      logToDisk('ERROR', `Security: Blocked ${source} navigation`);
    };
    win.webContents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) blockNavigation(details, details.url, 'frame');
      else details.preventDefault();
    });
    win.webContents.on('will-navigate', (details) => {
      blockNavigation(details, details.url, 'page');
    });
    win.webContents.on('will-redirect', (details) => {
      blockNavigation(details, details.url, 'redirect');
    });
    win.webContents.setWindowOpenHandler(() => {
      try { logToDisk('ERROR', 'Security: Blocked window.open'); } catch { /* ignore */ }
      return { action: 'deny' };
    });
    const rendererSession = win.webContents.session;
    rendererSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const mediaType = 'mediaTypes' in details && details.mediaTypes?.includes('video')
        ? 'video'
        : 'mediaTypes' in details && details.mediaTypes?.includes('audio') ? 'audio' : undefined;
      callback(permissionAllowed(contents, permission, mediaType));
    });
    rendererSession.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) => {
      return permissionAllowed(contents, permission, details.mediaType);
    });
  } catch (e) {
    try { logToDisk('ERROR', `Security: renderer lockdown setup failed: ${e}`); } catch { /* ignore */ }
  }

  win.loadFile(TRUSTED_INDEX_PATH);

  // Fallback: if the renderer crashes before app:ready-to-show, the window
  // would stay hidden forever. Force-show after 8s.
  setTimeout(() => {
    try { if (!win.isDestroyed() && !win.isVisible()) win.show(); } catch { /* ignore */ }
  }, 8000).unref?.();

  win.on('close', () => {
    // Window-scoped cleanup only. Full process teardown (DB/logger)
    // lives on quit paths below — doing it here kills the logger timer and
    // orphans state on macOS where close != quit and activate re-creates
    // a window in the same process.
    try { dialogReturnedPaths.clear(); } catch { /* ignore */ }
  });

  return win;
}

// Idempotent full cleanup (C1): previously only win 'close' cleaned up, so
// Cmd+Q / dock quit / taskkill / macOS close-then-quit leaked a dirty WAL.
// Every quit path funnels through here. before-quit holds the quit with
// preventDefault until done.
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
function shutdownMain(reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    try { dialogReturnedPaths.clear(); } catch { /* ignore */ }
    try {
      getDbManager()?.close();
    } catch (e) {
      try { logToDisk('ERROR', `DB close failed (${reason}): ${e}`); } catch { /* ignore */ }
    }
    try { logManager.close(); } catch { /* ignore */ }
  })();
  return shutdownPromise;
}

app.whenReady().then(() => {
  if (!gotLock) return;
  try { logManager.relocateToUserData(); } catch { /* keep pre-ready path */ }
  registerIpcHandlers();
  try { initDbManager(); } catch (e) {
    try { logToDisk('ERROR', `Eager DB init failed: ${e}`); } catch { /* ignore */ }
  }
  try {
    loadAllowedAudioFiles();
  } catch (e) {
    try { logToDisk('WARN', `Audio consent restore failed: ${e}`); } catch { /* ignore */ }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  dialogReturnedPaths.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (shuttingDown && shutdownPromise) return;
  e.preventDefault();
  void shutdownMain('before-quit').finally(() => {
    try { app.exit(0); } catch { try { app.quit(); } catch { /* ignore */ } }
  });
});

app.on('will-quit', () => {
  void shutdownMain('will-quit');
});

process.on('SIGINT', () => {
  void shutdownMain('SIGINT').finally(() => {
    try { app.quit(); } catch { /* ignore */ }
  });
});

process.on('SIGTERM', () => {
  void shutdownMain('SIGTERM').finally(() => {
    try { app.quit(); } catch { /* ignore */ }
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else { getMainWindow()?.focus(); }
});

// GURU CRASH PROTECTION — registered once; report is written before exit.
// Order matters: buffer must survive until generatePostMortem reads it, so
// logManager.close() runs AFTER the report (with keepBuffer flush). A hard
// fallback timer guarantees exit even if the report promise never settles.
process.on('uncaughtException', (error) => {
  const fallback = setTimeout(() => {
    try { console.error('GURU ERROR: post-mortem timed out, forcing exit'); } catch { /* ignore */ }
    try { app.exit(1); } catch { try { process.exit(1); } catch { /* ignore */ } }
  }, 3000);
  try { (fallback as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
  try {
    logToDisk('ERROR', `UNCAUGHT EXCEPTION: ${(error as Error)?.stack || error}`);
  } catch { /* ignore */ }
  // Crash path must also checkpoint the DB — otherwise an exception
  // leaves a dirty WAL behind.
  try { getDbManager()?.close(); } catch { /* ignore */ }
  logManager.generatePostMortem({ type: 'CRASH_UNCAUGHT_EXCEPTION' })
    .then((report) => console.error(`GURU ERROR: Crash report generated at ${report}`))
    .catch((e) => console.error(`GURU ERROR: Failed to write crash report: ${e}`))
    .finally(() => {
      try { clearTimeout(fallback); } catch { /* ignore */ }
      try { logManager.close(); } catch { /* ignore */ }
      try { app.exit(1); } catch { try { process.exit(1); } catch { /* ignore */ } }
    });
});
// Burst-tracked so a rejecting loop can't silently accumulate handles.
// Rejections are counted per-minute-window; a sustained burst flushes a
// post-mortem for forensics but the app keeps running (exit-on-rejection
// would turn any async hiccup into a crash).
let unhandledRejectionCount = 0;
let unhandledRejectionWindowStart = 0;
const REJECTION_BURST_WINDOW_MS = 60 * 1000;
const REJECTION_BURST_LIMIT = 50;
process.on('unhandledRejection', (reason) => {
  const now = Date.now();
  if (now - unhandledRejectionWindowStart > REJECTION_BURST_WINDOW_MS) {
    unhandledRejectionCount = 0;
    unhandledRejectionWindowStart = now;
  }
  unhandledRejectionCount++;
  logToDisk('ERROR', `UNHANDLED REJECTION [${unhandledRejectionCount}]: ${(reason as Error)?.stack || reason}`);
  if (unhandledRejectionCount >= REJECTION_BURST_LIMIT) {
    unhandledRejectionCount = 0;
    unhandledRejectionWindowStart = now;
    logToDisk('ERROR', 'Rejection burst limit hit — flushing diagnostics');
    logManager.generatePostMortem({ type: 'REJECTION_BURST' })
      .then((report) => logToDisk('ERROR', `Rejection-burst report: ${report}`))
      .catch((e) => { try { logToDisk('ERROR', `Rejection-burst report FAILED: ${(e as Error)?.stack || e}`); } catch { /* ignore */ } });
  }
});
