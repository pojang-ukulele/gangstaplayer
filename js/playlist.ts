import { audioCtx } from './audio';
import { detectBPMWorker } from './worker-client';
import { state, Track } from './state';
import { VirtualScroller } from './reactive/ui';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import { engine } from './audio-engine';
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

let playlistEl: HTMLElement | null = null;
let playlistInput: HTMLInputElement | null = null;
let contextMenu: HTMLElement | null = null;

let loadTrackFn: ((index: number) => Promise<void>) | null = null;
let playTrackFn: (() => void) | null = null;
let vScroller: VirtualScroller<Track> | null = null;
const ITEM_HEIGHT = 26; // Pixels — compact single-line row

export function initPlaylist(deps: PlaylistDeps): void {
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
        db.getAllTracks().then((tracks: Track[]) => {
            if (tracks && tracks.length > 0) {
                // Selection indices were computed against the pre-load list
                state.update({ playlist: tracks, selectedIndices: [] });
                anchorIndex = -1;
                pivotIndex = -1;
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', async () => {
            const query = searchInput.value;
            if (db && query.length > 0) {
                const results = await db.searchTracks(query);
                // Filtered results invalidate every existing index
                state.update({ playlist: results, selectedIndices: [] });
                anchorIndex = -1;
                pivotIndex = -1;
            } else if (db) {
                const all = await db.getAllTracks();
                state.update({ playlist: all, selectedIndices: [] });
                anchorIndex = -1;
                pivotIndex = -1;
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
        const db = window.database;
        
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

        const rawData = await window.fileSystem.readFile(track.path);
        if (!rawData) {
            console.warn(`[Playlist] Analysis skipped for ${track.name} (File unreadable)`);
            return;
        }


        const arrayBuffer = normalizeToArrayBuffer(rawData);

        // Same validation policy as the sampler — reject non-audio early
        // instead of feeding garbage to the decoder.
        const validationError = validateAudioSignature(arrayBuffer, track.name);
        if (validationError) {
            console.warn(`[Playlist] Analysis skipped for ${track.name}: ${validationError}`);
            track.bpm = 0;
            state.update({ playlist: [...state.playlist] });
            return;
        }

        // Use native decoder (decoder pool workers are unreliable)
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

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
        console.warn(`[Playlist] BPM analysis skipped for ${track.name}`);
        track.bpm = 0; 
        state.update({ playlist: [...state.playlist] });
    }
}

export function addTracksToPlaylist(files: File[]): void {
    const currentPlaylist = [...state.playlist];
    const startIdx = currentPlaylist.length;
    files.forEach((file) => {
        const fullPath = window.electronAPI.getPathForFile(file);
        const track: Track = { 
            id: crypto.randomUUID(),
            name: file.name, 
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

    li.innerText = track.name + bpmSuffix + blendSuffix;
    
    if (state.selectedIndices.includes(index)) li.classList.add('selected');
    if (index === state.currentTrackIndex) li.classList.add('playing');
    
    // Only add listeners if it's a new element
    if (!existing) {
        li.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(li.dataset.index || "0");
            console.log(`[Playlist] Item Clicked: ${idx}`);
            
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
            console.log(`[Playlist] Item Dbl-Clicked: ${idx}`);
            if (loadTrackFn) {
                loadTrackFn(idx).then(() => {
                    console.log(`[Playlist] Track ${idx} loaded, triggering play...`);
                    if (playTrackFn) playTrackFn();
                }).catch(err => console.error(`[Playlist] Load failed for ${idx}:`, err));
            }
        });

        li.draggable = true;

        li.addEventListener('dragstart', (e) => {
            const idx = parseInt(li.dataset.index || "-1");
            if (idx < 0) { e.preventDefault(); return; }
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
            e.preventDefault();
            e.stopPropagation();
            if (!isDragging || draggedIndex < 0) return;
            
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
                
                // Use clientX/Y which are more reliable for fixed/absolute overlays in scrollable views
                let x = e.clientX;
                let y = e.clientY;
                
                // Keep menu within viewport
                const menuWidth = 180;
                const menuHeight = 150;
                if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth;
                if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight;
                
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

/**
 * Reorder the playlist by moving an item from `fromIndex` to `toIndex`.
 * If `insertAfter` is true, the item is placed after `toIndex` instead of before it.
 * Updates selection indices to follow the moved item.
 */
function reorderPlaylist(fromIndex: number, toIndex: number, insertAfter: boolean): void {
    const playlist = [...state.playlist];
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
    
    const currentPlaylist = [...state.playlist];
    const currentSelected = [...state.selectedIndices];
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
        // Kill audible playback of the removed track
        engine.main.audio.pause();
        engine.main.audio.src = "";
        state.update({ isPlaying: false, masterBPM: 0 });
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
        playlistEl.addEventListener('click', (e) => {
            // Only if directly clicking the container (empty space)
            if (e.target === playlistEl) {
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
             const idxStr = contextMenu.dataset.ctxIndex;
             if (idxStr) {
                 const idx = parseInt(idxStr);
                 if (!isNaN(idx)) {
                     if (loadTrackFn) {
                         loadTrackFn(idx).then(() => {
                             if (playTrackFn) playTrackFn();
                         });
                     }
                 }
             }
         }
    });
}
