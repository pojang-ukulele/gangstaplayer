import { VISUALIZER_FFT_SIZE } from './constants';
import { bufferToWaveWorker } from './worker-client';

// Extend window to support webkitAudioContext
declare global {
    interface Window {
        webkitAudioContext: typeof AudioContext;
    }
}

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
export const audioCtx = new AudioContextClass();
export const masterGain = audioCtx.createGain();
export const analyser = audioCtx.createAnalyser();
analyser.fftSize = VISUALIZER_FFT_SIZE;

masterGain.connect(analyser);
analyser.connect(audioCtx.destination);

/**
 * Resumes the audio context if it's suspended
 */
export function resumeAudioContext(): Promise<void> {
    if (audioCtx.state === 'suspended') {
        return audioCtx.resume();
    }
    return Promise.resolve();
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
    try {
        await audioCtx.audioWorklet.addModule('js/workers/gangsta-processor.js');
        await audioCtx.audioWorklet.addModule('js/workers/recorder-processor.js');
        isWorkletRegistered = true;
        console.log('[Audio] Worklets Registered');
    } catch (e) {
        console.error('[Audio] Worklet registration failed', e);
    }
}

export interface DecodeResult {
    numberOfChannels: number;
    sampleRate: number;
    length: number;
    duration: number;
    channels: Float32Array[];
}

/**
 * Reconstructs an AudioBuffer from background-decoded PCM data
 */
export function createAudioBuffer(data: DecodeResult): AudioBuffer {
    const buffer = audioCtx.createBuffer(data.numberOfChannels, data.length, data.sampleRate);
    for (let i = 0; i < data.numberOfChannels; i++) {
        buffer.copyToChannel(data.channels[i] as any, i);
    }
    return buffer;
}
