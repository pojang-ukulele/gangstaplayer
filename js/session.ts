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
import { DIALOG_THROTTLED } from './types';
import { state, Track, LoopMode, PlaybackMode } from './state';
import { settings, applySettingsToUI, updateAutoMix } from './settings';
import { NUM_PADS, VALID_AUDIO_EXTENSIONS } from './constants';
import { toast } from './toast';
import { logger } from './logger';
import { sanitizeParsedJson } from './utils';
import {
    padPaths,
    padVolumes,
    padBPMs,
    padSyncState,
    padSnapToBeat,
    padBeatPositions,
    padBpmEstimated,
    loadSampleFromPath,
    recomputePadBeatGrid,
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
/** FNV-1a fallback for file:// / non-secure contexts without crypto.subtle. */
function fallbackHashHex(data: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < data.length; i++) {
        const c = data.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (c + (i & 0xff)), 0x01000193) >>> 0;
    }
    const mix = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
    // 64 hex chars to match SHA-256 shape (corruption-evidence only).
    return (mix(h1) + mix(h2) + mix(h1 ^ h2) + mix(h1 + h2) + mix(h1 ^ 0x9e3779b9) + mix(h2 ^ 0x85ebca6b) + mix(h1 + h2 + 1) + mix(h2 + h1 + 2)).slice(0, 64);
}
// FNV fallback is corruption-evidence only (weak:true) — not collision
// resistant. Saved sessions mark signatureWeak so verify can warn.
let _lastHashWeak = false;
let _lastHashWasStrong = false;
async function sha256Hex(data: string): Promise<string> {
    try {
        const subtle = (typeof crypto !== 'undefined' ? (crypto as Crypto).subtle : undefined);
        // M29: crypto.subtle is undefined in non-secure contexts (file://).
        if (!subtle || typeof subtle.digest !== 'function') {
            _lastHashWeak = true;
            return fallbackHashHex(data);
        }
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(data));
        _lastHashWasStrong = true;
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        _lastHashWeak = true;
        return fallbackHashHex(data);
    }
}
// FNV fallback is corruption-evidence only (weak:true) — not collision
// resistant. Saved sessions mark signatureWeak so verify can warn.
async function verifyChecksum(data: string, expected: string, wasWeak?: boolean): Promise<boolean> {
    try {
        if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
        if (wasWeak) {
            logger.warn('[Session] Checksum uses weak FNV fallback (non-secure context) — tamper-evidence reduced');
        }
        _lastHashWeak = false;
        _lastHashWasStrong = false;
        const actual = await sha256Hex(data);
        if (_lastHashWeak) {
            logger.warn('[Session] Verified with weak FNV fallback — integrity evidence reduced');
        }
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
    snap?: boolean;
    loopStart?: number;
    loopEnd?: number;
}

interface SessionData {
    version: number;
    name: string;
    signature?: string; // SHA-256 corruption-evidence checksum (not a secret)
    signatureWeak?: boolean; // true when FNV fallback was used (weak integrity)
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
            enableAI?: boolean;
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
            // Throttled dialog open returns the sentinel (truthy) — check
            // before the cancel guard or it would be treated as a real path.
            if (filePath === DIALOG_THROTTLED) {
                logger.debug('[Session] Save dialog throttled — TRY AGAIN');
                toast.info('DIALOG BUSY — TRY AGAIN');
                return;
            }
            if (!filePath) return;
        } else if (window.electronAPI?.saveKit) {
            filePath = await window.electronAPI.saveKit();
            if (filePath === DIALOG_THROTTLED) {
                logger.debug('[Session] Save dialog throttled — TRY AGAIN');
                toast.info('DIALOG BUSY — TRY AGAIN');
                return;
            }
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
                    snap: padSnapToBeat[i] === false ? false : undefined,
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
                    enableAI: settings.autoMix.enableAI,
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
        _lastHashWeak = false;
        _lastHashWasStrong = false;
        session.signature = await sha256Hex(canonicalize(session));
        session.signatureWeak = _lastHashWeak ? true : undefined;
        if (_lastHashWeak) {
            logger.warn('[Session] Saved with weak FNV checksum (non-secure context) — integrity evidence reduced');
        }

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

/** Bumps on every loadSession start AND on rollback — stale per-pad awaits check it. */
let sessionLoadGen = 0;

function readSliderNumber(id: string): number | null {
    try {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return null;
        const v = Number(el.value);
        return Number.isFinite(v) ? v : null;
    } catch { return null; }
}

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
        autoMix: { eqCrossfade: boolean; filterSweep: boolean; hpfSweep: boolean; bpmSync: boolean; trackDuration: number; btnDuration: number; enableAI: boolean };
        masterVolume: number | null;
        tempoValue: number | null;
        pads: Array<{ buf: AudioBuffer | undefined; path: string; vol: number; bpm: number; sync: boolean; snap: boolean | undefined; beats: number[]; est: boolean; ls: number; le: number; wf: unknown }>;
    } | null = null;
    // Generation guard: per-pad loads that time out keep running in the
    // background (no abort). Without this their late resolve overwrites the
    // pad — or the rollback — minutes later (ghost sample).
    const loadGen = ++sessionLoadGen;
    const restoreRollback = () => {
        if (!rollback) return;
        // Invalidate in-flight per-pad loads so their late resolves skip
        // post-await writes (ghost samples over the restored kit).
        sessionLoadGen++;
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
                else padBuffers[i] = undefined!;
                padPaths[i] = p.path;
                padVolumes[i] = p.vol;
                padBPMs[i] = p.bpm;
                padSyncState[i] = p.sync;
                if (p.snap === false || p.snap === true) padSnapToBeat[i] = p.snap;
                else delete padSnapToBeat[i];
                if (Array.isArray(p.beats)) padBeatPositions[i] = [...p.beats];
                if (p.est) padBpmEstimated[i] = true;
                else try { delete padBpmEstimated[i]; } catch { /* ignore */ }
                padLoopStart[i] = p.ls;
                padLoopEnd[i] = p.le;
                try { (padWaveforms as unknown as unknown[])[i] = p.wf; } catch { /* ignore */ }
            });
            // Rollback previously restored playlist+pads but left the restored
            // EQ/fade/volume/tempo in place — a mixed old/new desync.
            try {
                updateAutoMix({ ...rollback.autoMix });
                applySettingsToUI();
            } catch { /* ignore */ }
            try {
                if (rollback.masterVolume !== null) {
                    const volSlider = document.getElementById('masterVol') as HTMLInputElement | null;
                    if (volSlider) {
                        volSlider.value = String(rollback.masterVolume);
                        volSlider.dispatchEvent(new Event('input'));
                    }
                }
                if (rollback.tempoValue !== null) {
                    const tempo = document.getElementById('tempoSlider') as HTMLInputElement | null;
                    if (tempo) {
                        tempo.value = String(rollback.tempoValue);
                        tempo.dispatchEvent(new Event('input'));
                    }
                }
            } catch { /* ignore */ }
            // Pad UI previously kept showing the failed-load empties while the
            // toast claimed PREVIOUS STATE RESTORED — re-sync sliders.
            try {
                const grid = document.getElementById('padGrid');
                rollback.pads.forEach((p, i) => {
                    const slider = grid?.children[i]?.querySelector('.pad-slider') as HTMLInputElement | null;
                    if (slider) slider.value = String(p.vol);
                });
            } catch { /* ignore */ }
            // Waveforms were cleared pre-load and never restored — pads stayed
            // visually empty after rollback. Repaint from restored peaks.
            try {
                void import('./sampler').then((m) => {
                    rollback!.pads.forEach((p, i) => {
                        try {
                            if (p.wf !== undefined) m.renderWaveform(i);
                        } catch { /* ignore */ }
                    });
                }).catch(() => undefined);
            } catch { /* ignore */ }
        } catch { /* best-effort */ }
    };
    try {
        let filePath: string | null | undefined;

        if (window.electronAPI?.loadKit) {
            filePath = await window.electronAPI.loadKit();
            // Throttle sentinel (truthy) — must precede the cancel guard.
            if (filePath === DIALOG_THROTTLED) {
                logger.debug('[Session] Load dialog throttled — TRY AGAIN');
                toast.info('DIALOG BUSY — TRY AGAIN');
                return;
            }
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
        const session: SessionData = sanitizeParsedJson(JSON.parse(jsonStr));

        // Verify checksum (corruption evidence only — not attacker-proof)
        if (session.signature) {
            const isValid = await verifyChecksum(canonicalize(session), session.signature, session.signatureWeak);
            if (!isValid) {
                logger.error('[Session] Checksum mismatch - file is corrupt or was edited outside the app');
                toast.error("SESSION CORRUPTED - LOAD ABORTED");
                return;
            }
        } else {
            // Legacy session without signature - warn but allow loading (for backward compatibility)
            logger.warn('[Session] No checksum found - loading legacy session (no integrity check)');
        }

        // M28: unknown schema must fail loudly — warn-only let future
        // versions silently load into a mismatched shape and corrupt state.
        if (session.version !== SESSION_VERSION) {
            logger.error(`[Session] Unsupported version ${session.version} (expected ${SESSION_VERSION}) — load aborted`);
            toast.error('UNSUPPORTED SESSION VERSION — LOAD ABORTED');
            return;
        }

        // 1. Snapshot current state first — a failed kit restore must not
        // destroy the working kit with no rollback.
        const padSnap = Array.from({ length: NUM_PADS }, (_, i) => ({
            buf: padBuffers[i],
            path: padPaths[i] ?? '',
            vol: padVolumes[i] ?? 0.75,
            bpm: padBPMs[i] ?? 0,
            sync: !!padSyncState[i],
            snap: (padSnapToBeat[i] === false ? false : undefined) as boolean | undefined,
            beats: Array.isArray(padBeatPositions[i]) ? [...padBeatPositions[i]] : [],
            est: !!padBpmEstimated[i],
            ls: padLoopStart[i] ?? -1,
            le: padLoopEnd[i] ?? -1,
            wf: (padWaveforms as unknown as unknown[])[i],
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
            autoMix: { ...settings.autoMix },
            masterVolume: readSliderNumber('masterVol'),
            tempoValue: readSliderNumber('tempoSlider'),
            pads: padSnap,
        };
        try {
            const { clearAnalysisQueue } = await import('./playlist');
            clearAnalysisQueue();
        } catch { /* ignore */ }
        // Stop the live deck BEFORE swapping the list (C18/M18) — otherwise
        // the old audio keeps playing while the index points into the new
        // list, and a stale finishCrossfade timer can promote mid-restore.
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
        state.update({
            playlist: [],
            selectedIndices: [],
            currentTrackIndex: -1,
            isPlaying: false,
            isCrossfadeInProgress: false,
            blendingIndex: -1,
            masterBPM: 0,
        });

        // 2. Load playlist (validated, bounded — crafted files must not OOM).
        // Ext + slice gate: playlist paths must be audio with bounded length.
        if (Array.isArray(session.playlist)) {
            const clean = session.playlist.filter(isValidTrack).filter(t => {
                const p = String(t.path).slice(0, 32760);
                const ext = p.split('.').pop()?.toLowerCase() ?? '';
                return (VALID_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
            }).slice(0, 2000).map(t => ({
                id: String(t.id).slice(0, 128),
                name: String(t.name).slice(0, 512),
                path: String(t.path).slice(0, 32760),
                duration: clampNum(t.duration, 0, 86400, 0),
                bpm: t.bpm === undefined ? undefined : clampNum(t.bpm, 0, 300, 0),
            }));
            state.update({ playlist: clean });
            // BPM-less tracks get no analysis otherwise — the queue was
            // cleared above and nothing re-enqueues on this path (C18).
            try {
                const { reanalyzeTracks } = await import('./playlist');
                const missing = clean
                    .map((t, i) => ({ t, i }))
                    .filter(({ t }) => !(t.bpm !== undefined && t.bpm > 0))
                    .map(({ i }) => i);
                if (missing.length) reanalyzeTracks(missing);
            } catch { /* analysis is best-effort */ }
        }

        // 3. Load kit
        if (session.kit?.pads && Array.isArray(session.kit.pads)) {
            // Clear existing pads (incl. loop points — stale loops must not survive)
            for (let i = 0; i < NUM_PADS; i++) {
                padBuffers[i] = undefined!;
                padPaths[i] = '';
                padWaveforms[i] = undefined!;
                padBPMs[i] = 0;
                padBeatPositions[i] = [];
                padSyncState[i] = false;
                delete padSnapToBeat[i];
                try { delete padBpmEstimated[i]; } catch { /* ignore */ }
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
                // Ext gate: pad samples must be audio (slice already bounded).
                const pext = ppath.split('.').pop()?.toLowerCase() ?? '';
                if (!(VALID_AUDIO_EXTENSIONS as readonly string[]).includes(pext)) {
                    logger.warn(`[Session] Pad ${idx} skipped (non-audio ext .${pext})`);
                    continue;
                }
                if (loadGen !== sessionLoadGen) break; // rolled back mid-loop — stop writing
                const sessBpm = typeof (p as SessionPad)?.bpm === 'number' ? (p as SessionPad).bpm : undefined;
                const orig = loadSampleFromPath(ppath, idx, sessBpm);
                // Late-resolve guard: the timed-out load keeps decoding in the
                // background; if it lands after a rollback/newer load, undo the
                // ghost commit for this pad.
                void orig.then(() => {
                    if (loadGen !== sessionLoadGen && rollback) {
                        try {
                            const snap = rollback.pads[idx];
                            if (snap) {
                                if (snap.buf) padBuffers[idx] = snap.buf;
                                else padBuffers[idx] = undefined!;
                                padPaths[idx] = snap.path;
                                padVolumes[idx] = snap.vol;
                                padBPMs[idx] = snap.bpm;
                                padSyncState[idx] = snap.sync;
                                if (snap.snap === false || snap.snap === true) padSnapToBeat[idx] = snap.snap;
                                else delete padSnapToBeat[idx];
                                if (Array.isArray(snap.beats)) padBeatPositions[idx] = [...snap.beats];
                                if (snap.est) padBpmEstimated[idx] = true;
                                else try { delete padBpmEstimated[idx]; } catch { /* ignore */ }
                                padLoopStart[idx] = snap.ls;
                                padLoopEnd[idx] = snap.le;
                                try { (padWaveforms as unknown as unknown[])[idx] = snap.wf; } catch { /* ignore */ }
                            }
                        } catch { /* ignore */ }
                    }
                }).catch(() => undefined);
                try {
                    await withTimeout(orig, 20000);
                    if (loadGen !== sessionLoadGen) break; // stale — skip post-await writes
                    const vol = (p as SessionPad).vol;
                    if (typeof vol === 'number' && Number.isFinite(vol)) padVolumes[idx] = Math.min(1, Math.max(0, vol));
                    const bpm = (p as SessionPad).bpm;
                    if (typeof bpm === 'number' && Number.isFinite(bpm)) {
                        padBPMs[idx] = Math.min(300, Math.max(0, bpm));
                        // Session BPM overwrites fresh analysis — rebuild grid.
                        recomputePadBeatGrid(idx);
                    }
                    if (typeof (p as SessionPad).sync === 'boolean') padSyncState[idx] = (p as SessionPad).sync as boolean;
                    if (typeof (p as SessionPad).snap === 'boolean') padSnapToBeat[idx] = (p as SessionPad).snap as boolean;
                    else delete padSnapToBeat[idx];
                    const ls = (p as SessionPad).loopStart;
                    const le = (p as SessionPad).loopEnd;
                    if (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) padLoopStart[idx] = ls;
                    if (typeof le === 'number' && Number.isFinite(le) && le > 0) padLoopEnd[idx] = le;

                    // Update the volume slider UI
                    const grid = document.getElementById('padGrid');
                    if (!grid) {
                        // Load-before-grid previously desync'd padVolumes from
                        // sliders with zero signal.
                        logger.warn(`[Session] Pad ${idx} slider skipped (pad grid not built)`);
                    }
                    const slider = grid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                    if (slider) slider.value = padVolumes[idx].toString();
                    try {
                        const { renderWaveform } = await import('./sampler');
                        renderWaveform(idx);
                    } catch { /* ignore */ }
                } catch (e) {
                    // Per-pad failure is non-fatal for the loop, but silent
                    // before — 16 missing files printed SUCCESS on an empty kit.
                    logger.warn(`[Session] Pad ${idx} restore failed (${ppath})`, e);
                }
            }
        }

        // 4. Restore settings.
        // applySettingsToUI() MUST run before saveSettings() — saveSettings
        // reads the DOM checkboxes, and stale checkboxes were overwriting the
        // restored values immediately after load.
        if (session.settings?.autoMix) {
            const { eqCrossfade, filterSweep, hpfSweep, bpmSync, trackDuration, btnDuration, enableAI } = session.settings.autoMix;
            const bool = (v: unknown, fb: boolean): boolean => typeof v === 'boolean' ? v : fb;
            updateAutoMix({
                eqCrossfade: bool(eqCrossfade, true),
                filterSweep: bool(filterSweep, true),
                hpfSweep: bool(hpfSweep, true),
                bpmSync: bool(bpmSync, false),
                trackDuration: clampNum(trackDuration, 0.5, 60, 10),
                btnDuration: clampNum(btnDuration, 0.5, 30, 4),
                enableAI: bool(enableAI, false),
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
                // Actuate through the player engine (not raw state) so the
                // deck/loop-one interlock actually applies.
                try {
                    const { setAutoMixEnabled } = await import('./player');
                    if (typeof setAutoMixEnabled === 'function') setAutoMixEnabled(session.ui.isAutoMixEnabled);
                    else state.update({ isAutoMixEnabled: session.ui.isAutoMixEnabled });
                } catch {
                    state.update({ isAutoMixEnabled: session.ui.isAutoMixEnabled });
                }
            }
        }

        try {
            const { renderPlaylist } = await import('./playlist');
            renderPlaylist();
        } catch { /* playlist UI refresh is best-effort */ }
        // A manual load supersedes the auto-snapshot: leaving it behind
        // previously re-prompted "Restore unsaved session?" on the next boot
        // for pre-load state, inviting a double-restore clobber.
        try {
            const { clearSnapshots } = await import('./crash-recovery');
            clearSnapshots();
        } catch { /* ignore */ }
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
