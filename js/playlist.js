// === PLAYLIST MODULE ===
import { DRAG_THRESHOLD_PX } from './constants.js';
import { audioCtx } from './audio.js';
import { detectBPM } from './player.js';

export let playlist = [];
export let selectedIndices = [];
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
let currentTrackIndexRef = { value: 0 };
let blendingIndex = -1; 

export function initPlaylist(deps) {
    loadTrackFn = deps.loadTrack;
    playTrackFn = deps.playTrack;
    currentTrackIndexRef = deps.currentTrackIndexRef;
    playlistEl = document.getElementById('playlist');
    playlistInput = document.getElementById('playlistInput');
    contextMenu = document.getElementById('contextMenu');
}

export function setBlendingIndex(index) {
    blendingIndex = index;
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
        const bpm = detectBPM(audioBuffer);
        track.bpm = bpm; 
        renderPlaylist();
    } catch (e) {
        console.error(`[Playlist] Failed to analyze ${track.name}`, e);
        track.bpm = 0; 
    }
}

export function addTracksToPlaylist(files) {
    const startIdx = playlist.length;
    files.forEach((file, i) => {
        const track = { 
            name: file.name, 
            url: URL.createObjectURL(file),
            bpm: null 
        };
        playlist.push(track);
        analyzeTrackInBackground(track);
    });

    renderPlaylist();
    if (startIdx === 0 && playlist.length > 0 && loadTrackFn) {
        loadTrackFn(0);
        // Auto select first
        selectedIndices = [0];
        anchorIndex = 0;
        pivotIndex = 0;
        renderPlaylist();
    }
}

export function renderPlaylist() {
    if (!playlistEl) return;
    playlistEl.innerHTML = '';
    playlist.forEach((track, index) => {
        const li = document.createElement('li');
        
        let bpmSuffix = " [...]";
        if (track.bpm !== null && track.bpm !== undefined) {
            bpmSuffix = track.bpm > 0 ? ` [${track.bpm} BPM]` : " [BPM: --]";
        }
        
        let blendSuffix = "";
        if (index === blendingIndex) {
            blendSuffix = " [MIXING IN...]";
            li.classList.add('blending');
        }

        li.innerText = track.name + bpmSuffix + blendSuffix;
        
        if (selectedIndices.includes(index)) li.classList.add('selected');
        if (index === currentTrackIndexRef.value) li.classList.add('playing');
        
        li.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent background click from deselecting
            
            if (e.ctrlKey || e.metaKey) {
                const i = selectedIndices.indexOf(index);
                if (i !== -1) selectedIndices.splice(i, 1); 
                else selectedIndices.push(index);
                anchorIndex = index;
                pivotIndex = index;
            } else if (e.shiftKey) {
                if (pivotIndex === -1) pivotIndex = anchorIndex !== -1 ? anchorIndex : index;
                
                const s = Math.min(pivotIndex, index);
                const e_ = Math.max(pivotIndex, index);
                selectedIndices = Array.from({length: e_ - s + 1}, (_, i) => s + i);
                anchorIndex = index;
            } else {
                selectedIndices = [index];
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
             if (!selectedIndices.includes(index)) {
                 selectedIndices = [index];
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
    if (!playlist.length) return;
    
    // Ensure valid anchor/pivot if coming from empty state
    if (anchorIndex === -1) anchorIndex = 0;
    if (pivotIndex === -1) pivotIndex = anchorIndex;

    const lastAnchor = anchorIndex;
    let newAnchor = anchorIndex;

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        newAnchor = Math.max(0, anchorIndex - 1);
        if (anchorIndex === -1 && playlist.length > 0) newAnchor = playlist.length - 1; 
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        newAnchor = Math.min(playlist.length - 1, anchorIndex + 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
         if (selectedIndices.length > 0) {
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
        selectedIndices = Array.from({length: e_ - s + 1}, (_, i) => s + i);
    } else {
        // Single Selection
        selectedIndices = [newAnchor];
        pivotIndex = newAnchor;
    }
    
    renderPlaylist();
    // Scroll into view
    if (playlistEl && playlistEl.children[anchorIndex]) {
        playlistEl.children[anchorIndex].scrollIntoView({ block: 'nearest' });
    }
}

export function removeSelectedTracks() {
    if (!selectedIndices.length) return;
    
    // Sort descending to remove safe
    selectedIndices.sort((a, b) => b - a);
    
    let isPlayingRemoved = false;
    
    selectedIndices.forEach(idx => {
        if (idx === currentTrackIndexRef.value) isPlayingRemoved = true;
        playlist.splice(idx, 1);
    });
    
    selectedIndices = [];
    anchorIndex = Math.min(anchorIndex, playlist.length - 1);
    pivotIndex = anchorIndex; 

    if (anchorIndex < 0 && playlist.length > 0) {
        anchorIndex = 0;
        pivotIndex = 0;
    }
    
    if (playlist.length > 0) selectedIndices = [anchorIndex];
    else {
        anchorIndex = -1;
        pivotIndex = -1;
    }
    
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
                selectedIndices = [];
                pivotIndex = -1;
                anchorIndex = -1;
                renderPlaylist();
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
        // Use removeIndex if single click (or just use selection if multi)
        // Usually context menu acts on selection if target IS in selection.
        // Or if target is outside, it selects target first (which we implemented in contextmenu handler).
        // So relying on 'selectedIndices' is robust.
        removeSelectedTracks();
    });

    if (ctxMoveUp) ctxMoveUp.addEventListener('click', () => {
        const e = { key: 'ArrowUp', shiftKey: false, preventDefault: () => {} }; // Simulating move logic? 
        // No, ArrowUp changes SELECTION. We want to MOVE ITEMS.
        // We lack specific moveUp logic export, but we can reuse the logic from render.js or implement here.
        // Let's implement Move Up/Down simple logic here.
        if (!selectedIndices.length) return;
        const sorted = [...selectedIndices].sort((a,b) => a-b);
        if (sorted[0] > 0) {
            // Swap bubble up
            sorted.forEach(idx => {
                const temp = playlist[idx];
                playlist[idx] = playlist[idx-1];
                playlist[idx-1] = temp;
            });
            selectedIndices = sorted.map(i => i-1);
            renderPlaylist();
        }
    });

    if (ctxMoveDown) ctxMoveDown.addEventListener('click', () => {
        if (!selectedIndices.length) return;
        const sorted = [...selectedIndices].sort((a,b) => b-a);
        if (sorted[0] < playlist.length - 1) {
             sorted.forEach(idx => {
                const temp = playlist[idx];
                playlist[idx] = playlist[idx+1];
                playlist[idx+1] = temp;
            });
            selectedIndices = sorted.map(i => i+1);
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
