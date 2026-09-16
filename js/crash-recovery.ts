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
    padLoopStart, padLoopEnd, padWaveforms,
    loadSampleFromPath
} from './sampler';
import { showConfirm } from './modals';
import { AUTO_SAVE_INTERVAL_MS, MAX_SNAPSHOTS, MIN_SAVE_INTERVAL_MS, NUM_PADS } from './constants';

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
// H30: cooperative cancel for the sequential pad-restore loop.
let _restoreCancelled = false;
// Throttle for the autosave-failure toast (see saveSnapshot).
let _saveFailToastAt = 0;

/** Cancel an in-flight snapshot pad restore (overall cancel, fail fast). */
export function cancelSnapshotRestore(): void {
    _restoreCancelled = true;
}

// === Snapshot Management ===

function getSnapshotKey(index = 0): string {
    return index === 0 ? STORAGE_KEY : `${STORAGE_KEY}_${index}`;
}

function saveToStorage(key: string, data: CrashSnapshot): boolean {
    try {
        const json = JSON.stringify(data);
        // M27: cap total under the ~5MB quota. Live + single backup must fit
        // together — 1.5MB per slot keeps the pair (~3MB) safely inside.
        if (json.length > 1_500_000) {
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
        if (raw.length > 1_500_000) { try { localStorage.removeItem(key); } catch { /* ignore */ } return null; }
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

// Archive retention: unbounded `_archive_${Date.now()}` keys previously grew
// without limit against the ~5MB quota. Keep newest MAX_SNAPSHOTS, expire after 14d.
export const MAX_SNAPSHOT_ARCHIVES = MAX_SNAPSHOTS;
export const SNAPSHOT_ARCHIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function archivePrefix(): string {
    return `${STORAGE_KEY}_archive_`;
}
function listArchiveKeys(): string[] {
    const found = new Set<string>();
    try {
        const ls = localStorage as unknown as { length?: unknown; key?: (i: number) => string | null };
        if (typeof ls.length === 'number' && typeof ls.key === 'function') {
            for (let i = 0; i < (ls.length as number); i++) {
                try {
                    const k = ls.key(i);
                    if (typeof k === 'string' && k.startsWith(archivePrefix())) found.add(k);
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
    try {
        const idxRaw = localStorage.getItem(`${STORAGE_KEY}_archive_index`);
        if (idxRaw) {
            const arr = JSON.parse(idxRaw) as unknown;
            if (Array.isArray(arr)) {
                for (const k of arr) {
                    if (typeof k === 'string' && k.startsWith(archivePrefix())) found.add(k);
                }
            }
        }
    } catch { /* ignore */ }
    return [...found];
}
export function pruneSnapshotArchives(now = Date.now()): void {
    try {
        const keys = listArchiveKeys();
        // 14d expiry first.
        for (const k of keys) {
            const ts = Number(k.slice(archivePrefix().length));
            if (Number.isFinite(ts) && now - ts > SNAPSHOT_ARCHIVE_TTL_MS) {
                try { localStorage.removeItem(k); } catch { /* ignore */ }
            }
        }
        // Cap: keep newest 3 (timestamp suffix sorts chronologically).
        const remaining = listArchiveKeys().sort();
        while (remaining.length > MAX_SNAPSHOT_ARCHIVES) {
            const oldest = remaining.shift();
            if (!oldest) break;
            try { localStorage.removeItem(oldest); } catch { /* ignore */ }
        }
        // Persist pruned index for length/key-less environments.
        try {
            const live = listArchiveKeys().sort();
            // Rebuild index from enumeration when available; otherwise prune stored index.
            if (live.length > 0) {
                localStorage.setItem(`${STORAGE_KEY}_archive_index`, JSON.stringify(live));
            } else {
                const idxRaw = localStorage.getItem(`${STORAGE_KEY}_archive_index`);
                if (idxRaw) {
                    try {
                        const arr = JSON.parse(idxRaw) as unknown;
                        if (Array.isArray(arr)) {
                            const kept = (arr as unknown[]).filter((k): k is string =>
                                typeof k === 'string' && remaining.includes(k));
                            localStorage.setItem(`${STORAGE_KEY}_archive_index`, JSON.stringify(kept));
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    } catch { /* ignore */ }
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
    // Suppressed during restore — the restore's own state writes must not
    // re-dirty and resurrect snapshots mid-restore.
    if (_restoring) return;
    const now = Date.now();
    // beforeunload must bypass the throttle — otherwise a crash within 10s of
    // the last save loses up to ~40s of work.
    if (reason !== 'beforeunload' && now - _lastSaveTime < MIN_SAVE_INTERVAL_MS) return;

    const snapshot = collectSnapshot(reason);

    // H29: write-then-rotate. Stage the newest snapshot FIRST and verify it
    // landed before touching history — a quota failure must never destroy
    // the previous newest (STORAGE_KEY) or its backups.
    const stagingKey = `${STORAGE_KEY}_staging`;
    const failToast = (msg: string) => {
        try {
            const now2 = Date.now();
            if (now2 - _saveFailToastAt > 5 * 60 * 1000) {
                _saveFailToastAt = now2;
                toast.error(msg);
            }
        } catch { /* ignore */ }
    };
    const markOverCapWarning = () => {
        try { localStorage.setItem('ug_crash_snapshot_warning', String(Date.now())); } catch { /* ignore */ }
    };
    if (!saveToStorage(stagingKey, snapshot)) {
        // Over-cap fallback: full snapshot (pads + waveforms paths) exceeds
        // 1.5MB — retry playlist-only (no pads, truncated playlist) so crash
        // protection degrades instead of dying. Persistent warning flag lets
        // the UI surface degraded mode across reloads.
        logger.warn('[CrashRecovery] Snapshot save failed (quota?) — trying playlist-only fallback');
        try {
            const minimal: CrashSnapshot = {
                ...snapshot,
                pads: {},
                playlist: snapshot.playlist.slice(0, 200),
                reason: `${snapshot.reason || 'periodic'}:minimal`,
            };
            if (saveToStorage(stagingKey, minimal)) {
                const stagedMin = loadFromStorage(stagingKey);
                if (stagedMin) {
                    const prev0m = loadFromStorage(STORAGE_KEY);
                    if (prev0m) saveToStorage(getSnapshotKey(1), prev0m);
                    if (saveToStorage(STORAGE_KEY, stagedMin)) {
                        removeFromStorage(stagingKey);
                        _lastSaveTime = now;
                        _hasUnsavedChanges = false;
                        markOverCapWarning();
                        logger.warn('[CrashRecovery] Saved playlist-only fallback snapshot (pads dropped — storage over-cap)');
                        failToast('AUTOSAVE DEGRADED (STORAGE FULL?) — PADS NOT SAVED');
                        return;
                    }
                }
            }
        } catch { /* fallback best-effort */ }
        logger.warn('[CrashRecovery] Snapshot save failed (quota?) — history untouched, will retry');
        // Silent warn-only previously left the user believing autosave was on
        // while nothing persisted (e.g. 2000-track playlist over the 1.5MB
        // cap). Surface it, throttled — every-30s nagging would be worse.
        failToast('AUTOSAVE FAILED (STORAGE FULL?) — CRASH PROTECTION OFF');
        return;
    }
    const staged = loadFromStorage(stagingKey);
    if (!staged) {
        logger.warn('[CrashRecovery] Snapshot staging verify failed — history untouched, will retry');
        return;
    }

    // Read history before overwriting (oldest-first write order).
    // M27: single slot + backup only — the old 3x4MB rotation (~12MB) could
    // never fit the ~5MB quota and quota-failed every save.
    const prev0 = loadFromStorage(STORAGE_KEY);
    let ok = true;
    if (prev0) ok = saveToStorage(getSnapshotKey(1), prev0) && ok;

    // Promote staged newest to the live slot.
    ok = saveToStorage(STORAGE_KEY, staged) && ok;
    if (ok) {
        removeFromStorage(stagingKey);
        _lastSaveTime = now;
        _hasUnsavedChanges = false;
        logger.debug(`[CrashRecovery] Snapshot saved (${reason || 'periodic'})`);
    } else {
        // Live slot write failed but the newest survives in staging —
        // getLatestSnapshot() falls back to it, so nothing is lost.
        logger.warn('[CrashRecovery] Snapshot promote failed (quota?) — newest kept in staging, will retry');
    }
}

// === Restore Snapshot ===

export function getLatestSnapshot(): CrashSnapshot | null {
    // Enforce archive retention on every read so expired archives can't
    // accumulate when restores never run.
    try { pruneSnapshotArchives(); } catch { /* ignore */ }
    // Rotation: newest is STORAGE_KEY, older copy in _1 (single backup).
    // Staging holds a newest that failed to promote (quota) — prefer live,
    // fall back to staging before history so it is never lost.
    // M27: _2 retired (see saveSnapshot) — still checked last for legacy builds.
    const snap = loadFromStorage(STORAGE_KEY) || loadFromStorage(`${STORAGE_KEY}_staging`) || loadFromStorage(getSnapshotKey(1)) || loadFromStorage(getSnapshotKey(2));
    // Expiry: an ancient snapshot (weeks old) is almost never what the user
    // wants — previously a 6-month-old crash still prompted "Restore?", and
    // YES clobbered current work. 14 days is generous for crash recovery.
    if (snap && typeof snap.timestamp === 'number' && Number.isFinite(snap.timestamp)) {
        if (Date.now() - snap.timestamp > 14 * 24 * 60 * 60 * 1000) {
            logger.info('[CrashRecovery] Ignoring expired snapshot from ' + new Date(snap.timestamp).toLocaleString());
            try { clearSnapshots(); } catch { /* ignore */ }
            return null;
        }
    }
    return snap;
}

export function clearSnapshots(): void {
    // Also purge the legacy _bak key from older builds
    removeFromStorage('ug_crash_snapshot_bak');
    removeFromStorage(`${STORAGE_KEY}_staging`);
    removeFromStorage(STORAGE_KEY);
    // M27: single backup — keep the loop bounded to live + _1 (+ legacy _2 purge).
    for (let i = 1; i <= 2; i++) {
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
    // Stage-then-commit backup (matches session.ts:365-388 rollback): capture
    // live pads/playlist BEFORE any mutation so a failed pad reload can
    // restore them. Never clearSnapshots on partial success — archive instead.
    const readSliderNumber = (id: string): number | null => {
        try {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return null;
            const v = Number(el.value);
            return Number.isFinite(v) ? v : null;
        } catch { return null; }
    };
    const liveBackup = {
        playlist: [...state.playlist],
        selectedIndices: [...state.selectedIndices],
        currentTrackIndex: state.currentTrackIndex,
        masterBPM: state.masterBPM,
        loopMode: state.loopMode,
        playbackMode: state.playbackMode,
        isAutoMixEnabled: state.isAutoMixEnabled,
        blendingIndex: state.blendingIndex,
        isPlaying: state.isPlaying,
        isCrossfadeInProgress: state.isCrossfadeInProgress,
        masterVolume: readSliderNumber('masterVol'),
        tempoValue: readSliderNumber('tempoSlider'),
        pads: Array.from({ length: NUM_PADS }, (_, i) => ({
            buf: (padBuffers as unknown as unknown[])[i],
            path: padPaths[i] ?? '',
            vol: padVolumes[i] ?? 0.75,
            bpm: padBPMs[i] ?? 0,
            sync: !!padSyncState[i],
            ls: padLoopStart[i] ?? -1,
            le: padLoopEnd[i] ?? -1,
            wf: (padWaveforms as unknown as unknown[])[i],
        })),
    };
    const restoreLive = () => {
        try {
            state.update({
                playlist: liveBackup.playlist,
                selectedIndices: liveBackup.selectedIndices,
                currentTrackIndex: liveBackup.currentTrackIndex,
                masterBPM: liveBackup.masterBPM,
                loopMode: liveBackup.loopMode,
                playbackMode: liveBackup.playbackMode,
                isAutoMixEnabled: liveBackup.isAutoMixEnabled,
                blendingIndex: liveBackup.blendingIndex,
                isPlaying: false,
                isCrossfadeInProgress: false,
            });
            liveBackup.pads.forEach((p, i) => {
                try {
                    (padBuffers as unknown as unknown[])[i] = p.buf;
                    padPaths[i] = p.path;
                    padVolumes[i] = p.vol;
                    padBPMs[i] = p.bpm;
                    padSyncState[i] = p.sync;
                    padLoopStart[i] = p.ls;
                    padLoopEnd[i] = p.le;
                    (padWaveforms as unknown as unknown[])[i] = p.wf;
                } catch { /* ignore */ }
            });
            // Gate-3: a partial failure previously left volume/tempo mutated
            // (sliders actuated pre-pad-loop) and waveforms empty (cleared,
            // never restored). Restore captured slider positions + pad UI.
            try {
                if (liveBackup.masterVolume !== null) {
                    const volSlider = document.getElementById('masterVol') as HTMLInputElement | null;
                    if (volSlider) {
                        volSlider.value = String(liveBackup.masterVolume);
                        volSlider.dispatchEvent(new Event('input'));
                    }
                }
                if (liveBackup.tempoValue !== null) {
                    const tempo = document.getElementById('tempoSlider') as HTMLInputElement | null;
                    if (tempo) {
                        tempo.value = String(liveBackup.tempoValue);
                        tempo.dispatchEvent(new Event('input'));
                    }
                }
            } catch { /* ignore */ }
            try {
                const grid = document.getElementById('padGrid');
                liveBackup.pads.forEach((p, i) => {
                    try {
                        const slider = grid?.children[i]?.querySelector('.pad-slider') as HTMLInputElement | null;
                        if (slider) slider.value = String(p.vol);
                    } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            // Best-effort waveform repaint so pads don't stay visually empty.
            try {
                void import('./sampler').then((m) => {
                    liveBackup.pads.forEach((_p, i) => {
                        try {
                            if ((padWaveforms as unknown as unknown[])[i] !== undefined) m.renderWaveform(i);
                        } catch { /* ignore */ }
                    });
                }).catch(() => undefined);
            } catch { /* ignore */ }
        } catch { /* best-effort */ }
    };
    const archiveSnapshot = () => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const key = `${STORAGE_KEY}_archive_${Date.now()}`;
            try { localStorage.setItem(key, raw); } catch { /* quota — skip archiving */ }
            // Track index for environments without length/key enumeration (tests).
            try {
                const idxRaw = localStorage.getItem(`${STORAGE_KEY}_archive_index`);
                const idx: string[] = idxRaw ? (JSON.parse(idxRaw) as string[]) : [];
                if (Array.isArray(idx)) {
                    idx.push(key);
                    localStorage.setItem(`${STORAGE_KEY}_archive_index`, JSON.stringify(idx));
                }
            } catch { /* ignore */ }
            pruneSnapshotArchives();
        } catch { /* ignore */ }
    };
    let hadFailure = false;
    try {
        // Stop the live deck BEFORE swapping the list (M18) — restoring
        // while the old track plays leaves audio pointing at a playlist
        // that no longer contains it, with a stale currentTrackIndex.
        try {
            const { abortCrossfade } = await import('./player');
            abortCrossfade();
        } catch { /* ignore */ }
        try {
            const { engine } = await import('./audio-engine');
            try { engine.main.audio.pause(); } catch { /* ignore */ }
            try { engine.main.audio.removeAttribute('src'); engine.main.audio.load(); }
            catch { try { engine.main.audio.src = ''; } catch { /* ignore */ } }
            try { engine.crossfade.audio.pause(); } catch { /* ignore */ }
            try { engine.crossfade.audio.removeAttribute('src'); engine.crossfade.audio.load(); }
            catch { try { engine.crossfade.audio.src = ''; } catch { /* ignore */ } }
        } catch { /* ignore */ }
        // Stage playlist (validated) but commit only after pads prove loadable.
        let stagedPlaylist: Track[] | null = null;
        let stagedIndex = -1;
        let stagedBPM = 0;
        // 1. Stage playlist (validated + bounded like session restore —
        // untrusted localStorage must not OOM the renderer). Committed only
        // after pads prove loadable (stage-then-commit).
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
            stagedPlaylist = clean;
            stagedIndex = cur >= 0 && cur < clean.length ? cur : -1;
            stagedBPM = typeof snapshot.masterBPM === 'number' && Number.isFinite(snapshot.masterBPM) ? snapshot.masterBPM : 0;
        }

        // 2. Stage UI updates (committed only on full success).
        // Gate-3: sliders must NOT be actuated before the pad loop — a
        // partial pad failure previously left volume/tempo mutated while
        // restoreLive() restored only state/pads. Stage values here, actuate
        // after pads prove loadable (commit block below).
        let stagedUiUpdates: Record<string, unknown> | null = null;
        let stagedMasterVolume: number | null = null;
        let stagedTempoValue: number | null = null;
        if (snapshot.ui) {
            const clamp = (v: unknown, lo: number, hi: number): number | null => {
                const n = typeof v === 'number' ? v : parseFloat(String(v));
                if (!Number.isFinite(n)) return null;
                return Math.min(hi, Math.max(lo, n));
            };
            if (snapshot.ui.masterVolume !== undefined) {
                stagedMasterVolume = clamp(snapshot.ui.masterVolume, 0, 1);
            }
            if (snapshot.ui.tempoValue !== undefined) {
                stagedTempoValue = clamp(snapshot.ui.tempoValue, 0.5, 1.5);
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
            if (Object.keys(updates).length > 0) stagedUiUpdates = updates;
        }

        // 3. Restore sampler pads — H30: fail fast on missing files, per-pad
        // timeout (8s) plus an overall budget (60s) with cooperative cancel
        // so 16 missing files can't stall startup for minutes.
        // Stage-then-commit: live pads are backed up above; cleared here for
        // the load attempt, restored on any failure (no partial clobber).
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
            Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('pad restore timeout')), ms))]);
        const PER_PAD_RESTORE_MS = 8000;
        const OVERALL_RESTORE_BUDGET_MS = 60000;
        const restoreStart = Date.now();
        _restoreCancelled = false;
        // Clear live pads for the attempt (ghost-audio fix): restored on
        // failure via restoreLive() below.
        for (let i = 0; i < NUM_PADS; i++) {
            try { (padBuffers as any)[i] = undefined; } catch { /* ignore */ }
            try { padPaths[i] = ''; } catch { /* ignore */ }
            try { (padWaveforms as any)[i] = undefined; } catch { /* ignore */ }
            try { padBPMs[i] = 0; } catch { /* ignore */ }
            try { padSyncState[i] = false; } catch { /* ignore */ }
            try { padLoopStart[i] = -1; } catch { /* ignore */ }
            try { padLoopEnd[i] = -1; } catch { /* ignore */ }
        }
        // Pause live state swap until pads prove loadable.
        state.update({ isPlaying: false, isCrossfadeInProgress: false, blendingIndex: -1 });
        const padKeys = Object.keys(snapshot.pads || {});
        if (padKeys.length > 0) {
            for (const key of padKeys) {
                if (_restoreCancelled) {
                    logger.info('[CrashRecovery] Pad restore cancelled — rolling back to live kit');
                    hadFailure = true;
                    break;
                }
                if (Date.now() - restoreStart > OVERALL_RESTORE_BUDGET_MS) {
                    logger.warn('[CrashRecovery] Pad restore budget exceeded — rolling back to live kit');
                    hadFailure = true;
                    break;
                }
                const idx = parseInt(key);
                const p = (snapshot.pads as Record<number, { path: string; vol: number; bpm: number; sync: boolean; loopStart?: number; loopEnd?: number }>)[idx];
                if (!p || !Number.isInteger(idx) || idx < 0 || idx >= NUM_PADS) continue;
                // Fail fast: empty/overlong paths can never load.
                if (typeof p.path !== 'string' || !p.path || p.path.length > 32760) {
                    logger.warn(`[CrashRecovery] Pad ${idx} skipped (missing path)`);
                    hadFailure = true;
                    continue;
                }
                // Don't claim padPaths before the file proves loadable —
                // otherwise failures leave ghost paths with no buffer.
                try {
                    const remaining = Math.max(1000, OVERALL_RESTORE_BUDGET_MS - (Date.now() - restoreStart));
                    await withTimeout(loadSampleFromPath(p.path, idx), Math.min(PER_PAD_RESTORE_MS, remaining));
                    padVolumes[idx] = (typeof p.vol === 'number' && Number.isFinite(p.vol)) ? Math.min(1, Math.max(0, p.vol)) : 0.75;
                    padBPMs[idx] = p.bpm || 0;
                    padSyncState[idx] = p.sync || false;
                    if (typeof p.loopStart === 'number' && Number.isFinite(p.loopStart) && p.loopStart >= 0) padLoopStart[idx] = p.loopStart;
                    if (typeof p.loopEnd === 'number' && Number.isFinite(p.loopEnd) && p.loopEnd > 0) padLoopEnd[idx] = p.loopEnd;
                } catch (err: unknown) {
                    logger.warn(`[CrashRecovery] Pad ${idx} reload failed: ${(err as Error)?.message || err}`);
                    hadFailure = true;
                    continue;
                }
                // Restore volume slider UI
                const grid = document.getElementById('padGrid');
                if (!grid) logger.warn(`[CrashRecovery] Pad ${idx} slider skipped (pad grid not built)`);
                const slider = grid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                if (slider) slider.value = padVolumes[idx].toString();
            }
        }
        if (hadFailure || _restoreCancelled) {
            // Partial success must never clobber live or clear history —
            // archive the snapshot and restore the live kit/playlist.
            restoreLive();
            archiveSnapshot();
            try {
                const { renderPlaylist } = await import('./playlist');
                renderPlaylist();
            } catch { /* ignore */ }
            logger.warn('[CrashRecovery] Restore incomplete — live kit preserved, snapshot archived');
            toast.error('RESTORE INCOMPLETE — LIVE KIT PRESERVED');
            return false;
        }
        // Commit staged playlist + UI only after all pads succeeded.
        // Slider actuation lives here (not pre-pad-loop) so a failure path
        // never leaves volume/tempo mutated.
        if (stagedPlaylist) {
            state.update({
                playlist: stagedPlaylist,
                currentTrackIndex: stagedIndex,
                masterBPM: stagedBPM,
            });
        } else {
            state.update({ isPlaying: false, isCrossfadeInProgress: false, blendingIndex: -1, masterBPM: 0 });
        }
        if (stagedUiUpdates) state.update(stagedUiUpdates);
        try {
            if (stagedMasterVolume !== null) {
                const volSlider = document.getElementById('masterVol') as HTMLInputElement | null;
                if (volSlider) {
                    volSlider.value = String(stagedMasterVolume);
                    volSlider.dispatchEvent(new Event('input'));
                }
            }
            if (stagedTempoValue !== null) {
                const tempo = document.getElementById('tempoSlider') as HTMLInputElement | null;
                if (tempo) {
                    tempo.value = String(stagedTempoValue);
                    tempo.dispatchEvent(new Event('input'));
                }
            }
        } catch { /* slider actuation is best-effort */ }

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
        try { restoreLive(); } catch { /* ignore */ }
        logger.error('[CrashRecovery] Restore failed', e);
        toast.error("RESTORE FAILED");
        return false;
    } finally {
        _restoring = false;
        _restoreCancelled = false;
    }
}

// === Initialization ===

export function initCrashRecovery(): void {
    // Already initialized: keep the live autosave timer. Clearing it here
    // then returning (old behavior) left _timer=null forever with an
    // "Initialized" log — crash protection silently dead on re-init/HMR.
    if (_crashInit) return;
    if (_timer) { clearInterval(_timer); _timer = null; }
    _crashInit = true;
    // Subscribe to state changes for auto-save (suppressed during restore so
    // the restore itself doesn't re-dirty and resurrect cleared snapshots).
    state.subscribeAll(() => {
        if (!_restoring) _hasUnsavedChanges = true;
    });

    // Listen for custom data-change events from sampler/playlist.
    // Suppressed during restore like the state subscription above —
    // otherwise the restore's own pad loads re-dirty immediately and the
    // just-cleared snapshot is resurrected on the next tick (prompt loop).
    document.addEventListener('ug:dataChanged', () => {
        if (!_restoring) _hasUnsavedChanges = true;
    });

    // Periodic auto-save timer
    _timer = setInterval(() => {
        if (_hasUnsavedChanges) {
            saveSnapshot('periodic');
        }
    }, AUTO_SAVE_INTERVAL_MS);

    // cancelSnapshotRestore() was previously exported but wired to nothing —
    // a 60s pad-restore budget couldn't be cut short. ESC during an active
    // restore (no modal open) now cancels the remaining pads; already-loaded
    // pads stay, matching the budget-exceeded path.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !_restoring) return;
        try {
            if (document.querySelector('.modal.active')) return; // modal ESC paths own it
        } catch { /* ignore */ }
        cancelSnapshotRestore();
        try { toast.info('RESTORE CANCELLED — LOADED PADS KEPT'); } catch { /* ignore */ }
    });

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
                // Reject-proof: restoreSnapshot() rejecting previously left
                // `done` uncalled, wedging checkAndRestore (and the DB load
                // gated behind it) forever.
                try {
                    restoreSnapshot().then(
                        (ok) => done(!!ok),
                        () => done(false)
                    );
                } catch {
                    done(false);
                }
            },
            () => {
                clearSnapshots();
                toast.info("Crash session discarded.");
                done(false);
            }
        );
    });
}
