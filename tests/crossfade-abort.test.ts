/**
 * P0 repro (audit-sweep Phase P0 — FAILING, no prod fix yet).
 *
 * Bug: startCrossfade() throws mid-automation (js/player.ts:728-761, the
 * outgoing/incoming AudioParam scheduling block has no try/finally) and the
 * throw escapes with `isCrossfadeInProgress` stuck at true. The deck then
 * deadlocks: every later startCrossfade() early-returns on the stale flag,
 * and play/pause stay guarded. P1 must wrap automation so the flag always
 * resets (abort path) on failure.
 */

// --- Mock audio module ---
const mockAudioCtx = {
    currentTime: 0,
    decodeAudioData: jest.fn().mockResolvedValue({}),
};
jest.mock('../js/audio', () => ({
    audioCtx: mockAudioCtx,
    resumeAudioContext: jest.fn(),
    masterGain: { gain: { value: 1 } },
    analyser: {},
    initWorklets: jest.fn(),
    ensureAudio: jest.fn(() => true),
}));

// --- Mock settings (EQ automation enabled so the full block runs) ---
jest.mock('../js/settings', () => ({
    settings: {
        fullScreen: false,
        inputDevice: 'default',
        outputDevice: 'default',
        midiDevice: 'all',
        autoMix: {
            eqCrossfade: true,
            filterSweep: true,
            hpfSweep: true,
            bpmSync: false,
            trackDuration: 10,
            btnDuration: 4,
            enableAI: false,
        },
    },
    updateSettings: jest.fn(),
    isAiEnabled: jest.fn(() => false),
}));

// --- Mock audio engine (live deck loaded, incoming deck healthy) ---
function makeMockAudioNode(initialValue = 0) {
    return {
        value: initialValue,
        cancelScheduledValues: jest.fn(),
        setValueAtTime: jest.fn(),
        linearRampToValueAtTime: jest.fn(),
        exponentialRampToValueAtTime: jest.fn(),
    };
}
function makeMockFilter() {
    return {
        gain: makeMockAudioNode(),
        frequency: makeMockAudioNode(20000),
        type: 'lowpass',
        Q: { value: 0.5 },
    };
}
const mockMainAudio = {
    loop: false,
    playbackRate: 1,
    src: 'blob:live-deck',
    readyState: 4,
    currentTime: 0,
    duration: 100,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
};
const mockCrossfadeAudio = {
    loop: false,
    playbackRate: 1,
    src: '',
    currentTime: 0,
    duration: 100,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
};
const mockMainGainNode = makeMockAudioNode(1);
const mockEngine = {
    main: {
        audio: mockMainAudio,
        reset: jest.fn(),
        load: jest.fn(),
        loadAsync: jest.fn().mockResolvedValue(true),
        needsReload: false,
        gain: { gain: mockMainGainNode },
        lowEQ: makeMockFilter(),
        midEQ: makeMockFilter(),
        highEQ: makeMockFilter(),
        lpFilter: makeMockFilter(),
        hpFilter: makeMockFilter(),
    },
    crossfade: {
        audio: mockCrossfadeAudio,
        reset: jest.fn(),
        load: jest.fn(),
        loadAsync: jest.fn().mockResolvedValue(true),
        needsReload: false,
        gain: { gain: makeMockAudioNode(0.001) },
        lowEQ: makeMockFilter(),
        midEQ: makeMockFilter(),
        highEQ: makeMockFilter(),
        lpFilter: makeMockFilter(),
        hpFilter: makeMockFilter(),
    },
    swapChannels: jest.fn(),
    initWorklets: jest.fn(),
};
jest.mock('../js/audio-engine', () => ({
    engine: mockEngine,
}));

jest.mock('../js/worker-client', () => ({
    detectBPMWorker: jest.fn().mockResolvedValue(120),
    bufferToWaveWorker: jest.fn(),
}));
jest.mock('../js/toast', () => ({
    toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../js/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../js/utils', () => ({
    normalizeToArrayBuffer: jest.fn((x: any) => x),
    validateAudioSignature: jest.fn(() => null),
}));

function wavBytes(): ArrayBuffer {
    const buf = new ArrayBuffer(1024);
    const v = new Uint8Array(buf);
    v.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    return buf;
}
(global as any).document = { getElementById: jest.fn().mockReturnValue(null) };
Object.defineProperty(global, 'window', {
    value: { fileSystem: { readFile: jest.fn(async () => wavBytes()) } },
    writable: true,
    configurable: true,
});

import { state } from '../js/state';
import { startCrossfade, abortCrossfade } from '../js/player';

beforeEach(() => {
    jest.clearAllMocks();
    // Mid-automation failure: the outgoing gain ramp throws (e.g. a closed
    // AudioContext param). This is inside the unguarded block 728-761.
    mockMainGainNode.linearRampToValueAtTime.mockImplementation(() => {
        throw new Error('Automation failed');
    });
    state.update({
        isPlaying: true,
        currentTrackIndex: 0,
        playbackMode: 'continuous',
        loopMode: 'off',
        masterBPM: 0,
        playlist: [
            { id: '1', name: 'Track One', path: '/path/to/one.mp3', duration: 120, bpm: 128 },
            { id: '2', name: 'Track Two', path: '/path/to/two.mp3', duration: 90, bpm: 0 },
        ],
        selectedIndices: [],
        isAutoMixEnabled: true,
        isCrossfadeInProgress: false,
        blendingIndex: -1,
    });
});

afterEach(() => {
    try { abortCrossfade(); } catch { /* ignore */ }
});

describe('crossfade abort semantics (P0 repro — currently FAILS)', () => {
    test('isCrossfadeInProgress resets when automation throws mid-blend', async () => {
        await expect(startCrossfade(1)).rejects.toThrow('Automation failed');
        // BUG (js/player.ts:649,728-761): flag stays true — deck deadlocks.
        expect(state.isCrossfadeInProgress).toBe(false);
    });

    test('a failed blend does not permanently block the next blend', async () => {
        await startCrossfade(1).catch(() => { /* mid-automation throw */ });
        mockCrossfadeAudio.play.mockClear();
        mockMainGainNode.linearRampToValueAtTime.mockImplementation(() => { /* healed */ });
        await startCrossfade(1);
        // BUG: stale flag causes early-return, incoming deck never plays.
        expect(mockCrossfadeAudio.play).toHaveBeenCalledTimes(1);
    });
});
