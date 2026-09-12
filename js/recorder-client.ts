import { audioCtx, ensureAudio, onAudioRebuilt } from './audio';
import { bufferToWaveWorker } from './worker-client';
import { logger } from './logger';
import { toast } from './toast';

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
    // Take-start tap ownership: the {source, context, node} live at start().
    // stop()/dispose() disconnect THAT stored tap, never the current
    // _source() (which may belong to a rebuilt chain mid-take).
    private _takeSource: AudioNode | null = null;
    private _takeCtx: AudioContext | null = null;
    private _takeNode: AudioWorkletNode | null = null;
    /** Set when a mid-take rebuild killed the tap — stop() rejects loudly. */
    private _tapDead = false;
    private _tapDeadReason = '';
    /** Zero-gain sink: node→sink→destination keeps the worklet alive
     * (a sink-less worklet can suspend and capture nothing). */
    private _sink: GainNode | null = null;

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
        // Auto-retap path: an ensureAudio() rebuild mid-take orphans the tap.
        // When idle this is a no-op (next start() resolves fresh); mid-take
        // the handler re-attaches to the new chain or fails the take loudly.
        try { onAudioRebuilt(() => this._onRebuilt()); } catch { /* headless — ignore */ }
    }

    private _source(): AudioNode | null {
        try { return this._resolveSource(); } catch { return null; }
    }

    /** Rebuild handler: retap mid-take onto the new chain, or fail loudly. */
    private _onRebuilt(): void {
        if (!this.accepting) return; // idle — next start() resolves the tap fresh
        if (this._doRetap()) {
            // Retap succeeded — re-point take ownership at the live chain.
            try { this._takeSource = this._source(); } catch { /* keep old */ }
            try { this._takeCtx = audioCtx; } catch { /* keep old */ }
            logger.warn('[Recorder] Tap re-attached after audio rebuild mid-take');
            return;
        }
        // Retap failed: the take is stuck on a dead context. Stop intake and
        // mark it — stop() rejects instead of handing back a silent WAV.
        this._tapDead = true;
        this._tapDeadReason = 'rebuild';
        this.accepting = false;
        try { toast.error('RECORDING TAP LOST (AUDIO REBUILD) — TAKE DISCARDED'); } catch { /* ignore */ }
        logger.error('[Recorder] Audio rebuilt mid-take and retap failed — take marked dead');
    }

    /** Best-effort zero-gain sink so the worklet never runs sink-less. */
    private _attachSink(): void {
        try {
            const actx = audioCtx as AudioContext | null;
            if (!this.node || !actx || typeof actx.createGain !== 'function' || !actx.destination) return;
            try { this._sink?.disconnect(); } catch { /* ignore */ }
            const sink = actx.createGain();
            sink.gain.value = 0;
            this.node.connect(sink as unknown as AudioNode);
            (sink as GainNode).connect(actx.destination);
            this._sink = sink;
        } catch { /* headless/test env — capture path still works without a sink */ }
    }

    /** Reconnect node to the current source (+ sink). Mid-take capable. */
    private _doRetap(): boolean {
        const src = this._source();
        if (!this.node || !src) return false;
        try { this.node.disconnect(); } catch { /* ignore */ }
        try { src.disconnect(this.node as unknown as AudioNode); } catch { /* old chain — ignore */ }
        try {
            src.connect(this.node);
            this._attachSink();
            this.connected = true;
            return true;
        } catch {
            this.connected = false;
            return false;
        }
    }

    /**
     * Re-attach the tap to the current master chain after an AudioContext
     * rebuild. Refused mid-take (would split the capture across contexts) —
     * mid-take rebuilds are handled by the onAudioRebuilt auto-retap path
     * instead, which fails the take loudly when re-attachment is impossible.
     * Returns true when tapped.
     */
    retap(): boolean {
        if (this.accepting) {
            logger.warn('[Recorder] retap refused: take in progress');
            return false;
        }
        return this._doRetap();
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
            // Sink-less worklets can suspend and capture nothing — keep
            // node→zeroGain→destination alongside the tap (best-effort).
            this._attachSink();
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
        this._attachSink();
        this.chunks = [];
        this._capped = false;
        // Take-start ownership: stop()/dispose() tear down THIS tap, even if
        // the live chain is rebuilt mid-take.
        try { this._takeSource = this._source(); } catch { this._takeSource = null; }
        try { this._takeCtx = audioCtx; } catch { this._takeCtx = null; }
        this._takeNode = this.node;
        this._tapDead = false;
        this._tapDeadReason = '';
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
        const wasDead = this._tapDead;
        const deadReason = this._tapDeadReason;
        this._tapDead = false;
        this._tapDeadReason = '';
        // Snapshot + clear synchronously: bufferToWaveWorker transfers
        // (neuters) the assembled copies, so a racing second stop can only
        // ever see the fresh empty array — never a neutered buffer.
        const captured = this.chunks;
        this.chunks = [];

        // Disconnect the TAKE's stored tap while idle — a permanently
        // connected worklet processes every quantum forever after the first
        // take. Uses take-start ownership, not the current live source.
        try {
            const takeNode = this._takeNode ?? this.node;
            if (takeNode && this.connected) {
                try { this._takeSource?.disconnect(takeNode as unknown as AudioNode); } catch { /* old chain — ignore */ }
                try { takeNode.disconnect(); } catch { /* ignore */ }
                this.connected = false;
            }
            try { this._sink?.disconnect(); } catch { /* ignore */ }
            this._sink = null;
        } catch { /* already disconnected */ }
        this._takeSource = null;
        this._takeCtx = null;
        this._takeNode = null;

        // Loud failures — never hand back a silent/partial WAV as success.
        if (wasDead) {
            const msg = `Recorder tap went stale mid-take (${deadReason || 'rebuild'}) — take is dead, no data recorded`;
            try { toast.error('RECORDING TAP LOST — TAKE DISCARDED'); } catch { /* ignore */ }
            logger.error(`[Recorder] ${msg}`);
            throw new Error(msg);
        }
        if (wasCapped) {
            const msg = 'TAKE_TOO_LONG: Recording exceeded the 30-minute block cap — tail beyond the cap was not captured';
            try { toast.error('RECORDING TOO LONG (30MIN CAP) — TAKE DISCARDED'); } catch { /* ignore */ }
            logger.error(`[Recorder] ${msg}`);
            throw new Error(msg);
        }

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
        if (chunks.length > MAX_BLOCKS) throw new Error('TAKE_TOO_LONG: Recording too long (30min block cap)');

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
        if (finalLen > MAX_SAMPLES) throw new Error('TAKE_TOO_LONG: Recording too long (30min sample cap)');

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
        // Dead/stale taps capture exact silence — handing that back as a WAV
        // looks like a successful take. Fail loudly instead (never silent WAV).
        let peak = 0;
        for (const ch of channels) {
            for (let i = 0; i < ch.length; i++) {
                const a = Math.abs(ch[i]);
                if (a > peak) peak = a;
                if (peak > 0) break;
            }
            if (peak > 0) break;
        }
        if (peak === 0) throw new Error('Recorder captured silent audio (dead/stale tap?) — no data recorded');

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
        this._tapDead = false;
        this._tapDeadReason = '';
        this.connected = false;
        // Tear down the take's stored tap (not the current live source).
        const takeNode = this._takeNode ?? this.node;
        if (takeNode) {
            try { (this._takeSource ?? this._source())?.disconnect(takeNode as unknown as AudioNode); } catch { /* ignore */ }
            try { takeNode.disconnect(); } catch { /* ignore */ }
        }
        try { this._sink?.disconnect(); } catch { /* ignore */ }
        this._sink = null;
        this._takeSource = null;
        this._takeCtx = null;
        this._takeNode = null;
        if (this.node) {
            this.node = null;
        }
        this.chunks = [];
    }
}
