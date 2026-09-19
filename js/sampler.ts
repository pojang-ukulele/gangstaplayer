// === SAMPLER MODULE ===
import { DEFAULT_PAD_VOLUME, MAX_FILE_SIZE_BYTES, NUM_PADS, POOL_SIZE } from './constants';
import { state } from './state';
import { audioCtx, masterGain, resumeAudioContext, ensureAudio } from './audio';
import { engine } from './audio-engine';
import { toast } from './toast';
import { logger } from './logger';
import { normalizeToArrayBuffer, sanitizeParsedJson, validateAudioSignature } from './utils';
import type { FileSystemAPI, ElectronAPI } from './types';
import { DIALOG_THROTTLED } from './types';
import { resolveBpmPersist } from './worker-client';
import type { BpmAnalysis } from './worker-client';

interface SamplerDeps {
    fsBridge: FileSystemAPI;
    bridge: ElectronAPI;
    detectBPM: (buffer: AudioBuffer) => Promise<BpmAnalysis | number>;
    masterBPMRef: { value: number };
    tempoSliderRef: HTMLInputElement;
}

export const padBuffers: Record<number, AudioBuffer> = {};
export const padPaths: Record<number, string> = {};
export const activeVoices: Record<number, { source: AudioBufferSourceNode, gain: GainNode } | null> = {};
export const padVolumes: number[] = new Array(16).fill(DEFAULT_PAD_VOLUME);
export const padBPMs: Record<number, number> = {};
export const padSyncState: Record<number, boolean> = {};
// Snap-to-beat toggle per pad (default ON — entry absent means enabled).
// Only effective when the pad has a usable BPM + beat grid. Survives pad
// reload (fresh samples keep the preference); persisted in kit files.
export const padSnapToBeat: Record<number, boolean> = {};
// Which edges of the current selection landed on a beat (drives the snap
// glow + brightened beat ticks in renderWaveform). Null = no snap highlight.
export const padSnappedEdges: Record<number, { start: boolean; end: boolean } | null> = {};
// Armed beat-span per pad, as beat-grid indices {from,to} into
// padBeatPositions. Set only by a Shift+Ctrl drag whose edges both land on
// beats; cleared by any non-Ctrl re-drag, selection clear, or sample reload.
// In-memory only (not persisted to kit/session). Drives the persistent
// armed glow + lit in-range ticks; the armed span is the hold-to-loop target
// automatically since it is written through setPadSelection.
export const padArmedBeats: Record<number, { from: number; to: number } | null> = {};

// Waveform preview data: per-column peak envelope per pad (0-255 for canvas).
// Layout is [tops 0..N-1, bottoms N..2N-1] where N = WAVEFORM_POINTS.
// Tops hold the positive peak magnitude per column, bottoms the negative
// peak magnitude — asymmetric pairs so troughs read independently of peaks.
export const padWaveforms: Record<number, Uint8Array> = {};
export const padBeatPositions: Record<number, number[]> = {}; // beat positions in seconds
export const padLoopStart: Record<number, number> = {}; // loop start in seconds (-1 = not set)
export const padLoopEnd: Record<number, number> = {}; // loop end in seconds (-1 = not set)

// Waveform area selection per pad, in seconds. This is the "active area":
// triggers play from selection start, long-press loops it while held.
// Kept in sync with padLoopStart/End so session save/load and existing
// loop semantics keep working from a single source of truth.
export interface PadSelection { start: number; end: number; }
export const padSelections: Record<number, PadSelection | null> = {};

// Playback clock per pad (AudioContext time) driving the strip playhead.
const padPlayState: Record<number, { t0: number; offset: number; rate: number } | null> = {};

// Press-and-hold state for long-press-to-loop (mouse only — keyboard/MIDI
// triggers never arm it, so they keep their plain one-shot behavior).
const LONG_PRESS_MS = 450;
// Strip hold-vs-drag: a press inside an existing selection auditions it as
// a loop when held still; moving beyond HOLD_DRAG_PX first turns the press
// into a fresh selection drag instead.
const HOLD_LOOP_MS = 220;
const HOLD_DRAG_PX = 5;
const _pressHeld: boolean[] = new Array(16).fill(false);
const _longPressTimers: Array<ReturnType<typeof setTimeout> | null> = new Array(16).fill(null);

const WAVEFORM_POINTS = 100; // Number of amplitude samples for preview
// Contrast shaping for the strip: gamma > 1 compresses mids downward so
// only true peaks reach the rails while body sits well inside. Floor gates
// sub-audible noise/hiss; ceiling leaves headroom so even full-scale hits
// stop short of the edges and green stays visible top/bottom.
const WAVEFORM_GAMMA = 1.35;
const WAVEFORM_FLOOR = 0.10;
const WAVEFORM_CEIL = 0.82;

// === Voice Pool: reuse GainNode objects to reduce GC pressure ===
// Pool is bound to the owning AudioContext — foreign-context nodes throw on
// connect(). The pool is dropped whenever the context is rebuilt.
const _gainPool: GainNode[] = [];
let _poolCreated = 0;
let _poolCtx: AudioContext | null = null;

function acquireGain(): GainNode | null {
    if (!ensureAudio() || !audioCtx) return null;
    if (_poolCtx && _poolCtx !== audioCtx) {
        _gainPool.length = 0;
    }
    _poolCtx = audioCtx;
    const pooled = _gainPool.pop();
    if (pooled) return pooled;
    _poolCreated++;
    return audioCtx.createGain();
}

function releaseGain(gain: GainNode): void {
    // Never pool a node from a dead context — it throws on connect().
    // The pool context tracks the current AudioContext; foreign nodes are dropped.
    if (_poolCtx && audioCtx && _poolCtx !== audioCtx) {
        return;
    }
    // Disconnect the gain node from its input and output
    try { gain.disconnect(); } catch (_) { /* already disconnected */ }
    // Cancel prior automation before reset, or the next voice inherits ramps.
    try {
        if (audioCtx) gain.gain.cancelScheduledValues(audioCtx.currentTime);
    } catch (_) { /* ignore */ }
    try {
        if (audioCtx) gain.gain.setValueAtTime(1, audioCtx.currentTime);
        else gain.gain.value = 1;
    } catch (_) { gain.gain.value = 1; }
    // Identity guard (C17): onended/stopPad races previously pushed the same
    // node twice and the reuse double-connected it.
    if (_gainPool.includes(gain)) return;
    // Return to pool (limit pool size)
    if (_gainPool.length < POOL_SIZE) {
        _gainPool.push(gain);
    }
}

let padGrid: HTMLElement | null = null;
let fsBridgeRef: FileSystemAPI | null = null;
let bridgeRef: ElectronAPI | null = null;
let detectBPMFn: ((buffer: AudioBuffer) => Promise<BpmAnalysis | number>) | null = null;
let masterBPMRef = { value: 0 };
let tempoSliderRef: HTMLInputElement | null = null;
/**
 * Re-resolve the tempo slider from the live DOM on every SYNC start.
 * The init-time capture goes stale across re-renders/re-inits (the sampler
 * previously read a detached node forever and SYNC ignored the chopper).
 */
function resolveTempoSlider(): HTMLInputElement | null {
    try {
        const fresh = document.getElementById('tempoSlider') as HTMLInputElement | null;
        if (fresh) tempoSliderRef = fresh;
    } catch { /* ignore */ }
    return tempoSliderRef;
}
/** One-time static wiring guard for initSampler (subscriptions + resize). */
let samplerStaticWired = false;

export function initSampler(deps: SamplerDeps): void {
    fsBridgeRef = deps.fsBridge;
    bridgeRef = deps.bridge;
    detectBPMFn = deps.detectBPM;
    masterBPMRef = deps.masterBPMRef;
    tempoSliderRef = deps.tempoSliderRef;
    padGrid = document.getElementById('padGrid');

    // One-time wiring: re-init (restore flows, HMR) previously stacked
    // duplicate subscriptions + resize listeners, rendering N times per event.
    if (!samplerStaticWired) {
        samplerStaticWired = true;
        // Subscribe to mapping changes
        state.subscribe('padKeyMap', () => {
            if (padGrid) {
                for (let i = 0; i < NUM_PADS; i++) updatePadVisuals(i);
            }
        });
        // MIDI bindings have their own pad badge — refresh when they change.
        state.subscribe('padMidiMap', () => {
            if (padGrid) {
                for (let i = 0; i < NUM_PADS; i++) updatePadVisuals(i);
            }
        });
        // Re-render waveforms on resize (debounced) — maximized windows otherwise
        // leave stretched/blank canvases until the next pad event.
        let _resizeT: ReturnType<typeof setTimeout> | null = null;
        window.addEventListener('resize', () => {
            if (_resizeT) clearTimeout(_resizeT);
            _resizeT = setTimeout(() => {
                for (let i = 0; i < NUM_PADS; i++) {
                    try { renderWaveform(i); } catch { /* ignore */ }
                }
            }, 200);
        });
    }

    wirePadMenuActions();

    createPadGrid();
}

export function getPadGrid(): HTMLElement | null { return padGrid; }

/**
 * Compute evenly-spaced beat positions from BPM and duration.
 * Returns positions in seconds.
 */
function computeBeatPositions(bpm: number, duration: number): number[] {
    if (bpm <= 0 || duration <= 0) return []; // Skip, no beat data available
    const beatInterval = 60 / bpm; // seconds per beat
    const count = Math.floor(duration / beatInterval);
    const positions: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        positions[i] = i * beatInterval;
    }
    return positions;
}

/** Recompute a pad's beat grid from its current BPM + buffer duration.
 *  Guard: duration must be > 0, otherwise the grid is left untouched.
 *  Clears stale armed indices (grid moved). */
export function recomputePadBeatGrid(index: number): void {
    const bpm = padBPMs[index] ?? 0;
    const dur = padBuffers[index]?.duration ?? 0;
    if (!(dur > 0)) return;
    padBeatPositions[index] = computeBeatPositions(bpm, dur);
    padArmedBeats[index] = null;
    try { delete padBpmEstimated[index]; } catch { /* ignore */ }
}

/** Clear BPM + beat grid so no stale grid survives a failed analysis. */
export function clearPadBeatGrid(index: number): void {
    padBPMs[index] = 0;
    padBeatPositions[index] = [];
    padArmedBeats[index] = null;
    padSnappedEdges[index] = null;
    try { delete padBpmEstimated[index]; } catch { /* ignore */ }
}

/** Fallback tempo when detection needs review — guarantees a visible grid
 *  + working Ctrl-snap instead of an empty strip. Priority: prior pad BPM,
 *  then caller-provided (kit/session/snapshot) BPM, then 120. */
export const FALLBACK_BPM = 120;
/** True when a pad's BPM is an estimate (fallback), shown as ~bpm in the strip. */
export const padBpmEstimated: Record<number, boolean> = {};

function applyBpmFallback(index: number, duration: number, callerBpm?: number): number {
    if (!(duration > 0)) { clearPadBeatGrid(index); return 0; }
    const prior = padBPMs[index];
    let bpm = 0;
    if (Number.isFinite(prior) && (prior as number) > 0) bpm = prior as number;
    else if (Number.isFinite(callerBpm as number) && (callerBpm as number) > 0) bpm = callerBpm as number;
    else bpm = FALLBACK_BPM;
    bpm = Math.min(300, Math.max(1, bpm));
    padBPMs[index] = bpm;
    padBeatPositions[index] = computeBeatPositions(bpm, duration);
    padArmedBeats[index] = null;
    padSnappedEdges[index] = null;
    padBpmEstimated[index] = true;
    return bpm;
}

/** Repaint strip (+ loupe when open) after async BPM settles — ug:dataChanged
 *  has no paint listener, so without this successful detections stay invisible. */
function refreshPadAfterBpm(index: number): void {
    try { renderWaveform(index); } catch { /* ignore */ }
    try { updatePadVisuals(index); } catch { /* ignore */ }
    try { syncZoomToCommitted(index); } catch { /* ignore */ }
}

// === SELECTION (active area) HELPERS ===

function clampToBuffer(index: number, t: number): number {
    const dur = padBuffers[index]?.duration ?? 0;
    if (!Number.isFinite(t) || !(dur > 0)) return 0;
    return Math.min(Math.max(0, t), dur);
}

// === SNAP-TO-BEAT (magnetic waveform selection) ===
// Radius rule: each edge snaps to its nearest beat when within
// min(half a beat, 12px in seconds) — whichever is tighter, so long
// samples use the half-beat cap and short samples use the pixel cap.
// Edges quantize independently (1/2/4-beat selections stay easy).
const SNAP_RADIUS_PX = 12;

/** True when snap is toggled on AND the pad has a usable BPM + beat grid. */
export function isSnapEnabled(index: number): boolean {
    if (padSnapToBeat[index] === false) return false;
    const bpm = padBPMs[index];
    if (!Number.isFinite(bpm) || bpm <= 0) return false;
    const beats = padBeatPositions[index];
    return !!beats && beats.length > 1;
}

export function setSnapEnabled(index: number, enabled: boolean): void {
    padSnapToBeat[index] = enabled;
    if (!enabled) padSnappedEdges[index] = null;
    try { renderWaveform(index); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
}

export function toggleSnapToBeat(index: number): boolean {
    const next = padSnapToBeat[index] === false;
    setSnapEnabled(index, next);
    return next;
}

/** Snap one time value to its nearest beat when inside the magnetic radius. */
function snapEdgeToBeat(index: number, t: number, rectWidth: number, duration: number): { time: number; snapped: boolean } {
    const beats = padBeatPositions[index];
    const bpm = padBPMs[index];
    if (padSnapToBeat[index] === false || !beats || beats.length < 2 || !Number.isFinite(bpm) || bpm <= 0) {
        return { time: t, snapped: false };
    }
    const beatInterval = 60 / bpm;
    const pixelRadius = rectWidth > 0 && duration > 0 ? (SNAP_RADIUS_PX / rectWidth) * duration : Number.POSITIVE_INFINITY;
    const radius = Math.min(beatInterval * 0.5, pixelRadius);
    let bi = Math.round(t / beatInterval);
    if (bi < 0) bi = 0;
    if (bi >= beats.length) bi = beats.length - 1;
    const beat = beats[bi];
    if (!Number.isFinite(beat)) return { time: t, snapped: false };
    if (Math.abs(t - beat) <= radius) return { time: beat, snapped: true };
    return { time: t, snapped: false };
}

/** Quantize both selection edges independently to the beat grid. */
export function quantizeSelectionToBeat(index: number, startSec: number, endSec: number, rectWidth: number, duration: number): { start: number; end: number; startSnapped: boolean; endSnapped: boolean } {
    const a = snapEdgeToBeat(index, Math.min(startSec, endSec), rectWidth, duration);
    const b = snapEdgeToBeat(index, Math.max(startSec, endSec), rectWidth, duration);
    return { start: a.time, end: b.time, startSnapped: a.snapped, endSnapped: b.snapped };
}

/** Nearest beat-grid index for a time value, or null without a grid. */
function beatIndexForTime(index: number, t: number): number | null {
    const beats = padBeatPositions[index];
    const bpm = padBPMs[index];
    if (!beats || beats.length < 2 || !Number.isFinite(bpm) || bpm <= 0) return null;
    const bi = Math.round(t / (60 / bpm));
    if (!Number.isFinite(bi)) return null;
    return Math.min(beats.length - 1, Math.max(0, bi));
}

/** MIDI note currently bound to a pad, or null (for the MIDI badge). */
function padMidiNote(index: number): number | null {
    try {
        const map = state.padMidiMap;
        for (const entry of Object.entries(map)) {
            if (Number(entry[1]) === index) return Number(entry[0]);
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * The pad's active area: waveform selection wins, legacy loop points are
 * the fallback. Always clamped to the loaded buffer.
 */
export function getActiveRegion(index: number): PadSelection | null {
    const dur = padBuffers[index]?.duration ?? 0;
    if (!(dur > 0)) return null;
    const sel = padSelections[index];
    if (sel && Number.isFinite(sel.start) && Number.isFinite(sel.end) && sel.end > sel.start) {
        const s = clampToBuffer(index, sel.start);
        const e = clampToBuffer(index, sel.end);
        if (e > s) return { start: s, end: e };
    }
    const ls = padLoopStart[index];
    const le = padLoopEnd[index];
    if (typeof ls === 'number' && typeof le === 'number' && ls >= 0 && le > ls) {
        const s = clampToBuffer(index, ls);
        const e = clampToBuffer(index, le);
        if (e > s) return { start: s, end: e };
    }
    return null;
}

/** Store a waveform selection; mirrors into loop points (single source). */
export function setPadSelection(index: number, start: number, end: number): void {
    const dur = padBuffers[index]?.duration ?? 0;
    if (!(dur > 0)) return;
    let s = Math.min(start, end);
    let e = Math.max(start, end);
    s = Math.min(Math.max(0, s), dur);
    e = Math.min(Math.max(0, e), dur);
    if (!(e > s)) return;
    padSelections[index] = { start: s, end: e };
    padLoopStart[index] = s;
    padLoopEnd[index] = e;
    renderWaveform(index);
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
}

/** Drop the waveform selection (Unselect area). */
export function clearPadSelection(index: number): void {
    padSelections[index] = null;
    padSnappedEdges[index] = null;
    padArmedBeats[index] = null;
    padLoopStart[index] = -1;
    padLoopEnd[index] = -1;
    renderWaveform(index);
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
}

/** Reset one pad to its unloaded state (Clear pad). */
export function clearPad(index: number): void {
    try { stopPad(index); } catch { /* ignore */ }
    delete padBuffers[index];
    delete padPaths[index];
    delete padWaveforms[index];
    delete padBeatPositions[index];
    delete padBPMs[index];
    delete padSyncState[index];
    delete padSnapToBeat[index];
    try { delete padBpmEstimated[index]; } catch { /* ignore */ }
    padSnappedEdges[index] = null;
    padArmedBeats[index] = null;
    padSelections[index] = null;
    padLoopStart[index] = -1;
    padLoopEnd[index] = -1;
    padPlayState[index] = null;
    updatePadVisuals(index);
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    toast.info(`PAD ${index + 1} CLEARED`);
}

/** Wire the Clear-pad / Unselect-area menu items (once — init may re-run). */
function wirePadMenuActions(): void {
    const menu = document.getElementById('padContextMenu');
    const readMenuIndex = (): number => {
        const idx = parseInt(menu?.dataset.padIndex || '-1', 10);
        return Number.isInteger(idx) && idx >= 0 && idx < NUM_PADS ? idx : -1;
    };
    const once = (id: string, fn: () => void): void => {
        const el = document.getElementById(id) as HTMLElement | null;
        if (!el || el.dataset.ugWired === '1') return;
        el.dataset.ugWired = '1';
        el.addEventListener('click', fn);
    };
    once('ctxClearPad', () => {
        const idx = readMenuIndex();
        if (idx >= 0) clearPad(idx);
    });
    once('ctxUnselectArea', () => {
        const idx = readMenuIndex();
        if (idx >= 0) {
            clearPadSelection(idx);
            toast.info(`PAD ${idx + 1} AREA UNSELECTED`);
        }
    });
}

// === LONG-PRESS-TO-LOOP (mouse hold repeats the active area) ===

function armLongPress(index: number): void {
    disarmLongPress(index);
    _pressHeld[index] = true;
    _longPressTimers[index] = setTimeout(() => {
        if (!_pressHeld[index]) return;
        const voice = activeVoices[index];
        if (!voice) {
            // Short selection already ended while still held: (re)start it
            // looping. The stopPad inside startPad disarms this fired timer
            // (harmless); keyup still stops the voice via stopPad.
            try { startPad(index, { loop: true }); } catch { /* ignore */ }
            _pressHeld[index] = true;
            return;
        }
        try {
            const region = getActiveRegion(index);
            const dur = padBuffers[index]?.duration ?? 0;
            if (region && dur > 0) {
                voice.source.loopStart = region.start;
                voice.source.loopEnd = region.end;
            } else if (dur > 0) {
                voice.source.loopStart = 0;
                voice.source.loopEnd = dur;
            }
            voice.source.loop = true;
        } catch { /* live loop toggle is best-effort */ }
    }, LONG_PRESS_MS);
}

function disarmLongPress(index: number): void {
    _pressHeld[index] = false;
    const t = _longPressTimers[index];
    if (t) {
        clearTimeout(t);
        _longPressTimers[index] = null;
    }
}

// === PLAYHEAD (cheap DOM marker, one shared rAF while voices play) ===

let _playheadRaf: number | null = null;

function ensurePlayheadLoop(): void {
    if (_playheadRaf !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    const tick = (): void => {
        try {
            let anyActive = false;
            if (padGrid && audioCtx) {
                for (let i = 0; i < NUM_PADS; i++) {
                    const voice = activeVoices[i];
                    const ps = padPlayState[i];
                    const wrapper = padGrid.children[i] as HTMLElement | undefined;
                    const marker = wrapper?.querySelector('.pad-playhead') as HTMLElement | null;
                    if (!marker) continue;
                    const dur = padBuffers[i]?.duration ?? 0;
                    if (voice && ps && dur > 0) {
                        anyActive = true;
                        let pos = ps.offset + (audioCtx.currentTime - ps.t0) * ps.rate;
                        const region = getActiveRegion(i);
                        if (voice.source.loop && region && region.end > region.start) {
                            const len = region.end - region.start;
                            pos = region.start + ((((pos - region.start) % len) + len) % len);
                        }
                        const frac = Math.min(1, Math.max(0, pos / dur));
                        marker.classList.remove('hidden');
                        marker.style.left = (frac * 100).toFixed(2) + '%';
                    } else {
                        marker.classList.add('hidden');
                    }
                }
            }
            _playheadRaf = anyActive ? requestAnimationFrame(tick) : null;
        } catch {
            _playheadRaf = null;
        }
    };
    _playheadRaf = requestAnimationFrame(tick);
}

/**
 * Compute a downsampled waveform preview from an AudioBuffer.
 * Returns a Uint8Array of 2 * WAVEFORM_POINTS length (0-255 amplitude):
 * first half = positive peak per column, second half = negative peak
 * magnitude per column. Peaks are normalized to the buffer peak and
 * compressed with gamma > 1 plus a ceiling so quiet body stays inside
 * while silence stays a hairline. Scans all channels so hard-panned content
 * is never missed.
 */
function computeWaveform(buffer: AudioBuffer): Uint8Array {
    const channels: Float32Array[] = [];
    try {
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    } catch {
        channels.push(buffer.getChannelData(0));
    }
    const len = channels[0]?.length ?? 0;
    const points = new Uint8Array(WAVEFORM_POINTS * 2);
    if (len <= 0) return points;
    const samplesPerPoint = Math.max(1, Math.floor(len / WAVEFORM_POINTS));

    // Per-column min/max first; global peak derived from them (single pass).
    // Stride-capped taps: a 100MB buffer puts ~500k samples per column (~100M
    // ops, seconds of main-thread freeze). 2048 taps/column is visually
    // identical for a 100px preview and ~250x faster on huge buffers.
    const colMax = new Float32Array(WAVEFORM_POINTS);
    const colMin = new Float32Array(WAVEFORM_POINTS);
    let peak = 0;
    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        let mx = -Infinity;
        let mn = Infinity;
        const start = i * samplesPerPoint;
        const end = Math.min(start + samplesPerPoint, len);
        const span = end - start;
        const stride = span > 2048 ? Math.ceil(span / 2048) : 1;
        for (let j = start; j < end; j += stride) {
            for (let c = 0; c < channels.length; c++) {
                const v = channels[c][j];
                if (v > mx) mx = v;
                if (v < mn) mn = v;
            }
        }
        if (mx === -Infinity) mx = 0;
        if (mn === Infinity) mn = 0;
        colMax[i] = mx;
        colMin[i] = mn;
        const a = Math.max(Math.abs(mx), Math.abs(mn));
        if (a > peak) peak = a;
    }
    if (!(peak > 0.0001)) return points; // silent buffer: hairline strip

    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        const nTop = Math.min(1, Math.max(0, colMax[i] / peak));
        const nBot = Math.min(1, Math.max(0, -colMin[i] / peak));
        // Gamma compression pulls mids inside; floor kills hiss so
        // silence renders thin instead of a fuzzy box; ceiling keeps
        // full-scale peaks off the rails so green bites at the edges.
        const sTop = nTop < WAVEFORM_FLOOR ? 0 : Math.pow(nTop, WAVEFORM_GAMMA) * WAVEFORM_CEIL;
        const sBot = nBot < WAVEFORM_FLOOR ? 0 : Math.pow(nBot, WAVEFORM_GAMMA) * WAVEFORM_CEIL;
        points[i] = Math.min(255, Math.round(sTop * 255));
        points[WAVEFORM_POINTS + i] = Math.min(255, Math.round(sBot * 255));
    }
    return points;
}

/** Draw the waveform strip: selection tint + beats + filled ember-red envelope on green.
 *  beatBoost (Shift held mid-drag) reveals the beat grid brighter + taller. */
export function renderWaveform(index: number, opts?: { beatBoost?: boolean }): void {
    if (!padGrid) return;
    const wrapper = padGrid.children[index] as HTMLElement;
    if (!wrapper) return;
    const strip = wrapper.querySelector('.pad-wave') as HTMLElement;
    const canvas = wrapper.querySelector('.pad-canvas') as HTMLCanvasElement;
    if (!strip || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size the canvas to the compact strip, not the whole pad.
    const dpr = window.devicePixelRatio || 1;
    const w = strip.clientWidth;
    const h = strip.clientHeight;
    if (w <= 0 || h <= 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);

    // Keep the DOM selection overlay in sync (survives every re-render —
    // geometry is recomputed from stored seconds, never from pixels).
    const selEl = strip.querySelector('.pad-selection') as HTMLElement | null;
    const buffer = padBuffers[index];
    const duration = buffer ? buffer.duration : 0;
    const region = getActiveRegion(index);
    if (region && duration > 0 && selEl) {
        selEl.classList.remove('hidden');
        selEl.style.left = ((region.start / duration) * 100).toFixed(2) + '%';
        selEl.style.width = (((region.end - region.start) / duration) * 100).toFixed(2) + '%';
    } else if (selEl) {
        selEl.classList.add('hidden');
    }
    // Snap glow: brightened edges when either side landed on a beat.
    // Theme-safe — keeps the purple selection, adds a gold edge glow.
    // Armed glow persists while an armed beat-span is the active region.
    if (selEl) {
        const flags = padSnappedEdges[index];
        const anySnapped = !!(region && flags && (flags.start || flags.end));
        selEl.classList.toggle('snapped', anySnapped);
        selEl.classList.toggle('armed', !!(region && padArmedBeats[index]));
    }

    const data = padWaveforms[index];
    if (!data || data.length < 2 || !buffer || !(duration > 0)) {
        // Unloaded pad: leave the strip blank (canvas already cleared above).
        // No placeholder line or waveform until a sample loads.
        return;
    }

    // Palette comes from CSS vars so the strip matches the app theme.
    let ink = '#ff5c39';
    let inkEdge = '#c93a1e';
    try {
        const v = getComputedStyle(strip).getPropertyValue('--pad-wave-ink').trim();
        if (v) ink = v;
        const e = getComputedStyle(strip).getPropertyValue('--pad-wave-ink-edge').trim();
        if (e) inkEdge = e;
    } catch { /* fallback ink */ }

    const beats = padBeatPositions[index];
    paintWaveCanvas(ctx, {
        data, beats, bpm: padBPMs[index] ?? 0, duration,
        region, snapFlags: padSnappedEdges[index],
        armed: padArmedBeats[index] ?? null,
        w, h, ink, inkEdge, beatBoost: opts?.beatBoost === true,
    });

    // === 4. BPM tag (tiny, top-left of the strip; ~ marks estimated grids) ===
    if (padBPMs[index] > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.font = '8px VT323, monospace';
        ctx.textBaseline = 'top';
        const tag = padBpmEstimated[index] ? `~${padBPMs[index]}bpm` : `${padBPMs[index]}bpm`;
        ctx.fillText(tag, 3, 2);
    }
}

/** Shared wave painter: selection tint + beat grid + snapped highlights +
 *  amplitude envelope. Used by the strip and the zoom loupe alike (no
 *  re-decode, no duplicated envelope math). */
interface WavePaintInput {
    data: Uint8Array;
    beats: number[] | undefined;
    bpm: number;
    duration: number;
    region: PadSelection | null;
    snapFlags: { start: boolean; end: boolean } | null | undefined;
    armed?: { from: number; to: number } | null;
    w: number;
    h: number;
    ink: string;
    inkEdge: string;
    beatBoost?: boolean;
    // Visible window in global seconds for loupe zoom. Envelope data is
    // pre-resampled to the window; region/beats stay global and are mapped
    // through xOf so beat math (snap intervals, armed indices) is untouched.
    view?: { start: number; end: number };
}

function paintWaveCanvas(ctx: CanvasRenderingContext2D, o: WavePaintInput): void {
    const { data, beats, bpm, duration, region, snapFlags, w, h, ink, inkEdge } = o;
    const midY = h / 2;
    const stepX = w / WAVEFORM_POINTS;
    // Window mapping: global seconds -> canvas x. Defaults to full duration
    // so strip callers (no view) render exactly as before.
    const v0 = (o.view && Number.isFinite(o.view.start)) ? o.view.start : 0;
    const v1 = (o.view && Number.isFinite(o.view.end) && o.view.end > v0) ? o.view.end : duration;
    const vSpan = Math.max(1e-9, v1 - v0);
    const xOf = (t: number): number => ((t - v0) / vSpan) * w;
    const xVisible = (x: number): boolean => x >= -1 && x <= w + 1;

    // === 1. Selection tint (canvas backstop behind the DOM overlay) ===
    if (region && region.end > region.start) {
        const cs = Math.max(region.start, v0);
        const ce = Math.min(region.end, v1);
        if (ce > cs) {
            const lsX = xOf(cs);
            const leX = xOf(ce);
            ctx.fillStyle = 'rgba(188, 19, 254, 0.25)';
            ctx.fillRect(lsX, 0, leX - lsX, h);
            ctx.strokeStyle = 'rgba(188, 19, 254, 0.8)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(lsX, 0); ctx.lineTo(lsX, h);
            ctx.moveTo(leX, 0); ctx.lineTo(leX, h);
            ctx.stroke();
        }
    }

    // === 2. Always-on beat grid (visible whenever beats exist, no modifier
    // needed) + mid ticks (revealed brighter/taller while Ctrl is held) ===
    if (beats && beats.length > 1) {
        const boost = o.beatBoost === true;
        // Full-height faint grid lines for every beat + stronger downbeat
        // every 4th beat. Drawn first so mid ticks + highlights sit on top.
        for (let i = 0; i < beats.length; i++) {
            const x = xOf(beats[i]);
            if (!xVisible(x)) continue;
            const isDown = (i % 4 === 0);
            ctx.strokeStyle = boost
                ? (isDown ? 'rgba(255, 204, 0, 0.85)' : 'rgba(255, 204, 0, 0.6)')
                : (isDown ? 'rgba(255, 204, 0, 0.45)' : 'rgba(255, 204, 0, 0.28)');
            ctx.lineWidth = isDown ? (boost ? 1.5 : 1) : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        ctx.strokeStyle = boost ? 'rgba(255, 204, 0, 0.9)' : 'rgba(255, 204, 0, 0.35)';
        ctx.lineWidth = boost ? 1.5 : 1;
        const tickHalf = boost ? 6 : 4;
        for (let i = 0; i < beats.length; i++) {
            const x = xOf(beats[i]);
            if (!xVisible(x)) continue;
            ctx.beginPath();
            ctx.moveTo(x, midY - tickHalf);
            ctx.lineTo(x, midY + tickHalf);
            ctx.stroke();
        }
        // Snapped edges: redraw their ticks brighter + taller so the
        // magnetized beats pop without recoloring the theme.
        if (snapFlags && (snapFlags.start || snapFlags.end) && region) {
            const ivHi = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : 0;
            const targets: number[] = [];
            if (snapFlags.start) targets.push(region.start);
            if (snapFlags.end) targets.push(region.end);
            ctx.strokeStyle = 'rgba(255, 224, 130, 0.95)';
            ctx.lineWidth = 2;
            for (const t of targets) {
                let x = -1;
                if (ivHi > 0) {
                    const bi = Math.min(beats.length - 1, Math.max(0, Math.round(t / ivHi)));
                    x = xOf(beats[bi]);
                } else {
                    let best = 0, bd = Infinity;
                    for (let i = 0; i < beats.length; i++) {
                        const d = Math.abs(beats[i] - t);
                        if (d < bd) { bd = d; best = i; }
                    }
                    x = xOf(beats[best]);
                }
                if (!xVisible(x)) continue;
                ctx.beginPath();
                ctx.moveTo(x, midY - 6);
                ctx.lineTo(x, midY + 6);
                ctx.stroke();
            }
        }
        // Armed span: every in-range beat tick stays lit (persistent, unlike
        // the transient snapped-edge highlights above).
        if (o.armed && beats.length > 1) {
            const a0 = Math.max(0, Math.min(o.armed.from, o.armed.to));
            const a1 = Math.min(beats.length - 1, Math.max(o.armed.from, o.armed.to));
            if (a1 >= a0) {
                ctx.strokeStyle = 'rgba(255, 224, 130, 0.9)';
                ctx.lineWidth = 2;
                for (let i = a0; i <= a1; i++) {
                    const x = xOf(beats[i]);
                    if (!xVisible(x)) continue;
                    ctx.beginPath();
                    ctx.moveTo(x, midY - 6);
                    ctx.lineTo(x, midY + 6);
                    ctx.stroke();
                }
            }
        }
    }

    // === 3. Amplitude envelope: filled asymmetric min/max shape with
    // ~12% green padding top/bottom so hits use the full strip height.
    // Silence renders as a hairline; hits pop to the rails. ===
    const vPad = Math.max(2, Math.round(h * 0.12));
    const halfAmp = Math.max(1, midY - vPad);
    // Split tops/bottoms; legacy single-sided caches (len == N) mirror.
    const isDual = data.length >= WAVEFORM_POINTS * 2;
    const topAt = (i: number): number => data[i] ?? 0;
    const botAt = (i: number): number => (isDual ? data[WAVEFORM_POINTS + i] : data[i]) ?? 0;
    const topPx = (i: number): number => {
        const v = topAt(i) / 255;
        if (v <= 0) return 0.5; // hairline floor — silence stays thin
        return Math.max(1.5, v * halfAmp);
    };
    const botPx = (i: number): number => {
        const v = botAt(i) / 255;
        if (v <= 0) return 0.5;
        return Math.max(1.5, v * halfAmp);
    };
    // Faint center line so troughs read against peaks.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(w, midY + 0.5);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        const x = i * stepX + stepX / 2;
        if (i === 0) ctx.moveTo(x, midY - topPx(i));
        else ctx.lineTo(x, midY - topPx(i));
    }
    for (let i = WAVEFORM_POINTS - 1; i >= 0; i--) {
        const x = i * stepX + stepX / 2;
        ctx.lineTo(x, midY + botPx(i));
    }
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, midY - halfAmp, 0, midY + halfAmp);
    grad.addColorStop(0, ink);
    grad.addColorStop(0.5, ink);
    grad.addColorStop(1, inkEdge);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = inkEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
}

function updatePadVisuals(index: number): void {
    if (!padGrid) return;
    const wrapper = padGrid.children[index] as HTMLElement;
    if (wrapper) {
        renderPad(index, wrapper);
        // Defer waveform render to next frame so canvas has correct layout dimensions
        requestAnimationFrame(() => renderWaveform(index));
    }
}

// Dead-press flash: startPad early returns fail shut with no signal, so a
// tap on an unloading/dead pad feels identical to a working hit. A brief
// .denied outline blink marks the denial; auto-clears on a timeout and
// never touches layout (outline only, no transform/box-model change).
const DENIED_FLASH_MS = 220;
const _deniedTimers: Array<ReturnType<typeof setTimeout> | null> = new Array(16).fill(null);

function flashPadDenied(index: number): void {
    try {
        const pad = padGrid?.children[index]?.querySelector('.pad') as HTMLElement | null;
        if (!pad) return;
        // Restart the blink on rapid repeats (class re-add alone won't).
        pad.classList.remove('denied');
        void pad.offsetWidth;
        pad.classList.add('denied');
        const prev = _deniedTimers[index];
        if (prev) clearTimeout(prev);
        _deniedTimers[index] = setTimeout(() => {
            _deniedTimers[index] = null;
            try { pad.classList.remove('denied'); } catch { /* ignore */ }
        }, DENIED_FLASH_MS);
    } catch { /* flash is best-effort */ }
}

// === WAVEFORM ZOOM LOUPE (Shift+hold/drag magnifier) ===
// Pure visual loupe (pointer-events:none except the box edge for leave
// detection): all input stays on the existing window mousemove/mouseup, so
// hold-to-loop audition, momentary choke, and drag-cancel paths are untouched.
// Canvas reuses padWaveforms peaks + padBeatPositions grid (no re-decode)
// through the shared paintWaveCanvas painter — same orange/green/neon theme.
const ZOOM_BODY_H = 102; // 3x the 34px strip height
const ZOOM_MIN_W = 300;
const ZOOM_MAX_W = 620;

interface ZoomDom { root: HTMLElement; box: HTMLElement; body: HTMLElement; canvas: HTMLCanvasElement; sel: HTMLElement; title: HTMLElement; }
let _zoomDom: ZoomDom | null = null;
let _zoomIndex = -1;
// Green side padding cached at open (px each side) so the loupe overlay %
// math tracks the inset canvas. Read from computed style — single source.
let _zoomPadL = 0;
let _zoomPadR = 0;
// True while a strip/loupe gesture owns the window mouse handlers.
let _gestureActive = false;
// Loupe zoom view: visible window as fractions of total duration.
// Reset to full on openZoom()/closeZoom(); narrowed by onZoomWheel.
let _zoomView = { start: 0, end: 1 };
// Last live drag preview (global seconds) so a wheel-zoom mid-drag can
// repaint the preview instead of falling back to committed state.
let _zoomLive: { index: number; start: number; end: number; startSnapped: boolean; endSnapped: boolean; armed: boolean } | null = null;
// Base loupe title (without the zoom factor suffix) set at openZoom().
let _zoomBaseTitle = '';

function ensureZoomDom(): ZoomDom | null {
    if (_zoomDom) return _zoomDom;
    try {
        const root = document.getElementById('waveZoomPopup') as HTMLElement | null;
        if (!root) return null;
        const box = root.querySelector('.wave-zoom-box') as HTMLElement | null;
        const body = root.querySelector('.wave-zoom-body') as HTMLElement | null;
        const canvas = root.querySelector('.wave-zoom-canvas') as HTMLCanvasElement | null;
        const sel = root.querySelector('.wave-zoom-selection') as HTMLElement | null;
        const title = root.querySelector('.wave-zoom-title') as HTMLElement | null;
        if (!box || !body || !canvas || !sel || !title) return null;
        _zoomDom = { root, box, body, canvas, sel, title };
        if (box.dataset.ugZoomDown !== '1') {
            box.dataset.ugZoomDown = '1';
            box.addEventListener('mousedown', onZoomBoxDown);
        }
        if (box.dataset.ugZoomWheel !== '1') {
            box.dataset.ugZoomWheel = '1';
            // Non-passive so preventDefault() stops page scroll while zooming.
            box.addEventListener('wheel', onZoomWheel, { passive: false });
        }
        return _zoomDom;
    } catch { return null; }
}

// Re-drag starter on the loupe itself (Shift held): re-anchor the press in
// strip coordinates and funnel through the strip gesture machine — first
// move re-anchors to loupe space (open), so one code path owns all drags.
function onZoomBoxDown(e: MouseEvent): void {
    try {
        const idx = _zoomIndex;
        if (idx < 0 || e.button !== 0 || _gestureActive) return;
        if (!e.shiftKey) return;
        const z = _zoomDom;
        if (!z) return;
        const buf = padBuffers[idx];
        if (!buf || !(buf.duration > 0)) return;
        const wave = padGrid?.children[idx]?.querySelector('.pad-wave') as HTMLElement | null;
        if (!wave) return;
        const lr = z.canvas.getBoundingClientRect();
        if (lr.width <= 0) return;
        const winFrac = Math.min(1, Math.max(0, (e.clientX - lr.left) / lr.width));
        // Loupe canvas shows the zoom window, not full duration — convert to
        // global frac so the synth strip press lands in the same space as
        // frac0/drag cur (both global once onMove converts back).
        const span = Math.max(1e-6, _zoomView.end - _zoomView.start);
        const frac = Math.min(1, Math.max(0, _zoomView.start + winFrac * span));
        const sr = wave.getBoundingClientRect();
        if (sr.width <= 0) return;
        e.stopPropagation();
        e.preventDefault();
        const synth = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0,
            clientX: sr.left + frac * sr.width, clientY: e.clientY,
            shiftKey: true, ctrlKey: e.ctrlKey,
        });
        wave.dispatchEvent(synth);
    } catch (err) {
        logger.debug(`[Sampler] Loupe re-drag skipped (open/geometry failure)`, err);
    }
}

// Idle-open sentinel: with no gesture active nothing else observes Shift
// release / blur, so the loupe would stick open. Closes it (no commit —
// gesture commit only happens on mouseup inside a gesture).
function zoomSentinelKeyUp(ev: KeyboardEvent): void {
    if (ev.key === 'Shift') closeZoom();
}
function zoomSentinelBlur(): void {
    closeZoom();
}
function armZoomSentinel(): void {
    try {
        window.addEventListener('keyup', zoomSentinelKeyUp);
        window.addEventListener('blur', zoomSentinelBlur);
    } catch { /* ignore */ }
}
function disarmZoomSentinel(): void {
    try {
        window.removeEventListener('keyup', zoomSentinelKeyUp);
        window.removeEventListener('blur', zoomSentinelBlur);
    } catch { /* ignore */ }
}

/** Open the loupe centered on the cursor, clamped into the viewport. */
function openZoom(index: number, cx: number, cy: number, stripW: number): void {
    const z = ensureZoomDom();
    if (!z) return;
    const buf = padBuffers[index];
    const data = padWaveforms[index];
    if (!buf || !(buf.duration > 0) || !data || data.length < 2) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let zw = Math.min(ZOOM_MAX_W, Math.max(ZOOM_MIN_W, Math.round(stripW * 3)));
    zw = Math.min(zw, Math.max(160, vw - 16));
    const zh = ZOOM_BODY_H;
    const boxH = zh + 22; // title row
    const left = Math.max(8, Math.min(Math.round(cx - zw / 2), Math.max(8, vw - zw - 8)));
    const top = Math.max(8, Math.min(Math.round(cy - boxH / 2), Math.max(8, vh - boxH - 8)));
    z.box.style.width = zw + 'px';
    z.box.style.left = left + 'px';
    z.box.style.top = top + 'px';
    z.body.style.height = zh + 'px';
    const bpm = padBPMs[index] ?? 0;
    _zoomBaseTitle = `PAD ${String(index + 1).padStart(2, '0')}${bpm > 0 ? ` • ${bpm}BPM` : ''} • SHIFT ZOOM • CTRL SNAP`;
    z.title.textContent = _zoomBaseTitle;
    z.root.classList.add('active');
    z.root.setAttribute('aria-hidden', 'false');
    _zoomIndex = index;
    // Fresh loupe always starts at full duration; wheel narrows from here.
    _zoomView = { start: 0, end: 1 };
    _zoomLive = null;
    try {
        const cs = getComputedStyle(z.body);
        _zoomPadL = Math.max(0, parseFloat(cs.paddingLeft) || 0);
        _zoomPadR = Math.max(0, parseFloat(cs.paddingRight) || 0);
    } catch { _zoomPadL = 0; _zoomPadR = 0; }
    armZoomSentinel();
    paintZoomCanvas(index);
    // Overlay mirrors the committed selection until the first live preview.
    mirrorZoomOverlay();
}

/** Repaint the loupe canvas from committed state (theme vars read off the strip).
 *  Window-aware: the envelope is resampled to the zoom view so zoom visibly
 *  magnifies; region/beats stay global and map through the view window. */
function paintZoomCanvas(index: number): void {
    if (_zoomIndex !== index) return;
    const z = _zoomDom;
    if (!z) return;
    const buf = padBuffers[index];
    const data = padWaveforms[index];
    const duration = buf ? buf.duration : 0;
    if (!buf || !(duration > 0) || !data || data.length < 2) return;
    const ctx = z.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Inset canvas (green side padding) owns the pixels — not the body.
    const w = z.canvas.clientWidth;
    const h = z.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    z.canvas.width = w * dpr;
    z.canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let ink = '#ff5c39';
    let inkEdge = '#c93a1e';
    try {
        const strip = padGrid?.children[index]?.querySelector('.pad-wave') as HTMLElement | null;
        if (strip) {
            const v = getComputedStyle(strip).getPropertyValue('--pad-wave-ink').trim();
            if (v) ink = v;
            const e2 = getComputedStyle(strip).getPropertyValue('--pad-wave-ink-edge').trim();
            if (e2) inkEdge = e2;
        }
    } catch { /* fallback ink */ }
    const view = zoomViewSeconds(duration);
    paintWaveCanvas(ctx, {
        data: resampleWindowedPeaks(data, _zoomView.start, _zoomView.end),
        beats: padBeatPositions[index], bpm: padBPMs[index] ?? 0, duration,
        region: getActiveRegion(index), snapFlags: padSnappedEdges[index],
        armed: padArmedBeats[index] ?? null,
        w, h, ink, inkEdge, beatBoost: true, view,
    });
}

/** Mirror a global seconds-range onto the loupe overlay, mapped into the
 *  zoom window (same % math as the strip, offset for the green side padding
 *  so it tracks the inset canvas). Clipped to the window; hidden when the
 *  range lies fully outside it. */
function mirrorZoomSelection(startSec: number, endSec: number, snapped: boolean, armed = false): void {
    const z = _zoomDom;
    if (!z || _zoomIndex < 0) return;
    const duration = padBuffers[_zoomIndex]?.duration ?? 0;
    if (!(duration > 0)) return;
    const W = z.body.clientWidth;
    if (W <= 0) return;
    const span = Math.max(1e-6, _zoomView.end - _zoomView.start);
    const sFrac = (startSec / duration - _zoomView.start) / span;
    const eFrac = (endSec / duration - _zoomView.start) / span;
    // Fully outside the window — nothing to mirror.
    if (eFrac <= 0 || sFrac >= 1) { z.sel.classList.add('hidden'); return; }
    const cs = Math.max(0, sFrac);
    const ce = Math.min(1, eFrac);
    if (!(ce > cs)) { z.sel.classList.add('hidden'); return; }
    const inner = Math.max(1, W - _zoomPadL - _zoomPadR);
    z.sel.classList.remove('hidden');
    z.sel.style.left = ((_zoomPadL + cs * inner) / W * 100).toFixed(2) + '%';
    z.sel.style.width = (((ce - cs)) * inner / W * 100).toFixed(2) + '%';
    z.sel.classList.toggle('snapped', snapped);
    z.sel.classList.toggle('armed', armed);
}

/** Mirror the committed selection (used on open, before live previews). */
function mirrorZoomOverlay(): void {
    const z = _zoomDom;
    if (!z || _zoomIndex < 0) return;
    const region = getActiveRegion(_zoomIndex);
    if (!region) { z.sel.classList.add('hidden'); return; }
    const flags = padSnappedEdges[_zoomIndex];
    mirrorZoomSelection(region.start, region.end, !!(flags && (flags.start || flags.end)), !!padArmedBeats[_zoomIndex]);
}

/** Repaint strip + loupe canvases with the live drag preview so the old
 *  committed tint never shows alongside the new preview (single selection). */
function paintPreviewCanvases(index: number, startSec: number, endSec: number, startSnapped: boolean, endSnapped: boolean, armedLive: boolean): void {
    try {
        const s = Math.min(startSec, endSec);
        const e = Math.max(startSec, endSec);
        const region = { start: s, end: e };
        const snapFlags = (startSnapped || endSnapped) ? { start: startSnapped, end: endSnapped } : null;
        let armedPreview: { from: number; to: number } | null = null;
        if (armedLive) {
            try {
                const bi1 = beatIndexForTime(index, s);
                const bi2 = beatIndexForTime(index, e);
                if (bi1 !== null && bi2 !== null) armedPreview = { from: Math.min(bi1, bi2), to: Math.max(bi1, bi2) };
            } catch { armedPreview = null; }
        }
        const buf = padBuffers[index];
        const data = padWaveforms[index];
        const duration = buf ? buf.duration : 0;
        if (!buf || !(duration > 0) || !data || data.length < 2) return;
        const beats = padBeatPositions[index];
        const bpm = padBPMs[index] ?? 0;
        const wrapper = padGrid?.children[index] as HTMLElement | undefined;
        const strip = wrapper?.querySelector('.pad-wave') as HTMLElement | null;
        const canvas = wrapper?.querySelector('.pad-canvas') as HTMLCanvasElement | null;
        if (strip && canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const dpr = window.devicePixelRatio || 1;
                const w = strip.clientWidth;
                const h = strip.clientHeight;
                if (w > 0 && h > 0) {
                    let ink = '#ff5c39';
                    let inkEdge = '#c93a1e';
                    try {
                        const v = getComputedStyle(strip).getPropertyValue('--pad-wave-ink').trim();
                        if (v) ink = v;
                        const e2 = getComputedStyle(strip).getPropertyValue('--pad-wave-ink-edge').trim();
                        if (e2) inkEdge = e2;
                    } catch { /* fallback ink */ }
                    canvas.width = w * dpr;
                    canvas.height = h * dpr;
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.clearRect(0, 0, w, h);
                    paintWaveCanvas(ctx, {
                        data, beats, bpm, duration,
                        region, snapFlags, armed: armedPreview ?? (padArmedBeats[index] && !armedLive ? padArmedBeats[index] : null),
                        w, h, ink, inkEdge, beatBoost: strip.classList.contains('show-beats'),
                    });
                    if (bpm > 0) {
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                        ctx.font = '8px VT323, monospace';
                        ctx.textBaseline = 'top';
                        ctx.fillText(`${padBpmEstimated[index] ? '~' : ''}${bpm}bpm`, 3, 2);
                    }
                }
            }
        }
        if (isZoomOpenFor(index) && _zoomDom) {
            const z = _zoomDom;
            const zctx = z.canvas.getContext('2d');
            if (zctx) {
                const dpr = window.devicePixelRatio || 1;
                const w = z.canvas.clientWidth;
                const h = z.canvas.clientHeight;
                if (w > 0 && h > 0) {
                    let ink = '#ff5c39';
                    let inkEdge = '#c93a1e';
                    try {
                        if (strip) {
                            const v = getComputedStyle(strip).getPropertyValue('--pad-wave-ink').trim();
                            if (v) ink = v;
                            const e2 = getComputedStyle(strip).getPropertyValue('--pad-wave-ink-edge').trim();
                            if (e2) inkEdge = e2;
                        }
                    } catch { /* fallback ink */ }
                    z.canvas.width = w * dpr;
                    z.canvas.height = h * dpr;
                    zctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    zctx.clearRect(0, 0, w, h);
                    paintWaveCanvas(zctx, {
                        data: resampleWindowedPeaks(data, _zoomView.start, _zoomView.end),
                        beats, bpm, duration,
                        region, snapFlags, armed: armedPreview,
                        w, h, ink, inkEdge, beatBoost: true,
                        view: zoomViewSeconds(duration),
                    });
                }
            }
        }
    } catch { /* preview repaint is best-effort */ }
}

/** Re-sync the loupe canvas + overlay from committed state (call after
 *  renderWaveform on commit / discard so strip and zoom never diverge). */
function syncZoomToCommitted(index: number): void {
    try {
        if (!isZoomOpenFor(index)) return;
        paintZoomCanvas(index);
        mirrorZoomOverlay();
    } catch { /* best-effort */ }
}

function closeZoom(): void {
    disarmZoomSentinel();
    _zoomView = { start: 0, end: 1 };
    _zoomLive = null;
    if (!_zoomDom) { _zoomIndex = -1; return; }
    _zoomDom.root.classList.remove('active');
    _zoomDom.root.setAttribute('aria-hidden', 'true');
    _zoomIndex = -1;
}

function isZoomOpenFor(index: number): boolean {
    return _zoomIndex === index && !!_zoomDom?.root.classList.contains('active');
}

/** Zoom view window in global seconds for a buffer duration. */
function zoomViewSeconds(duration: number): { start: number; end: number } {
    return { start: _zoomView.start * duration, end: _zoomView.end * duration };
}

/** Resample full-duration peak data into WAVEFORM_POINTS bins covering the
 *  [startF, endF) fraction window. Wide windows take per-bin maxima (peak
 *  preserving); magnified windows lerp between source bins (smooth). */
function resampleWindowedPeaks(data: Uint8Array, startF: number, endF: number): Uint8Array {
    const N = WAVEFORM_POINTS;
    const span = Math.max(1e-6, endF - startF);
    // Fast path: full view renders the cached peaks untouched.
    if (startF <= 0 && endF >= 1) return data;
    const isDual = data.length >= N * 2;
    const srcLen = isDual ? N : Math.min(N, data.length);
    const topSrc = (j: number): number => data[Math.min(srcLen - 1, Math.max(0, j))] ?? 0;
    const botSrc = (j: number): number => (isDual ? data[N + Math.min(N - 1, Math.max(0, j))] : topSrc(j)) ?? 0;
    const out = new Uint8Array(N * 2);
    for (let i = 0; i < N; i++) {
        const srcStart = (startF + (i / N) * span) * N;
        const srcEnd = (startF + ((i + 1) / N) * span) * N;
        if (srcEnd - srcStart >= 1) {
            let mt = 0, mb = 0;
            const j0 = Math.max(0, Math.floor(srcStart));
            const j1 = Math.min(srcLen - 1, Math.ceil(srcEnd) - 1);
            for (let j = j0; j <= j1; j++) {
                const t = topSrc(j), b = botSrc(j);
                if (t > mt) mt = t;
                if (b > mb) mb = b;
            }
            out[i] = mt;
            out[N + i] = mb;
        } else {
            const mid = Math.min(srcLen - 1, Math.max(0, (srcStart + srcEnd) / 2));
            const j0 = Math.floor(mid);
            const f = mid - j0;
            const j1 = Math.min(srcLen - 1, j0 + 1);
            out[i] = Math.round(topSrc(j0) + (topSrc(j1) - topSrc(j0)) * f);
            out[N + i] = Math.round(botSrc(j0) + (botSrc(j1) - botSrc(j0)) * f);
        }
    }
    return out;
}

/** Mouse-wheel zoom inside the open loupe, anchored at the pointer: the
 *  global time under the cursor stays under the cursor across the zoom. */
function onZoomWheel(e: WheelEvent): void {
    try {
        const idx = _zoomIndex;
        if (idx < 0 || !isZoomOpenFor(idx) || !_zoomDom) return;
        const buf = padBuffers[idx];
        const duration = buf ? buf.duration : 0;
        if (!(duration > 0)) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = _zoomDom.canvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const cursorFrac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const span = Math.max(1e-6, _zoomView.end - _zoomView.start);
        // Global time (fraction) under the cursor before the zoom.
        const t = _zoomView.start + cursorFrac * span;
        // ~1.25x per 100 deltaY (one wheel notch); continuous so trackpads
        // and ctrl+wheel pinch deltas scale smoothly. deltaY > 0 zooms out.
        const norm = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (!Number.isFinite(norm) || norm === 0) return;
        const factor = Math.pow(1.25, norm / 100);
        if (!Number.isFinite(factor) || factor <= 0) return;
        const newSpan = Math.min(1.0, Math.max(0.02, span * factor));
        let newStart = t - cursorFrac * newSpan;
        newStart = Math.min(Math.max(0, newStart), 1 - newSpan);
        _zoomView = { start: newStart, end: newStart + newSpan };
        // Zoom factor badge (1.0x hidden at full view).
        try {
            const zx = 1 / newSpan;
            _zoomDom.title.textContent = _zoomBaseTitle + (zx > 1.01 ? ` • ${zx.toFixed(1)}X` : '');
        } catch { /* title is best-effort */ }
        // Repaint from the live drag preview when a gesture owns one (keeps
        // the single-selection invariant — preview only, no committed tint);
        // otherwise re-sync from committed state.
        const live = (_zoomLive && _zoomLive.index === idx && _gestureActive) ? _zoomLive : null;
        if (live) {
            paintPreviewCanvases(idx, live.start, live.end, live.startSnapped, live.endSnapped, live.armed);
            mirrorZoomSelection(live.start, live.end, live.startSnapped || live.endSnapped, live.armed);
        } else {
            paintZoomCanvas(idx);
            mirrorZoomOverlay();
        }
    } catch (err) {
        logger.debug(`[Sampler] Loupe wheel zoom skipped`, err);
    }
}

function setPadLoading(index: number, loading: boolean, gen?: number): void {
    if (!padGrid) return;
    const pad = padGrid.children[index]?.querySelector('.pad') as HTMLElement | null;
    if (!pad) return;
    const emptyEl = pad.querySelector('.pad-empty') as HTMLElement | null;
    if (loading) {
        pad.classList.add('loading');
        // Same box, same typography — only the word swaps.
        if (emptyEl) emptyEl.textContent = 'LOADING';
    } else {
        // Stale finisher must not clear a newer in-flight load: a rapid
        // second drop bumps _padLoadGen, so an older gen returning here
        // would otherwise strip LOADING mid-load and strand the label.
        if (gen !== undefined && gen !== _padLoadGen[index]) return;
        pad.classList.remove('loading');
        if (emptyEl) emptyEl.textContent = 'EMPTY';
    }
}

const _padLoadGen: number[] = new Array(16).fill(0);

// Decode semaphore: 16 simultaneous drops previously decoded + waveform'd +
// BPM'd concurrently (each 10-30x RAM expansion) and OOM'd. The kit loader is
// sequential; the drag path was not. Two slots keep multi-drop usable.
let _padDecodeActive = 0;
const _padDecodeWaiters: Array<() => void> = [];
const MAX_PAD_DECODE = 2;
async function acquirePadDecodeSlot(): Promise<void> {
    if (_padDecodeActive < MAX_PAD_DECODE) {
        _padDecodeActive++;
        return;
    }
    await new Promise<void>((resolve) => _padDecodeWaiters.push(resolve));
    // Slot passes directly from releaser to waiter — count unchanged.
}
function releasePadDecodeSlot(): void {
    const next = _padDecodeWaiters.shift();
    if (next) {
        try { next(); } catch { /* ignore */ }
    } else {
        _padDecodeActive = Math.max(0, _padDecodeActive - 1);
    }
}

export async function loadSampleFile(file: File, index: number): Promise<void> {
    const gen = ++_padLoadGen[index];
    setPadLoading(index, true, gen);
    let slot = false;
    try {
        logger.info(`[Sampler] Loading file to pad ${index}: ${file.name}`);
        if (file.size > MAX_FILE_SIZE_BYTES) {
            logger.error(`[Sampler] Pad ${index} rejected: file too large (${file.size} bytes)`);
            toast.error("FILE TOO LARGE (MAX 100MB)");
            return;
        }
        await acquirePadDecodeSlot();
        slot = true;
        if (gen !== _padLoadGen[index]) return; // superseded while queued
        const arrayBuffer = await file.arrayBuffer();
        if (gen !== _padLoadGen[index]) return; // superseded by newer drop

        // Validate audio file signature
        const validationError = validateAudioSignature(arrayBuffer, file.name);
        if (validationError) {
            logger.error(`[Sampler] Pad ${index} validation failed: ${validationError}`);
            toast.error("INVALID AUDIO FILE");
            return;
        }

        // Use native decoder directly (no worker pool — most reliable for one-shot samples)
        if (!ensureAudio() || !audioCtx) { toast.error("AUDIO NOT READY"); return; }
        let audioBuffer: AudioBuffer;
        try {
            audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        } catch (decErr) {
            logger.error(`[Sampler] Pad ${index} decode failed`, decErr);
            toast.error("SAMPLE UNDECODABLE");
            return;
        }
        if (gen !== _padLoadGen[index]) return;

        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        padWaveforms[index] = computeWaveform(audioBuffer);
        // Fresh sample: stale selections/loops belong to the old buffer.
        // Snap toggle survives (in-memory preference); edge glow resets.
        padSelections[index] = null;
        padSnappedEdges[index] = null;
        padArmedBeats[index] = null;
        padLoopStart[index] = -1;
        padLoopEnd[index] = -1;
        logger.info(`[Sampler] Pad ${index}: Buffer set from file (${audioBuffer.duration.toFixed(2)}s)`);
        updatePadVisuals(index);

        // BPM failure must not masquerade as sample-load failure (buffer is playable).
        // needsReview falls back to an estimated grid (prior > 120) so lines
        // + Ctrl-snap always work; strip is repainted on every branch.
        if (detectBPMFn) {
            try {
                const raw = await detectBPMFn(audioBuffer);
                if (gen !== _padLoadGen[index]) return;
                const decision = resolveBpmPersist(raw, padBPMs[index]);
                if (!decision.persisted || decision.bpm === undefined) {
                    const fb = applyBpmFallback(index, audioBuffer.duration);
                    logger.warn(`[Sampler] Pad ${index} BPM needs review — estimated grid @${fb}bpm`);
                    toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                        } else {
                            padBPMs[index] = decision.bpm;
                            padBeatPositions[index] = computeBeatPositions(decision.bpm, audioBuffer.duration);
                            padArmedBeats[index] = null; // grid moved — stale indices
                            try { delete padBpmEstimated[index]; } catch { /* ignore */ }
                            logger.info(`[Sampler] Pad ${index} BPM: ${decision.bpm}, beats: ${padBeatPositions[index].length}`);
                        }
                refreshPadAfterBpm(index);
            } catch (bpmErr) {
                const fb = applyBpmFallback(index, audioBuffer.duration);
                logger.warn(`[Sampler] Pad ${index} BPM detection skipped — estimated grid @${fb}bpm`, bpmErr);
                toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                refreshPadAfterBpm(index);
            }
        } else {
            const fb = applyBpmFallback(index, audioBuffer.duration);
            logger.warn(`[Sampler] Pad ${index} no BPM detector — estimated grid @${fb}bpm`);
            refreshPadAfterBpm(index);
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} file load FAILED: ${e?.message || e}`, e);
        toast.error("SAMPLE LOAD FAILED");
    } finally {
        if (slot) releasePadDecodeSlot();
        setPadLoading(index, false, gen);
    }
}

export async function loadSampleFromPath(path: string, index: number, callerBpm?: number): Promise<boolean> {
    const gen = ++_padLoadGen[index];
    setPadLoading(index, true, gen);
    let slot = false;
    try {
        if (!fsBridgeRef) {
            logger.error(`[Sampler] Pad ${index} path load failed: no filesystem bridge`);
            toast.error("SAMPLE LOAD FAILED");
            return false;
        }
        logger.info(`[Sampler] Loading path to pad ${index}: ${path}`);
        await acquirePadDecodeSlot();
        slot = true;
        if (gen !== _padLoadGen[index]) return true; // superseded while queued
        const rawData = await fsBridgeRef.readFile(path);
        if (!rawData) {
            logger.error(`[Sampler] Read failed for path: ${path}`);
            toast.error("SAMPLE LOAD FAILED");
            return false;
        }
        
        const arrayBuffer = normalizeToArrayBuffer(rawData);
        if (arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            logger.error(`[Sampler] Pad ${index} rejected: decoded size too large`);
            toast.error("FILE TOO LARGE (MAX 100MB)");
            return false;
        }
        
        // Validate audio file signature (kit restores previously failed silently).
        const validationError = validateAudioSignature(arrayBuffer, path.split(/[\\/]/).pop());
        if (validationError) {
            logger.error(`[Sampler] Pad ${index} path validation failed: ${validationError}`);
            toast.error("INVALID AUDIO FILE IN KIT");
            return false;
        }
        if (gen !== _padLoadGen[index]) return true;

        logger.info(`[Sampler] Pad ${index}: Got ${arrayBuffer.byteLength} bytes, decoding...`);

        // Use native decoder directly — slice first: decodeAudioData neuters
        // its input, and the shared/cache-backed buffer must survive retries
        // (matches loadSampleFile).
        if (!ensureAudio() || !audioCtx) { toast.error("AUDIO NOT READY"); return false; }
        let audioBuffer: AudioBuffer;
        try {
            audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        } catch (decErr) {
            logger.error(`[Sampler] Pad ${index} path decode failed`, decErr);
            toast.error("KIT SAMPLE UNDECODABLE");
            return false;
        }
        if (gen !== _padLoadGen[index]) return true;

        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        padWaveforms[index] = computeWaveform(audioBuffer);
        // Fresh sample: stale selections/loops belong to the old buffer.
        // Snap toggle survives (in-memory preference); edge glow resets.
        padSelections[index] = null;
        padSnappedEdges[index] = null;
        padArmedBeats[index] = null;
        padLoopStart[index] = -1;
        padLoopEnd[index] = -1;
        logger.info(`[Sampler] Pad ${index}: Buffer set (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`);
        updatePadVisuals(index);
        // needsReview falls back to an estimated grid (prior > caller > 120)
        // so lines + Ctrl-snap always work; strip repainted on every branch.
        if (detectBPMFn) {
            try {
                const raw = await detectBPMFn(audioBuffer);
                if (gen !== _padLoadGen[index]) return true;
                const decision = resolveBpmPersist(raw, padBPMs[index]);
                if (!decision.persisted || decision.bpm === undefined) {
                    const fb = applyBpmFallback(index, audioBuffer.duration, callerBpm);
                    logger.warn(`[Sampler] Pad ${index} BPM needs review — estimated grid @${fb}bpm`);
                    toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                } else {
                    padBPMs[index] = decision.bpm;
                    padBeatPositions[index] = computeBeatPositions(decision.bpm, audioBuffer.duration);
                    padArmedBeats[index] = null; // grid moved — stale indices
                    try { delete padBpmEstimated[index]; } catch { /* ignore */ }
                }
                refreshPadAfterBpm(index);
            } catch (bpmErr) {
                const fb = applyBpmFallback(index, audioBuffer.duration, callerBpm);
                logger.warn(`[Sampler] Pad ${index} BPM detection skipped — estimated grid @${fb}bpm`, bpmErr);
                toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                refreshPadAfterBpm(index);
            }
        } else {
            const fb = applyBpmFallback(index, audioBuffer.duration, callerBpm);
            logger.warn(`[Sampler] Pad ${index} no BPM detector — estimated grid @${fb}bpm`);
            refreshPadAfterBpm(index);
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
        return true;
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} path load FAILED: ${e?.message || e}`, e);
        toast.error("SAMPLE LOAD FAILED");
        return false;
    } finally {
        if (slot) releasePadDecodeSlot();
        setPadLoading(index, false, gen);
    }
}

/**
 * Trigger a pad. Plays the waveform selection from its start when one
 * exists, otherwise the full sample. Short presses (keyboard, MIDI, mouse
 * click) play once; pass { loop: true } — or hold the pad past the
 * long-press delay — to repeat the active area while held.
 */
export function startPad(index: number, opts?: { loop?: boolean }): void {
    logger.debug(`[Sampler] startPad(${index}) called. Buffer exists: ${!!padBuffers[index]}`);
    if (!padBuffers[index]) {
        flashPadDenied(index);
        logger.debug(`[Sampler] Pad ${index} trigger denied (no sample loaded)`);
        return;
    }
    if (!ensureAudio() || !audioCtx || !masterGain) {
        flashPadDenied(index);
        logger.warn(`[Sampler] Audio not ready, cannot start pad ${index}`);
        return;
    }
    // Guard against AudioContext being in closed state (ensureAudio rebuilds)
    if (audioCtx.state === 'closed' && !ensureAudio()) {
        flashPadDenied(index);
        logger.warn(`[Sampler] AudioContext is closed, cannot start pad ${index}`);
        return;
    }
    // Context rebuild orphans live voices (gain nodes bound to the dead
    // context/master). Stop them so the new trigger isn't silent/mixed.
    try {
        const cur = (audioCtx as AudioContext | null);
        if (cur && (_poolCtx as AudioContext | null) && (_poolCtx as AudioContext | null) !== cur) {
            stopAllPads();
        }
    } catch { /* ignore */ }
    
    resumeAudioContext();
    
    // Stop previous instance if playing
    stopPad(index);

    // Hoisted so the catch block can release a voice that never registered
    // (C17) — previously a start() throw after acquire leaked the gain node.
    let source: AudioBufferSourceNode | null = null;
    let gainNode: GainNode | null = null;
    try {
        const buf = padBuffers[index];
        const bufDur = buf?.duration ?? 0;
        if (!buf || !(bufDur > 0)) {
            flashPadDenied(index);
            logger.debug(`[Sampler] Pad ${index} trigger denied (buffer vanished mid-start)`);
            return;
        }
        // Acquire BEFORE creating the source: a null return used to strand an
        // orphaned BufferSource (created but never connected/started).
        gainNode = acquireGain();
        if (!gainNode) {
            flashPadDenied(index);
            logger.warn(`[Sampler] No gain node for pad ${index}`);
            return;
        }
        source = audioCtx.createBufferSource();
        source.buffer = buf;
        const wantLoop = opts?.loop === true;
        // One-shot selection playback never loops; long-press repeats.
        source.loop = false;

        // Active area drives both the start offset and the loop points.
        const region = getActiveRegion(index);
        const currentVol = padVolumes[index] !== undefined ? padVolumes[index] : DEFAULT_PAD_VOLUME;
        gainNode.gain.setValueAtTime(currentVol, audioCtx.currentTime);
        
        const tempoEl = resolveTempoSlider();
        let rate = tempoEl ? parseFloat(tempoEl.value) : 1;
        // Selection plays from its start; full sample starts at zero.
        let startOffset = region ? region.start : 0;
        
        if (padSyncState[index] && masterBPMRef.value > 0 && padBPMs[index] > 0) {
            // Adjust playback rate to match master BPM (clamped like the deck).
            rate = (masterBPMRef.value / padBPMs[index]) * rate;
            rate = Math.min(1.5, Math.max(0.5, rate));

            // Beat-quantized start: snap to nearest beat in the master timeline
            const masterBPS = masterBPMRef.value / 60; // beats per second
            const padBeatDuration = 60 / padBPMs[index]; // one beat in the pad's native time

            // Get current position in the master audio — from the channel
            // that is actually playing (main or crossfade), with a finite
            // duration guard so a not-yet-loaded deck can't poison the phase.
            const mainAudio = engine.main.audio;
            const xAudio = engine.crossfade.audio;
            const playerAudio = (mainAudio && !mainAudio.paused) ? mainAudio
                : (xAudio && !xAudio.paused) ? xAudio : mainAudio;
            if (playerAudio && playerAudio.currentTime > 0 && Number.isFinite(playerAudio.duration) && playerAudio.duration > 0) {
                const masterBeatPhase = (playerAudio.currentTime * masterBPS) % 1; // 0-1 phase within current beat
                // Start the pad at the same phase position within its beat cycle
                startOffset = masterBeatPhase * padBeatDuration;
            }
            // Clamp: short stabs shorter than one beat previously threw RangeError.
            const dur = padBuffers[index]?.duration ?? 0;
            if (!Number.isFinite(startOffset) || startOffset < 0) startOffset = 0;
            if (dur > 0 && startOffset >= dur) startOffset = 0;
            // Keep the beat-quantized offset inside the selection so SYNC
            // never jumps playback outside the chosen area.
            if (region && (startOffset < region.start || startOffset >= region.end)) {
                startOffset = region.start;
            }
        }
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        if (!Number.isFinite(startOffset) || startOffset < 0) startOffset = 0;
        if (bufDur > 0 && startOffset >= bufDur) startOffset = region ? region.start : 0;
        source.playbackRate.value = rate;

        source.connect(gainNode);
        gainNode.connect(masterGain);
        if (wantLoop) {
            // Held pad: repeat the active area (selection, else full sample).
            if (region) {
                source.loopStart = region.start;
                source.loopEnd = region.end;
            } else {
                source.loopStart = 0;
                source.loopEnd = bufDur;
            }
            source.loop = true;
            source.start(0, startOffset);
        } else if (region && region.end > startOffset) {
            // One-shot: stop at the selection end instead of the file end.
            source.start(0, startOffset, region.end - startOffset);
        } else {
            source.start(0, startOffset);
        }
        logger.debug(`[Sampler] Pad ${index} playing! Rate: ${rate.toFixed(3)}, Offset: ${startOffset.toFixed(3)}s`);
        
        // Register the voice for cleanup
        activeVoices[index] = { source, gain: gainNode };
        padPlayState[index] = { t0: audioCtx.currentTime, offset: startOffset, rate };
        ensurePlayheadLoop();

        // Narrowed aliases for the async cleanup below.
        const endedSource: AudioBufferSourceNode = source;
        const endedGain: GainNode = gainNode;
        // Cleanup after source finishes playing naturally
        endedSource.onended = () => {
            if (activeVoices[index]?.source === endedSource) {
                try {
                    endedSource.disconnect();
                } catch (e) { /* already disconnected */ }
                // Return gain node to pool
                releaseGain(endedGain);
                if (activeVoices[index]?.source === endedSource) {
                    activeVoices[index] = null;
                }
                padPlayState[index] = null;
                updatePadVisuals(index);
            }
        };
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} start failed: ${e.message || e}`);
        // Release a voice that never registered (start() threw after
        // acquire) — without this the gain node leaks out of the pool.
        try {
            if (gainNode && activeVoices[index]?.source !== source) releaseGain(gainNode);
        } catch { /* ignore */ }
        // Ensure we don't leak activeVoices reference on failure
        if (activeVoices[index]?.gain) {
            releaseGain(activeVoices[index]!.gain);
        }
        activeVoices[index] = null;
    }
    
    updatePadVisuals(index);
}

/** Stop every looping pad voice (focus-loss safety — looped sources never end on their own). */
export function stopAllPads(): void {
    for (let i = 0; i < NUM_PADS; i++) {
        try { stopPad(i); } catch { /* ignore */ }
    }
}

export function stopPad(index: number): void {
    disarmLongPress(index);
    padPlayState[index] = null;
    try {
        const marker = padGrid?.children[index]?.querySelector('.pad-playhead') as HTMLElement | null;
        if (marker) marker.classList.add('hidden');
    } catch { /* ignore */ }
    const currentVoice = activeVoices[index];
    if (currentVoice) {
        try { 
            currentVoice.source.stop(); 
        } catch (e) { /* Already stopped or audioCtx closed */ }
        try { 
            currentVoice.source.disconnect(); 
        } catch (e) { /* Already disconnected */ }
        // Return gain node to pool instead of discarding
        releaseGain(currentVoice.gain);
        activeVoices[index] = null;
    }
    updatePadVisuals(index);
}

export function toggleSync(index: number): void { 
    padSyncState[index] = !padSyncState[index]; 
    updatePadVisuals(index);
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
}

export function createPadGrid(): void {
    if (!padGrid) return;
    if (padGrid.children.length > 0) return; // Guard: prevent duplicate grid on hot reload
    padGrid.innerHTML = '';
    for (let i = 0; i < NUM_PADS; i++) {
        const wrapper = renderPad(i);
        padGrid.appendChild(wrapper);
    }
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\//g, '&#x2F;');
}

function renderPad(index: number, existing?: HTMLElement): HTMLElement {
    const wrapper = (existing || document.createElement('div')) as HTMLElement;
    if (!existing) {
        wrapper.className = 'pad-wrapper';
        wrapper.style.position = 'relative';
        const currentKey = state.padKeyMap[index] || "?";
        const safeKey = escapeAttr(currentKey);
        const padNum = String(index + 1).padStart(2, '0');
        // Layout (per design): top row = LED + pad number + MIDI/SYNC badges,
        // middle = waveform strip, below = square trigger button (key label)
        // centered under the strip. The outer .pad stays the trigger
        // hit-target (existing main.ts/sampler.ts listeners attach to it and
        // inner clicks bubble up), so all trigger/long-press/menu behavior
        // is preserved — only the visual hit-target moved + centered.
        wrapper.innerHTML = `
            <div class="pad" data-key="${safeKey}">
                <div class="pad-top">
                    <span class="rec-btn" title="Hold to Record"></span>
                    <span class="pad-num">${padNum}</span>
                    <span class="pad-badges">
                        <span class="pad-sync hidden" title="Tempo sync on">SYNC</span>
                        <span class="pad-midi hidden" title="MIDI bound">MIDI</span>
                    </span>
                </div>
                <div class="pad-wave" title="Drag to select • Shift hold/drag zooms • Ctrl snaps to beats • Shift+Ctrl arms region • Hold selection to loop">
                    <canvas class="pad-canvas"></canvas>
                    <div class="pad-selection hidden"></div>
                    <div class="pad-playhead hidden"></div>
                    <div class="pad-empty">EMPTY</div>
                </div>
                <button type="button" class="pad-trigger" data-key="${safeKey}" aria-pressed="false" aria-label="Trigger pad ${padNum} (key ${safeKey.toUpperCase()})" title="Click / hold to trigger">
                    <span class="pad-key" title="Keyboard key">${safeKey.toUpperCase()}</span>
                </button>
                <span class="pad-name" title="Empty pad — click to load">EMPTY</span>
            </div>
            <input type="range" class="pad-slider" min="0" max="1" step="0.01" aria-label="Pad ${padNum} volume">
        `;

        const pad = wrapper.querySelector('.pad') as HTMLElement;
        const recBtn = wrapper.querySelector('.rec-btn') as HTMLElement;
        const volSlider = wrapper.querySelector('.pad-slider') as HTMLInputElement;

        recBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); startRecording(index); });
        recBtn.addEventListener('mouseup', (e) => { e.stopPropagation(); stopRecording(index); });
        recBtn.addEventListener('mouseleave', (e) => { e.stopPropagation(); stopRecording(index); });
        recBtn.addEventListener('click', (e) => { e.stopPropagation(); }); // Prevent file dialog from opening
        // Global fallbacks: releasing outside the button (or alt-tabbing
        // mid-take) previously left the mic running with no way to stop it
        // short of re-pressing the tiny LED.
        window.addEventListener('mouseup', () => { try { stopRecording(index); } catch { /* ignore */ } });
        window.addEventListener('blur', () => { try { stopRecording(index); } catch { /* ignore */ } });

        pad.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.add('drag-over'); });
        pad.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); });
        pad.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); 
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file) loadSampleFile(file, index);
            }
        });

        volSlider.addEventListener('input', () => {
            const v = parseFloat(volSlider.value);
            padVolumes[index] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.75;
            const currentVoice = activeVoices[index];
            if (currentVoice && audioCtx) {
                try {
                    currentVoice.gain.gain.cancelScheduledValues(audioCtx.currentTime);
                    currentVoice.gain.gain.setValueAtTime(padVolumes[index], audioCtx.currentTime);
                } catch { /* audio closed */ }
            }
        });

        // === WAVEFORM STRIP (waveform-first interaction) ===
        // NOTE: the old canvas click-to-loop handler was inert — .pad-canvas
        // has pointer-events:none, so clicks never reached it.
        // Modifier scheme: SHIFT = zoom loupe (open while held, mouseup
        // commits but keeps it open for re-drags; closes on Shift release /
        // blur / Escape). CTRL = beat mode (markers + magnetic snap appear
        // only while also held). SHIFT+CTRL+drag arms the snapped beat-span
        // as the persistent active region (.armed).
        // Gestures, distinguished by movement + hold time:
        // - HOLD inside an existing selection/filled region (still, ~220ms):
        //   loop-auditions that area until release (startPad loop path).
        //   With SHIFT held the hold opens the zoom loupe instead (no audition).
        // - DRAG: move beyond ~5px first -> fresh selection drag. Plain drag
        //   is free; CTRL+drag (with SHIFT held) reveals beat markers, keeps
        //   the zoom loupe open, and magnetically snaps both edges via
        //   quantizeSelectionToBeat + snapped-edge glow (mirrored strip +
        //   loupe). SHIFT+CTRL commit arms the span (.armed).
        // - CLICK (quick, no move): keeps the old selection.
        const wave = wrapper.querySelector('.pad-wave') as HTMLElement;
        if (wave) {
            wave.addEventListener('mousedown', (e) => {
                const buf = padBuffers[index];
                if (!buf || !(buf.duration > 0) || e.button !== 0) return;
                if (_gestureActive) return; // loupe re-drag funnels here too
                // Don't trigger the pad or the long-press timer from a strip gesture.
                e.stopPropagation();
                e.preventDefault();
                const rect = wave.getBoundingClientRect();
                if (rect.width <= 0) return;
                _gestureActive = true;
                const x0 = e.clientX, y0 = e.clientY;
                let lastCX = e.clientX, lastCY = e.clientY;
                const frac0 = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                const selEl = wave.querySelector('.pad-selection') as HTMLElement | null;
                const region = getActiveRegion(index);
                const pressT = frac0 * buf.duration;
                const insideRegion = !!region && pressT >= region.start && pressT <= region.end;
                let cur = frac0;
                let mode: 'pending' | 'drag' | 'audition' = insideRegion ? 'pending' : 'drag';
                let holdTimer: ReturnType<typeof setTimeout> | null = null;
                let shiftReveal = false;
                let shiftHeld = e.shiftKey;
                let ctrlHeld = e.ctrlKey;
                let lastRectW = rect.width;
                let lastPreview: { start: number; end: number; startSnapped: boolean; endSnapped: boolean; armed: boolean } | null = null;

                // Beat-marker reveal while Shift is held (canvas redraw only —
                // the live DOM preview geometry is re-applied by the caller).
                const setShiftReveal = (on: boolean): void => {
                    if (on === shiftReveal) return;
                    shiftReveal = on;
                    wave.classList.toggle('show-beats', on);
                    try { renderWaveform(index, { beatBoost: on }); } catch { /* ignore */ }
                    reapplyPreviewOverlay();
                };

                // Re-assert the live preview overlays (strip repaint above
                // resets the DOM overlay from stored state mid-drag).
                const reapplyPreviewOverlay = (): void => {
                    if (!selEl || !lastPreview) return;
                    const pv = lastPreview;
                    selEl.classList.remove('hidden');
                    selEl.style.left = ((pv.start / buf.duration) * 100).toFixed(2) + '%';
                    selEl.style.width = (((pv.end - pv.start) / buf.duration) * 100).toFixed(2) + '%';
                    selEl.classList.toggle('snapped', pv.startSnapped || pv.endSnapped);
                    selEl.classList.toggle('armed', pv.armed);
                    if (isZoomOpenFor(index)) mirrorZoomSelection(pv.start, pv.end, pv.startSnapped || pv.endSnapped, pv.armed);
                };

                const openZoomHere = (): void => {
                    if (isZoomOpenFor(index)) return;
                    try {
                        const r = wave.getBoundingClientRect();
                        openZoom(index, lastCX, lastCY, r.width > 0 ? r.width : 160);
                        reapplyPreviewOverlay();
                    } catch (err) {
                        logger.debug(`[Sampler] Pad ${index} loupe open skipped (sizing/paint failure)`, err);
                    }
                };

                // Single owner for modifier transitions (mouse moves + Shift/
                // Ctrl keydown/keyup). Shift owns the loupe lifetime: open
                // while held; mouseup commits but never closes (re-drags
                // welcome); closes only on Shift release / blur / Escape.
                // Ctrl owns beat mode: markers + snap on Ctrl alone (loupe
                // stays Shift-gated); release returns to free selection.
                const syncModifiers = (): void => {
                    setShiftReveal(ctrlHeld && isSnapEnabled(index));
                    if (shiftHeld && (mode === 'pending' || mode === 'drag')) openZoomHere();
                    else if (!shiftHeld) closeZoomIfOurs();
                };
                // Shift-only entry points route through here.
                const updateShiftState = (on: boolean): void => {
                    shiftHeld = on;
                    syncModifiers();
                };

                const closeZoomIfOurs = (): void => {
                    if (isZoomOpenFor(index)) closeZoom();
                };

                const applyPreview = (aFrac: number, bFrac: number, shift: boolean, ctrl: boolean, rectW: number): void => {
                    if (!selEl) return;
                    const aSec = aFrac * buf.duration;
                    const bSec = bFrac * buf.duration;
                    selEl.classList.remove('hidden');
                    // Ctrl-alone beat mode; Shift only owns the loupe.
                    if (ctrl && isSnapEnabled(index)) {
                        // Loupe pixels cover only the zoom window, so scale the
                        // snap radius back to full-duration terms (12px in
                        // loupe space = 12*span seconds, not 12*duration).
                        let qW = rectW;
                        if (isZoomOpenFor(index)) {
                            const sp = Math.max(1e-6, _zoomView.end - _zoomView.start);
                            if (sp < 1) qW = rectW / sp;
                        }
                        const q = quantizeSelectionToBeat(index, aSec, bSec, qW, buf.duration);
                        // Ctrl makes the snapped span stick: live armed look
                        // while held; commit persists it (both edges on beats).
                        const armedLive = ctrl && q.startSnapped && q.endSnapped;
                        lastPreview = { ...q, armed: armedLive };
                        _zoomLive = { index, ...lastPreview };
                        selEl.style.left = ((q.start / buf.duration) * 100).toFixed(2) + '%';
                        selEl.style.width = (((q.end - q.start) / buf.duration) * 100).toFixed(2) + '%';
                        selEl.classList.toggle('snapped', q.startSnapped || q.endSnapped);
                        selEl.classList.toggle('armed', armedLive);
                        if (isZoomOpenFor(index)) mirrorZoomSelection(q.start, q.end, q.startSnapped || q.endSnapped, armedLive);
                        paintPreviewCanvases(index, q.start, q.end, q.startSnapped, q.endSnapped, armedLive);
                    } else {
                        lastPreview = { start: Math.min(aSec, bSec), end: Math.max(aSec, bSec), startSnapped: false, endSnapped: false, armed: false };
                        _zoomLive = { index, ...lastPreview };
                        const a = Math.min(aFrac, bFrac);
                        const b = Math.max(aFrac, bFrac);
                        selEl.style.left = (a * 100).toFixed(2) + '%';
                        selEl.style.width = ((b - a) * 100).toFixed(2) + '%';
                        selEl.classList.remove('snapped');
                        selEl.classList.remove('armed');
                        if (isZoomOpenFor(index)) mirrorZoomSelection(lastPreview.start, lastPreview.end, false, false);
                        paintPreviewCanvases(index, lastPreview.start, lastPreview.end, false, false, false);
                    }
                };

                // Re-run the current preview (Ctrl pressed/released mid-drag
                // with no mouse move: upgrades/downgrades the armed look).
                const refreshLivePreview = (): void => {
                    if (mode !== 'drag') return;
                    applyPreview(frac0, cur, shiftHeld, ctrlHeld, lastRectW);
                };

                const stopAudition = (): void => {
                    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                    try { stopPad(index); } catch { /* ignore */ }
                };

                if (mode === 'pending') {
                    holdTimer = setTimeout(() => {
                        holdTimer = null;
                        if (mode !== 'pending') return;
                        // Shift+hold opens the loupe instead of auditioning —
                        // plain hold keeps the loop audition below.
                        if (shiftHeld) { openZoomHere(); return; }
                        mode = 'audition';
                        try { startPad(index, { loop: true }); } catch { mode = 'pending'; }
                    }, HOLD_LOOP_MS);
                } else {
                    // Press started outside any region: live drag from the
                    // first pixel (0.02s minimum still guards clicks on release).
                    updateShiftState(e.shiftKey);
                }
                const onMove = (ev: MouseEvent): void => {
                    lastCX = ev.clientX; lastCY = ev.clientY;
                    if (mode === 'audition') return; // looping — moves are ignored
                    const dx = ev.clientX - x0, dy = ev.clientY - y0;
                    if (mode === 'pending') {
                        if (dx * dx + dy * dy <= HOLD_DRAG_PX * HOLD_DRAG_PX) return; // still holding
                        // Broke the stillness budget first -> fresh selection drag.
                        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                        mode = 'drag';
                    }
                    // While the loupe is open it owns the coordinate space
                    // (inset canvas = finer control); otherwise the strip does.
                    // Loupe x is window-relative — convert to the global frac
                    // (viewStart + win*span) so frac0 (global, from the strip
                    // press or the converted synth path) and cur share a space
                    // through applyPreview/commit.
                    const zoomOpen = isZoomOpenFor(index);
                    let r: DOMRect;
                    if (zoomOpen && _zoomDom) {
                        r = _zoomDom.canvas.getBoundingClientRect() as DOMRect;
                        if (r.width <= 0) return;
                        const win = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
                        const span = Math.max(1e-6, _zoomView.end - _zoomView.start);
                        cur = Math.min(1, Math.max(0, _zoomView.start + win * span));
                    } else {
                        r = wave.getBoundingClientRect();
                        if (r.width <= 0) return;
                        cur = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
                    }
                    shiftHeld = ev.shiftKey;
                    ctrlHeld = ev.ctrlKey;
                    lastRectW = r.width;
                    syncModifiers();
                    applyPreview(frac0, cur, ev.shiftKey, ev.ctrlKey, r.width);
                };
                const onUp = (upEv?: MouseEvent): void => {
                    const wasAudition = mode === 'audition';
                    cleanupDrag();
                    if (wasAudition) {
                        // Loop audition ends on release; selection untouched.
                        // main.ts window-mouseup also chokes — belt + suspenders.
                        try { stopPad(index); } catch { /* ignore */ }
                        try { renderWaveform(index); } catch { /* ignore */ }
                        return;
                    }
                    const a = Math.min(frac0, cur);
                    const b = Math.max(frac0, cur);
                    if (mode === 'pending' || (b - a) * buf.duration < 0.02) {
                        // Quick click / no real drag — keep the old selection
                        // (and any armed mark).
                        logger.debug(`[Sampler] Pad ${index} drag discarded (${mode === 'pending' ? 'no-move-click' : `span-${((b - a) * buf.duration).toFixed(3)}s-under-0.02s`}) — selection kept`);
                        renderWaveform(index);
                        syncZoomToCommitted(index);
                        return;
                    }
                    try {
                        // Commit the last live preview (modifier release mid-drag
                        // keeps the snapped edges — it never clears them).
                        // Event-accurate modifiers: a release with no trailing
                        // mousemove must still downgrade correctly.
                        const ctrlAtCommit = upEv?.ctrlKey ?? ctrlHeld;
                        const shiftAtCommit = upEv?.shiftKey ?? shiftHeld;
                        const pv = lastPreview;
                        let sSec = pv ? pv.start : a * buf.duration;
                        let eSec = pv ? pv.end : b * buf.duration;
                        sSec = clampToBuffer(index, sSec);
                        eSec = clampToBuffer(index, eSec);
                        if (!(eSec > sSec) || (eSec - sSec) < 0.02) {
                            logger.debug(`[Sampler] Pad ${index} drag discarded (${!(eSec > sSec) ? 'collapsed-span' : `span-${(eSec - sSec).toFixed(3)}s-under-0.02s`}) — selection kept`);
                            renderWaveform(index);
                            syncZoomToCommitted(index);
                            return;
                        }
                        const sS = !!pv?.startSnapped, sE = !!pv?.endSnapped;
                        // Ctrl-alone edge glow (no Shift requirement); release
                        // before commit clears it.
                        padSnappedEdges[index] = (ctrlAtCommit && (sS || sE)) ? { start: sS, end: sE } : null;
                        if (shiftAtCommit && ctrlAtCommit && sS && sE && isSnapEnabled(index)) {
                            // Shift+Ctrl commit: arm the snapped beat-span as the
                            // persistent active region (hold-to-loop target).
                            const bi1 = beatIndexForTime(index, sSec);
                            const bi2 = beatIndexForTime(index, eSec);
                            if (bi1 !== null && bi2 !== null) {
                                padArmedBeats[index] = { from: Math.min(bi1, bi2), to: Math.max(bi1, bi2) };
                            } else {
                                padArmedBeats[index] = null;
                                logger.debug(`[Sampler] Pad ${index} arm downgraded (beat-index-unresolved) — plain selection kept`);
                            }
                        } else {
                            // Plain re-drag replaces the selection and clears
                            // the armed mark (Ctrl arms only while held).
                            // Downgrade reason first: silent fallbacks are
                            // indistinguishable from a dead strip otherwise.
                            if (padArmedBeats[index]) {
                                const why = !shiftAtCommit ? 'shift-released'
                                    : !ctrlAtCommit ? 'ctrl-released'
                                    : (!sS || !sE) ? 'edges-off-grid'
                                    : 'no-beat-grid';
                                logger.debug(`[Sampler] Pad ${index} arm downgraded (${why}) — armed mark cleared, plain selection kept`);
                            } else if (shiftAtCommit && ctrlAtCommit) {
                                const why = (!sS || !sE) ? 'edges-off-grid' : 'no-beat-grid';
                                logger.debug(`[Sampler] Pad ${index} arm skipped (${why}) — plain selection kept`);
                            } else if (ctrlAtCommit && sS && sE) {
                                logger.debug(`[Sampler] Pad ${index} arm skipped (shift-released) — snapped edges kept`);
                            }
                            padArmedBeats[index] = null;
                        }
                        setPadSelection(index, sSec, eSec);
                        syncZoomToCommitted(index);
                    } catch (err) {
                        logger.error(`[Sampler] Waveform select failed for pad ${index}:`, err);
                    }
                };
                const onStripLeave = (): void => {
                    // Drags may leave the strip freely (window tracks them);
                    // only a looping audition chokes on leave (momentary).
                    if (mode !== 'audition') return;
                    mode = 'pending';
                    stopAudition();
                    cleanupDrag();
                    try { renderWaveform(index); } catch { /* ignore */ }
                };
                // Blur/Esc mid-gesture previously leaked the window listeners
                // and left a phantom selection overlay; both now cancel cleanly
                // (and close the loupe — mouseup commits never do).
                const cleanupDrag = (): void => {
                    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                    _gestureActive = false;
                    // Live preview dies with the gesture — a later wheel zoom
                    // repaints from committed state (wheel handler checks this).
                    if (_zoomLive && _zoomLive.index === index) _zoomLive = null;
                    wave.classList.remove('show-beats');
                    shiftReveal = false;
                    wave.removeEventListener('mouseleave', onStripLeave);
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    window.removeEventListener('blur', onDragCancel);
                    document.removeEventListener('keydown', onDragKey, true);
                    document.removeEventListener('keyup', onModifierKeyUp, true);
                };
                const onDragCancel = (): void => {
                    const wasAudition = mode === 'audition';
                    cleanupDrag();
                    closeZoomIfOurs();
                    if (wasAudition) { try { stopPad(index); } catch { /* ignore */ } }
                    try { renderWaveform(index); } catch { /* ignore */ }
                };
                const onDragKey = (ev: KeyboardEvent): void => {
                    if (ev.key === 'Escape') { onDragCancel(); return; }
                    // Modifiers pressed mid-hold/drag (no mouse move needed).
                    if (ev.key === 'Shift') { shiftHeld = true; syncModifiers(); }
                    // Ctrl pressed mid-drag enters beat mode (markers + snap).
                    if (ev.key === 'Control') { ctrlHeld = true; syncModifiers(); refreshLivePreview(); }
                };
                const onModifierKeyUp = (ev: KeyboardEvent): void => {
                    if (ev.key === 'Shift') { shiftHeld = false; syncModifiers(); }
                    // Ctrl release hides markers + returns to free selection;
                    // Shift+loupe stays open, preview/selection kept.
                    if (ev.key === 'Control') { ctrlHeld = false; syncModifiers(); refreshLivePreview(); }
                };
                wave.addEventListener('mouseleave', onStripLeave);
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
                window.addEventListener('blur', onDragCancel);
                document.addEventListener('keydown', onDragKey, true);
                document.addEventListener('keyup', onModifierKeyUp, true);
            });
        }

        // === LONG-PRESS-TO-LOOP (mouse hold upgrades the voice to loop) ===
        // Runs alongside main.ts's own pad trigger — that starts the one-shot
        // voice, this only flips it to loop when the hold passes the delay.
        pad.addEventListener('mousedown', (e) => {
            if (e.button === 0 && padBuffers[index]) armLongPress(index);
        });
        pad.addEventListener('mouseup', () => disarmLongPress(index));
        pad.addEventListener('mouseleave', () => disarmLongPress(index));

        // === RIGHT-CLICK VISIBILITY for the pad menu items ===
        // main.ts shows the menu afterwards; it never touches these ids, so
        // setting them here (first listener) sticks.
        pad.addEventListener('contextmenu', () => {
            try {
                const unSel = document.getElementById('ctxUnselectArea');
                if (unSel) unSel.classList.toggle('hidden', !getActiveRegion(index));
            } catch { /* ignore */ }
        });
    }

    const pad = wrapper.querySelector('.pad') as HTMLElement;
    const volSlider = wrapper.querySelector('.pad-slider') as HTMLInputElement;

    // UPDATE VISUALS (selection + loop data untouched — survives re-render)
    pad.classList.toggle('loaded', !!padBuffers[index]);
    pad.classList.toggle('active', !!activeVoices[index]);
    pad.setAttribute('aria-pressed', activeVoices[index] ? 'true' : 'false');

    // Record LED follows load/play state (CSS-only glow — recording class wins).
    const recLed = pad.querySelector('.rec-btn');
    if (recLed) {
        recLed.classList.toggle('loaded', !!padBuffers[index]);
        recLed.classList.toggle('playing', !!activeVoices[index]);
    }

    const padNumEl = pad.querySelector('.pad-num');
    if (padNumEl) padNumEl.textContent = String(index + 1).padStart(2, '0');

    const keyBadge = pad.querySelector('.pad-key');
    if (keyBadge) keyBadge.textContent = (state.padKeyMap[index] || '?').toUpperCase();

    // Keep the centered trigger button in sync (key label lives here now).
    const trigger = pad.querySelector('.pad-trigger') as HTMLElement | null;
    if (trigger) {
        const k = (state.padKeyMap[index] || '?').toUpperCase();
        trigger.setAttribute('data-key', state.padKeyMap[index] || '?');
        trigger.setAttribute('aria-pressed', activeVoices[index] ? 'true' : 'false');
        trigger.setAttribute('aria-label', `Trigger pad ${String(index + 1).padStart(2, '0')} (key ${k})`);
    }

    const syncBadge = pad.querySelector('.pad-sync');
    if (syncBadge) syncBadge.classList.toggle('hidden', !padSyncState[index]);

    const midiBadge = pad.querySelector('.pad-midi');
    if (midiBadge) midiBadge.classList.toggle('hidden', padMidiNote(index) === null);

    // The EMPTY hint lives in the waveform strip until a sample loads.
    // Loading-aware: a re-render mid-load (volume input, mapping change)
    // must keep LOADING, never flash EMPTY — same element, same typography.
    const emptyEl = pad.querySelector('.pad-empty') as HTMLElement | null;
    if (emptyEl) {
        emptyEl.classList.toggle('hidden', !!padBuffers[index]);
        if (!padBuffers[index]) {
            emptyEl.textContent = pad.classList.contains('loading') ? 'LOADING' : 'EMPTY';
        }
    }

    const nameEl = pad.querySelector('.pad-name') as HTMLElement | null;
    if (nameEl) {
        if (padBuffers[index]) {
            const fullName = padPaths[index] || 'Sample';
            const fileName = fullName.split(/[\\/]/).pop()?.split('.')[0] || 'Sample';
            // Full name in the DOM — CSS ellipsis truncates, title shows all.
            nameEl.textContent = fileName.toUpperCase();
            nameEl.title = fullName;
        } else {
            nameEl.textContent = '';
            nameEl.title = 'Empty pad — click to load';
        }
    }

    volSlider.value = padVolumes[index].toString();

    return wrapper;
}

export function setupPadKeyboardHandlers(): void {
    let keyLearnTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelKeyLearn = () => {
        if (keyLearnTimer) { clearTimeout(keyLearnTimer); keyLearnTimer = null; }
    };
    state.subscribe('isLearningKey', (learning) => {
        cancelKeyLearn();
        if (!learning) return;
        keyLearnTimer = setTimeout(() => {
            if (!state.isLearningKey) return;
            state.update({ isLearningKey: false, keyLearnTargetPad: null });
            toast.info("KEY BIND TIMED OUT");
        }, 10000);
    });
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        // Typing in search/inputs must never trigger pads or steal keys —
        // previously typing 'a' in playlist search fired the pad.
        const t = e.target as HTMLElement | null;
        try {
            const tag = (t?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
        } catch { /* ignore */ }
        
        // Handle Key Learn Mode (steal-free: swap so two pads never share a key)
        if (state.isLearningKey && state.keyLearnTargetPad !== null) {
            e.preventDefault();
            const padIndex = state.keyLearnTargetPad;
            const key = e.key.toLowerCase();
            // Ignore pure modifiers — binding "shift" strands the pad.
            if (['shift', 'control', 'alt', 'meta'].includes(key)) return;
            // Transport/system keys must never become pad triggers (H16) —
            // binding SPACE/ENTER/arrows/Delete strands core controls, and
            // the pad handler double-fires with the transport handler.
            if ([' ', 'enter', 'tab', 'escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'delete', 'backspace', 'home', 'end', 'pageup', 'pagedown'].includes(key)) {
                toast.info(`KEY "${e.key.toUpperCase()}" RESERVED FOR TRANSPORT`);
                return;
            }
            const newMap = [...state.padKeyMap];
            const other = newMap.indexOf(key);
            if (other !== -1 && other !== padIndex) newMap[other] = newMap[padIndex];
            newMap[padIndex] = key;
            cancelKeyLearn();
            state.update({ padKeyMap: newMap, isLearningKey: false, keyLearnTargetPad: null });
            toast.success(`PAD ${padIndex + 1} BOUND TO KEY "${e.key.toUpperCase()}"`);
            return;
        }
        
        const index = state.padKeyMap.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (e.ctrlKey) {
                startRecording(index);
            } else if (!e.altKey && padBuffers[index]) {
                startPad(index);
                // Hold-to-loop (parity with mouse hold): past LONG_PRESS_MS
                // the live voice loops the selection; keyup -> stopPad disarms.
                armLongPress(index);
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        try {
            const t = e.target as HTMLElement | null;
            const tag = (t?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
        } catch { /* ignore */ }
        const index = state.padKeyMap.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (activeRecorders[index]) stopRecording(index);
            else stopPad(index);
        }
    });
    
    const btnSaveKit = document.getElementById('btnSaveKit');
    const btnLoadKit = document.getElementById('btnLoadKit');
    if (btnSaveKit) btnSaveKit.addEventListener('click', saveKit);
    if (btnLoadKit) btnLoadKit.addEventListener('click', loadKitDialog);
}

// === RECORDING LOGIC ===
let activeRecorders: Record<number, MediaRecorder> = {}; 

async function startRecording(index: number): Promise<void> {
    if (activeRecorders[index]) return;
    // Claim the slot synchronously — the async mic-permission gap previously
    // let keyup fire first, stranding an unstoppable open mic stream.
    const PENDING = '__pending__';
    (activeRecorders as any)[index] = PENDING as any;

    let stream: MediaStream | null = null;
    try {
        // Honor the selected input device instead of always using the default mic.
        let audioConstraint: MediaTrackConstraints | boolean = true;
        try {
            const { settings } = await import('./settings');
            const devId = settings.inputDevice;
            if (devId && devId !== 'default') {
                audioConstraint = { deviceId: { exact: devId } };
            }
        } catch { /* settings unavailable — default mic */ }
        // H17: a hanging permission prompt held __pending__ forever and
        // stranded the slot. Bound the whole mic acquisition.
        const withMicTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
            Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('mic permission timeout')), ms))]);
        // Late-resolve sweep: Promise.race does NOT abort getUserMedia — a
        // permission granted after the timeout (or after keyup-cancel) leaves
        // a live open mic with tracks never stopped. Sweep stragglers.
        const sweepLateMic = (raw: Promise<MediaStream>, isWanted: () => boolean): void => {
            void raw.then((s) => {
                if (!isWanted()) {
                    try { s.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
                }
            }).catch(() => undefined);
        };
        const wantMic = (): boolean =>
            (activeRecorders as any)[index] === PENDING && !(activeRecorders as any)[`__cancel_${index}`];
        const acquireMic = async (constraint: MediaTrackConstraints | boolean): Promise<MediaStream> => {
            const raw = navigator.mediaDevices.getUserMedia({ audio: constraint });
            sweepLateMic(raw, wantMic);
            return await withMicTimeout(raw, 30000);
        };
        try {
            try {
                stream = await acquireMic(audioConstraint);
            } catch {
                // Exact deviceId fails if the device vanished — fall back to default.
                stream = await acquireMic(true);
            }
        } catch {
            delete activeRecorders[index];
            logger.error("[Sampler] Recording start failed", new Error('mic unavailable'));
            toast.error("COULD NOT START RECORDING");
            return;
        }
        // Keyup cancelled while permission was pending — release the mic immediately.
        if ((activeRecorders as any)[`__cancel_${index}`]) {
            delete (activeRecorders as any)[`__cancel_${index}`];
            delete activeRecorders[index];
            try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
            return;
        }
        const mediaRecorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const arrayBuffer = await blob.arrayBuffer();

             try {
                if (!ensureAudio() || !audioCtx) { toast.error("AUDIO NOT READY"); return; }
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
                padBuffers[index] = decodedBuffer;
                padPaths[index] = `REC_${Date.now()}`;
                padWaveforms[index] = computeWaveform(decodedBuffer);
                padSelections[index] = null;
                padLoopStart[index] = -1;
                padLoopEnd[index] = -1;
                renderWaveform(index);
                updatePadVisuals(index);
                // Recorded pads previously kept stale waveform/BPM — SYNC stayed dead.
                // needsReview falls back to an estimated grid; repaint every branch.
                if (detectBPMFn) {
                    try {
                        const raw = await detectBPMFn(decodedBuffer);
                        const decision = resolveBpmPersist(raw, padBPMs[index]);
                        if (!decision.persisted || decision.bpm === undefined) {
                            const fb = applyBpmFallback(index, decodedBuffer.duration);
                            logger.warn(`[Sampler] Pad ${index} BPM needs review — estimated grid @${fb}bpm`);
                            toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                        } else {
                            padBPMs[index] = decision.bpm;
                            padBeatPositions[index] = computeBeatPositions(decision.bpm, decodedBuffer.duration);
                            padArmedBeats[index] = null; // grid moved — stale indices
                            try { delete padBpmEstimated[index]; } catch { /* ignore */ }
                        }
                        refreshPadAfterBpm(index);
                    } catch {
                        const fb = applyBpmFallback(index, decodedBuffer.duration);
                        logger.warn(`[Sampler] Pad ${index} BPM detection skipped — estimated grid @${fb}bpm`);
                        toast.info(`PAD ${index + 1} BPM UNCERTAIN — ESTIMATED GRID, SNAP ON`);
                        refreshPadAfterBpm(index);
                        /* BPM is best-effort */
                    }
                } else {
                    const fb = applyBpmFallback(index, decodedBuffer.duration);
                    logger.warn(`[Sampler] Pad ${index} no BPM detector — estimated grid @${fb}bpm`);
                    refreshPadAfterBpm(index);
                }
                document.dispatchEvent(new CustomEvent('ug:dataChanged'));
                logger.debug(`[Sampler] Recording on pad ${index} successful`);
             } catch (e) {
                logger.error(`[Sampler] Recording decode failed on pad ${index}`, e);
                toast.error("RECORDING DECODE FAILED");
             } finally {
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
             }

            delete activeRecorders[index];
            updateRecVisuals(index, false);
        };

        mediaRecorder.start();
        activeRecorders[index] = mediaRecorder;
        updateRecVisuals(index, true);

    } catch (e) {
        delete activeRecorders[index];
        logger.error("[Sampler] Recording start failed", e);
        toast.error("COULD NOT START RECORDING");
        if (stream) stream.getTracks().forEach(t => t.stop());
    }
}

function stopRecording(index: number): void {
    const recorder: any = (activeRecorders as any)[index];
    if (recorder === '__pending__') {
        // Mic permission still in flight — keyup arrived first. Mark cancelled
        // so startRecording aborts instead of stranding an open stream.
        delete activeRecorders[index];
        (activeRecorders as any)[`__cancel_${index}`] = true;
        setTimeout(() => { delete (activeRecorders as any)[`__cancel_${index}`]; }, 15000);
        return;
    }
    if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
    }
}

/** Abort all in-flight pad recordings and release mic streams (unload safety). */
export function stopAllRecordings(): void {
    for (const key of Object.keys(activeRecorders)) {
        if (key.startsWith('__cancel_')) continue;
        const idx = Number(key);
        if (!Number.isInteger(idx)) continue;
        try {
            const rec: any = (activeRecorders as any)[idx];
            if (rec === '__pending__') {
                (activeRecorders as any)[`__cancel_${idx}`] = true;
                delete (activeRecorders as any)[idx];
                continue;
            }
            if (rec && (rec as MediaRecorder).state !== 'inactive') {
                try { (rec as MediaRecorder).stop(); } catch { /* ignore */ }
            } else {
                delete activeRecorders[idx];
            }
        } catch { /* ignore */ }
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', stopAllRecordings);
}

function updateRecVisuals(index: number, isRecording: boolean): void {
    const padWrapper = padGrid?.children[index];
    const recBtn = padWrapper?.querySelector('.rec-btn');
    if (recBtn) {
        if (isRecording) recBtn.classList.add('recording');
        else recBtn.classList.remove('recording');
    }
}

// === KIT PERSISTENCE ===
// Kit v2: full-fidelity pads {index,path,vol,bpm,sync,loopStart,loopEnd} —
// the old vol-only shape silently dropped BPM/SYNC/loops on every save (C19)
// and diverged from the session/crash shapes. Loader accepts both.
interface KitPad {
    index: number;
    path: string;
    vol?: number;
    bpm?: number;
    sync?: boolean;
    snap?: boolean;
    loopStart?: number;
    loopEnd?: number;
}
async function saveKit(): Promise<void> {
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.saveKit();
        // Throttled dialog open reads as user-cancel without this: the
        // sentinel is truthy, so it must be checked BEFORE the null guard.
        if (path === DIALOG_THROTTLED) {
            logger.debug('[Sampler] Save-kit dialog throttled — TRY AGAIN');
            toast.info('DIALOG BUSY — TRY AGAIN');
            return;
        }
        if (!path) return;

        const kit = {
            version: 2,
            name: "My Gangsta Kit",
            pads: [] as KitPad[]
        };

        let skippedRecordings = 0;
        for (let i = 0; i < NUM_PADS; i++) {
            if (!padPaths[i]) continue;
            // Mic recordings have no backing file path ("REC_<ts>") — they
            // cannot be reloaded from a kit, so saving them writes broken refs.
            if (padPaths[i].startsWith('REC_')) {
                skippedRecordings++;
                continue;
            }
            const ls = padLoopStart[i];
            const le = padLoopEnd[i];
            kit.pads.push({
                index: i,
                path: padPaths[i],
                vol: padVolumes[i] ?? DEFAULT_PAD_VOLUME,
                bpm: padBPMs[i] || undefined,
                sync: padSyncState[i] || undefined,
                snap: padSnapToBeat[i] === false ? false : undefined,
                loopStart: (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) ? ls : undefined,
                loopEnd: (typeof le === 'number' && Number.isFinite(le) && le > 0) ? le : undefined,
            });
        }

        const ok = await fsBridgeRef.saveFile(path, new TextEncoder().encode(JSON.stringify(kit, null, 2)));
        // fs.saveFile returns false when the main process rejects the write —
        // previously this was ignored and "KIT SAVED" was shown regardless.
        if (ok) {
            if (skippedRecordings > 0) {
                toast.info(`${skippedRecordings} RECORDED PAD(S) NOT SAVED (NO SOURCE FILE)`);
            }
            toast.success("KIT SAVED");
            logger.info(`[Sampler] Kit saved to ${path}`);
        } else {
            toast.error("KIT SAVE FAILED (WRITE REJECTED)");
            logger.error(`[Sampler] Main process rejected write to ${path}`);
        }
    } catch (err) {
        logger.error("Save Kit Failed", err);
        toast.error("FAILED TO SAVE KIT");
    }
}

async function loadKitDialog(): Promise<void> {
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.loadKit();
        // Throttle sentinel (see saveKit above) — truthy, check first.
        if (path === DIALOG_THROTTLED) {
            logger.debug('[Sampler] Load-kit dialog throttled — TRY AGAIN');
            toast.info('DIALOG BUSY — TRY AGAIN');
            return;
        }
        if (!path) return;
        
        const data = await fsBridgeRef.readFile(path);
        if (!data) { toast.error("FAILED TO LOAD KIT"); return; }
        const rawLen = (data as unknown as { byteLength?: number; length?: number })?.byteLength
            ?? (data as unknown as { length?: number })?.length ?? 0;
        if (rawLen > 25 * 1024 * 1024) { toast.error("KIT FILE TOO LARGE"); return; }
        const jsonStr = new TextDecoder().decode(data);
        const kit = sanitizeParsedJson(JSON.parse(jsonStr));
        
        if (kit.pads && Array.isArray(kit.pads)) {
            // Sequential loads with a shared budget — the old parallel
            // fire-and-forget spiked 16 decodes at once (C19 OOM note).
            const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('kit pad timeout')), ms))]);
            // Pads absent from the kit previously kept their old samples —
            // loading a sparser kit over a full one silently merged both.
            const kitIdx = new Set<number>();
            const failed: number[] = [];
            for (const p of (kit.pads as KitPad[]).slice(0, NUM_PADS)) {
                const idx = Number((p as KitPad)?.index);
                if (Number.isInteger(idx) && idx >= 0 && idx < NUM_PADS) kitIdx.add(idx);
            }
            for (const p of (kit.pads as KitPad[]).slice(0, NUM_PADS)) {
                // Validate pad index from untrusted JSON — out-of-range values
                // would write stray properties past the pad arrays.
                const idx = Number((p as KitPad)?.index);
                const ppath = typeof (p as KitPad)?.path === 'string' ? (p as KitPad).path.slice(0, 32760) : '';
                if (!ppath || !Number.isInteger(idx) || idx < 0 || idx >= NUM_PADS) continue;
                try {
                    const kitBpm = typeof (p as KitPad)?.bpm === 'number' ? (p as KitPad).bpm : undefined;
                    const ok = await withTimeout(loadSampleFromPath(ppath, idx, kitBpm), 20000);
                    if (!ok) {
                        logger.warn(`[Sampler] Kit pad ${idx} load failed (${ppath})`);
                        failed.push(idx);
                        continue;
                    }
                } catch {
                    logger.warn(`[Sampler] Kit pad ${idx} load failed (${ppath})`);
                    failed.push(idx);
                    continue; // missing/undecodable sample must not stall the kit
                }
                // Full-fidelity restore (v2 fields optional for v1 kits).
                // Volume clamps to the 0..1 slider range — unclamped values
                // previously over-drove the gain stage.
                if (typeof p.vol === 'number' && Number.isFinite(p.vol)) {
                    padVolumes[idx] = Math.min(1, Math.max(0, p.vol));
                    const slider = padGrid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                    if (slider) slider.value = padVolumes[idx].toString();
                }
                if (typeof p.bpm === 'number' && Number.isFinite(p.bpm)) {
                    padBPMs[idx] = Math.min(300, Math.max(0, p.bpm));
                    // Kit BPM overwrites fresh analysis — rebuild the grid from
                    // the restored value (guard duration>0 inside helper).
                    recomputePadBeatGrid(idx);
                }
                if (typeof p.sync === 'boolean') padSyncState[idx] = p.sync;
                if (typeof p.snap === 'boolean') padSnapToBeat[idx] = p.snap;
                else delete padSnapToBeat[idx];
                padSnappedEdges[idx] = null;
                padArmedBeats[idx] = null;
                // Loop points clamp to the loaded buffer — stale durations
                // from re-encoded files previously threw RangeError on start.
                const dur = padBuffers[idx]?.duration ?? 0;
                if (typeof p.loopStart === 'number' && Number.isFinite(p.loopStart) && p.loopStart >= 0) {
                    padLoopStart[idx] = dur > 0 ? Math.min(p.loopStart, dur) : p.loopStart;
                }
                if (typeof p.loopEnd === 'number' && Number.isFinite(p.loopEnd) && p.loopEnd > 0) {
                    padLoopEnd[idx] = dur > 0 ? Math.min(p.loopEnd, dur) : p.loopEnd;
                }
                updatePadVisuals(idx);
            }
            // Clear pads the kit doesn't mention (silent — clearPad() toasts
            // per pad and would spam one toast per empty slot).
            let clearedAbsent = 0;
            for (let i = 0; i < NUM_PADS; i++) {
                if (kitIdx.has(i)) continue;
                if (!padBuffers[i] && !padPaths[i]) continue;
                try { stopPad(i); } catch { /* ignore */ }
                delete padBuffers[i];
                delete padPaths[i];
                delete padWaveforms[i];
                delete padBeatPositions[i];
                delete padBPMs[i];
                delete padSyncState[i];
                delete padSnapToBeat[i];
                try { delete padBpmEstimated[i]; } catch { /* ignore */ }
                padSnappedEdges[i] = null;
                padArmedBeats[i] = null;
                padSelections[i] = null;
                padLoopStart[i] = -1;
                padLoopEnd[i] = -1;
                padPlayState[i] = null;
                updatePadVisuals(i);
                clearedAbsent++;
            }
            if (clearedAbsent > 0) toast.info(`${clearedAbsent} PAD(S) CLEARED (ABSENT FROM KIT)`);
            if (failed.length > 0) toast.error(`KIT LOADED (${failed.length} FAILED)`);
            document.dispatchEvent(new CustomEvent('ug:dataChanged'));
        }
    } catch (err) {
        logger.error("Load Kit Failed", err);
        toast.error("FAILED TO LOAD KIT");
    }
}

