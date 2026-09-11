import { audioCtx, ensureAudio } from './audio';
import { bufferToWaveWorker } from './worker-client';
import { logger } from './logger';

export class HighFidelityRecorder {
    private node: AudioWorkletNode | null = null;
    private chunks: Float32Array[][] = [];
    private stopAckHandler: ((event: MessageEvent) => void) | null = null;
    private accepting = false;
    private connected = false;
    // Sample rate is locked at take start: a device/context switch mid-take
    // must not silently re-stamp the WAV header with the new rate.
    private lockedSampleRate = 0;
    /** Set when the block cap stopped intake — surfaced in stop(). */
    private _capped = false;
    /** Serializes stop() — concurrent stops corrupted the ack handler. */
    private _stopping = false;

    private readonly _resolveSource: () => AudioNode | null;

    /**
     * @param sourceNode the master tap, or a provider returning the CURRENT
     * master tap. A fixed node goes dead on AudioContext rebuild (C7) — pass
     * a provider (e.g. () => masterGain) so retap() can re-attach.
     */
    constructor(sourceNode: AudioNode | (() => AudioNode | null)) {
        this._resolveSource = typeof sourceNode === 'function'
            ? sourceNode as () => AudioNode | null
            : () => sourceNode as AudioNode;
    }

    private _source(): AudioNode | null {
        try { return this._resolveSource(); } catch { return null; }
    }

    /**
     * Re-attach the tap to the current master chain after an AudioContext
     * rebuild. Refused mid-take (would split the capture across contexts).
     * Returns true when tapped.
     */
    retap(): boolean {
        if (this.accepting) {
            logger.warn('[Recorder] retap refused: take in progress');
            return false;
        }
        const src = this._source();
        if (!this.node || !src) return false;
        try { this.node.disconnect(); } catch { /* ignore */ }
        try { src.disconnect(this.node as unknown as AudioNode); } catch { /* old chain — ignore */ }
        try {
            src.connect(this.node);
            this.connected = true;
            return true;
        } catch {
            this.connected = false;
            return false;
        }
    }

    async init(): Promise<void> {
        if (!ensureAudio() || !audioCtx) throw new Error('Audio not ready');
        // Guard rebuild mid-take: disposing the worklet while accepting
        // would orphan the tap and strand captured chunks.
        if (this.accepting) {
            logger.warn('[Recorder] init() refused: take in progress (stop before rebuilding)');
            return;
        }
        // Second init previously orphaned the old worklet (double capture + CPU).
        this.dispose();
        try {
            this.node = new AudioWorkletNode(audioCtx, 'recorder-processor');
            this.node.port.onmessage = (event) => {
                if (event.data.type === 'DATA') {
                    if (!this.accepting) return; // post-STOP stragglers → next take
                    const payload = event.data.payload as Float32Array[];
                    if (Array.isArray(payload) && payload.length > 0) {
                        // Length cap must STOP intake loudly, not silently drop
                        // the tail while the UI keeps showing REC (H13).
                        if (this.chunks.length >= 90000) {
                            this.accepting = false;
                            this._capped = true;
                            // Tell the worklet to stop sending — previously it
                            // kept posting DATA at 60/s for the rest of the
                            // take, each dropped after the check (CPU waste).
                            try { this.node?.port.postMessage({ type: 'STOP' }); } catch { /* ignore */ }
                            logger.warn('[Recorder] Block cap hit — intake stopped, keep what was captured');
                            return;
                        }
                        this.chunks.push(payload);
                    }
                }
            };
            const src = this._source();
            if (!src) throw new Error('Master tap unavailable');
            src.connect(this.node);
            this.connected = true;
            logger.info('[Recorder] High-Fidelity Recorder initialized');
        } catch (e) {
            logger.error('[Recorder] Initialization failed', e);
            throw e;
        }
    }

    start(): void {
        // Loud failure instead of fake REC: previously start() with no node
        // silently returned while the UI already showed REC (no capture).
        if (!this.node) throw new Error('Recorder not initialized (call init() first)');
        // Double-start previously wiped the in-flight take's chunks (H13).
        if (this.accepting) {
            logger.warn('[Recorder] start() ignored: take already in progress');
            return;
        }
        // Reconnect if a previous stop disconnected the tap to save CPU.
        // Resolve fresh each take — the master chain may have been rebuilt.
        if (!this.connected) {
            try {
                const src = this._source();
                if (src) { src.connect(this.node); this.connected = true; }
            } catch { /* ignore */ }
        }
        // Null tap previously recorded silence with no error — the take looked
        // live but captured nothing.
        if (!this.connected || !this._source()) {
            throw new Error('Recorder has no master tap (audio unavailable)');
        }
        this.chunks = [];
        this._capped = false;
        this.accepting = true;
        // Lock the rate for this take — compileWav stamps the header from
        // this value even if the context is rebuilt mid-take.
        try {
            this.lockedSampleRate = audioCtx?.sampleRate ?? this.lockedSampleRate;
        } catch { /* ignore */ }
        this.node.port.postMessage({ type: 'START' });
        logger.info(`[Recorder] Recording started @ ${this.lockedSampleRate || 'unknown'}Hz`);
    }

    async stop(): Promise<Blob> {
        if (!this.node) throw new Error('Recorder not initialized');
        // Double-stop previously overwrote stopAckHandler mid-flight: the first
        // ack's cleanup removed the second handler, stranding the second stop
        // until the 2s timeout. Serialize stops.
        if (this._stopping) throw new Error('Stop already in progress');
        this._stopping = true;
        try {

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

        logger.info(`[Recorder] Recording stopped. Captured ${this.chunks.length} blocks.${this._capped ? ' (capped)' : ''}`);

        // Freeze intake BEFORE snapshot — DATA racing the STOPPED ack previously
        // landed in the next take's chunks.
        this.accepting = false;
        const wasCapped = this._capped;
        this._capped = false;
        const captured = this.chunks;
        this.chunks = [];
        if (wasCapped) logger.warn('[Recorder] Take hit the 30-minute cap — tail beyond the cap was not captured');

        // Disconnect the tap while idle — a permanently connected worklet
        // processes every quantum forever after the first take.
        try {
            if (this.node && this.connected) {
                try { this._source()?.disconnect(this.node); } catch { /* old chain — ignore */ }
                this.connected = false;
            }
        } catch { /* already disconnected */ }

        const result = await this.compileWav(captured);
        this._stopping = false;
        return result;
        } catch (e) {
            this._stopping = false;
            throw e;
        }
    }

    private async compileWav(chunks: Float32Array[][]): Promise<Blob> {
        if (chunks.length === 0) throw new Error('No data recorded');
        // Each chunk is one flushed batch (~8x128=1024 samples/ch). 30min @48kHz
        // ≈ 86.4M samples/ch ≈ 84k chunks. Cap blocks + total PCM samples.
        const MAX_BLOCKS = 90000;
        const MAX_SAMPLES = 90 * 1000000;
        if (chunks.length > MAX_BLOCKS) throw new Error('Recording too long (30min cap)');

        const firstValid = chunks.find(b => Array.isArray(b) && b.length > 0);
        const numChannels = firstValid ? firstValid.length : 0;
        if (!numChannels) throw new Error('No data recorded');
        // Two-pass exact assembly (C11): the old allocate-max + slice(0, off)
        // held 2x per channel transiently (~720MB + copy for a 30min stereo
        // take). Pass 1 measures the exact per-channel length; pass 2 fills
        // it and transfers the whole buffer — no second copy.
        const exactLens = new Array<number>(numChannels).fill(0);
        for (const block of chunks) {
            if (!block || block.length !== numChannels) continue;
            for (let c = 0; c < numChannels; c++) {
                exactLens[c] += block[c]?.length ?? 0;
            }
        }
        const finalLen = exactLens[0] ?? 0;
        if (finalLen <= 0) throw new Error('No data recorded');
        if (finalLen > MAX_SAMPLES) throw new Error('Recording too long (30min cap)');

        const channels: Float32Array[] = [];
        for (let channel = 0; channel < numChannels; channel++) {
            const channelData = new Float32Array(exactLens[channel]);
            let off = 0;
            for (const block of chunks) {
                const src = block?.[channel];
                if (!src || src.length === 0 || off >= channelData.length) continue;
                const room = channelData.length - off;
                const take = src.length > room ? src.subarray(0, room) : src;
                channelData.set(take, off);
                off += take.length;
            }
            channels.push(channelData);
        }
        if (finalLen <= 0) throw new Error('No data recorded');

        // Build a minimal AudioBuffer-like object for the worker (avoids AudioBuffer + round-trip)
        // Use the take-start rate, not the live context rate (may have switched mid-take).
        const takeRate = this.lockedSampleRate > 0
            ? this.lockedSampleRate
            : (audioCtx?.sampleRate ?? 0);
        if (!takeRate) throw new Error('Audio not ready');
        if (audioCtx && audioCtx.sampleRate !== takeRate) {
            logger.warn(`[Recorder] Sample rate changed mid-take (${takeRate} -> ${audioCtx.sampleRate}); keeping take rate`);
        }
        const bufferLike = {
            numberOfChannels: numChannels,
            sampleRate: takeRate,
            channels
        };

        // Send directly to worker — skip AudioBuffer creation on main thread
        return await bufferToWaveWorker(bufferLike, finalLen);
    }

    dispose(): void {
        // Mid-take dispose previously dropped the capture silently (H13).
        if (this.accepting) logger.warn('[Recorder] dispose() during take — capture discarded');
        this.accepting = false;
        this._capped = false;
        this.connected = false;
        if (this.node) {
            try { this._source()?.disconnect(this.node); } catch { /* ignore */ }
            try { this.node.disconnect(); } catch { /* ignore */ }
            this.node = null;
        }
        this.chunks = [];
    }
}
