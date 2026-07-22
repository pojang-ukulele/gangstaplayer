/**
 * Unit tests for utility functions (js/utils.ts)
 *
 * NOTE: `toBeInstanceOf(ArrayBuffer)` is intentionally avoided because
 * ts-jest transforms code into a separate realm, breaking instanceof
 * for built-ins like ArrayBuffer. We use a cross-realm-safe check instead.
 */
import { normalizeToArrayBuffer } from '../js/utils';

/** Cross-realm safe ArrayBuffer check (same technique used in the source) */
function isArrayBuffer(v: any): boolean {
    return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

describe('normalizeToArrayBuffer', () => {
    // --- ArrayBuffer input ---
    test('returns a slice copy of ArrayBuffer', () => {
        const original = new ArrayBuffer(16);
        const view = new Uint8Array(original);
        view[0] = 42;
        view[15] = 255;

        const result = normalizeToArrayBuffer(original);
        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(16);

        // Verify it's a copy (different reference)
        expect(result).not.toBe(original);

        // Verify content matches
        const resultView = new Uint8Array(result);
        expect(resultView[0]).toBe(42);
        expect(resultView[15]).toBe(255);
    });

    test('ArrayBuffer slice preserves data correctly', () => {
        const buf = new ArrayBuffer(8);
        const view = new Uint8Array(buf);
        view.set([10, 20, 30, 40, 50, 60, 70, 80]);

        const result = normalizeToArrayBuffer(buf);
        expect(new Uint8Array(result)).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    });

    // --- Typed array input ---
    test('extracts buffer from Uint8Array with correct byteOffset/length', () => {
        const original = new ArrayBuffer(32);
        const uint8 = new Uint8Array(original, 8, 16); // offset 8, length 16
        uint8[0] = 100;
        uint8[15] = 200;

        const result = normalizeToArrayBuffer(uint8);
        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(16);

        const resultView = new Uint8Array(result);
        expect(resultView[0]).toBe(100);
        expect(resultView[15]).toBe(200);
    });

    test('extracts buffer from Float32Array', () => {
        const original = new Float32Array([1.5, 2.5, 3.5]);
        const result = normalizeToArrayBuffer(original);

        expect(isArrayBuffer(result)).toBe(true);
        // Float32Array has 4 bytes per element
        expect(result.byteLength).toBe(12); // 3 * 4

        const resultView = new Float32Array(result);
        expect(resultView[0]).toBeCloseTo(1.5);
        expect(resultView[1]).toBeCloseTo(2.5);
        expect(resultView[2]).toBeCloseTo(3.5);
    });

    test('extracts buffer from Int16Array', () => {
        const original = new Int16Array([-100, 0, 100, 32767]);
        const result = normalizeToArrayBuffer(original);

        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(8); // 4 * 2

        const resultView = new Int16Array(result);
        expect(resultView[0]).toBe(-100);
        expect(resultView[3]).toBe(32767);
    });

    test('extracts buffer from Uint16Array with offset', () => {
        const ab = new ArrayBuffer(20);
        const uint16 = new Uint16Array(ab, 4, 4); // offset 4, length 4 (8 bytes)
        uint16[0] = 65535;
        uint16[3] = 1;

        const result = normalizeToArrayBuffer(uint16);
        expect(result.byteLength).toBe(8); // 4 elements * 2 bytes

        const resultView = new Uint16Array(result);
        expect(resultView[0]).toBe(65535);
        expect(resultView[3]).toBe(1);
    });

    // --- Node.js Buffer input ---
    test('extracts buffer from Node.js Buffer', () => {
        const buf = Buffer.from([1, 2, 3, 4, 5]);
        const result = normalizeToArrayBuffer(buf);

        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(5);

        const resultView = new Uint8Array(result);
        expect(Array.from(resultView)).toEqual([1, 2, 3, 4, 5]);
    });

    test('extracts buffer from Buffer subarray (offset)', () => {
        const buf = Buffer.from([10, 20, 30, 40, 50, 60]);
        const sub = buf.subarray(2, 5); // [30, 40, 50]

        const result = normalizeToArrayBuffer(sub);
        expect(result.byteLength).toBe(3);

        const resultView = new Uint8Array(result);
        expect(Array.from(resultView)).toEqual([30, 40, 50]);
    });

    // --- Edge cases ---
    test('handles empty ArrayBuffer', () => {
        const result = normalizeToArrayBuffer(new ArrayBuffer(0));
        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(0);
    });

    test('handles empty Uint8Array', () => {
        const result = normalizeToArrayBuffer(new Uint8Array(0));
        expect(isArrayBuffer(result)).toBe(true);
        expect(result.byteLength).toBe(0);
    });

    test('handles Uint8Array with full buffer (no offset)', () => {
        const uint8 = new Uint8Array([255, 0, 128, 64]);
        const result = normalizeToArrayBuffer(uint8);

        expect(result.byteLength).toBe(4);
        expect(Array.from(new Uint8Array(result))).toEqual([255, 0, 128, 64]);
    });

    test('result is always a standalone ArrayBuffer (not view)', () => {
        const original = new Uint8Array([1, 2, 3]);
        const result = normalizeToArrayBuffer(original);

        // Modifying original should NOT affect result
        original[0] = 99;
        expect(new Uint8Array(result)[0]).toBe(1);
    });

    test('result from ArrayBuffer slice is independent', () => {
        const original = new ArrayBuffer(4);
        new Uint8Array(original).set([5, 10, 15, 20]);

        const result = normalizeToArrayBuffer(original);
        new Uint8Array(original)[0] = 0; // mutate original

        expect(new Uint8Array(result)[0]).toBe(5); // result unaffected
    });

    // --- Large buffer ---
    test('handles large buffer (1MB)', () => {
        const size = 1024 * 1024; // 1MB
        const original = new Uint8Array(size);
        original[0] = 1;
        original[size - 1] = 255;

        const result = normalizeToArrayBuffer(original);
        expect(result.byteLength).toBe(size);

        const resultView = new Uint8Array(result);
        expect(resultView[0]).toBe(1);
        expect(resultView[size - 1]).toBe(255);
    });
});
