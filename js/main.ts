// === MAIN ENTRY POINT ===
// Gangsta Player Pro 3 - Modular Architecture
import { resumeAudioContext, masterGain, audioCtx, bufferToWave, initWorklets } from './audio';
import { enableMIDI, initMIDI } from './midi';
import { 
    initSampler, createPadGrid, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, loadSampleFromPath, toggleSync,
    padBuffers, activeVoices, padVolumes, padSyncState, padBPMs
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

import { saveSession, loadSession } from './session';
import { initCrashRecovery, checkAndRestore } from './crash-recovery';

import './types';

// State for master recording (moved to module scope for setupMasterRecording closure)
let hiFiRecorder: HighFidelityRecorder | null = null;
let isRecording = false;

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

// Context menu setup functions (extracted from initApp)
function setupContextMenus() {
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
                    const hasBuffer = !!padBuffers[i];
                    if (hasBuffer) {
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
                    if (padCtxDivider) padCtxDivider.classList.toggle('hidden', !hasBuffer);
                    
                    // Show loop items when sample is loaded
                    const hasBpm = hasBuffer && !!padBPMs[i];
                    const padCtxLoopDivider = document.getElementById('ctxLoopDivider');
                    if (padCtxLoopDivider) padCtxLoopDivider.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxSetLoop1Bar')) document.getElementById('ctxSetLoop1Bar')!.classList.toggle('hidden', !hasBpm);
                    if (document.getElementById('ctxSetLoopStart')) document.getElementById('ctxSetLoopStart')!.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxSetLoopEnd')) document.getElementById('ctxSetLoopEnd')!.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxClearLoop')) document.getElementById('ctxClearLoop')!.classList.toggle('hidden', !hasBuffer);

                    const ctxPadMidiLearn = document.getElementById('ctxPadMidiLearn');
                    if (ctxPadMidiLearn) ctxPadMidiLearn.classList.toggle('hidden', !state.isMidiActive);

                    // Position context menu with viewport boundary check
                    padContextMenu.classList.remove('hidden');
                    padContextMenu.setAttribute('aria-hidden', 'false');
                    let left = e.clientX;
                    let top = e.clientY;
                    const rect = padContextMenu.getBoundingClientRect();
                    if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width;
                    if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height;
                    padContextMenu.style.left = `${left}px`;
                    padContextMenu.style.top = `${top}px`;
                    padContextMenu.dataset.padIndex = i.toString();
                });
                pad.addEventListener('mousedown', (e) => {
                    logger.info(`[Main] Pad ${i} mousedown. button=${e.button}, bufferExists=${!!padBuffers[i]}`);
                    if (e.button === 0 && padBuffers[i]) startPad(i);
                });
                pad.addEventListener('mouseup', () => stopPad(i));
                pad.addEventListener('mouseleave', () => stopPad(i));
                pad.addEventListener('click', async () => {
                    logger.info(`[Main] Pad ${i} click. bufferExists=${!!padBuffers[i]}`);
                    if (!padBuffers[i]) {
                        const filePath = await bridge.openSampleDialog();
                        logger.info(`[Main] Pad ${i} dialog result: ${filePath}`);
                        if (filePath) await loadSampleFromPath(filePath, i);
                        logger.info(`[Main] Pad ${i} after load. bufferExists=${!!padBuffers[i]}`);
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

    // === LOOP CONTEXT MENU ITEMS ===
    const ctxSetLoop1Bar = document.getElementById('ctxSetLoop1Bar');
    const ctxSetLoopStart = document.getElementById('ctxSetLoopStart');
    const ctxSetLoopEnd = document.getElementById('ctxSetLoopEnd');
    const ctxClearLoop = document.getElementById('ctxClearLoop');

    if (ctxSetLoop1Bar && padContextMenu) {
        ctxSetLoop1Bar.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            import('./sampler').then(({ padBuffers, padBPMs, padLoopStart, padLoopEnd, padBeatPositions }) => {
                const buf = padBuffers[index];
                const bpm = padBPMs[index];
                if (!buf || !bpm) return;
                const beatSec = 60 / bpm;
                const barSec = beatSec * 4;
                const currentPos = (buf.duration / 4); // roughly 1/4 into sample
                const startBeat = Math.floor(currentPos / barSec) * barSec;
                padLoopStart[index] = startBeat;
                padLoopEnd[index] = Math.min(startBeat + barSec, buf.duration);
                toast.success(`1-BAR LOOP SET`);
                const { renderWaveform } = require('./sampler');
                if (renderWaveform) renderWaveform(index);
            });
        });
    }
    if (ctxSetLoopStart && padContextMenu) {
        ctxSetLoopStart.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            import('./sampler').then(({ padBuffers, padLoopStart, padLoopEnd, padBeatPositions, renderWaveform }) => {
                const buf = padBuffers[index];
                if (!buf) return;
                // Use 25% of duration as the default loop start position
                const pos = buf.duration * 0.25;
                padLoopStart[index] = pos;
                if (padLoopEnd[index] < 0 || padLoopEnd[index] <= pos) {
                    padLoopEnd[index] = buf.duration;
                }
                toast.success(`LOOP START AT ${pos.toFixed(2)}s`);
                if (renderWaveform) renderWaveform(index);
            });
        });
    }
    if (ctxSetLoopEnd && padContextMenu) {
        ctxSetLoopEnd.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            import('./sampler').then(({ padBuffers, padLoopStart, padLoopEnd, padBeatPositions, renderWaveform }) => {
                const buf = padBuffers[index];
                if (!buf) return;
                // Use 75% of duration as the default loop end position
                const pos = buf.duration * 0.75;
                padLoopEnd[index] = pos;
                if (padLoopStart[index] < 0 || padLoopStart[index] >= pos) {
                    padLoopStart[index] = 0;
                }
                toast.success(`LOOP END AT ${pos.toFixed(2)}s`);
                if (renderWaveform) renderWaveform(index);
            });
        });
    }
    if (ctxClearLoop && padContextMenu) {
        ctxClearLoop.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            import('./sampler').then(({ padLoopStart, padLoopEnd, renderWaveform }) => {
                padLoopStart[index] = -1;
                padLoopEnd[index] = -1;
                toast.info("LOOP CLEARED");
                if (renderWaveform) renderWaveform(index);
            });
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
                let left = e.clientX;
                let top = e.clientY;
                const rect = controlContextMenu.getBoundingClientRect();
                if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width;
                if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height;
                controlContextMenu.style.left = `${left}px`;
                controlContextMenu.style.top = `${top}px`;
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
}

function setupGlobalKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if user is typing in an input
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') return;

        // ESC: Close topmost modal or context menu
        if (e.key === 'Escape') {
            e.preventDefault();
            // Try modals first
            const activeModal = document.querySelector('.modal.active');
            if (activeModal) {
                import('./modals').then(({ closeModal }) => closeModal(activeModal as HTMLElement));
                return;
            }
            // Fallback: hide any visible context menus
            const visibleMenus = document.querySelectorAll('.context-menu:not(.hidden)');
            if (visibleMenus.length > 0) {
                visibleMenus.forEach(menu => {
                    (menu as HTMLElement).classList.add('hidden');
                    menu.setAttribute('aria-hidden', 'true');
                });
            }
            return;
        }

        // Transport — blocked during AutoMix blending
        if (e.code === 'Space') {
            e.preventDefault();
            if (state.isCrossfadeInProgress) return;
            const playerAudio = getPlayerAudio();
            if (playerAudio) {
                if (!playerAudio.paused) pauseTrack(); else playTrack();
            }
        } else if (e.code === 'Enter') {
            e.preventDefault();
            if (state.isCrossfadeInProgress) return;
            stopPlayback();
        } 
        
        // Playlist Navigation
        if (['ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(e.key)) {
            handlePlaylistNavigation(e);
        }
    });
}

function setupMasterRecording() {
    const recBtn = document.getElementById('masterRecBtn');
    if (recBtn) {
        recBtn.addEventListener('click', async () => {
            if (!isRecording) {
                // START RECORDING
                try {
                    if (!hiFiRecorder) {
                        if (!masterGain) {
                            logger.error("AudioContext unavailable. Cannot start recorder.");
                            return;
                        }
                        hiFiRecorder = new HighFidelityRecorder(masterGain);
                        await hiFiRecorder.init();
                    }
                   
                    hiFiRecorder.start();
                    isRecording = true;
                    recBtn.classList.add('recording');
                    recBtn.innerText = "STOP";
                    recBtn.setAttribute('aria-pressed', 'true');
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
                        recBtn.setAttribute('aria-pressed', 'false');
                        isRecording = false;
                    }
                }
            }
        });
    }
}

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
        tempoSliderRef: getTempoSlider() as HTMLInputElement
    });

    initPlayer({ renderPlaylist, setBlendingIndex });

    initPlaylist({
        loadTrack, playTrack
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ setAutoMixEnabled });

    // Initialize UI components
    // NOTE: createPadGrid() is already called inside initSampler() — do NOT call it again here
    initVisuals();
    
    // Setup handlers
    setupPadKeyboardHandlers();
    setupPlayerHandlers();
    setupPlaylistHandlers();
    setupSettingsHandlers();
    loadSettings();

    // Context menus, keyboard shortcuts, and master recording
    setupContextMenus();
    setupGlobalKeyboardShortcuts();
    setupMasterRecording();

    // Manual Button
    const btnOpenManual = document.getElementById('btnOpenManual');
    if (btnOpenManual) {
        btnOpenManual.addEventListener('click', () => {
             bridge.openExternal('README.md');
        });
    }

    // Session Save/Load
    const btnSaveSession = document.getElementById('btnSaveSession');
    const btnLoadSession = document.getElementById('btnLoadSession');
    if (btnSaveSession) {
        btnSaveSession.addEventListener('click', saveSession);
    }
    if (btnLoadSession) {
        btnLoadSession.addEventListener('click', loadSession);
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
            let left = e.clientX;
            let top = e.clientY;
            const rect = playContextMenu.getBoundingClientRect();
            if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width;
            if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height;
            playContextMenu.style.left = `${left}px`;
            playContextMenu.style.top = `${top}px`;
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
            let left = e.clientX;
            let top = e.clientY;
            const rect = loopContextMenu.getBoundingClientRect();
            if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width;
            if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height;
            loopContextMenu.style.left = `${left}px`;
            loopContextMenu.style.top = `${top}px`;
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
    
    // Startup sequence completion
    playStartupSound();
    if (bridge?.appReadyToShow) bridge.appReadyToShow();

    // Initialize crash recovery (auto-save)
    initCrashRecovery();
    // Check for previous crash and prompt restore (non-blocking)
    checkAndRestore();

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