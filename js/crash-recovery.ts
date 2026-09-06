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
    loadSampleFromPath
} from './sampler';
import { openModal, closeModal } from './modals';

// === Constants ===

const STORAGE_KEY = 'ug_crash_snapshot';
const AUTO_SAVE_INTERVAL_MS = 30_000; // Save every 30s
const MIN_SAVE_INTERVAL_MS = 10_000;  // Don't save more often than this
const MAX_SNAPSHOTS = 3;
const SNAPSHOT_VERSION = 1;

// === Types ===

interface SnapshotPad {
    path: string;
    vol: number;
    bpm: number;
    sync: boolean;
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
let _lastSaveTime = 0;
let _hasUnsavedChanges = false;

// === Snapshot Management ===

function getSnapshotKey(index = 0): string {
    return index === 0 ? STORAGE_KEY : `${STORAGE_KEY}_${index}`;
}

function saveToStorage(key: string, data: CrashSnapshot): void {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
        logger.warn('[CrashRecovery] localStorage write failed (quota?)', e);
    }
}

function loadFromStorage(key: string): CrashSnapshot | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as CrashSnapshot;
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
    for (let i = 0; i < 16; i++) {
        if (padBuffers[i] || padPaths[i]) {
            pads[i] = {
                path: padPaths[i] || '',
                vol: padVolumes[i] ?? 0.75,
                bpm: padBPMs[i] || 0,
                sync: padSyncState[i] || false,
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

function saveSnapshot(reason?: string): void {
    const now = Date.now();
    if (now - _lastSaveTime < MIN_SAVE_INTERVAL_MS) return;

    _lastSaveTime = now;
    _hasUnsavedChanges = false;

    const snapshot = collectSnapshot(reason);

    // Rotate snapshots newest->_1->_2. Read older slots FIRST before
    // overwriting, otherwise _2 becomes a duplicate of _1's predecessor.
    const prev1 = loadFromStorage(getSnapshotKey(1));
    const prev0 = loadFromStorage(STORAGE_KEY);
    if (prev1) saveToStorage(getSnapshotKey(2), prev1);
    if (prev0) saveToStorage(getSnapshotKey(1), prev0);

    saveToStorage(STORAGE_KEY, snapshot);
    logger.debug(`[CrashRecovery] Snapshot saved (${reason || 'periodic'})`);
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

    try {
        // 1. Restore playlist
        if (Array.isArray(snapshot.playlist)) {
            state.update({
                playlist: snapshot.playlist,
                currentTrackIndex: snapshot.currentTrackIndex ?? -1,
                masterBPM: snapshot.masterBPM || 0,
            });
        }

        // 2. Restore UI state
        if (snapshot.ui) {
            const volSlider = document.getElementById('masterVol') as HTMLInputElement;
            if (volSlider && snapshot.ui.masterVolume !== undefined) {
                volSlider.value = snapshot.ui.masterVolume.toString();
                volSlider.dispatchEvent(new Event('input'));
            }

            const tempo = document.getElementById('tempoSlider') as HTMLInputElement;
            if (tempo && snapshot.ui.tempoValue !== undefined) {
                tempo.value = snapshot.ui.tempoValue.toString();
                tempo.dispatchEvent(new Event('input'));
            }

            const updates: Record<string, any> = {};
            if (snapshot.ui.loopMode) updates.loopMode = snapshot.ui.loopMode;
            if (snapshot.ui.playbackMode) updates.playbackMode = snapshot.ui.playbackMode;
            if (snapshot.ui.isAutoMixEnabled !== undefined) updates.isAutoMixEnabled = snapshot.ui.isAutoMixEnabled;
            if (Object.keys(updates).length > 0) state.update(updates);
        }

        // 3. Restore sampler pads
        const padKeys = Object.keys(snapshot.pads);
        if (padKeys.length > 0) {
            for (const key of padKeys) {
                const idx = parseInt(key);
                const p = snapshot.pads[idx];
                if (!p || !Number.isInteger(idx) || idx < 0 || idx > 15 || !p.path) continue;
                // Don't claim padPaths before the file proves loadable —
                // otherwise failures leave ghost paths with no buffer.
                try {
                    await loadSampleFromPath(p.path, idx);
                    padVolumes[idx] = (typeof p.vol === 'number' && Number.isFinite(p.vol)) ? Math.min(1, Math.max(0, p.vol)) : 0.75;
                    padBPMs[idx] = p.bpm || 0;
                    padSyncState[idx] = p.sync || false;
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

        toast.success("CRASH SESSION RESTORED");
        logger.info(`[CrashRecovery] Restored snapshot from ${new Date(snapshot.timestamp).toLocaleString()}`);
        return true;
    } catch (e) {
        logger.error('[CrashRecovery] Restore failed', e);
        toast.error("RESTORE FAILED");
        return false;
    }
}

// === Initialization ===

export function initCrashRecovery(): void {
    // Subscribe to state changes for auto-save
    state.subscribeAll(() => {
        _hasUnsavedChanges = true;
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

        const modal = document.getElementById('confirmModal');
        if (!modal) {
            resolve(false);
            return;
        }

        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMessage');
        const yesBtn = document.getElementById('confirmYes');
        const noBtn = document.getElementById('confirmNo');

        if (titleEl) titleEl.innerText = 'CRASH RECOVERY';
        if (msgEl) msgEl.innerText = `We detected an unsaved session from ${ageStr}.\nRestore it?`;
        _restorePromptOpen = true;
        const done = (v: boolean) => { _restorePromptOpen = false; resolve(v); };
        if (yesBtn) {
            yesBtn.onclick = async () => {
                closeModal(modal);
                const ok = await restoreSnapshot();
                done(ok);
            };
        }
        if (noBtn) {
            noBtn.onclick = () => {
                closeModal(modal);
                clearSnapshots();
                toast.info("Crash session discarded.");
                done(false);
            };
        }
        // Via the shared modal API so ESC/close behaves like every other modal
        openModal(modal);
    });
}
