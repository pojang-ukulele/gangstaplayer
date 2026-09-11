// === SAMPLER MODULE ===
import { DEFAULT_PAD_VOLUME, MAX_FILE_SIZE_BYTES, NUM_PADS, POOL_SIZE } from './constants';
import { state } from './state';
import { audioCtx, masterGain, resumeAudioContext, ensureAudio } from './audio';
import { engine } from './audio-engine';
import { toast } from './toast';
import { logger } from './logger';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import type { FileSystemAPI, ElectronAPI } from './types';

interface SamplerDeps {
    fsBridge: FileSystemAPI;
    bridge: ElectronAPI;
    detectBPM: (buffer: AudioBuffer) => Promise<number>;
    masterBPMRef: { value: number };
    tempoSliderRef: HTMLInputElement;
}

export const padBuffers: Record<number, AudioBuffer> = {};
export const padPaths: Record<number, string> = {};
export const activeVoices: Record<number, { source: AudioBufferSourceNode, gain: GainNode } | null> = {};
export const padVolumes: number[] = new Array(16).fill(DEFAULT_PAD_VOLUME);
export const padBPMs: Record<number, number> = {};
export const padSyncState: Record<number, boolean> = {};

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
    if (_gainPool.length < (POOL_SIZE || 32)) {
        _gainPool.push(gain);
    }
}

let padGrid: HTMLElement | null = null;
let fsBridgeRef: FileSystemAPI | null = null;
let bridgeRef: ElectronAPI | null = null;
let detectBPMFn: ((buffer: AudioBuffer) => Promise<number>) | null = null;
let masterBPMRef = { value: 0 };
let tempoSliderRef: HTMLInputElement | null = null;
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

// === SELECTION (active area) HELPERS ===

function clampToBuffer(index: number, t: number): number {
    const dur = padBuffers[index]?.duration ?? 0;
    if (!Number.isFinite(t) || !(dur > 0)) return 0;
    return Math.min(Math.max(0, t), dur);
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
        if (!voice) return;
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

/** Draw the waveform strip: selection tint + beats + filled ember-red envelope on green */
export function renderWaveform(index: number): void {
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

    const midY = h / 2;
    const stepX = w / WAVEFORM_POINTS;

    // === 1. Selection tint (canvas backstop behind the DOM overlay) ===
    if (region && region.end > region.start) {
        const lsX = (region.start / duration) * w;
        const leX = (region.end / duration) * w;
        ctx.fillStyle = 'rgba(188, 19, 254, 0.25)';
        ctx.fillRect(lsX, 0, leX - lsX, h);
        ctx.strokeStyle = 'rgba(188, 19, 254, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(lsX, 0); ctx.lineTo(lsX, h);
        ctx.moveTo(leX, 0); ctx.lineTo(leX, h);
        ctx.stroke();
    }

    // === 2. Beat ticks ===
    const beats = padBeatPositions[index];
    if (beats && beats.length > 1) {
        ctx.strokeStyle = 'rgba(255, 204, 0, 0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < beats.length; i++) {
            const x = (beats[i] / duration) * w;
            ctx.beginPath();
            ctx.moveTo(x, midY - 4);
            ctx.lineTo(x, midY + 4);
            ctx.stroke();
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

    // === 4. BPM tag (tiny, top-left of the strip) ===
    if (padBPMs[index] > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.font = '8px VT323, monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(`${padBPMs[index]}bpm`, 3, 2);
    }
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

function setPadLoading(index: number, loading: boolean): void {
    if (!padGrid) return;
    const pad = padGrid.children[index]?.querySelector('.pad') as HTMLElement;
    if (pad) {
        pad.classList.toggle('loading', loading);
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
    setPadLoading(index, true);
    const gen = ++_padLoadGen[index];
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
        padSelections[index] = null;
        padLoopStart[index] = -1;
        padLoopEnd[index] = -1;
        logger.info(`[Sampler] Pad ${index}: Buffer set from file (${audioBuffer.duration.toFixed(2)}s)`);
        updatePadVisuals(index);

        // BPM failure must not masquerade as sample-load failure (buffer is playable).
        if (detectBPMFn) {
            try {
                const bpm = await detectBPMFn(audioBuffer);
                if (gen !== _padLoadGen[index]) return;
                padBPMs[index] = bpm;
                padBeatPositions[index] = computeBeatPositions(bpm, audioBuffer.duration);
                logger.info(`[Sampler] Pad ${index} BPM: ${bpm}, beats: ${padBeatPositions[index].length}`);
            } catch (bpmErr) {
                logger.warn(`[Sampler] Pad ${index} BPM detection skipped`, bpmErr);
            }
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} file load FAILED: ${e?.message || e}`, e);
        toast.error("SAMPLE LOAD FAILED");
    } finally {
        if (slot) releasePadDecodeSlot();
        setPadLoading(index, false);
    }
}

export async function loadSampleFromPath(path: string, index: number): Promise<void> {
    setPadLoading(index, true);
    const gen = ++_padLoadGen[index];
    let slot = false;
    try {
        if (!fsBridgeRef) return;
        logger.info(`[Sampler] Loading path to pad ${index}: ${path}`);
        await acquirePadDecodeSlot();
        slot = true;
        if (gen !== _padLoadGen[index]) return; // superseded while queued
        const rawData = await fsBridgeRef.readFile(path);
        if (!rawData) {
            logger.error(`[Sampler] Read failed for path: ${path}`);
            return;
        }
        
        const arrayBuffer = normalizeToArrayBuffer(rawData);
        if (arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            logger.error(`[Sampler] Pad ${index} rejected: decoded size too large`);
            toast.error("FILE TOO LARGE (MAX 100MB)");
            return;
        }
        
        // Validate audio file signature (kit restores previously failed silently).
        const validationError = validateAudioSignature(arrayBuffer, path.split(/[\\/]/).pop());
        if (validationError) {
            logger.error(`[Sampler] Pad ${index} path validation failed: ${validationError}`);
            toast.error("INVALID AUDIO FILE IN KIT");
            return;
        }
        if (gen !== _padLoadGen[index]) return;

        logger.info(`[Sampler] Pad ${index}: Got ${arrayBuffer.byteLength} bytes, decoding...`);

        // Use native decoder directly
        if (!ensureAudio() || !audioCtx) return;
        let audioBuffer: AudioBuffer;
        try {
            audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        } catch (decErr) {
            logger.error(`[Sampler] Pad ${index} path decode failed`, decErr);
            toast.error("KIT SAMPLE UNDECODABLE");
            return;
        }
        if (gen !== _padLoadGen[index]) return;

        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        padWaveforms[index] = computeWaveform(audioBuffer);
        // Fresh sample: stale selections/loops belong to the old buffer.
        padSelections[index] = null;
        padLoopStart[index] = -1;
        padLoopEnd[index] = -1;
        logger.info(`[Sampler] Pad ${index}: Buffer set (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`);
        updatePadVisuals(index);
        if (detectBPMFn) {
            try {
                const bpm = await detectBPMFn(audioBuffer);
                if (gen !== _padLoadGen[index]) return;
                padBPMs[index] = bpm;
                padBeatPositions[index] = computeBeatPositions(bpm, audioBuffer.duration);
            } catch (bpmErr) {
                logger.warn(`[Sampler] Pad ${index} BPM detection skipped`, bpmErr);
            }
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} path load FAILED: ${e?.message || e}`, e);
    } finally {
        if (slot) releasePadDecodeSlot();
        setPadLoading(index, false);
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
    if (!padBuffers[index]) return;
    if (!ensureAudio() || !audioCtx || !masterGain) {
        logger.warn(`[Sampler] Audio not ready, cannot start pad ${index}`);
        return;
    }
    // Guard against AudioContext being in closed state (ensureAudio rebuilds)
    if (audioCtx.state === 'closed' && !ensureAudio()) {
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
        if (!buf || !(bufDur > 0)) return;
        // Acquire BEFORE creating the source: a null return used to strand an
        // orphaned BufferSource (created but never connected/started).
        gainNode = acquireGain();
        if (!gainNode) { logger.warn(`[Sampler] No gain node for pad ${index}`); return; }
        source = audioCtx.createBufferSource();
        source.buffer = buf;
        const wantLoop = opts?.loop === true;
        // One-shot selection playback never loops; long-press repeats.
        source.loop = false;

        // Active area drives both the start offset and the loop points.
        const region = getActiveRegion(index);
        const currentVol = padVolumes[index] !== undefined ? padVolumes[index] : DEFAULT_PAD_VOLUME;
        gainNode.gain.setValueAtTime(currentVol, audioCtx.currentTime);
        
        let rate = tempoSliderRef ? parseFloat(tempoSliderRef.value) : 1;
        // Selection plays from its start; full sample starts at zero.
        let startOffset = region ? region.start : 0;
        
        if (padSyncState[index] && masterBPMRef.value > 0 && padBPMs[index] > 0) {
            // Adjust playback rate to match master BPM (clamped like the deck).
            rate = (masterBPMRef.value / padBPMs[index]) * rate;
            rate = Math.min(1.5, Math.max(0.5, rate));

            // Beat-quantized start: snap to nearest beat in the master timeline
            const masterBPS = masterBPMRef.value / 60; // beats per second
            const padBeatDuration = 60 / padBPMs[index]; // one beat in the pad's native time

            // Get current position in the master audio
            const playerAudio = engine.main.audio;
            if (playerAudio && playerAudio.currentTime > 0 && !isNaN(playerAudio.duration)) {
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
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
                <div class="pad-wave" title="Drag to select an area">
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

        // === WAVEFORM DRAG-SELECT (press-hold-select area on the strip) ===
        // NOTE: the old canvas click-to-loop handler was inert — .pad-canvas
        // has pointer-events:none, so clicks never reached it. Drag-select on
        // the strip replaces it; loop presets live in the context menu.
        const wave = wrapper.querySelector('.pad-wave') as HTMLElement;
        if (wave) {
            wave.addEventListener('mousedown', (e) => {
                const buf = padBuffers[index];
                if (!buf || !(buf.duration > 0) || e.button !== 0) return;
                // Don't trigger the pad or the long-press timer from a strip drag.
                e.stopPropagation();
                e.preventDefault();
                const rect = wave.getBoundingClientRect();
                if (rect.width <= 0) return;
                const frac0 = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                const selEl = wave.querySelector('.pad-selection') as HTMLElement | null;
                let cur = frac0;
                const onMove = (ev: MouseEvent): void => {
                    const r = wave.getBoundingClientRect();
                    if (r.width <= 0) return;
                    cur = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
                    if (selEl) {
                        selEl.classList.remove('hidden');
                        const a = Math.min(frac0, cur);
                        const b = Math.max(frac0, cur);
                        selEl.style.left = (a * 100).toFixed(2) + '%';
                        selEl.style.width = ((b - a) * 100).toFixed(2) + '%';
                    }
                };
                const onUp = (): void => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    const a = Math.min(frac0, cur);
                    const b = Math.max(frac0, cur);
                    if ((b - a) * buf.duration < 0.02) {
                        // Plain click without a drag — keep the old selection.
                        renderWaveform(index);
                        return;
                    }
                    try {
                        const sSec = a * buf.duration;
                        const eSec = b * buf.duration;
                        setPadSelection(index, sSec, eSec);
                        toast.success(`SELECTED ${sSec.toFixed(2)}s - ${eSec.toFixed(2)}s`);
                    } catch (err) {
                        logger.error(`[Sampler] Waveform select failed for pad ${index}:`, err);
                    }
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
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

        // === RIGHT-CLICK VISIBILITY for the new menu items ===
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
    const emptyEl = pad.querySelector('.pad-empty') as HTMLElement | null;
    if (emptyEl) emptyEl.classList.toggle('hidden', !!padBuffers[index]);

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
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                padBuffers[index] = decodedBuffer;
                padPaths[index] = `REC_${Date.now()}`;
                padWaveforms[index] = computeWaveform(decodedBuffer);
                padSelections[index] = null;
                padLoopStart[index] = -1;
                padLoopEnd[index] = -1;
                renderWaveform(index);
                updatePadVisuals(index);
                // Recorded pads previously kept stale waveform/BPM — SYNC stayed dead.
                if (detectBPMFn) {
                    try {
                        const bpm = await detectBPMFn(decodedBuffer);
                        padBPMs[index] = bpm;
                        padBeatPositions[index] = computeBeatPositions(bpm, decodedBuffer.duration);
                    } catch { /* BPM is best-effort */ }
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
    loopStart?: number;
    loopEnd?: number;
}
async function saveKit(): Promise<void> {
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.saveKit();
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
                loopStart: (typeof ls === 'number' && Number.isFinite(ls) && ls >= 0) ? ls : undefined,
                loopEnd: (typeof le === 'number' && Number.isFinite(le) && le > 0) ? le : undefined,
            });
        }

        await fsBridgeRef.saveFile(path, new TextEncoder().encode(JSON.stringify(kit, null, 2)));
        if (skippedRecordings > 0) {
            toast.info(`${skippedRecordings} RECORDED PAD(S) NOT SAVED (NO SOURCE FILE)`);
        }
        toast.success("KIT SAVED");
    } catch (err) {
        logger.error("Save Kit Failed", err);
        toast.error("FAILED TO SAVE KIT");
    }
}

async function loadKitDialog(): Promise<void> {
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.loadKit();
        if (!path) return;
        
        const data = await fsBridgeRef.readFile(path);
        if (!data) { toast.error("FAILED TO LOAD KIT"); return; }
        const jsonStr = new TextDecoder().decode(data);
        const kit = JSON.parse(jsonStr);
        
        if (kit.pads && Array.isArray(kit.pads)) {
            // Sequential loads with a shared budget — the old parallel
            // fire-and-forget spiked 16 decodes at once (C19 OOM note).
            const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('kit pad timeout')), ms))]);
            for (const p of (kit.pads as KitPad[]).slice(0, NUM_PADS)) {
                // Validate pad index from untrusted JSON — out-of-range values
                // would write stray properties past the pad arrays.
                const idx = Number((p as KitPad)?.index);
                const ppath = typeof (p as KitPad)?.path === 'string' ? (p as KitPad).path.slice(0, 32760) : '';
                if (!ppath || !Number.isInteger(idx) || idx < 0 || idx >= NUM_PADS) continue;
                try {
                    await withTimeout(loadSampleFromPath(ppath, idx), 20000);
                } catch {
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
                }
                if (typeof p.sync === 'boolean') padSyncState[idx] = p.sync;
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
            document.dispatchEvent(new CustomEvent('ug:dataChanged'));
        }
    } catch (err) {
        logger.error("Load Kit Failed", err);
        toast.error("FAILED TO LOAD KIT");
    }
}

