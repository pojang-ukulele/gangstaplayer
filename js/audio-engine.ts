import { audioCtx, masterGain, ensureAudio, initWorklets } from './audio';
import { state } from './state';
import {
    LOWSHELF_FREQ, PEAKING_FREQ, PEAKING_Q, HIGHSHELF_FREQ,
    LOWPASS_FREQ, HIGHPASS_FREQ
} from './constants';

/**
 * Create an <audio> element without throwing in Node/Jest where the
 * Audio constructor does not exist. In Electron this is exactly
 * `new Audio()` with the same defaults; outside a browser a minimal
 * stub is returned and the real element materializes lazily via
 * ensureNodes() once running with DOM audio support.
 */
function createAudioElement(): HTMLAudioElement {
    if (typeof Audio !== 'undefined') {
        try {
            const el = new Audio();
            el.crossOrigin = 'anonymous';
            el.preload = 'auto';
            return el;
        } catch { /* fall through to stub */ }
    }
    return {
        crossOrigin: null,
        preload: 'auto',
        src: '',
        currentTime: 0,
        loop: false,
        playbackRate: 1,
        volume: 1,
        error: null,
        pause(): void { /* noop in Node */ },
        load(): void { /* noop in Node */ },
        addEventListener(): void { /* noop in Node */ },
        removeEventListener(): void { /* noop in Node */ },
        removeAttribute(): void { /* noop in Node */ },
    } as unknown as HTMLAudioElement;
}

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
    /** Set once initWorklet() is ever requested — drives auto re-injection after rebuilds. */
    private _wantWorklet = false;
    /** True after a closed-context rebuild dropped the deck; cleared by load(). */
    private _wasRebuilt = false;
    /** Fired when the underlying <audio> element is recreated after a context rebuild. */
    onReplaced: ((newAudio: HTMLAudioElement, oldAudio: HTMLAudioElement) => void) | null = null;
    /** Superseder for a pending loadAsync handshake on this element. */
    private _pendingFinish: ((ok: boolean) => void) | null = null;

    /** True when a rebuild dropped the deck source — caller must re-load the track. */
    get needsReload(): boolean {
        return this._wasRebuilt;
    }

    get isWorkletReady(): boolean {
        return this._isWorkletConnected;
    }

    constructor() {
        this.audio = createAudioElement();
        this._attachErrorListener(this.audio);
        // Chain builds lazily via ensureNodes() — constructing at import time
        // used to permanently brick audio when the context wasn't ready yet.
        this.ensureNodes();
    }

    private _attachErrorListener(el: HTMLAudioElement): void {
        try {
            el.addEventListener('error', () => {
                const err = el.error;
                if (err) {
                    const src = typeof el.src === 'string' ? el.src.slice(0, 64) : '';
                    console.error(`[AudioChannel] Media error code ${err.code}: ${err.message} (src=${src})`);
                }
            });
        } catch { /* stub element or no DOM — ignore */ }
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
            const newAudio = createAudioElement();
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
            // Blob sources can't survive the element swap (C7) — flag the deck
            // so the player re-loads the current track instead of playing silence.
            this._wasRebuilt = true;
            try { this.onReplaced?.(newAudio, oldAudio); } catch { /* ignore */ }
        }
        if (this.gain && this.lowEQ && this.source && this._owningCtx === audioCtx && masterGain) return true;
        // Disconnect the full EQ/filter tail — previously only source/gain were
        // disconnected, orphaning live EQ nodes on same-context re-entry.
        for (const n of [this.source, this.lowEQ, this.midEQ, this.highEQ, this.lpFilter, this.hpFilter, this.workletNode, this.gain]) {
            try { (n as AudioNode | null)?.disconnect(); } catch { /* ignore */ }
        }
        // L8: removed dead hadWorklet capture — worklet desire now lives in
        // _wantWorklet and re-injection happens at the end of ensureNodes.
        this._isWorkletConnected = false;
        this.workletNode = null;
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
                const fresh = createAudioElement();
                this._attachErrorListener(fresh);
                try {
                    // Revoked blob: URLs must not be copied (M7) — flag reload.
                    if (oldAudio.src && !oldAudio.src.startsWith('blob:')) fresh.src = oldAudio.src;
                    else if (oldAudio.src) this._wasRebuilt = true;
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
        // Rebuilds drop the worklet node (C8) — re-inject inline when wanted.
        // Sync attempt first (modules may already be registered); otherwise
        // register on the new context, then inject.
        if (this._wantWorklet && !this._isWorkletConnected) {
            if (!this._tryInject()) {
                void initWorklets()
                    .catch(() => undefined)
                    .then(() => { try { this._tryInject(); } catch { /* deferred again */ } });
            }
        }
        return true;
    }

    /** Inject the worklet node assuming the chain exists. No ensureNodes call — recursion-free. */
    private _tryInject(): boolean {
        if (this._isWorkletConnected || !audioCtx) return this._isWorkletConnected;
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
            return true;
        } catch {
            console.warn("[AudioChannel] Worklet injection deferred (node not ready)");
            // Base chain is still connected, so audio will still play.
            return false;
        }
    }

    /**
     * Attempts to inject the Worklet into the signal chain safely.
     * If it fails, the signal remains intact via the base chain.
     */
    initWorklet(): void {
        this._wantWorklet = true;
        if (!this.ensureNodes() || !audioCtx || !masterGain) {
            console.error("Cannot initialize worklet: AudioContext is not available.");
            return;
        }
        if (this._isWorkletConnected) return;
        this._tryInject();
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
        // Pause first: assigning src on a playing element aborts in-flight
        // buffering with a media error (C13). needsReload clears — the deck
        // holds a fresh source again.
        try { this.audio.pause(); } catch { /* ignore */ }
        this.audio.src = url;
        this._wasRebuilt = false;
    }

    /**
     * Pause, assign, and handshake: resolves true once the element reaches
     * loadedmetadata (fast — catches missing/undecodable sources before
     * play()), false on error/timeout. Never rejects.
     */
    loadAsync(url: string, timeoutMs = 8000): Promise<boolean> {
        try { this.audio.pause(); } catch { /* ignore */ }
        this._wasRebuilt = false;
        // Supersede any pending handshake on this element: rapid skips
        // previously stacked N listener-pairs+timers for the full 8s, with
        // stale finish(true) resolving for long-replaced URLs.
        try { this._pendingFinish?.(false); } catch { /* ignore */ }
        this._pendingFinish = null;
        const el = this.audio;
        return new Promise<boolean>((resolve) => {
            let done = false;
            const finish = (ok: boolean): void => {
                if (done) return;
                done = true;
                if (this._pendingFinish === finish) this._pendingFinish = null;
                try { clearTimeout(timer); } catch { /* ignore */ }
                try { el.removeEventListener('loadedmetadata', onOk); } catch { /* ignore */ }
                try { el.removeEventListener('error', onErr); } catch { /* ignore */ }
                resolve(ok);
            };
            this._pendingFinish = finish;
            const onOk = (): void => finish(true);
            const onErr = (): void => finish(false);
            const timer = setTimeout(() => finish(el.readyState >= 1), timeoutMs);
            try {
                el.addEventListener('loadedmetadata', onOk, { once: true });
                el.addEventListener('error', onErr, { once: true });
            } catch { /* stub element — resolve on timeout */ }
            try {
                el.src = url;
                el.load();
            } catch {
                finish(false);
            }
        });
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
        // Single 1s retry previously left the idle deck at gain 1.0 when the
        // context still wasn't ready — the first AutoMix then blasted at full
        // volume. Retry a bounded number of times instead.
        let attempts = 0;
        const tryMute = (): void => {
            try {
                if (this.crossfade.gain) {
                    this.crossfade.gain.gain.value = 0;
                    return;
                }
            } catch { /* ignore */ }
            if (++attempts < 10) {
                const t = setTimeout(tryMute, 500);
                (t as any)?.unref?.();
            }
        };
        tryMute();
    }

    /**
     * Robust Worklet initialization with retry logic (M8: longer backoff —
     * file:// module fetch can exceed the old 100-300ms budget).
     */
    async initWorklets(retries = 5): Promise<void> {
        for (let i = 0; i < retries; i++) {
            this.main.initWorklet();
            this.crossfade.initWorklet();

            if (this.main.isWorkletReady && this.crossfade.isWorkletReady) break;

            console.log(`[AudioEngine] Worklet init retry ${i+1}...`);
            await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
        if (!this.crossfade.isWorkletReady) {
            console.warn('[AudioEngine] Crossfade worklet not ready — blends will be asymmetric');
        }
    }

    private _swapping = false;

    swapChannels(): void {
        // Engine-level atomicity (C9): the caller-side gen guard can still let
        // a stale finishCrossfade timer slip in during the swap itself.
        if (this._swapping) return;
        this._swapping = true;
        try {
            this._swapChannelsInner();
        } finally {
            this._swapping = false;
        }
    }

    private _swapChannelsInner(): void {
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

        try { this.crossfade.audio.pause(); } catch { /* ignore */ }
        try { this.crossfade.audio.removeAttribute('src'); this.crossfade.audio.load(); }
        catch { try { this.crossfade.audio.src = ""; } catch { /* ignore */ } }
        // Retired deck must be silent AND neutral for its next life as the
        // incoming channel — previously it kept LP 600Hz / EQ -24dB and the
        // next blend (or plain play) started filtered.
        try {
            const t = this.crossfade.gain?.context?.currentTime ?? 0;
            if (this.crossfade.gain) {
                this.crossfade.gain.gain.cancelScheduledValues(t);
                this.crossfade.gain.gain.setValueAtTime(0, t);
            }
            if (this.crossfade.lowEQ) {
                this.crossfade.lowEQ.gain.cancelScheduledValues(t);
                this.crossfade.lowEQ.gain.setValueAtTime(0, t);
            }
            if (this.crossfade.midEQ) {
                this.crossfade.midEQ.gain.cancelScheduledValues(t);
                this.crossfade.midEQ.gain.setValueAtTime(0, t);
            }
            if (this.crossfade.highEQ) {
                this.crossfade.highEQ.gain.cancelScheduledValues(t);
                this.crossfade.highEQ.gain.setValueAtTime(0, t);
            }
            if (this.crossfade.lpFilter) {
                this.crossfade.lpFilter.frequency.cancelScheduledValues(t);
                this.crossfade.lpFilter.frequency.setValueAtTime(LOWPASS_FREQ, t);
            }
            if (this.crossfade.hpFilter) {
                this.crossfade.hpFilter.frequency.cancelScheduledValues(t);
                this.crossfade.hpFilter.frequency.setValueAtTime(HIGHPASS_FREQ, t);
            }
        } catch { /* ignore */ }

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
