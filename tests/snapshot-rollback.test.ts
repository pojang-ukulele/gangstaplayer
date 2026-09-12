/**
 * P0 repro (audit-sweep Phase P0 — FAILING, no prod fix yet).
 *
 * Bug: restoreSnapshot() (js/crash-recovery.ts:346-354) clears the LIVE pads
 * first, then swaps the playlist, and only afterwards attempts to reload pad
 * files. When snapshot files are missing (deleted/moved samples), the live
 * kit is already destroyed and the failures just `continue` — partial clobber
 * with no rollback. P2 must stage-then-commit (or roll back) so a restore
 * with missing files preserves the live pads/playlist.
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
import { restoreSnapshot } from '../js/crash-recovery';
import {
    padBuffers, padPaths, padVolumes, padBPMs, padSyncState,
    loadSampleFromPath,
} from '../js/sampler';

const STORAGE_KEY = 'ug_crash_snapshot';
let store: Map<string, string>;

function seedSnapshotWithMissingFiles(): void {
    const snap = {
        version: 1,
        timestamp: Date.now(),
        playlist: [
            { id: 'snap1', name: 'Snapshot Track', path: '/snap/a.mp3', duration: 200, bpm: 120 },
        ],
        currentTrackIndex: 0,
        masterBPM: 120,
        pads: {
            0: { path: '/missing/gone.wav', vol: 0.8, bpm: 128, sync: true },
        },
        ui: {
            masterVolume: 1,
            tempoValue: 1,
            loopMode: 'off',
            playbackMode: 'continuous',
            isAutoMixEnabled: false,
            isPlaying: false,
        },
    };
    store.set(STORAGE_KEY, JSON.stringify(snap));
}

function seedLiveKit(): { liveBuf: object } {
    const liveBuf = { fake: 'live-buffer' };
    (padBuffers as any[]).length = 0;
    (padPaths as string[]).length = 0;
    (padBuffers as any[])[0] = liveBuf;
    (padPaths as string[])[0] = '/live/kit.wav';
    (padVolumes as number[])[0] = 0.6;
    (padBPMs as number[])[0] = 100;
    (padSyncState as boolean[])[0] = true;
    state.update({
        isPlaying: false,
        currentTrackIndex: 0,
        masterBPM: 128,
        playlist: [
            { id: 'live1', name: 'Live Track', path: '/live/a.mp3', duration: 180, bpm: 128 },
        ],
        selectedIndices: [],
        isCrossfadeInProgress: false,
        blendingIndex: -1,
    });
    return { liveBuf };
}

beforeEach(() => {
    jest.clearAllMocks();
    store = new Map<string, string>();
    (global as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
    };
    (global as any).document = { getElementById: jest.fn().mockReturnValue(null) };
    // Every snapshot pad file is gone from disk.
    (loadSampleFromPath as jest.Mock).mockRejectedValue(new Error('ENOENT: missing file'));
    seedSnapshotWithMissingFiles();
});

describe('snapshot rollback on missing files (P0 repro — currently FAILS)', () => {
    test('restore with missing pad file preserves live pads', async () => {
        const { liveBuf } = seedLiveKit();
        const ok = await restoreSnapshot();
        // Preservation-only: restore may report either way on missing files,
        // but the live kit must survive (clobber still fails below).
        expect([true, false]).toContain(ok);
        // BUG (crash-recovery.ts:346-354): live pads cleared before the
        // failing reload, never restored.
        expect(padPaths[0]).toBe('/live/kit.wav');
        expect((padBuffers as any[])[0]).toBe(liveBuf);
    });

    test('restore with missing pad file preserves live playlist/position', async () => {
        seedLiveKit();
        await restoreSnapshot();
        // BUG: playlist already swapped to the snapshot list even though the
        // restore could not complete the kit.
        expect(state.playlist.map((t) => t.id)).toEqual(['live1']);
        expect(state.currentTrackIndex).toBe(0);
        expect(state.masterBPM).toBe(128);
    });
});
