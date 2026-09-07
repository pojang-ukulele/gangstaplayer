import { audioCtx, masterGain, ensureAudio } from './audio';
import { state } from './state';
import {
    LOWSHELF_FREQ, PEAKING_FREQ, PEAKING_Q, HIGHSHELF_FREQ,
    LOWPASS_FREQ, HIGHPASS_FREQ
} from './constants';

export class AudioChannel {
    audio: HTMLAudioElement;
    gain: GainNode | null = null;
    lowEQ: BiquadFilterNode | null = null;
    midEQ: BiquadFilterNode | null = null;
    highEQ: BiquadFilterNode | null = null;
    lpFilter: BiquadFilterNode | null = null;
    hpFilter: BiquadFilterNode | null = null;
    source: MediaElementAudioSourceNode | null = null;
    workletNode: AudioWorkletNode | null = null;
    private _isWorkletConnected = false;
    private _owningCtx: AudioContext | null = null;
    /** Fired when the underlying <audio> element is recreated after a context rebuild. */
    onReplaced: ((newAudio: HTMLAudioElement, oldAudio: HTMLAudioElement) => void) | null = null;

    get isWorkletReady(): boolean {
        return this._isWorkletConnected;
    }

    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = "anonymous";
        this.audio.preload = 'auto';
        this._attachErrorListener(this.audio);
        // Chain builds lazily via ensureNodes() — constructing at import time
        // used to permanently brick audio when the context wasn't ready yet.
        this.ensureNodes();
    }

    private _attachErrorListener(el: HTMLAudioElement): void {
        el.addEventListener('error', () => {
            const err = el.error;
            if (err) {
                const src = typeof el.src === 'string' ? el.src.slice(0, 64) : '';
                console.error(`[AudioChannel] Media error code ${err.code}: ${err.message} (src=${src})`);
            }
        });
    }

    /** Re-apply worklet routing after a rebuild (ensureNodes drops it). */
    private _reapplyWorklet(): void {
        if (!this.workletNode || !audioCtx || !this.hpFilter || !this.gain) return;
        try {
            this.hpFilter.disconnect();
            this.hpFilter.connect(this.workletNode);
            try { (this.workletNode as AudioWorkletNode).disconnect(); } catch { /* ignore */ }
            this.workletNode.connect(this.gain);
            this._isWorkletConnected = true;
        } catch { this._isWorkletConnected = false; }
    }

    /** Build (or rebuild after a closed-context reset) the signal chain. */
    ensureNodes(): boolean {
        if (!ensureAudio() || !audioCtx || !masterGain) return false;
        // Context was rebuilt (old context closed) — old nodes are bound to a
        // dead context and createMediaElementSource() cannot be called twice
        // on the same <audio> element. Recreate the element and rebuild.
        if (this._owningCtx && this._owningCtx !== audioCtx) {
            const oldAudio = this.audio;
            try { oldAudio.pause(); } catch { /* ignore */ }
            const newAudio = new Audio();
            newAudio.crossOrigin = "anonymous";
            newAudio.preload = 'auto';
            this._attachErrorListener(newAudio);
            try {
                // Blob URLs may have been revoked by revokeLater — only copy
                // non-blob state; the caller re-loads the track after rebuild.
                if (oldAudio.src && !oldAudio.src.startsWith('blob:')) newAudio.src = oldAudio.src;
                try { newAudio.currentTime = oldAudio.currentTime || 0; } catch { /* not seekable */ }
                newAudio.loop = oldAudio.loop;
                newAudio.playbackRate = oldAudio.playbackRate;
                newAudio.volume = oldAudio.volume;
            } catch { /* ignore copy errors */ }
            this.audio = newAudio;
            // Drop all dead-context nodes so they are rebuilt below.
            this.source = null;
            this.gain = null;
            this.lowEQ = null;
            this.midEQ = null;
            this.highEQ = null;
            this.lpFilter = null;
            this.hpFilter = null;
            this.workletNode = null;
            this._isWorkletConnected = false;
            this._owningCtx = null;
            try { this.onReplaced?.(newAudio, oldAudio); } catch { /* ignore */ }
        }
        if (this.gain && this.lowEQ && this.source && this._owningCtx === audioCtx && masterGain) return true;
        // Disconnect the full EQ/filter tail — previously only source/gain were
        // disconnected, orphaning live EQ nodes on same-context re-entry.
        for (const n of [this.source, this.lowEQ, this.midEQ, this.highEQ, this.lpFilter, this.hpFilter, this.workletNode, this.gain]) {
            try { (n as AudioNode | null)?.disconnect(); } catch { /* ignore */ }
        }
        const hadWorklet = !!this.workletNode;
        this._isWorkletConnected = false;
        this.workletNode = null;
        void hadWorklet;
        this.gain = audioCtx.createGain();
        this.lowEQ = audioCtx.createBiquadFilter();
        this.midEQ = audioCtx.createBiquadFilter();
        this.highEQ = audioCtx.createBiquadFilter();
        this.lpFilter = audioCtx.createBiquadFilter();
        this.hpFilter = audioCtx.createBiquadFilter();

        this.lowEQ.type = 'lowshelf'; this.lowEQ.frequency.value = LOWSHELF_FREQ;
        this.midEQ.type = 'peaking'; this.midEQ.frequency.value = PEAKING_FREQ; this.midEQ.Q.value = PEAKING_Q;
        this.highEQ.type = 'highshelf'; this.highEQ.frequency.value = HIGHSHELF_FREQ;
        this.lpFilter.type = 'lowpass'; this.lpFilter.frequency.value = LOWPASS_FREQ;
        this.hpFilter.type = 'highpass'; this.hpFilter.frequency.value = HIGHPASS_FREQ;

        // Base signal chain: Source -> EQ -> LP -> HP -> Gain -> Out
        // createMediaElementSource() throws if this element already has a
        // source (single-use per element lifetime). Recreate the element once
        // and retry instead of bricking audio forever.
        try {
            this.source = audioCtx.createMediaElementSource(this.audio);
        } catch {
            try {
                const oldAudio = this.audio;
                try { oldAudio.pause(); } catch { /* ignore */ }
                const fresh = new Audio();
                fresh.crossOrigin = "anonymous";
                this._attachErrorListener(fresh);
                try {
                    if (oldAudio.src) fresh.src = oldAudio.src;
                    fresh.loop = oldAudio.loop;
                    fresh.playbackRate = oldAudio.playbackRate;
                } catch { /* ignore */ }
                this.audio = fresh;
                try { this.onReplaced?.(fresh, oldAudio); } catch { /* ignore */ }
                this.source = audioCtx.createMediaElementSource(this.audio);
            } catch {
                return false;
            }
        }

        if (this.lowEQ && this.midEQ && this.highEQ && this.lpFilter && this.hpFilter && this.gain && masterGain) {
            this.source.connect(this.lowEQ);
            this.lowEQ.connect(this.midEQ);
            this.midEQ.connect(this.highEQ);
            this.highEQ.connect(this.lpFilter);
            this.lpFilter.connect(this.hpFilter);
            this.hpFilter.connect(this.gain);
            this.gain.connect(masterGain);
        }
        this._owningCtx = audioCtx;
        return true;
    }

    /**
     * Attempts to inject the Worklet into the signal chain safely.
     * If it fails, the signal remains intact via the base chain.
     */
    initWorklet(): void {
        if (!this.ensureNodes() || !audioCtx || !masterGain) {
            console.error("Cannot initialize worklet: AudioContext is not available.");
            return;
        }
        if (this._isWorkletConnected) return;

        try {
            this.workletNode = new AudioWorkletNode(audioCtx, 'gangsta-processor');

            // Safe re-routing
            if (this.hpFilter && this.workletNode && this.gain) {
                this.hpFilter.disconnect(this.gain);
                this.hpFilter.connect(this.workletNode);
                this.workletNode.connect(this.gain);
            }

            this._isWorkletConnected = true;
            console.log("[AudioChannel] Worklet injection successful");
        } catch (e) {
            console.warn("[AudioChannel] Worklet injection deferred (node not ready)");
            // Base chain is still connected, so audio will still play.
        }
    }

    reset(): void {
        if (!this.ensureNodes() || !audioCtx || !this.gain || !this.lowEQ || !this.midEQ || !this.highEQ || !this.lpFilter || !this.hpFilter) {
            console.warn("[AudioChannel] Cannot reset: AudioContext or audio nodes not available.");
            return;
        }
        // Rebuilds drop the worklet routing — restore it so FX don't die after
        // the first loadTrack/stopPlayback (which all call reset()).
        if (this.workletNode && !this._isWorkletConnected) this._reapplyWorklet();
        const now = audioCtx.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(1, now);
        this.lowEQ.gain.cancelScheduledValues(now);
        this.lowEQ.gain.setValueAtTime(0, now);
        this.midEQ.gain.cancelScheduledValues(now);
        this.midEQ.gain.setValueAtTime(0, now);
        this.highEQ.gain.cancelScheduledValues(now);
        this.highEQ.gain.setValueAtTime(0, now);
        this.lpFilter.frequency.cancelScheduledValues(now);
        this.lpFilter.frequency.setValueAtTime(LOWPASS_FREQ, now);
        this.hpFilter.frequency.cancelScheduledValues(now);
        this.hpFilter.frequency.setValueAtTime(HIGHPASS_FREQ, now);
    }

    load(url: string): void {
        this.audio.src = url;
    }
}

class AudioEngine {
    main: AudioChannel;
    crossfade: AudioChannel;

    constructor() {
        this.main = new AudioChannel();
        this.crossfade = new AudioChannel();
        this.muteCrossfade();
    }

    /** Keep the idle deck silent even when nodes materialize lazily after construction. */
    private muteCrossfade(): void {
        try {
            if (this.crossfade.gain) this.crossfade.gain.gain.value = 0;
            else {
                // Nodes not ready pre-gesture — retry once they exist.
                setTimeout(() => {
                    try { if (this.crossfade.gain) this.crossfade.gain.gain.value = 0; } catch { /* ignore */ }
                }, 1000);
            }
        } catch { /* ignore */ }
    }

    /**
     * Robust Worklet initialization with retry logic
     */
    async initWorklets(retries = 3): Promise<void> {
        for (let i = 0; i < retries; i++) {
            this.main.initWorklet();
            this.crossfade.initWorklet();

            if (this.main.isWorkletReady && this.crossfade.isWorkletReady) break;

            console.log(`[AudioEngine] Worklet init retry ${i+1}...`);
            await new Promise(r => setTimeout(r, 100 * (i + 1)));
        }
        if (!this.crossfade.isWorkletReady) {
            console.warn('[AudioEngine] Crossfade worklet not ready — blends will be asymmetric');
        }
    }

    swapChannels(): void {
        const outgoing = this.main;
        // Cancel automation on the retired deck — early/late timers otherwise
        // leave scheduled gain/EQ/filter events on the now-crossfade channel.
        try {
            const t = outgoing.gain?.context?.currentTime ?? 0;
            outgoing.gain?.gain.cancelScheduledValues(t);
            outgoing.lowEQ?.gain.cancelScheduledValues(t);
            outgoing.midEQ?.gain.cancelScheduledValues(t);
            outgoing.highEQ?.gain.cancelScheduledValues(t);
            outgoing.lpFilter?.frequency.cancelScheduledValues(t);
            outgoing.hpFilter?.frequency.cancelScheduledValues(t);
        } catch { /* ignore */ }
        const temp = this.main;
        this.main = this.crossfade;
        this.crossfade = temp;

        this.crossfade.audio.pause();
        try { this.crossfade.audio.removeAttribute('src'); this.crossfade.audio.load(); }
        catch { try { this.crossfade.audio.src = ""; } catch { /* ignore */ } }
        // Retired deck must be silent for its next life as the incoming channel.
        try { if (this.crossfade.gain) this.crossfade.gain.gain.value = 0; } catch { /* ignore */ }

        // The loop flag was set on the retired element — re-apply it to the
        // promoted one or LOOP ONE silently stops working after any crossfade.
        this.main.audio.loop = (state.loopMode === 'one');
        // Timer-vs-audio-clock drift can leave the promoted gain below 1 —
        // enforce unity so the deck never gets stuck quiet after a swap.
        try {
            if (this.main.gain && audioCtx) {
                this.main.gain.gain.cancelScheduledValues(audioCtx.currentTime);
                this.main.gain.gain.setValueAtTime(1, audioCtx.currentTime);
            }
        } catch { /* ignore */ }
    }
}

export const engine = new AudioEngine();
