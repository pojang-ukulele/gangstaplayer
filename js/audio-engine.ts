import { audioCtx, masterGain } from './audio';

export class AudioChannel {
    audio: HTMLAudioElement;
    gain: GainNode;
    lowEQ: BiquadFilterNode;
    midEQ: BiquadFilterNode;
    highEQ: BiquadFilterNode;
    lpFilter: BiquadFilterNode;
    hpFilter: BiquadFilterNode;
    source: MediaElementAudioSourceNode;

    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = "anonymous";
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

        this.source = audioCtx.createMediaElementSource(this.audio);
        this.source.connect(this.lowEQ);
        this.lowEQ.connect(this.midEQ);
        this.midEQ.connect(this.highEQ);
        this.highEQ.connect(this.lpFilter);
        this.lpFilter.connect(this.hpFilter);
        this.hpFilter.connect(this.gain);
        this.gain.connect(masterGain);
    }

    reset(): void {
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
        // Crossfade channel starts at 0 gain
        this.crossfade.gain.gain.value = 0.001;
    }

    swapChannels(): void {
        // Promote crossfade to main
        const temp = this.main;
        this.main = this.crossfade;
        this.crossfade = temp;
        
        // Clean up now-background channel
        this.crossfade.audio.pause();
        this.crossfade.audio.src = "";
    }
}

export const engine = new AudioEngine();
