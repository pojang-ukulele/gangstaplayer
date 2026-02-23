import { DRAG_THRESHOLD_PX } from './constants';
import { audioCtx, createAudioBuffer } from './audio';
import { decoderPool } from './decoder-pool';
import { detectBPMWorker } from './worker-client';
import { state, Track } from './state';
import { VirtualScroller } from './reactive/ui';

interface PlaylistDeps {
    loadTrack: (index: number) => Promise<void>;
    playTrack: () => void;
}

let anchorIndex = -1;
let pivotIndex = -1; // Start of selection range
let draggedIndex = -1;
let isDragging = false;
let dragStartY = 0;

let playlistEl: HTMLElement | null = null;
let playlistInput: HTMLInputElement | null = null;
let contextMenu: HTMLElement | null = null;

let loadTrackFn: ((index: number) => Promise<void>) | null = null;
let playTrackFn: (() => void) | null = null;
let vScroller: VirtualScroller<Track> | null = null;
const ITEM_HEIGHT = 40; // Pixels

export function initPlaylist(deps: PlaylistDeps): void {
    loadTrackFn = deps.loadTrack;
    playTrackFn = deps.playTrack;
    playlistEl = document.getElementById('playlist');
    playlistInput = document.getElementById('playlistInput') as HTMLInputElement;
    contextMenu = document.getElementById('contextMenu');
    const searchInput = document.getElementById('playlistSearch') as HTMLInputElement;

    // === INITIAL LOAD FROM DB ===
    const db = (window as any).database;
    if (db) {
        db.getAllTracks().then((tracks: Track[]) => {
            if (tracks && tracks.length > 0) {
                state.update({ playlist: tracks });
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', async () => {
            const query = searchInput.value;
            if (db && query.length > 0) {
                const results = await db.searchTracks(query);
                state.update({ playlist: results });
            } else if (db) {
                const all = await db.getAllTracks();
                state.update({ playlist: all });
            }
        });
    }

    // === REACTIVE SUBSCRIPTIONS ===
    state.subscribe('playlist', (playlist) => {
        if (vScroller) vScroller.updateItems(playlist);
    });
    
    const refreshSelection = () => {
        if (vScroller) vScroller.refresh(true);
    };

    state.subscribe('selectedIndices', refreshSelection);
    state.subscribe('currentTrackIndex', refreshSelection);
    state.subscribe('blendingIndex', refreshSelection);
    
    // Initial vScroller setup
    if (playlistEl) {
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
 * Background worker to analyze BPM for a track
 */
async function analyzeTrackInBackground(track: Track): Promise<void> {
    try {
        const db = (window as any).database;
        
        // 1. Check DB Cache first
        if (db) {
            const cached = await db.getTrack(track.path);
            if (cached && cached.bpm > 0) {
                track.bpm = cached.bpm;
                track.duration = cached.duration;
                state.update({ playlist: [...state.playlist] });
                return;
            }
        }

        const rawData = await (window as any).fileSystem.readFile(track.path);
        if (!rawData) {
            console.warn(`[Playlist] Analysis skipped for ${track.name} (File unreadable)`);
            return;
        }


        const arrayBuffer = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
        
        // Background decoding like a pro
        const decodeResult = await decoderPool.decode(arrayBuffer);
        const audioBuffer = createAudioBuffer(decodeResult);

        const bpm = await detectBPMWorker(audioBuffer);
        
        track.bpm = bpm; 
        track.duration = audioBuffer.duration;

        // 2. Persist to DB
        if (db) {
            await db.upsertTrack({
                id: track.id,
                path: track.path,
                name: track.name,
                duration: track.duration,
                bpm: track.bpm
            });
        }

        state.update({ playlist: [...state.playlist] });
    } catch (e) {
        console.error(`[Playlist] Failed to analyze ${track.name}`, e);
        track.bpm = 0; 
        state.update({ playlist: [...state.playlist] });
    }
}

export function addTracksToPlaylist(files: File[]): void {
    const currentPlaylist = [...state.playlist];
    const startIdx = currentPlaylist.length;
    files.forEach((file) => {
        const fullPath = (window as any).electronAPI.getPathForFile(file);
        const track: Track = { 
            id: Math.random().toString(36).substr(2, 9),
            name: file.name, 
            path: fullPath, 
            duration: 0, 
            bpm: undefined 
        };
        currentPlaylist.push(track);
        
        // Instant DB Indexing (metadata comes later via analysis)
        const db = (window as any).database;
        if (db) {
            db.upsertTrack({
                id: track.id,
                path: track.path,
                name: track.name,
                duration: 0,
                bpm: 0
            });
        }

        analyzeTrackInBackground(track);
    });

    state.update({ playlist: currentPlaylist });

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
    
    let bpmSuffix = " [...]";
    if (track.bpm !== null && track.bpm !== undefined) {
        bpmSuffix = track.bpm > 0 ? ` [${track.bpm} BPM]` : " [BPM: --]";
    }
    
    let blendSuffix = "";
    li.classList.remove('blending', 'selected', 'playing');

    if (index === state.blendingIndex) {
        blendSuffix = " [MIXING IN...]";
        li.classList.add('blending');
    }

    li.innerText = track.name + bpmSuffix + blendSuffix;
    
    if (state.selectedIndices.includes(index)) li.classList.add('selected');
    if (index === state.currentTrackIndex) li.classList.add('playing');
    
    // Only add listeners if it's a new element
    if (!existing) {
        li.addEventListener('click', (e) => {
            e.stopPropagation();
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

        li.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const idx = parseInt(li.dataset.index || "0");
            if (loadTrackFn) {
                loadTrackFn(idx).then(() => {
                    if (playTrackFn) playTrackFn();
                });
            }
        });

        li.addEventListener('mousedown', (e) => {
            if (e.button === 0) { 
                draggedIndex = parseInt(li.dataset.index || "0"); 
                dragStartY = e.clientY; 
            } 
        });

        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
                let x = e.pageX;
                let y = e.pageY;
                if (x + 180 > window.innerWidth) x = window.innerWidth - 180;
                if (y + 150 > window.innerHeight) y = window.innerHeight - 150;
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                menu.dataset.removeIndex = idx.toString(); 
            }
        });
    }

    li.dataset.index = index.toString();
    return li;
}

export function renderPlaylist(): void {
    if (vScroller) vScroller.refresh(true);
}

// === NEW: KEYBOARD NAVIGATION ===
export function handlePlaylistNavigation(e: KeyboardEvent): void {
    if (!state.playlist.length) return;
    
    // Ensure valid anchor/pivot if coming from empty state
    if (anchorIndex === -1) anchorIndex = 0;
    if (pivotIndex === -1) pivotIndex = anchorIndex;

    let newAnchor = anchorIndex;

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        newAnchor = Math.max(0, anchorIndex - 1);
        if (anchorIndex === -1 && state.playlist.length > 0) newAnchor = state.playlist.length - 1; 
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
    
    const currentPlaylist = [...state.playlist];
    const currentSelected = [...state.selectedIndices];
    
    // Sort descending to remove safe
    currentSelected.sort((a, b) => b - a);
    
    currentSelected.forEach(idx => {
        currentPlaylist.splice(idx, 1);
    });
    
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
        selectedIndices: newSelected 
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
        playlistEl.addEventListener('click', (e) => {
            // Only if directly clicking the container (empty space)
            if (e.target === playlistEl) {
                state.update({ selectedIndices: [] });
                pivotIndex = -1;
                anchorIndex = -1;
            }
        });

        // DRAG & DROP
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
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                addTracksToPlaylist(Array.from(e.dataTransfer.files));
            }
        });
    }

    document.addEventListener('mouseup', () => { draggedIndex = -1; isDragging = false; document.body.style.cursor = ''; });

    // === CONTEXT MENU ACTION HANDLERS ===
    const ctxRemove = document.getElementById('ctxRemove');
    const ctxMoveUp = document.getElementById('ctxMoveUp');
    const ctxMoveDown = document.getElementById('ctxMoveDown');
    const ctxPlay = document.getElementById('ctxPlay');

    if (ctxRemove) ctxRemove.addEventListener('click', () => {
        removeSelectedTracks();
    });

    if (ctxMoveUp) ctxMoveUp.addEventListener('click', () => {
        if (!state.selectedIndices.length) return;
        const currentPlaylist = [...state.playlist];
        const sorted = [...state.selectedIndices].sort((a,b) => a-b);
        if (sorted[0] > 0) {
            sorted.forEach(idx => {
                const temp = currentPlaylist[idx];
                currentPlaylist[idx] = currentPlaylist[idx-1];
                currentPlaylist[idx-1] = temp;
            });
            state.update({ 
                playlist: currentPlaylist,
                selectedIndices: sorted.map(i => i-1) 
            });
        }
    });

    if (ctxMoveDown) ctxMoveDown.addEventListener('click', () => {
        if (!state.selectedIndices.length) return;
        const currentPlaylist = [...state.playlist];
        const sorted = [...state.selectedIndices].sort((a,b) => b-a);
        if (sorted[0] < currentPlaylist.length - 1) {
             sorted.forEach(idx => {
                const temp = currentPlaylist[idx];
                currentPlaylist[idx] = currentPlaylist[idx+1];
                currentPlaylist[idx+1] = temp;
            });
            state.update({ 
                playlist: currentPlaylist,
                selectedIndices: sorted.map(i => i+1) 
            });
        }
    });

    if (ctxPlay) ctxPlay.addEventListener('click', () => {
         if (contextMenu) {
             const idxStr = contextMenu.dataset.removeIndex;
             if (idxStr) {
                 const idx = parseInt(idxStr);
                 if (!isNaN(idx)) {
                     if (loadTrackFn) loadTrackFn(idx);
                     if (playTrackFn) setTimeout(() => playTrackFn!(), 100);
                 }
             }
         }
    });
}
