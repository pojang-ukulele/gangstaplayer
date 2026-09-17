/**
 * Ellis-2007-lite BPM detector: synthetic click-track accuracy.
 *
 * Imports detectBPM from js/workers/audio-worker directly (worker
 * registration is skipped outside a Worker/self context). Clicks are
 * periodic impulses — the old loudness-averaging detector also "passed"
 * these, but the periodicity gates (support/cv/r1) are what is pinned here:
 * exact-tempo clicks must score high/medium, silence/short/noise must take
 * the needs-review path (bpm 0 + low, or -1 + none).
 */
import { detectBPM } from '../js/workers/audio-worker';

function clickTrack(bpm: number, seconds: number, sampleRate: number): Float32Array {
    const len = Math.floor(seconds * sampleRate);
    const data = new Float32Array(len);
    const periodSamples = (60 / bpm) * sampleRate;
    const beats = Math.floor((seconds * bpm) / 60);
    for (let t = 0; t < beats; t++) {
        const idx = Math.round(t * periodSamples);
        for (let i = 0; i < 64 && idx + i < len; i++) {
            data[idx + i] += Math.exp(-i / 8) * 0.9;
        }
    }
    return data;
}

function lcgNoise(seconds: number, sampleRate: number, seed = 0x12345678): Float32Array {
    const len = Math.floor(seconds * sampleRate);
    const data = new Float32Array(len);
    let s = seed >>> 0;
    for (let i = 0; i < len; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        data[i] = (s / 0xffffffff) * 0.4 - 0.2;
    }
    return data;
}

describe('detectBPM periodicity (synthetic clicks)', () => {
    test('120 BPM clicks @44.1k -> ~120 high/medium', () => {
        const res = detectBPM(clickTrack(120, 16, 44100), 44100);
        expect(Math.abs(res.bpm - 120)).toBeLessThanOrEqual(1);
        expect(['high', 'medium']).toContain(res.confidence);
    });

    test('100 BPM clicks @48k -> ~100 high/medium (sample-rate independence)', () => {
        const res = detectBPM(clickTrack(100, 16, 48000), 48000);
        expect(Math.abs(res.bpm - 100)).toBeLessThanOrEqual(1);
        expect(['high', 'medium']).toContain(res.confidence);
    });

    test('140 BPM clicks @44.1k -> ~140 high/medium (off-center of prior)', () => {
        const res = detectBPM(clickTrack(140, 16, 44100), 44100);
        expect(Math.abs(res.bpm - 140)).toBeLessThanOrEqual(1);
        expect(['high', 'medium']).toContain(res.confidence);
    });

    test('octave rival reported as altBpm, never folded into bpm', () => {
        const res = detectBPM(clickTrack(120, 16, 44100), 44100);
        expect(res.bpm).toBeGreaterThanOrEqual(119);
        expect(res.bpm).toBeLessThanOrEqual(121);
        if (res.altBpm !== undefined) {
            expect(Number.isFinite(res.altBpm)).toBe(true);
            expect(res.altBpm).not.toBe(res.bpm);
        }
    });

    test('silence -> needs-review (bpm 0 + low)', () => {
        const res = detectBPM(new Float32Array(44100 * 8), 44100);
        expect(res.bpm).toBe(0);
        expect(res.confidence).toBe('low');
    });

    test('sub-4s clip -> needs-review', () => {
        const res = detectBPM(clickTrack(120, 2, 44100), 44100);
        expect(res.bpm).toBe(0);
        expect(res.confidence).toBe('low');
    });

    test('unpitched noise -> needs-review (no false tempo)', () => {
        const res = detectBPM(lcgNoise(12, 44100), 44100);
        expect(res.confidence === 'low' || res.confidence === 'none').toBe(true);
        expect(res.bpm).toBeLessThanOrEqual(0);
    });

    test('invalid input -> -1/none', () => {
        expect(detectBPM(new Float32Array(100), 0)).toEqual({ bpm: -1, confidence: 'none' });
        expect(detectBPM(new Float32Array(0), 44100)).toEqual({ bpm: -1, confidence: 'none' });
    });
});
