/**
 * P0 repro (audit-sweep Phase P0 — FAILING, no prod fix yet).
 *
 * Bug (js/utils.ts:28,45-54): normalizeToArrayBuffer() has no IPC contract —
 * a string payload is silently shredded into a zero-filled buffer via the
 * array-like path, and a DETACHED ArrayBuffer returns `data.slice(0)` (a
 * zero-length buffer) instead of failing loud. Callers then feed garbage into
 * decodeAudioData/workers. P2 must throw INVALID_IPC_PAYLOAD for strings and
 * detached buffers and never return a zero-buffer for non-empty input.
 */
import { normalizeToArrayBuffer } from '../js/utils';

function makeDetached(size = 8): ArrayBuffer {
    const ab = new ArrayBuffer(size);
    new Uint8Array(ab).fill(0xa5);
    const t = (ab as unknown as { transfer?: () => ArrayBuffer }).transfer;
    if (typeof t === 'function') {
        t.call(ab);
    } else if (typeof structuredClone === 'function') {
        try {
            structuredClone(ab, { transfer: [ab] });
        } catch { /* fall through to port transfer */ }
    }
    if (ab.byteLength !== 0) {
        // Final fallback: MessagePort transfer neuters the source.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { MessageChannel } = require('worker_threads');
        const { port1, port2 } = new MessageChannel();
        port1.postMessage(ab, [ab]);
        port1.close();
        port2.close();
    }
    expect(ab.byteLength).toBe(0); // precondition: really detached
    return ab;
}

describe('detached-buffer IPC contract (P0 repro — currently FAILS)', () => {
    test('string payload throws INVALID_IPC_PAYLOAD', () => {
        // BUG (utils.ts:45-54): shredded into a zero-filled buffer, no throw
        // with the contract code (current message lacks INVALID_IPC_PAYLOAD).
        expect(() => normalizeToArrayBuffer('RIFF....WAVE' as unknown as ArrayBuffer)).toThrow(
            /INVALID_IPC_PAYLOAD/
        );
    });

    test('detached ArrayBuffer throws INVALID_IPC_PAYLOAD, never zero-buffer', () => {
        const detached = makeDetached(8);
        let threw = false;
        let result: ArrayBuffer | undefined;
        try {
            result = normalizeToArrayBuffer(detached);
        } catch (e) {
            threw = true;
            expect((e as Error).message).toMatch(/INVALID_IPC_PAYLOAD/);
        }
        // BUG (utils.ts:28): `data.slice(0)` on a detached buffer yields a
        // zero-length buffer instead of throwing.
        expect(threw).toBe(true);
        if (!threw) expect(result!.byteLength).toBe(8);
    });
});
