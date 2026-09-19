// === MAIN ENTRY POINT ===
// Gangsta Player Pro 3 - Modular Architecture
import { resumeAudioContext, masterGain, audioCtx, initWorklets, ensureAudio, onAudioRebuilt } from './audio';
import { enableMIDI, initMIDI } from './midi';
import {
    initSampler, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, stopAllPads, loadSampleFromPath, toggleSync,
    padBuffers, activeVoices, padVolumes, padSyncState, padBPMs,
    padLoopStart, padLoopEnd, padSnapToBeat, toggleSnapToBeat,
    renderWaveform
} from './sampler';
import {
    initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    getPlayerAudio, stopPlayback, getPlaybackMode, setPlaybackMode,
    getLoopMode, setLoopMode, disposePlayerUrls
} from './player';
import { detectBPMWithConfidence } from './worker-client';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, setBlendingIndex, handlePlaylistNavigation } from './playlist';
import { initSettings } from './settings';
import { initVisuals, playStartupSound } from './visuals';
import { engine } from './audio-engine';
import { state } from './state';
import { toast } from './toast';
import { logger } from './logger';
import { HighFidelityRecorder } from './recorder-client';

import { getTopModal } from './modals';
import { saveSession, loadSession, purgeLegacySessionKey } from './session';
import { initCrashRecovery, checkAndRestore } from './crash-recovery';
import { initTrackInfo } from './track-info';
import { NUM_PADS } from './constants';

import { DIALOG_THROTTLED } from './types';

// State for master recording (moved to module scope for setupMasterRecording closure)
let hiFiRecorder: HighFidelityRecorder | null = null;
let isRecording = false;

const bridge = window.electronAPI;
const fsBridge = window.fileSystem;

// Fail-loud when preload bridges are missing (packaged-only class of bug:
// renderer boots without contextBridge exposes and every bridge call throws
// an inscrutable TypeError). Shows a full-screen overlay naming the missing
// bridges instead of dying on first use.
function showBridgeFatalOverlay(missing: string[]): void {
    try {
        if (document.getElementById('bridgeFatalOverlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'bridgeFatalOverlay';
        overlay.setAttribute('role', 'alert');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.92);padding:24px;text-align:center;';
        const box = document.createElement('div');
        box.style.cssText = 'max-width:560px;color:#ff5a5a;font-family:monospace;font-size:14px;line-height:1.6;';
        const title = document.createElement('div');
        title.textContent = 'FATAL: PRELOAD BRIDGES MISSING';
        title.style.cssText = 'font-weight:bold;font-size:16px;margin-bottom:12px;';
        const detail = document.createElement('div');
        detail.style.color = '#eee';
        detail.textContent = `Missing: ${missing.join(', ')}. The app was built or packaged without preload.js exposes (run outside Electron, broken build, or blocked preload). Restart the packaged app — if this persists, rebuild.`;
        box.appendChild(title);
        box.appendChild(detail);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    } catch { /* overlay is best-effort — init already aborts */ }
}

function getMissingBridges(): string[] {
    const missing: string[] = [];
    if (!window.electronAPI) missing.push('electronAPI');
    if (!window.fileSystem) missing.push('fileSystem');
    if (!window.database) missing.push('database');
    return missing;
}

/** Hide every context menu (M21): openers previously hid only a subset. */
function hideAllContextMenus(): void {
    try {
        const ids = ['contextMenu', 'samplerSubmenu', 'playContextMenu', 'loopContextMenu'];
        for (const id of ids) {
            const m = document.getElementById(id);
            if (m) { m.classList.add('hidden'); m.setAttribute('aria-hidden', 'true'); }
        }
        if (padContextMenuEl) {
            padContextMenuEl.classList.add('hidden');
            padContextMenuEl.setAttribute('aria-hidden', 'true');
            // Stale padIndex previously survived hides — the next opener that
            // reads dataset.padIndex without a fresh contextmenu (e.g. a
            // keyboard-triggered action) acted on the wrong pad.
            try { delete padContextMenuEl.dataset.padIndex; } catch { /* ignore */ }
        }
        if (controlContextMenuEl) {
            controlContextMenuEl.classList.add('hidden');
            controlContextMenuEl.setAttribute('aria-hidden', 'true');
            try { delete controlContextMenuEl.dataset.controlId; } catch { /* ignore */ }
        }
        const playlistCtx = document.getElementById('contextMenu');
        if (playlistCtx) {
            try { delete playlistCtx.dataset.ctxIndex; } catch { /* ignore */ }
        }
        const samplerParent = document.getElementById('ctxLoadToSampler');
        if (samplerParent) samplerParent.setAttribute('aria-expanded', 'false');
    } catch { /* ignore */ }
}

// Context menu setup functions (extracted from initApp)

// Hoisted so handlers outside setupContextMenus (play/loop menus, global
// click) can reference them. Previously these names were scoped to
// setupContextMenus while other handlers referenced them — a guaranteed
// ReferenceError the moment those menus were used.
let padContextMenuEl: HTMLElement | null = null;
let controlContextMenuEl: HTMLElement | null = null;

let _contextMenusWired = false;
function setupContextMenus() {
    // Idempotent (mirrors playlist/sampler guards): re-init previously
    // stacked duplicate contextmenu/mousedown listeners per pad.
    if (_contextMenusWired) return;
    _contextMenusWired = true;
    // Context Menu for Pads (restored): right-click opens #padContextMenu.
    // Coexists with waveform-first strip gestures (drag/loupe/hold-to-loop
    // live on .pad-wave mousedown; the menu is a right-click affordance only).
    // Playlist/play/loop/control menus below are untouched.
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
                    hideAllContextMenus();
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
                    const hasBpm = hasBuffer && Number.isFinite(padBPMs[i]) && (padBPMs[i] as number) > 0;
                    // NOTE: element id is 'padCtxLoopDivider' in index.html —
                    // the old 'ctxLoopDivider' lookup never resolved.
                    const padCtxLoopDivider = document.getElementById('padCtxLoopDivider');
                    if (padCtxLoopDivider) padCtxLoopDivider.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxSetLoop1Bar')) document.getElementById('ctxSetLoop1Bar')!.classList.toggle('hidden', !hasBpm);
                    if (document.getElementById('ctxSetLoopStart')) document.getElementById('ctxSetLoopStart')!.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxSetLoopEnd')) document.getElementById('ctxSetLoopEnd')!.classList.toggle('hidden', !hasBuffer);
                    if (document.getElementById('ctxClearLoop')) document.getElementById('ctxClearLoop')!.classList.toggle('hidden', !hasBuffer);
                    // Snap toggle: visible with a sample, greyed/disabled without BPM (free drag).
                    const snapItem = document.getElementById('ctxSnapToBeat');
                    if (snapItem) {
                        snapItem.classList.toggle('hidden', !hasBuffer);
                        const snapOn = padSnapToBeat[i] !== false;
                        snapItem.textContent = snapOn ? 'SNAP TO BEAT ✓' : 'SNAP TO BEAT';
                        snapItem.classList.toggle('menu-disabled', !hasBpm);
                        snapItem.setAttribute('aria-disabled', (!hasBpm).toString());
                    }

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
                // Mouse hold-to-play (momentary): mousedown starts the voice,
                // mouseup/mouseleave always choke it while active — same as
                // keyboard keyup and MIDI note-off. stopPad is a safe no-op
                // when no voice exists, so no .loop guard (the old guard let
                // one-shot clicks latch and ring out).
                pad.addEventListener('mouseup', () => {
                    try { if (activeVoices[i]) stopPad(i); } catch { /* ignore */ }
                });
                pad.addEventListener('mouseleave', () => {
                    try { if (activeVoices[i]) stopPad(i); } catch { /* ignore */ }
                });
                // Safety: releasing outside the pad after drag-off never fires
                // pad mouseup — choke the voice anyway (mirrors the rec-btn
                // window mouseup fallback in sampler.ts).
                window.addEventListener('mouseup', () => {
                    try { if (activeVoices[i]) stopPad(i); } catch { /* ignore */ }
                });
                pad.addEventListener('click', async () => {
                    logger.info(`[Main] Pad ${i} click. bufferExists=${!!padBuffers[i]}`);
                    if (!padBuffers[i]) {
                        const filePath = await bridge?.openSampleDialog();
                        logger.info(`[Main] Pad ${i} dialog result: ${filePath}`);
                        // Throttle sentinel is truthy — trap it before the
                        // path guard or it would load as a sample path.
                        if (filePath === DIALOG_THROTTLED) {
                            logger.debug(`[Main] Pad ${i} sample dialog throttled — TRY AGAIN`);
                            toast.info('DIALOG BUSY — TRY AGAIN');
                        } else if (filePath) {
                            try {
                                const ok = await loadSampleFromPath(filePath, i);
                                if (!ok) toast.error("SAMPLE LOAD FAILED");
                            } catch (e) {
                                logger.error(`[Main] Pad ${i} load failed`, e);
                                toast.error("SAMPLE LOAD FAILED");
                            }
                        }
                        logger.info(`[Main] Pad ${i} after load. bufferExists=${!!padBuffers[i]}`);
                    }
                });
            }
        }
    }

    // === PAD MENU ITEMS (restored prior behavior) ===
    if (ctxLoadSample && padContextMenu) {
        ctxLoadSample.addEventListener('click', async () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            const filePath = await bridge?.openSampleDialog();
            // Throttle sentinel is truthy — trap it before the path guard.
            if (filePath === DIALOG_THROTTLED) {
                logger.debug(`[Main] Pad ${index} sample dialog throttled — TRY AGAIN`);
                toast.info('DIALOG BUSY — TRY AGAIN');
            } else if (filePath) {
                try {
                    const ok = await loadSampleFromPath(filePath, index);
                    if (!ok) toast.error("SAMPLE LOAD FAILED");
                } catch (e) {
                    logger.error(`[Main] Pad ${index} load failed`, e);
                    toast.error("SAMPLE LOAD FAILED");
                }
            }
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
            if (!buf || !bpm) {
                logger.debug(`[Main] 1-bar loop skipped (stale pad ${index}: buffer=${!!buf}, bpm=${!!bpm})`);
                return;
            }
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
                if (!buf) {
                    logger.debug(`[Main] Loop-start preset skipped (stale pad ${index}: sample gone)`);
                    return;
                }
                // Use 25% of duration as the default loop start position
                const pos = buf.duration * 0.25;
                padLoopStart[index] = pos;
                if (padLoopEnd[index] < 0 || padLoopEnd[index] <= pos) {
                    padLoopEnd[index] = buf.duration;
                }
                toast.success(`LOOP START AT ${pos.toFixed(2)}s`);
                if (renderWaveform) renderWaveform(index);
            }).catch((err) => {
                logger.warn(`[Main] Loop-start preset failed (sampler import)`, err);
            });
        });
    }
    if (ctxSetLoopEnd && padContextMenu) {
        ctxSetLoopEnd.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            import('./sampler').then(({ padBuffers, padLoopStart, padLoopEnd, padBeatPositions, renderWaveform }) => {
                const buf = padBuffers[index];
                if (!buf) {
                    logger.debug(`[Main] Loop-end preset skipped (stale pad ${index}: sample gone)`);
                    return;
                }
                // Use 75% of duration as the default loop end position
                const pos = buf.duration * 0.75;
                padLoopEnd[index] = pos;
                if (padLoopStart[index] < 0 || padLoopStart[index] >= pos) {
                    padLoopStart[index] = 0;
                }
                toast.success(`LOOP END AT ${pos.toFixed(2)}s`);
                if (renderWaveform) renderWaveform(index);
            }).catch((err) => {
                logger.warn(`[Main] Loop-end preset failed (sampler import)`, err);
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
            }).catch((err) => {
                logger.warn(`[Main] Loop-clear failed (sampler import)`, err);
            });
        });
    }
    const ctxSnapToBeat = document.getElementById('ctxSnapToBeat');
    if (ctxSnapToBeat && padContextMenu) {
        ctxSnapToBeat.addEventListener('click', () => {
            const index = parseInt(padContextMenu.dataset.padIndex || "0");
            if (!padBuffers[index] || !padBPMs[index]) {
                toast.info("SNAP NEEDS BPM");
                return;
            }
            const next = toggleSnapToBeat(index);
            ctxSnapToBeat.textContent = next ? 'SNAP TO BEAT ✓' : 'SNAP TO BEAT';
            toast.info(next ? `PAD ${index + 1} SNAP ON` : `PAD ${index + 1} SNAP OFF`);
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

                hideAllContextMenus();

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
            // Try modals first — topmost via the modals.ts single source
            // (getTopModal: last .active wins). The confirm modal must go
            // through its No-button path so the queue drains; closeModal()
            // directly would wedge _confirmOpen forever.
            const activeModal = getTopModal();
            if (activeModal) {
                if (activeModal.id === 'confirmModal') {
                    const noBtn = document.getElementById('confirmNo') as HTMLElement | null;
                    if (noBtn) { (noBtn as HTMLButtonElement).click(); return; }
                }
                import('./modals').then(({ closeModal }) => closeModal(activeModal as HTMLElement));
                return;
            }
            // Fallback: hide any visible context menus (incl. sampler submenu)
            const visibleMenus = document.querySelectorAll('.context-menu:not(.hidden), .context-submenu:not(.hidden)');
            if (visibleMenus.length > 0) {
                visibleMenus.forEach(menu => {
                    (menu as HTMLElement).classList.add('hidden');
                    menu.setAttribute('aria-hidden', 'true');
                });
                const samplerParent = document.getElementById('ctxLoadToSampler');
                if (samplerParent) samplerParent.setAttribute('aria-expanded', 'false');
            }
            return;
        }

        // Learn modes steal the next key — transport must not fire underneath.
        if (state.isLearningKey || state.isLearningMidi) return;

        // Ignore typing/editing contexts: text inputs, textareas, selects,
        // contenteditable, and range sliders (arrows adjust the slider natively).
        // M22: password/url/email/tel are editing contexts too — SPACE must
        // type natively there, not toggle transport.
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target?.isContentEditable) return;
        if (tag === 'INPUT' && (inputType === 'text' || inputType === 'search' || inputType === 'number' || inputType === 'password' || inputType === 'url' || inputType === 'email' || inputType === 'tel')) return;
        if (tag === 'INPUT' && inputType === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
        // Focused buttons: Space clicks natively — don't also toggle transport.
        if (tag === 'BUTTON' && e.code === 'Space') return;
        // Focused checkboxes/ranges: Space toggles the control natively —
        // must not also toggle transport or seek.
        if (tag === 'INPUT' && (inputType === 'checkbox' || inputType === 'range') && e.code === 'Space') return;

        // Transport — play/pause queue as intent mid-blend (C8), so SPACE
        // stays live during AutoMix blending instead of blacking out.
        // Modal-open guard: Space/Enter must not drive transport while any
        // modal (incl. the queued confirm) holds the screen.
        if ((e.code === 'Space' || e.code === 'Enter') && document.querySelector('.modal.active')) return;
        if (e.code === 'Space') {
            e.preventDefault();
            const playerAudio = getPlayerAudio();
            if (playerAudio) {
                if (!playerAudio.paused) pauseTrack(); else playTrack();
            }
        } else if (e.code === 'Enter') {
            if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            e.preventDefault();
            stopPlayback();
        } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
            // C15: never hijack caret/slider movement in editing contexts —
            // return BEFORE preventDefault so the caret moves natively.
            if (tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (target?.isContentEditable) return;
            if (tag === 'INPUT') return;
            try { if ((target as HTMLElement | null)?.closest?.('#playlistSearch')) return; } catch { /* ignore */ }
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
        
        // Playlist Navigation — H32: forward to the playlist ONLY when it
        // has focus AND the key target is not a transport control. Delete
        // has no native behavior on buttons/sliders, but forwarding it there
        // deletes tracks while the user operates transport — the old blanket
        // forward is why Delete felt dangerous after clicking any control.
        const isTextEdit = tag === 'TEXTAREA' || tag === 'SELECT'
            || (target?.isContentEditable ?? false)
            || (tag === 'INPUT' && ['text', 'search', 'number', 'password', 'url', 'email', 'tel'].includes(inputType));
        const onTransportControl = tag === 'BUTTON'
            || (tag === 'INPUT' && ['range', 'checkbox', 'radio', 'button', 'submit', 'color'].includes(inputType));
        if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            if (isTextEdit) return;
            if (onTransportControl) return;
            handlePlaylistNavigation(e);
        } else if (['ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(e.key)) {
            if (isTextEdit) return;
            if (onTransportControl) return;
            // Delete/Backspace must never mutate the playlist from a control:
            // checkboxes/radios/colors/ranges/buttons consume or ignore it
            // natively, and forwarding deletes tracks while operating transport.
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (tag === 'BUTTON') return;
                if (tag === 'INPUT' && ['checkbox', 'radio', 'color', 'range', 'button', 'submit'].includes(inputType)) return;
            }
            if (tag === 'INPUT' && inputType === 'range' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
            if (tag === 'SELECT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
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
                        // Provider, not the node: a fixed masterGain goes dead
                        // on context rebuild and the tap records silence (C7).
                        hiFiRecorder = new HighFidelityRecorder(() => masterGain);
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
                        if (wavBuffer.byteLength > 100 * 1024 * 1024) {
                            toast.error("RECORDING TOO LARGE (100MB CAP) — DISCARDED");
                            return;
                        }

                        const path = await bridge?.saveAudioDialog();
                        // Throttle sentinel is truthy — trap it before the
                        // path guard or it would be written as a file path.
                        if (path === DIALOG_THROTTLED) {
                            logger.debug('[MasterRec] Save-audio dialog throttled — TRY AGAIN');
                            toast.info('DIALOG BUSY — TRY AGAIN (RECORDING DISCARDED)');
                        } else if (path) {
                             const uint8 = new Uint8Array(wavBuffer);
                             // IPC Buffer Alignment Fix
                             const safeBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
                             const success = await fsBridge?.saveFile(path, new Uint8Array(safeBuffer));
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
    // Renderer assumes preload bridges exist — fail loud here so a packaged
    // build with broken preload shows WHAT is missing instead of throwing
    // an inscrutable TypeError on first bridge use.
    const missingBridges = getMissingBridges();
    if (missingBridges.length > 0) {
        logger.error(`[MAIN] Preload bridges missing: ${missingBridges.join(', ')} — aborting init.`);
        showBridgeFatalOverlay(missingBridges);
        return;
    }
    purgeLegacySessionKey();
    applyPlatformStyles();
    
    // Initialize Worklets first
    await initWorklets();
    engine.initWorklets();

    // Closed-context rebuilds (device switch / suspend) kill worklet modules,
    // deck chains, and the recorder tap. Re-attach everything centrally —
    // engine channels self-heal their nodes via ensureNodes, worklets need
    // module re-registration + node re-injection, the recorder needs a retap.
    onAudioRebuilt(() => {
        logger.warn('[MAIN] AudioContext rebuilt — re-attaching worklets + recorder tap');
        void initWorklets()
            .catch(() => undefined)
            .then(() => { try { engine.initWorklets(); } catch { /* ignore */ } });
        try { hiFiRecorder?.retap(); } catch { /* ignore */ }
    });
    
    // Window Controls
    const minBtn = document.getElementById('minBtn');
    const maxBtn = document.getElementById('maxBtn');
    const closeBtn = document.getElementById('closeBtn');
    if (minBtn) minBtn.addEventListener('click', () => bridge?.minimize());
    if (maxBtn) maxBtn.addEventListener('click', () => bridge?.maximize());
    if (closeBtn) closeBtn.addEventListener('click', () => bridge?.close());

    // ORDER MATTERS: initPlayer caches tempoSlider in the DOM. initSampler
    // captures getTempoSlider() — running the sampler first handed it a
    // permanent null and pads ignored the chopper slider forever.
    initPlayer({ renderPlaylist, setBlendingIndex });

    initSampler({
        fsBridge, bridge,
        detectBPM: detectBPMWithConfidence,
        masterBPMRef: getMasterBPMRef(),
        tempoSliderRef: getTempoSlider() as HTMLInputElement
    });

    // Playlist UI wires up immediately (C15). The DB load still waits for the
    // auto-restore so a late async read can't clobber it; a missing/failed
    // restore triggers the DB load afterwards, restored snapshots skip it.
    initPlaylist({ loadTrack, playTrack, skipDbLoad: true });
    setupPlaylistHandlers();
    // Bounded restore wait: a hung restore previously pended forever and
    // the library DB load behind it never ran (empty-looking app). 60s
    // without settling counts as no-restore; a late restore still
    // overwrites (DB-load guards yield to non-empty/restored playlists).
    const restoreWait = checkAndRestore();
    const restoreTimeout = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 60000);
        (t as any)?.unref?.();
    });
    void Promise.race([restoreWait, restoreTimeout]).then((restored) => {
        if (!restored) initPlaylist({ loadTrack, playTrack });
    }).catch(() => {
        try { initPlaylist({ loadTrack, playTrack }); } catch { /* ignore */ }
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ setAutoMixEnabled });

    // Track Info modal (playlist context menu) — focus trap + ESC via shared helpers
    initTrackInfo();

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
             bridge?.openExternal('README.md');
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

            hideAllContextMenus();

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

            hideAllContextMenus();

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

    // Right-click on empty space (not a row/pad/slider/button opener —
    // those stopPropagation and never reach here) dismisses stale menus.
    // Skipped when the click is inside a menu so submenu hovers survive.
    document.addEventListener('contextmenu', (e) => {
        const t = e.target as HTMLElement | null;
        try {
            if (t?.closest?.('.context-menu, .context-submenu')) return;
        } catch { /* ignore */ }
        hideAllContextMenus();
    });
    // Global Click Handler to hide menus
    document.addEventListener('click', () => {
        const playlistCtxMenu = document.getElementById('contextMenu');
        if (playlistCtxMenu) {
            playlistCtxMenu.classList.add('hidden');
            playlistCtxMenu.setAttribute('aria-hidden', 'true');
            try { delete (playlistCtxMenu as HTMLElement).dataset.ctxIndex; } catch { /* ignore */ }
        }
        const samplerSub = document.getElementById('samplerSubmenu');
        if (samplerSub) {
            samplerSub.classList.add('hidden');
            samplerSub.setAttribute('aria-hidden', 'true');
        }
        const samplerParent = document.getElementById('ctxLoadToSampler');
        if (samplerParent) samplerParent.setAttribute('aria-expanded', 'false');
        if (padContextMenuEl) {
            padContextMenuEl.classList.add('hidden');
            padContextMenuEl.setAttribute('aria-hidden', 'true');
            try { delete padContextMenuEl.dataset.padIndex; } catch { /* ignore */ }
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
            controlContextMenuEl.setAttribute('aria-hidden', 'true');
            try { delete controlContextMenuEl.dataset.controlId; } catch { /* ignore */ }
        }
    });
    
    // Startup sequence completion: show the GUI first, then play the
    // shotgun-then-intro stack once the last session is actually on screen.
    // Double-rAF waits for a painted frame; the beat after that lets the
    // restored/DB content finish compositing so it lands as a flourish.
    // Chained behind the restore race (same gate as the DB load) with a
    // 12s absolute cap so a hung restore can never silence the flourish.
    bridge?.appReadyToShow?.();
    const paintReady = new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            window.setTimeout(() => resolve(), 1200);
        }));
    });
    const soundCap = new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 12000);
    });
    void Promise.race([
        Promise.race([restoreWait, restoreTimeout]).then(() => paintReady),
        soundCap,
    ]).then(() => {
        try { playStartupSound(); } catch { /* ignore */ }
    });

    // Initialize crash recovery (auto-save)
    initCrashRecovery();
    // NOTE: checkAndRestore() already ran above (gated before initPlaylist).
    // Do NOT call it again here — two concurrent restores fight over
    // state and double-restore/clear snapshots.

    // === GURU CRASH PROTECTION (RENDERER) ===
    // addEventListener (not assignment) so earlier handlers aren't clobbered.
    // Mirrors the rejection path: re-entrancy flag + 5s throttle so an
    // erroring logger/report can never recurse into a report storm.
    let errorReporting = false;
    let lastErrorReport = 0;
    window.addEventListener('error', (event) => {
        if (errorReporting) return;
        const now = Date.now();
        const { message, filename, lineno, colno, error } = event;
        try { logger.error(`[Renderer Crash] ${message} at ${filename}:${lineno}:${colno}`); } catch { /* ignore */ }
        if (now - lastErrorReport < 5000) return;
        errorReporting = true;
        lastErrorReport = now;
        // Pass a plain snapshot — the live ReactiveStore holds Maps/Sets of
        // functions that throw DataCloneError over IPC.
        let appState: unknown = null;
        try { appState = state.getSnapshot(); } catch { appState = null; }
        try {
            void Promise.resolve(logger.generateCrashReport({
                type: 'RENDERER_ERROR',
                message,
                source: filename,
                lineno,
                colno,
                stack: (error as Error | undefined)?.stack,
                appState
            })).catch((e) => { try { logger.error('[Renderer Crash] Crash report write failed — ring copy is the only evidence', e); } catch { /* ignore */ } }).finally(() => { errorReporting = false; });
        } catch { errorReporting = false; /* report must never throw back into the handler */ }
    });

    let rejectionReporting = false;
    let lastRejectionReport = 0;
    window.addEventListener('unhandledrejection', (event) => {
        try { event.preventDefault(); } catch { /* ignore */ }
        if (rejectionReporting) return;
        const now = Date.now();
        try { logger.error(`[Renderer Rejection] ${event.reason}`); } catch { /* logger must never re-throw into the handler */ }
        if (now - lastRejectionReport < 5000) return;
        rejectionReporting = true;
        lastRejectionReport = now;
        let appState: unknown = null;
        try { appState = state.getSnapshot(); } catch { appState = null; }
        try {
            void Promise.resolve(logger.generateCrashReport({
                type: 'RENDERER_REJECTION',
                reason: String(event.reason)?.slice(0, 2000),
                appState
            })).catch((e) => { try { logger.error('[Renderer Rejection] Crash report write failed — ring copy is the only evidence', e); } catch { /* ignore */ } }).finally(() => { rejectionReporting = false; });
        } catch { rejectionReporting = false; }
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

// First-gesture unlock retries until it takes (H15): the old once:true
// click meant keyboard-first users kept a suspended context and MIDI:OFF
// forever, and one denied MIDI prompt never retried. enableMIDI() is cheap
// to re-call (guard flag while a request is in flight).
function tryFirstGestureUnlock(): void {
    void resumeAudioContext().catch(() => undefined);
    try { enableMIDI(); } catch { /* MIDI unavailable — non-fatal */ }
    try {
        if (audioCtx && audioCtx.state === 'running') {
            document.body.removeEventListener('click', tryFirstGestureUnlock);
            document.body.removeEventListener('keydown', tryFirstGestureUnlock);
        }
    } catch { /* keep listening */ }
}
document.body.addEventListener('click', tryFirstGestureUnlock);
document.body.addEventListener('keydown', tryFirstGestureUnlock);