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

/**
 * Convert AudioBuffer to a Blob (WAV)
 */
export function bufferToWave(ab) {
    const numOfChan = ab.numberOfChannels;
    const length = ab.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let i = 0;
    let sample = 0;
    let offset = 0;
    let pos = 0;

    // Write WAVE Header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(ab.sampleRate);
    setUint32(ab.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit (hardcoded in this encoder)

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    // Interleave channels
    for (i = 0; i < numOfChan; i++) channels.push(ab.getChannelData(i));

    while (pos < ab.length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit
            view.setInt16(44 + offset, sample, true); // write 16-bit sample
            offset += 2;
        }
        pos++;
    }

    return new Blob([buffer], { type: "audio/wav" });

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
}
