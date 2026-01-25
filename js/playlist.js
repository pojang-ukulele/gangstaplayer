// === PLAYLIST MODULE ===
import { DRAG_THRESHOLD_PX } from './constants.js';

export let playlist = [];
export let selectedIndices = [];
let anchorIndex = -1;
let draggedIndex = -1;
let isDragging = false;
let dragStartY = 0;

let playlistEl = null;
let playlistInput = null;
let contextMenu = null;

let loadTrackFn = null;
let playTrackFn = null;
let currentTrackIndexRef = { value: 0 };

export function initPlaylist(deps) {
    loadTrackFn = deps.loadTrack;
    playTrackFn = deps.playTrack;
    currentTrackIndexRef = deps.currentTrackIndexRef;
    playlistEl = document.getElementById('playlist');
    playlistInput = document.getElementById('playlistInput');
    contextMenu = document.getElementById('contextMenu');
}

export function addTracksToPlaylist(files) {
    files.forEach(file => playlist.push({ name: file.name, url: URL.createObjectURL(file) }));
    renderPlaylist();
    if (playlist.length === files.length && loadTrackFn) loadTrackFn(0);
}

export function renderPlaylist() {
    if (!playlistEl) return;
    playlistEl.innerHTML = '';
    playlist.forEach((track, index) => {
        const li = document.createElement('li');
        li.innerText = track.name;
        if (selectedIndices.includes(index)) li.classList.add('selected');
        if (index === currentTrackIndexRef.value) li.classList.add('playing');
        li.onclick = (e) => {
            if (e.ctrlKey || e.metaKey) {
                const i = selectedIndices.indexOf(index);
                if (i !== -1) selectedIndices.splice(i, 1); else selectedIndices.push(index);
            } else if (e.shiftKey && anchorIndex !== -1) {
                const s = Math.min(anchorIndex, index), e_ = Math.max(anchorIndex, index);
                selectedIndices = Array.from({length: e_ - s + 1}, (_, i) => s + i);
            } else {
                selectedIndices = [index];
                anchorIndex = index;
            }
            renderPlaylist();
        };
        li.ondblclick = () => loadTrackFn && loadTrackFn(index).then(() => playTrackFn?.());
        li.onmousedown = (e) => { if (e.button === 0) { draggedIndex = index; dragStartY = e.clientY; } };
        playlistEl.appendChild(li);
    });
}

export function setupPlaylistHandlers() {
    if (playlistInput) playlistInput.addEventListener('change', (e) => addTracksToPlaylist(Array.from(e.target.files)));
    document.addEventListener('mouseup', () => { draggedIndex = -1; isDragging = false; document.body.style.cursor = ''; });
}
