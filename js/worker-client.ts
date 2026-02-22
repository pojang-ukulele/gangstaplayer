/**
 * Client for communicating with the Audio Processing Worker
 */

interface PendingRequest {
    resolve: (value: any) => void;
}

const worker = new Worker('js/workers/audio-worker.js');
const pendingRequests = new Map<number, PendingRequest>();
let requestId = 0;

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
 * Detect BPM of an audio buffer using a worker
 */
export function detectBPMWorker(audioBuffer: AudioBuffer): Promise<number> {
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        
        // AudioBuffer's buffers can be transferred if they are Float32Arrays.
        const data = new Float32Array(audioBuffer.getChannelData(0));
        worker.postMessage({ 
            type: 'DETECT_BPM', 
            payload: { data, sampleRate: audioBuffer.sampleRate },
            id 
        }, [data.buffer]);
    });
}

/**
 * Convert AudioBuffer to a Blob (WAV) using a worker
 */
export function bufferToWaveWorker(audioBuffer: AudioBuffer, len: number): Promise<Blob> {
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        const channels: Float32Array[] = [];
        const buffers: ArrayBufferLike[] = [];
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            const data = new Float32Array(audioBuffer.getChannelData(i));
            channels.push(data);
            buffers.push(data.buffer);
        }
        
        worker.postMessage({
            type: 'BUFFER_TO_WAVE',
            payload: { 
                buffer: {
                    numberOfChannels: audioBuffer.numberOfChannels,
                    sampleRate: audioBuffer.sampleRate,
                    channels // Send the arrays directly
                },
                len
            },
            id
        }, buffers);
    });
}
