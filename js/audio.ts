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

/** Create (or recreate) context + master chain. Returns true when usable. */
export function ensureAudio(): boolean {
    try {
        if (audioCtx && audioCtx.state !== 'closed' && masterGain && analyser) return true;
        // Closed contexts can't resume — drop everything and rebuild.
        if (audioCtx && audioCtx.state === 'closed') {
            try { audioCtx.close().catch(() => undefined); } catch { /* ignore */ }
            audioCtx = null; masterGain = null; analyser = null;
        }
        if (!audioCtx) {
            const Cls = getAudioContextClass();
            if (!Cls) { _failed = true; return false; }
            audioCtx = new Cls();
            _owningCtx = audioCtx;
        }
        if (!masterGain || !analyser || _owningCtx !== audioCtx) {
            masterGain = audioCtx.createGain();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = VISUALIZER_FFT_SIZE;
            masterGain.connect(analyser);
            analyser.connect(audioCtx.destination);
            _owningCtx = audioCtx;
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
    return !!(audioCtx && audioCtx.state !== 'closed' && !_failed) || ensureAudio();
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
    return await bufferToWaveWorker(ab, ab.length);
}

let isWorkletRegistered = false;
let workletCtx: AudioContext | null = null;

/**
 * Initialize AudioWorklets with singleton protection
 */
export async function initWorklets(): Promise<void> {
    if (!ensureAudio() || !audioCtx) {
        console.warn("Cannot init worklets: AudioContext not available.");
        return;
    }
    // Re-register if the context was rebuilt after a close.
    if (isWorkletRegistered && workletCtx === audioCtx) return;
    try {
        await audioCtx.audioWorklet.addModule('js/workers/gangsta-processor.js');
        await audioCtx.audioWorklet.addModule('js/workers/recorder-processor.js');
        isWorkletRegistered = true;
        workletCtx = audioCtx;
        console.log('[Audio] Worklets Registered');
    } catch (e) {
        console.error('[Audio] Worklet registration failed', e);
    }
}
