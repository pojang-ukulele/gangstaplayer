// === MAIN ENTRY POINT ===
import { KEYBOARD_MAP } from './constants.js';
import { resumeAudioContext } from './audio.js';
import { enableMIDI, initMIDI } from './midi.js';
import { 
    initSampler, createPadGrid, setupPadKeyboardHandlers, getPadGrid,
    startPad, stopPad, loadSampleFile, loadSampleFromPath,
    padBuffers, activeVoices, padVolumes
} from './sampler.js';
import { 
    initPlayer, setupPlayerHandlers, loadTrack, playTrack, pauseTrack, 
    detectBPM, getMasterBPMRef, getTempoSlider, setAutoMixEnabled,
    playerAudio, currentTrackIndex
} from './player.js';
import { initPlaylist, setupPlaylistHandlers, renderPlaylist, playlist } from './playlist.js';
import { initSettings, setupSettingsHandlers, loadSettings } from './settings.js';

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

    initPlayer({ playlist, renderPlaylist });

    initPlaylist({
        loadTrack, playTrack,
        currentTrackIndexRef: { get value() { return currentTrackIndex; } }
    });

    initMIDI({ startPad, stopPad, activeVoices, padVolumes });

    initSettings({ bridge, playerAudio, setAutoMixEnabled });

    createPadGrid();
    setupPadKeyboardHandlers();
    setupPlayerHandlers();
    setupPlaylistHandlers();
    setupSettingsHandlers();
    loadSettings();

    // Context Menu for Pads
    const padGrid = getPadGrid();
    if (padGrid) {
        for (let i = 0; i < 16; i++) {
            const pad = padGrid.children[i]?.querySelector('.pad');
            if (pad) {
                pad.addEventListener('mousedown', (e) => { if (e.button === 0 && padBuffers[i]) startPad(i); });
                pad.addEventListener('mouseup', () => stopPad(i));
                pad.addEventListener('mouseleave', () => stopPad(i));
            }
        }
    }

    if (bridge?.appReadyToShow) bridge.appReadyToShow();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

document.body.addEventListener('click', () => { resumeAudioContext(); enableMIDI(); }, { once: true });
