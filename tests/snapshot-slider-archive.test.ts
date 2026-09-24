/**
 * P3-H NEW tests (do not edit existing suites):
 * - Gate-3: restoreSnapshot partial failure must not mutate volume/tempo
 *   sliders and must restore padWaveforms.
 * - Archive cap: _archive_ keys bounded (keep 3) + 14d expiry enforced.
 */

jest.mock('../js/sampler', () => ({
    padBuffers: [] as any[],
    padPaths: [] as string[],
    padVolumes: [] as number[],
    padBPMs: [] as number[],
    padSyncState: [] as boolean[],
    padLoopStart: [] as number[],
    padLoopEnd: [] as number[],
    padWaveforms: [] as any[],
    loadSampleFromPath: jest.fn(),
    renderWaveform: jest.fn(),
}));
jest.mock('../js/player', () => ({
    abortCrossfade: jest.fn(),
}));
jest.mock('../js/audio-engine', () => ({
    engine: {
        main: { audio: { pause: jest.fn(), removeAttribute: jest.fn(), load: jest.fn(), src: '' } },
        crossfade: { audio: { pause: jest.fn(), removeAttribute: jest.fn(), load: jest.fn(), src: '' } },
    },
}));
jest.mock('../js/playlist', () => ({
    renderPlaylist: jest.fn(),
}));
jest.mock('../js/toast', () => ({
    toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../js/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { state } from '../js/state';
import { restoreSnapshot, getLatestSnapshot, pruneSnapshotArchives } from '../js/crash-recovery';
import {
    padBuffers, padPaths, padVolumes, padWaveforms, padBPMs, padSyncState,
    padLoopStart, padLoopEnd, loadSampleFromPath,
} from '../js/sampler';

const STORAGE_KEY = 'ug_crash_snapshot';
let store: Map<string, string>;

function makeLocalStorage(): void {
    (global as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
    };
}

function makeSliders(vol: string, tempo: string): { volEl: any; tempoEl: any } {
    const volEl: any = { value: vol, dispatchEvent: jest.fn() };
    const tempoEl: any = { value: tempo, dispatchEvent: jest.fn() };
    const grid: any = { children: [] as any[] };
    (global as any).document = {
        getElementById: jest.fn((id: string) => {
            if (id === 'masterVol') return volEl;
            if (id === 'tempoSlider') return tempoEl;
            if (id === 'padGrid') return grid;
            return null;
        }),
    };
    return { volEl, tempoEl };
}

function seedLiveKitWithWaveform(): { liveBuf: object; liveWf: object } {
    const liveBuf = { fake: 'live-buffer' };
    const liveWf = { peaks: [1, 2, 3] };
    (padBuffers as any[]).length = 0;
    (padPaths as string[]).length = 0;
    (padBuffers as any[])[0] = liveBuf;
    (padPaths as string[])[0] = '/live/kit.wav';
    (padVolumes as number[])[0] = 0.6;
    (padWaveforms as any[])[0] = liveWf;
    (padBPMs as number[])[0] = 100;
    (padSyncState as boolean[])[0] = true;
    (padLoopStart as number[])[0] = -1;
    (padLoopEnd as number[])[0] = -1;
    state.update({
        isPlaying: false,
        currentTrackIndex: 0,
        masterBPM: 128,
        playlist: [{ id: 'live1', name: 'Live Track', path: '/live/a.mp3', duration: 180, bpm: 128 }],
        selectedIndices: [],
        isCrossfadeInProgress: false,
        blendingIndex: -1,
    });
    return { liveBuf, liveWf };
}

function seedFailingSnapshot(): void {
    const snap = {
        version: 1,
        timestamp: Date.now(),
        playlist: [{ id: 'snap1', name: 'Snapshot Track', path: '/snap/a.mp3', duration: 200, bpm: 120 }],
        currentTrackIndex: 0,
        masterBPM: 120,
        pads: { 0: { path: '/missing/gone.wav', vol: 0.8, bpm: 128, sync: true } },
        ui: {
            masterVolume: 0.1,
            tempoValue: 1.4,
            loopMode: 'off',
            playbackMode: 'continuous',
            isAutoMixEnabled: false,
            isPlaying: false,
        },
    };
    store.set(STORAGE_KEY, JSON.stringify(snap));
}

beforeEach(() => {
    jest.clearAllMocks();
    store = new Map<string, string>();
    makeLocalStorage();
    (loadSampleFromPath as jest.Mock).mockRejectedValue(new Error('ENOENT: missing file'));
});

describe('P3-H slider + waveform rollback', () => {
    test('partial failure restores slider positions (not snapshot values)', async () => {
        const { volEl, tempoEl } = makeSliders('0.9', '1.2');
        seedLiveKitWithWaveform();
        seedFailingSnapshot();
        const ok = await restoreSnapshot();
        expect(ok).toBe(false);
        // Live slider positions preserved — snapshot (0.1 / 1.4) never actuated.
        expect(volEl.value).toBe('0.9');
        expect(tempoEl.value).toBe('1.2');
    });

    test('partial failure restores padWaveforms (not empty)', async () => {
        makeSliders('0.9', '1.2');
        const { liveBuf, liveWf } = seedLiveKitWithWaveform();
        seedFailingSnapshot();
        await restoreSnapshot();
        expect((padBuffers as any[])[0]).toBe(liveBuf);
        expect((padWaveforms as any[])[0]).toBe(liveWf);
        expect(padPaths[0]).toBe('/live/kit.wav');
    });
});

describe('P3-H archive cap + expiry', () => {
    test('archives capped at 3 (oldest purged)', async () => {
        makeSliders('0.9', '1.2');
        seedLiveKitWithWaveform();
        seedFailingSnapshot();
        // Five consecutive failed restores => five archive attempts.
        for (let i = 0; i < 5; i++) {
            store.set(STORAGE_KEY, store.get(STORAGE_KEY)!);
            await restoreSnapshot();
            await new Promise((r) => setTimeout(r, 2));
        }
        const archiveKeys = [...store.keys()].filter((k) => k.startsWith(`${STORAGE_KEY}_archive_`));
        expect(archiveKeys.length).toBeLessThanOrEqual(3);
    });

    test('expired archives (>14d) are purged', () => {
        const oldTs = Date.now() - 15 * 24 * 60 * 60 * 1000;
        const oldKey = `${STORAGE_KEY}_archive_${oldTs}`;
        store.set(oldKey, '{"version":1}');
        store.set(`${STORAGE_KEY}_archive_index`, JSON.stringify([oldKey]));
        pruneSnapshotArchives(Date.now());
        expect(store.has(oldKey)).toBe(false);
    });

    test('newer staging snapshot wins over older live slot', () => {
        const base = {
            version: 1,
            playlist: [],
            currentTrackIndex: -1,
            masterBPM: 0,
            pads: {},
            ui: { masterVolume: 1, tempoValue: 1, loopMode: 'off', playbackMode: 'continuous', isAutoMixEnabled: false, isPlaying: false },
        };
        store.set(STORAGE_KEY, JSON.stringify({ ...base, timestamp: Date.now() - 1000, reason: 'live' }));
        store.set(`${STORAGE_KEY}_staging`, JSON.stringify({ ...base, timestamp: Date.now(), reason: 'staging' }));
        expect(getLatestSnapshot()?.reason).toBe('staging');
    });

    test('expired live snapshot returns null', () => {
        const snap = {
            version: 1,
            timestamp: Date.now() - 15 * 24 * 60 * 60 * 1000,
            playlist: [],
            currentTrackIndex: -1,
            masterBPM: 0,
            pads: {},
            ui: { masterVolume: 1, tempoValue: 1, loopMode: 'off', playbackMode: 'continuous', isAutoMixEnabled: false, isPlaying: false },
        };
        store.set(STORAGE_KEY, JSON.stringify(snap));
        expect(getLatestSnapshot()).toBeNull();
    });
});
