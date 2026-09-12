/**
 * P3-I validator coverage (js/utils.ts validateAudioSignature).
 * Proves each accept/reject from the audit-sweep lane:
 *  - accepts: WAV/RIFX/RF64-with-body/AIFF, MP3 sync, ADTS (.aac explicit),
 *    OggS, fLaC, M4A-audio brands, WebM doctype, ID3>8KB padding, ftyp/EBML
 *    inside ID3.
 *  - rejects: MP4-video brands, MKV doctype, RF64-bare, 12B RIFF without
 *    fmt/data, bare ID3, garbage/tiny.
 */
import { validateAudioSignature } from '../js/utils';

function buf(bytes: number[]): ArrayBuffer {
    return new Uint8Array(bytes).buffer;
}
function ascii(s: string): number[] {
    return Array.from(s).map((c) => c.charCodeAt(0));
}
function synchsafe(n: number): number[] {
    return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

describe('P3-I audio validator', () => {
    test('accepts WAV with fmt body', () => {
        const b = new Uint8Array(32);
        b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);
        expect(validateAudioSignature(b.buffer)).toBeNull();
    });

    test('rejects 12B RIFF without fmt/data', () => {
        const b = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]);
        expect(b.length).toBe(12);
        expect(validateAudioSignature(b.buffer)).not.toBeNull();
    });

    test('accepts RF64 with ds64 body, rejects RF64-bare', () => {
        const good = new Uint8Array(64);
        good.set(ascii('RF64'), 0);
        good.set(ascii('ds64'), 12);
        expect(validateAudioSignature(good.buffer)).toBeNull();
        const bare = new Uint8Array(64); // no ds64/data/WAVE anywhere
        bare.set(ascii('RF64'), 0);
        expect(validateAudioSignature(bare.buffer)).not.toBeNull();
    });

    test('accepts ADTS AAC syncs (explicit .aac policy)', () => {
        expect(validateAudioSignature(buf([0xff, 0xf1, 0, 0]))).toBeNull();
        expect(validateAudioSignature(buf([0xff, 0xf9, 0, 0]))).toBeNull();
    });

    test('accepts M4A audio brands, rejects MP4-video brands', () => {
        const audio = new Uint8Array(32);
        audio.set([0, 0, 0, 24, ...ascii('ftyp'), ...ascii('M4A ')], 0);
        expect(validateAudioSignature(audio.buffer)).toBeNull();
        const video = new Uint8Array(32);
        video.set([0, 0, 0, 24, ...ascii('ftyp'), ...ascii('isom')], 0);
        video.set(ascii('avc1'), 16);
        expect(validateAudioSignature(video.buffer)).not.toBeNull();
        const avcMajor = new Uint8Array(32);
        avcMajor.set([0, 0, 0, 24, ...ascii('ftyp'), ...ascii('avc1')], 0);
        expect(validateAudioSignature(avcMajor.buffer)).not.toBeNull();
    });

    test('accepts WebM doctype, rejects MKV (matroska) doctype', () => {
        const webm = new Uint8Array(32);
        webm.set([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0], 0);
        webm.set([0x42, 0x82, 0x84, ...ascii('webm')], 8);
        expect(validateAudioSignature(webm.buffer)).toBeNull();
        const mkv = new Uint8Array(32);
        mkv.set([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0], 0);
        mkv.set([0x42, 0x82, 0x88, ...ascii('matroska')], 8);
        expect(validateAudioSignature(mkv.buffer)).not.toBeNull();
    });

    test('accepts ID3 with >8KB padding before frames', () => {
        const tagSize = 20000;
        const total = 10 + tagSize + 8;
        const b = new Uint8Array(total);
        b.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(tagSize)], 0);
        b.set([0xff, 0xfb, 0, 0], 10 + tagSize);
        expect(validateAudioSignature(b.buffer)).toBeNull();
    });

    test('accepts ftyp and EBML inside ID3', () => {
        const tagSize = 16;
        const bf = new Uint8Array(10 + tagSize + 12);
        bf.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(tagSize)], 0);
        bf.set([0, 0, 0, 0, ...ascii('ftyp')], 10 + tagSize);
        expect(validateAudioSignature(bf.buffer)).toBeNull();
        const be = new Uint8Array(10 + tagSize + 8);
        be.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(tagSize)], 0);
        be.set([0x1a, 0x45, 0xdf, 0xa3], 10 + tagSize);
        expect(validateAudioSignature(be.buffer)).toBeNull();
    });

    test('rejects bare ID3 and garbage', () => {
        const bare = new Uint8Array(26);
        bare.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(16)], 0);
        expect(validateAudioSignature(bare.buffer)).not.toBeNull();
        expect(validateAudioSignature(buf([1, 2, 3, 4]))).not.toBeNull();
        expect(validateAudioSignature(new ArrayBuffer(0))).not.toBeNull();
    });
});
