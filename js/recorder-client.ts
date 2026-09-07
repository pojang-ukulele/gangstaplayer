import { audioCtx, ensureAudio } from './audio';
import { bufferToWaveWorker } from './worker-client';
import { logger } from './logger';

export class HighFidelityRecorder {
    private node: AudioWorkletNode | null = null;
    private chunks: Float32Array[][] = [];
    private stopAckHandler: ((event: MessageEvent) => void) | null = null;
    private accepting = false;
    private connected = false;

    constructor(private sourceNode: AudioNode) {}

    async init(): Promise<void> {
        if (!ensureAudio() || !audioCtx) throw new Error('Audio not ready');
        // Second init previously orphaned the old worklet (double capture + CPU).
        this.dispose();
        try {
            this.node = new AudioWorkletNode(audioCtx, 'recorder-processor');
            this.node.port.onmessage = (event) => {
                if (event.data.type === 'DATA') {
                    if (!this.accepting) return; // post-STOP stragglers → next take
                    const payload = event.data.payload as Float32Array[];
                    if (Array.isArray(payload) && payload.length > 0) this.chunks.push(payload);
                }
            };
            this.sourceNode.connect(this.node);
            this.connected = true;
            logger.info('[Recorder] High-Fidelity Recorder initialized');
        } catch (e) {
            logger.error('[Recorder] Initialization failed', e);
            throw e;
        }
    }

    start(): void {
        if (!this.node) return;
        // Reconnect if a previous stop disconnected the tap to save CPU.
        if (!this.connected) {
            try { this.sourceNode.connect(this.node); this.connected = true; } catch { /* ignore */ }
        }
        this.chunks = [];
        this.accepting = true;
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
            }, 2000);
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

        // Freeze intake BEFORE snapshot — DATA racing the STOPPED ack previously
        // landed in the next take's chunks.
        this.accepting = false;
        const captured = this.chunks;
        this.chunks = [];

        // Disconnect the tap while idle — a permanently connected worklet
        // processes every quantum forever after the first take.
        try {
            if (this.node && this.connected) {
                this.sourceNode.disconnect(this.node);
                this.connected = false;
            }
        } catch { /* already disconnected */ }

        return await this.compileWav(captured);
    }

    private async compileWav(chunks: Float32Array[][]): Promise<Blob> {
        if (chunks.length === 0) throw new Error('No data recorded');
        // Cap takes (~30min stereo @48kHz ≈ 660MB PCM) — longer takes OOMed before WAV compile.
        const MAX_BLOCKS = 30 * 60 * (48000 / 128) * 1.2;
        if (chunks.length > MAX_BLOCKS) throw new Error('Recording too long (30min cap)');

        const numChannels = chunks[0].length;
        if (!numChannels) throw new Error('No data recorded');
        // Sum actual lengths — last quantum / channel drift breaks fixed math.
        let totalLength = 0;
        for (const block of chunks) {
            if (!block || block.length !== numChannels) continue;
            totalLength += block[0]?.length ?? 0;
        }
        if (totalLength <= 0) throw new Error('No data recorded');

        const channels: Float32Array[] = [];
        for (let channel = 0; channel < numChannels; channel++) {
            const channelData = new Float32Array(totalLength);
            let off = 0;
            for (const block of chunks) {
                const src = block?.[channel];
                if (!src || src.length === 0) continue;
                if (off >= totalLength) break;
                const room = totalLength - off;
                const take = src.length > room ? src.subarray(0, room) : src;
                channelData.set(take, off);
                off += take.length;
            }
            // Fresh copy: transferring a subarray view would transfer (and
            // neuter) the entire backing store, not just the view window.
            channels.push(channelData.slice(0, off));
        }
        const finalLen = channels[0]?.length ?? 0;
        if (finalLen <= 0) throw new Error('No data recorded');

        // Build a minimal AudioBuffer-like object for the worker (avoids AudioBuffer + round-trip)
        if (!audioCtx) throw new Error('Audio not ready');
        const bufferLike = {
            numberOfChannels: numChannels,
            sampleRate: audioCtx.sampleRate,
            channels
        };

        // Send directly to worker — skip AudioBuffer creation on main thread
        return await bufferToWaveWorker(bufferLike, finalLen);
    }

    dispose(): void {
        this.accepting = false;
        this.connected = false;
        if (this.node) {
            try { this.sourceNode.disconnect(this.node); } catch { /* ignore */ }
            this.node.disconnect();
            this.node = null;
        }
        this.chunks = [];
    }
}
