class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onmessageerror: ((event: any) => void) | null = null;
    terminate = jest.fn();

    constructor(public url: string) {
        FakeWorker.instances.push(this);
    }

    postMessage(): void {}
}

function fakeAudioBuffer(): AudioBuffer {
    return {
        sampleRate: 44100,
        numberOfChannels: 1,
        length: 44100,
        getChannelData: () => new Float32Array(44100),
    } as unknown as AudioBuffer;
}

describe('worker client recycling', () => {
    beforeEach(() => {
        FakeWorker.instances.length = 0;
        (global as any).Worker = FakeWorker;
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (global as any).Worker;
    });

    test('timeout terminates the hung worker and the next request gets a fresh instance', async () => {
        const { detectBPMWithConfidence } = require('../js/worker-client') as typeof import('../js/worker-client');
        const first = detectBPMWithConfidence(fakeAudioBuffer());
        const firstExpectation = expect(first).rejects.toThrow('timed out');
        jest.advanceTimersByTime(30000);
        await firstExpectation;
        expect(FakeWorker.instances).toHaveLength(1);
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);

        const second = detectBPMWithConfidence(fakeAudioBuffer());
        const secondExpectation = expect(second).rejects.toThrow('timed out');
        expect(FakeWorker.instances).toHaveLength(2);
        jest.advanceTimersByTime(30000);
        await secondExpectation;
    });
});
