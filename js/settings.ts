// === SETTINGS MODULE ===
import { toast } from './toast';
import { showConfirm } from './player';

interface AutoMixSettings {
    eqCrossfade: boolean;
    filterSweep: boolean;
    hpfSweep: boolean;
    bpmSync: boolean;
    trackDuration: number;
    btnDuration: number;
}

interface Settings {
    fullScreen: boolean;
    inputDevice: string;
    outputDevice: string;
    midiDevice: string;
    autoMix: AutoMixSettings;
}

import './types';

const bridge = window.electronAPI;

export const settings: Settings = {
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

let setAutoMixEnabledFn: ((enabled: boolean) => void) | null = null;

export function initSettings(deps: { setAutoMixEnabled: (enabled: boolean) => void }): void {
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
        if (e.target === settingsModal && settingsModal) settingsModal.style.display = 'none';
        const autoMixModal = document.getElementById('autoMixModal');
        if (e.target === autoMixModal && autoMixModal) autoMixModal.style.display = 'none';
        const helpModal = document.getElementById('helpModal');
        if (e.target === helpModal && helpModal) helpModal.style.display = 'none';
    });

    setupSettingsHandlers();
    loadSettings();

    // Escape key closes topmost modal or context menu
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // Priority order: child modals first, then parent settings modal, then context menus
        const modals = ['confirmModal', 'autoMixModal', 'helpModal', 'settingsModal', 'padContextMenu', 'contextMenu'];
        for (const id of modals) {
            const el = document.getElementById(id);
            if (!el) continue;
            const isVisible = el.style.display === 'block' || 
                              el.style.display === 'flex' ||
                              (el.style.display !== 'none' && getComputedStyle(el).display !== 'none');
            if (isVisible) {
                el.style.display = 'none';
                e.preventDefault();
                e.stopPropagation();
                break;
            }
        }
    });
}

export function loadSettings(): void {
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

function applySettingsToUI(): void {
    const fullScreenToggle = document.getElementById('fullScreenToggle') as HTMLInputElement;
    if (fullScreenToggle) fullScreenToggle.checked = !!settings.fullScreen;

    const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade') as HTMLInputElement;
    const mixOptFilterSweep = document.getElementById('mixOptFilterSweep') as HTMLInputElement;
    const mixOptHPFSweep = document.getElementById('mixOptHPFSweep') as HTMLInputElement;
    const mixOptBPMSync = document.getElementById('mixOptBPMSync') as HTMLInputElement;

    if (mixOptEQCrossfade) mixOptEQCrossfade.checked = !!settings.autoMix.eqCrossfade;
    if (mixOptFilterSweep) mixOptFilterSweep.checked = !!settings.autoMix.filterSweep;
    if (mixOptHPFSweep) mixOptHPFSweep.checked = !!settings.autoMix.hpfSweep;
    if (mixOptBPMSync) mixOptBPMSync.checked = !!settings.autoMix.bpmSync;

    updateSliderUI('sliderTrackFade', 'valTrackFade', settings.autoMix.trackDuration);
    updateSliderUI('sliderBtnFade', 'valBtnFade', settings.autoMix.btnDuration);
}

export function saveSettings(): void {
    const fullScreenToggle = document.getElementById('fullScreenToggle') as HTMLInputElement;
    const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade') as HTMLInputElement;
    const mixOptFilterSweep = document.getElementById('mixOptFilterSweep') as HTMLInputElement;
    const mixOptHPFSweep = document.getElementById('mixOptHPFSweep') as HTMLInputElement;
    const mixOptBPMSync = document.getElementById('mixOptBPMSync') as HTMLInputElement;

    settings.fullScreen = fullScreenToggle ? fullScreenToggle.checked : settings.fullScreen;
    if (mixOptEQCrossfade) settings.autoMix.eqCrossfade = mixOptEQCrossfade.checked;
    if (mixOptFilterSweep) settings.autoMix.filterSweep = mixOptFilterSweep.checked;
    if (mixOptHPFSweep) settings.autoMix.hpfSweep = mixOptHPFSweep.checked;
    if (mixOptBPMSync) settings.autoMix.bpmSync = mixOptBPMSync.checked;

    localStorage.setItem('ug_settings', JSON.stringify(settings));
    
    // Actuate Full Screen
    if (bridge && bridge.setFullScreen) bridge.setFullScreen(settings.fullScreen);
}

function updateSliderUI(sliderId: string, labelId: string, val: number): void {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const label = document.getElementById(labelId);
    if (slider && label) {
        slider.value = val.toString();
        label.innerText = val.toFixed(1) + 's';
    }
}

export function setupSettingsHandlers(): void {
    const btnOpenAutoMix = document.getElementById('btnOpenAutoMix');
    const autoMixModal = document.getElementById('autoMixModal');
    const closeAutoMix = document.getElementById('closeAutoMix');
    const closeAutoMixBtn = document.getElementById('closeAutoMixBtn');

    if (btnOpenAutoMix && autoMixModal) btnOpenAutoMix.addEventListener('click', () => { autoMixModal.style.display = 'block'; });
    if (closeAutoMix && autoMixModal) closeAutoMix.addEventListener('click', () => { autoMixModal.style.display = 'none'; });
    if (closeAutoMixBtn && autoMixModal) closeAutoMixBtn.addEventListener('click', () => { autoMixModal.style.display = 'none'; });

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
            helpModal.style.display = 'block';
        });
    }
    if (closeHelpBtn && helpModal) {
        closeHelpBtn.addEventListener('click', () => {
            helpModal.style.display = 'none';
        });
    }
}

function setupDurationSlider(sliderId: string, labelId: string, isTrackFade: boolean): void {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const label = document.getElementById(labelId);
    if (!slider || !label) return;

    slider.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const val = parseFloat(target.value);
        label.innerText = val.toFixed(1) + 's';
        if (isTrackFade) settings.autoMix.trackDuration = val;
        else settings.autoMix.btnDuration = val;
        saveSettings();
    });
}

async function refreshAudioDevices(): Promise<void> {
    const inputSelect = document.getElementById('inputDeviceSelect') as HTMLSelectElement;
    const outputSelect = document.getElementById('outputDeviceSelect') as HTMLSelectElement;
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
