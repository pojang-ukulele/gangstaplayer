/**
 * Client for communicating with the Audio Processing Worker
 */

const worker = new Worker('js/workers/audio-worker.js');
const pendingRequests = new Map();
let requestId = 0;

worker.onmessage = function(e) {
    const { type, bpm, blob, id } = e.data;
    if (pendingRequests.has(id)) {
        const { resolve } = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (type === 'BPM_RESULT') resolve(bpm);
        if (type === 'WAVE_RESULT') resolve(blob);
    }
};

export function detectBPMWorker(audioBuffer) {
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        // Create a copy if it's already detached or if we want to preserve original.
        // Actually, AudioBuffer's buffers can be transferred if they are Float32Arrays.
        const data = new Float32Array(audioBuffer.getChannelData(0));
        worker.postMessage({ 
            type: 'DETECT_BPM', 
            payload: { data, sampleRate: audioBuffer.sampleRate },
            id 
        }, [data.buffer]);
    });
}

export function bufferToWaveWorker(audioBuffer, len) {
    const id = requestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, { resolve });
        const channels = [];
        const buffers = [];
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
