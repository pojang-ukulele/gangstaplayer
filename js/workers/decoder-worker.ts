/**
 * Dedicated Audio Decoder Worker
 * Decodes compressed audio (MP3, WAV, etc.) to raw PCM in the background.
 */

self.onmessage = async (e: MessageEvent) => {
    const { id, arrayBuffer } = e.data;
    
    try {
        // Using OfflineAudioContext in the worker (supported in modern Chrome/Electron)
        // This is much faster and cleaner than manual JS decoders.
        
        // We create a dummy OAC just to get access to decodeAudioData
        // Note: sampleRate doesn't matter much for decoding, but 44100 is safe.
        const OfflineContext = (self as any).OfflineAudioContext || (self as any).webkitOfflineAudioContext;
        
        if (!OfflineContext) {
            throw new Error("OfflineAudioContext not supported in this worker environment");
        }

        const offCtx = new OfflineContext(1, 1, 44100);
        
        // decodeAudioData is the magic here. It runs the browser's native (often multi-threaded)
        // decoding logic but inside this worker's context, so it doesn't block the main UI.
        const audioBuffer = await offCtx.decodeAudioData(arrayBuffer);
        
        const channels: Float32Array[] = [];
        const buffers: ArrayBuffer[] = [];
        
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            const chanData = audioBuffer.getChannelData(i);
            // We need to copy or transfer the data. 
            // Transferring is better for performance.
            const pcm = new Float32Array(chanData);
            channels.push(pcm);
            buffers.push(pcm.buffer);
        }

        (self as any).postMessage({
            id,
            type: 'DECODE_SUCCESS',
            payload: {
                numberOfChannels: audioBuffer.numberOfChannels,
                sampleRate: audioBuffer.sampleRate,
                length: audioBuffer.length,
                duration: audioBuffer.duration,
                channels
            }
        }, buffers);

    } catch (err: any) {
        (self as any).postMessage({
            id,
            type: 'DECODE_ERROR',
            error: err.message || "Unknown decoding error"
        });
    }
};
