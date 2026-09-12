/**
 * P4 audit-sweep: BPM confidence skip-persist policy.
 *
 * Proves a low-confidence / null / 0 fresh analysis never clobbers a good
 * cached BPM — callers keep the prior value (DB/state) and flag review
 * instead of persisting bpm:0.
 */
import { detectBPMWithConfidence, resolveBpmPersist } from '../js/worker-client';

// --- Fake AudioWorker: replies BPM_RESULT with a scripted bpm/confidence ---
let fakeReply: { bpm: number; confidence: string } = { bpm: 128, confidence: 'high' };
class FakeWorker {
    onmessage: ((e: { data: Record<string, unknown> }) => void) | null = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    constructor(public url: string) {}
    postMessage(msg: { id: number }): void {
        const handler = this.onmessage;
        const reply = fakeReply;
        setTimeout(() => {
            handler?.({ data: { type: 'BPM_RESULT', bpm: reply.bpm, confidence: reply.confidence, id: msg.id } });
        }, 0);
    }
    terminate(): void { /* noop */ }
}
(global as unknown as { Worker: unknown }).Worker = FakeWorker;

function fakeAudioBuffer(): AudioBuffer {
    return {
        getChannelData: () => new Float32Array(44100),
        sampleRate: 44100,
        numberOfChannels: 1,
    } as unknown as AudioBuffer;
}

describe('resolveBpmPersist — skip-persist policy', () => {
    test('high-confidence fresh value persists', () => {
        const d = resolveBpmPersist({ bpm: 128, confidence: 'high', needsReview: false }, undefined);
        expect(d).toEqual({ bpm: 128, persisted: true, needsReview: false });
    });

    test('medium-confidence fresh value persists', () => {
        const d = resolveBpmPersist({ bpm: 96, confidence: 'medium', needsReview: false }, 120);
        expect(d).toEqual({ bpm: 96, persisted: true, needsReview: false });
    });

    test('low-confidence null keeps prior value (no 0 clobber)', () => {
        const d = resolveBpmPersist({ bpm: null, confidence: 'low', needsReview: true }, 128);
        expect(d).toEqual({ bpm: 128, persisted: false, needsReview: true });
    });

    test('legacy 0 fresh result keeps good prior value', () => {
        const d = resolveBpmPersist(0, 128);
        expect(d.persisted).toBe(false);
        expect(d.bpm).toBe(128);
    });

    test('null/undefined fresh result keeps prior value', () => {
        expect(resolveBpmPersist(null, 128)).toEqual({ bpm: 128, persisted: false, needsReview: true });
        expect(resolveBpmPersist(undefined, 128)).toEqual({ bpm: 128, persisted: false, needsReview: true });
    });

    test('non-finite / negative legacy numbers are needs-review', () => {
        for (const bad of [NaN, Infinity, -5, -1]) {
            const d = resolveBpmPersist(bad, 100);
            expect(d.persisted).toBe(false);
            expect(d.bpm).toBe(100);
        }
    });

    test('invalid prior sanitizes to undefined (never caches garbage)', () => {
        for (const prior of [0, -3, NaN, null, undefined]) {
            const d = resolveBpmPersist({ bpm: null, confidence: 'none', needsReview: true }, prior as number | null);
            expect(d.persisted).toBe(false);
            expect(d.bpm).toBeUndefined();
        }
    });

    test('needs-review flag on object wins even with a positive bpm field', () => {
        const d = resolveBpmPersist({ bpm: 140, confidence: 'low', needsReview: true }, 128);
        expect(d).toEqual({ bpm: 128, persisted: false, needsReview: true });
    });
});

describe('detectBPMWithConfidence + skip-persist integration', () => {
    test('high-confidence worker result persists the fresh BPM', async () => {
        fakeReply = { bpm: 128, confidence: 'high' };
        const analysis = await detectBPMWithConfidence(fakeAudioBuffer());
        expect(analysis.needsReview).toBe(false);
        const d = resolveBpmPersist(analysis, undefined);
        expect(d.persisted).toBe(true);
        expect(d.bpm).toBe(128);
    });

    test('low-confidence worker result does NOT clobber a good cached BPM', async () => {
        fakeReply = { bpm: -1, confidence: 'low' };
        const analysis = await detectBPMWithConfidence(fakeAudioBuffer());
        expect(analysis.needsReview).toBe(true);
        expect(analysis.bpm).toBeNull();
        // The regression: this must keep 128 (the good DB value), never 0.
        const d = resolveBpmPersist(analysis, 128);
        expect(d.persisted).toBe(false);
        expect(d.bpm).toBe(128);
        expect(d.bpm).not.toBe(0);
    });
});
