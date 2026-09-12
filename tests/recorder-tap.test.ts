/**
 * P0 repro (audit-sweep Phase P0 — FAILING, no prod fix yet).
 *
 * Bug: the recorder tap holds a dead masterGain after ensureAudio() rebuilds
 * the audio chain. retap() refuses mid-take (recorder-client.ts:42-58), and
 * start() (104-136) resolves the tap once per take — a take started on a
 * stale tap keeps capturing from the dead context and stop() still resolves
 * with a silent WAV instead of failing loudly. P2 must surface the dead tap
 * (throw / reject stop() / flag the take) instead of returning silent audio.
 *
 * Bound to the real js/recorder-client.ts (HighFidelityRecorder). js/audio is
 * mocked only for the AudioContext handle (sampleRate/ensureAudio); the
 * retap-refusal + start-tap logic under test is the real implementation.
 */
jest.mock('../js/audio', () => ({
    audioCtx: { sampleRate: 48000, state: 'running' },
    ensureAudio: jest.fn(() => true),
    masterGain: null,
    analyser: null,
    onAudioRebuilt: jest.fn(() => () => { /* unsubscribe */ }),
}));
jest.mock('../js/worker-client', () => ({
    bufferToWaveWorker: jest.fn(async () => new Blob(['fake-wav'], { type: 'audio/wav' })),
}));
jest.mock('../js/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HighFidelityRecorder } from '../js/recorder-client';

type MockPort = {
    onmessage: ((event: { data: { type: string; payload?: Float32Array[] } }) => void) | null;
    postMessage: jest.Mock;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
    _stopHandler: ((event: { data?: { type?: string } }) => void) | null;
};

function makeMockNode(): { connect: jest.Mock; disconnect: jest.Mock; port: MockPort } {
    const port: MockPort = {
        onmessage: null,
        postMessage: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        _stopHandler: null,
    };
    port.addEventListener.mockImplementation((type: string, handler: (e: { data?: { type?: string } }) => void) => {
        if (type === 'message') port._stopHandler = handler;
    });
    port.removeEventListener.mockImplementation(() => { port._stopHandler = null; });
    // Worklet acks STOP asynchronously, like the real processor.
    port.postMessage.mockImplementation((msg: { type?: string }) => {
        if (msg && msg.type === 'STOP') {
            setTimeout(() => { port._stopHandler?.({ data: { type: 'STOPPED' } }); }, 0);
        }
    });
    return { connect: jest.fn(), disconnect: jest.fn(), port: port as unknown as { connect: jest.Mock; disconnect: jest.Mock; port: MockPort }['port'] };
}

describe('recorder tap survives ensureAudio() rebuild (P0 repro — currently FAILS)', () => {
    test('take on dead tap after rebuild fails loudly instead of returning silent WAV', async () => {
        const mockNode = makeMockNode();
        (global as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = jest.fn().mockImplementation(() => mockNode);

        // Fixed tap: goes dead when ensureAudio() rebuilds the master chain
        // (caller should pass a provider; this take holds the stale node).
        const deadTap = { connect: jest.fn(), disconnect: jest.fn() };
        const recorder = new HighFidelityRecorder(deadTap as unknown as AudioNode);

        await recorder.init();
        recorder.start();

        // Simulate ensureAudio() rebuild: live chain has a NEW masterGain,
        // this take still points at the dead one. Mid-take retap is refused
        // (recorder-client.ts:42-44 returns false while accepting).
        const retapped = recorder.retap();
        expect(retapped).toBe(false); // documents current refusal — take stays on dead tap

        // Dead tap pushes one silent quantum (what the stale worklet would deliver).
        mockNode.port.onmessage?.({ data: { type: 'DATA', payload: [new Float32Array(128)] } });

        // BUG: stop() resolves with a silent WAV. It must reject (dead/stale
        // tap, silent capture) instead of handing back recordable-looking audio.
        await expect(recorder.stop()).rejects.toThrow(/tap|dead|stale|rebuild|silent|no data/i);
    }, 10000);
});
