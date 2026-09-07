/**
 * Session Save/Load module for Gangsta Player Pro 3
 *
 * Serializes and restores the full app state:
 *   - Kit (pad samples, volumes, BPMs, sync)
 *   - Playlist (track list)
 *   - Settings (AutoMix configuration)
 *   - UI state (volume, tempo, loop mode, playback mode)
 */

import './types';
import { state, Track, LoopMode, PlaybackMode } from './state';
import { settings, saveSettings, applySettingsToUI, updateAutoMix } from './settings';
import { NUM_PADS } from './constants';
import { toast } from './toast';
import { logger } from './logger';
import {
    padPaths,
    padVolumes,
    padBPMs,
    padSyncState,
    loadSampleFromPath,
    padBuffers,
    padWaveforms,
    padLoopStart,
    padLoopEnd,
} from './sampler';

// ==================== SESSION INTEGRITY ====================
// Honest corruption-evidence checksum (SHA-256, no secret). A stored HMAC key
// in the same localStorage as the data can't stop an attacker who can read
// both — so we don't pretend. This catches truncated/edited/corrupt files.

/** One-time purge of the legacy HMAC key (no longer used — see above). */
export function purgeLegacySessionKey(): void {
    try {
        localStorage.removeItem('ug_session_hmac_key');
    } catch { /* storage unavailable — nothing to purge */ }
}
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const keys = Object.keys(value as Record<string, unknown>).filter(k => k !== 'signature').sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
async function sha256Hex(data: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function verifyChecksum(data: string, expected: string): Promise<boolean> {
    try {
        if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
        const actual = await sha256Hex(data);
        return actual.toLowerCase() === expected.toLowerCase();
    } catch {
        return false;
    }
}

function clampNum(v: unknown, lo: number, hi: number, fb: number): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
}

function isValidTrack(t: unknown): t is Track {
    if (!t || typeof t !== 'object') return false;
    const o = t as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string';
}

// === Types ===

interface SessionPad {
    index: number;
    path: string;
    vol: number;
    bpm?: number;
    sync?: boolean;
    loopStart?: number;
    loopEnd?: number;
}

interface SessionData {
    version: number;
    name: string;
    signature?: string; // SHA-256 corruption-evidence checksum (not a secret)
    kit: {
        pads: SessionPad[];
    };
    playlist: Track[];
    settings: {
        autoMix: {
            eqCrossfade: boolean;
            filterSweep: boolean;
            hpfSweep: boolean;
            bpmSync: boolean;
            trackDuration: number;
            btnDuration: number;
        };
    };
    ui: {
        masterVolume: number;
        tempoValue: number;
        loopMode: LoopMode;
        playbackMode: PlaybackMode;
        isAutoMixEnabled: boolean;
    };
}

const SESSION_VERSION = 1;

// === Save ===

export async function saveSession(): Promise<void> {
    try {
        // Dedicated session dialog: the default filename already carries the
        // .session.json extension. Rewriting the returned path (the old
        // approach) desynced it from the main-process write allowlist and
        // every save silently failed while claiming success.
        let filePath: string | null | undefined;
        if (window.electronAPI?.saveSessionDialog) {
            filePath = await window.electronAPI.saveSessionDialog();
            if (!filePath) return;
        } else if (window.electronAPI?.saveKit) {
            filePath = await window.electronAPI.saveKit();
            if (!filePath) return;
        } else {
            toast.error("SESSION SAVE NOT AVAILABLE");
            return;
        }

        // Collect pad data (incl. loop points — previously dropped on every save)
        const pads: SessionPad[] = [];
        for (let i = 0; i < NUM_PADS; i++) {
            if (padPaths[i]) {
                const ls = padLoopStart[i];
                const le = padLoopEnd[i];
                pads.push({
                    index: i,
                    path: padPaths[i],
                    vol: padVolumes[i] ?? 0.75,
                    bpm: padBPMs[i] || undefined,
                    sync: padSyncState[i] || undefined,
                    loopStart: (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) ? ls : undefined,
                    loopEnd: (typeof le === 'number' && Number.isFinite(le) && le > 0) ? le : undefined,
                });
            }
        }

        const session: SessionData = {
            version: SESSION_VERSION,
            name: "Gangsta Session",
            signature: undefined, // Will be set after HMAC computation
            kit: { pads },
            playlist: state.playlist,
            settings: {
                autoMix: {
                    eqCrossfade: settings.autoMix.eqCrossfade,
                    filterSweep: settings.autoMix.filterSweep,
                    hpfSweep: settings.autoMix.hpfSweep,
                    bpmSync: settings.autoMix.bpmSync,
                    trackDuration: settings.autoMix.trackDuration,
                    btnDuration: settings.autoMix.btnDuration,
                },
            },
            ui: {
                masterVolume: parseFloat((document.getElementById('masterVol') as HTMLInputElement)?.value || '1'),
                tempoValue: parseFloat((document.getElementById('tempoSlider') as HTMLInputElement)?.value || '1'),
                loopMode: state.loopMode,
                playbackMode: state.playbackMode,
                isAutoMixEnabled: state.isAutoMixEnabled,
            },
        };

        // Corruption-evidence checksum over canonical form (key-sorted, whitespace-insensitive).
        session.signature = await sha256Hex(canonicalize(session));

        const fs = window.fileSystem;
        if (fs?.saveFile) {
            const ok = await fs.saveFile(filePath, new TextEncoder().encode(JSON.stringify(session, null, 2)));
            // fs.saveFile returns false when the main process rejects the write —
            // previously this was ignored and "SESSION SAVED" was shown regardless.
            if (ok) {
                toast.success("SESSION SAVED");
                logger.info(`[Session] Saved to ${filePath}`);
            } else {
                toast.error("SESSION SAVE FAILED (WRITE REJECTED)");
                logger.error(`[Session] Main process rejected write to ${filePath}`);
            }
        }
    } catch (err) {
        logger.error('[Session] Save failed', err);
        toast.error("SESSION SAVE FAILED");
    }
}

// === Load ===

export async function loadSession(): Promise<void> {
    let rollback: {
        playlist: Track[];
        selectedIndices: number[];
        currentTrackIndex: number;
        loopMode: LoopMode;
        playbackMode: PlaybackMode;
        masterBPM: number;
        isAutoMixEnabled: boolean;
        blendingIndex: number;
        pads: Array<{ buf: AudioBuffer | undefined; path: string; vol: number; bpm: number; sync: boolean; ls: number; le: number }>;
    } | null = null;
    const restoreRollback = () => {
        if (!rollback) return;
        try {
            state.update({
                playlist: rollback.playlist,
                selectedIndices: rollback.selectedIndices,
                currentTrackIndex: rollback.currentTrackIndex,
                isPlaying: false,
                loopMode: rollback.loopMode,
                playbackMode: rollback.playbackMode,
                masterBPM: rollback.masterBPM,
                isAutoMixEnabled: rollback.isAutoMixEnabled,
                blendingIndex: rollback.blendingIndex,
            });
            rollback.pads.forEach((p, i) => {
                if (p.buf) padBuffers[i] = p.buf;
                padPaths[i] = p.path;
                padVolumes[i] = p.vol;
                padBPMs[i] = p.bpm;
                padSyncState[i] = p.sync;
                padLoopStart[i] = p.ls;
                padLoopEnd[i] = p.le;
            });
        } catch { /* best-effort */ }
    };
    try {
        let filePath: string | null | undefined;

        if (window.electronAPI?.loadKit) {
            filePath = await window.electronAPI.loadKit();
            if (!filePath) return;
        } else {
            toast.error("SESSION LOAD NOT AVAILABLE");
            return;
        }

        const fs = window.fileSystem;
        if (!fs?.readFile) {
            toast.error("SESSION LOAD NOT AVAILABLE");
            return;
        }

        const rawData = await fs.readFile(filePath);
        const rawLen = (rawData as unknown as { byteLength?: number; length?: number })?.byteLength
            ?? (rawData as unknown as { length?: number })?.length ?? 0;
        if (!rawData || rawLen > 25 * 1024 * 1024) {
            toast.error("SESSION FILE TOO LARGE OR UNREADABLE");
            return;
        }
        const jsonStr = new TextDecoder().decode(rawData as Uint8Array);
        const session: SessionData = JSON.parse(jsonStr);

        // Verify checksum (corruption evidence only — not attacker-proof)
        if (session.signature) {
            const isValid = await verifyChecksum(canonicalize(session), session.signature);
            if (!isValid) {
                logger.error('[Session] Checksum mismatch - file is corrupt or was edited outside the app');
                toast.error("SESSION CORRUPTED - LOAD ABORTED");
                return;
            }
        } else {
            // Legacy session without signature - warn but allow loading (for backward compatibility)
            logger.warn('[Session] No checksum found - loading legacy session (no integrity check)');
        }

        if (session.version !== SESSION_VERSION) {
            logger.warn(`[Session] Version mismatch: expected ${SESSION_VERSION}, got ${session.version}`);
        }

        // 1. Snapshot current state first — a failed kit restore must not
        // destroy the working kit with no rollback.
        const padSnap = Array.from({ length: NUM_PADS }, (_, i) => ({
            buf: padBuffers[i],
            path: padPaths[i] ?? '',
            vol: padVolumes[i] ?? 0.75,
            bpm: padBPMs[i] ?? 0,
            sync: !!padSyncState[i],
            ls: padLoopStart[i] ?? -1,
            le: padLoopEnd[i] ?? -1,
        }));
        rollback = {
            playlist: [...state.playlist],
            selectedIndices: [...state.selectedIndices],
            currentTrackIndex: state.currentTrackIndex,
            loopMode: state.loopMode,
            playbackMode: state.playbackMode,
            masterBPM: state.masterBPM,
            isAutoMixEnabled: state.isAutoMixEnabled,
            blendingIndex: state.blendingIndex,
            pads: padSnap,
        };
        try {
            const { clearAnalysisQueue } = await import('./playlist');
            clearAnalysisQueue();
        } catch { /* ignore */ }
        state.update({
            playlist: [],
            selectedIndices: [],
            currentTrackIndex: -1,
            isPlaying: false,
        });

        // 2. Load playlist (validated, bounded — crafted files must not OOM)
        if (Array.isArray(session.playlist)) {
            const clean = session.playlist.filter(isValidTrack).slice(0, 2000).map(t => ({
                id: String(t.id).slice(0, 128),
                name: String(t.name).slice(0, 512),
                path: String(t.path).slice(0, 32760),
                duration: clampNum(t.duration, 0, 86400, 0),
                bpm: t.bpm === undefined ? undefined : clampNum(t.bpm, 0, 300, 0),
            }));
            state.update({ playlist: clean });
        }

        // 3. Load kit
        if (session.kit?.pads && Array.isArray(session.kit.pads)) {
            // Clear existing pads (incl. loop points — stale loops must not survive)
            for (let i = 0; i < NUM_PADS; i++) {
                padBuffers[i] = undefined!;
                padPaths[i] = '';
                padWaveforms[i] = undefined!;
                padBPMs[i] = 0;
                padSyncState[i] = false;
                padLoopStart[i] = -1;
                padLoopEnd[i] = -1;
            }

            // Sequential loads: 16 parallel decodeAudioData of arbitrary files OOMs.
            // Per-pad timeout so one huge/missing file can't stall the restore.
            const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('pad load timeout')), ms))]);
            for (const p of session.kit.pads.slice(0, NUM_PADS)) {
                const idx = Number((p as SessionPad)?.index);
                const ppath = typeof (p as SessionPad)?.path === 'string' ? (p as SessionPad).path.slice(0, 32760) : '';
                if (!ppath || !Number.isInteger(idx) || idx < 0 || idx >= NUM_PADS) continue;
                try {
                    await withTimeout(loadSampleFromPath(ppath, idx), 20000);
                    const vol = (p as SessionPad).vol;
                    if (typeof vol === 'number' && Number.isFinite(vol)) padVolumes[idx] = Math.min(1, Math.max(0, vol));
                    const bpm = (p as SessionPad).bpm;
                    if (typeof bpm === 'number' && Number.isFinite(bpm)) padBPMs[idx] = Math.min(300, Math.max(0, bpm));
                    if (typeof (p as SessionPad).sync === 'boolean') padSyncState[idx] = (p as SessionPad).sync as boolean;
                    const ls = (p as SessionPad).loopStart;
                    const le = (p as SessionPad).loopEnd;
                    if (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) padLoopStart[idx] = ls;
                    if (typeof le === 'number' && Number.isFinite(le) && le > 0) padLoopEnd[idx] = le;

                    // Update the volume slider UI
                    const grid = document.getElementById('padGrid');
                    const slider = grid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                    if (slider) slider.value = padVolumes[idx].toString();
                    try {
                        const { renderWaveform } = await import('./sampler');
                        renderWaveform(idx);
                    } catch { /* ignore */ }
                } catch { /* per-pad failure is non-fatal */ }
            }
        }

        // 4. Restore settings.
        // applySettingsToUI() MUST run before saveSettings() — saveSettings
        // reads the DOM checkboxes, and stale checkboxes were overwriting the
        // restored values immediately after load.
        if (session.settings?.autoMix) {
            const { eqCrossfade, filterSweep, hpfSweep, bpmSync, trackDuration, btnDuration } = session.settings.autoMix;
            const bool = (v: unknown, fb: boolean): boolean => typeof v === 'boolean' ? v : fb;
            updateAutoMix({
                eqCrossfade: bool(eqCrossfade, true),
                filterSweep: bool(filterSweep, true),
                hpfSweep: bool(hpfSweep, true),
                bpmSync: bool(bpmSync, false),
                trackDuration: clampNum(trackDuration, 0.5, 60, 10),
                btnDuration: clampNum(btnDuration, 0.5, 30, 4),
            });
            applySettingsToUI();
        }

        // 5. Restore UI
        if (session.ui) {
            const volSlider = document.getElementById('masterVol') as HTMLInputElement;
            if (volSlider && session.ui.masterVolume !== undefined) {
                const mv = clampNum(session.ui.masterVolume, 0, 1, 1);
                volSlider.value = mv.toString();
                volSlider.dispatchEvent(new Event('input'));
            }

            const tempo = document.getElementById('tempoSlider') as HTMLInputElement;
            if (tempo && session.ui.tempoValue !== undefined) {
                const tv = clampNum(session.ui.tempoValue, 0.5, 1.5, 1);
                tempo.value = tv.toString();
                tempo.dispatchEvent(new Event('input'));
            }

            const VALID_LOOP = new Set(['off', 'one', 'all']);
            const VALID_PLAY = new Set(['continuous', 'single']);
            if (typeof session.ui.loopMode === 'string' && VALID_LOOP.has(session.ui.loopMode)) {
                state.update({ loopMode: session.ui.loopMode as 'off' | 'one' | 'all' });
            }
            if (typeof session.ui.playbackMode === 'string' && VALID_PLAY.has(session.ui.playbackMode)) {
                state.update({ playbackMode: session.ui.playbackMode as 'continuous' | 'single' });
            }
            if (typeof session.ui.isAutoMixEnabled === 'boolean') {
                state.update({ isAutoMixEnabled: session.ui.isAutoMixEnabled });
            }
        }

        try {
            const { renderPlaylist } = await import('./playlist');
            renderPlaylist();
        } catch { /* playlist UI refresh is best-effort */ }
        toast.success("SESSION LOADED");
        logger.info(`[Session] Loaded from ${filePath}`);
    } catch (err) {
        logger.error('[Session] Load failed — rolling back', err);
        try { restoreRollback(); } catch { /* ignore */ }
        try {
            const { renderPlaylist } = await import('./playlist');
            renderPlaylist();
        } catch { /* ignore */ }
        toast.error("SESSION LOAD FAILED — PREVIOUS STATE RESTORED");
    }
}
