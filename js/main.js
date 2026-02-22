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
import { initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    getPlayerAudio, stopPlayback
} from './player.js';
import { detectBPMWorker } from './worker-client.js';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, setBlendingIndex, handlePlaylistNavigation } from './playlist.js';
import { initSettings, setupSettingsHandlers, loadSettings } from './settings.js';
import { initVisuals, playStartupSound } from './visuals.js';
import { state } from './state.js';
import { toast } from './toast.js';

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

async function initApp() {
    console.log('[GANGSTA PLAYER PRO 3] Initializing Modules...');
    applyPlatformStyles();
    
    // Window Controls
    const minBtn = document.getElementById('minBtn');
    const maxBtn = document.getElementById('maxBtn');
    const closeBtn = document.getElementById('closeBtn');
    if (minBtn) minBtn.addEventListener('click', () => bridge.minimize());
    if (maxBtn) maxBtn.addEventListener('click', () => bridge.maximize());
    if (closeBtn) closeBtn.addEventListener('click', () => bridge.close());

    initSampler({
        fsBridge, bridge, 
        detectBPM: detectBPMWorker,
        masterBPMRef: getMasterBPMRef(),
        tempoSlider: getTempoSlider()
    });

    initPlayer({ renderPlaylist, setBlendingIndex });

    initPlaylist({
        loadTrack, playTrack
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ bridge, playerAudio: getPlayerAudio(), setAutoMixEnabled });

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

    // Global Click Handler to hide menus (handled later with unified logic)

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
                        const wavBlob = await bufferToWave(audioBuffer);
                        const wavBuffer = await wavBlob.arrayBuffer();

                        // 4. Save
                        const path = await bridge.saveAudioDialog();
                        if (path) {
                             await fsBridge.saveFile(path, new Uint8Array(wavBuffer));
                             toast.success("RECORDING SAVED TO DISK");
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

    // Manual Button
    const btnOpenManual = document.getElementById('btnOpenManual');
    if (btnOpenManual) {
        btnOpenManual.addEventListener('click', () => {
             bridge.openExternal('README.txt');
        });
    }
    // === PLAY BUTTON CONTEXT MENU ===
    const playPauseBtn = document.getElementById('playPauseBtn');
    const playContextMenu = document.getElementById('playContextMenu');
    const ctxPlayContinuous = document.getElementById('ctxPlayContinuous');
    const ctxPlaySingle = document.getElementById('ctxPlaySingle');
    const { getPlaybackMode, setPlaybackMode } = await import('./player.js');

    if (playPauseBtn && playContextMenu) {
        playPauseBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Hide others
            if (padContextMenu) padContextMenu.classList.add('hidden');
            const playlistCtxMenu = document.getElementById('contextMenu');
            if (playlistCtxMenu) playlistCtxMenu.classList.add('hidden');

            // Update Checks
            const mode = getPlaybackMode();
            if (ctxPlayContinuous) ctxPlayContinuous.innerText = `CONTINUOUS PLAYBACK ${mode === 'continuous' ? '✓' : ''}`;
            if (ctxPlaySingle) ctxPlaySingle.innerText = `STOP AFTER CURRENT ${mode === 'single' ? '✓' : ''}`;

            // Show
            playContextMenu.classList.remove('hidden');
            playContextMenu.setAttribute('aria-hidden', 'false');
            playContextMenu.style.left = e.pageX + 'px';
            playContextMenu.style.top = e.pageY + 'px';
        });
    }

    if (ctxPlayContinuous) {
        ctxPlayContinuous.addEventListener('click', () => {
            setPlaybackMode('continuous');
            playContextMenu.classList.add('hidden');
        });
    }
    if (ctxPlaySingle) {
        ctxPlaySingle.addEventListener('click', () => {
            setPlaybackMode('single');
            playContextMenu.classList.add('hidden');
        });
    }



    // === LOOP BUTTON CONTEXT MENU ===
    const loopBtn = document.getElementById('loopBtn');
    const loopContextMenu = document.getElementById('loopContextMenu');
    const ctxLoopOff = document.getElementById('ctxLoopOff');
    const ctxLoopOne = document.getElementById('ctxLoopOne');
    const ctxLoopAll = document.getElementById('ctxLoopAll');
    const { getLoopMode, setLoopMode } = await import('./player.js');

    if (loopBtn && loopContextMenu) {
        // Right Click: Show Menu
        loopBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Hide others
            if (padContextMenu) padContextMenu.classList.add('hidden');
            if (playContextMenu) playContextMenu.classList.add('hidden');
            const playlistCtxMenu = document.getElementById('contextMenu');
            if (playlistCtxMenu) playlistCtxMenu.classList.add('hidden');

            // Update Checks
            const mode = getLoopMode();
            if (ctxLoopOff) ctxLoopOff.innerText = `LOOP OFF ${mode === 'off' ? '✓' : ''}`;
            if (ctxLoopOne) ctxLoopOne.innerText = `LOOP CURRENT TRACK ${mode === 'one' ? '✓' : ''}`;
            if (ctxLoopAll) ctxLoopAll.innerText = `LOOP PLAYLIST ${mode === 'all' ? '✓' : ''}`;

            // Show
            loopContextMenu.classList.remove('hidden');
            loopContextMenu.setAttribute('aria-hidden', 'false');
            loopContextMenu.style.left = e.pageX + 'px';
            loopContextMenu.style.top = e.pageY + 'px';
        });

        // Left Click: Toggle (Off -> One -> All -> Off) or (Off <-> Last Selected)?
        // User request: "select to loop current song, or loop the playlist... and same kind of visual feedback when selected"
        // Let's make Left Click cycle through modes for convenience, or just toggle One/Off?
        // Standard behavior for Loop button: Toggle Off/One/All.
        loopBtn.addEventListener('click', () => {
             const current = getLoopMode();
             let next = 'off';
             if (current === 'off') next = 'one';
             else if (current === 'one') next = 'all';
             else if (current === 'all') next = 'off';
             
             setLoopMode(next);
             
             // Update Visual Feedback on Button? 
             // Maybe add active class if not off?
             if (next !== 'off') loopBtn.classList.add('active-loop');
             else loopBtn.classList.remove('active-loop');

             // Optional: Show brief toast or log?
        });
    }

    if (ctxLoopOff) {
        ctxLoopOff.addEventListener('click', () => {
            setLoopMode('off');
            loopBtn.classList.remove('active-loop');
            loopContextMenu.classList.add('hidden');
        });
    }
    if (ctxLoopOne) {
        ctxLoopOne.addEventListener('click', () => {
            setLoopMode('one');
            loopBtn.classList.add('active-loop');
            loopContextMenu.classList.add('hidden');
        });
    }
    if (ctxLoopAll) {
        ctxLoopAll.addEventListener('click', () => {
            setLoopMode('all');
            loopBtn.classList.add('active-loop');
            loopContextMenu.classList.add('hidden');
        });
    }

    // React to state changes
    state.subscribe(() => {
        // Many UI updates are already handled by direct calls in modules, 
        // but this is where we'd add cross-module sync if needed.
    });


    // Global Click Handler (Update existing one to include loopContextMenu)
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
        if (playContextMenu) {
            playContextMenu.classList.add('hidden');
            playContextMenu.setAttribute('aria-hidden', 'true');
        }
        if (loopContextMenu) {
            loopContextMenu.classList.add('hidden');
            loopContextMenu.setAttribute('aria-hidden', 'true');
        }
    });

if (document.readyState === 'loading') {
    
function applyPlatformStyles() {
    // Apply Electron-specific styles programmatically to avoid CSS linter warnings
    const style = document.createElement('style');
    style.textContent = `
        .title-bar { -webkit-app-region: drag; }
        .window-controls, .kit-controls { -webkit-app-region: no-drag; }
        * { -webkit-user-drag: none; }
    `;
    document.head.appendChild(style);
}

document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();



    // === MASTER RECORDING LOGIC MOVED TO initApp ===
}

document.body.addEventListener('click', () => { resumeAudioContext(); enableMIDI(); }, { once: true });
