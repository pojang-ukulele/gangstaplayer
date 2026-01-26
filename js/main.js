// === MAIN ENTRY POINT ===
// Gangsta Player Pro 3 - Modular Architecture
// This is the orchestrator that imports and initializes all modules
import { KEYBOARD_MAP } from './constants.js';
import { resumeAudioContext } from './audio.js';
import { enableMIDI, initMIDI } from './midi.js';
import { 
    initSampler, createPadGrid, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, loadSampleFile, loadSampleFromPath, toggleSync,
    padBuffers, activeVoices, padVolumes, padSyncState
} from './sampler.js';
import { 
    initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    detectBPM, getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    playerAudio, currentTrackIndex, stopPlayback
} from './player.js';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, playlist, setBlendingIndex, handlePlaylistNavigation } from './playlist.js';
import { initSettings, setupSettingsHandlers, loadSettings } from './settings.js';
import { initVisuals, playStartupSound } from './visuals.js';

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

async function initApp() {
    console.log('[GANGSTA PLAYER PRO 3] Initializing Modules...');
    
    // Window Controls
    const minBtn = document.getElementById('minBtn');
    const maxBtn = document.getElementById('maxBtn');
    const closeBtn = document.getElementById('closeBtn');
    if (minBtn) minBtn.addEventListener('click', () => bridge.minimize());
    if (maxBtn) maxBtn.addEventListener('click', () => bridge.maximize());
    if (closeBtn) closeBtn.addEventListener('click', () => bridge.close());

    initSampler({
        fsBridge, bridge, detectBPM,
        masterBPMRef: getMasterBPMRef(),
        tempoSlider: getTempoSlider()
    });

    initPlayer({ playlist, renderPlaylist, setBlendingIndex });

    initPlaylist({
        loadTrack, playTrack,
        currentTrackIndexRef: { get value() { return currentTrackIndex; } }
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ bridge, playerAudio, setAutoMixEnabled });

    // Initialize UI components
    createPadGrid();
    initVisuals();
    
    // Setup handlers
    setupPadKeyboardHandlers();
    setupPlayerHandlers();
    setupPlaylistHandlers();
    // setupSettingsHandlers(); // Already called in initSettings
    // loadSettings();          // Already called in initSettings

    // Context Menu for Pads
    const padGrid = getPadGrid();
    const padContextMenu = document.getElementById('padContextMenu');
    const ctxLoadSample = document.getElementById('ctxLoadSample');
    const ctxSync = document.getElementById('ctxSync');
    const padCtxDivider = document.getElementById('padCtxDivider');

    if (padGrid && padContextMenu) {
        for (let i = 0; i < 16; i++) {
            const padWrapper = padGrid.children[i];
            const pad = padWrapper?.querySelector('.pad');
            if (pad) {
                pad.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (padBuffers[i]) {
                        if (ctxSync) ctxSync.classList.remove('hidden');
                        if (padCtxDivider) padCtxDivider.classList.remove('hidden');
                        if (padSyncState[i] && ctxSync) {
                            ctxSync.classList.add('sync-active');
                            ctxSync.innerText = 'SYNC ✓';
                        } else if (ctxSync) {
                            ctxSync.classList.remove('sync-active');
                            ctxSync.innerText = 'SYNC';
                        }
                    } else {
                        if (ctxSync) ctxSync.classList.add('hidden');
                        if (padCtxDivider) padCtxDivider.classList.add('hidden');
                    }
                    padContextMenu.classList.remove('hidden');
                    padContextMenu.setAttribute('aria-hidden', 'false');
                    padContextMenu.style.left = e.pageX + 'px';
                    padContextMenu.style.top = e.pageY + 'px';
                    padContextMenu.dataset.padIndex = i;
                });
                pad.addEventListener('mousedown', (e) => { if (e.button === 0 && padBuffers[i]) startPad(i); });
                pad.addEventListener('mouseup', () => stopPad(i));
                pad.addEventListener('mouseleave', () => stopPad(i));
                pad.addEventListener('click', async () => {
                    if (!padBuffers[i]) {
                        const filePath = await bridge.openSampleDialog();
                        if (filePath) await loadSampleFromPath(filePath, i);
                    }
                });
            }
        }
    }

    // Global Click Handler to hide menus
    document.addEventListener('click', () => {
        const playlistCtxMenu = document.getElementById('contextMenu');
        if (playlistCtxMenu) {
            playlistCtxMenu.classList.add('hidden');
            playlistCtxMenu.setAttribute('aria-hidden', 'true');
        }
        if (padContextMenu) {
            padContextMenu.classList.add('hidden');
            padContextMenu.setAttribute('aria-hidden', 'true');
        }
    });

    if (ctxLoadSample) {
        ctxLoadSample.addEventListener('click', async () => {
            const index = parseInt(padContextMenu.dataset.padIndex);
            const filePath = await bridge.openSampleDialog();
            if (filePath) await loadSampleFromPath(filePath, index);
        });
    }
    if (ctxSync) {
        ctxSync.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex);
            toggleSync(index);
        });
    }

    // === GLOBAL KEYBOARD SHORTCUTS ===
    document.addEventListener('keydown', (e) => {
        // Ignore if user is typing in an input
        if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

        // Transport
        if (e.code === 'Space') {
            e.preventDefault(); 
            if (playerAudio) {
                if (!playerAudio.paused) pauseTrack(); else playTrack();
            }
        } else if (e.code === 'Enter') {
            e.preventDefault();
            stopPlayback();
        } 
        
        // Playlist Navigation
        if (['ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(e.key)) {
            handlePlaylistNavigation(e);
        }
    });

    // Startup sequence completion
    playStartupSound();
    if (bridge?.appReadyToShow) bridge.appReadyToShow();

    // === MASTER RECORDING LOGIC ===
    const recBtn = document.getElementById('masterRecBtn');
    let mediaRecorder;
    let recordedChunks = [];
    let isRecording = false;

    if (recBtn) {
        recBtn.addEventListener('click', async () => {
            if (!isRecording) {
                // START RECORDING
                const { masterGain, audioCtx, bufferToWave } = await import('./audio.js'); 
                if (!mediaRecorder) {
                    const dest = audioCtx.createMediaStreamDestination();
                    masterGain.connect(dest);
                    // Standard WebM recording
                    mediaRecorder = new MediaRecorder(dest.stream);
                    
                    mediaRecorder.ondataavailable = (e) => {
                        if (e.data.size > 0) recordedChunks.push(e.data);
                    };
                    
                    mediaRecorder.onstop = async () => {
                        // 1. Create WebM Blob from chunks
                        const webmBlob = new Blob(recordedChunks, { type: 'audio/webm' });
                        recordedChunks = [];
                        
                        // 2. Decode WebM to PCM AudioBuffer
                        const arrayBuffer = await webmBlob.arrayBuffer();
                        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                        
                        // 3. Convert PCM to valid seekable WAV Blob
                        const wavBlob = bufferToWave(audioBuffer);
                        const wavBuffer = await wavBlob.arrayBuffer();

                        // 4. Save
                        const path = await bridge.saveAudioDialog();
                        if (path) {
                             await fsBridge.saveFile(path, new Uint8Array(wavBuffer));
                             alert("Recording Saved!");
                        }
                        
                        recBtn.classList.remove('recording');
                        recBtn.innerText = "REC";
                        isRecording = false;
                    };
                }
                
                recordedChunks = [];
                mediaRecorder.start();
                isRecording = true;
                recBtn.classList.add('recording');
                recBtn.innerText = "STOP";
                
            } else {
                // STOP RECORDING
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                }
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();



    // === MASTER RECORDING LOGIC MOVED TO initApp ===
}

document.body.addEventListener('click', () => { resumeAudioContext(); enableMIDI(); }, { once: true });
