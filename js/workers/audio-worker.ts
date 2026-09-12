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
    // Drop id-less replies without leaking: no pending entry is created for
    // them, and none is resolved here.
    if (id === undefined || id === null) return;

    switch (type) {
        case 'DETECT_BPM':
            if (payload.data && payload.sampleRate) {
                const res = detectBPM(payload.data, payload.sampleRate, payload.threshold, payload.minStepSeconds);
                self.postMessage({ type: 'BPM_RESULT', bpm: res.bpm, confidence: res.confidence, id });
            } else {
                self.postMessage({ type: 'BPM_RESULT', bpm: 0, confidence: 'none', id });
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
// Mono fast path: the client sends channel-0 only (90s cap); stereo is NOT
// analyzed here — that is intentional (2x copy + phase issues).
// Octave-fold limits (documented): the peak detector often lands on
// half-beats, so values fold into 60-180 once (x2 up from <60, /2 down from
// >180) with a usable 30-210 window. Outside 30-210 the result is -1
// (needs-review) — callers must NOT cache it as analyzed 0. Low-confidence
// results likewise mean "retry with other means", not "0 BPM".
export type BpmConfidence = 'high' | 'medium' | 'low' | 'none';
function detectBPM(data: Float32Array, sampleRate: number, threshold = 0.1, minStepSeconds = 0.3): { bpm: number; confidence: BpmConfidence } {
    // Defense in depth (H13): the client clamps these, but a minStepSeconds
    // of 0 previously meant minStep=0 → i+=0 infinite loop → worker OOM.
    if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) return { bpm: -1, confidence: 'none' };
    if (!data || data.length === 0 || data.length > 32 * 1024 * 1024) return { bpm: -1, confidence: 'none' };
    const BPM_DETECTION_THRESHOLD = threshold > 0 && threshold <= 1 ? threshold : 0.1;
    const BPM_MIN_STEP_SECONDS = minStepSeconds > 0 && minStepSeconds <= 5 ? minStepSeconds : 0.3;

    const peaks: number[] = [];
    const minStep = Math.max(1, Math.floor(BPM_MIN_STEP_SECONDS * sampleRate));
    
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > BPM_DETECTION_THRESHOLD) {
            peaks.push(i);
            i += minStep;
        }
    }
    
    if (peaks.length < 2) return { bpm: 0, confidence: 'low' };
    // Density guard: peaks on nearly every minStep window mean a crushed/loud
    // master, not beats — previously every loud track reported ~100 BPM.
    const durationSec = data.length / sampleRate;
    const maxPlausiblePeaks = durationSec / minStepSeconds;
    if (peaks.length > maxPlausiblePeaks * 0.9) return { bpm: 0, confidence: 'low' };
    
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i] - peaks[i - 1]);
    }
    
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    let bpmValue = (sampleRate * 60) / avgInterval;
    
    // The peak detector often catches half-beats, doubling the BPM.
    // Fold into 60-180 once instead of single halve; keep 30-210 usable
    // so screwed/ghetto-tech extremes return a value instead of silent 0.
    // Limits: 2x octave error is corrected; 3x+ (triplet feels) and
    // <30/>210 extremes are out of scope and return -1/needs-review.
    let folded = false;
    while (bpmValue > 180) { bpmValue = bpmValue / 2; folded = true; }
    while (bpmValue < 60 && bpmValue > 0) { bpmValue = bpmValue * 2; folded = true; }
    if (!Number.isFinite(bpmValue)) return { bpm: -1, confidence: 'none' };
    if (bpmValue < 30 || bpmValue > 210) return { bpm: -1, confidence: 'none' };
    const bpm = Math.round(bpmValue);
    // Confidence from peak support + interval stability (CV). Folded results
    // cap at medium — an octave guess is not high-confidence.
    let variance = 0;
    for (const iv of intervals) variance += (iv - avgInterval) * (iv - avgInterval);
    variance /= intervals.length;
    const cv = avgInterval > 0 ? Math.sqrt(variance) / avgInterval : 1;
    let confidence: BpmConfidence = 'low';
    if (peaks.length >= 8 && cv < 0.25) confidence = 'high';
    else if (peaks.length >= 4 && cv < 0.45) confidence = 'medium';
    if (folded && confidence === 'high') confidence = 'medium';
    return { bpm, confidence };
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
    // Product guard: safeLen x 32ch individually valid still multiplies to
    // ~17GB — previously attempted before any check, risking a worker OOM
    // that killed every queued BPM job. Recorder caps at ~360MB stereo.
    if (totalLength > 600 * 1024 * 1024) {
        throw new Error('Encode too large');
    }
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const channels = abuffer.channels;
    // Fail loud on short channels: len>actual previously zero-padded the tail
    // (silent truncated audio). Every channel must carry at least safeLen.
    if (!Array.isArray(channels) || channels.length < numOfChan) {
        throw new Error('Encode channels missing');
    }
    for (let c = 0; c < numOfChan; c++) {
        const ch = channels[c] as Float32Array | undefined;
        if (!ch || ch.length < safeLen) {
            throw new Error(`Encode length ${safeLen} exceeds channel ${c} data (${ch ? ch.length : 0})`);
        }
    }
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
            sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
            sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF); // scale to 16-bit signed int
            view.setInt16(pos, sample, true);          // write 16-bit sample
            pos += 2;
        }
        offset++;                                     // next sample
    }

    return new Blob([buffer], { type: "audio/wav" });
}
