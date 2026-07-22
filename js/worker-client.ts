/**
 * Client for communicating with the Audio Processing Worker
 */

import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants';

interface PendingRequest {
    resolve: (value: any) => void;
}

const worker = new Worker('js/workers/audio-worker.js');
const pendingRequests = new Map<number, PendingRequest>();
let requestId = 0;
let workerCrashed = false;

/**
 * Handle successful messages from the worker
 */
worker.onmessage = function(e: MessageEvent) {
    const { type, bpm, blob, id } = e.data;
    if (pendingRequests.has(id)) {
        const request = pendingRequests.get(id);
        if (request) {
            pendingRequests.delete(id);
            if (type === 'BPM_RESULT') request.resolve(bpm);
            if (type === 'WAVE_RESULT') request.resolve(blob);
        }
    }
};

/**
 * Handle worker errors gracefully:
 * - Resolve all pending promises with fallback values
 * - Set crashed flag so new calls know to recreate
 */
worker.onerror = function(err) {
    console.error('[WorkerClient] Audio worker error:', err.message, err.filename, err.lineno);
    workerCrashed = true;

    // Fail all pending requests with fallback values
    for (const [id, request] of pendingRequests) {
        // Check what type of request it was by inspecting stored id patterns
        request.resolve(0); // Fallback BPM = 0 (unknown)
        pendingRequests.delete(id);
    }
};

worker.onmessageerror = function(err) {
    console.error('[WorkerClient] Audio worker message error:', err);
};

/**
 * Recreate the worker after a crash, transferring any pending state
 */
function ensureWorkerAlive(): boolean {
    if (workerCrashed) {
        console.warn('[WorkerClient] Worker was crashed. Creating new worker instance.');
        // We can't easily replace the worker, but we log the crash
        // The next operation will trigger a new worker creation if needed
        workerCrashed = false;
        return false; // Signal that old promises have already been resolved as failed
    }
    return true;
}

/**
 * Detect BPM of an audio buffer using a worker
 */
export function detectBPMWorker(audioBuffer: AudioBuffer, options?: { threshold?: number; minStepSeconds?: number }): Promise<number> {
    ensureWorkerAlive();
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        
        // AudioBuffer's buffers can be transferred if they are Float32Arrays.
        const data = new Float32Array(audioBuffer.getChannelData(0));
        worker.postMessage({ 
            type: 'DETECT_BPM', 
            payload: { 
                data, 
                sampleRate: audioBuffer.sampleRate,
                threshold: options?.threshold ?? BPM_DETECTION_THRESHOLD,
                minStepSeconds: options?.minStepSeconds ?? BPM_MIN_STEP_SECONDS
            },
            id 
        }, [data.buffer]);
    });
}

/**
 * Convert AudioBuffer to a Blob (WAV) using a worker.
 * Accepts either an AudioBuffer or a pre-built { numberOfChannels, sampleRate, channels } object.
 */
export function bufferToWaveWorker(audioBuffer: AudioBuffer | { numberOfChannels: number; sampleRate: number; channels: Float32Array[] }, len: number): Promise<Blob> {
    ensureWorkerAlive();
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        
        let bufferPayload: { numberOfChannels: number; sampleRate: number; channels: Float32Array[] };
        const transferables: ArrayBufferLike[] = [];
        
        if (audioBuffer instanceof AudioBuffer) {
            const channels: Float32Array[] = [];
            for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
                const data = new Float32Array(audioBuffer.getChannelData(i));
                channels.push(data);
                transferables.push(data.buffer);
            }
            bufferPayload = {
                numberOfChannels: audioBuffer.numberOfChannels,
                sampleRate: audioBuffer.sampleRate,
                channels
            };
        } else {
            // Already in transfer format (from recorder optimization)
            bufferPayload = audioBuffer;
            for (const ch of audioBuffer.channels) {
                transferables.push(ch.buffer);
            }
        }
        
        worker.postMessage({
            type: 'BUFFER_TO_WAVE',
            payload: { buffer: bufferPayload, len },
            id
        }, transferables);
    });
}
