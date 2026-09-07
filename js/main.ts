// === MAIN ENTRY POINT ===
// Gangsta Player Pro 3 - Modular Architecture
import { resumeAudioContext, masterGain, audioCtx, bufferToWave, initWorklets, ensureAudio } from './audio';
import { enableMIDI, initMIDI } from './midi';
import {
    initSampler, createPadGrid, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, stopAllPads, loadSampleFromPath, toggleSync,
    padBuffers, activeVoices, padVolumes, padSyncState, padBPMs,
    padLoopStart, padLoopEnd,
    renderWaveform
} from './sampler';
import {
    initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    getPlayerAudio, stopPlayback, getPlaybackMode, setPlaybackMode,
    getLoopMode, setLoopMode, disposePlayerUrls
} from './player';
import { detectBPMWorker } from './worker-client';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, setBlendingIndex, handlePlaylistNavigation } from './playlist';
import { initSettings } from './settings';
import { initVisuals, playStartupSound } from './visuals';
import { engine } from './audio-engine';
import { state } from './state';
import { toast } from './toast';
import { logger } from './logger';
import { HighFidelityRecorder } from './recorder-client';

import { saveSession, loadSession, purgeLegacySessionKey } from './session';
import { initCrashRecovery, checkAndRestore } from './crash-recovery';
import { NUM_PADS } from './constants';

import './types';

// State for master recording (moved to module scope for setupMasterRecording closure)
let hiFiRecorder: HighFidelityRecorder | null = null;
let isRecording = false;

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

// Context menu setup functions (extracted from initApp)

// Hoisted so handlers outside setupContextMenus (play/loop menus, global
// click) can reference them. Previously these names were scoped to
// setupContextMenus while other handlers referenced them — a guaranteed
// ReferenceError the moment those menus were used.
let padContextMenuEl: HTMLElement | null = null;
let controlContextMenuEl: HTMLElement | null = null;

function setupContextMenus() {
    // Context Menu for Pads
    const padGrid = getPadGrid();
    const padContextMenu = document.getElementById('padContextMenu');
    padContextMenuEl = padContextMenu;
    const ctxLoadSample = document.getElementById('ctxLoadSample');
    const ctxSync = document.getElementById('ctxSync');
    const padCtxDivider = document.getElementById('padCtxDivider');

    if (padGrid && padContextMenu) {
        for (let i = 0; i < NUM_PADS; i++) {
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
                    // NOTE: element id is 'padCtxLoopDivider' in index.html —
                    // the old 'ctxLoopDivider' lookup never resolved.
                    const padCtxLoopDivider = document.getElementById('padCtxLoopDivider');
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
            renderWaveform(index);
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
    controlContextMenuEl = controlContextMenu;
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
        const target = e.target as HTMLElement;
        const tag = target?.tagName ?? '';
        const inputType = (target as HTMLInputElement)?.type ?? '';

        // ESC: cancel learn modes first, then modal, then context menu.
        if (e.key === 'Escape') {
            if (state.isLearningKey || state.isLearningMidi) {
                state.update({ isLearningKey: false, keyLearnTargetPad: null, isLearningMidi: false, midiLearnTarget: null });
                return;
            }
            e.preventDefault();
            // Try modals first — topmost, not first in DOM order. The confirm
            // modal must go through its No-button path so the queue drains;
            // closeModal() directly would wedge _confirmOpen forever.
            // Try modals first — topmost, not first in DOM order. The confirm
            // modal must go through its No-button path so the queue drains;
            // closeModal() directly would wedge _confirmOpen forever.
            const topModal = (document.querySelectorAll('.modal.active').length
                ? document.querySelectorAll('.modal.active')[document.querySelectorAll('.modal.active').length - 1]
                : null) as HTMLElement | null;
            const activeModal = topModal ?? document.querySelector('.modal.active');
            if (activeModal) {
                if (activeModal.id === 'confirmModal') {
                    const noBtn = document.getElementById('confirmNo') as HTMLElement | null;
                    if (noBtn) { (noBtn as HTMLButtonElement).click(); return; }
                }
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

        // Learn modes steal the next key — transport must not fire underneath.
        if (state.isLearningKey || state.isLearningMidi) return;

        // Ignore typing/editing contexts: text inputs, textareas, selects,
        // contenteditable, and range sliders (arrows adjust the slider natively).
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target?.isContentEditable) return;
        if (tag === 'INPUT' && (inputType === 'text' || inputType === 'search' || inputType === 'number')) return;
        if (tag === 'INPUT' && inputType === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
        // Focused buttons: Space clicks natively — don't also toggle transport.
        if (tag === 'BUTTON' && e.code === 'Space') return;
        // Focused checkboxes/ranges: Space toggles the control natively —
        // must not also toggle transport or seek.
        if (tag === 'INPUT' && (inputType === 'checkbox' || inputType === 'range') && e.code === 'Space') return;

        // Transport — blocked during AutoMix blending
        if (e.code === 'Space') {
            e.preventDefault();
            if (state.isCrossfadeInProgress) return;
            const playerAudio = getPlayerAudio();
            if (playerAudio) {
                if (!playerAudio.paused) pauseTrack(); else playTrack();
            }
        } else if (e.code === 'Enter') {
            if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            e.preventDefault();
            stopPlayback();
        } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
            // Seek ±5s — documented in the help modal but never implemented
            e.preventDefault();
            if (state.isCrossfadeInProgress) return;
            const playerAudio = getPlayerAudio();
            if (playerAudio && isFinite(playerAudio.duration)) {
                const delta = e.code === 'ArrowRight' ? 5 : -5;
                playerAudio.currentTime = Math.min(
                    Math.max(0, playerAudio.currentTime + delta),
                    playerAudio.duration || Number.MAX_SAFE_INTEGER
                );
            }
        }
        
        // Playlist Navigation — only when focus is not inside an
        // interactive control (buttons/inputs/selects), otherwise Delete or
        // arrows hijack the focused control's native behavior.
        if (['ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(e.key)) {
            if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if (target?.isContentEditable) return;
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
                        if (!ensureAudio() || !masterGain) {
                            logger.error("AudioContext unavailable. Cannot start recorder.");
                            toast.error("AUDIO NOT READY");
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
                             else toast.error("FAILED TO SAVE HI-FI RECORDING");
                        } else {
                            // Don't discard minutes of capture without telling the user
                            toast.info("SAVE CANCELED — RECORDING DISCARDED");
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
    purgeLegacySessionKey();
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

    // ORDER MATTERS: initPlayer caches tempoSlider in the DOM. initSampler
    // captures getTempoSlider() — running the sampler first handed it a
    // permanent null and pads ignored the chopper slider forever.
    initPlayer({ renderPlaylist, setBlendingIndex });

    initSampler({
        fsBridge, bridge,
        detectBPM: detectBPMWorker,
        masterBPMRef: getMasterBPMRef(),
        tempoSliderRef: getTempoSlider() as HTMLInputElement
    });

    // Crash-recovery prompt must resolve BEFORE the playlist loads from DB —
    // otherwise the async DB read races the restore and clobbers it.
    checkAndRestore().then((restored) => {
        initPlaylist({
            loadTrack, playTrack,
            skipDbLoad: restored
        });
        // Depends on DOM refs cached by initPlaylist — run after, not before
        setupPlaylistHandlers();
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    // Sonetra status was previously forwarded by main but never subscribed —
    // surface crashes/restarts instead of dropping the signal.
    try {
        window.sonetra?.onRestartStatus?.((status: unknown) => {
            try {
                const s = status as { event?: string; message?: string };
                logger.info(`[Sonetra] status: ${s?.event ?? 'unknown'} ${s?.message ?? ''}`);
                if (s?.event === 'crashed' || s?.event === 'failed') toast.error(`AI MIXER ${String(s.event).toUpperCase()}`);
                else if (s?.event === 'restarted' || s?.event === 'started') toast.success('AI MIXER ONLINE');
            } catch { /* ignore */ }
        });
    } catch { /* Sonetra bridge unavailable — non-fatal */ }

    initSettings({ setAutoMixEnabled });

    // Initialize UI components
    // NOTE: createPadGrid() is already called inside initSampler() — do NOT call it again here
    initVisuals();
    
    // Setup handlers (initSettings already ran setupSettingsHandlers+loadSettings —
    // calling them again double-wires every settings control and modal).
    setupPadKeyboardHandlers();
    setupPlayerHandlers();

    // Reclaim blob URLs on teardown
    window.addEventListener('beforeunload', disposePlayerUrls);
    window.addEventListener('beforeunload', () => {
        try { hiFiRecorder?.dispose(); } catch { /* ignore */ }
    });

    // Looped pad voices never end on their own — a missed keyup/mouseleave
    // (alt-tab, focus loss) would drone forever. Choke all pads on blur.
    window.addEventListener('blur', () => {
        try { stopAllPads(); } catch { /* ignore */ }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            try { stopAllPads(); } catch { /* ignore */ }
        }
    });

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
            if (padContextMenuEl) padContextMenuEl.classList.add('hidden');
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

            if (padContextMenuEl) padContextMenuEl.classList.add('hidden');
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
        if (padContextMenuEl) {
            padContextMenuEl.classList.add('hidden');
            padContextMenuEl.setAttribute('aria-hidden', 'true');
        }
        if (playContextMenu) {
            playContextMenu.classList.add('hidden');
            playContextMenu.setAttribute('aria-hidden', 'true');
        }
        if (loopContextMenu) {
            loopContextMenu.classList.add('hidden');
            loopContextMenu.setAttribute('aria-hidden', 'true');
        }
        if (controlContextMenuEl) {
            controlContextMenuEl.classList.add('hidden');
        }
    });
    
    // Startup sequence completion
    playStartupSound();
    if (bridge?.appReadyToShow) bridge.appReadyToShow();

    // Initialize crash recovery (auto-save)
    initCrashRecovery();
    // NOTE: checkAndRestore() already ran above (gated before initPlaylist).
    // Do NOT call it again here — two concurrent prompts fight over
    // confirmModal and double-restore/clear snapshots.

    // === GURU CRASH PROTECTION (RENDERER) ===
    // addEventListener (not assignment) so earlier handlers aren't clobbered.
    window.addEventListener('error', (event) => {
        const { message, filename, lineno, colno, error } = event;
        logger.error(`[Renderer Crash] ${message} at ${filename}:${lineno}:${colno}`);
        // Pass a plain snapshot — the live ReactiveStore holds Maps/Sets of
        // functions that throw DataCloneError over IPC.
        let appState: unknown = null;
        try { appState = state.getSnapshot(); } catch { appState = null; }
        logger.generateCrashReport({
            type: 'RENDERER_ERROR',
            message,
            source: filename,
            lineno,
            colno,
            stack: (error as Error | undefined)?.stack,
            appState
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        logger.error(`[Renderer Rejection] ${event.reason}`);
        let appState: unknown = null;
        try { appState = state.getSnapshot(); } catch { appState = null; }
        logger.generateCrashReport({
            type: 'RENDERER_REJECTION',
            reason: String(event.reason)?.slice(0, 2000),
            appState
        });
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

document.body.addEventListener('click', () => {
    void resumeAudioContext().catch(() => undefined);
    try { enableMIDI(); } catch { /* MIDI unavailable — non-fatal */ }
}, { once: true });