/**
 * Crash Recovery module for Gangsta Player Pro 3
 *
 * Periodically auto-saves app state to localStorage.
 * On startup, checks for a saved snapshot and offers to restore it.
 * Prevents data loss from unexpected crashes.
 */

import { state, Track, LoopMode, PlaybackMode } from './state';
import { toast } from './toast';
import { logger } from './logger';
// Static imports — require() throws at runtime in the ESM browser bundle,
// which silently killed snapshot collection and restore entirely.
import {
    padBuffers, padPaths, padVolumes, padBPMs, padSyncState,
    padLoopStart, padLoopEnd,
    loadSampleFromPath
} from './sampler';
import { openModal, closeModal, showConfirm } from './modals';
import { AUTO_SAVE_INTERVAL_MS, MIN_SAVE_INTERVAL_MS, MAX_SNAPSHOTS, NUM_PADS } from './constants';

// === Constants ===

const STORAGE_KEY = 'ug_crash_snapshot';
const SNAPSHOT_VERSION = 1;

// === Types ===

interface SnapshotPad {
    path: string;
    vol: number;
    bpm: number;
    sync: boolean;
    loopStart?: number;
    loopEnd?: number;
}

interface CrashSnapshot {
    version: number;
    timestamp: number;
    reason?: string;
    playlist: Track[];
    currentTrackIndex: number;
    masterBPM: number;
    pads: Record<number, SnapshotPad>;
    ui: {
        masterVolume: number;
        tempoValue: number;
        loopMode: LoopMode;
        playbackMode: PlaybackMode;
        isAutoMixEnabled: boolean;
        isPlaying: boolean;
    };
}

// === Internal State ===

let _timer: ReturnType<typeof setInterval> | null = null;
let _crashInit = false;
let _lastSaveTime = 0;
let _hasUnsavedChanges = false;

// === Snapshot Management ===

function getSnapshotKey(index = 0): string {
    return index === 0 ? STORAGE_KEY : `${STORAGE_KEY}_${index}`;
}

function saveToStorage(key: string, data: CrashSnapshot): boolean {
    try {
        const json = JSON.stringify(data);
        // localStorage quota is ~5MB — a huge playlist would throw and must
        // not masquerade as saved.
        if (json.length > 4_000_000) {
            logger.warn('[CrashRecovery] Snapshot too large, skipping save');
            return false;
        }
        localStorage.setItem(key, json);
        return true;
    } catch (e) {
        logger.warn('[CrashRecovery] localStorage write failed (quota?)', e);
        return false;
    }
}

function loadFromStorage(key: string): CrashSnapshot | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        if (raw.length > 4_000_000) { try { localStorage.removeItem(key); } catch { /* ignore */ } return null; }
        const snap = JSON.parse(raw) as CrashSnapshot;
        if (!snap || snap.version !== SNAPSHOT_VERSION) return null;
        return snap;
    } catch (e) {
        logger.warn('[CrashRecovery] Failed to read snapshot', e);
        return null;
    }
}

function removeFromStorage(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch (e) {
        // ignore
    }
}

// === Collect Current State ===

function collectSnapshot(reason?: string): CrashSnapshot {
    const pads: Record<number, SnapshotPad> = {};
    for (let i = 0; i < NUM_PADS; i++) {
        if (padBuffers[i] || padPaths[i]) {
            const ls = padLoopStart[i];
            const le = padLoopEnd[i];
            pads[i] = {
                path: padPaths[i] || '',
                vol: padVolumes[i] ?? 0.75,
                bpm: padBPMs[i] || 0,
                sync: padSyncState[i] || false,
                loopStart: (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) ? ls : undefined,
                loopEnd: (typeof le === 'number' && Number.isFinite(le) && le > 0) ? le : undefined,
            };
        }
    }

    const masterVolEl = document.getElementById('masterVol') as HTMLInputElement;
    const tempoEl = document.getElementById('tempoSlider') as HTMLInputElement;

    return {
        version: SNAPSHOT_VERSION,
        timestamp: Date.now(),
        reason,
        playlist: state.playlist.map(t => ({ ...t })),
        currentTrackIndex: state.currentTrackIndex,
        masterBPM: state.masterBPM,
        pads,
        ui: {
            masterVolume: masterVolEl ? parseFloat(masterVolEl.value) : 1,
            tempoValue: tempoEl ? parseFloat(tempoEl.value) : 1,
            loopMode: state.loopMode,
            playbackMode: state.playbackMode,
            isAutoMixEnabled: state.isAutoMixEnabled,
            isPlaying: false,
        },
    };
}

// === Save Snapshot ===

let _restoring = false;

function saveSnapshot(reason?: string): void {
    const now = Date.now();
    // beforeunload must bypass the throttle — otherwise a crash within 10s of
    // the last save loses up to ~40s of work.
    if (reason !== 'beforeunload' && now - _lastSaveTime < MIN_SAVE_INTERVAL_MS) return;

    const snapshot = collectSnapshot(reason);

    // Rotate snapshots newest->_1->_2. Read older slots FIRST before
    // overwriting, otherwise _2 becomes a duplicate of _1's predecessor.
    const prev1 = loadFromStorage(getSnapshotKey(1));
    const prev0 = loadFromStorage(STORAGE_KEY);
    let ok = true;
    if (prev1) ok = saveToStorage(getSnapshotKey(2), prev1) && ok;
    if (prev0) ok = saveToStorage(getSnapshotKey(1), prev0) && ok;

    ok = saveToStorage(STORAGE_KEY, snapshot) && ok;
    // Only clear the dirty flag when the write actually landed — otherwise a
    // quota failure masquerades as saved and the data is lost.
    if (ok) {
        _lastSaveTime = now;
        _hasUnsavedChanges = false;
        logger.debug(`[CrashRecovery] Snapshot saved (${reason || 'periodic'})`);
    } else {
        logger.warn('[CrashRecovery] Snapshot save failed (quota?) — will retry');
    }
}

// === Restore Snapshot ===

export function getLatestSnapshot(): CrashSnapshot | null {
    // Rotation: newest is STORAGE_KEY, older copies land in _1/_2
    return loadFromStorage(STORAGE_KEY) || loadFromStorage(getSnapshotKey(1)) || loadFromStorage(getSnapshotKey(2));
}

export function clearSnapshots(): void {
    // Also purge the legacy _bak key from older builds
    removeFromStorage('ug_crash_snapshot_bak');
    removeFromStorage(STORAGE_KEY);
    for (let i = 1; i < MAX_SNAPSHOTS; i++) {
        removeFromStorage(getSnapshotKey(i));
    }
    _hasUnsavedChanges = false;
    logger.info('[CrashRecovery] Snapshots cleared');
}

export async function restoreSnapshot(): Promise<boolean> {
    const snapshot = getLatestSnapshot();
    if (!snapshot) {
        toast.info("No saved session to restore.");
        return false;
    }

    _restoring = true;
    try {
        // 1. Restore playlist (validated + bounded like session restore —
        // untrusted localStorage must not OOM the renderer).
        if (Array.isArray(snapshot.playlist)) {
            const clean = snapshot.playlist
                .filter((t): t is Track => !!t && typeof (t as Track).id === 'string' && typeof (t as Track).name === 'string' && typeof (t as Track).path === 'string')
                .slice(0, 2000)
                .map(t => ({
                    id: String(t.id).slice(0, 128),
                    name: String(t.name).slice(0, 512),
                    path: String(t.path).slice(0, 32760),
                    duration: typeof t.duration === 'number' && Number.isFinite(t.duration) ? Math.min(86400, Math.max(0, t.duration)) : 0,
                    bpm: t.bpm === undefined ? undefined : (Number.isFinite(Number(t.bpm)) ? Math.min(300, Math.max(0, Number(t.bpm))) : 0),
                }));
            const cur = typeof snapshot.currentTrackIndex === 'number' ? snapshot.currentTrackIndex : -1;
            state.update({
                playlist: clean,
                currentTrackIndex: cur >= 0 && cur < clean.length ? cur : -1,
                masterBPM: typeof snapshot.masterBPM === 'number' && Number.isFinite(snapshot.masterBPM) ? snapshot.masterBPM : 0,
            });
        }

        // 2. Restore UI state (clamped + allowlisted — corrupt localStorage
        // previously poisoned gain/tempo and injected invalid enums).
        if (snapshot.ui) {
            const clamp = (v: unknown, lo: number, hi: number): number | null => {
                const n = typeof v === 'number' ? v : parseFloat(String(v));
                if (!Number.isFinite(n)) return null;
                return Math.min(hi, Math.max(lo, n));
            };
            const volSlider = document.getElementById('masterVol') as HTMLInputElement;
            if (volSlider && snapshot.ui.masterVolume !== undefined) {
                const mv = clamp(snapshot.ui.masterVolume, 0, 1);
                if (mv !== null) {
                    volSlider.value = mv.toString();
                    volSlider.dispatchEvent(new Event('input'));
                }
            }

            const tempo = document.getElementById('tempoSlider') as HTMLInputElement;
            if (tempo && snapshot.ui.tempoValue !== undefined) {
                const tv = clamp(snapshot.ui.tempoValue, 0.5, 1.5);
                if (tv !== null) {
                    tempo.value = tv.toString();
                    tempo.dispatchEvent(new Event('input'));
                }
            }

            const updates: Record<string, any> = {};
            if (snapshot.ui.loopMode === 'off' || snapshot.ui.loopMode === 'one' || snapshot.ui.loopMode === 'all') {
                updates.loopMode = snapshot.ui.loopMode;
            }
            if (snapshot.ui.playbackMode === 'continuous' || snapshot.ui.playbackMode === 'single') {
                updates.playbackMode = snapshot.ui.playbackMode;
            }
            if (typeof snapshot.ui.isAutoMixEnabled === 'boolean') {
                updates.isAutoMixEnabled = snapshot.ui.isAutoMixEnabled;
            }
            if (Object.keys(updates).length > 0) state.update(updates);
        }

        // 3. Restore sampler pads (per-pad timeout: 16 missing files = slow fail)
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
            Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('pad restore timeout')), ms))]);
        const padKeys = Object.keys(snapshot.pads);
        if (padKeys.length > 0) {
            for (const key of padKeys) {
                const idx = parseInt(key);
                const p = snapshot.pads[idx];
                if (!p || !Number.isInteger(idx) || idx < 0 || idx >= NUM_PADS || !p.path) continue;
                // Don't claim padPaths before the file proves loadable —
                // otherwise failures leave ghost paths with no buffer.
                try {
                    await withTimeout(loadSampleFromPath(p.path, idx), 20000);
                    padVolumes[idx] = (typeof p.vol === 'number' && Number.isFinite(p.vol)) ? Math.min(1, Math.max(0, p.vol)) : 0.75;
                    padBPMs[idx] = p.bpm || 0;
                    padSyncState[idx] = p.sync || false;
                    if (typeof p.loopStart === 'number' && Number.isFinite(p.loopStart) && p.loopStart >= 0) padLoopStart[idx] = p.loopStart;
                    if (typeof p.loopEnd === 'number' && Number.isFinite(p.loopEnd) && p.loopEnd > 0) padLoopEnd[idx] = p.loopEnd;
                } catch (err: unknown) {
                    logger.warn(`[CrashRecovery] Pad ${idx} reload failed: ${(err as Error)?.message || err}`);
                    continue;
                }
                // Restore volume slider UI
                const grid = document.getElementById('padGrid');
                const slider = grid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                if (slider) slider.value = padVolumes[idx].toString();
            }
        }

        // 4. Trigger playlist render
        try {
            const { renderPlaylist } = await import('./playlist');
            renderPlaylist();
        } catch (e) {
            // renderPlaylist may not be available yet
        }

        // Clear snapshots after successful restore
        clearSnapshots();

        const ts = typeof snapshot.timestamp === 'number' && Number.isFinite(snapshot.timestamp)
            ? new Date(snapshot.timestamp).toLocaleString()
            : 'unknown time';
        toast.success("CRASH SESSION RESTORED");
        logger.info(`[CrashRecovery] Restored snapshot from ${ts}`);
        return true;
    } catch (e) {
        logger.error('[CrashRecovery] Restore failed', e);
        toast.error("RESTORE FAILED");
        return false;
    } finally {
        _restoring = false;
    }
}

// === Initialization ===

export function initCrashRecovery(): void {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_crashInit) return;
    _crashInit = true;
    // Subscribe to state changes for auto-save (suppressed during restore so
    // the restore itself doesn't re-dirty and resurrect cleared snapshots).
    state.subscribeAll(() => {
        if (!_restoring) _hasUnsavedChanges = true;
    });

    // Listen for custom data-change events from sampler/playlist
    document.addEventListener('ug:dataChanged', () => {
        _hasUnsavedChanges = true;
    });

    // Periodic auto-save timer
    _timer = setInterval(() => {
        if (_hasUnsavedChanges) {
            saveSnapshot('periodic');
        }
    }, AUTO_SAVE_INTERVAL_MS);

    // Save on page unload (crash prevention)
    window.addEventListener('beforeunload', () => {
        if (_hasUnsavedChanges) {
            saveSnapshot('beforeunload');
        }
    });

    logger.info('[CrashRecovery] Initialized (auto-save every 30s)');
}

/**
 * Check if there is a saved snapshot and prompt user to restore.
 * Returns true if a snapshot was restored.
 */
let _restorePromptOpen = false;
export function checkAndRestore(): Promise<boolean> {
    if (_restorePromptOpen) return Promise.resolve(false);
    return new Promise((resolve) => {
        const snapshot = getLatestSnapshot();
        if (!snapshot) {
            resolve(false);
            return;
        }

        const age = Date.now() - snapshot.timestamp;
        const ageStr = age < 60000 ? 'just now'
            : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
            : `${Math.floor(age / 3600000)}h ago`;

        logger.info(`[CrashRecovery] Found snapshot from ${new Date(snapshot.timestamp).toLocaleString()} (${ageStr})`);

        if (!document.getElementById('confirmModal')) {
            resolve(false);
            return;
        }

        _restorePromptOpen = true;
        const done = (v: boolean) => { _restorePromptOpen = false; resolve(v); };
        // Queued confirm — concurrent showConfirm callers no longer clobber it.
        showConfirm(
            'CRASH RECOVERY',
            `We detected an unsaved session from ${ageStr}.\nRestore it?`,
            () => {
                restoreSnapshot().then(done);
            },
            () => {
                clearSnapshots();
                toast.info("Crash session discarded.");
                done(false);
            }
        );
    });
}
