import { DEFAULT_PAD_VOLUME } from './constants';
import { state } from './state';
import { audioCtx, masterGain, resumeAudioContext, createAudioBuffer } from './audio';
import { decoderPool } from './decoder-pool';
import { toast } from './toast';
import { logger } from './logger';

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
    
    // Subscribe to mapping changes
    state.subscribe('padKeyMap', () => {
        if (padGrid) {
            for (let i = 0; i < 16; i++) updatePadVisuals(i);
        }
    });

    createPadGrid();
}

export function getPadGrid(): HTMLElement | null { return padGrid; }

function updatePadVisuals(index: number): void {
    if (!padGrid) return;
    const wrapper = padGrid.children[index] as HTMLElement;
    if (wrapper) renderPad(index, wrapper);
}

export async function loadSampleFile(file: File, index: number): Promise<void> {
    try {
        logger.info(`[Sampler] Loading file to pad ${index}: ${file.name}`);
        const arrayBuffer = await file.arrayBuffer();
        
        // Background decoding like a pro
        const decodeResult = await decoderPool.decode(arrayBuffer);
        const audioBuffer = createAudioBuffer(decodeResult);
        
        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        updatePadVisuals(index);
        
        if (detectBPMFn) {
            const bpm = await detectBPMFn(audioBuffer);
            padBPMs[index] = bpm;
            logger.info(`[Sampler] Pad ${index} BPM: ${bpm}`);
        }
    } catch (e) { 
        logger.error(`[Sampler] Pad ${index} load failed:`, e);
        toast.error("SAMPLE LOAD FAILED");
    }
}

export async function loadSampleFromPath(path: string, index: number): Promise<void> {
    try {
        logger.info(`[Sampler] Loading path to pad ${index}: ${path}`);
        const rawData = await fsBridgeRef.readFile(path);
        if (!rawData) {
            logger.error(`[Sampler] Read failed for path: ${path}`);
            return;
        }
        const arrayBuffer = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
        
        // Background decoding like a pro
        const decodeResult = await decoderPool.decode(arrayBuffer);
        const audioBuffer = createAudioBuffer(decodeResult);

        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        updatePadVisuals(index);
        if (detectBPMFn) {
            const bpm = await detectBPMFn(audioBuffer);
            padBPMs[index] = bpm;
        }
    } catch (e) { 
        logger.error(`[Sampler] Pad ${index} path load failed:`, e);
    }
}

export function startPad(index: number): void {
    if (!padBuffers[index]) return;
    resumeAudioContext();
    
    // Stop previous instance if playing
    stopPad(index);

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
    updatePadVisuals(index);
}

export function stopPad(index: number): void {
    const currentVoice = activeVoices[index];
    if (currentVoice) {
        try { 
            currentVoice.source.stop(); 
            currentVoice.source.disconnect();
            currentVoice.gain.disconnect();
        } catch (e) {}
        activeVoices[index] = null;
    }
    updatePadVisuals(index);
}

export function toggleSync(index: number): void { 
    padSyncState[index] = !padSyncState[index]; 
    updatePadVisuals(index);
}

export function createPadGrid(): void {
    if (!padGrid) return;
    padGrid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        const wrapper = renderPad(i);
        padGrid.appendChild(wrapper);
    }
}

function renderPad(index: number, existing?: HTMLElement): HTMLElement {
    const wrapper = (existing || document.createElement('div')) as HTMLElement;
    if (!existing) {
        wrapper.className = 'pad-wrapper';
        wrapper.style.position = 'relative';
        const currentKey = state.padKeyMap[index] || "?";
        wrapper.innerHTML = `
            <div class="pad" data-key="${currentKey}" role="button" aria-pressed="false" tabindex="0">
                <span>${currentKey.toUpperCase()}</span>
                <div class="rec-btn" title="Hold to Record"></div>
            </div>
            <input type="range" class="pad-slider" min="0" max="1" step="0.01">
        `;

        const pad = wrapper.querySelector('.pad') as HTMLElement;
        const recBtn = wrapper.querySelector('.rec-btn') as HTMLElement;
        const volSlider = wrapper.querySelector('.pad-slider') as HTMLInputElement;

        recBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); startRecording(index); });
        recBtn.addEventListener('mouseup', (e) => { e.stopPropagation(); stopRecording(index); });
        recBtn.addEventListener('mouseleave', (e) => { e.stopPropagation(); stopRecording(index); });

        pad.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.add('drag-over'); });
        pad.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); });
        pad.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); 
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file) loadSampleFile(file, index);
            }
        });

        volSlider.addEventListener('input', () => {
            padVolumes[index] = parseFloat(volSlider.value);
            const currentVoice = activeVoices[index];
            if (currentVoice) currentVoice.gain.gain.setValueAtTime(padVolumes[index], audioCtx.currentTime);
        });
    }

    const pad = wrapper.querySelector('.pad') as HTMLElement;
    const volSlider = wrapper.querySelector('.pad-slider') as HTMLInputElement;

    // UPDATE VISUALS
    pad.classList.toggle('loaded', !!padBuffers[index]);
    pad.classList.toggle('active', !!activeVoices[index]);
    pad.setAttribute('aria-pressed', activeVoices[index] ? 'true' : 'false');

    let span = pad.querySelector('span');
    if (span) {
        if (padBuffers[index]) {
            const fullName = padPaths[index];
            const fileName = fullName.split(/[\\/]/).pop()?.split('.')[0] || "Sample";
            const shortName = fileName.length > 10 ? fileName.substring(0, 10) + '…' : fileName;
            span.innerText = shortName.toUpperCase();
        } else {
            const currentKey = state.padKeyMap[index] || "?";
            span.innerText = currentKey.toUpperCase();
        }
    }

    volSlider.value = padVolumes[index].toString();

    return wrapper;
}

export function setupPadKeyboardHandlers(): void {
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        
        // Handle Key Learn Mode
        if (state.isLearningKey && state.keyLearnTargetPad !== null) {
            e.preventDefault();
            const padIndex = state.keyLearnTargetPad;
            const newMap = [...state.padKeyMap];
            newMap[padIndex] = e.key.toLowerCase();
            state.update({ padKeyMap: newMap, isLearningKey: false, keyLearnTargetPad: null });
            toast.success(`PAD ${padIndex + 1} BOUND TO KEY "${e.key.toUpperCase()}"`);
            return;
        }

        const index = state.padKeyMap.indexOf(e.key.toLowerCase());
        if (index !== -1) {
            if (e.ctrlKey) {
                startRecording(index);
            } else if (!e.altKey && padBuffers[index]) {
                startPad(index);
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        const index = state.padKeyMap.indexOf(e.key.toLowerCase());
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
    
    let stream: MediaStream | null = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' }); 
            const arrayBuffer = await blob.arrayBuffer();
             
             try {
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                padBuffers[index] = decodedBuffer;
                padPaths[index] = `REC_${Date.now()}`;
                updatePadVisuals(index);
                logger.debug(`[Sampler] Recording on pad ${index} successful`);
             } catch (e) {
                logger.error(`[Sampler] Recording decode failed on pad ${index}`, e);
                toast.error("RECORDING DECODE FAILED");
             } finally {
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
             }

            delete activeRecorders[index];
            updateRecVisuals(index, false);
        };

        mediaRecorder.start();
        activeRecorders[index] = mediaRecorder;
        updateRecVisuals(index, true);

    } catch (e) {
        logger.error("[Sampler] Recording start failed", e);
        toast.error("COULD NOT START RECORDING");
        if (stream) stream.getTracks().forEach(t => t.stop());
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
