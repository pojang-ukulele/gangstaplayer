import { VISUALIZER_FFT_SIZE } from './constants';
import { bufferToWaveWorker } from './worker-client';

// Extend window to support webkitAudioContext
declare global {
    interface Window {
        webkitAudioContext: typeof AudioContext;
    }
}

function getAudioContextClass(): typeof AudioContext | null {
    try {
        return window.AudioContext || window.webkitAudioContext || null;
    } catch {
        return null;
    }
}

// Live bindings (kept for backward compat). They start null and are
// populated by ensureAudio() — never constructed at import time, so a
// pre-gesture failure doesn't permanently brick audio.
export let audioCtx: AudioContext | null = null;
export let masterGain: GainNode | null = null;
export let analyser: AnalyserNode | null = null;

let _failed = false;
let _owningCtx: AudioContext | null = null;

/** Fired whenever a brand-new AudioContext + master chain is built. */
type RebuiltCallback = () => void;
const _rebuiltCallbacks = new Set<RebuiltCallback>();
export function onAudioRebuilt(cb: RebuiltCallback): () => void {
    _rebuiltCallbacks.add(cb);
    return () => { _rebuiltCallbacks.delete(cb); };
}
function _fireRebuilt(): void {
    for (const cb of Array.from(_rebuiltCallbacks)) {
        try { cb(); } catch (e) { console.error('[Audio] rebuilt callback failed', e); }
    }
}

/** Create (or recreate) context + master chain. Returns true when usable. */
export function ensureAudio(): boolean {
    try {
        if (audioCtx && audioCtx.state !== 'closed' && masterGain && analyser) return true;
        // Closed contexts can't resume — drop everything and rebuild.
        // (No close() call: state is already 'closed', and awaiting it here
        // would serialize device-loss recovery behind a dead handle.)
        if (audioCtx && audioCtx.state === 'closed') {
            try { masterGain?.disconnect(); } catch { /* ignore */ }
            try { analyser?.disconnect(); } catch { /* ignore */ }
            audioCtx = null; masterGain = null; analyser = null;
        }
        if (!audioCtx) {
            const Cls = getAudioContextClass();
            if (!Cls) { _failed = true; return false; }
            audioCtx = new Cls();
            _owningCtx = audioCtx;
        }
        if (!masterGain || !analyser || _owningCtx !== audioCtx) {
            try { masterGain?.disconnect(); } catch { /* ignore */ }
            try { analyser?.disconnect(); } catch { /* ignore */ }
            masterGain = audioCtx.createGain();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = VISUALIZER_FFT_SIZE;
            masterGain.connect(analyser);
            analyser.connect(audioCtx.destination);
            _owningCtx = audioCtx;
            // Fire AFTER the chain exists — subscribers retapping masterGain
            // previously got null and never retried.
            _fireRebuilt();
        }
        _failed = false;
        return true;
    } catch (e) {
        console.error("AudioContext creation failed:", e);
        _failed = true;
        audioCtx = null; masterGain = null; analyser = null;
        return false;
    }
}

export function isAudioAvailable(): boolean {
    // No side effects: probing must not construct a suspended pre-gesture context.
    return !!(audioCtx && audioCtx.state !== 'closed' && !_failed && masterGain && analyser);
}

/**
 * Resumes the audio context if it's suspended (creating it first if needed)
 */
export async function resumeAudioContext(): Promise<void> {
    if (!ensureAudio() || !audioCtx) {
        console.warn("Cannot resume: AudioContext is not available.");
        return;
    }
    try {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
    } catch (e) {
        console.error("Error resuming AudioContext:", e);
    }
}

/**
 * Convert AudioBuffer to a Blob (WAV) - Offloaded to Worker
 */
export async function bufferToWave(ab: AudioBuffer): Promise<Blob> {
    if (!ab || typeof ab.length !== 'number' || ab.length <= 0 || !Number.isFinite(ab.length)) {
        throw new Error('bufferToWave: empty or detached buffer');
    }
    return await bufferToWaveWorker(ab, ab.length);
}

let isWorkletRegistered = false;
let workletCtx: AudioContext | null = null;

/**
 * Initialize AudioWorklets with singleton protection
 */
function workletUrl(file: string): string {
    try {
        // Packaged layout is app-build/index.html + app-build/js/... — resolve
        // against the document base so dev and prod agree.
        return new URL(`js/workers/${file}`, document.baseURI).toString();
    } catch {
        return `js/workers/${file}`;
    }
}

export async function initWorklets(): Promise<void> {
    if (!ensureAudio() || !audioCtx) {
        console.warn("Cannot init worklets: AudioContext not available.");
        return;
    }
    // Re-register if the context was rebuilt after a close.
    if (isWorkletRegistered && workletCtx === audioCtx) return;
    // Bound registration: a hung file:// fetch previously stalled
    // engine.initWorklets retries forever with no timeout.
    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`Worklet timeout: ${label}`)), ms);
            (t as any)?.unref?.();
            p.then(
                (v) => { clearTimeout(t); resolve(v); },
                (e) => { clearTimeout(t); reject(e); }
            );
        });
    try {
        await withTimeout(audioCtx.audioWorklet.addModule(workletUrl('gangsta-processor.js')), 10000, 'gangsta-processor');
        await withTimeout(audioCtx.audioWorklet.addModule(workletUrl('recorder-processor.js')), 10000, 'recorder-processor');
        isWorkletRegistered = true;
        workletCtx = audioCtx;
        console.log('[Audio] Worklets Registered');
    } catch (e) {
        console.error('[Audio] Worklet registration failed', e);
    }
}
