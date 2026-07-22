import { audioCtx, masterGain } from './audio';

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

    get isWorkletReady(): boolean {
        return this._isWorkletConnected;
    }

    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = "anonymous";
        if (!audioCtx || !masterGain) {
            console.error("AudioContext or masterGain is not available. Audio features will be limited.");
            return;
        }
        this.gain = audioCtx.createGain();
        this.lowEQ = audioCtx.createBiquadFilter();
        this.midEQ = audioCtx.createBiquadFilter();
        this.highEQ = audioCtx.createBiquadFilter();
        this.lpFilter = audioCtx.createBiquadFilter();
        this.hpFilter = audioCtx.createBiquadFilter();

        this.lowEQ.type = 'lowshelf'; this.lowEQ.frequency.value = 320;
        this.midEQ.type = 'peaking'; this.midEQ.frequency.value = 1000; this.midEQ.Q.value = 0.5;
        this.highEQ.type = 'highshelf'; this.highEQ.frequency.value = 3200;
        this.lpFilter.type = 'lowpass'; this.lpFilter.frequency.value = 20000;
        this.hpFilter.type = 'highpass'; this.hpFilter.frequency.value = 30;

        // Base signal chain: Source -> EQ -> LP -> HP -> Gain -> Out
        this.source = audioCtx.createMediaElementSource(this.audio);

        if (this.lowEQ && this.midEQ && this.highEQ && this.lpFilter && this.hpFilter && this.gain && masterGain) {
            this.source.connect(this.lowEQ);
            this.lowEQ.connect(this.midEQ);
            this.midEQ.connect(this.highEQ);
            this.highEQ.connect(this.lpFilter);
            this.lpFilter.connect(this.hpFilter);
            this.hpFilter.connect(this.gain);
            this.gain.connect(masterGain);
        }
    }

    /**
     * Attempts to inject the Worklet into the signal chain safely.
     * If it fails, the signal remains intact via the base chain.
     */
    initWorklet(): void {
        if (!audioCtx || !masterGain) {
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
        if (!audioCtx || !this.gain || !this.lowEQ || !this.midEQ || !this.highEQ || !this.lpFilter || !this.hpFilter) {
            console.warn("[AudioChannel] Cannot reset: AudioContext or audio nodes not available.");
            return;
        }
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
        this.lpFilter.frequency.setValueAtTime(20000, now);
        this.hpFilter.frequency.cancelScheduledValues(now);
        this.hpFilter.frequency.setValueAtTime(30, now);
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
        if (this.crossfade.gain) {
            this.crossfade.gain.gain.value = 0;
        }
    }

    /**
     * Robust Worklet initialization with retry logic
     */
    async initWorklets(retries = 3): Promise<void> {
        for (let i = 0; i < retries; i++) {
            this.main.initWorklet();
            this.crossfade.initWorklet();

            if (this.main.isWorkletReady) break;

            console.log(`[AudioEngine] Worklet init retry ${i+1}...`);
            await new Promise(r => setTimeout(r, 100 * (i + 1)));
        }
    }

    swapChannels(): void {
        const temp = this.main;
        this.main = this.crossfade;
        this.crossfade = temp;

        this.crossfade.audio.pause();
        this.crossfade.audio.src = "";
    }
}

export const engine = new AudioEngine();
