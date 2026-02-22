import { DRAG_THRESHOLD_PX } from './constants.js';
import { audioCtx } from './audio.js';
import { detectBPMWorker } from './worker-client.js';
import { state } from './state.js';
let anchorIndex = -1;
let pivotIndex = -1; // Start of selection range
let draggedIndex = -1;
let isDragging = false;
let dragStartY = 0;

let playlistEl = null;

let playlistInput = null;
let contextMenu = null;

let loadTrackFn = null;
let playTrackFn = null;

export function initPlaylist(deps) {
    loadTrackFn = deps.loadTrack;
    playTrackFn = deps.playTrack;
    playlistEl = document.getElementById('playlist');
    playlistInput = document.getElementById('playlistInput');
    contextMenu = document.getElementById('contextMenu');
}

export function setBlendingIndex(index) {
    state.update({ blendingIndex: index });
    renderPlaylist();
}

/**
 * Background worker to analyze BPM for a track
 */
async function analyzeTrackInBackground(track) {
    try {
        const response = await fetch(track.url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const bpm = await detectBPMWorker(audioBuffer);
        track.bpm = bpm; 
        renderPlaylist();
    } catch (e) {
        console.error(`[Playlist] Failed to analyze ${track.name}`, e);
        track.bpm = 0; 
    }
}

export function addTracksToPlaylist(files) {
    const currentPlaylist = [...state.playlist];
    const startIdx = currentPlaylist.length;
    files.forEach((file) => {
        const track = { 
            name: file.name, 
            url: URL.createObjectURL(file),
            bpm: null 
        };
        currentPlaylist.push(track);
        analyzeTrackInBackground(track);
    });

    state.update({ playlist: currentPlaylist });
    renderPlaylist();
    if (startIdx === 0 && state.playlist.length > 0 && loadTrackFn) {
        loadTrackFn(0);
        // Auto select first
        state.update({
            selectedIndices: [0]
        });
        anchorIndex = 0;
        pivotIndex = 0;
        renderPlaylist();
    }
}

export function renderPlaylist() {
    if (!playlistEl) return;
    playlistEl.innerHTML = '';
    state.playlist.forEach((track, index) => {
        const li = document.createElement('li');
        
        let bpmSuffix = " [...]";
        if (track.bpm !== null && track.bpm !== undefined) {
            bpmSuffix = track.bpm > 0 ? ` [${track.bpm} BPM]` : " [BPM: --]";
        }
        
        let blendSuffix = "";
        if (index === state.blendingIndex) {
            blendSuffix = " [MIXING IN...]";
            li.classList.add('blending');
        }

        li.innerText = track.name + bpmSuffix + blendSuffix;
        
        if (state.selectedIndices.includes(index)) li.classList.add('selected');
        if (index === state.currentTrackIndex) li.classList.add('playing');
        
        li.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent background click from deselecting
            
            const currentSelected = [...state.selectedIndices];
            if (e.ctrlKey || e.metaKey) {
                const i = currentSelected.indexOf(index);
                if (i !== -1) currentSelected.splice(i, 1); 
                else currentSelected.push(index);
                anchorIndex = index;
                pivotIndex = index;
                state.update({ selectedIndices: currentSelected });
            } else if (e.shiftKey) {
                if (pivotIndex === -1) pivotIndex = anchorIndex !== -1 ? anchorIndex : index;
                
                const s = Math.min(pivotIndex, index);
                const e_ = Math.max(pivotIndex, index);
                const range = Array.from({length: e_ - s + 1}, (_, i) => s + i);
                state.update({ selectedIndices: range });
                anchorIndex = index;
            } else {
                state.update({ selectedIndices: [index] });
                anchorIndex = index;
                pivotIndex = index;
            }
            renderPlaylist();
        });

        li.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (loadTrackFn) {
                loadTrackFn(index).then(() => {
                    if (playTrackFn) playTrackFn();
                }).catch(err => console.error("DblClick Playback Failed:", err));
            }
        });

        li.addEventListener('mousedown', (e) => {
            if (e.button === 0) { 
                draggedIndex = index; 
                dragStartY = e.clientY; 
            } 
        });

        // Right-Click Context Menu
        li.addEventListener('contextmenu', (e) => {
             e.preventDefault();
             e.stopPropagation();
             // 1. Select if not selected
             if (!state.selectedIndices.includes(index)) {
                 state.update({ selectedIndices: [index] });
                 anchorIndex = index;
                 pivotIndex = index;
                 renderPlaylist();
             }
             
             // 2. Show Menu
             const menu = document.getElementById('contextMenu');
             if (menu) {
                 menu.classList.remove('hidden');
                 menu.style.display = 'block'; // Force visibility
                 menu.style.zIndex = '9999';
                 
                 // Bounds
                 let x = e.pageX;
                 let y = e.pageY;
                 if (x + 180 > window.innerWidth) x = window.innerWidth - 180;
                 if (y + 150 > window.innerHeight) y = window.innerHeight - 150;
                 
                 menu.style.left = x + 'px';
                 menu.style.top = y + 'px';
                 
                 // Store index for actions
                 menu.dataset.removeIndex = index; 
             }
        });

        playlistEl.appendChild(li);
    });
}

// === NEW: KEYBOARD NAVIGATION ===
export function handlePlaylistNavigation(e) {
    if (!state.playlist.length) return;
    
    // Ensure valid anchor/pivot if coming from empty state
    if (anchorIndex === -1) anchorIndex = 0;
    if (pivotIndex === -1) pivotIndex = anchorIndex;

    const lastAnchor = anchorIndex;
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
    
    renderPlaylist();
    // Scroll into view
    if (playlistEl && playlistEl.children[anchorIndex]) {
        playlistEl.children[anchorIndex].scrollIntoView({ block: 'nearest' });
    }
}

export function removeSelectedTracks() {
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

    const newSelected = [];
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
    
    renderPlaylist();
}

export function setupPlaylistHandlers() {
    if (playlistInput) {
        playlistInput.addEventListener('change', (e) => {
            addTracksToPlaylist(Array.from(e.target.files));
            e.target.value = ''; // FIX: Allow re-adding same file
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
                renderPlaylist();
            }
        });

        // DRAG & DROP
        playlistEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            playlistEl.classList.add('drag-over');
        });

        playlistEl.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            playlistEl.classList.remove('drag-over');
        });

        playlistEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            playlistEl.classList.remove('drag-over');
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
            renderPlaylist();
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
            renderPlaylist();
        }
    });

    if (ctxPlay) ctxPlay.addEventListener('click', () => {
         const idx = parseInt(contextMenu.dataset.removeIndex);
         if (!isNaN(idx)) {
             if (loadTrackFn) loadTrackFn(idx);
             if (playTrackFn) setTimeout(() => playTrackFn(), 100);
         }
    });
}
