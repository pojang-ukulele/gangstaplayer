/**
 * Audio Processing Worker for Gangsta Player Pro 3
 * Handles high-latency tasks like BPM detection and WAV encoding
 */

interface AudioBufferTransfer {
    numberOfChannels: number;
    sampleRate: number;
    channels: Float32Array[];
}

interface WorkerMessage {
    type: 'DETECT_BPM' | 'BUFFER_TO_WAVE';
    payload: {
        data?: Float32Array;
        sampleRate?: number;
        threshold?: number;
        minStepSeconds?: number;
        buffer?: AudioBufferTransfer;
        len?: number;
    };
    id: number;
}

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
    const { type, payload, id } = e.data;

    switch (type) {
        case 'DETECT_BPM':
            if (payload.data && payload.sampleRate) {
                const bpm = detectBPM(payload.data, payload.sampleRate, payload.threshold, payload.minStepSeconds);
                self.postMessage({ type: 'BPM_RESULT', bpm, id });
            } else {
                self.postMessage({ type: 'BPM_RESULT', bpm: 0, id });
            }
            break;
        case 'BUFFER_TO_WAVE':
            if (payload.buffer && payload.len !== undefined) {
                try {
                    const waveBlob = bufferToWave(payload.buffer, payload.len);
                    self.postMessage({ type: 'WAVE_RESULT', blob: waveBlob, id });
                } catch {
                    self.postMessage({ type: 'WAVE_RESULT', blob: null, id });
                }
            } else {
                self.postMessage({ type: 'WAVE_RESULT', blob: null, id });
            }
            break;
        default:
            self.postMessage({ type: 'UNKNOWN', id });
            break;
    }
};

// Defaults match js/constants.ts — values are always passed from the main thread
// but kept here as fallback for standalone worker execution.
function detectBPM(data: Float32Array, sampleRate: number, threshold = 0.1, minStepSeconds = 0.3): number {
    const BPM_DETECTION_THRESHOLD = threshold;
    const BPM_MIN_STEP_SECONDS = minStepSeconds;
    
    const peaks: number[] = [];
    const minStep = Math.floor(BPM_MIN_STEP_SECONDS * sampleRate);
    
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > BPM_DETECTION_THRESHOLD) {
            peaks.push(i);
            i += minStep;
        }
    }
    
    if (peaks.length < 2) return 0;
    // Density guard: peaks on nearly every minStep window mean a crushed/loud
    // master, not beats — previously every loud track reported ~100 BPM.
    const durationSec = data.length / sampleRate;
    const maxPlausiblePeaks = durationSec / minStepSeconds;
    if (peaks.length > maxPlausiblePeaks * 0.9) return 0;
    
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i] - peaks[i - 1]);
    }
    
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    let bpmValue = (sampleRate * 60) / avgInterval;
    
    // The peak detector often catches half-beats, doubling the BPM.
    // Halve values above 170 to get the true tempo.
    if (bpmValue > 170) bpmValue = bpmValue / 2;
    
    return (bpmValue < 40 || bpmValue > 200) ? 0 : Math.round(bpmValue);
}

function bufferToWave(abuffer: AudioBufferTransfer, len: number): Blob {
    const numOfChan = Math.floor(Number(abuffer.numberOfChannels));
    const sampleRate = Number(abuffer.sampleRate);
    const safeLen = Math.floor(Number(len));
    if (!Number.isInteger(numOfChan) || numOfChan < 1 || numOfChan > 32) {
        throw new Error('Invalid channel count');
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) {
        throw new Error('Invalid sample rate');
    }
    if (!Number.isInteger(safeLen) || safeLen <= 0 || safeLen > 268435456) {
        throw new Error('Invalid length');
    }
    const totalLength = safeLen * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const channels = abuffer.channels;
    len = safeLen;
    let i: number;
    let sample: number;
    let offset = 0;
    let pos = 0;

    function setUint16(data: number) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data: number) {
        view.setUint32(pos, data, true);
        pos += 4;
    }

    // write WAVE header
    setUint32(0x46464952);                         // "RIFF"
    setUint32(totalLength - 8);                    // file length - 8
    setUint32(0x45564157);                         // "WAVE"

    setUint32(0x20746d66);                         // "fmt " chunk
    setUint32(16);                                 // length = 16
    setUint16(1);                                  // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2);                      // block-align
    setUint16(16);                                 // 16-bit (hardcoded)

    setUint32(0x61746164);                         // "data" - chunk
    setUint32(totalLength - pos - 4);              // chunk length

    // write interleaved data
    while (pos < totalLength) {
        for (i = 0; i < numOfChan; i++) {             // interleave channels
            if (channels[i] && channels[i][offset] !== undefined) {
                sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF); // scale to 16-bit signed int
                view.setInt16(pos, sample, true);          // write 16-bit sample
            }
            pos += 2;
        }
        offset++;                                     // next sample
    }

    return new Blob([buffer], { type: "audio/wav" });
}
