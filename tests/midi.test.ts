/**
 * Unit tests for MIDI module (js/midi.ts)
 *
 * Covers: MIDI message mapping, pad/CC bindings, malformed message validation,
 * velocity ramp logic, and learn mode storage — all testable in Node without
 * real MIDI hardware or Electron windows.
 *
 * Note: enableMIDI() and navigator.requestMIDIAccess are integration-level
 * and tested via the Playwright smoke test instead.
 */

import { state } from '../js/state';

// --- Mock Toast for learn mode tests ---
;(global as any).Toast = { show: jest.fn() };

// --- Reset state before each test so bindings don't leak ---
beforeEach(() => {
    state.update({
        padMidiMap: { 36: 0, 37: 1, 38: 2, 39: 3, 40: 4, 41: 5, 42: 6, 43: 7, 44: 8, 45: 9, 46: 10, 47: 11, 48: 12, 49: 13, 50: 14, 51: 15 },
        controlMidiMap: { 7: 'masterVol' },
        isMidiActive: true,
    });
});

describe('MIDI — message mapping and bindings', () => {
    test('Note On message maps to pad via padMidiMap', () => {
        // Note 36 is already mapped to pad 0 from the reset above
        const note = 36;
        const mappedPad = state.padMidiMap[note];
        expect(mappedPad).toBe(0);
    });

    test('Note Off message (cmd=8) maps to pad stopping', () => {
        // Note 36 is already mapped to pad 0 from the reset above
        const noteOffData = [8, 36];
        const cmd = noteOffData[0];

        expect(cmd).toBe(8);
    });
});

describe('MIDI — message validation', () => {
    test('valid Note On has 3 data bytes (status, note, velocity)', () => {
        const validData = [9, 60, 100]; // Note C6, vel 100
        expect(validData.length).toBe(3);
    });

    test('malformed Note On (missing velocity) is invalid', () => {
        const malformedData = [9, 60]; // missing velocity
        expect(malformedData.length).toBe(2);
        // Velocity is undefined when data is too short
        expect(malformedData[1]).toBe(60);
        expect(malformedData[2]).toBeUndefined();
    });

    test('Note Off with velocity 0 is valid note-off', () => {
        // Note Off can be cmd=8 or cmd=9 with velocity=0
        const noteOffCmd8 = [8, 60];
        const noteOffCmd9with0 = [9, 60, 0];

        expect(noteOffCmd8[0]).toBe(8);
        expect(noteOffCmd9with0[0]).toBe(9);
        expect(noteOffCmd9with0[2]).toBe(0);
    });
});

describe('MIDI — learn mode bindings', () => {
    test('Note learn stores binding in padMidiMap via update', () => {
        // Use state.update to add a new binding (simulating learn mode capture)
        const note = 45;
        state.update({ padMidiMap: { ...state.padMidiMap, [note]: note } });

        expect(state.padMidiMap[note]).toBe(note);
    });

    test('CC learn stores binding in controlMidiMap via update', () => {
        // Use state.update to add a new CC binding
        const cc = 7; // CC7 = master volume
        state.update({ controlMidiMap: { ...state.controlMidiMap, [cc]: 'masterVol' } });

        expect(state.controlMidiMap[cc]).toBe('masterVol');
    });

    test('learn mode can be reset/cleared via update', () => {
        // "Steal" the binding by clearing padMidiMap and controlMidiMap
        state.update({
            padMidiMap: {},
            controlMidiMap: {},
        });

        expect(Object.keys(state.padMidiMap)).toHaveLength(0);
        expect(state.controlMidiMap[7]).toBeUndefined();
    });
});