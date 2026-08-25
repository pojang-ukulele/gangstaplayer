import { audioCtx } from './audio';
import { bufferToWaveWorker } from './worker-client';
import { logger } from './logger';

export class HighFidelityRecorder {
    private node: AudioWorkletNode | null = null;
    private chunks: Float32Array[][] = [];
    private stopAckHandler: ((event: MessageEvent) => void) | null = null;

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
        this.node.port.postMessage({ type: 'START' });
        logger.info('[Recorder] Recording started');
    }

    async stop(): Promise<Blob> {
        if (!this.node) throw new Error('Recorder not initialized');

        // Wait for the worklet's STOPPED ack — otherwise the final render
        // quantum(s) arrive after we snapshot `chunks` and the tail is cut off.
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(); // proceed with what we have rather than hanging
            }, 500);
            const cleanup = () => {
                clearTimeout(timeout);
                if (this.stopAckHandler && this.node) {
                    this.node.port.removeEventListener('message', this.stopAckHandler);
                    this.stopAckHandler = null;
                }
            };
            this.stopAckHandler = (event: MessageEvent) => {
                if (event.data?.type === 'STOPPED') {
                    cleanup();
                    resolve();
                }
            };
            this.node!.port.addEventListener('message', this.stopAckHandler);
            this.node!.port.postMessage({ type: 'STOP' });
        });

        logger.info(`[Recorder] Recording stopped. Captured ${this.chunks.length} blocks.`);

        // Detach chunks before compiling: late DATA messages can't mutate the
        // array mid-flatten, and length math stays consistent.
        const captured = this.chunks;
        this.chunks = [];

        return await this.compileWav(captured);
    }

    private async compileWav(chunks: Float32Array[][]): Promise<Blob> {
        if (chunks.length === 0) throw new Error('No data recorded');

        const numChannels = chunks[0].length;
        const blockSize = chunks[0][0].length;
        const totalLength = chunks.length * blockSize;

        // Build interleaved Float32Array per channel directly from raw chunks
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < numChannels; channel++) {
            const channelData = new Float32Array(totalLength);
            for (let i = 0; i < chunks.length; i++) {
                channelData.set(chunks[i][channel], i * blockSize);
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
