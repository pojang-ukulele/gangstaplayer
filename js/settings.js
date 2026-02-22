// === SETTINGS MODULE ===
import { toast } from './toast.js';
import { showConfirm } from './player.js';

const bridge = window.electronAPI;

export const settings = {
    fullScreen: false,
    inputDevice: 'default',
    outputDevice: 'default',
    midiDevice: 'all',
    autoMix: {
        eqCrossfade: true,
        filterSweep: true,
        hpfSweep: true,
        bpmSync: false,
        trackDuration: 10.0,
        btnDuration: 4.0
    }
};

let setAutoMixEnabledFn = null;

export function initSettings(deps) {
    setAutoMixEnabledFn = deps.setAutoMixEnabled;
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettings = document.getElementById('closeSettings');
    
    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            settingsModal.style.display = 'block';
            refreshAudioDevices();
        });
    }
    if (closeSettings && settingsModal) {
        closeSettings.addEventListener('click', () => settingsModal.style.display = 'none');
    }

    // Modal Click-outside to close
    window.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.style.display = 'none';
        const autoMixModal = document.getElementById('autoMixModal');
        if (e.target === autoMixModal) autoMixModal.style.display = 'none';
        const helpModal = document.getElementById('helpModal');
        if (e.target === helpModal) helpModal.style.display = 'none';
    });

    setupSettingsHandlers();
    loadSettings();
}

export function loadSettings() {
    try {
        const saved = localStorage.getItem('ug_settings');
        if (saved) {
            const s = JSON.parse(saved);
            Object.assign(settings, s);
            applySettingsToUI();
            // Apply Full Screen on load
            if (bridge && bridge.setFullScreen) bridge.setFullScreen(settings.fullScreen);
        }
    } catch(e) { console.error("Load Settings Error", e); }
}

function applySettingsToUI() {
    const fullScreenToggle = document.getElementById('fullScreenToggle');
    if (fullScreenToggle) fullScreenToggle.checked = !!settings.fullScreen;

    const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade');
    const mixOptFilterSweep = document.getElementById('mixOptFilterSweep');
    const mixOptHPFSweep = document.getElementById('mixOptHPFSweep');
    const mixOptBPMSync = document.getElementById('mixOptBPMSync');

    if (mixOptEQCrossfade) mixOptEQCrossfade.checked = !!settings.autoMix.eqCrossfade;
    if (mixOptFilterSweep) mixOptFilterSweep.checked = !!settings.autoMix.filterSweep;
    if (mixOptHPFSweep) mixOptHPFSweep.checked = !!settings.autoMix.hpfSweep;
    if (mixOptBPMSync) mixOptBPMSync.checked = !!settings.autoMix.bpmSync;

    updateSliderUI('sliderTrackFade', 'valTrackFade', settings.autoMix.trackDuration);
    updateSliderUI('sliderBtnFade', 'valBtnFade', settings.autoMix.btnDuration);
}

export function saveSettings() {
    const fullScreenToggle = document.getElementById('fullScreenToggle');
    const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade');
    const mixOptFilterSweep = document.getElementById('mixOptFilterSweep');
    const mixOptHPFSweep = document.getElementById('mixOptHPFSweep');
    const mixOptBPMSync = document.getElementById('mixOptBPMSync');

    settings.fullScreen = fullScreenToggle ? fullScreenToggle.checked : settings.fullScreen;
    if (mixOptEQCrossfade) settings.autoMix.eqCrossfade = mixOptEQCrossfade.checked;
    if (mixOptFilterSweep) settings.autoMix.filterSweep = mixOptFilterSweep.checked;
    if (mixOptHPFSweep) settings.autoMix.hpfSweep = mixOptHPFSweep.checked;
    if (mixOptBPMSync) settings.autoMix.bpmSync = mixOptBPMSync.checked;

    if (mixOptBPMSync) settings.autoMix.bpmSync = mixOptBPMSync.checked;

    localStorage.setItem('ug_settings', JSON.stringify(settings));
    
    // Actuate Full Screen
    if (bridge && bridge.setFullScreen) bridge.setFullScreen(settings.fullScreen);
}

function updateSliderUI(sliderId, labelId, val) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (slider && label) {
        slider.value = val;
        label.innerText = val.toFixed(1) + 's';
    }
}

export function setupSettingsHandlers() {
    const btnOpenAutoMix = document.getElementById('btnOpenAutoMix');
    const autoMixModal = document.getElementById('autoMixModal');
    const closeAutoMix = document.getElementById('closeAutoMix');
    const closeAutoMixBtn = document.getElementById('closeAutoMixBtn');

    if (btnOpenAutoMix) btnOpenAutoMix.addEventListener('click', () => { autoMixModal.style.display = 'block'; });
    if (closeAutoMix) closeAutoMix.addEventListener('click', () => { autoMixModal.style.display = 'none'; });
    if (closeAutoMixBtn) closeAutoMixBtn.addEventListener('click', () => { autoMixModal.style.display = 'none'; });

    // Auto-save on any change
    const inputs = ['fullScreenToggle', 'mixOptEQCrossfade', 'mixOptFilterSweep', 'mixOptHPFSweep', 'mixOptBPMSync'];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveSettings);
    });

    setupDurationSlider('sliderTrackFade', 'valTrackFade', true);
    setupDurationSlider('sliderBtnFade', 'valBtnFade', false);

    // --- Restore Defaults ---
    const restoreBtn = document.getElementById('restoreDefaultsBtn');
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
            showConfirm("RESTORE DEFAULTS?", "This will reset all your audio and Auto-Mix preferences.", () => {
                settings.fullScreen = false;
                settings.inputDevice = 'default';
                settings.outputDevice = 'default';
                settings.midiDevice = 'all';
                settings.autoMix = {
                    eqCrossfade: true,
                    filterSweep: true,
                    hpfSweep: true,
                    bpmSync: false,
                    trackDuration: 10.0,
                    btnDuration: 4.0
                };
                saveSettings();
                applySettingsToUI();
                toast.success("SETTINGS RESTORED TO DEFAULTS");
            });
        });
    }

    // --- Help Modal Logic ---
    const helpModal = document.getElementById('helpModal');
    const openHelpBtn = document.getElementById('openHelpFromSettings');
    const closeHelpBtn = document.getElementById('closeHelp');

    if (openHelpBtn && helpModal) {
        openHelpBtn.addEventListener('click', () => {
            console.log("Opening Help Modal");
            helpModal.style.display = 'block';
        });
    }
    if (closeHelpBtn && helpModal) {
        closeHelpBtn.addEventListener('click', () => {
            helpModal.style.display = 'none';
        });
    }
}

function setupDurationSlider(sliderId, labelId, isTrackFade) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (!slider || !label) return;

    slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        label.innerText = val.toFixed(1) + 's';
        if (isTrackFade) settings.autoMix.trackDuration = val;
        else settings.autoMix.btnDuration = val;
        saveSettings();
    });
}

async function refreshAudioDevices() {
    const inputSelect = document.getElementById('inputDeviceSelect');
    const outputSelect = document.getElementById('outputDeviceSelect');
    if (!inputSelect || !outputSelect) return;

    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        inputSelect.innerHTML = '';
        outputSelect.innerHTML = '';
        
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `${device.kind} - ${device.deviceId.substring(0, 8)}`;
            if (device.kind === 'audioinput') inputSelect.appendChild(option);
            else if (device.kind === 'audiooutput') outputSelect.appendChild(option);
        });
    } catch (e) { console.warn("Device refresh failed", e); }
}
