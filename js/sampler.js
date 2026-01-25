// === SAMPLER MODULE ===
import { KEYBOARD_MAP, DEFAULT_PAD_VOLUME } from './constants.js';
import { audioCtx, masterGain, resumeAudioContext } from './audio.js';

export const padBuffers = {};
export const padPaths = {};
export const activeVoices = {};
export const padVolumes = new Array(16).fill(DEFAULT_PAD_VOLUME);
export const padBPMs = {};
export const padSyncState = {};

let padGrid = null;
let fsBridgeRef = null;
let bridgeRef = null;
let detectBPMFn = null;
let masterBPMRef = { value: 0 };
let tempoSliderRef = null;

export function initSampler(deps) {
    fsBridgeRef = deps.fsBridge;
    bridgeRef = deps.bridge;
    detectBPMFn = deps.detectBPM;
    masterBPMRef = deps.masterBPMRef;
    tempoSliderRef = deps.tempoSlider;
    padGrid = document.getElementById('padGrid');
}

export function getPadGrid() { return padGrid; }

export async function loadSampleFile(file, index, padElement) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        if (padElement) padElement.classList.add('loaded');
        if (detectBPMFn) padBPMs[index] = detectBPMFn(audioBuffer);
    } catch (e) { console.error("Sample load failed:", e); }
}

export async function loadSampleFromPath(path, index) {
    try {
        const rawData = await fsBridgeRef.readFile(path);
        const arrayBuffer = rawData.buffer || rawData;
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        const padElement = padGrid?.children[index]?.querySelector('.pad');
        if (padElement) padElement.classList.add('loaded');
        if (detectBPMFn) padBPMs[index] = detectBPMFn(audioBuffer);
    } catch (e) { console.error("Sample load from path failed:", e); }
}

export function startPad(index) {
    if (!padBuffers[index]) return;
    resumeAudioContext();
    const pad = padGrid?.children[index]?.querySelector('.pad');
    if (pad) {
        pad.classList.add('active');
        pad.setAttribute('aria-pressed', 'true');
    }
    if (activeVoices[index]) {
        try { activeVoices[index].source.stop(); } catch (e) {}
    }
    const source = audioCtx.createBufferSource();
    source.buffer = padBuffers[index];
    source.loop = true;
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(padVolumes[index], audioCtx.currentTime);
    let rate = tempoSliderRef ? parseFloat(tempoSliderRef.value) : 1;
    if (padSyncState[index] && masterBPMRef.value > 0 && padBPMs[index] > 0) {
        rate = (masterBPMRef.value / padBPMs[index]) * rate;
    }
    source.playbackRate.value = rate;
    source.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(0);
    activeVoices[index] = { source, gain: gainNode };
}

export function stopPad(index) {
    if (activeVoices[index]) {
        try { activeVoices[index].source.stop(); } catch (e) {}
        activeVoices[index] = null;
    }
    const pad = padGrid?.children[index]?.querySelector('.pad');
    if (pad) {
        pad.classList.remove('active');
        pad.setAttribute('aria-pressed', 'false');
    }
}

export function toggleSync(index) { padSyncState[index] = !padSyncState[index]; }

export function createPadGrid() {
    if (!padGrid) return;
    padGrid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'pad-wrapper';
        const pad = document.createElement('div');
        pad.className = 'pad';
        pad.dataset.key = KEYBOARD_MAP[i];
        pad.innerHTML = `<span>${KEYBOARD_MAP[i].toUpperCase()}</span>`;
        pad.setAttribute('role', 'button');
        pad.setAttribute('aria-pressed', 'false');
        pad.setAttribute('tabindex', '0');
        const volSlider = document.createElement('input');
        volSlider.type = 'range';
        volSlider.className = 'pad-slider';
        volSlider.min = '0';
        volSlider.max = '1';
        volSlider.step = '0.01';
        volSlider.value = padVolumes[i];
        volSlider.addEventListener('input', () => {
            padVolumes[i] = parseFloat(volSlider.value);
            if (activeVoices[i]) activeVoices[i].gain.gain.setValueAtTime(padVolumes[i], audioCtx.currentTime);
        });
        wrapper.appendChild(pad);
        wrapper.appendChild(volSlider);
        padGrid.appendChild(wrapper);
    }
}

export function setupPadKeyboardHandlers() {
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1 && !e.ctrlKey && !e.altKey && padBuffers[index]) startPad(index);
    });
    document.addEventListener('keyup', (e) => {
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1) stopPad(index);
    });
}
