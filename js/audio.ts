import { VISUALIZER_FFT_SIZE } from './constants';
import { bufferToWaveWorker } from './worker-client';

// Extend window to support webkitAudioContext
declare global {
    interface Window {
        webkitAudioContext: typeof AudioContext;
    }
}

const AudioContextClass = window.AudioContext || window.webkitAudioContext;

let _audioCtx: AudioContext;
let _audioCtxFailed = false;

try {
    _audioCtx = new AudioContextClass();
} catch (e) {
    console.error("AudioContext creation failed:", e);
    _audioCtxFailed = true;
    // Create a dummy that fails gracefully on method calls
    _audioCtx = null as unknown as AudioContext;
}

export let audioCtx: AudioContext = _audioCtx;
export const isAudioAvailable = !_audioCtxFailed;

export let masterGain: GainNode;
export let analyser: AnalyserNode;

try {
    masterGain = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = VISUALIZER_FFT_SIZE;
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);
} catch (e) {
    console.error("Audio node creation failed:", e);
    masterGain = null as unknown as GainNode;
    analyser = null as unknown as AnalyserNode;
}

/**
 * Resumes the audio context if it's suspended
 */
export async function resumeAudioContext(): Promise<void> {
    if (!isAudioAvailable) {
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
 * Attempt to recreate the AudioContext after a failure
 */
export function recreateAudioContext(): boolean {
    try {
        const newCtx = new AudioContextClass();
        // Override the readonly property on the exported reference
        (audioCtx as any) = newCtx;
        masterGain = newCtx.createGain();
        analyser = newCtx.createAnalyser();
        analyser.fftSize = VISUALIZER_FFT_SIZE;
        masterGain.connect(analyser);
        analyser.connect(newCtx.destination);
        (_audioCtxFailed as boolean) = false;
        console.log("[Audio] AudioContext recreated successfully");
        return true;
    } catch (e) {
        console.error("[Audio] Failed to recreate AudioContext:", e);
        return false;
    }
}

/**
 * Convert AudioBuffer to a Blob (WAV) - Offloaded to Worker
 */
export async function bufferToWave(ab: AudioBuffer): Promise<Blob> {
    return await bufferToWaveWorker(ab, ab.length);
}

let isWorkletRegistered = false;

/**
 * Initialize AudioWorklets with singleton protection
 */
export async function initWorklets(): Promise<void> {
    if (isWorkletRegistered) return;
    if (!isAudioAvailable) {
        console.warn("Cannot init worklets: AudioContext not available.");
        return;
    }
    try {
        await audioCtx.audioWorklet.addModule('js/workers/gangsta-processor.js');
        await audioCtx.audioWorklet.addModule('js/workers/recorder-processor.js');
        isWorkletRegistered = true;
        console.log('[Audio] Worklets Registered');
    } catch (e) {
        console.error('[Audio] Worklet registration failed', e);
    }
}
