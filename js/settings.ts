// === SETTINGS MODULE ===
import { toast } from './toast';
import { showConfirm, openModal, closeModal } from './modals';
import { logger } from './logger';
import { DEFAULT_TRACK_DURATION_S, DEFAULT_BTN_DURATION_S } from './constants';

interface AutoMixSettings {
    eqCrossfade: boolean;
    filterSweep: boolean;
    hpfSweep: boolean;
    bpmSync: boolean;
    trackDuration: number;
    btnDuration: number;
    enableAI: boolean;
}

interface Settings {
    fullScreen: boolean;
    inputDevice: string;
    outputDevice: string;
    midiDevice: string;
    autoMix: AutoMixSettings;
}

import './types';

const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;

const _settings: Settings = {
    fullScreen: false,
    inputDevice: 'default',
    outputDevice: 'default',
    midiDevice: 'all',
    autoMix: {
        eqCrossfade: true,
        filterSweep: true,
        hpfSweep: true,
        bpmSync: false,
        trackDuration: DEFAULT_TRACK_DURATION_S,
        btnDuration: DEFAULT_BTN_DURATION_S,
        enableAI: false
    }
};

/** Settings accessor — read-only reference. Use updateSettings() to make changes. */
export const settings: Readonly<Settings> = _settings;

type SettingsPatch = Omit<Partial<Settings>, 'autoMix'> & { autoMix?: Partial<AutoMixSettings> };

/**
 * Update settings with partial patch and auto-save to localStorage.
 * This is the ONLY way to mutate settings that guarantees persistence.
 * Fullscreen actuation happens only when the patch explicitly contains
 * fullScreen (user toggle gesture) — slider-drag saves never actuate.
 */
export function updateSettings(patch: SettingsPatch): void {
    const hadFullscreen = patch && Object.prototype.hasOwnProperty.call(patch, 'fullScreen');
    if (patch.autoMix && typeof patch.autoMix === 'object') {
        const { autoMix, ...rest } = patch;
        Object.assign(_settings, rest);
        Object.assign(_settings.autoMix, autoMix);
    } else {
        Object.assign(_settings, patch);
    }
    saveSettings(hadFullscreen ? { actuateFullscreen: true } : undefined); // persist immediately
}

let setAutoMixEnabledFn: ((enabled: boolean) => void) | null = null;
let _settingsInit = false;

// openModal/closeModal imported from modals.ts

export function initSettings(deps: { setAutoMixEnabled: (enabled: boolean) => void }): void {
    setAutoMixEnabledFn = deps.setAutoMixEnabled;
    if (_settingsInit) { loadSettings(); return; }
    _settingsInit = true;
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettings = document.getElementById('closeSettings');
    
    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            openModal(settingsModal);
            // Enumerate only — no mic request on open. Mic labels are primed
            // on explicit user action (input select interaction, see below).
            void refreshAudioDevices();
        });
    }
    if (closeSettings && settingsModal) {
        closeSettings.addEventListener('click', () => closeModal(settingsModal));
    }

    // Modal Click-outside to close
    window.addEventListener('click', (e) => {
        if (e.target === settingsModal && settingsModal) closeModal(settingsModal);
        const autoMixModal = document.getElementById('autoMixModal');
        if (e.target === autoMixModal && autoMixModal) closeModal(autoMixModal);
        const helpModal = document.getElementById('helpModal');
        if (e.target === helpModal && helpModal) closeModal(helpModal);
        const consoleModal = document.getElementById('consoleModal');
        if (e.target === consoleModal && consoleModal) closeModal(consoleModal);
        const trackInfoModal = document.getElementById('trackInfoModal');
        if (e.target === trackInfoModal && trackInfoModal) closeModal(trackInfoModal);
    });

    setupSettingsHandlers();
    loadSettings();
    // ESC-close is handled once in js/main.ts setupGlobalKeyboardShortcuts —
    // a second handler here used a different visibility model (.active class
    // vs style.display) and left crash-recovery prompts stuck open.
}

export function loadSettings(): void {
    try {
        const saved = localStorage.getItem('ug_settings');
        if (saved) {
            let s: any = null;
            try {
                s = JSON.parse(saved);
            } catch {
                // Corrupt settings previously errored every boot forever — purge once.
                try { localStorage.removeItem('ug_settings'); } catch { /* ignore */ }
                logger.error('Load Settings Error: corrupt JSON purged');
                return;
            }
            if (s && typeof s === 'object') {
                if (typeof s.fullScreen === 'boolean') _settings.fullScreen = s.fullScreen;
                if (typeof s.inputDevice === 'string') _settings.inputDevice = s.inputDevice.slice(0, 256);
                if (typeof s.outputDevice === 'string') _settings.outputDevice = s.outputDevice.slice(0, 256);
                if (typeof s.midiDevice === 'string') _settings.midiDevice = s.midiDevice.slice(0, 256);
                if (s.autoMix && typeof s.autoMix === 'object') {
                    const am = s.autoMix;
                    if (typeof am.eqCrossfade === 'boolean') _settings.autoMix.eqCrossfade = am.eqCrossfade;
                    if (typeof am.filterSweep === 'boolean') _settings.autoMix.filterSweep = am.filterSweep;
                    if (typeof am.hpfSweep === 'boolean') _settings.autoMix.hpfSweep = am.hpfSweep;
                    if (typeof am.bpmSync === 'boolean') _settings.autoMix.bpmSync = am.bpmSync;
                    if (typeof am.enableAI === 'boolean') _settings.autoMix.enableAI = am.enableAI;
                    if (Number.isFinite(Number(am.trackDuration))) _settings.autoMix.trackDuration = Math.min(60, Math.max(0.5, Number(am.trackDuration)));
                    if (Number.isFinite(Number(am.btnDuration))) _settings.autoMix.btnDuration = Math.min(30, Math.max(0.5, Number(am.btnDuration)));
                }
            }
        }
        // First-boot actuation: the block above only ran with saved settings,
        // leaving fresh profiles on HTML slider max=20/8 (code: 60/30) with
        // output/MIDI never synced. Defaults are safe (fullscreen off,
        // default devices), so always apply.
        try { applySettingsToUI(); } catch { /* ignore */ }
        try { setAutoMixEnabledFn?.(settings.autoMix.enableAI); } catch { /* player not ready */ }
        // Apply Full Screen + persisted output route on load (output was
        // previously reflected in the <select> but never actuated).
        if (bridge && bridge.setFullScreen) bridge.setFullScreen(settings.fullScreen);
        try { applyOutputDevice(settings.outputDevice); } catch { /* no device yet */ }
        try {
            void import('./midi').then((m) => {
                try { if (settings.midiDevice) m.setSelectedMidiDevice(settings.midiDevice); } catch { /* ignore */ }
            }).catch(() => undefined);
        } catch { /* MIDI sync best-effort */ }
    } catch(e) {
        logger.error("Load Settings Error", e);
    }
}

/** Persisted AutoMix mutation that actually saves (shallow Readonly was bypassable). */
export function updateAutoMix(patch: Partial<typeof _settings.autoMix>): void {
    const clean: Partial<typeof _settings.autoMix> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (['eqCrossfade', 'filterSweep', 'hpfSweep', 'bpmSync', 'enableAI'].includes(k)) {
            if (typeof v === 'boolean') (clean as any)[k] = v;
        } else if (k === 'trackDuration' && Number.isFinite(Number(v))) {
            clean.trackDuration = Math.min(60, Math.max(0.5, Number(v)));
        } else if (k === 'btnDuration' && Number.isFinite(Number(v))) {
            clean.btnDuration = Math.min(30, Math.max(0.5, Number(v)));
        }
    }
    Object.assign(_settings.autoMix, clean);
    saveSettings();
}

export function applySettingsToUI(): void {
    const fullScreenToggle = document.getElementById('fullScreenToggle') as HTMLInputElement;
    if (fullScreenToggle) fullScreenToggle.checked = !!settings.fullScreen;

    const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade') as HTMLInputElement;
    const mixOptFilterSweep = document.getElementById('mixOptFilterSweep') as HTMLInputElement;
    const mixOptHPFSweep = document.getElementById('mixOptHPFSweep') as HTMLInputElement;
    const mixOptBPMSync = document.getElementById('mixOptBPMSync') as HTMLInputElement;
    const mixOptEnableAI = document.getElementById('mixOptEnableAI') as HTMLInputElement;

    if (mixOptEQCrossfade) mixOptEQCrossfade.checked = !!settings.autoMix.eqCrossfade;
    if (mixOptFilterSweep) mixOptFilterSweep.checked = !!settings.autoMix.filterSweep;
    if (mixOptHPFSweep) mixOptHPFSweep.checked = !!settings.autoMix.hpfSweep;
    if (mixOptBPMSync) mixOptBPMSync.checked = !!settings.autoMix.bpmSync;
    if (mixOptEnableAI) mixOptEnableAI.checked = !!settings.autoMix.enableAI;

    updateSliderUI('sliderTrackFade', 'valTrackFade', settings.autoMix.trackDuration);
    updateSliderUI('sliderBtnFade', 'valBtnFade', settings.autoMix.btnDuration);

    try {
        void import('./midi').then((m) => {
            try { m.setSelectedMidiDevice(settings.midiDevice || 'all'); } catch { /* ignore */ }
        }).catch(() => undefined);
    } catch { /* ignore */ }
}

export function saveSettings(opts?: { actuateFullscreen?: boolean }): void {
    try {
        const fullScreenToggle = document.getElementById('fullScreenToggle') as HTMLInputElement;
        const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade') as HTMLInputElement;
        const mixOptFilterSweep = document.getElementById('mixOptFilterSweep') as HTMLInputElement;
        const mixOptHPFSweep = document.getElementById('mixOptHPFSweep') as HTMLInputElement;
        const mixOptBPMSync = document.getElementById('mixOptBPMSync') as HTMLInputElement;
        const mixOptEnableAI = document.getElementById('mixOptEnableAI') as HTMLInputElement;

        // DOM-read-then-overwrite: only touch fields whose controls exist so a
        // missing modal can't clobber persisted values with stale state.
        if (fullScreenToggle) _settings.fullScreen = fullScreenToggle.checked;
        if (mixOptEQCrossfade) _settings.autoMix.eqCrossfade = mixOptEQCrossfade.checked;
        if (mixOptFilterSweep) _settings.autoMix.filterSweep = mixOptFilterSweep.checked;
        if (mixOptHPFSweep) _settings.autoMix.hpfSweep = mixOptHPFSweep.checked;
        if (mixOptBPMSync) _settings.autoMix.bpmSync = mixOptBPMSync.checked;
        if (mixOptEnableAI) _settings.autoMix.enableAI = mixOptEnableAI.checked;

        // M26: merge — never last-wins drop. midi.ts writes midiDevice /
        // midiDeviceName into the same key; a blind write of _settings would
        // drop those (and a stale _settings.midiDevice would clobber a fresh
        // MIDI selection). Adopt the stored MIDI route when _settings is stale.
        let existing: Record<string, unknown> | null = null;
        try {
            const raw = localStorage.getItem('ug_settings');
            existing = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        } catch { existing = null; }
        if (existing && typeof existing === 'object') {
            const storedMidi = existing['midiDevice'];
            if (typeof storedMidi === 'string' && storedMidi && storedMidi !== _settings.midiDevice) {
                _settings.midiDevice = storedMidi.slice(0, 256);
            }
        }
        const merged: Record<string, unknown> = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            ...JSON.parse(JSON.stringify(_settings)) as Record<string, unknown>,
        };
        // Preserve keys _settings does not own (e.g. midiDeviceName).
        if (existing && typeof existing === 'object' && existing['midiDeviceName'] !== undefined) {
            (merged as Record<string, unknown>)['midiDeviceName'] = existing['midiDeviceName'];
        }
        try {
            localStorage.setItem('ug_settings', JSON.stringify(merged));
        } catch (quotaErr) {
            // Quota/private-mode failures must surface (not silent) so the
            // user knows persistence is off.
            logger.error('Save Settings Error (quota?)', quotaErr);
            try { toast.error('SETTINGS NOT SAVED (STORAGE FULL?)'); } catch { /* ignore */ }
            throw quotaErr;
        }

        // Actuate Full Screen only on explicit toggle (gesture) — never on
        // slider-drag saves. Callers pass { actuateFullscreen: true } only
        // from the fullscreen toggle handler / updateSettings fullScreen patch.
        if (opts?.actuateFullscreen && bridge && bridge.setFullScreen) {
            try { bridge.setFullScreen(_settings.fullScreen); } catch { /* ignore */ }
        }
    } catch (e) {
        // Quota/private-mode failures previously threw out of every settings write.
        logger.error('Save Settings Error', e);
    }
}

export function isAiEnabled(): boolean {
    return _settings.autoMix.enableAI;
}

export function setAutoMixPreference(enabled: boolean): void {
    if (typeof enabled !== 'boolean') return;
    _settings.autoMix.enableAI = enabled;
    saveSettings();
}

function updateSliderUI(sliderId: string, labelId: string, val: number): void {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const label = document.getElementById(labelId);
    if (slider && label) {
        // DOM max (20/8) disagrees with code clamp (60/30): widen the control
        // so restored session values aren't silently clamped by the browser.
        try {
            const isTrack = sliderId === 'sliderTrackFade';
            slider.max = isTrack ? '60' : '30';
            slider.min = '0.5';
        } catch { /* ignore */ }
        slider.value = val.toString();
        label.innerText = val.toFixed(1) + 's';
    }
}

export function setupSettingsHandlers(): void {
    const btnOpenAutoMix = document.getElementById('btnOpenAutoMix');
    const autoMixModal = document.getElementById('autoMixModal');
    const closeAutoMix = document.getElementById('closeAutoMix');
    const closeAutoMixBtn = document.getElementById('closeAutoMixBtn');

    if (btnOpenAutoMix && autoMixModal) btnOpenAutoMix.addEventListener('click', () => { openModal(autoMixModal); });
    if (closeAutoMix && autoMixModal) closeAutoMix.addEventListener('click', () => { closeModal(autoMixModal); });
    if (closeAutoMixBtn && autoMixModal) closeAutoMixBtn.addEventListener('click', () => { closeModal(autoMixModal); });

    // Device selects were stored but never actuated — persist + route output
    const inputSelect = document.getElementById('inputDeviceSelect') as HTMLSelectElement;
    const outputSelect = document.getElementById('outputDeviceSelect') as HTMLSelectElement;
    inputSelect?.addEventListener('change', () => {
        // Never persist an empty/placeholder device id.
        if (!inputSelect.value) return;
        updateSettings({ inputDevice: inputSelect.value });
    });
    outputSelect?.addEventListener('change', () => {
        if (!outputSelect.value) return;
        updateSettings({ outputDevice: outputSelect.value });
        applyOutputDevice(outputSelect.value);
    });
    // Mic labels unlock only on explicit user action (focus/open of the
    // input select), not on every settings open. One-shot per session once
    // real labels are obtained.
    if (inputSelect && !_micPrimeWired) {
        _micPrimeWired = true;
        inputSelect.addEventListener('pointerdown', primeMicLabelsOnce);
        inputSelect.addEventListener('focus', primeMicLabelsOnce);
    }

    // Auto-save on any change (via updateSettings so persistence is unified).
    // Route AutoMix checkbox changes into the player engine — previously the
    // settings UI never actuated it (dead setAutoMixEnabledFn signal).
    // Fullscreen actuates only on its explicit toggle (user gesture) — other
    // inputs + slider drags persist without touching fullscreen.
    const inputs = ['mixOptEQCrossfade', 'mixOptFilterSweep', 'mixOptHPFSweep', 'mixOptBPMSync', 'mixOptEnableAI'];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => updateSettings({}));
    });
    const fullToggle = document.getElementById('fullScreenToggle') as HTMLInputElement | null;
    if (fullToggle) fullToggle.addEventListener('change', () => {
        try {
            if (bridge && bridge.setFullScreen) bridge.setFullScreen(fullToggle.checked);
        } catch { /* ignore */ }
        updateSettings({ fullScreen: fullToggle.checked });
    });
    const autoMixBtn = document.getElementById('autoMixBtn');
    const mixAiCb = document.getElementById('mixOptEnableAI') as HTMLInputElement | null;
    if (mixAiCb) mixAiCb.addEventListener('change', () => {
        try { if (setAutoMixEnabledFn) setAutoMixEnabledFn(mixAiCb.checked); } catch { /* ignore */ }
    });
    void autoMixBtn;

    setupDurationSlider('sliderTrackFade', 'valTrackFade', true);
    setupDurationSlider('sliderBtnFade', 'valBtnFade', false);

    // --- Restore Defaults ---
    const restoreBtn = document.getElementById('restoreDefaultsBtn');
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
            showConfirm("RESTORE DEFAULTS?", "This will reset all your audio and Auto-Mix preferences.", () => {
                _settings.fullScreen = false;
                _settings.inputDevice = 'default';
                _settings.outputDevice = 'default';
                _settings.midiDevice = 'all';
                _settings.autoMix = {
                    eqCrossfade: true,
                    filterSweep: true,
                    hpfSweep: true,
                    bpmSync: false,
                    trackDuration: DEFAULT_TRACK_DURATION_S,
                    btnDuration: DEFAULT_BTN_DURATION_S,
                    enableAI: false
                };
                applySettingsToUI();
                saveSettings();
                try { setAutoMixEnabledFn?.(false); } catch { /* player not ready */ }

                // M19: defaults must reach the UI selects + actuation, not
                // just _settings — stale selects/output-route/fullscreen
                // otherwise survive the "reset".
                try {
                    const inSel = document.getElementById('inputDeviceSelect') as HTMLSelectElement | null;
                    if (inSel) inSel.value = _settings.inputDevice;
                    const outSel = document.getElementById('outputDeviceSelect') as HTMLSelectElement | null;
                    if (outSel) outSel.value = _settings.outputDevice;
                } catch { /* ignore */ }
                try { applyOutputDevice(_settings.outputDevice); } catch { /* ignore */ }
                try { if (bridge && bridge.setFullScreen) bridge.setFullScreen(false); } catch { /* ignore */ }
                try {
                    void import('./midi').then((m) => {
                        try { m.setSelectedMidiDevice('all'); } catch { /* ignore */ }
                    }).catch(() => undefined);
                } catch { /* ignore */ }
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
            openModal(helpModal);
        });
    }
    if (closeHelpBtn && helpModal) {
        closeHelpBtn.addEventListener('click', () => {
            closeModal(helpModal);
        });
    }

    // --- Console Modal Logic ---
    const consoleModal = document.getElementById('consoleModal');
    const openConsoleBtn = document.getElementById('openConsoleBtn');
    const closeConsoleBtn = document.getElementById('closeConsole');
    const consoleCopyBtn = document.getElementById('consoleCopyBtn');
    const consoleClearBtn = document.getElementById('consoleClearBtn');
    const consoleOutput = document.getElementById('consoleOutput');

    // Function to render logs into the console output
    function renderConsoleLogs(): void {
        if (!consoleOutput) return;
        const logs = logger.getLogs();
        consoleOutput.innerHTML = logs.map(e => {
            const levelClass = e.level.toLowerCase();
            return `<div class="console-line console-${levelClass}">
                <span class="console-time">[${e.timestamp}]</span>
                <span class="console-level">[${e.level}]</span>
                <span class="console-msg">${escapeHtml(e.message)}</span>
            </div>`;
        }).join('');
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    if (openConsoleBtn && consoleModal) {
        openConsoleBtn.addEventListener('click', () => {
            openModal(consoleModal);
            renderConsoleLogs();
        });
    }
    if (closeConsoleBtn && consoleModal) {
        closeConsoleBtn.addEventListener('click', () => {
            closeModal(consoleModal);
        });
    }
    if (consoleCopyBtn) {
        consoleCopyBtn.addEventListener('click', () => {
            const text = logger.getLogsAsText();
            navigator.clipboard.writeText(text).then(() => {
                toast.success("LOGS COPIED TO CLIPBOARD");
            }).catch(() => {
                // Fallback for environments without clipboard API
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                toast.success("LOGS COPIED TO CLIPBOARD");
            });
        });
    }
    if (consoleClearBtn) {
        consoleClearBtn.addEventListener('click', () => {
            // Clear the ring buffer too — previously "CLEARED" only wiped the
            // DOM and every log resurrected on the next modal open.
            logger.clearLogs();
            if (consoleOutput) consoleOutput.innerHTML = '';
            toast.info("CONSOLE CLEARED");
        });
    }
}

/** Utility: escape HTML entities to prevent XSS in log display */
function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function setupDurationSlider(sliderId: string, labelId: string, isTrackFade: boolean): void {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const label = document.getElementById(labelId);
    if (!slider || !label) return;

    // Debounced save: dragging previously fired saveSettings() (localStorage
    // + setFullScreen IPC) on every input tick — jank + window flash.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    slider.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const val = parseFloat(target.value);
        if (!Number.isFinite(val)) return; // NaN previously persisted as null
        const lo = 0.5, hi = isTrackFade ? 60 : 30;
        const clamped = Math.min(hi, Math.max(lo, val));
        label.innerText = clamped.toFixed(1) + 's';
        if (isTrackFade) _settings.autoMix.trackDuration = clamped;
        else _settings.autoMix.btnDuration = clamped;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try { saveSettings(); } catch { /* ignore */ }
        }, 300);
    });
}

async function refreshAudioDevices(options?: { requestMic?: boolean }): Promise<void> {
    const inputSelect = document.getElementById('inputDeviceSelect') as HTMLSelectElement;
    const outputSelect = document.getElementById('outputDeviceSelect') as HTMLSelectElement;
    if (!inputSelect || !outputSelect) return;

    let stream: MediaStream | null = null;
    try {
        // Mic is requested ONLY on explicit user action (requestMic: true).
        // A plain enumerate never warms the mic; labels stay placeholders
        // until the user deliberately primes them.
        if (options?.requestMic) {
            // Check if we already have mic permission before requesting
            let hasPermission = false;
            if (navigator.permissions?.query) {
                try {
                    const permStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                    hasPermission = permStatus.state === 'granted';
                    if (permStatus.state === 'denied') {
                        logger.warn("Microphone permission denied — audio device list may be incomplete");
                    }
                } catch { /* permissions API unavailable — request directly */ }
            }
            if (!hasPermission) {
                // The stream exists ONLY to unlock device labels — it is
                // stopped immediately after enumerateDevices resolves.
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } catch (e) {
                    logger.warn("Mic label prime failed", e);
                }
            }
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        // Release the mic BEFORE touching the DOM so a slow render can't
        // keep the indicator hot.
        if (stream) {
            try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
            stream = null;
        }
        inputSelect.innerHTML = '';
        outputSelect.innerHTML = '';

        let inputIdx = 0;
        let outputIdx = 0;
        for (const device of devices) {
            const option = document.createElement('option');
            option.value = device.deviceId;
            // Never surface an empty label as a selectable identity — empty
            // labels are placeholders, never persisted.
            if (device.kind === 'audioinput') {
                inputIdx++;
                option.text = device.label || `Microphone ${inputIdx}`;
                if (!device.label) option.dataset['unlabeled'] = '1';
                inputSelect.appendChild(option);
            } else if (device.kind === 'audiooutput') {
                outputIdx++;
                option.text = device.label || `Speaker ${outputIdx}`;
                if (!device.label) option.dataset['unlabeled'] = '1';
                outputSelect.appendChild(option);
            }
        }

        // Reflect persisted selections (only when the stored id exists and
        // the matched option carries a real label).
        if (settings.inputDevice && settings.inputDevice !== 'default') {
            const opt = Array.from(inputSelect.options).find(o => o.value === settings.inputDevice);
            if (opt && !opt.dataset['unlabeled']) inputSelect.value = settings.inputDevice;
        }
        if (settings.outputDevice && settings.outputDevice !== 'default') {
            const opt = Array.from(outputSelect.options).find(o => o.value === settings.outputDevice);
            if (opt && !opt.dataset['unlabeled']) outputSelect.value = settings.outputDevice;
        }
        // Unplug desync: a stored id with no live option left the UI on the
        // first device while _settings kept the stale id — the next save
        // wrote the dead route back and audio silently stayed misrouted.
        try {
            let corrected = false;
            if (inputSelect.value !== _settings.inputDevice) {
                const live = Array.from(inputSelect.options).some(o => o.value === _settings.inputDevice);
                if (!live) { _settings.inputDevice = inputSelect.value || 'default'; corrected = true; }
            }
            if (outputSelect.value !== _settings.outputDevice) {
                const live = Array.from(outputSelect.options).some(o => o.value === _settings.outputDevice);
                if (!live) { _settings.outputDevice = outputSelect.value || 'default'; corrected = true; }
            }
            if (corrected) saveSettings();
        } catch { /* correction best-effort */ }
        // Labels obtained — no further mic primes needed this session.
        if (options?.requestMic) {
            const anyLabeled = devices.some(d => !!d.label);
            if (anyLabeled) _micPrimed = true;
        }
    } catch (e) {
        logger.warn("Device refresh failed", e);
    } finally {
        if (stream) {
            try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
        }
    }
}

// One-shot mic-label priming on explicit user action (input-select focus).
let _micPrimed = false;
let _micPrimeWired = false;
function primeMicLabelsOnce(): void {
    if (_micPrimed) return;
    _micPrimed = true; // single attempt per session — no repeated prompts
    void refreshAudioDevices({ requestMic: true }).catch(() => undefined);
}

/**
 * Best-effort output routing via setSinkId on the deck audio elements +
 * AudioContext.setSinkId for sampler/worklet paths (which ignore element sinks).
 * Chromium supports it; failures are non-fatal.
 */
async function applyOutputDevice(deviceId: string): Promise<void> {
    try {
        const { engine } = await import('./audio-engine');
        for (const channel of [engine.main, engine.crossfade]) {
            const audio = channel.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
            if (typeof audio.setSinkId === 'function') {
                await audio.setSinkId(deviceId === 'default' ? '' : deviceId);
            }
        }
        try {
            const { audioCtx, ensureAudio } = await import('./audio');
            if (ensureAudio() && audioCtx) {
                const ctxWithSink = audioCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
                if (typeof ctxWithSink.setSinkId === 'function') {
                    await ctxWithSink.setSinkId(deviceId === 'default' ? '' : deviceId);
                }
            }
        } catch { /* context sink unsupported — deck routing still applies */ }
        logger.info(`[Settings] Output device applied: ${deviceId}`);
    } catch (e) {
        logger.warn(`[Settings] Could not apply output device: ${e}`);
    }
}