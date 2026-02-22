// === SAMPLER MODULE ===
import { KEYBOARD_MAP, DEFAULT_PAD_VOLUME } from './constants';
import { audioCtx, masterGain, resumeAudioContext } from './audio';
import { toast } from './toast';

interface SamplerDeps {
    fsBridge: any;
    bridge: any;
    detectBPM: (buffer: AudioBuffer) => Promise<number>;
    masterBPMRef: { value: number };
    tempoSlider: HTMLInputElement;
}

export const padBuffers: Record<number, AudioBuffer> = {};
export const padPaths: Record<number, string> = {};
export const activeVoices: Record<number, { source: AudioBufferSourceNode, gain: GainNode } | null> = {};
export const padVolumes: number[] = new Array(16).fill(DEFAULT_PAD_VOLUME);
export const padBPMs: Record<number, number> = {};
export const padSyncState: Record<number, boolean> = {};

let padGrid: HTMLElement | null = null;
let fsBridgeRef: any = null;
let bridgeRef: any = null;
let detectBPMFn: ((buffer: AudioBuffer) => Promise<number>) | null = null;
let masterBPMRef = { value: 0 };
let tempoSliderRef: HTMLInputElement | null = null;

export function initSampler(deps: SamplerDeps): void {
    fsBridgeRef = deps.fsBridge;
    bridgeRef = deps.bridge;
    detectBPMFn = deps.detectBPM;
    masterBPMRef = deps.masterBPMRef;
    tempoSliderRef = deps.tempoSlider;
    padGrid = document.getElementById('padGrid');
}

export function getPadGrid(): HTMLElement | null { return padGrid; }

function updatePadVisuals(index: number, pathOrFile: string | { name: string }): void {
    const padElement = padGrid?.children[index]?.querySelector('.pad');
    if (padElement) {
        padElement.classList.add('loaded');
        const fullName = typeof pathOrFile === 'string' ? pathOrFile : (pathOrFile.name || "Sample");
        // Extract filename and truncate for premium fit
        const fileName = fullName.split(/[\\/]/).pop()?.split('.')[0] || "Sample";
        const shortName = fileName.length > 10 ? fileName.substring(0, 10) + '…' : fileName;
        
        let span = padElement.querySelector('span');
        if (!span) {
            span = document.createElement('span');
            padElement.appendChild(span);
        }
        span.innerText = shortName.toUpperCase();
    }
}

export async function loadSampleFile(file: File, index: number): Promise<void> {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        updatePadVisuals(index, file.name);
        if (detectBPMFn) padBPMs[index] = await detectBPMFn(audioBuffer);
    } catch (e) { console.error("Sample load failed:", e); }
}

export async function loadSampleFromPath(path: string, index: number): Promise<void> {
    try {
        const rawData = await fsBridgeRef.readFile(path);
        const arrayBuffer = rawData.buffer || rawData;
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        updatePadVisuals(index, path);
        if (detectBPMFn) padBPMs[index] = await detectBPMFn(audioBuffer);
    } catch (e) { console.error("Sample load from path failed:", e); }
}

export function startPad(index: number): void {
    if (!padBuffers[index]) return;
    resumeAudioContext();
    const pad = padGrid?.children[index]?.querySelector('.pad');
    if (pad) {
        pad.classList.add('active');
        pad.setAttribute('aria-pressed', 'true');
    }
    const currentVoice = activeVoices[index];
    if (currentVoice) {
        try { currentVoice.source.stop(); } catch (e) {}
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

export function stopPad(index: number): void {
    const currentVoice = activeVoices[index];
    if (currentVoice) {
        try { currentVoice.source.stop(); } catch (e) {}
        activeVoices[index] = null;
    }
    const pad = padGrid?.children[index]?.querySelector('.pad');
    if (pad) {
        pad.classList.remove('active');
        pad.setAttribute('aria-pressed', 'false');
    }
}

export function toggleSync(index: number): void { padSyncState[index] = !padSyncState[index]; }

export function createPadGrid(): void {
    if (!padGrid) return;
    padGrid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'pad-wrapper';
        wrapper.style.position = 'relative';

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
        
        recBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
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

        // DRAG & DROP
        pad.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pad.classList.add('drag-over');
        });

        pad.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pad.classList.remove('drag-over');
        });

        pad.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pad.classList.remove('drag-over');
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file) loadSampleFile(file, i);
            }
        });

        const volSlider = document.createElement('input');
        volSlider.type = 'range';
        volSlider.className = 'pad-slider';
        volSlider.min = '0';
        volSlider.max = '1';
        volSlider.step = '0.01';
        volSlider.value = padVolumes[i].toString();
        volSlider.addEventListener('input', () => {
            padVolumes[i] = parseFloat(volSlider.value);
            const currentVoice = activeVoices[i];
            if (currentVoice) currentVoice.gain.gain.setValueAtTime(padVolumes[i], audioCtx.currentTime);
        });
        
        pad.appendChild(recBtn);
        wrapper.appendChild(pad);
        wrapper.appendChild(volSlider);
        padGrid.appendChild(wrapper);
    }
}

export function setupPadKeyboardHandlers(): void {
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (e.ctrlKey) {
                startRecording(index);
            } else if (!e.altKey && padBuffers[index]) {
                startPad(index);
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        const index = KEYBOARD_MAP.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (activeRecorders[index]) stopRecording(index);
            else stopPad(index);
        }
    });
    
    const btnSaveKit = document.getElementById('btnSaveKit');
    const btnLoadKit = document.getElementById('btnLoadKit');
    if (btnSaveKit) btnSaveKit.addEventListener('click', saveKit);
    if (btnLoadKit) btnLoadKit.addEventListener('click', loadKitDialog);
}

// === RECORDING LOGIC ===
let activeRecorders: Record<number, MediaRecorder> = {}; 

async function startRecording(index: number): Promise<void> {
    if (activeRecorders[index]) return;
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' }); 
            const arrayBuffer = await blob.arrayBuffer();
             
             audioCtx.decodeAudioData(arrayBuffer).then(decodedBuffer => {
                 padBuffers[index] = decodedBuffer;
                 padPaths[index] = `Recorded Sample ${new Date().toLocaleTimeString()}`;
                 updatePadVisuals(index, { name: "RECORDING" }); 
                 
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
        toast.error("COULD NOT START RECORDING");
    }
}

function stopRecording(index: number): void {
    const recorder = activeRecorders[index];
    if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
    }
}

function updateRecVisuals(index: number, isRecording: boolean): void {
    const padWrapper = padGrid?.children[index];
    const recBtn = padWrapper?.querySelector('.rec-btn');
    if (recBtn) {
        if (isRecording) recBtn.classList.add('recording');
        else recBtn.classList.remove('recording');
    }
}

// === KIT PERSISTENCE ===
async function saveKit(): Promise<void> {
    try {
        const path = await bridgeRef.saveKit();
        if (!path) return;

        const kit = {
            name: "My Gangsta Kit",
            pads: [] as Array<{ index: number, path: string, vol: number }>
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
        toast.success("KIT SAVED");
    } catch (err) {
        console.error("Save Kit Failed", err);
        toast.error("FAILED TO SAVE KIT");
    }
}

async function loadKitDialog(): Promise<void> {
    try {
        const path = await bridgeRef.loadKit();
        if (!path) return;
        
        const data = await fsBridgeRef.readFile(path);
        const jsonStr = new TextDecoder().decode(data);
        const kit = JSON.parse(jsonStr);
        
        if (kit.pads && Array.isArray(kit.pads)) {
             kit.pads.forEach((p: { index: number, path: string, vol?: number }) => {
                 if (p.path) {
                     loadSampleFromPath(p.path, p.index).then(() => {
                         if (p.vol !== undefined) {
                             padVolumes[p.index] = p.vol;
                             const slider = padGrid?.children[p.index]?.querySelector('.pad-slider') as HTMLInputElement;
                             if (slider) slider.value = p.vol.toString();
                         }
                     });
                 }
             });
        }
    } catch (err) {
        console.error("Load Kit Failed", err);
        toast.error("FAILED TO LOAD KIT");
    }
}
