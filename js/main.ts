// === MAIN ENTRY POINT ===
// Gangsta Player Pro 3 - Modular Architecture
import { resumeAudioContext, masterGain, audioCtx, bufferToWave, initWorklets } from './audio';
import { enableMIDI, initMIDI } from './midi';
import { 
    initSampler, createPadGrid, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, loadSampleFromPath, toggleSync,
    padBuffers, activeVoices, padVolumes, padSyncState
} from './sampler';
import { 
    initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    getPlayerAudio, stopPlayback, getPlaybackMode, setPlaybackMode,
    getLoopMode, setLoopMode
} from './player';
import { detectBPMWorker } from './worker-client';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, setBlendingIndex, handlePlaylistNavigation } from './playlist';
import { initSettings, setupSettingsHandlers, loadSettings } from './settings';
import { initVisuals, playStartupSound } from './visuals';
import { engine } from './audio-engine';
import { state } from './state';
import { toast } from './toast';

declare global {
    interface Window {
        electronAPI: any;
        fileSystem: any;
    }
}

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

async function initApp() {
    console.log('[GANGSTA PLAYER PRO 3] Initializing Modules...');
    applyPlatformStyles();
    
    // Initialize Worklets first
    await initWorklets();
    engine.initWorklets();
    
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
        tempoSlider: getTempoSlider() as HTMLInputElement
    });

    initPlayer({ playlist: state.playlist, renderPlaylist, setBlendingIndex });

    initPlaylist({
        loadTrack, playTrack
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ setAutoMixEnabled });

    // Initialize UI components
    createPadGrid();
    initVisuals();
    
    // Setup handlers
    setupPadKeyboardHandlers();
    setupPlayerHandlers();
    setupPlaylistHandlers();
    setupSettingsHandlers();
    loadSettings();

    // Context Menu for Pads
    const padGrid = getPadGrid();
    const padContextMenu = document.getElementById('padContextMenu');
    const ctxLoadSample = document.getElementById('ctxLoadSample');
    const ctxSync = document.getElementById('ctxSync');
    const padCtxDivider = document.getElementById('padCtxDivider');

    if (padGrid && padContextMenu) {
        for (let i = 0; i < 16; i++) {
            const padWrapper = padGrid.children[i];
            const pad = padWrapper?.querySelector('.pad') as HTMLElement;
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
                    padContextMenu.dataset.padIndex = i.toString();
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

    if (ctxLoadSample && padContextMenu) {
        ctxLoadSample.addEventListener('click', async () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            const filePath = await bridge.openSampleDialog();
            if (filePath) await loadSampleFromPath(filePath, index);
        });
    }
    if (ctxSync && padContextMenu) {
        ctxSync.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            toggleSync(index);
        });
    }

    // === GLOBAL KEYBOARD SHORTCUTS ===
    document.addEventListener('keydown', (e) => {
        // Ignore if user is typing in an input
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') return;

        // Transport
        if (e.code === 'Space') {
            e.preventDefault(); 
            const playerAudio = getPlayerAudio();
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
    let mediaRecorder: MediaRecorder | null = null;
    let recordedChunks: Blob[] = [];
    let isRecording = false;

    if (recBtn) {
        recBtn.addEventListener('click', async () => {
            if (!isRecording) {
                // START RECORDING
                if (!mediaRecorder) {
                    const dest = audioCtx.createMediaStreamDestination();
                    masterGain.connect(dest);
                    mediaRecorder = new MediaRecorder(dest.stream);
                    
                    mediaRecorder.ondataavailable = (e) => {
                        if (e.data.size > 0) recordedChunks.push(e.data);
                    };
                    
                    mediaRecorder.onstop = async () => {
                        const webmBlob = new Blob(recordedChunks, { type: 'audio/webm' });
                        recordedChunks = [];
                        
                        const arrayBuffer = await webmBlob.arrayBuffer();
                        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                        
                        const wavBlob = await bufferToWave(audioBuffer);
                        const wavBuffer = await wavBlob.arrayBuffer();

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

    if (playPauseBtn && playContextMenu) {
        playPauseBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Hide others
            if (padContextMenu) padContextMenu.classList.add('hidden');
            const playlistCtxMenu = document.getElementById('contextMenu');
            if (playlistCtxMenu) playlistCtxMenu.classList.add('hidden');

            const mode = getPlaybackMode();
            if (ctxPlayContinuous) ctxPlayContinuous.innerText = `CONTINUOUS PLAYBACK ${mode === 'continuous' ? '✓' : ''}`;
            if (ctxPlaySingle) ctxPlaySingle.innerText = `STOP AFTER CURRENT ${mode === 'single' ? '✓' : ''}`;

            playContextMenu.classList.remove('hidden');
            playContextMenu.setAttribute('aria-hidden', 'false');
            playContextMenu.style.left = e.pageX + 'px';
            playContextMenu.style.top = e.pageY + 'px';
        });
    }

    if (ctxPlayContinuous) {
        ctxPlayContinuous.addEventListener('click', () => {
            setPlaybackMode('continuous');
            playContextMenu?.classList.add('hidden');
        });
    }
    if (ctxPlaySingle) {
        ctxPlaySingle.addEventListener('click', () => {
            setPlaybackMode('single');
            playContextMenu?.classList.add('hidden');
        });
    }

    // === LOOP BUTTON CONTEXT MENU ===
    const loopBtn = document.getElementById('loopBtn');
    const loopContextMenu = document.getElementById('loopContextMenu');
    const ctxLoopOff = document.getElementById('ctxLoopOff');
    const ctxLoopOne = document.getElementById('ctxLoopOne');
    const ctxLoopAll = document.getElementById('ctxLoopAll');

    if (loopBtn && loopContextMenu) {
        loopBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (padContextMenu) padContextMenu.classList.add('hidden');
            if (playContextMenu) playContextMenu.classList.add('hidden');
            const playlistCtxMenu = document.getElementById('contextMenu');
            if (playlistCtxMenu) playlistCtxMenu.classList.add('hidden');

            const mode = getLoopMode();
            if (ctxLoopOff) ctxLoopOff.innerText = `LOOP OFF ${mode === 'off' ? '✓' : ''}`;
            if (ctxLoopOne) ctxLoopOne.innerText = `LOOP CURRENT TRACK ${mode === 'one' ? '✓' : ''}`;
            if (ctxLoopAll) ctxLoopAll.innerText = `LOOP PLAYLIST ${mode === 'all' ? '✓' : ''}`;

            loopContextMenu.classList.remove('hidden');
            loopContextMenu.setAttribute('aria-hidden', 'false');
            loopContextMenu.style.left = e.pageX + 'px';
            loopContextMenu.style.top = e.pageY + 'px';
        });

        loopBtn.addEventListener('click', () => {
             const current = getLoopMode();
             let next: 'off' | 'one' | 'all' = 'off';
             if (current === 'off') next = 'one';
             else if (current === 'one') next = 'all';
             else if (current === 'all') next = 'off';
             
             setLoopMode(next);
             
             if (next !== 'off') loopBtn.classList.add('active-loop');
             else loopBtn.classList.remove('active-loop');
        });
    }

    if (ctxLoopOff) {
        ctxLoopOff.addEventListener('click', () => {
            setLoopMode('off');
            loopBtn?.classList.remove('active-loop');
            loopContextMenu?.classList.add('hidden');
        });
    }
    if (ctxLoopOne) {
        ctxLoopOne.addEventListener('click', () => {
            setLoopMode('one');
            loopBtn?.classList.add('active-loop');
            loopContextMenu?.classList.add('hidden');
        });
    }
    if (ctxLoopAll) {
        ctxLoopAll.addEventListener('click', () => {
            setLoopMode('all');
            loopBtn?.classList.add('active-loop');
            loopContextMenu?.classList.add('hidden');
        });
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
        if (playContextMenu) {
            playContextMenu.classList.add('hidden');
            playContextMenu.setAttribute('aria-hidden', 'true');
        }
        if (loopContextMenu) {
            loopContextMenu.classList.add('hidden');
            loopContextMenu.setAttribute('aria-hidden', 'true');
        }
    });
}

function applyPlatformStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .title-bar { -webkit-app-region: drag; }
        .window-controls, .kit-controls { -webkit-app-region: no-drag; }
        * { -webkit-user-drag: none; }
    `;
    document.head.appendChild(style);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

document.body.addEventListener('click', () => { resumeAudioContext(); enableMIDI(); }, { once: true });
