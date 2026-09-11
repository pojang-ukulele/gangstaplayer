/**
 * Unit tests for Player module (js/player.ts)
 *
 * player.ts depends on DOM, Web Audio API, settings, state, and engine.
 * We mock all external deps and test pure-logic exports + guard clauses.
 */

// ============================================================
// M O C K S   (must be before the import)
// ============================================================

// --- Mock audio module ---
const mockAudioCtx = {
    currentTime: 0,
    decodeAudioData: jest.fn(),
    resume: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../js/audio', () => ({
    audioCtx: mockAudioCtx,
    resumeAudioContext: jest.fn().mockResolvedValue(undefined),
    masterGain: { gain: { value: 1 } },
    analyser: { getByteFrequencyData: jest.fn(), fftSize: 256 },
    initWorklets: jest.fn(),
    ensureAudio: jest.fn(() => true),
}));

// --- Mock settings ---
const mockSettings = {
    fullScreen: false,
    inputDevice: 'default',
    outputDevice: 'default',
    midiDevice: 'all',
    autoMix: {
        eqCrossfade: false,
        filterSweep: false,
        hpfSweep: false,
        bpmSync: false,
        trackDuration: 10,
        btnDuration: 4,
        enableAI: false,
    },
};
jest.mock('../js/settings', () => ({
    settings: mockSettings,
    updateSettings: jest.fn(),
    isAiEnabled: jest.fn(() => mockSettings.autoMix.enableAI),
}));

// --- Mock audio engine ---
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
    src: '',
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

const mockEngine = {
    main: {
        audio: mockMainAudio,
        reset: jest.fn(),
        load: jest.fn(),
        loadAsync: jest.fn().mockResolvedValue(true),
        needsReload: false,
        gain: { gain: makeMockAudioNode(1) },
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

// --- Mock worker-client ---
jest.mock('../js/worker-client', () => ({
    detectBPMWorker: jest.fn().mockResolvedValue(120),
    bufferToWaveWorker: jest.fn(),
}));

// --- Mock toast ---
jest.mock('../js/toast', () => ({
    toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// --- Mock logger ---
jest.mock('../js/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// --- Mock normalizeToArrayBuffer (passthrough) + signature gate (accept) ---
jest.mock('../js/utils', () => ({
    normalizeToArrayBuffer: jest.fn((x: any) => x instanceof ArrayBuffer ? x.slice(0) : x),
    validateAudioSignature: jest.fn(() => null),
}));

// --- Mock document (for updateControlsLock etc.) ---
const mockDoc = {
    getElementById: jest.fn().mockReturnValue(null),
    createElement: jest.fn().mockReturnValue({} as any),
};
(global as any).document = mockDoc;

// --- Mock window.fileSystem ---
const mockFileSystem = {
    readFile: jest.fn().mockResolvedValue(new ArrayBuffer(1024)),
};
Object.defineProperty(global, 'window', {
    value: { fileSystem: mockFileSystem },
    writable: true,
    configurable: true,
});

// ============================================================
// I M P O R T S
// ============================================================
import { state } from '../js/state';
import {
    setPlaybackMode,
    getPlaybackMode,
    setLoopMode,
    getLoopMode,
    toggleAutoMix,
    setAutoMixEnabled,
    getMasterBPMRef,
    loadTrack,
    playTrack,
    pauseTrack,
    stopPlayback,
} from '../js/player';

describe('Player — sync exports (pure logic, no DOM required)', () => {
    beforeEach(() => {
        // Reset state to defaults before each test
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
        });
        jest.clearAllMocks();
    });

    // --- Playback mode ---
    test('setPlaybackMode updates playbackMode in state', () => {
        expect(getPlaybackMode()).toBe('continuous');
        setPlaybackMode('single');
        expect(getPlaybackMode()).toBe('single');
    });

    test('getPlaybackMode returns current mode', () => {
        expect(getPlaybackMode()).toBe('continuous');
        setPlaybackMode('single');
        expect(getPlaybackMode()).toBe('single');
        setPlaybackMode('continuous');
        expect(getPlaybackMode()).toBe('continuous');
    });

    // --- Loop mode ---
    test('setLoopMode updates loopMode and sets audio.loop', () => {
        expect(getLoopMode()).toBe('off');
        expect(mockMainAudio.loop).toBe(false);

        setLoopMode('one');
        expect(getLoopMode()).toBe('one');
        expect(mockMainAudio.loop).toBe(true);

        setLoopMode('all');
        expect(getLoopMode()).toBe('all');
        expect(mockMainAudio.loop).toBe(false);
    });

    test('getLoopMode returns current mode', () => {
        expect(getLoopMode()).toBe('off');
        setLoopMode('one');
        expect(getLoopMode()).toBe('one');
    });

    // --- AutoMix ---
    test('toggleAutoMix toggles isAutoMixEnabled', () => {
        expect(state.isAutoMixEnabled).toBe(false);
        toggleAutoMix();
        expect(state.isAutoMixEnabled).toBe(true);
        toggleAutoMix();
        expect(state.isAutoMixEnabled).toBe(false);
    });

    test('setAutoMixEnabled sets the value correctly', () => {
        setAutoMixEnabled(true);
        expect(state.isAutoMixEnabled).toBe(true);
        setAutoMixEnabled(false);
        expect(state.isAutoMixEnabled).toBe(false);
    });

    test('setAutoMixEnabled(true) disables loop-one if active', () => {
        state.update({ loopMode: 'one' });
        setAutoMixEnabled(true);
        expect(state.isAutoMixEnabled).toBe(true);
        expect(state.loopMode).toBe('off');
    });

    test('setAutoMixEnabled(true) preserves loop-one if autoMix already false', () => {
        // loop-one without autoMix should stay
        state.update({ loopMode: 'one', isAutoMixEnabled: false });
        setAutoMixEnabled(false);
        expect(state.loopMode).toBe('one'); // unchanged
    });

    test('setAutoMixEnabled(false) does not change loopMode', () => {
        state.update({ loopMode: 'all' });
        setAutoMixEnabled(false);
        expect(state.loopMode).toBe('all');
    });

    // --- Master BPM ref ---
    test('getMasterBPMRef returns object with getter/setter', () => {
        const ref = getMasterBPMRef();
        expect(ref.value).toBe(0);

        ref.value = 140;
        expect(state.masterBPM).toBe(140);
        expect(ref.value).toBe(140);

        ref.value = 0;
        expect(ref.value).toBe(0);
    });
});

describe('Player — guarded functions (no DOM, no crash)', () => {
    beforeEach(() => {
        state.update({
            isPlaying: false,
            currentTrackIndex: 0,
            isCrossfadeInProgress: false,
            playlist: [
                { id: '1', name: 'Track One', path: '/path/to/one.mp3', duration: 120, bpm: 128 },
                { id: '2', name: 'Track Two', path: '/path/to/two.mp3', duration: 90, bpm: 0 },
            ],
            selectedIndices: [],
        });
        jest.clearAllMocks();
    });

    // --- playTrack guards ---
    test('playTrack does nothing during crossfade', () => {
        state.update({ isCrossfadeInProgress: true });
        playTrack();
        expect(mockMainAudio.play).not.toHaveBeenCalled();
    });

    test('playTrack does nothing with empty playlist', () => {
        state.update({ playlist: [] });
        playTrack();
        expect(mockMainAudio.play).not.toHaveBeenCalled();
    });

    test('playTrack calls audio.play when conditions allow', async () => {
        playTrack();
        // play() chains after the resume attempt — flush the microtask queue.
        await new Promise((r) => setTimeout(r, 0));
        expect(mockMainAudio.play).toHaveBeenCalledTimes(1);
    });

    test('playTrack updates isPlaying on success', async () => {
        mockMainAudio.play.mockResolvedValueOnce(undefined);
        playTrack();
        // Allow promise microtask to resolve
        await new Promise((r) => setTimeout(r, 0));
        expect(state.isPlaying).toBe(true);
    });

    // --- pauseTrack guards ---
    test('pauseTrack does nothing during crossfade', () => {
        state.update({ isCrossfadeInProgress: true });
        pauseTrack();
        expect(mockMainAudio.pause).not.toHaveBeenCalled();
    });

    test('pauseTrack pauses audio and sets isPlaying false', () => {
        state.update({ isPlaying: true });
        pauseTrack();
        expect(mockMainAudio.pause).toHaveBeenCalledTimes(1);
        expect(state.isPlaying).toBe(false);
    });

    // --- stopPlayback ---
    test('stopPlayback resets both channels and state', () => {
        state.update({ isPlaying: true, isCrossfadeInProgress: true });
        stopPlayback();
        expect(mockMainAudio.pause).toHaveBeenCalled();
        expect(mockMainAudio.currentTime).toBe(0);
        expect(mockCrossfadeAudio.pause).toHaveBeenCalled();
        expect(mockCrossfadeAudio.src).toBe('');
        expect(state.isPlaying).toBe(false);
        expect(state.isCrossfadeInProgress).toBe(false);
    });

    // --- loadTrack guards ---
    test('loadTrack does nothing with empty playlist', async () => {
        state.update({ playlist: [] });
        await loadTrack(0);
        expect(mockEngine.main.reset).not.toHaveBeenCalled();
    });

    test('loadTrack does nothing with negative index', async () => {
        await loadTrack(-1);
        expect(mockEngine.main.reset).not.toHaveBeenCalled();
    });

    test('loadTrack does nothing with out-of-range index', async () => {
        await loadTrack(99);
        expect(mockEngine.main.reset).not.toHaveBeenCalled();
    });

    test('loadTrack resets engine and loads track for valid index', async () => {
        // Mock file read to return some data
        mockFileSystem.readFile.mockResolvedValueOnce(new ArrayBuffer(1024));
        const mockDecodedBuffer = {
            numberOfChannels: 2,
            sampleRate: 44100,
            length: 44100,
            duration: 1,
            getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
        };
        mockAudioCtx.decodeAudioData.mockResolvedValueOnce(mockDecodedBuffer);

        await loadTrack(0);

        expect(mockEngine.main.reset).toHaveBeenCalledTimes(1);
        expect(mockEngine.main.loadAsync).toHaveBeenCalled();
        expect(state.currentTrackIndex).toBe(0);
    });
});
