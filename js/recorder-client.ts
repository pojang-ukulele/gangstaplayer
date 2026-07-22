import { audioCtx } from './audio';
import { bufferToWaveWorker } from './worker-client';
import { logger } from './logger';

export class HighFidelityRecorder {
    private node: AudioWorkletNode | null = null;
    private chunks: Float32Array[][] = [];
    private isRecording = false;

    constructor(private sourceNode: AudioNode) {}

    async init(): Promise<void> {
        try {
            this.node = new AudioWorkletNode(audioCtx, 'recorder-processor');
            this.node.port.onmessage = (event) => {
                if (event.data.type === 'DATA') {
                    this.chunks.push(event.data.payload);
                }
            };
            this.sourceNode.connect(this.node);
            logger.info('[Recorder] High-Fidelity Recorder initialized');
        } catch (e) {
            logger.error('[Recorder] Initialization failed', e);
            throw e;
        }
    }

    start(): void {
        if (!this.node) return;
        this.chunks = [];
        this.isRecording = true;
        this.node.port.postMessage({ type: 'START' });
        logger.info('[Recorder] Recording started');
    }

    async stop(): Promise<Blob> {
        if (!this.node) throw new Error('Recorder not initialized');
        this.node.port.postMessage({ type: 'STOP' });
        this.isRecording = false;
        logger.info(`[Recorder] Recording stopped. Captured ${this.chunks.length} blocks.`);

        // Flatten the chunks into a single AudioBuffer
        const blob = await this.compileWav();
        return blob;
    }

    private async compileWav(): Promise<Blob> {
        if (this.chunks.length === 0) throw new Error('No data recorded');

        const numChannels = this.chunks[0].length;
        const blockSize = this.chunks[0][0].length;
        const totalLength = this.chunks.length * blockSize;

        // Build interleaved Float32Array per channel directly from raw chunks
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < numChannels; channel++) {
            const channelData = new Float32Array(totalLength);
            for (let i = 0; i < this.chunks.length; i++) {
                channelData.set(this.chunks[i][channel], i * blockSize);
            }
            channels.push(channelData);
        }

        // Build a minimal AudioBuffer-like object for the worker (avoids AudioBuffer + round-trip)
        const bufferLike = {
            numberOfChannels: numChannels,
            sampleRate: audioCtx.sampleRate,
            channels
        };

        // Send directly to worker — skip AudioBuffer creation on main thread
        return await bufferToWaveWorker(bufferLike, totalLength);
    }

    dispose(): void {
        if (this.node) {
            this.node.disconnect();
            this.node = null;
        }
        this.chunks = [];
    }
}
