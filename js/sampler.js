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

function updatePadVisuals(index, pathOrFile) {
    const padElement = padGrid?.children[index]?.querySelector('.pad');
    if (padElement) {
        padElement.classList.add('loaded');
        const fullName = typeof pathOrFile === 'string' ? pathOrFile : (pathOrFile.name || "Sample");
        // Extract filename and truncate for premium fit
        const fileName = fullName.split(/[\\/]/).pop().split('.')[0];
        const shortName = fileName.length > 10 ? fileName.substring(0, 10) + '…' : fileName;
        padElement.innerHTML = `<span>${shortName.toUpperCase()}</span>`;
    }
}

export async function loadSampleFile(file, index) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        updatePadVisuals(index, file.name);
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
        updatePadVisuals(index, path);
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
    const currentVol = padVolumes[index] !== undefined ? padVolumes[index] : DEFAULT_PAD_VOLUME;
    gainNode.gain.setValueAtTime(currentVol, audioCtx.currentTime);
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
        wrapper.style.position = 'relative'; // Ensure positioning context

        const pad = document.createElement('div');
        pad.className = 'pad';
        pad.dataset.key = KEYBOARD_MAP[i];
        pad.innerHTML = `<span>${KEYBOARD_MAP[i].toUpperCase()}</span>`;
        pad.setAttribute('role', 'button');
        pad.setAttribute('aria-pressed', 'false');
        pad.setAttribute('tabindex', '0');

        // REC BUTTON
        const recBtn = document.createElement('div');
        recBtn.className = 'rec-btn';
        recBtn.title = 'Hold to Record';
        
        // Mouse/Touch Handlers for Rec Button
        recBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // Don't trigger pad play
            startRecording(i);
        });
        recBtn.addEventListener('mouseup', (e) => {
            e.stopPropagation();
            stopRecording(i);
        });
        recBtn.addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            stopRecording(i);
        });

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
        
        wrapper.appendChild(recBtn); // Add Rec Button
        wrapper.appendChild(pad);
        wrapper.appendChild(volSlider);
        padGrid.appendChild(wrapper);
    }
}

export function setupPadKeyboardHandlers() {
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (e.ctrlKey) {
                // REC SHORTCUT
                startRecording(index);
            } else if (!e.altKey && padBuffers[index]) {
                startPad(index);
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            // Check if we were recording this pad
            if (activeRecorders[index]) stopRecording(index);
            else stopPad(index);
        }
    });
    
    // Wire up Kit Buttons
    const btnSaveKit = document.getElementById('btnSaveKit');
    const btnLoadKit = document.getElementById('btnLoadKit');
    if (btnSaveKit) btnSaveKit.addEventListener('click', saveKit);
    if (btnLoadKit) btnLoadKit.addEventListener('click', loadKitDialog);
}

// === RECORDING LOGIC ===
let activeRecorders = {}; 

async function startRecording(index) {
    if (activeRecorders[index]) return; // Already recording via another method
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        const chunks = [];

        mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' }); // Chrome/Electron records to WebM
            const arrayBuffer = await blob.arrayBuffer();
             
             // Decode and save to buffer
             audioCtx.decodeAudioData(arrayBuffer).then(decodedBuffer => {
                 padBuffers[index] = decodedBuffer;
                 padPaths[index] = `Recorded Sample ${new Date().toLocaleTimeString()}`; // Dummy name
                 updatePadVisuals(index, { name: "RECORDING" }); 
                 
                 // Stop all tracks to release mic
                 stream.getTracks().forEach(track => track.stop());
             }).catch(e => console.error("Decode Rec Error", e));

            delete activeRecorders[index];
            updateRecVisuals(index, false);
        };

        mediaRecorder.start();
        activeRecorders[index] = mediaRecorder;
        updateRecVisuals(index, true);

    } catch (e) {
        console.error("Recording failed", e);
        alert("Could not start recording: " + e.message);
    }
}

function stopRecording(index) {
    if (activeRecorders[index] && activeRecorders[index].state !== 'inactive') {
        activeRecorders[index].stop();
    }
}

function updateRecVisuals(index, isRecording) {
    const padWrapper = padGrid?.children[index];
    const recBtn = padWrapper?.querySelector('.rec-btn');
    if (recBtn) {
        if (isRecording) recBtn.classList.add('recording');
        else recBtn.classList.remove('recording');
    }
}


// === KIT PERSISTENCE ===
async function saveKit() {
    try {
        const path = await bridgeRef.saveKit();
        if (!path) return;

        const kit = {
            name: "My Gangsta Kit",
            pads: []
        };

        for (let i = 0; i < 16; i++) {
            if (padPaths[i]) {
                kit.pads.push({
                    index: i,
                    path: padPaths[i],
                    vol: padVolumes[i] || 1
                });
            }
        }
        
        await fsBridgeRef.saveFile(path, JSON.stringify(kit, null, 2));
        alert("Kit Saved!");
    } catch (err) {
        console.error("Save Kit Failed", err);
        alert("Failed to save kit: " + err.message);
    }
}

async function loadKitDialog() {
    try {
        const path = await bridgeRef.loadKit();
        if (!path) return;
        
        const data = await fsBridgeRef.readFile(path);
        // data is buffer (Uint8Array), decode to string
        const jsonStr = new TextDecoder().decode(data);
        const kit = JSON.parse(jsonStr);
        
        if (kit.pads && Array.isArray(kit.pads)) {
             // Clear current? Maybe optional.
             kit.pads.forEach(p => {
                 if (p.path) {
                     loadSampleFromPath(p.path, p.index).then(() => {
                         if (p.vol !== undefined) {
                             padVolumes[p.index] = p.vol;
                             // Update slider UI if exists
                             // This is hard blindly without ref to slider elements.
                             // But createPadGrid regenerates them using padVolumes, so we could re-render grid?
                             // Or better: update active voice if playing.
                             // Ideally we update the specific slider input.
                             const slider = padGrid?.children[p.index]?.querySelector('.pad-slider');
                             if (slider) slider.value = p.vol;
                         }
                     });
                 }
             });
        }
    } catch (err) {
        console.error("Load Kit Failed", err);
        alert("Failed to load kit: " + err.message);
    }
}
