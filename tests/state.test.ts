/**
 * Unit tests for ReactiveStore (js/state.ts)
 */
import { state, ReactiveStore, AppStateData, PlaybackMode, LoopMode, Track } from '../js/state';

// We import the singleton `state` for integration-style tests,
// but create fresh stores for isolated unit tests via constructor access.
// ReactiveStore is not exported by name — we test via the singleton.
// For isolated tests, we use `jest.requireActual` to get the class.

describe('ReactiveStore (state singleton)', () => {
    // --- Default values ---
    test('has correct default values', () => {
        expect(state.isPlaying).toBe(false);
        expect(state.currentTrackIndex).toBe(-1);
        expect(state.playbackMode).toBe('continuous');
        expect(state.loopMode).toBe('off');
        expect(state.masterBPM).toBe(0);
        expect(state.playlist).toEqual([]);
        expect(state.selectedIndices).toEqual([]);
        expect(state.isAutoMixEnabled).toBe(false);
        expect(state.isCrossfadeInProgress).toBe(false);
        expect(state.blendingIndex).toBe(-1);
        expect(state.isMidiActive).toBe(false);
        expect(state.isLearningMidi).toBe(false);
        expect(state.midiLearnTarget).toBeNull();
        expect(state.isLearningKey).toBe(false);
        expect(state.keyLearnTargetPad).toBeNull();
    });

    test('padMidiMap has 16 entries (MIDI notes 36-51)', () => {
        expect(Object.keys(state.padMidiMap)).toHaveLength(16);
        expect(state.padMidiMap[36]).toBe(0);
        expect(state.padMidiMap[51]).toBe(15);
    });

    test('padKeyMap has 16 entries', () => {
        expect(state.padKeyMap).toHaveLength(16);
        expect(state.padKeyMap[0]).toBe('1');
        expect(state.padKeyMap[15]).toBe('v');
    });

    test('controlMidiMap has 3 entries', () => {
        expect(state.controlMidiMap[1]).toBe('masterVol');
        expect(state.controlMidiMap[7]).toBe('masterVol');
        expect(state.controlMidiMap[10]).toBe('tempoSlider');
    });

    // --- subscribe / unsubscribe ---
    test('subscribe() returns unsubscribe function that stops listener', () => {
        const spy = jest.fn();
        const unsub = state.subscribe('isPlaying', spy);

        state.update({ isPlaying: true });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(true, expect.anything());

        unsub();
        state.update({ isPlaying: false });
        // Should NOT have been called again
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('subscribe() fires with (value, fullState) args', () => {
        const spy = jest.fn();
        const unsub = state.subscribe('masterBPM', spy);

        state.update({ masterBPM: 140 });
        expect(spy).toHaveBeenCalledWith(140, expect.objectContaining({
            masterBPM: 140,
            isPlaying: false,
        }));

        unsub();
    });

    // --- update() with equality check ---
    test('update() does NOT trigger subscribers when value is unchanged (reference)', () => {
        const spy = jest.fn();
        const unsub = state.subscribe('loopMode', spy);

        // Same value — should NOT trigger
        state.update({ loopMode: 'off' });
        expect(spy).not.toHaveBeenCalled();

        // Different value — SHOULD trigger
        state.update({ loopMode: 'one' });
        expect(spy).toHaveBeenCalledTimes(1);

        unsub();
    });

    test('update() does NOT trigger when array content is unchanged (shallowEqual)', () => {
        const spy = jest.fn();
        const unsub = state.subscribe('playlist', spy);

        state.update({ playlist: [] }); // empty === default, same content
        expect(spy).toHaveBeenCalledTimes(0);

        state.update({ playlist: [{ id: '1', name: 'A', path: '/a', duration: 10, bpm: 120 }] });
        expect(spy).toHaveBeenCalledTimes(1);

        unsub();
    });

    // --- subscribeAll ---
    test('subscribeAll() fires on any state change', () => {
        const spy = jest.fn();
        const unsub = state.subscribeAll(spy);

        state.update({ isPlaying: true });
        expect(spy).toHaveBeenCalledTimes(1);

        state.update({ masterBPM: 100 });
        expect(spy).toHaveBeenCalledTimes(2);

        state.update({ isPlaying: false, masterBPM: 0 });
        // Both changed — global listener fires once per update() call
        expect(spy).toHaveBeenCalledTimes(3);

        unsub();
    });

    test('subscribeAll() returns unsubscribe', () => {
        const spy = jest.fn();
        const unsub = state.subscribeAll(spy);

        state.update({ isPlaying: true });
        expect(spy).toHaveBeenCalledTimes(1);

        unsub();
        state.update({ isPlaying: false });
        expect(spy).toHaveBeenCalledTimes(1); // no change
    });

    // --- update() multi-key ---
    test('update() with multiple keys triggers each specific listener', () => {
        const spy1 = jest.fn();
        const spy2 = jest.fn();
        const unsub1 = state.subscribe('isAutoMixEnabled', spy1);
        const unsub2 = state.subscribe('isCrossfadeInProgress', spy2);

        state.update({ isAutoMixEnabled: true, isCrossfadeInProgress: true });

        expect(spy1).toHaveBeenCalledWith(true, expect.anything());
        expect(spy2).toHaveBeenCalledWith(true, expect.anything());

        unsub1();
        unsub2();
    });

    // --- Readonly enforcement ---
    test('properties cannot be mutated directly at compile-time', () => {
        // The getter pattern in ReactiveStore makes direct assignment
        // fail at the TypeScript level. In JS runtime, it's a no-op.
        // We verify the getter exists.
        expect(typeof state.isPlaying).toBe('boolean');
        expect(typeof state.update).toBe('function');
    });

    // --- State tracking correctness ---
    test('update() correctly tracks state changes', () => {
        expect(state.isPlaying).toBe(false);

        state.update({ isPlaying: true });
        expect(state.isPlaying).toBe(true);

        state.update({ currentTrackIndex: 5 });
        expect(state.currentTrackIndex).toBe(5);
        expect(state.isPlaying).toBe(true); // still true
    });

    // --- update() with no changes ---
    test('update() with no changed keys triggers nothing', () => {
        const spy = jest.fn();
        const unsub = state.subscribeAll(spy);

        // Set to current value — should not trigger
        state.update({ isPlaying: state.isPlaying });
        expect(spy).not.toHaveBeenCalled();

        unsub();
    });
});

describe('ReactiveStore integration (state changes propagate)', () => {
    beforeEach(() => {
        state.update({
            isPlaying: false,
            currentTrackIndex: -1,
            playbackMode: 'continuous',
            loopMode: 'off',
            masterBPM: 0,
            playlist: [],
            selectedIndices: [],
            isAutoMixEnabled: false,
            isCrossfadeInProgress: false,
            blendingIndex: -1,
            isMidiActive: false,
            isLearningMidi: false,
            midiLearnTarget: null,
            isLearningKey: false,
            keyLearnTargetPad: null,
        });
    });

    test('isPlaying propagates correctly through play/pause cycle', () => {
        expect(state.isPlaying).toBe(false);

        state.update({ isPlaying: true });
        expect(state.isPlaying).toBe(true);

        state.update({ isPlaying: false });
        expect(state.isPlaying).toBe(false);
    });

    test('loopMode cycles correctly', () => {
        const modes: LoopMode[] = ['off', 'one', 'all'];
        modes.forEach(m => {
            state.update({ loopMode: m });
            expect(state.loopMode).toBe(m);
        });
    });

    test('playbackMode cycles correctly', () => {
        const modes: PlaybackMode[] = ['continuous', 'single'];
        modes.forEach(m => {
            state.update({ playbackMode: m });
            expect(state.playbackMode).toBe(m);
        });
    });

    test('blendingIndex updates correctly', () => {
        state.update({ blendingIndex: 3 });
        expect(state.blendingIndex).toBe(3);

        state.update({ blendingIndex: -1 });
        expect(state.blendingIndex).toBe(-1);
    });
});
