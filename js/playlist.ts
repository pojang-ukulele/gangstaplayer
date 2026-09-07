import { audioCtx, ensureAudio } from './audio';
import { detectBPMWorker } from './worker-client';
import { state, Track } from './state';
import { VirtualScroller } from './reactive/ui';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import { engine } from './audio-engine';
import { abortCrossfade } from './player';
import { showConfirm } from './modals';
import { toast } from './toast';
import { logger } from './logger';
import { MAX_FILE_SIZE_BYTES, NUM_PADS } from './constants';
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
// Playlist keyboard focus: cleared when the user clicks anywhere outside the
// playlist so arrows/Delete stop driving it. Set on any press inside.
let playlistFocused = true;

let playlistEl: HTMLElement | null = null;
let playlistInput: HTMLInputElement | null = null;
let contextMenu: HTMLElement | null = null;

let loadTrackFn: ((index: number) => Promise<void>) | null = null;
let playTrackFn: (() => void) | null = null;
let _uiLoadGen = 0;
let vScroller: VirtualScroller<Track> | null = null;
let _playlistUnsubs: (() => void)[] | null = null;
let _dbLoadGen = 0;
let _isFiltering = false;
let _focusWired = false;
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
            if (loadGen !== _dbLoadGen) return; // superseded by newer load/filter
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

    let fullPlaylistBackup: Track[] | null = null;
    const setFiltering = (v: boolean) => { _isFiltering = v; };

    if (searchInput) {
        let searchGen = 0;
        searchInput.addEventListener('input', async () => {
            const myGen = ++searchGen;
            _dbLoadGen = myGen; // invalidate any in-flight initial DB load
            const query = searchInput.value;
            try {
                if (query.length > 0) {
                    // Stash the real queue once — filtering must never destroy it.
                    if (fullPlaylistBackup === null) fullPlaylistBackup = [...state.playlist];
                    setFiltering(true);
                    const results = db ? await db.searchTracks(query.slice(0, 256)) : state.playlist;
                    if (myGen !== searchGen) return; // stale keystroke, drop
                    const list = Array.isArray(results) ? results : [];
                    const curId = fullPlaylistBackup[state.currentTrackIndex]?.id
                        ?? state.playlist[state.currentTrackIndex]?.id;
                    const newCur = curId ? list.findIndex(t => t?.id === curId) : -1;
                    state.update({
                        playlist: list,
                        selectedIndices: [],
                        ...(newCur !== state.currentTrackIndex ? { currentTrackIndex: newCur } : {}),
                    });
                } else {
                    if (myGen !== searchGen) return;
                    // Restore the stashed queue, merging tracks added while
                    // filtered (they went to the visible list, backup stale).
                    if (fullPlaylistBackup !== null) {
                        const restored = fullPlaylistBackup;
                        fullPlaylistBackup = null;
                        setFiltering(false);
                        const liveIds = new Set(restored.map(t => t.id));
                        for (const t of state.playlist) {
                            if (t && t.id && !liveIds.has(t.id)) { restored.push(t); liveIds.add(t.id); }
                        }
                        const curId = state.playlist[state.currentTrackIndex]?.id;
                        const newCur = curId ? restored.findIndex(t => t?.id === curId) : state.currentTrackIndex;
                        state.update({
                            playlist: restored,
                            selectedIndices: [],
                            ...(newCur !== state.currentTrackIndex && newCur >= -1 ? { currentTrackIndex: newCur } : {}),
                        });
                    } else if (db) {
                        const all = await db.getAllTracks();
                        if (myGen !== searchGen) return;
                        state.update({ playlist: Array.isArray(all) ? all : [], selectedIndices: [] });
                    }
                }
            } catch {
                return; // DB error must not wipe the visible list
            }
            anchorIndex = -1;
            pivotIndex = -1;
        });
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
        if (vScroller) vScroller.updateItems(playlist);
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
            renderItem: (track, index, existing) => renderTrackRow(track, index, existing)
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

function enqueueAnalysis(track: Track): void {
    // Bounded queue — bulk imports previously queued N unbounded decodes.
    if (_analysisQueue.length >= 256) return;
    _analysisQueue.push(track);
    pumpAnalysisQueue();
}

export function clearAnalysisQueue(): void {
    _analysisQueue.length = 0;
}

function pumpAnalysisQueue(): void {
    while (_analysisActive < MAX_CONCURRENT_ANALYSIS && _analysisQueue.length > 0) {
        const next = _analysisQueue.shift();
        if (!next) break;
        _analysisActive++;
        analyzeTrackInBackground(next).finally(() => {
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

        const rawData = await window.fileSystem.readFile(track.path);
        if (!rawData) {
            console.warn(`[Playlist] Analysis skipped for ${track.name} (File unreadable)`);
            return;
        }


        const arrayBuffer = normalizeToArrayBuffer(rawData);
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            return; // oversized drops previously OOMed the renderer
        }
        // Drop doomed work: track deleted/cleared while queued.
        if (!state.playlist.some(t => t.id === track.id)) return;

        // Same validation policy as the sampler — reject non-audio early
        // instead of feeding garbage to the decoder.
        const validationError = validateAudioSignature(arrayBuffer, track.name);
        if (validationError) {
            console.warn(`[Playlist] Analysis skipped for ${track.name}: ${validationError}`);
            const failIdx = state.playlist.findIndex(t => t.id === track.id);
            if (failIdx >= 0) {
                const failNext = [...state.playlist];
                failNext[failIdx] = { ...failNext[failIdx], bpm: 0 };
                state.update({ playlist: failNext });
            }
            return;
        }

        // Use native decoder (decoder pool workers are unreliable)
        if (!ensureAudio() || !audioCtx) return;
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        const bpm = await detectBPMWorker(audioBuffer);
        
        const idx = state.playlist.findIndex(t => t.id === track.id);
        const next = [...state.playlist];
        if (idx >= 0) next[idx] = { ...next[idx], bpm, duration: audioBuffer.duration };
        else { track.bpm = bpm; track.duration = audioBuffer.duration; }

        // 2. Persist to DB
        if (db) {
            await db.upsertTrack({
                id: track.id,
                path: track.path,
                name: track.name,
                duration: audioBuffer.duration,
                bpm
            });
        }

        // Drop stale work: track cleared/deleted while DB persist was in flight.
        // Re-resolve against the live list instead of pushing the pre-await snapshot.
        const liveIdx = state.playlist.findIndex(t => t.id === track.id);
        if (liveIdx < 0) return;
        const live = [...state.playlist];
        live[liveIdx] = { ...live[liveIdx], bpm, duration: audioBuffer.duration };
        state.update({ playlist: live });
    } catch (e) {
        console.warn(`[Playlist] BPM analysis skipped for ${track.name}`);
        const idx = state.playlist.findIndex(t => t.id === track.id);
        if (idx >= 0) {
            const next = [...state.playlist];
            next[idx] = { ...next[idx], bpm: 0 };
            state.update({ playlist: next });
        }
    }
}

export function addTracksToPlaylist(files: File[]): void {
    const currentPlaylist = [...state.playlist];
    const existingPaths = new Set(currentPlaylist.map(t => t.path));
    const startIdx = currentPlaylist.length;
    const uuid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? () => crypto.randomUUID()
        : () => `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm']);
    let rejected = 0;
    let dupes = 0;
    files.forEach((file) => {
        const fullPath = window.electronAPI.getPathForFile(file);
        if (!fullPath) { rejected++; return; }
        if (fullPath.length > 32760) { rejected++; return; }
        const ext = fullPath.split('.').pop()?.toLowerCase() ?? '';
        if (!AUDIO_EXTS.has(ext)) { rejected++; return; }
        if (existingPaths.has(fullPath)) { dupes++; return; }
        existingPaths.add(fullPath);
        const track: Track = {
            id: uuid(),
            name: String(file.name).slice(0, 512),
            path: fullPath,
            duration: 0,
            bpm: undefined
        };
        currentPlaylist.push(track);
        
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

    state.update({ playlist: currentPlaylist });
    if (rejected > 0) { try { toast.info(`${rejected} FILE(S) SKIPPED (UNSUPPORTED TYPE)`); } catch { /* ignore */ } }
    else if (dupes > 0) { try { toast.info(`${dupes} DUPLICATE(S) SKIPPED`); } catch { /* ignore */ } }

    if (startIdx === 0 && state.playlist.length > 0 && loadTrackFn) {
        loadTrackFn(0);
        // Auto select first
        state.update({
            selectedIndices: [0]
        });
        anchorIndex = 0;
        pivotIndex = 0;
    }
}

function renderTrackRow(track: Track, index: number, existing?: HTMLElement): HTMLElement {
    const li = (existing || document.createElement('li')) as HTMLElement;
    
    let bpmSuffix = " [...]";  // Still analyzing
    if (track.bpm !== null && track.bpm !== undefined) {
        bpmSuffix = track.bpm > 0 ? ` [${track.bpm}bpm]` : "";  // Detected or silent fail
    }
    
    let blendSuffix = "";
    li.classList.remove('blending', 'selected', 'playing');

    if (index === state.blendingIndex) {
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
    if (index === state.currentTrackIndex) li.classList.add('playing');
    
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
            const idx = parseInt(li.dataset.index || "0");
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
            const idx = parseInt(li.dataset.index || "0");
            if (!state.selectedIndices.includes(idx)) {
                state.update({ selectedIndices: [idx] });
                anchorIndex = idx;
                pivotIndex = idx;
            }
            const menu = document.getElementById('contextMenu');
            if (menu) {
                menu.classList.remove('hidden');
                menu.style.display = 'block';
                menu.style.zIndex = '9999';
                hideSamplerSubmenu();
                void buildSamplerSubmenu(idx);

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
                menu.dataset.ctxIndex = idx.toString(); 
            }
        });
    }

    li.dataset.index = index.toString();
    return li;
}

export function renderPlaylist(): void {
    if (vScroller) vScroller.refresh(true);
}

export function isPlaylistFocused(): boolean { return playlistFocused; }
export function setPlaylistFocused(v: boolean): void { playlistFocused = v; }

export function selectAllTracks(): void {
    const n = state.playlist.length;
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
        await sampler.loadSampleFromPath(track.path, padIdx);
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
            // Item moved forward: indices between fromIndex and target-1 shift left
            if (idx > fromIndex && idx < target) return idx - 1;
        } else {
            // Item moved backward: indices between target and fromIndex-1 shift right
            if (idx >= target && idx < fromIndex) return idx + 1;
        }
        return idx;
    });

    // Adjust anchor/pivot
    if (anchorIndex === fromIndex) anchorIndex = target;
    else if (fromIndex < target && anchorIndex > fromIndex && anchorIndex < target) anchorIndex--;
    else if (fromIndex > target && anchorIndex >= target && anchorIndex < fromIndex) anchorIndex++;

    if (pivotIndex === fromIndex) pivotIndex = target;
    else if (fromIndex < target && pivotIndex > fromIndex && pivotIndex < target) pivotIndex--;
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
}

// === NEW: KEYBOARD NAVIGATION ===
export function handlePlaylistNavigation(e: KeyboardEvent): void {
    if (!state.playlist.length) return;
    // Keyboard only drives the playlist while it has focus — clicking
    // elsewhere in the GUI defocuses it (see setupPlaylistHandlers).
    if (!playlistFocused) return;

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
        newAnchor = Math.min(state.playlist.length - 1, anchorIndex + 1);
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
    let newIndex = currentIndex;
    if (playingTrackRemoved) {
        newIndex = -1;
        // Kill audible playback of the removed track + abort any armed blend
        // that would otherwise promote the deleted channel on timer fire.
        try { engine.main.audio.pause(); } catch { /* ignore */ }
        try { engine.main.audio.removeAttribute('src'); engine.main.audio.load(); } catch { try { engine.main.audio.src = ""; } catch { /* ignore */ } }
        try { engine.crossfade.audio.pause(); } catch { /* ignore */ }
        try { engine.crossfade.audio.removeAttribute('src'); engine.crossfade.audio.load(); } catch { try { engine.crossfade.audio.src = ""; } catch { /* ignore */ } }
        try { setBlendingIndex(-1); } catch { /* ignore */ }
        state.update({ isPlaying: false, masterBPM: 0, isCrossfadeInProgress: false });
    } else if (currentIndex >= 0) {
        const removedBefore = currentSelected.filter(idx => idx < currentIndex).length;
        newIndex = currentIndex - removedBefore;
        if (newIndex >= currentPlaylist.length) newIndex = currentPlaylist.length - 1;
    }
    
    let newAnchor = Math.min(anchorIndex, currentPlaylist.length - 1);
    let newPivot = newAnchor; 

    const newSelected: number[] = [];
    if (newAnchor >= 0 && currentPlaylist.length > 0) {
        newSelected.push(newAnchor);
    } else if (currentPlaylist.length > 0) {
        newAnchor = 0;
        newPivot = 0;
        newSelected.push(0);
    } else {
        newAnchor = -1;
        newPivot = -1;
    }
    
    anchorIndex = newAnchor;
    pivotIndex = newPivot;
    state.update({ 
        playlist: currentPlaylist, 
        selectedIndices: newSelected,
        ...(newIndex !== state.currentTrackIndex ? { currentTrackIndex: newIndex } : {})
    });
}

export function setupPlaylistHandlers(): void {
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
        const indices = state.selectedIndices.length ? [...state.selectedIndices] : (target >= 0 ? [target] : []);
        if (!indices.length) {
            try { toast.info('NOTHING TO ANALYZE'); } catch { /* ignore */ }
            return;
        }
        reanalyzeTracks(indices);
    });

    if (ctxTrackInfo) ctxTrackInfo.addEventListener('click', () => {
        const target = getContextTargetIndex();
        const track = state.playlist[target] ?? state.playlist[state.selectedIndices[0]];
        if (!track) {
            try { toast.info('NO TRACK SELECTED'); } catch { /* ignore */ }
            return;
        }
        void import('./track-info').then((m) => m.openTrackInfo(track)).catch(() => undefined);
    });

    if (ctxShowInFolder) ctxShowInFolder.addEventListener('click', () => {
        const target = getContextTargetIndex();
        const track = state.playlist[target] ?? state.playlist[state.selectedIndices[0]];
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
        const target = getContextTargetIndex();
        const track = state.playlist[target] ?? state.playlist[state.selectedIndices[0]];
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
        if (state.isCrossfadeInProgress) return;
        if (_isFiltering) { try { toast.info('CLEAR SEARCH BEFORE MOVING'); } catch { /* ignore */ } return; }
        const list = [...state.playlist];
        // Drop stale/OOB selections — previously wrote undefined into the list.
        const sel = new Set(
            [...state.selectedIndices].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < list.length)
        );
        if (!sel.size) { state.update({ selectedIndices: [] }); return; }
        const sorted = [...sel].sort((a, b) => a - b);
        if (sorted[0] <= 0) return;
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
    });

    if (ctxMoveDown) ctxMoveDown.addEventListener('click', () => {
        if (!state.selectedIndices.length) return;
        if (state.isCrossfadeInProgress) return;
        if (_isFiltering) { try { toast.info('CLEAR SEARCH BEFORE MOVING'); } catch { /* ignore */ } return; }
        const list = [...state.playlist];
        const sel = new Set(
            [...state.selectedIndices].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < list.length)
        );
        if (!sel.size) { state.update({ selectedIndices: [] }); return; }
        const sorted = [...sel].sort((a, b) => b - a);
        if (sorted[0] >= list.length - 1) return;
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
    });
}
