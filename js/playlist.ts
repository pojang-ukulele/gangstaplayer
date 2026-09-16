import { audioCtx, ensureAudio } from './audio';
import { detectBPMWithConfidence, resolveBpmPersist } from './worker-client';
import { state, Track } from './state';
import { VirtualScroller } from './reactive/ui';
import { validateAudioSignature } from './utils';
import { engine } from './audio-engine';
import { abortCrossfade, cacheDroppedAudio, getDroppedAudioFile, readAudioBytesForPath } from './player';
import { showConfirm } from './modals';
import { toast } from './toast';
import { logger } from './logger';
import { MAX_FILE_SIZE_BYTES, MAX_PLAYLIST_SEARCH_RESULTS, NUM_PADS, VALID_AUDIO_EXTENSIONS } from './constants';
import './types';

interface PlaylistDeps {
    loadTrack: (index: number) => Promise<void>;
    playTrack: () => void;
    /** Skip the initial DB load — used when a crash snapshot was just restored */
    skipDbLoad?: boolean;
}

let anchorIndex = -1;
let pivotIndex = -1; // Start of selection range
let draggedIndex = -1;
let isDragging = false;
// Press-drag multi-select gesture state (mouse down + move across rows).
let pressIndex = -1;
let pressWasSelected = false;
let selectDragging = false;
let suppressClick = false;
// Playlist keyboard focus: default UNfocused so arrows/Delete never drive it
// until the user presses inside. Cleared on modal open, restored on close.
let playlistFocused = false;
// Window hook so js/modals.ts can clear/restore focus without a static
// import cycle (playlist -> modals -> playlist).
try {
    const w = window as unknown as {
        __ugSetPlaylistFocused?: (v: boolean) => void;
        __ugGetPlaylistFocused?: () => boolean;
    };
    w.__ugSetPlaylistFocused = (v: boolean) => { playlistFocused = !!v; };
    w.__ugGetPlaylistFocused = () => playlistFocused;
} catch { /* non-browser boot — hook unavailable */ }

let playlistEl: HTMLElement | null = null;
let playlistInput: HTMLInputElement | null = null;
let contextMenu: HTMLElement | null = null;

let loadTrackFn: ((index: number) => Promise<void>) | null = null;
let playTrackFn: (() => void) | null = null;
let _uiLoadGen = 0;
let vScroller: VirtualScroller<Track> | null = null;
let _playlistUnsubs: (() => void)[] | null = null;
// M17: separate generations — DB-load and search must not share a counter.
// The old alias (_dbLoadGen = searchGen) let a stale search resolve clobber
// the initial list and vice versa.
let _dbLoadGen = 0;
let _searchGen = 0;
let _isFiltering = false;
let _focusWired = false;
// H26: filtered search shows a view over the stable playing list.
// state.playlist is never swapped by the filter — the scroller renders
// _filteredView while currentTrackIndex keeps pointing into the full list.
let _filteredView: Track[] | null = null;
let _filterQuery = '';
const ITEM_HEIGHT = 26; // Pixels — compact single-line row

let _playlistInit = false;
export function initPlaylist(deps: PlaylistDeps): void {
    if (_playlistInit) {
        loadTrackFn = deps.loadTrack;
        playTrackFn = deps.playTrack;
        if (vScroller) { try { vScroller.destroy(); } catch { /* ignore */ } vScroller = null; }
    }
    _playlistInit = true;
    loadTrackFn = deps.loadTrack;
    playTrackFn = deps.playTrack;
    playlistEl = document.getElementById('playlist');
    playlistInput = document.getElementById('playlistInput') as HTMLInputElement;
    contextMenu = document.getElementById('contextMenu');
    const searchInput = document.getElementById('playlistSearch') as HTMLInputElement;

    // === INITIAL LOAD FROM DB ===
    // Skipped when a crash snapshot was restored, otherwise the async DB read
    // resolves later and clobbers the restored playlist.
    const db = window.database;
    if (db && !deps.skipDbLoad) {
        const loadGen = ++_dbLoadGen;
        db.getAllTracks().then((tracks: Track[]) => {
            if (loadGen !== _dbLoadGen) return; // superseded by newer DB load
            if (_isFiltering) return; // a search view is active — never clobber it
            // Don't clobber tracks the user added while the DB read was in flight.
            if (state.playlist.length > 0) return;
            if (tracks && tracks.length > 0) {
                // Selection indices were computed against the pre-load list
                state.update({ playlist: tracks, selectedIndices: [] });
                anchorIndex = -1;
                pivotIndex = -1;
            }
        }).catch(() => { /* DB failure must not break the playlist UI */ });
    }

    const setFiltering = (v: boolean) => { _isFiltering = v; };

    if (searchInput) {
        let searchDebounce: ReturnType<typeof setTimeout> | null = null;
        searchInput.addEventListener('input', () => {
            // Debounce: every keystroke previously fired an IPC search with
            // last-wins only — rapid typing spawned N concurrent main-thread
            // LIKE scans. 150ms coalesces bursts into one query.
            if (searchDebounce) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                searchDebounce = null;
                void runSearch();
            }, 150);
        });
        const runSearch = async (): Promise<void> => {
            const myGen = ++_searchGen;
            const query = searchInput.value;
            try {
                if (query.length > 0) {
                    // H26: never swap state.playlist for a filter view. The
                    // playing list stays stable; currentTrackIndex keeps
                    // pointing into the full list (no id->filtered remap).
                    const q = query.slice(0, 256);
                    const qLower = q.toLowerCase();
                    setFiltering(true);
                    _filterQuery = qLower;
                    let list: Track[];
                    try {
                        if (db) {
                            const results = await db.searchTracks(q);
                            if (myGen !== _searchGen) return; // stale keystroke, drop
                            list = Array.isArray(results) ? [...results] : [];
                        } else {
                            // No-DB fallback must still filter — previously it
                            // showed the full unfiltered list, ignoring query.
                            if (myGen !== _searchGen) return;
                            list = state.playlist.filter(t => {
                                const name = (t?.name || '').toLowerCase();
                                const p = (t?.path || '').toLowerCase();
                                return name.includes(qLower) || p.includes(qLower);
                            }).map(t => ({ ...t })).slice(0, MAX_PLAYLIST_SEARCH_RESULTS);
                        }
                        if (myGen !== _searchGen) return;
                    } catch {
                        if (myGen !== _searchGen) return;
                        list = [];
                    }
                    if (myGen !== _searchGen) return;
                    // H27: merge in-memory tracks the DB missed (just added
                    // while filtered / not indexed yet) so they are not lost.
                    // Preserve full-list order for the merged tail.
                    const full = state.playlist;
                    const ids = new Set(list.map(t => t?.id));
                    for (const t of full) {
                        if (!t || !t.id || ids.has(t.id)) continue;
                        const name = (t.name || '').toLowerCase();
                        const p = (t.path || '').toLowerCase();
                        if (name.includes(qLower) || p.includes(qLower)) {
                            list.push({ ...t });
                            ids.add(t.id);
                        }
                    }
                    _filteredView = list;
                    // Selection is view-relative; clear it. Do NOT touch
                    // playlist or currentTrackIndex.
                    state.update({ selectedIndices: [] });
                    if (vScroller) vScroller.updateItems([...list]);
                } else {
                    if (myGen !== _searchGen) return;
                    // Clear the view and reveal the untouched full list.
                    // Tracks added while filtered already went to the full
                    // list (H27) — nothing to merge, order preserved.
                    setFiltering(false);
                    _filterQuery = '';
                    _filteredView = null;
                    state.update({ selectedIndices: [] });
                    if (vScroller) vScroller.updateItems(state.playlist);
                }
            } catch {
                return; // DB error must not wipe the visible list
            }
            anchorIndex = -1;
            pivotIndex = -1;
        };
    }

    // === REACTIVE SUBSCRIPTIONS ===
    // Drop previous subscriptions on re-init so one selection change
    // doesn't render N times via leaked closures.
    const refreshSelection = () => {
        if (vScroller) vScroller.refresh(true);
    };
    if (_playlistUnsubs) { _playlistUnsubs.forEach(fn => { try { fn(); } catch { /* ignore */ } }); }
    _playlistUnsubs = [
    state.subscribe('playlist', (playlist) => {
        if (!vScroller) return;
        if (_isFiltering && _filteredView) {
            // H26/H27: full-list writes (adds, BPM analysis) must not clobber
            // the filter view. Propagate fresh fields into visible rows by id
            // and append newly added matches; never swap the playing list.
            const byId = new Map(playlist.map(t => [t.id, t]));
            let dirty = false;
            for (let i = 0; i < _filteredView.length; i++) {
                const fresh = byId.get(_filteredView[i].id);
                if (!fresh) continue;
                const cur = _filteredView[i];
                if (fresh.bpm !== cur.bpm || fresh.duration !== cur.duration ||
                    fresh.name !== cur.name || fresh.path !== cur.path) {
                    _filteredView[i] = { ...fresh };
                    dirty = true;
                }
            }
            if (_filterQuery) {
                const viewIds = new Set(_filteredView.map(t => t.id));
                for (const t of playlist) {
                    if (!t || viewIds.has(t.id)) continue;
                    const name = (t.name || '').toLowerCase();
                    const p = (t.path || '').toLowerCase();
                    if (name.includes(_filterQuery) || p.includes(_filterQuery)) {
                        _filteredView.push({ ...t });
                        viewIds.add(t.id);
                        dirty = true;
                    }
                }
            }
            if (dirty) vScroller.updateItems([..._filteredView]);
            return;
        }
        vScroller.updateItems(playlist);
    }),
    
    state.subscribe('selectedIndices', refreshSelection),
    state.subscribe('currentTrackIndex', refreshSelection),
    state.subscribe('blendingIndex', refreshSelection),
    ];
    
    // Initial vScroller setup (destroy previous on re-init / hot reload)
    if (playlistEl) {
        if (vScroller) { try { vScroller.destroy(); } catch { /* ignore */ } vScroller = null; }
        vScroller = new VirtualScroller({
            container: playlistEl,
            items: state.playlist,
            itemHeight: ITEM_HEIGHT,
            renderItem: (track, index, existing) => renderTrackRow(track, index, existing),
            // Key rows by track id so reorder/filter recycles by identity,
            // not by recycled index.
            keyOf: (track) => (track && track.id) || ''
        });
    }
}

export function setBlendingIndex(index: number): void {
    state.update({ blendingIndex: index });
}

/**
 * Background worker to analyze BPM for a track.
 * Serialized through a bounded queue (max 2 concurrent decodes) — bulk
 * imports previously spawned N parallel decodeAudioData calls and OOM'd.
 */
const _analysisQueue: Track[] = [];
let _analysisActive = 0;
const MAX_CONCURRENT_ANALYSIS = 2;
// In-flight ids (M16): reanalyze-all / bulk re-adds previously queued the
// same track N times and burned N full decodes for one last-writer-wins.
const _analysisIds = new Set<string>();

let _analysisDropToastAt = 0;
function enqueueAnalysis(track: Track): void {
    // Bounded queue — bulk imports previously queued N unbounded decodes.
    if (_analysisQueue.length >= 256) {
        // Requeue instead of a silent bpm:0: the track keeps its analyzing
        // state and retries once the queue drains (stale/dequeued tracks are
        // dropped by the guards). Throttled toast, not a silent mark.
        try {
            const now = Date.now();
            if (now - _analysisDropToastAt > 10000) {
                _analysisDropToastAt = now;
                toast.info('ANALYSIS QUEUE FULL — RETRYING...');
            }
        } catch { /* ignore */ }
        try {
            const retryId = track?.id;
            const t = setTimeout(() => {
                try {
                    if (!retryId) return;
                    if (!state.playlist.some(x => x.id === retryId)) return;
                    if (_analysisIds.has(retryId)) return;
                    enqueueAnalysis(track);
                } catch { /* ignore */ }
            }, 2000);
            (t as unknown as { unref?: () => void })?.unref?.();
        } catch { /* ignore */ }
        return;
    }
    if (!track || !track.id || _analysisIds.has(track.id)) return;
    _analysisIds.add(track.id);
    _analysisQueue.push(track);
    pumpAnalysisQueue();
}

export function clearAnalysisQueue(): void {
    _analysisQueue.length = 0;
    _analysisIds.clear();
}

function pumpAnalysisQueue(): void {
    while (_analysisActive < MAX_CONCURRENT_ANALYSIS && _analysisQueue.length > 0) {
        const next = _analysisQueue.shift();
        if (!next) break;
        _analysisActive++;
        analyzeTrackInBackground(next).finally(() => {
            _analysisIds.delete(next.id);
            _analysisActive--;
            pumpAnalysisQueue();
        });
    }
}

async function analyzeTrackInBackground(track: Track): Promise<void> {
    try {
        const db = window.database;
        
        // 1. Check DB Cache first
        if (db) {
            const cached = await db.getTrack(track.path);
            if (cached && cached.bpm > 0) {
                const idx = state.playlist.findIndex(t => t.id === track.id);
                const next = [...state.playlist];
                if (idx >= 0) next[idx] = { ...next[idx], bpm: cached.bpm, duration: cached.duration };
                state.update({ playlist: next });
                return;
            }
        }

        const rawData = await readAudioBytesForPath(track.path, track.id);
        if (!rawData) {
            console.warn(`[Playlist] Analysis skipped for ${track.name} (File unreadable)`);
            return;
        }


        const arrayBuffer = rawData;
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            return; // oversized drops previously OOMed the renderer
        }
        // Analysis decode bound (M16): decodeAudioData expands compressed
        // audio ~10-30x in RAM, so a near-100MB file can OOM the renderer
        // before BPM ever runs. Playback streams from disk and is unaffected;
        // analysis marks the track unknown instead of crashing the tab.
        if (arrayBuffer.byteLength > 64 * 1024 * 1024) {
            console.warn(`[Playlist] Analysis skipped for ${track.name} (too large to decode safely)`);
            const bigIdx = state.playlist.findIndex(t => t.id === track.id);
            if (bigIdx >= 0) {
                const bigNext = [...state.playlist];
                bigNext[bigIdx] = { ...bigNext[bigIdx], bpm: 0 };
                state.update({ playlist: bigNext });
            }
            return;
        }
        // Drop doomed work: track deleted/cleared while queued.
        if (!state.playlist.some(t => t.id === track.id)) return;

        // Same validation policy as the sampler — reject non-audio early
        // instead of feeding garbage to the decoder.
        const validationError = validateAudioSignature(arrayBuffer, track.name);
        if (validationError) {
            console.warn(`[Playlist] Analysis skipped for ${track.name}: ${validationError}`);
            // P4 deferral (oracle non-blocking): hard-failure bpm:0 writes not
            // yet routed through resolveBpmPersist — keep-prior would leave
            // reanalyzed rows stuck at "analyzing"; uniform-catch is future work.
            const failIdx = state.playlist.findIndex(t => t.id === track.id);
            if (failIdx >= 0) {
                const failNext = [...state.playlist];
                failNext[failIdx] = { ...failNext[failIdx], bpm: 0 };
                state.update({ playlist: failNext });
            }
            return;
        }

        // Use native decoder (decoder pool workers are unreliable).
        // Bounded: a hung decode previously occupied one of the 2 slots
        // forever, halving throughput for the rest of the session.
        // Slice before decode: decodeAudioData neuters its input, and a
        // retry/double-post over the same buffer would see it detached.
        if (!ensureAudio() || !audioCtx) return;
        const audioBuffer = await Promise.race([
            audioCtx.decodeAudioData(arrayBuffer.slice(0)),
            new Promise<never>((_, reject) => {
                const t = setTimeout(() => reject(new Error('decode timeout')), 30000);
                (t as any)?.unref?.();
            }),
        ]);

        const analysis = await detectBPMWithConfidence(audioBuffer);

        // Drop stale work: track cleared/deleted/replaced while decoding.
        // Verify against the live list (id + path) before any write.
        const preIdx = state.playlist.findIndex(t => t.id === track.id);
        if (preIdx < 0) return;
        if (state.playlist[preIdx].path !== track.path) return;

        // Confidence gate: a needs-review result must not persist bpm:0
        // over a good cached value — keep the prior BPM, record only the
        // measured duration, and skip the DB upsert.
        const decision = resolveBpmPersist(analysis, state.playlist[preIdx]?.bpm);
        if (!decision.persisted || decision.bpm === undefined) {
            console.warn(`[Playlist] BPM needs review for ${track.name} — kept prior value`);
            const durIdx = state.playlist.findIndex(t => t.id === track.id);
            if (durIdx >= 0 && state.playlist[durIdx].path === track.path) {
                const durNext = [...state.playlist];
                durNext[durIdx] = { ...durNext[durIdx], duration: audioBuffer.duration };
                state.update({ playlist: durNext });
            }
            return;
        }
        const bpm = decision.bpm;

        // 2. Persist to DB with fresh analysis values
        if (db) {
            await db.upsertTrack({
                id: track.id,
                path: track.path,
                name: track.name,
                duration: audioBuffer.duration,
                bpm
            });
        }

        // Drop stale work: track cleared/deleted/replaced while DB persist
        // was in flight. Re-resolve against the live list instead of pushing
        // a pre-await snapshot.
        const liveIdx = state.playlist.findIndex(t => t.id === track.id);
        if (liveIdx < 0) return;
        if (state.playlist[liveIdx].path !== track.path) return;
        const live = [...state.playlist];
        live[liveIdx] = { ...live[liveIdx], bpm, duration: audioBuffer.duration };
        state.update({ playlist: live });
    } catch (e) {
        console.warn(`[Playlist] BPM analysis skipped for ${track.name}`);
        // P4 deferral (oracle non-blocking): see validation-failure path above —
        // catch-path bpm:0 not routed through resolveBpmPersist (future work).
        const idx = state.playlist.findIndex(t => t.id === track.id);
        if (idx >= 0) {
            const next = [...state.playlist];
            next[idx] = { ...next[idx], bpm: 0 };
            state.update({ playlist: next });
        }
    }
}

export function addTracksToPlaylist(files: File[]): void {
    const basePlaylist = [...state.playlist];
    // Case/separator-normalized dedupe: Windows `C:\MUSIC\A.mp3` vs
    // `c:/music/a.mp3` previously slipped past the raw-string Set as dupes.
    const normPath = (p: string): string => {
        try {
            let k = String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
            if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
            return k.toLowerCase();
        } catch { return String(p ?? '').toLowerCase(); }
    };
    const existingPaths = new Set(basePlaylist.map(t => normPath(t.path)));
    const wasEmpty = basePlaylist.length === 0;
    const added: Track[] = [];
    const uuid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? () => crypto.randomUUID()
        : () => `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const AUDIO_EXTS = new Set<string>(VALID_AUDIO_EXTENSIONS as readonly string[]);
    let rejected = 0;
    let dupes = 0;
    files.forEach((file) => {
        let fullPath = '';
        try {
            fullPath = window.electronAPI.getPathForFile(file);
        } catch { fullPath = ''; }
        if (!fullPath) {
            try { fullPath = (file as unknown as { path?: unknown }).path as string || ''; } catch { fullPath = ''; }
        }
        if (!fullPath) { rejected++; return; }
        if (fullPath.length > 32760) { rejected++; return; }
        const ext = fullPath.split('.').pop()?.toLowerCase() ?? '';
        if (!AUDIO_EXTS.has(ext)) { rejected++; return; }
        if (existingPaths.has(normPath(fullPath))) { dupes++; return; }
        existingPaths.add(normPath(fullPath));
        // Keep the user-gesture File bytes so decode/playback/BPM never need
        // an IPC re-read that fail-closed allowlists would deny. Also register
        // per-file consent so later disk reads (Sonetra, post-restart) pass.
        const track: Track = {
            id: uuid(),
            name: String(file.name).slice(0, 512),
            path: fullPath,
            duration: 0,
            bpm: undefined
        };
        // Keyed by canonical path AND track.id so later lookups hit even
        // when the stored path string differs in case/separators.
        try { cacheDroppedAudio(fullPath, file, track.id); } catch { /* ignore */ }
        try {
            const fsApi = window.fileSystem as unknown as { consentFile?: (p: string) => Promise<boolean> };
            if (fsApi && typeof fsApi.consentFile === 'function') {
                fsApi.consentFile(fullPath).catch(() => undefined);
            }
        } catch { /* consent is best-effort; cached bytes still play */ }
        added.push(track);

        // Instant DB Indexing (metadata comes later via analysis)
        const db = window.database;
        if (db) {
            db.upsertTrack({
                id: track.id,
                path: track.path,
                name: track.name,
                duration: 0,
                bpm: 0
            }).catch(() => { /* indexing is best-effort */ });
        }

        enqueueAnalysis(track);
    });

    // Rebase onto the live list (C16): two rapid adds (dialog + drop,
    // double-drop) used to snapshot the same base and the second overwrote
    // the first. New tracks merge over whatever landed meanwhile.
    const fresh = state.playlist;
    const freshPaths = new Set(fresh.map(t => normPath(t.path)));
    const merged = [...fresh];
    for (const t of added) {
        if (!freshPaths.has(normPath(t.path))) {
            freshPaths.add(normPath(t.path));
            merged.push(t);
        }
    }
    state.update({ playlist: merged });
    if (rejected > 0) { try { toast.info(`${rejected} FILE(S) SKIPPED (UNSUPPORTED TYPE)`); } catch { /* ignore */ } }
    else if (dupes > 0) { try { toast.info(`${dupes} DUPLICATE(S) SKIPPED`); } catch { /* ignore */ } }

    if (wasEmpty && merged.length > 0 && loadTrackFn) {
        const first = merged[0];
        // Resolve by id at fire time — a concurrent add may have shifted
        // positions between the merge and the async consent handshake.
        const firstId = first.id;
        const autoLoad = loadTrackFn;
        // Await per-file consent before the first auto-load so an
        // allowlisted re-read can't silently fail and stall the deck
        // with no toast/error. Cached DnD bytes still play regardless.
        void (async () => {
            try {
                // Bounded consent: a hung main process previously stalled the
                // first-track auto-load forever. 5s cap, then load anyway
                // (cached DnD bytes play regardless of consent).
                const consentCall = typeof window.fileSystem?.consentFile === 'function'
                    ? window.fileSystem.consentFile(first.path)
                    : Promise.resolve(true);
                const consent = await Promise.race([
                    consentCall,
                    new Promise<boolean>((resolve) => {
                        const t = setTimeout(() => resolve(true), 5000);
                        (t as any)?.unref?.();
                    }),
                ]);
                if (consent === false) {
                    logger.warn(`[Playlist] consent denied for auto-load: ${first.path}`);
                }
            } catch (e) {
                logger.warn(`[Playlist] consent check failed for auto-load: ${first.path}`, e);
            }
            try {
                const atFire = state.playlist.findIndex(t => t.id === firstId);
                if (atFire >= 0) await autoLoad(atFire);
            } catch (e) {
                logger.warn(`[Playlist] auto-load failed for ${first.path}`, e);
            }
        })();
        // Auto select first
        state.update({
            selectedIndices: [0]
        });
        anchorIndex = 0;
        pivotIndex = 0;
    }
}

/** Map a visible (possibly filtered) row index to the full-list index by id. */
function viewIndexToFullIndex(viewIdx: number): number {
    if (!_isFiltering || !_filteredView) return viewIdx;
    const t = _filteredView[viewIdx];
    if (!t) return -1;
    return state.playlist.findIndex(x => x.id === t.id);
}

/**
 * Drop a stale context-menu target after any playlist mutation — the stored
 * ctxIndex otherwise points at an unrelated row once rows shift.
 */
function invalidateCtxIndex(): void {
    try {
        const menu = document.getElementById('contextMenu');
        if (!menu || menu.dataset.ctxIndex === undefined) return;
        const idx = parseInt(menu.dataset.ctxIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= state.playlist.length) {
            delete menu.dataset.ctxIndex;
        }
    } catch { /* ignore */ }
}

/**
 * Resolve the context-menu target track: prefers the full-list ctxIndex,
 * falls back to the (possibly filtered) view selection mapped by id so
 * track actions never operate on the wrong row while filtered.
 */
function resolveCtxTrack(): Track | undefined {
    try {
        const target = getContextTargetIndex();
        if (target >= 0 && state.playlist[target]) return state.playlist[target];
        if (_isFiltering && _filteredView && state.selectedIndices.length) {
            const vt = _filteredView[state.selectedIndices[0]];
            if (vt) {
                const full = state.playlist.find(x => x.id === vt.id);
                if (full) return full;
            }
        }
        const first = state.selectedIndices[0];
        if (Number.isInteger(first) && first >= 0) return state.playlist[first];
    } catch { /* ignore */ }
    return undefined;
}

function renderTrackRow(track: Track, index: number, existing?: HTMLElement): HTMLElement {
    const li = (existing || document.createElement('li')) as HTMLElement;
    
    let bpmSuffix = " [...]";  // Still analyzing
    if (track.bpm !== null && track.bpm !== undefined) {
        bpmSuffix = track.bpm > 0 ? ` [${track.bpm}bpm]` : "";  // Detected or silent fail
    }
    
    let blendSuffix = "";
    li.classList.remove('blending', 'selected', 'playing');

    // H26: while filtered, view indices differ from full-list indices —
    // resolve playing/blending by track id, not by filtered position.
    const playingId = state.playlist[state.currentTrackIndex]?.id;
    const blendingId = state.blendingIndex >= 0 ? state.playlist[state.blendingIndex]?.id : undefined;
    const isBlendingRow = _isFiltering
        ? (blendingId !== undefined && track.id === blendingId)
        : (index === state.blendingIndex);
    if (isBlendingRow) {
        blendSuffix = " [MIXING IN...]";
        li.classList.add('blending');
    }

    const fullText = track.name + bpmSuffix + blendSuffix;
    li.title = fullText;
    let titleSpan = li.querySelector('.track-title') as HTMLElement | null;
    if (!titleSpan) {
        titleSpan = document.createElement('span');
        titleSpan.className = 'track-title';
        li.appendChild(titleSpan);
    }
    titleSpan.textContent = fullText;

    if (state.selectedIndices.includes(index)) li.classList.add('selected');
    const isPlayingRow = _isFiltering
        ? (playingId !== undefined && track.id === playingId)
        : (index === state.currentTrackIndex);
    if (isPlayingRow) li.classList.add('playing');
    
    // Only add listeners if it's a new element
    if (!existing) {
        // Press-drag multi-select: plain mousedown selects immediately, moving
        // across rows extends the range from the press point. Dragging a row
        // that was ALREADY selected is a reorder gesture, not a selection one.
        li.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const idx = parseInt(li.dataset.index || "-1");
            if (idx < 0) return;
            playlistFocused = true;
            pressIndex = idx;
            pressWasSelected = state.selectedIndices.includes(idx);
            selectDragging = true;
            suppressClick = false;
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !pressWasSelected) {
                state.update({ selectedIndices: [idx] });
                anchorIndex = idx;
                pivotIndex = idx;
            } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey && pressWasSelected) {
                // Reorder candidate — keep the existing multi-selection intact.
                anchorIndex = idx;
            }
        });

        li.addEventListener('mouseenter', (e) => {
            if (!selectDragging || pressWasSelected) return;
            if (!(e.buttons & 1)) return;
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            const idx = parseInt(li.dataset.index || "-1");
            if (idx < 0 || idx === anchorIndex) return;
            const s = Math.min(pressIndex, idx);
            const e_ = Math.max(pressIndex, idx);
            anchorIndex = idx;
            if (idx !== pressIndex) suppressClick = true;
            state.update({ selectedIndices: Array.from({ length: e_ - s + 1 }, (_, i) => s + i) });
        });

        li.addEventListener('click', (e) => {
            e.stopPropagation();
            // Click after a press-drag would collapse the just-built range.
            if (suppressClick) { suppressClick = false; return; }
            const idx = parseInt(li.dataset.index || "0");
            
            const currentSelected = [...state.selectedIndices];
            if (e.ctrlKey || e.metaKey) {
                const i = currentSelected.indexOf(idx);
                if (i !== -1) currentSelected.splice(i, 1); 
                else currentSelected.push(idx);
                anchorIndex = idx;
                pivotIndex = idx;
                state.update({ selectedIndices: currentSelected });
            } else if (e.shiftKey) {
                if (pivotIndex === -1) pivotIndex = anchorIndex !== -1 ? anchorIndex : idx;
                const s = Math.min(pivotIndex, idx);
                const e_ = Math.max(pivotIndex, idx);
                const range = Array.from({length: e_ - s + 1}, (_, i) => s + i);
                state.update({ selectedIndices: range });
                anchorIndex = idx;
            } else {
                state.update({ selectedIndices: [idx] });
                anchorIndex = idx;
                pivotIndex = idx;
            }
        });

        // Hover marquee: long titles scroll only when clipped
        // (scrollWidth > clientWidth). Resets cleanly on mouseleave.
        li.addEventListener('mouseenter', () => {
            const span = li.querySelector('.track-title') as HTMLElement | null;
            if (!span) return;
            try {
                if (span.scrollWidth > li.clientWidth + 4) span.classList.add('marquee');
                else span.classList.remove('marquee');
            } catch { /* ignore */ }
        });
        li.addEventListener('mouseleave', () => {
            const span = li.querySelector('.track-title') as HTMLElement | null;
            if (span) span.classList.remove('marquee');
        });

        li.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const viewIdx = parseInt(li.dataset.index || "0");
            // H26: filtered rows are positions in the view — resolve to the
            // full-list index by id so the correct track loads.
            const idx = viewIndexToFullIndex(viewIdx);
            if (idx < 0) return;
            // Mid-blend dblclick previously called loadTrack (silently refused)
            // then playTrack() — playing the OLD deck under a new highlight.
            if (state.isCrossfadeInProgress) {
                try { toast.info('MIXING — WAIT FOR BLEND TO FINISH'); } catch { /* ignore */ }
                return;
            }
            if (loadTrackFn) {
                const gen = ++_uiLoadGen;
                loadTrackFn(idx).then(() => {
                    if (gen !== _uiLoadGen) return; // superseded by newer click
                    if (playTrackFn) playTrackFn();
                }).catch(err => console.error(`[Playlist] Load failed for ${idx}:`, err));
            }
        });

        li.draggable = true;

        li.addEventListener('dragstart', (e) => {
            const idx = parseInt(li.dataset.index || "-1");
            if (idx < 0) { e.preventDefault(); return; }
            // Select-drag in progress (press started on an unselected row):
            // cancel the reorder so extending the selection doesn't move tracks.
            if (selectDragging && !pressWasSelected) { e.preventDefault(); return; }
            isDragging = true;
            draggedIndex = idx;
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', idx.toString());
            }
            li.classList.add('dragging');
        });

        li.addEventListener('dragend', () => {
            isDragging = false;
            draggedIndex = -1;
            li.classList.remove('dragging');
            // Clear all drop indicators on every visible item
            if (playlistEl) {
                playlistEl.querySelectorAll('.drop-above, .drop-below').forEach(el => {
                    el.classList.remove('drop-above', 'drop-below');
                });
            }
        });

        li.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!isDragging) return;
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            
            const targetIdx = parseInt(li.dataset.index || "-1");
            if (targetIdx === draggedIndex) return;
            
            // Determine if dropping above or below
            const rect = li.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            
            li.classList.remove('drop-above', 'drop-below');
            if (e.clientY < midY) {
                li.classList.add('drop-above');
            } else {
                li.classList.add('drop-below');
            }
        });

        li.addEventListener('dragleave', () => {
            li.classList.remove('drop-above', 'drop-below');
        });

        li.addEventListener('drop', (e) => {
            // External file drops must bubble to the playlist container handler —
            // stopping them here silently swallows drag-and-drop onto any row
            // (rows cover the whole list, so drops appeared completely broken).
            if (!isDragging || draggedIndex < 0) return;
            e.preventDefault();
            e.stopPropagation();
            
            const targetIdx = parseInt(li.dataset.index || "-1");
            if (targetIdx < 0 || targetIdx === draggedIndex) return;
            
            // Determine insert position (before or after target)
            const rect = li.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertAfter = e.clientY >= midY;
            
            reorderPlaylist(draggedIndex, targetIdx, insertAfter);
            
            // Clean up
            isDragging = false;
            draggedIndex = -1;
            li.classList.remove('drop-above', 'drop-below');
            if (playlistEl) {
                playlistEl.querySelectorAll('.drop-above, .drop-below').forEach(el => {
                    el.classList.remove('drop-above', 'drop-below');
                });
            }
        });

        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            playlistFocused = true;
            const viewIdx = parseInt(li.dataset.index || "0");
            // View-relative selection stays as-is (cleared on filter change);
            // the stored context target is the full-list index by id.
            const fullIdx = viewIndexToFullIndex(viewIdx);
            const ctxIdx = fullIdx >= 0 ? fullIdx : viewIdx;
            if (!state.selectedIndices.includes(viewIdx)) {
                state.update({ selectedIndices: [viewIdx] });
                anchorIndex = viewIdx;
                pivotIndex = viewIdx;
            }
            const menu = document.getElementById('contextMenu');
            if (menu) {
                menu.classList.remove('hidden');
                menu.style.display = 'block';
                // M32: menus stay BELOW modals (modal z-index 3000).
                menu.style.zIndex = '1500';
                hideSamplerSubmenu();
                void buildSamplerSubmenu(ctxIdx);

                // Viewport clamp measured from the live menu (position:fixed +
                // max-height scroll). clientX/Y are viewport-relative, matching
                // fixed positioning — no page-scroll math needed.
                let x = e.clientX;
                let y = e.clientY;
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                const rect = menu.getBoundingClientRect();
                if (rect.right > window.innerWidth) x = Math.max(4, window.innerWidth - rect.width - 4);
                if (rect.bottom > window.innerHeight) y = Math.max(4, window.innerHeight - rect.height - 4);
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                menu.dataset.ctxIndex = ctxIdx.toString();
            }
        });
    }

    li.dataset.index = index.toString();
    return li;
}

export function renderPlaylist(): void {
    if (vScroller) vScroller.refresh(true);
}

export function selectAllTracks(): void {
    // H26: select the visible view while filtered, full list otherwise.
    const n = (_isFiltering && _filteredView) ? _filteredView.length : state.playlist.length;
    if (n <= 0) return;
    playlistFocused = true;
    anchorIndex = n - 1;
    pivotIndex = 0;
    state.update({ selectedIndices: Array.from({ length: n }, (_, i) => i) });
}

/** Index the playlist context menu was opened for (-1 if unknown). */
export function getContextTargetIndex(): number {
    try {
        const menu = document.getElementById('contextMenu');
        const idx = parseInt(menu?.dataset.ctxIndex || '-1');
        if (Number.isInteger(idx) && idx >= 0 && idx < state.playlist.length) return idx;
    } catch { /* ignore */ }
    return -1;
}

/** Auto-scroll the playlist so the currently playing track is visible. */
export function focusPlayingTrack(): void {
    const idx = state.currentTrackIndex;
    if (idx < 0 || idx >= state.playlist.length) {
        try { toast.info('NO TRACK PLAYING'); } catch { /* ignore */ }
        return;
    }
    playlistFocused = true;
    // H26: when filtered, select/scroll the view position of the playing
    // track (by id), not the full-list index.
    if (_isFiltering && _filteredView) {
        const playingId = state.playlist[idx]?.id;
        const viewIdx = playingId !== undefined ? _filteredView.findIndex(t => t.id === playingId) : -1;
        if (viewIdx < 0) {
            try { toast.info('PLAYING TRACK HIDDEN BY FILTER'); } catch { /* ignore */ }
            return;
        }
        anchorIndex = viewIdx;
        pivotIndex = viewIdx;
        state.update({ selectedIndices: [viewIdx] });
        if (vScroller) vScroller.scrollTo(viewIdx);
        return;
    }
    anchorIndex = idx;
    pivotIndex = idx;
    state.update({ selectedIndices: [idx] });
    if (vScroller) vScroller.scrollTo(idx);
}

/**
 * Re-run BPM analysis for the given playlist indices.
 * Resets their BPM to the "analyzing" state first, then enqueues
 * background analysis (bounded queue, DB persist on completion).
 */
export function reanalyzeTracks(indices: number[]): void {
    const valid = [...new Set(indices)].filter(
        (i) => Number.isInteger(i) && i >= 0 && i < state.playlist.length
    );
    if (!valid.length) return;
    const next = [...state.playlist];
    for (const i of valid) next[i] = { ...next[i], bpm: undefined };
    state.update({ playlist: next });
    for (const i of valid) enqueueAnalysis(next[i]);
    try { toast.info(`ANALYZING ${valid.length} TRACK(S)...`); } catch { /* ignore */ }
}

/** Remove every track from the queue (confirm first if audio is playing). */
export function clearPlaylist(): void {
    if (!state.playlist.length) return;
    if (_isFiltering) {
        try { toast.info('CLEAR SEARCH BEFORE CLEARING'); } catch { /* ignore */ }
        return;
    }
    const doClear = (): void => {
        try { abortCrossfade(); } catch { /* ignore */ }
        clearAnalysisQueue();
        try { engine.main.audio.pause(); } catch { /* ignore */ }
        try { engine.main.audio.removeAttribute('src'); engine.main.audio.load(); } catch { try { engine.main.audio.src = ''; } catch { /* ignore */ } }
        try { engine.crossfade.audio.pause(); } catch { /* ignore */ }
        try { engine.crossfade.audio.removeAttribute('src'); engine.crossfade.audio.load(); } catch { try { engine.crossfade.audio.src = ''; } catch { /* ignore */ } }
        anchorIndex = -1;
        pivotIndex = -1;
        state.update({
            playlist: [],
            selectedIndices: [],
            currentTrackIndex: -1,
            isPlaying: false,
            masterBPM: 0,
            isCrossfadeInProgress: false,
            blendingIndex: -1,
        });
        invalidateCtxIndex();
        try { toast.info('PLAYLIST CLEARED'); } catch { /* ignore */ }
    };
    if (state.isPlaying || state.isCrossfadeInProgress) {
        showConfirm(
            'CLEAR PLAYLIST?',
            `This will remove all ${state.playlist.length} tracks and stop playback.`,
            doClear
        );
    } else {
        doClear();
    }
}

// === SAMPLER SUBMENU (Load to Sampler Pad) ===
let _submenuHideTimer: ReturnType<typeof setTimeout> | null = null;

export function hideSamplerSubmenu(): void {
    if (_submenuHideTimer) { clearTimeout(_submenuHideTimer); _submenuHideTimer = null; }
    const sub = document.getElementById('samplerSubmenu');
    if (sub) {
        sub.classList.add('hidden');
        sub.setAttribute('aria-hidden', 'true');
    }
    const parent = document.getElementById('ctxLoadToSampler');
    if (parent) parent.setAttribute('aria-expanded', 'false');
}

function showSamplerSubmenu(): void {
    if (_submenuHideTimer) { clearTimeout(_submenuHideTimer); _submenuHideTimer = null; }
    const sub = document.getElementById('samplerSubmenu');
    const parent = document.getElementById('ctxLoadToSampler');
    const menu = document.getElementById('contextMenu');
    if (!sub || !parent || !menu) return;
    // Position to the right of the parent menu; flip left on overflow.
    const menuRect = menu.getBoundingClientRect();
    sub.classList.remove('hidden');
    sub.setAttribute('aria-hidden', 'false');
    parent.setAttribute('aria-expanded', 'true');
    const subWidth = sub.offsetWidth || 170;
    if (menuRect.right + subWidth > window.innerWidth) {
        sub.style.left = 'auto';
        sub.style.right = '100%';
    } else {
        sub.style.right = 'auto';
        sub.style.left = '100%';
    }
    sub.style.top = '-5px';
    sub.style.bottom = 'auto';
    // Vertical clamp: the 16-pad list overflows near the window bottom.
    // Pin its bottom to the item so it grows upward inside the viewport
    // (max-height + scroll in CSS is the backstop) instead of pushing
    // past the edge and dragging page scroll with it.
    const subRect = sub.getBoundingClientRect();
    if (subRect.bottom > window.innerHeight) {
        sub.style.top = 'auto';
        sub.style.bottom = '0';
    }
}

async function buildSamplerSubmenu(trackIdx: number): Promise<void> {
    const sub = document.getElementById('samplerSubmenu');
    if (!sub) return;
    sub.innerHTML = '';
    let occupied: Record<number, boolean> = {};
    try {
        const sampler = await import('./sampler');
        for (let i = 0; i < NUM_PADS; i++) {
            if (sampler.padBuffers[i]) occupied[i] = true;
        }
    } catch { /* sampler unavailable — plain list */ }
    for (let i = 0; i < NUM_PADS; i++) {
        const item = document.createElement('div');
        item.className = 'context-item' + (occupied[i] ? ' pad-occupied' : '');
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '-1');
        item.textContent = `PAD ${i + 1}${occupied[i] ? ' ●' : ''}`;
        item.dataset.padIndex = i.toString();
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            void loadTrackToPad(trackIdx, i);
        });
        sub.appendChild(item);
    }
}

async function loadTrackToPad(trackIdx: number, padIdx: number): Promise<void> {
    const track = state.playlist[trackIdx];
    if (!track) return;
    try {
        const sampler = await import('./sampler');
        // Dropped/imported files often have no on-disk consent path — IPC-only
        // loading previously failed them while they played fine in the deck.
        // Prefer the cached File bytes when available.
        let dropped: File | undefined;
        try { dropped = getDroppedAudioFile(track.path, track.id); } catch { dropped = undefined; }
        if (dropped) {
            await sampler.loadSampleFile(dropped, padIdx);
        } else {
            await sampler.loadSampleFromPath(track.path, padIdx);
        }
        try { toast.success(`LOADED TO PAD ${padIdx + 1}`); } catch { /* ignore */ }
    } catch (e) {
        logger.warn(`[Playlist] Load to pad ${padIdx} failed`, e);
        try { toast.error('LOAD TO PAD FAILED'); } catch { /* ignore */ }
    }
}

/**
 * Reorder the playlist by moving an item from `fromIndex` to `toIndex`.
 * If `insertAfter` is true, the item is placed after `toIndex` instead of before it.
 * Updates selection indices to follow the moved item.
 */
function reorderPlaylist(fromIndex: number, toIndex: number, insertAfter: boolean): void {
    // Reordering under an armed finishCrossfade(nextIdx) promotes the wrong track.
    // Abort the blend first so the timer can't fire with a stale index.
    if (state.isCrossfadeInProgress) {
        try { abortCrossfade(); } catch { /* ignore */ }
        try { toast.info('CROSSFADE ABORTED FOR REORDER'); } catch { /* ignore */ }
    }
    // Reordering a filtered view would corrupt the real queue — clear search first.
    if (_isFiltering) {
        try { toast.info('CLEAR SEARCH BEFORE REORDERING'); } catch { /* ignore */ }
        return;
    }
    const playlist = [...state.playlist];
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
    if (fromIndex < 0 || fromIndex >= playlist.length) return;
    if (toIndex < 0 || toIndex >= playlist.length) return;
    if (fromIndex === toIndex) return;

    const [moved] = playlist.splice(fromIndex, 1);
    let target = toIndex;
    // If we removed from before target, target shifts back by one
    if (fromIndex < target) target--;
    if (insertAfter) target++;
    target = Math.min(target, playlist.length);
    playlist.splice(target, 0, moved);

    // Adjust selection: follow the moved item
    const newSelected = state.selectedIndices.map(idx => {
        if (idx === fromIndex) {
            // The moved item — goes to new position
            return target;
        }
        // Adjust indices that shifted
        if (fromIndex < target) {
            // M19: forward move shifts (fromIndex, target] left by one —
            // the old `< target` left the occupant of `target` stranded.
            if (idx > fromIndex && idx <= target) return idx - 1;
        } else {
            // Item moved backward: indices between target and fromIndex-1 shift right
            if (idx >= target && idx < fromIndex) return idx + 1;
        }
        return idx;
    });

    // Adjust anchor/pivot
    if (anchorIndex === fromIndex) anchorIndex = target;
    else if (fromIndex < target && anchorIndex > fromIndex && anchorIndex <= target) anchorIndex--;
    else if (fromIndex > target && anchorIndex >= target && anchorIndex < fromIndex) anchorIndex++;

    if (pivotIndex === fromIndex) pivotIndex = target;
    else if (fromIndex < target && pivotIndex > fromIndex && pivotIndex <= target) pivotIndex--;
    else if (fromIndex > target && pivotIndex >= target && pivotIndex < fromIndex) pivotIndex++;

    // The playing indicator must follow its track through the reorder,
    // otherwise it jumps to whatever landed in the old slot.
    const curIdx = state.currentTrackIndex;
    if (curIdx === fromIndex) {
        state.update({ playlist, selectedIndices: newSelected, currentTrackIndex: target });
    } else {
        let newCur = curIdx;
        if (curIdx >= 0) {
            if (fromIndex < target && curIdx > fromIndex && curIdx <= target) newCur = curIdx - 1;
            else if (fromIndex > target && curIdx >= target && curIdx < fromIndex) newCur = curIdx + 1;
        }
        state.update({
            playlist,
            selectedIndices: newSelected,
            ...(newCur !== curIdx ? { currentTrackIndex: newCur } : {})
        });
    }
    invalidateCtxIndex();
}

// === NEW: KEYBOARD NAVIGATION ===
export function handlePlaylistNavigation(e: KeyboardEvent): void {
    const viewLen = (_isFiltering && _filteredView) ? _filteredView.length : state.playlist.length;
    if (!viewLen) return;
    // Keyboard only drives the playlist while it has focus — clicking
    // elsewhere in the GUI defocuses it (see setupPlaylistHandlers).
    if (!playlistFocused) return;
    // Mutations against a filtered view would corrupt the real queue —
    // Delete while filtered requires clearing the search first.
    if (_isFiltering && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        try { toast.info('CLEAR SEARCH BEFORE REMOVING'); } catch { /* ignore */ }
        return;
    }

    // Ctrl/Cmd+A selects everything in the current (possibly filtered) view.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAllTracks();
        return;
    }

    // Ensure valid anchor/pivot if coming from empty state
    if (anchorIndex === -1) anchorIndex = 0;
    if (pivotIndex === -1) pivotIndex = anchorIndex;

    let newAnchor = anchorIndex;

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        newAnchor = Math.max(0, anchorIndex - 1);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        newAnchor = Math.min(viewLen - 1, anchorIndex + 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
         if (state.selectedIndices.length > 0) {
             e.preventDefault();
             removeSelectedTracks();
         }
         return;
    } else {
        return; // Not handled
    }

    anchorIndex = newAnchor;

    if (e.shiftKey) {
        // Range Selection: pivot -> newAnchor
        const s = Math.min(pivotIndex, newAnchor);
        const e_ = Math.max(pivotIndex, newAnchor);
        const range = Array.from({length: e_ - s + 1}, (_, i) => s + i);
        state.update({ selectedIndices: range });
    } else {
        // Single Selection
        state.update({ selectedIndices: [newAnchor] });
        pivotIndex = newAnchor;
    }
    
    // Scroll into view
    if (vScroller) {
        vScroller.scrollTo(anchorIndex);
    }
}

export function removeSelectedTracks(): void {
    if (!state.selectedIndices.length) return;
    if (_isFiltering) {
        try { toast.info('CLEAR SEARCH BEFORE REMOVING'); } catch { /* ignore */ }
        return;
    }
    // Abort any armed blend FIRST — the pending finishCrossfade timer otherwise
    // fires with a stale index and resurrects the deleted track.
    try { abortCrossfade(); } catch { /* ignore */ }
    clearAnalysisQueue();

    const currentPlaylist = [...state.playlist];
    // Filter stale/OOB selections (e.g. after a filter shrank the list) —
    // previously undefined entries were spliced into the playlist.
    const currentSelected = [...new Set(state.selectedIndices)]
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < currentPlaylist.length);
    if (!currentSelected.length) {
        state.update({ selectedIndices: [] });
        return;
    }
    const currentIndex = state.currentTrackIndex;

    // Sort descending to remove safe
    currentSelected.sort((a, b) => b - a);

    let playingTrackRemoved = false;
    currentSelected.forEach(idx => {
        if (idx === currentIndex) playingTrackRemoved = true;
        // Indices after a removed row shift down by one
        currentPlaylist.splice(idx, 1);
    });
    
    // Remap currentTrackIndex against the new list — previously deleting the
    // playing track left the index pointing at an unrelated song.
    // blendingIndex mirrors the same remap (it pointed at unrelated rows
    // after any removal above it).
    const blendIndex = state.blendingIndex;
    const blendRemoved = blendIndex >= 0 && currentSelected.includes(blendIndex);
    let newBlend = blendIndex;
    if (blendRemoved) {
        newBlend = -1;
    } else if (blendIndex >= 0) {
        const removedBeforeBlend = currentSelected.filter(idx => idx < blendIndex).length;
        newBlend = blendIndex - removedBeforeBlend;
        if (newBlend >= currentPlaylist.length) newBlend = currentPlaylist.length - 1;
    }
    let newIndex = currentIndex;
    if (playingTrackRemoved) {
        newIndex = -1;
        // Kill audible playback of the removed track + abort any armed blend
        // that would otherwise promote the deleted channel on timer fire.
        try { engine.main.audio.pause(); } catch { /* ignore */ }
        try { engine.main.audio.removeAttribute('src'); engine.main.audio.load(); } catch { try { engine.main.audio.src = ""; } catch { /* ignore */ } }
        try { engine.crossfade.audio.pause(); } catch { /* ignore */ }
        try { engine.crossfade.audio.removeAttribute('src'); engine.crossfade.audio.load(); } catch { try { engine.crossfade.audio.src = ""; } catch { /* ignore */ } }
        try { setBlendingIndex(newBlend); } catch { /* ignore */ }
        state.update({ isPlaying: false, masterBPM: 0, isCrossfadeInProgress: false });
    } else if (currentIndex >= 0) {
        const removedBefore = currentSelected.filter(idx => idx < currentIndex).length;
        newIndex = currentIndex - removedBefore;
        if (newIndex >= currentPlaylist.length) newIndex = currentPlaylist.length - 1;
    }
    
    let newAnchor = currentPlaylist.length > 0
        ? Math.min(Math.max(anchorIndex, 0), currentPlaylist.length - 1)
        : -1;
    let newPivot = newAnchor;

    // M18: never force-select a survivor. Removal clears the selection;
    // the clamped anchor/pivot is kept only as the next keyboard origin.
    const newSelected: number[] = [];
    anchorIndex = currentPlaylist.length > 0 ? newAnchor : -1;
    pivotIndex = currentPlaylist.length > 0 ? newPivot : -1;
    state.update({
        playlist: currentPlaylist,
        selectedIndices: newSelected,
        ...(newIndex !== state.currentTrackIndex ? { currentTrackIndex: newIndex } : {}),
        ...(newBlend !== state.blendingIndex ? { blendingIndex: newBlend } : {})
    });
    invalidateCtxIndex();
}

let _handlersWired = false;
export function setupPlaylistHandlers(): void {
    // Idempotent (C15): initPlaylist may re-run after the restore prompt
    // resolves, and every call otherwise stacked duplicate listeners.
    if (_handlersWired) return;
    _handlersWired = true;
    if (playlistInput) {
        playlistInput.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            if (target.files) {
                addTracksToPlaylist(Array.from(target.files));
            }
            target.value = ''; // FIX: Allow re-adding same file
        });
    }

    // Deselect on background click
    if (playlistEl) {
        playlistEl.addEventListener('mousedown', () => { playlistFocused = true; });
        playlistEl.addEventListener('click', (e) => {
            // Only if directly clicking the container (empty space)
            if (e.target === playlistEl) {
                playlistFocused = true;
                state.update({ selectedIndices: [] });
                pivotIndex = -1;
                anchorIndex = -1;
            }
        });

        // DRAG & DROP (external files)
        playlistEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (playlistEl) playlistEl.classList.add('drag-over');
        });

        playlistEl.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (playlistEl) playlistEl.classList.remove('drag-over');
        });

        playlistEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (playlistEl) playlistEl.classList.remove('drag-over');
            
            // Internal reorder drop (handled by li.drop) — skip if already handled
            if (isDragging && draggedIndex >= 0) {
                // Dropped on empty area — append to end
                const idx = state.playlist.length - 1;
                if (draggedIndex !== idx) {
                    reorderPlaylist(draggedIndex, idx, true);
                }
                isDragging = false;
                draggedIndex = -1;
                return;
            }

            // External file drop
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                addTracksToPlaylist(Array.from(e.dataTransfer.files));
            }
        });
    }

    document.addEventListener('mouseup', () => {
        draggedIndex = -1; isDragging = false; document.body.style.cursor = '';
        selectDragging = false;
        pressIndex = -1;
        // A row click (if any) fires right after mouseup and consumes
        // suppressClick first; otherwise clear it so the next real click works.
        setTimeout(() => { suppressClick = false; }, 0);
    });
    // Clicking anywhere outside the playlist defocuses it so arrows/Delete
    // stop driving the playlist while the user works elsewhere in the GUI.
    if (!_focusWired) {
        _focusWired = true;
        document.addEventListener('mousedown', (e) => {
            const t = e.target as HTMLElement | null;
            if (playlistEl && t && playlistEl.contains(t)) return;
            if (t && t.closest && t.closest('#contextMenu')) return;
            playlistFocused = false;
        }, true);
    }
    // Cancelled drags (Esc, drop outside) previously left the highlight stuck.
    document.addEventListener('dragend', () => {
        draggedIndex = -1; isDragging = false; document.body.style.cursor = '';
        if (playlistEl) playlistEl.classList.remove('drag-over');
        if (playlistEl) playlistEl.querySelectorAll('.drop-above, .drop-below').forEach(el => {
            el.classList.remove('drop-above', 'drop-below');
        });
    });

    // === CONTEXT MENU ACTION HANDLERS ===
    const ctxRemove = document.getElementById('ctxRemove');
    const ctxMoveUp = document.getElementById('ctxMoveUp');
    const ctxMoveDown = document.getElementById('ctxMoveDown');
    const ctxSelectAll = document.getElementById('ctxSelectAll');
    const ctxFocusPlaying = document.getElementById('ctxFocusPlaying');
    const ctxLoadToSampler = document.getElementById('ctxLoadToSampler');
    const ctxAnalyzeBPM = document.getElementById('ctxAnalyzeBPM');
    const ctxTrackInfo = document.getElementById('ctxTrackInfo');
    const ctxShowInFolder = document.getElementById('ctxShowInFolder');
    const ctxCopyPath = document.getElementById('ctxCopyPath');
    const ctxClearPlaylist = document.getElementById('ctxClearPlaylist');
    const samplerSubmenu = document.getElementById('samplerSubmenu');

    // Submenu hover wiring (dismisses cleanly on leave / outside click / ESC)
    if (ctxLoadToSampler && samplerSubmenu) {
        ctxLoadToSampler.addEventListener('mouseenter', () => showSamplerSubmenu());
        ctxLoadToSampler.addEventListener('mouseleave', () => {
            if (_submenuHideTimer) clearTimeout(_submenuHideTimer);
            _submenuHideTimer = setTimeout(() => {
                try {
                    if (samplerSubmenu.matches(':hover') || ctxLoadToSampler.matches(':hover')) return;
                } catch { /* ignore */ }
                hideSamplerSubmenu();
            }, 150);
        });
        samplerSubmenu.addEventListener('mouseenter', () => {
            if (_submenuHideTimer) { clearTimeout(_submenuHideTimer); _submenuHideTimer = null; }
        });
        samplerSubmenu.addEventListener('mouseleave', () => hideSamplerSubmenu());
    }

    if (ctxFocusPlaying) ctxFocusPlaying.addEventListener('click', () => {
        focusPlayingTrack();
    });

    if (ctxAnalyzeBPM) ctxAnalyzeBPM.addEventListener('click', () => {
        const target = getContextTargetIndex();
        let indices = state.selectedIndices.length ? [...state.selectedIndices] : (target >= 0 ? [target] : []);
        // Selection is view-relative while filtered — resolve to full
        // indices by id before reanalyzing the real queue.
        if (_isFiltering && _filteredView) {
            indices = indices
                .map(vi => viewIndexToFullIndex(vi))
                .filter(i => i >= 0);
            if (target >= 0 && !indices.includes(target)) indices.push(target);
        }
        if (!indices.length) {
            try { toast.info('NOTHING TO ANALYZE'); } catch { /* ignore */ }
            return;
        }
        reanalyzeTracks(indices);
    });

    if (ctxTrackInfo) ctxTrackInfo.addEventListener('click', () => {
        const track = resolveCtxTrack();
        if (!track) {
            try { toast.info('NO TRACK SELECTED'); } catch { /* ignore */ }
            return;
        }
        void import('./track-info').then((m) => m.openTrackInfo(track)).catch(() => undefined);
    });

    if (ctxShowInFolder) ctxShowInFolder.addEventListener('click', () => {
        const track = resolveCtxTrack();
        if (!track) return;
        const show = window.fileSystem?.showItemInFolder;
        if (typeof show !== 'function') {
            try { toast.error('NOT AVAILABLE IN THIS ENVIRONMENT'); } catch { /* ignore */ }
            return;
        }
        void show(track.path).then((ok) => {
            if (!ok) try { toast.error('COULD NOT OPEN FILE LOCATION'); } catch { /* ignore */ }
        }).catch(() => {
            try { toast.error('COULD NOT OPEN FILE LOCATION'); } catch { /* ignore */ }
        });
    });

    if (ctxCopyPath) ctxCopyPath.addEventListener('click', () => {
        const track = resolveCtxTrack();
        if (!track) return;
        const done = () => { try { toast.success('FILE PATH COPIED'); } catch { /* ignore */ } };
        const fail = () => { try { toast.error('COPY FAILED'); } catch { /* ignore */ } };
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(track.path).then(done, fail);
            } else {
                const ta = document.createElement('textarea');
                ta.value = track.path;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                done();
            }
        } catch { fail(); }
    });

    if (ctxClearPlaylist) ctxClearPlaylist.addEventListener('click', () => {
        clearPlaylist();
    });

    if (ctxRemove) ctxRemove.addEventListener('click', () => {
        removeSelectedTracks();
    });

    if (ctxSelectAll) ctxSelectAll.addEventListener('click', () => {
        selectAllTracks();
    });

    if (ctxMoveUp) ctxMoveUp.addEventListener('click', () => {
        if (!state.selectedIndices.length) return;
        if (state.isCrossfadeInProgress) { try { toast.info('MIXING — WAIT FOR BLEND TO FINISH'); } catch { /* ignore */ } return; }
        if (_isFiltering) { try { toast.info('CLEAR SEARCH BEFORE MOVING'); } catch { /* ignore */ } return; }
        const list = [...state.playlist];
        // Drop stale/OOB selections — previously wrote undefined into the list.
        const sel = new Set(
            [...state.selectedIndices].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < list.length)
        );
        if (!sel.size) { state.update({ selectedIndices: [] }); return; }
        const sorted = [...sel].sort((a, b) => a - b);
        if (sorted[0] <= 0) return;
        // Anchor/pivot follow their tracks by id (block moves shift
        // unselected rows by more than one — arithmetic remap is wrong).
        const beforeIdsUp = state.playlist.map(t => t?.id);
        // Ascending; skip swap when predecessor is also selected so
        // contiguous blocks move together instead of reversing.
        for (const idx of sorted) {
            if (sel.has(idx - 1)) continue;
            if (list[idx - 1] === undefined || list[idx] === undefined) continue;
            [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
            sel.delete(idx); sel.add(idx - 1);
        }
        const curId = state.playlist[state.currentTrackIndex]?.id;
        const newCur = curId ? list.findIndex(t => t?.id === curId) : state.currentTrackIndex;
        state.update({
            playlist: list,
            selectedIndices: [...sel],
            ...(newCur !== state.currentTrackIndex ? { currentTrackIndex: newCur } : {}),
        });
        const remapUp = (p: number): number => {
            if (!Number.isInteger(p) || p < 0 || p >= beforeIdsUp.length) return p;
            const ni = list.findIndex(t => t?.id === beforeIdsUp[p]);
            return ni >= 0 ? ni : p;
        };
        anchorIndex = remapUp(anchorIndex);
        pivotIndex = remapUp(pivotIndex);
        invalidateCtxIndex();
    });

    if (ctxMoveDown) ctxMoveDown.addEventListener('click', () => {
        if (!state.selectedIndices.length) return;
        if (state.isCrossfadeInProgress) { try { toast.info('MIXING — WAIT FOR BLEND TO FINISH'); } catch { /* ignore */ } return; }
        if (_isFiltering) { try { toast.info('CLEAR SEARCH BEFORE MOVING'); } catch { /* ignore */ } return; }
        const list = [...state.playlist];
        const sel = new Set(
            [...state.selectedIndices].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < list.length)
        );
        if (!sel.size) { state.update({ selectedIndices: [] }); return; }
        const sorted = [...sel].sort((a, b) => b - a);
        if (sorted[0] >= list.length - 1) return;
        // Anchor/pivot follow their tracks by id (see move-up).
        const beforeIdsDown = state.playlist.map(t => t?.id);
        // Descending; skip swap when successor is also selected (block move).
        for (const idx of sorted) {
            if (sel.has(idx + 1)) continue;
            if (list[idx + 1] === undefined || list[idx] === undefined) continue;
            [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
            sel.delete(idx); sel.add(idx + 1);
        }
        const curId = state.playlist[state.currentTrackIndex]?.id;
        const newCur = curId ? list.findIndex(t => t?.id === curId) : state.currentTrackIndex;
        state.update({
            playlist: list,
            selectedIndices: [...sel],
            ...(newCur !== state.currentTrackIndex ? { currentTrackIndex: newCur } : {}),
        });
        const remapDown = (p: number): number => {
            if (!Number.isInteger(p) || p < 0 || p >= beforeIdsDown.length) return p;
            const ni = list.findIndex(t => t?.id === beforeIdsDown[p]);
            return ni >= 0 ? ni : p;
        };
        anchorIndex = remapDown(anchorIndex);
        pivotIndex = remapDown(pivotIndex);
        invalidateCtxIndex();
    });
}
