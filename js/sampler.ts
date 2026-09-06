// === SAMPLER MODULE ===
import { DEFAULT_PAD_VOLUME, POOL_SIZE } from './constants';
import { state } from './state';
import { audioCtx, masterGain, resumeAudioContext, ensureAudio } from './audio';
import { engine } from './audio-engine';
import { toast } from './toast';
import { logger } from './logger';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import type { FileSystemAPI, ElectronAPI } from './types';

interface SamplerDeps {
    fsBridge: FileSystemAPI;
    bridge: ElectronAPI;
    detectBPM: (buffer: AudioBuffer) => Promise<number>;
    masterBPMRef: { value: number };
    tempoSliderRef: HTMLInputElement;
}

export const padBuffers: Record<number, AudioBuffer> = {};
export const padPaths: Record<number, string> = {};
export const activeVoices: Record<number, { source: AudioBufferSourceNode, gain: GainNode } | null> = {};
export const padVolumes: number[] = new Array(16).fill(DEFAULT_PAD_VOLUME);
export const padBPMs: Record<number, number> = {};
export const padSyncState: Record<number, boolean> = {};

// Waveform preview data: downsampled amplitude envelopes per pad (0-255 for canvas)
export const padWaveforms: Record<number, Uint8Array> = {};
export const padBeatPositions: Record<number, number[]> = {}; // beat positions in seconds
export const padLoopStart: Record<number, number> = {}; // loop start in seconds (-1 = not set)
export const padLoopEnd: Record<number, number> = {}; // loop end in seconds (-1 = not set)

const WAVEFORM_POINTS = 100; // Number of amplitude samples for preview

// === Voice Pool: reuse GainNode objects to reduce GC pressure ===
const _gainPool: GainNode[] = [];
let _poolCreated = 0;

function acquireGain(): GainNode | null {
    const pooled = _gainPool.pop();
    if (pooled) return pooled;
    if (!ensureAudio() || !audioCtx) return null;
    _poolCreated++;
    return audioCtx.createGain();
}

function releaseGain(gain: GainNode): void {
    // Disconnect the gain node from its input and output
    try { gain.disconnect(); } catch (_) { /* already disconnected */ }
    // Cancel prior automation before reset, or the next voice inherits ramps.
    try {
        if (audioCtx) gain.gain.cancelScheduledValues(audioCtx.currentTime);
    } catch (_) { /* ignore */ }
    try {
        if (audioCtx) gain.gain.setValueAtTime(1, audioCtx.currentTime);
        else gain.gain.value = 1;
    } catch (_) { gain.gain.value = 1; }
    // Return to pool (limit pool size)
    if (_gainPool.length < (POOL_SIZE || 32)) {
        _gainPool.push(gain);
    }
}

let padGrid: HTMLElement | null = null;
let fsBridgeRef: FileSystemAPI | null = null;
let bridgeRef: ElectronAPI | null = null;
let detectBPMFn: ((buffer: AudioBuffer) => Promise<number>) | null = null;
let masterBPMRef = { value: 0 };
let tempoSliderRef: HTMLInputElement | null = null;

export function initSampler(deps: SamplerDeps): void {
    fsBridgeRef = deps.fsBridge;
    bridgeRef = deps.bridge;
    detectBPMFn = deps.detectBPM;
    masterBPMRef = deps.masterBPMRef;
    tempoSliderRef = deps.tempoSliderRef;
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

/**
 * Compute evenly-spaced beat positions from BPM and duration.
 * Returns positions in seconds.
 */
function computeBeatPositions(bpm: number, duration: number): number[] {
    if (bpm <= 0 || duration <= 0) return []; // Skip, no beat data available
    const beatInterval = 60 / bpm; // seconds per beat
    const count = Math.floor(duration / beatInterval);
    const positions: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        positions[i] = i * beatInterval;
    }
    return positions;
}

/**
 * Compute a downsampled waveform preview from an AudioBuffer.
 * Returns a Uint8Array of WAVEFORM_POINTS length (0-255 amplitude).
 */
function computeWaveform(buffer: AudioBuffer): Uint8Array {
    const channel = buffer.getChannelData(0);
    const len = channel.length;
    const points = new Uint8Array(WAVEFORM_POINTS);
    const samplesPerPoint = Math.max(1, Math.floor(len / WAVEFORM_POINTS));
    
    // Find peak amplitude for normalization
    let peak = 0;
    for (let i = 0; i < len; i++) {
        const abs = Math.abs(channel[i]);
        if (abs > peak) peak = abs;
    }
    if (peak < 0.01) peak = 1; // Avoid division by zero on silent samples
    
    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        let maxVal = 0;
        const start = i * samplesPerPoint;
        const end = Math.min(start + samplesPerPoint, len);
        for (let j = start; j < end; j++) {
            const abs = Math.abs(channel[j]);
            if (abs > maxVal) maxVal = abs;
        }
        points[i] = Math.min(255, Math.round((maxVal / peak) * 255));
    }
    return points;
}

/** Draw the waveform + beat markers + loop region onto the pad's canvas */
export function renderWaveform(index: number): void {
    if (!padGrid) return;
    const wrapper = padGrid.children[index] as HTMLElement;
    if (!wrapper) return;
    const canvas = wrapper.querySelector('.pad-canvas') as HTMLCanvasElement;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Match canvas size to pad dimensions
    const pad = wrapper.querySelector('.pad') as HTMLElement;
    if (!pad) return;
    const dpr = window.devicePixelRatio || 1;
    const w = pad.clientWidth;
    const h = pad.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    
    ctx.clearRect(0, 0, w, h);
    
    const data = padWaveforms[index];
    if (!data || data.length < 2) return;
    
    const buffer = padBuffers[index];
    const duration = buffer ? buffer.duration : 1;
    const midY = h / 2;
    const stepX = w / WAVEFORM_POINTS;
    
    // === 1. Draw loop region highlight (if loop points are set) ===
    const loopStart = padLoopStart[index];
    const loopEnd = padLoopEnd[index];
    if (loopStart >= 0 && loopEnd > loopStart && duration > 0) {
        const lsX = (loopStart / duration) * w;
        const leX = (loopEnd / duration) * w;
        ctx.fillStyle = 'rgba(188, 19, 254, 0.2)'; // purple tint for loop region
        ctx.fillRect(lsX, 0, leX - lsX, h);
        // Loop boundary lines
        ctx.strokeStyle = 'rgba(188, 19, 254, 0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lsX, 0); ctx.lineTo(lsX, h);
        ctx.moveTo(leX, 0); ctx.lineTo(leX, h);
        ctx.stroke();
    }
    
    // === 2. Draw beat markers (vertical ticks) ===
    const beats = padBeatPositions[index];
    if (beats && beats.length > 1 && duration > 0) {
        ctx.strokeStyle = 'rgba(255, 204, 0, 0.25)'; // gold tick marks
        ctx.lineWidth = 1;
        for (let i = 0; i < beats.length; i++) {
            const x = (beats[i] / duration) * w;
            ctx.beginPath();
            ctx.moveTo(x, midY - 6);
            ctx.lineTo(x, midY + 6);
            ctx.stroke();
        }
    }
    
    // === 3. Draw amplitude envelope (mirrored) ===
    ctx.strokeStyle = 'rgba(57, 255, 20, 0.35)';
    ctx.lineWidth = 1.5;
    
    // Top half
    ctx.beginPath();
    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        const amp = (data[i] / 255) * (midY - 4);
        const x = i * stepX + stepX / 2;
        if (i === 0) ctx.moveTo(x, midY - amp);
        else ctx.lineTo(x, midY - amp);
    }
    ctx.stroke();
    
    // Bottom half (mirror)
    ctx.beginPath();
    for (let i = 0; i < WAVEFORM_POINTS; i++) {
        const amp = (data[i] / 255) * (midY - 4);
        const x = i * stepX + stepX / 2;
        if (i === 0) ctx.moveTo(x, midY + amp);
        else ctx.lineTo(x, midY + amp);
    }
    ctx.stroke();
    
    // === 4. BPM text overlay (top-left corner) ===
    if (padBPMs[index] > 0) {
        ctx.fillStyle = 'rgba(57, 255, 20, 0.5)';
        ctx.font = `${Math.max(8, Math.min(12, Math.round(w * 0.07)))}px VT323, monospace`;
        ctx.textBaseline = 'top';
        ctx.fillText(`${padBPMs[index]}bpm`, 3, 3);
    }
}

function updatePadVisuals(index: number): void {
    if (!padGrid) return;
    const wrapper = padGrid.children[index] as HTMLElement;
    if (wrapper) {
        renderPad(index, wrapper);
        // Defer waveform render to next frame so canvas has correct layout dimensions
        requestAnimationFrame(() => renderWaveform(index));
    }
}

function setPadLoading(index: number, loading: boolean): void {
    if (!padGrid) return;
    const pad = padGrid.children[index]?.querySelector('.pad') as HTMLElement;
    if (pad) {
        pad.classList.toggle('loading', loading);
    }
}

export async function loadSampleFile(file: File, index: number): Promise<void> {
    setPadLoading(index, true);
    try {
        logger.info(`[Sampler] Loading file to pad ${index}: ${file.name}`);
        const arrayBuffer = await file.arrayBuffer();
        
        // Validate audio file signature
        const validationError = validateAudioSignature(arrayBuffer, file.name);
        if (validationError) {
            logger.error(`[Sampler] Pad ${index} validation failed: ${validationError}`);
            toast.error("INVALID AUDIO FILE");
            return;
        }
        
        // Use native decoder directly (no worker pool — most reliable for one-shot samples)
        if (!ensureAudio() || !audioCtx) { toast.error("AUDIO NOT READY"); return; }
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        
        padBuffers[index] = audioBuffer;
        padPaths[index] = file.name;
        padWaveforms[index] = computeWaveform(audioBuffer);
        logger.info(`[Sampler] Pad ${index}: Buffer set from file (${audioBuffer.duration.toFixed(2)}s)`);
        updatePadVisuals(index);
        
        if (detectBPMFn) {
            const bpm = await detectBPMFn(audioBuffer);
            padBPMs[index] = bpm;
            padBeatPositions[index] = computeBeatPositions(bpm, audioBuffer.duration);
            logger.info(`[Sampler] Pad ${index} BPM: ${bpm}, beats: ${padBeatPositions[index].length}`);
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    } catch (e: any) { 
        logger.error(`[Sampler] Pad ${index} load failed: ${e.message || e}`);
        logger.error(`[Sampler] Pad ${index} file load FAILED:`, e);
        toast.error("SAMPLE LOAD FAILED");
    } finally {
        setPadLoading(index, false);
    }
}

export async function loadSampleFromPath(path: string, index: number): Promise<void> {
    setPadLoading(index, true);
    try {
        if (!fsBridgeRef) return;
        logger.info(`[Sampler] Loading path to pad ${index}: ${path}`);
        const rawData = await fsBridgeRef.readFile(path);
        if (!rawData) {
            logger.error(`[Sampler] Read failed for path: ${path}`);
            return;
        }
        
        const arrayBuffer = normalizeToArrayBuffer(rawData);
        
        // Validate audio file signature
        const validationError = validateAudioSignature(arrayBuffer, path.split(/[\\/]/).pop());
        if (validationError) {
            logger.error(`[Sampler] Pad ${index} path validation failed: ${validationError}`);
            return;
        }
        
        logger.info(`[Sampler] Pad ${index}: Got ${arrayBuffer.byteLength} bytes, decoding...`);
        
        // Use native decoder directly
        if (!ensureAudio() || !audioCtx) return;
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
 
        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        padWaveforms[index] = computeWaveform(audioBuffer);
        logger.info(`[Sampler] Pad ${index}: Buffer set (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`);
        updatePadVisuals(index);
        if (detectBPMFn) {
            const bpm = await detectBPMFn(audioBuffer);
            padBPMs[index] = bpm;
            padBeatPositions[index] = computeBeatPositions(bpm, audioBuffer.duration);
        }
        document.dispatchEvent(new CustomEvent('ug:dataChanged'));
    } catch (e: any) { 
        logger.error(`[Sampler] Pad ${index} path load failed: ${e.message || e}`);
        logger.error(`[Sampler] Pad ${index} path load FAILED:`, e);
    } finally {
        setPadLoading(index, false);
    }
}

export function startPad(index: number): void {
    logger.debug(`[Sampler] startPad(${index}) called. Buffer exists: ${!!padBuffers[index]}`);
    if (!padBuffers[index]) return;
    if (!ensureAudio() || !audioCtx || !masterGain) {
        logger.warn(`[Sampler] Audio not ready, cannot start pad ${index}`);
        return;
    }
    // Guard against AudioContext being in closed state (ensureAudio rebuilds)
    if (audioCtx.state === 'closed' && !ensureAudio()) {
        logger.warn(`[Sampler] AudioContext is closed, cannot start pad ${index}`);
        return;
    }
    
    resumeAudioContext();
    
    // Stop previous instance if playing
    stopPad(index);
    
    try {
        const source = audioCtx.createBufferSource();
        source.buffer = padBuffers[index];
        source.loop = true;
        
        // Apply loop points if set
        const loopStart = padLoopStart[index];
        const loopEnd = padLoopEnd[index];
        if (loopStart >= 0 && loopEnd > loopStart) {
            source.loopStart = loopStart;
            source.loopEnd = loopEnd;
        }
        
        const gainNode = acquireGain();
        if (!gainNode) { logger.warn(`[Sampler] No gain node for pad ${index}`); return; }
        const currentVol = padVolumes[index] !== undefined ? padVolumes[index] : DEFAULT_PAD_VOLUME;
        gainNode.gain.setValueAtTime(currentVol, audioCtx.currentTime);
        
        let rate = tempoSliderRef ? parseFloat(tempoSliderRef.value) : 1;
        let startOffset = 0;
        
        if (padSyncState[index] && masterBPMRef.value > 0 && padBPMs[index] > 0) {
            // Adjust playback rate to match master BPM
            rate = (masterBPMRef.value / padBPMs[index]) * rate;
            
            // Beat-quantized start: snap to nearest beat in the master timeline
            const masterBPS = masterBPMRef.value / 60; // beats per second
            const padBeatDuration = 60 / padBPMs[index]; // one beat in the pad's native time
            
            // Get current position in the master audio
            const playerAudio = engine.main.audio;
            if (playerAudio && playerAudio.currentTime > 0 && !isNaN(playerAudio.duration)) {
                const masterBeatPhase = (playerAudio.currentTime * masterBPS) % 1; // 0-1 phase within current beat
                // Start the pad at the same phase position within its beat cycle
                startOffset = masterBeatPhase * padBeatDuration;
            }
        }
        source.playbackRate.value = rate;
        
        source.connect(gainNode);
        gainNode.connect(masterGain);
        source.start(0, startOffset);
        logger.debug(`[Sampler] Pad ${index} playing! Rate: ${rate.toFixed(3)}, Offset: ${startOffset.toFixed(3)}s`);
        
        // Register the voice for cleanup
        activeVoices[index] = { source, gain: gainNode };
        
        // Cleanup after source finishes playing naturally
        source.onended = () => {
            if (activeVoices[index]?.source === source) {
                try {
                    source.disconnect();
                } catch (e) { /* already disconnected */ }
                // Return gain node to pool
                releaseGain(gainNode);
                if (activeVoices[index]?.source === source) {
                    activeVoices[index] = null;
                }
            }
        };
    } catch (e: any) {
        logger.error(`[Sampler] Pad ${index} start failed: ${e.message || e}`);
        // Ensure we don't leak activeVoices reference on failure
        if (activeVoices[index]?.gain) {
            releaseGain(activeVoices[index]!.gain);
        }
        activeVoices[index] = null;
    }
    
    updatePadVisuals(index);
}

export function stopPad(index: number): void {
    const currentVoice = activeVoices[index];
    if (currentVoice) {
        try { 
            currentVoice.source.stop(); 
        } catch (e) { /* Already stopped or audioCtx closed */ }
        try { 
            currentVoice.source.disconnect(); 
        } catch (e) { /* Already disconnected */ }
        // Return gain node to pool instead of discarding
        releaseGain(currentVoice.gain);
        activeVoices[index] = null;
    }
    updatePadVisuals(index);
}

export function toggleSync(index: number): void { 
    padSyncState[index] = !padSyncState[index]; 
    updatePadVisuals(index);
    document.dispatchEvent(new CustomEvent('ug:dataChanged'));
}

export function createPadGrid(): void {
    if (!padGrid) return;
    if (padGrid.children.length > 0) return; // Guard: prevent duplicate grid on hot reload
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
                <canvas class="pad-canvas"></canvas>
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
        recBtn.addEventListener('click', (e) => { e.stopPropagation(); }); // Prevent file dialog from opening

        pad.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.add('drag-over'); });
        pad.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); });
        pad.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); pad.classList.remove('drag-over'); 
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file) loadSampleFile(file, index);
            }
        });

        volSlider.addEventListener('input', () => {
            const v = parseFloat(volSlider.value);
            padVolumes[index] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.75;
            const currentVoice = activeVoices[index];
            if (currentVoice && audioCtx) {
                try {
                    currentVoice.gain.gain.cancelScheduledValues(audioCtx.currentTime);
                    currentVoice.gain.gain.setValueAtTime(padVolumes[index], audioCtx.currentTime);
                } catch { /* audio closed */ }
            }
        });

        // === WAVEFORM LOOP POINT EDITING ===
        const canvas = wrapper.querySelector('.pad-canvas') as HTMLCanvasElement;
        if (canvas) {
            // Shift+click toggles loop start at nearest beat
            // Ctrl+click toggles loop end at nearest beat
            canvas.addEventListener('click', (e) => {
                try {
                    const buf = padBuffers[index];
                    if (!buf) return;
                    const duration = buf.duration;
                    if (!duration) return;
                    
                    const rect = canvas.getBoundingClientRect();
                    if (rect.width <= 0) return; // Guard against zero-width canvas
                    const frac = (e.clientX - rect.left) / rect.width;
                    const clickTime = frac * duration;
                    
                    // Snap to nearest beat if available
                    const beats = padBeatPositions[index];
                    let snappedTime = clickTime;
                    if (beats && beats.length > 0) {
                        let nearest = beats[0];
                        let minDist = Math.abs(clickTime - nearest);
                        for (let i = 1; i < beats.length; i++) {
                            const dist = Math.abs(clickTime - beats[i]);
                            if (dist < minDist) { minDist = dist; nearest = beats[i]; }
                        }
                        snappedTime = nearest;
                    }
                    
                    if (e.shiftKey) {
                        // Set loop start, snap to nearest beat
                        padLoopStart[index] = snappedTime;
                        // If loop end isn't set, default to end of sample
                        if (padLoopEnd[index] < 0 || padLoopEnd[index] <= snappedTime) {
                            padLoopEnd[index] = duration;
                        }
                        toast.success(`LOOP START: ${snappedTime.toFixed(2)}s`);
                    } else if (e.ctrlKey || e.metaKey) {
                        // Set loop end, snap to nearest beat
                        padLoopEnd[index] = snappedTime;
                        if (padLoopStart[index] < 0 || padLoopStart[index] >= snappedTime) {
                            padLoopStart[index] = 0;
                        }
                        toast.success(`LOOP END: ${snappedTime.toFixed(2)}s`);
                    } else if (e.altKey) {
                        // Alt+click = clear loop points
                        padLoopStart[index] = -1;
                        padLoopEnd[index] = -1;
                        toast.info("LOOP CLEARED");
                    } else {
                        // Regular click: only create a 1-bar loop when none exists.
                        // Previously every click silently overwrote a hand-tuned loop.
                        if (padLoopStart[index] >= 0 && padLoopEnd[index] > padLoopStart[index]) {
                            toast.info("LOOP EXISTS — ALT+CLICK TO CLEAR");
                        } else if (padBPMs[index] > 0) {
                            const beatSec = 60 / padBPMs[index];
                            const barSec = beatSec * 4; // 4 beats = 1 bar
                            // Snap start down to the bar boundary
                            const startBeat = Math.floor(snappedTime / barSec) * barSec;
                            padLoopStart[index] = startBeat;
                            padLoopEnd[index] = startBeat + barSec;
                            toast.success(`1-BAR LOOP: ${startBeat.toFixed(2)}s - ${(startBeat + barSec).toFixed(2)}s`);
                        } else {
                            // No BPM: set region from 0 to clickTime
                            padLoopStart[index] = 0;
                            padLoopEnd[index] = snappedTime;
                            toast.success(`LOOP: 0s - ${snappedTime.toFixed(2)}s`);
                        }
                    }
                    renderWaveform(index);
                } catch (err) {
                    logger.error(`[Sampler] Canvas click handler error for pad ${index}:`, err);
                }
            });
        }
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
    let keyLearnTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelKeyLearn = () => {
        if (keyLearnTimer) { clearTimeout(keyLearnTimer); keyLearnTimer = null; }
    };
    state.subscribe('isLearningKey', (learning) => {
        cancelKeyLearn();
        if (!learning) return;
        keyLearnTimer = setTimeout(() => {
            if (!state.isLearningKey) return;
            state.update({ isLearningKey: false, keyLearnTargetPad: null });
            toast.info("KEY BIND TIMED OUT");
        }, 10000);
    });
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        
        // Handle Key Learn Mode (steal-free: swap so two pads never share a key)
        if (state.isLearningKey && state.keyLearnTargetPad !== null) {
            e.preventDefault();
            const padIndex = state.keyLearnTargetPad;
            const key = e.key.toLowerCase();
            // Ignore pure modifiers — binding "shift" strands the pad.
            if (['shift', 'control', 'alt', 'meta'].includes(key)) return;
            const newMap = [...state.padKeyMap];
            const other = newMap.indexOf(key);
            if (other !== -1 && other !== padIndex) newMap[other] = newMap[padIndex];
            newMap[padIndex] = key;
            cancelKeyLearn();
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
                if (!ensureAudio() || !audioCtx) { toast.error("AUDIO NOT READY"); return; }
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
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.saveKit();
        if (!path) return;

        const kit = {
            name: "My Gangsta Kit",
            pads: [] as Array<{ index: number, path: string, vol: number }>
        };

        let skippedRecordings = 0;
        for (let i = 0; i < 16; i++) {
            if (!padPaths[i]) continue;
            // Mic recordings have no backing file path ("REC_<ts>") — they
            // cannot be reloaded from a kit, so saving them writes broken refs.
            if (padPaths[i].startsWith('REC_')) {
                skippedRecordings++;
                continue;
            }
            kit.pads.push({
                index: i,
                path: padPaths[i],
                vol: padVolumes[i] ?? DEFAULT_PAD_VOLUME
            });
        }

        await fsBridgeRef.saveFile(path, new TextEncoder().encode(JSON.stringify(kit, null, 2)));
        if (skippedRecordings > 0) {
            toast.info(`${skippedRecordings} RECORDED PAD(S) NOT SAVED (NO SOURCE FILE)`);
        }
        toast.success("KIT SAVED");
    } catch (err) {
        logger.error("Save Kit Failed", err);
        toast.error("FAILED TO SAVE KIT");
    }
}

async function loadKitDialog(): Promise<void> {
    if (!bridgeRef || !fsBridgeRef) return;
    try {
        const path = await bridgeRef.loadKit();
        if (!path) return;
        
        const data = await fsBridgeRef.readFile(path);
        const jsonStr = new TextDecoder().decode(data);
        const kit = JSON.parse(jsonStr);
        
        if (kit.pads && Array.isArray(kit.pads)) {
            kit.pads.forEach((p: { index: number, path: string, vol?: number }) => {
                // Validate pad index from untrusted JSON — out-of-range values
                // would write stray properties past the pad arrays.
                const idx = Number(p.index);
                if (!p.path || !Number.isInteger(idx) || idx < 0 || idx > 15) return;
                loadSampleFromPath(p.path, idx).then(() => {
                    if (p.vol !== undefined) {
                        padVolumes[idx] = p.vol;
                        const slider = padGrid?.children[idx]?.querySelector('.pad-slider') as HTMLInputElement;
                        if (slider) slider.value = p.vol.toString();
                    }
                });
            });
        }
    } catch (err) {
        logger.error("Load Kit Failed", err);
        toast.error("FAILED TO LOAD KIT");
    }
}

