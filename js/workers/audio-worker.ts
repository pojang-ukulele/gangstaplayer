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

if (typeof self !== 'undefined') {
self.onmessage = function(e: MessageEvent<WorkerMessage>) {
    const { type, payload, id } = e.data;
    // Drop id-less replies without leaking: no pending entry is created for
    // them, and none is resolved here.
    if (id === undefined || id === null) return;

    switch (type) {
        case 'DETECT_BPM':
            if (payload.data && payload.sampleRate) {
                const res = detectBPM(payload.data, payload.sampleRate, payload.threshold, payload.minStepSeconds);
                const reply: { type: string; bpm: number; confidence: BpmConfidence; altBpm?: number; id: number } =
                    { type: 'BPM_RESULT', bpm: res.bpm, confidence: res.confidence, id };
                if (typeof res.altBpm === 'number' && Number.isFinite(res.altBpm)) reply.altBpm = res.altBpm;
                self.postMessage(reply);
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
} // typeof self !== 'undefined' (node/test imports skip worker registration)

// Ellis-2007-lite tempo detector (no dependencies).
// Mono fast path: the client sends channel-0 only (90s cap); stereo is NOT
// analyzed here — that is intentional (2x copy + phase issues).
// Pipeline: loudest-30s segment → one-pole lowpass onset envelope (1024/512
// frames, log-flux, ~0.4Hz DC removal) → autocorrelation TPS over 60-210 BPM
// with Ellis log-Gaussian prior → parabolic peak refine → octave rival as
// altBpm (NO silent fold: winner is bpm, rival is altBpm).
// Limits: <4s clips, <8 usable onsets, or no TPS peak return bpm 0 + low
// (needs-review) — callers must NOT cache it as analyzed 0. Out-of-range or
// invalid input returns -1/none. Low-confidence estimates likewise mean
// "retry with other means", not "0 BPM".
// threshold/minStepSeconds are accepted for worker-contract compatibility
// (js/constants.ts defaults) but no longer drive detection.
export type BpmConfidence = 'high' | 'medium' | 'low' | 'none';

export interface BpmResult {
    bpm: number;
    confidence: BpmConfidence;
    altBpm?: number;
}

const BPM_RANGE_MIN = 60;
const BPM_RANGE_MAX = 210;
const BPM_ABS_MIN = 30;
const BPM_ABS_MAX = 210;
const SEGMENT_SECONDS = 30;
const FRAME_WINDOW = 1024;
const FRAME_HOP = 512;
const ONSET_LP_HZ = 175;
const ONSET_GAMMA = 100;
const DC_BLOCK_SECONDS = 2.5;
const OCTAVE_PERIOD_RATIOS = [2, 0.5, 3, 1 / 3];

function medianOf(values: number[]): number {
    if (values.length === 0) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function maxOf(values: number[]): number {
    let m = -Infinity;
    for (const v of values) if (v > m) m = v;
    return m === -Infinity ? 0 : m;
}

export function detectBPM(data: Float32Array, sampleRate: number, threshold = 0.1, minStepSeconds = 0.3): BpmResult {
    void threshold;
    void minStepSeconds;
    if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) return { bpm: -1, confidence: 'none' };
    if (!data || data.length === 0 || data.length > 32 * 1024 * 1024) return { bpm: -1, confidence: 'none' };
    const durationSec = data.length / sampleRate;
    if (!Number.isFinite(durationSec) || durationSec < 4) return { bpm: 0, confidence: 'low' };

    // 1. Segment: loudest SEGMENT_SECONDS of channel-0 (full clip if shorter).
    const segLen = Math.min(data.length, Math.floor(SEGMENT_SECONDS * sampleRate));
    let segStart = 0;
    if (segLen < data.length) {
        const blockLen = Math.max(1, Math.floor(sampleRate));
        const numBlocks = Math.floor(data.length / blockLen);
        const winBlocks = Math.max(1, Math.floor(segLen / blockLen));
        const blockE = new Float64Array(numBlocks);
        for (let b = 0; b < numBlocks; b++) {
            let e = 0;
            const off = b * blockLen;
            for (let i = 0; i < blockLen; i++) {
                const v = data[off + i];
                e += v * v;
            }
            blockE[b] = e;
        }
        let run = 0;
        for (let b = 0; b < winBlocks && b < numBlocks; b++) run += blockE[b];
        let best = 0;
        let bestE = run;
        for (let b = 1; b + winBlocks <= numBlocks; b++) {
            run += blockE[b + winBlocks - 1] - blockE[b - 1];
            if (run > bestE) {
                bestE = run;
                best = b;
            }
        }
        if (!(bestE > 0)) return { bpm: 0, confidence: 'low' };
        segStart = best * blockLen;
    }
    const seg = data.subarray(segStart, segStart + segLen);
    let segE = 0;
    for (let i = 0; i < seg.length; i += 7) {
        const v = seg[i];
        segE += v * v;
    }
    if (!(segE > 0)) return { bpm: 0, confidence: 'low' };
    const segDur = segLen / sampleRate;

    // 2. Onset envelope: one-pole lowpass, frame energy, log-flux, DC removal.
    const envRate = sampleRate / FRAME_HOP;
    const lpA = 1 - Math.exp(-2 * Math.PI * ONSET_LP_HZ / sampleRate);
    const nFrames = Math.floor((segLen - FRAME_WINDOW) / FRAME_HOP) + 1;
    if (nFrames < 16) return { bpm: 0, confidence: 'low' };
    const logE = new Float64Array(nFrames);
    let y = 0;
    for (let f = 0; f < nFrames; f++) {
        const off = f * FRAME_HOP;
        let e = 0;
        for (let i = 0; i < FRAME_WINDOW; i++) {
            const x = seg[off + i];
            y += lpA * (x - y);
            e += y * y;
        }
        logE[f] = Math.log(1 + ONSET_GAMMA * (e / FRAME_WINDOW));
    }
    const onset = new Float64Array(nFrames);
    for (let f = 1; f < nFrames; f++) {
        const d = logE[f] - logE[f - 1];
        onset[f] = d > 0 ? d : 0;
    }
    const dcWin = Math.max(8, Math.min(nFrames, Math.round(DC_BLOCK_SECONDS * envRate)));
    const half = Math.floor(dcWin / 2);
    const prefix = new Float64Array(nFrames + 1);
    for (let f = 0; f < nFrames; f++) prefix[f + 1] = prefix[f] + onset[f];
    const od = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
        const a = Math.max(0, f - half);
        const b = Math.min(nFrames - 1, f + half);
        od[f] = onset[f] - (prefix[b + 1] - prefix[a]) / (b - a + 1);
    }

    // Usable-onset gate: local maxima above median + 0.25 * (max - median).
    const odVals = Array.from(od);
    const odMax = maxOf(odVals);
    const odThr = medianOf(odVals) + 0.25 * (odMax - medianOf(odVals));
    const onsetPeaks: number[] = [];
    for (let f = 1; f < nFrames - 1; f++) {
        if (od[f] > od[f - 1] && od[f] >= od[f + 1] && od[f] > odThr) onsetPeaks.push(f);
    }
    if (onsetPeaks.length < 8) return { bpm: 0, confidence: 'low' };

    // 3. Periodicity: autocorrelation TPS over lags 0.286s-1.0s (60-210 BPM).
    // All lag math derives from envRate — never hardcoded samples.
    const minPer = 60 / BPM_RANGE_MAX;
    const maxPer = 60 / BPM_RANGE_MIN;
    const extMax = Math.min(maxPer * 3, segDur / 2);
    const minLag = Math.max(1, Math.round((minPer / 3) * envRate));
    const maxLag = Math.min(nFrames - 2, Math.round(extMax * envRate));
    if (maxLag <= minLag + 1) return { bpm: 0, confidence: 'low' };
    const raw = new Float64Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0;
        for (let i = lag; i < nFrames; i++) s += od[i] * od[i - lag];
        raw[lag] = s / (nFrames - lag);
    }
    const rawAt = (periodS: number): number => {
        const lag = periodS * envRate;
        if (!(lag >= minLag && lag <= maxLag)) return 0;
        const l0 = Math.floor(lag);
        const frac = lag - l0;
        const l1 = Math.min(maxLag, l0 + 1);
        return raw[l0] * (1 - frac) + raw[l1] * frac;
    };
    const tpsWeight = (tau: number): number => {
        const l = Math.log2(tau / 0.5) / 0.9;
        return Math.exp(-0.5 * l * l);
    };
    const gridMinLag = Math.max(minLag, Math.round(minPer * envRate));
    const gridMaxLag = Math.min(maxLag, Math.round(maxPer * envRate));
    if (gridMaxLag <= gridMinLag + 1) return { bpm: 0, confidence: 'low' };
    const grid: { lag: number; tau: number; v: number }[] = [];
    const gridVals: number[] = [];
    for (let lag = gridMinLag; lag <= gridMaxLag; lag++) {
        const tau = lag / envRate;
        const v = raw[lag] * tpsWeight(tau);
        grid.push({ lag, tau, v });
        gridVals.push(v);
    }
    const vMax = maxOf(gridVals);
    const vMed = medianOf(gridVals);
    const peakThr = vMed + 0.3 * (vMax - vMed);
    const cands: { lag: number; tau: number; v: number }[] = [];
    for (let i = 0; i < grid.length; i++) {
        const prev = i > 0 ? grid[i - 1].v : -Infinity;
        const next = i < grid.length - 1 ? grid[i + 1].v : -Infinity;
        if (grid[i].v > prev && grid[i].v >= next && grid[i].v >= peakThr) cands.push(grid[i]);
    }
    if (cands.length === 0) return { bpm: 0, confidence: 'low' };
    cands.sort((a, b) => b.v - a.v);
    const accepted: { lag: number; tau: number; v: number }[] = [];
    for (const c of cands) {
        const bc = 60 / c.tau;
        let clash = false;
        for (const a of accepted) {
            if (Math.abs(60 / a.tau - bc) / bc < 0.05) {
                clash = true;
                break;
            }
        }
        if (!clash) accepted.push(c);
    }
    const winner = accepted[0];
    let tauStar = winner.tau;
    const wi = grid.findIndex((t) => t.lag === winner.lag);
    if (wi > 0 && wi < grid.length - 1) {
        const y0 = grid[wi - 1].v;
        const y1 = grid[wi].v;
        const y2 = grid[wi + 1].v;
        const den = y0 - 2 * y1 + y2;
        let off = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
        if (!Number.isFinite(off)) off = 0;
        tauStar = (winner.lag + Math.max(-0.5, Math.min(0.5, off))) / envRate;
    }
    const bpmValue = 60 / tauStar;
    if (!Number.isFinite(bpmValue) || bpmValue < BPM_ABS_MIN || bpmValue > BPM_ABS_MAX) {
        return { bpm: -1, confidence: 'none' };
    }
    const bpm = Math.round(bpmValue);

    // 4. Octave reasoning: rival = best of {0.5x, 2x, 0.33x, 3x} tempo
    // (period ratios 2, 0.5, 3, 1/3). Winner stays bpm; rival becomes altBpm.
    const rawWinner = rawAt(tauStar);
    let octaveBest = 0;
    let octaveTau = 0;
    for (const r of OCTAVE_PERIOD_RATIOS) {
        const tau = tauStar * r;
        const v = rawAt(tau);
        if (v > octaveBest) {
            octaveBest = v;
            octaveTau = tau;
        }
    }
    let otherBest = 0;
    for (const a of accepted) {
        if (a === winner) continue;
        const ratio = a.tau / tauStar;
        let octaveRelated = false;
        for (const r of OCTAVE_PERIOD_RATIOS) {
            if (Math.abs(ratio - r) / r < 0.06) {
                octaveRelated = true;
                break;
            }
        }
        if (!octaveRelated && a.v > otherBest) otherBest = a.v;
    }
    if (!(otherBest > 0)) otherBest = Math.max(vMed, 1e-12);
    const r1 = winner.v / Math.max(otherBest, 1e-12);

    // Interval votes for the winner period (+/-8%) and their stability.
    const matched: number[] = [];
    for (let k = 1; k < onsetPeaks.length; k++) {
        const iv = (onsetPeaks[k] - onsetPeaks[k - 1]) / envRate;
        if (Math.abs(iv - tauStar) / tauStar <= 0.08) matched.push(iv);
    }
    const support = matched.length;
    let cv = 1;
    if (matched.length >= 2) {
        const m = matched.reduce((a, b) => a + b, 0) / matched.length;
        let va = 0;
        for (const iv of matched) va += (iv - m) * (iv - m);
        cv = m > 0 ? Math.sqrt(va / matched.length) / m : 1;
    }

    // 5. Confidence.
    let confidence: BpmConfidence = 'low';
    if (r1 >= 1.35 && support >= 12 && cv <= 0.25) confidence = 'high';
    else if (r1 >= 1.15 && support >= 8 && cv <= 0.40) confidence = 'medium';
    const octaveRatio = rawWinner / Math.max(octaveBest, 1e-12);
    if (octaveBest > 0 && octaveRatio < 1.15 && confidence === 'high') confidence = 'medium';
    if (segDur < 10) {
        if (confidence === 'high') confidence = 'medium';
        else if (confidence === 'medium') confidence = 'low';
    }
    if (confidence !== 'high' && confidence !== 'medium') return { bpm: 0, confidence: 'low' };
    const out: BpmResult = { bpm, confidence };
    if (octaveBest > 0 && octaveTau > 0) {
        const alt = Math.round(60 / octaveTau);
        if (Number.isFinite(alt) && alt >= 20 && alt <= 630 && alt !== bpm) out.altBpm = alt;
    }
    return out;
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
