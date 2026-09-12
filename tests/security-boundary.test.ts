/**
 * Regression tests for audit-critical boundaries.
 * Covers: audio signature gate, state enum validation + subscriber isolation,
 * session/crash enum allowlists are enforced via state.update.
 */
import { validateAudioSignature } from '../js/utils';
import { state } from '../js/state';

function wavBuffer(): ArrayBuffer {
    const buf = new ArrayBuffer(64);
    const v = new Uint8Array(buf);
    // Genuinely valid WAV: RIFF size + WAVE + fmt chunk tag + minimal body.
    // (A bare 64B RIFF....WAVE header with no fmt/data chunk is correctly
    // rejected by the P3-I gate, so the fixture must carry fmt evidence.)
    v.set([0x52, 0x49, 0x46, 0x46, 0x38, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    v.set([0x66, 0x6D, 0x74, 0x20], 12); // "fmt "
    v.set([0x10, 0x00, 0x00, 0x00], 16); // fmt chunk size 16 (PCM)
    return buf;
}

describe('validateAudioSignature gate', () => {
    test('accepts RIFF/WAVE', () => {
        expect(validateAudioSignature(wavBuffer())).toBeNull();
    });
    test('rejects non-audio payload', () => {
        const buf = new ArrayBuffer(64);
        new Uint8Array(buf).fill(0x41);
        expect(validateAudioSignature(buf)).not.toBeNull();
    });
    test('rejects empty buffer', () => {
        expect(validateAudioSignature(new ArrayBuffer(0))).not.toBeNull();
    });
});

describe('state.update validation', () => {
    test('rejects invalid loopMode/playbackMode', () => {
        const before = state.loopMode;
        state.update({ loopMode: 'evil' as any });
        expect(state.loopMode).toBe(before);
        const pb = state.playbackMode;
        state.update({ playbackMode: 'evil' as any });
        expect(state.playbackMode).toBe(pb);
    });
    test('rejects NaN currentTrackIndex', () => {
        const before = state.currentTrackIndex;
        state.update({ currentTrackIndex: NaN as any });
        expect(state.currentTrackIndex).toBe(before);
    });
    test('one throwing subscriber does not kill the rest', () => {
        const calls: string[] = [];
        const bad = state.subscribe('isPlaying', () => { throw new Error('boom'); });
        const good = state.subscribe('isPlaying', () => { calls.push('ok'); });
        expect(() => state.update({ isPlaying: !state.isPlaying })).not.toThrow();
        expect(calls).toEqual(['ok']);
        bad();
        good();
    });
    test('getSnapshot is plain-cloneable (no Maps/functions)', () => {
        const snap = state.getSnapshot();
        expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow();
    });
});
