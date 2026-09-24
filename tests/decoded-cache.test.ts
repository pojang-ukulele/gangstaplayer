import { clearDecoded, getDecoded, storeDecoded } from '../js/decoded-cache';

function fakeBuffer(length: number, channels = 2): AudioBuffer {
    return {
        numberOfChannels: channels,
        length,
        sampleRate: 44100,
        duration: length / 44100,
    } as unknown as AudioBuffer;
}

afterEach(() => clearDecoded());

test('a single decoded buffer over the memory cap is not retained', () => {
    storeDecoded('huge', new ArrayBuffer(16), fakeBuffer(30_000_000), 680);
    expect(getDecoded('huge')).toBeUndefined();
});

test('decoded PCM size evicts an older entry even when compressed bytes are small', () => {
    storeDecoded('old', new ArrayBuffer(16), fakeBuffer(13_200_000), 299);
    storeDecoded('new', new ArrayBuffer(16), fakeBuffer(1), 1);
    expect(getDecoded('old')).toBeUndefined();
    expect(getDecoded('new')).toBeDefined();
});
