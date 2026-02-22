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
