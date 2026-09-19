/**
 * Unit tests for playlist selection / removal / reorder / filter-index logic
 * (js/playlist.ts) — the H14/C18 bug class: stale indices promoting or
 * deleting the wrong track.
 *
 * Strategy: real ReactiveStore state, mocked engine/player/DOM-adjacent
 * modules. Module-private filter/nav state is driven via the durable
 * __playlistTestHooks affordance (no DOM gestures needed). Runs in the
 * default node environment — DOM-touching paths are try/caught in prod,
 * and KeyboardEvents are plain stub objects.
 */

import { state, Track } from '../js/state';

// ============================================================
// M O C K S   (hoisted before the import)
// ============================================================

jest.mock('../js/audio', () => ({
    audioCtx: null,
    ensureAudio: jest.fn(() => true),
}));

jest.mock('../js/worker-client', () => ({
    detectBPMResilient: jest.fn(),
    resolveBpmPersist: jest.fn(),
}));

jest.mock('../js/decoded-cache', () => ({
    getDecoded: jest.fn(),
    storeDecoded: jest.fn(),
    evictDecoded: jest.fn(),
    clearDecoded: jest.fn(),
}));

jest.mock('../js/pcm-disk-cache', () => ({
    keyFor: jest.fn(),
    getDiskAudio: jest.fn(async () => null),
    putDiskAudio: jest.fn(async () => false),
}));

function makeMockAudio() {
    return {
        pause: jest.fn(),
        removeAttribute: jest.fn(),
        load: jest.fn(),
        src: '',
    };
}
const mockMainAudio = makeMockAudio();
const mockCrossAudio = makeMockAudio();
jest.mock('../js/audio-engine', () => ({
    engine: {
        main: { audio: mockMainAudio },
        crossfade: { audio: mockCrossAudio },
    },
}));

const mockAbortCrossfade = jest.fn();
jest.mock('../js/player', () => ({
    abortCrossfade: mockAbortCrossfade,
    cacheDroppedAudio: jest.fn(),
    getDroppedAudioFile: jest.fn(),
    readAudioBytesForPath: jest.fn(async () => null),
}));

const mockShowConfirm = jest.fn();
jest.mock('../js/modals', () => ({
    showConfirm: mockShowConfirm,
}));

const mockToast = { info: jest.fn(), error: jest.fn(), success: jest.fn() };
jest.mock('../js/toast', () => ({ toast: mockToast }));

jest.mock('../js/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../js/reactive/ui', () => ({
    VirtualScroller: class {
        destroy(): void { /* ignore */ }
        refresh(): void { /* ignore */ }
        scrollTo(): void { /* ignore */ }
    },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const playlist = require('../js/playlist');
const {
    removeSelectedTracks,
    handlePlaylistNavigation,
    reorderPlaylist,
    selectAllTracks,
    clearPlaylist,
    focusPlayingTrack,
    __playlistTestHooks,
} = playlist;

// ============================================================
// H E L P E R S
// ============================================================

function makeTrack(id: string, name?: string): Track {
    return { id, name: name ?? `Track ${id}`, path: `/music/${id}.mp3`, duration: 200, bpm: 120 };
}

function setLibrary(ids: string[]): Track[] {
    const tracks = ids.map((id) => makeTrack(id));
    state.update({
        playlist: tracks,
        selectedIndices: [],
        currentTrackIndex: -1,
        isPlaying: false,
        isCrossfadeInProgress: false,
        blendingIndex: -1,
        masterBPM: 0,
    });
    return tracks;
}

function key(keyName: string, extra: Record<string, boolean> = {}): KeyboardEvent {
    return {
        key: keyName,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: jest.fn(),
        ...extra,
    } as unknown as KeyboardEvent;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockMainAudio.src = '';
    mockCrossAudio.src = '';
    setLibrary([]);
    __playlistTestHooks.resetNav();
    __playlistTestHooks.setFilter(null);
});

// ============================================================
// removeSelectedTracks
// ============================================================

describe('removeSelectedTracks', () => {
    test('no-op on empty selection', () => {
        setLibrary(['a', 'b']);
        removeSelectedTracks();
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'b']);
        expect(mockAbortCrossfade).not.toHaveBeenCalled();
    });

    test('removes descending and clears selection', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        state.update({ selectedIndices: [1, 3] });
        removeSelectedTracks();
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'c']);
        expect(state.selectedIndices).toEqual([]);
    });

    test('shifts currentTrackIndex down for removals before it', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        state.update({ selectedIndices: [0, 1], currentTrackIndex: 3 });
        removeSelectedTracks();
        expect(state.playlist.map((t) => t.id)).toEqual(['c', 'd']);
        expect(state.currentTrackIndex).toBe(1);
    });

    test('removing the playing track stops playback and resets', () => {
        setLibrary(['a', 'b', 'c']);
        state.update({ selectedIndices: [1], currentTrackIndex: 1, isPlaying: true, masterBPM: 128 });
        removeSelectedTracks();
        expect(state.currentTrackIndex).toBe(-1);
        expect(state.isPlaying).toBe(false);
        expect(state.masterBPM).toBe(0);
        expect(mockMainAudio.pause).toHaveBeenCalled();
    });

    test('blendingIndex follows removals above it, -1 when removed', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        state.update({ selectedIndices: [0], blendingIndex: 2 });
        removeSelectedTracks();
        expect(state.blendingIndex).toBe(1);
        // Now remove the blend target itself
        state.update({ selectedIndices: [1] });
        removeSelectedTracks();
        expect(state.blendingIndex).toBe(-1);
    });

    test('stale/OOB indices are filtered, survivors kept', () => {
        setLibrary(['a', 'b']);
        state.update({ selectedIndices: [99, -1, 0] });
        removeSelectedTracks();
        expect(state.playlist.map((t) => t.id)).toEqual(['b']);
    });

    test('aborts armed crossfade before mutating', () => {
        setLibrary(['a', 'b']);
        state.update({ selectedIndices: [0], isCrossfadeInProgress: true });
        removeSelectedTracks();
        expect(mockAbortCrossfade).toHaveBeenCalled();
        // Flag reset is abortCrossfade's own contract (see
        // crossfade-abort.test.ts) — the mock leaves state untouched.
        expect(state.playlist.map((t) => t.id)).toEqual(['b']);
    });

    test('blocked while filtering', () => {
        const tracks = setLibrary(['a', 'b']);
        state.update({ selectedIndices: [0] });
        __playlistTestHooks.setFilter([tracks[0]]);
        removeSelectedTracks();
        expect(state.playlist).toHaveLength(2);
        expect(mockToast.info).toHaveBeenCalledWith('CLEAR SEARCH BEFORE REMOVING');
    });
});

// ============================================================
// handlePlaylistNavigation
// ============================================================

describe('handlePlaylistNavigation', () => {
    test('no-op when playlist unfocused', () => {
        setLibrary(['a', 'b', 'c']);
        handlePlaylistNavigation(key('ArrowDown'));
        expect(state.selectedIndices).toEqual([]);
    });

    test('arrows move anchor and single-select', () => {
        setLibrary(['a', 'b', 'c']);
        __playlistTestHooks.setFocus(true);
        handlePlaylistNavigation(key('ArrowDown'));
        expect(state.selectedIndices).toEqual([1]);
        handlePlaylistNavigation(key('ArrowDown'));
        expect(state.selectedIndices).toEqual([2]);
        handlePlaylistNavigation(key('ArrowUp'));
        expect(state.selectedIndices).toEqual([1]);
    });

    test('arrows clamp at list bounds', () => {
        setLibrary(['a', 'b']);
        __playlistTestHooks.setFocus(true);
        handlePlaylistNavigation(key('ArrowUp'));
        expect(state.selectedIndices).toEqual([0]);
    });

    test('shift+arrow extends range from pivot', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        __playlistTestHooks.setFocus(true);
        handlePlaylistNavigation(key('ArrowDown'));
        handlePlaylistNavigation(key('ArrowDown', { shiftKey: true }));
        expect(state.selectedIndices).toEqual([1, 2]);
    });

    test('ctrl+A selects everything', () => {
        setLibrary(['a', 'b', 'c']);
        __playlistTestHooks.setFocus(true);
        handlePlaylistNavigation(key('a', { ctrlKey: true }));
        expect(state.selectedIndices).toEqual([0, 1, 2]);
    });

    test('Delete removes the selection', () => {
        setLibrary(['a', 'b', 'c']);
        __playlistTestHooks.setFocus(true);
        handlePlaylistNavigation(key('ArrowDown'));
        handlePlaylistNavigation(key('Delete'));
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'c']);
    });

    test('Delete while filtering is blocked', () => {
        const tracks = setLibrary(['a', 'b']);
        __playlistTestHooks.setFocus(true);
        __playlistTestHooks.setFilter([tracks[0]]);
        handlePlaylistNavigation(key('Delete'));
        expect(state.playlist).toHaveLength(2);
        expect(mockToast.info).toHaveBeenCalledWith('CLEAR SEARCH BEFORE REMOVING');
    });
});

// ============================================================
// reorderPlaylist
// ============================================================

describe('reorderPlaylist', () => {
    test('forward move shifts order, selection and current follow', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        state.update({ selectedIndices: [1], currentTrackIndex: 1 });
        reorderPlaylist(1, 3, false);
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'c', 'b', 'd']);
        expect(state.selectedIndices).toEqual([2]);
        expect(state.currentTrackIndex).toBe(2);
    });

    test('backward move shifts intervening indices right', () => {
        setLibrary(['a', 'b', 'c', 'd']);
        state.update({ selectedIndices: [3], currentTrackIndex: 0 });
        reorderPlaylist(3, 1, false);
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'd', 'b', 'c']);
        expect(state.selectedIndices).toEqual([1]);
        expect(state.currentTrackIndex).toBe(0);
    });

    test('invalid indices are no-ops', () => {
        setLibrary(['a', 'b']);
        reorderPlaylist(-1, 1, false);
        reorderPlaylist(0, 99, false);
        reorderPlaylist(0, 0, false);
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'b']);
    });

    test('aborts armed crossfade first', () => {
        setLibrary(['a', 'b', 'c']);
        state.update({ isCrossfadeInProgress: true });
        reorderPlaylist(0, 2, false);
        expect(mockAbortCrossfade).toHaveBeenCalled();
    });

    test('blocked while filtering', () => {
        const tracks = setLibrary(['a', 'b', 'c']);
        __playlistTestHooks.setFilter([tracks[0]]);
        reorderPlaylist(0, 2, false);
        expect(state.playlist.map((t) => t.id)).toEqual(['a', 'b', 'c']);
        expect(mockToast.info).toHaveBeenCalledWith('CLEAR SEARCH BEFORE REORDERING');
    });
});

// ============================================================
// filter-view (H26) branches
// ============================================================

describe('filter view', () => {
    test('selectAllTracks selects the visible view length', () => {
        const tracks = setLibrary(['a', 'b', 'c', 'd']);
        __playlistTestHooks.setFilter([tracks[0], tracks[2]]);
        selectAllTracks();
        expect(state.selectedIndices).toEqual([0, 1]);
    });

    test('focusPlayingTrack selects the view position by id', () => {
        const tracks = setLibrary(['a', 'b', 'c']);
        state.update({ currentTrackIndex: 2 });
        __playlistTestHooks.setFilter([tracks[1], tracks[2]]);
        focusPlayingTrack();
        expect(state.selectedIndices).toEqual([1]);
    });

    test('focusPlayingTrack warns when playing track hidden by filter', () => {
        const tracks = setLibrary(['a', 'b', 'c']);
        state.update({ currentTrackIndex: 0 });
        __playlistTestHooks.setFilter([tracks[1], tracks[2]]);
        focusPlayingTrack();
        expect(mockToast.info).toHaveBeenCalledWith('PLAYING TRACK HIDDEN BY FILTER');
        expect(state.selectedIndices).toEqual([]);
    });
});

// ============================================================
// clearPlaylist
// ============================================================

describe('clearPlaylist', () => {
    test('clears everything when idle', () => {
        setLibrary(['a', 'b']);
        state.update({ currentTrackIndex: 0 });
        clearPlaylist();
        expect(state.playlist).toEqual([]);
        expect(state.currentTrackIndex).toBe(-1);
        expect(mockShowConfirm).not.toHaveBeenCalled();
    });

    test('asks for confirm while playing, clears on yes', () => {
        setLibrary(['a', 'b']);
        state.update({ isPlaying: true });
        clearPlaylist();
        expect(mockShowConfirm).toHaveBeenCalled();
        const onYes = mockShowConfirm.mock.calls[0][2] as () => void;
        onYes();
        expect(state.playlist).toEqual([]);
        expect(state.isPlaying).toBe(false);
    });

    test('blocked while filtering', () => {
        const tracks = setLibrary(['a', 'b']);
        __playlistTestHooks.setFilter([tracks[0]]);
        clearPlaylist();
        expect(state.playlist).toHaveLength(2);
        expect(mockToast.info).toHaveBeenCalledWith('CLEAR SEARCH BEFORE CLEARING');
    });
});
