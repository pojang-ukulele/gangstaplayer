/**
 * P3-G audit-sweep guards (js/state.ts): playlist deep-freeze + update()
 * boolean return contract. DOM-free so it runs under the node test env.
 */
import { state } from '../js/state';

describe('P3-G state guards', () => {
    test('playlist getter returns a deep-frozen copy (no-mutate)', () => {
        expect(state.update({
            playlist: [{ id: 'fz-1', name: 'FZ', path: '/fz.mp3', duration: 3 }],
        })).toBe(true);
        const pl = state.playlist;
        expect(Object.isFrozen(pl)).toBe(true);
        expect(Object.isFrozen(pl[0])).toBe(true);
        // In-place writes must throw loudly instead of silently skipping notify.
        expect(() => { (pl as unknown as unknown[]).push({ id: 'x' }); }).toThrow();
        expect(() => { (pl[0] as unknown as { bpm?: number }).bpm = 5; }).toThrow();
        // Live state untouched by the failed writes.
        expect(state.playlist).toHaveLength(1);
        expect(state.playlist[0].bpm).toBeUndefined();
        expect(state.update({ playlist: [] })).toBe(true);
    });

    test('update() returns false and warns on a rejected patch', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const ok = state.update({ loopMode: 'bogus' as unknown as 'off' });
            expect(ok).toBe(false);
            expect(warn).toHaveBeenCalled();
            // Rejected write never applied.
            expect(state.loopMode).toBe('off');
        } finally {
            warn.mockRestore();
        }
    });

    test('update() returns true for a valid patch', () => {
        expect(state.update({ masterBPM: 128 })).toBe(true);
        expect(state.masterBPM).toBe(128);
        expect(state.update({ masterBPM: 0 })).toBe(true);
    });
});
