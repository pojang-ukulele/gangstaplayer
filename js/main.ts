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
import { logger } from './logger';
import { HighFidelityRecorder } from './recorder-client';

import './types';

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

async function initApp() {
    logger.info('[MAIN] Initializing Gangsta Player Pro 3 Core...');
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
                        if (ctxSync) {
                            ctxSync.classList.remove('hidden');
                            if (padSyncState[i]) {
                                ctxSync.classList.add('sync-active');
                                ctxSync.innerText = 'SYNC ✓';
                            } else {
                                ctxSync.classList.remove('sync-active');
                                ctxSync.innerText = 'SYNC';
                            }
                        }
                    } else {
                        if (ctxSync) ctxSync.classList.add('hidden');
                    }
                    if (padCtxDivider) padCtxDivider.classList.toggle('hidden', !padBuffers[i]);
                    
                    const ctxPadMidiLearn = document.getElementById('ctxPadMidiLearn');
                    if (ctxPadMidiLearn) ctxPadMidiLearn.classList.toggle('hidden', !state.isMidiActive);

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

    const ctxPadMidiLearn = document.getElementById('ctxPadMidiLearn');
    const ctxPadKeyBind = document.getElementById('ctxPadKeyBind');

    if (ctxPadMidiLearn && padContextMenu) {
        ctxPadMidiLearn.addEventListener('click', () => {
             const index = parseInt(padContextMenu.dataset.padIndex || "0");
             state.update({ isLearningMidi: true, midiLearnTarget: { type: 'pad', id: index } });
             toast.info(`PRESS MIDI NOTE FOR PAD ${index + 1}...`);
        });
    }

    if (ctxPadKeyBind && padContextMenu) {
        ctxPadKeyBind.addEventListener('click', () => {
             const index = parseInt(padContextMenu.dataset.padIndex || "0");
             state.update({ isLearningKey: true, keyLearnTargetPad: index });
             toast.info(`PRESS COMPUTER KEY FOR PAD ${index + 1}...`);
        });
    }

    // Slider Context Menus
    const sliders = ['masterVol', 'tempoSlider'];
    const controlContextMenu = document.getElementById('controlContextMenu');
    const ctxControlMidiLearn = document.getElementById('ctxControlMidiLearn');

    sliders.forEach(id => {
        const el = document.getElementById(id);
        if (el && controlContextMenu) {
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Hide other menus
                document.dispatchEvent(new Event('click'));

                if (ctxControlMidiLearn) ctxControlMidiLearn.classList.toggle('hidden', !state.isMidiActive);

                controlContextMenu.classList.remove('hidden');
                controlContextMenu.style.left = e.pageX + 'px';
                controlContextMenu.style.top = e.pageY + 'px';
                controlContextMenu.dataset.controlId = id;
            });
        }
    });

    if (ctxControlMidiLearn && controlContextMenu) {
        ctxControlMidiLearn.addEventListener('click', () => {
             const id = controlContextMenu.dataset.controlId || "";
             state.update({ isLearningMidi: true, midiLearnTarget: { type: 'control', id: id } });
             toast.info(`MOVE MIDI KNOB FOR ${id.toUpperCase()}...`);
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

    // === HIGH-FIDELITY MASTER RECORDING LOGIC ===
    const recBtn = document.getElementById('masterRecBtn');
    let hiFiRecorder: HighFidelityRecorder | null = null;
    let isRecording = false;

    if (recBtn) {
        recBtn.addEventListener('click', async () => {
            if (!isRecording) {
                // START RECORDING
                try {
                    if (!hiFiRecorder) {
                        hiFiRecorder = new HighFidelityRecorder(masterGain);
                        await hiFiRecorder.init();
                    }
                    
                    hiFiRecorder.start();
                    isRecording = true;
                    recBtn.classList.add('recording');
                    recBtn.innerText = "STOP";
                } catch (e) {
                    logger.error("[MasterRec] Start failed", e);
                    toast.error("COULD NOT START HI-FI RECORDER");
                }
            } else {
                // STOP RECORDING
                if (hiFiRecorder) {
                    try {
                        const wavBlob = await hiFiRecorder.stop();
                        const wavBuffer = await wavBlob.arrayBuffer();

                        const path = await bridge.saveAudioDialog();
                        if (path) {
                             const uint8 = new Uint8Array(wavBuffer);
                             // IPC Buffer Alignment Fix
                             const safeBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
                             const success = await fsBridge.saveFile(path, new Uint8Array(safeBuffer));
                             if (success) toast.success("HI-FI RECORDING SAVED");
                        }
                    } catch (e) {
                        logger.error("[MasterRec] Stop/Save failed", e);
                        toast.error("COULD NOT SAVE HI-FI RECORDING");
                    } finally {
                        recBtn.classList.remove('recording');
                        recBtn.innerText = "REC";
                        isRecording = false;
                    }
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
        });
    }

    if (ctxLoopOff) {
        ctxLoopOff.addEventListener('click', () => {
            setLoopMode('off');
            loopContextMenu?.classList.add('hidden');
        });
    }
    if (ctxLoopOne) {
        ctxLoopOne.addEventListener('click', () => {
            setLoopMode('one');
            loopContextMenu?.classList.add('hidden');
        });
    }
    if (ctxLoopAll) {
        ctxLoopAll.addEventListener('click', () => {
            setLoopMode('all');
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
        if (controlContextMenu) {
            controlContextMenu.classList.add('hidden');
        }
    });
    
    // === GURU CRASH PROTECTION (RENDERER) ===
    window.onerror = (message, source, lineno, colno, error) => {
        logger.error(`[Renderer Crash] ${message} at ${source}:${lineno}:${colno}`);
        logger.generateCrashReport({
            type: 'RENDERER_ERROR',
            message,
            source,
            lineno,
            colno,
            stack: error?.stack,
            appState: state
        });
        return false;
    };

    window.onunhandledrejection = (event) => {
        logger.error(`[Renderer Rejection] ${event.reason}`);
        logger.generateCrashReport({
            type: 'RENDERER_REJECTION',
            reason: event.reason,
            appState: state
        });
    };
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
