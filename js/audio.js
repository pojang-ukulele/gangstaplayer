// === AUDIO CONTEXT & CORE NODES ===
import { VISUALIZER_FFT_SIZE } from './constants.js';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
export const audioCtx = new AudioContextClass();
export const masterGain = audioCtx.createGain();
export const analyser = audioCtx.createAnalyser();
analyser.fftSize = VISUALIZER_FFT_SIZE;

masterGain.connect(analyser);
analyser.connect(audioCtx.destination);

export function resumeAudioContext() {
    if (audioCtx.state === 'suspended') {
        return audioCtx.resume();
    }
    return Promise.resolve();
}
