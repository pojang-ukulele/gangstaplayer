/**
 * Unit tests for Audio Engine module (js/audio-engine.ts)
 *
 * AudioChannel and AudioEngine depend on Web Audio API constructs
 * (AudioContext, GainNode, BiquadFilterNode, etc.) and the Audio()
 * constructor. We mock all browser APIs and test construction, guards,
 * and channel swapping logic.
 */

// ============================================================
// M O C K S   (must be before the import)
// ============================================================

// --- Mock global Audio constructor (not available in Node) ---
const mockAudioElement = {
    crossOrigin: '',
    src: '',
    loop: false,
    playbackRate: 1,
    currentTime: 0,
    duration: 100,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    load: jest.fn(),
};
(global as any).Audio = jest.fn(() => ({ ...mockAudioElement }));

function makeMockAudioParam(initialValue = 0) {
    return {
        value: initialValue,
        cancelScheduledValues: jest.fn(),
        setValueAtTime: jest.fn(),
        linearRampToValueAtTime: jest.fn(),
        exponentialRampToValueAtTime: jest.fn(),
    };
}

function makeMockAudioNode() {
    return {
        connect: jest.fn().mockReturnThis(),
        disconnect: jest.fn(),
        gain: makeMockAudioParam(),
        frequency: makeMockAudioParam(20000),
        type: 'lowshelf',
        Q: { value: 0.5 },
    };
}

const mockAudioCtx = {
    currentTime: 0,
    createGain: jest.fn(() => makeMockAudioNode()),
    createBiquadFilter: jest.fn(() => makeMockAudioNode()),
    createMediaElementSource: jest.fn(() => makeMockAudioNode()),
};

jest.mock('../js/audio', () => ({
    audioCtx: mockAudioCtx,
    masterGain: { gain: { value: 1 }, connect: jest.fn() },
    analyser: { getByteFrequencyData: jest.fn(), fftSize: 256 },
    resumeAudioContext: jest.fn().mockResolvedValue(undefined),
    initWorklets: jest.fn(),
    ensureAudio: jest.fn(() => true),
}));

// ============================================================
// I M P O R T S
// ============================================================
import { AudioChannel } from '../js/audio-engine';
import { engine } from '../js/audio-engine';

describe('AudioChannel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('constructs and sets up signal chain', () => {
        const channel = new AudioChannel();
        expect(channel.audio).toBeTruthy();
        expect(channel.audio.crossOrigin).toBe('anonymous');
        expect(channel.gain).not.toBeNull();
        expect(channel.lowEQ).not.toBeNull();
        expect(channel.midEQ).not.toBeNull();
        expect(channel.highEQ).not.toBeNull();
        expect(channel.lpFilter).not.toBeNull();
        expect(channel.hpFilter).not.toBeNull();
        expect(channel.source).not.toBeNull();

        // Verify signal chain: source -> lowEQ -> midEQ -> highEQ -> lpFilter -> hpFilter -> gain
        expect(channel.source!.connect).toHaveBeenCalledWith(channel.lowEQ);
        expect(channel.lowEQ!.connect).toHaveBeenCalledWith(channel.midEQ);
        expect(channel.midEQ!.connect).toHaveBeenCalledWith(channel.highEQ);
        expect(channel.highEQ!.connect).toHaveBeenCalledWith(channel.lpFilter);
        expect(channel.lpFilter!.connect).toHaveBeenCalledWith(channel.hpFilter);
        expect(channel.hpFilter!.connect).toHaveBeenCalledWith(channel.gain);
        expect(channel.gain!.connect).toHaveBeenCalled();
    });

    test('configures EQ filter types and frequencies', () => {
        const channel = new AudioChannel();
        expect(channel.lowEQ!.type).toBe('lowshelf');
        expect(channel.lowEQ!.frequency.value).toBe(320);
        expect(channel.midEQ!.type).toBe('peaking');
        expect(channel.midEQ!.frequency.value).toBe(1000);
        expect(channel.midEQ!.Q.value).toBe(0.5);
        expect(channel.highEQ!.type).toBe('highshelf');
        expect(channel.highEQ!.frequency.value).toBe(3200);
        expect(channel.lpFilter!.type).toBe('lowpass');
        expect(channel.lpFilter!.frequency.value).toBe(20000);
        expect(channel.hpFilter!.type).toBe('highpass');
        expect(channel.hpFilter!.frequency.value).toBe(30);
    });

    test('isWorkletReady returns false initially', () => {
        const channel = new AudioChannel();
        expect(channel.isWorkletReady).toBe(false);
    });

    test('initWorklet does not re-inject if already connected', () => {
        const channel = new AudioChannel();
        // First call attempts injection
        channel.initWorklet();
        // Force private state (normally set on successful worklet creation)
        (channel as any)._isWorkletConnected = true;
        const hpFilterDisconnect = channel.hpFilter!.disconnect;
        hpFilterDisconnect.mockClear();

        // Second call — should bail early
        channel.initWorklet();
        expect(hpFilterDisconnect).not.toHaveBeenCalled();
    });

    test('load sets audio src', () => {
        const channel = new AudioChannel();
        channel.load('http://example.com/track.mp3');
        expect(channel.audio.src).toBe('http://example.com/track.mp3');
    });

    test('reset cancels scheduled values and resets to defaults', () => {
        const channel = new AudioChannel();
        const now = mockAudioCtx.currentTime;

        channel.reset();

        // Gain resets
        expect(channel.gain!.gain.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.gain!.gain.setValueAtTime).toHaveBeenCalledWith(1, now);

        // EQ gains reset to 0
        expect(channel.lowEQ!.gain.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.lowEQ!.gain.setValueAtTime).toHaveBeenCalledWith(0, now);
        expect(channel.midEQ!.gain.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.midEQ!.gain.setValueAtTime).toHaveBeenCalledWith(0, now);
        expect(channel.highEQ!.gain.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.highEQ!.gain.setValueAtTime).toHaveBeenCalledWith(0, now);

        // Filter frequency resets
        expect(channel.lpFilter!.frequency.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.lpFilter!.frequency.setValueAtTime).toHaveBeenCalledWith(20000, now);
        expect(channel.hpFilter!.frequency.cancelScheduledValues).toHaveBeenCalledWith(now);
        expect(channel.hpFilter!.frequency.setValueAtTime).toHaveBeenCalledWith(30, now);
    });
});

describe('AudioEngine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('engine singleton has main and crossfade channels', () => {
        expect(engine.main).toBeInstanceOf(AudioChannel);
        expect(engine.crossfade).toBeInstanceOf(AudioChannel);
    });

    test('crossfade channel starts at zero gain', () => {
        expect(engine.crossfade.gain!.gain.value).toBe(0);
    });

    test('swapChannels swaps main and crossfade references', () => {
        const originalMain = engine.main;
        const originalCrossfade = engine.crossfade;

        engine.swapChannels();

        expect(engine.main).toBe(originalCrossfade);
        expect(engine.crossfade).toBe(originalMain);
    });

    test('swapChannels pauses crossfade (now old main) and clears src', () => {
        const originalMain = engine.main;
        const pauseSpy = jest.spyOn(originalMain.audio, 'pause');
        // src is a plain property on the mock, so we check it after swap instead of spying

        engine.swapChannels();

        // After swap, crossfade = old main, which should be paused and cleared
        expect(pauseSpy).toHaveBeenCalled();
        expect(engine.crossfade.audio.src).toBe('');
    });

    test('initWorklets calls initWorklet on both channels', async () => {
        jest.spyOn(engine.main, 'initWorklet');
        jest.spyOn(engine.crossfade, 'initWorklet');

        await engine.initWorklets(1);

        expect(engine.main.initWorklet).toHaveBeenCalled();
        expect(engine.crossfade.initWorklet).toHaveBeenCalled();
    });

    test('initWorklets retries up to specified count', async () => {
        // Reset _isWorkletConnected so it retries each time
        (engine.main as any)._isWorkletConnected = false;
        (engine.crossfade as any)._isWorkletConnected = false;
        jest.spyOn(engine.main, 'initWorklet');
        jest.spyOn(engine.crossfade, 'initWorklet');

        await engine.initWorklets(3);

        expect(engine.main.initWorklet).toHaveBeenCalledTimes(3);
        expect(engine.crossfade.initWorklet).toHaveBeenCalledTimes(3);
    });

    test('initWorklets stops early when worklet is ready', async () => {
        (engine.main as any)._isWorkletConnected = false;
        (engine.crossfade as any)._isWorkletConnected = true;
        let callCount = 0;
        jest.spyOn(engine.main, 'initWorklet').mockImplementation(function (this: any) {
            callCount++;
            if (callCount >= 2) {
                this._isWorkletConnected = true;
            }
        });

        await engine.initWorklets(5);

        expect(callCount).toBe(2);
    });
});
