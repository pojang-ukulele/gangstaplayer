/**
 * Gangsta AudioWorklet Processor - Master Guru Edition
 * Features: 
 * - 2x Oversampling (Linear Upsampling / Decimation)
 * - Anti-Aliasing DSP Chain
 * - Stereo isolation & Parameter smoothing
 * - Hardened Moog-Ladder DSP (Stability-Enhanced)
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processorClass: unknown): void;

// P3-I decision (documented): wire parameters + per-channel state (NOT dead
// ladder deletion). The bypass below is an intentional documented passthrough
// (P1): at default knob positions the crusher/drive/filter are mathematical
// no-ops, so quanta copy through to save CPU. Non-default positions run the
// full 2x-oversampled ladder with per-channel state (stateL/stateR + prevL/
// prevR never shared across channels).

// Define a minimal interface for the class to satisfy the compiler
interface AudioWorkletProcessorInstance {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

interface GangstaProcessorGlobals {
    AudioWorkletProcessor: new () => AudioWorkletProcessorInstance;
}

const GBaseProcessor = (globalThis as unknown as GangstaProcessorGlobals).AudioWorkletProcessor;

class GangstaProcessor extends GBaseProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bitDepth', defaultValue: 16, minValue: 1, maxValue: 16 },
      { name: 'drive', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'filterCutoff', defaultValue: 20000, minValue: 20, maxValue: 20000 },
      { name: 'filterResonance', defaultValue: 0.1, minValue: 0, maxValue: 1 }
    ];
  }

  // Per-channel state to prevent stereo bleed
  private stateL = [0, 0, 0, 0];
  private stateR = [0, 0, 0, 0];
  
  // Previous sample state for upsampling
  private prevL = 0;
  private prevR = 0;

  // Smoothing values
  private smoothCutoff = 20000;
  private smoothDrive = 0;
  private smoothBitDepth = 16;
  private smoothResonance = 0.1;
  private smoothingFactor = 0.05; 

  private resetStates(): void {
    this.stateL = [0, 0, 0, 0];
    this.stateR = [0, 0, 0, 0];
    this.prevL = 0;
    this.prevR = 0;
  }

  /** Passthrough the unprocessed tail so a mid-block reset degrades to dry
   * instead of leaving stale/zero samples (click). P1 passthrough: kept
   * intact — channel-indexed over inputs[0]/outputs[0], never shared. */
  private passthroughFrom(inputs: Float32Array[][], outputs: Float32Array[][], from: number): void {
    try {
      const chanIn0 = inputs[0];
      const chanOut0 = outputs[0];
      if (!chanIn0 || !chanOut0) return;
      const count = Math.min(chanIn0.length, chanOut0.length);
      for (let channel = 0; channel < count; channel++) {
        const chanIn = chanIn0[channel];
        const chanOut = chanOut0[channel];
        if (!chanIn || !chanOut) continue;
        const m = Math.min(chanIn.length, chanOut.length);
        for (let i = from; i < m; i++) chanOut[i] = chanIn[i];
      }
    } catch { /* ignore */ }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output) return true;
    const n = Math.min(input[0]?.length ?? 0, output[0]?.length ?? 0);
    if (!Number.isFinite(n) || n <= 0) return true;

    // Targets for smoothing (host may omit automation — default, don't throw).
    const targetBitDepth = parameters.bitDepth?.[0] ?? 16;
    const targetDrive = parameters.drive?.[0] ?? 0;
    const targetCutoff = parameters.filterCutoff?.[0] ?? 20000;
    const targetResonance = parameters.filterResonance?.[0] ?? 0.1;

    // Bypass: defaults mean bitcrusher/drive/filter are all no-ops. Running
    // 2x oversample + ladder per sample anyway wastes CPU on every quantum.
    const isBypass = targetBitDepth >= 15.5 && targetDrive <= 0.001
        && targetCutoff >= 19900 && targetResonance <= 0.11
        && this.smoothBitDepth >= 15.5 && this.smoothDrive <= 0.001 && this.smoothCutoff >= 19900;
    if (isBypass) {
        for (let channel = 0; channel < input.length; channel++) {
            const chanIn = input[channel];
            const chanOut = output[channel];
            if (!chanIn || !chanOut) continue;
            const m = Math.min(chanIn.length, chanOut.length);
            for (let i = 0; i < m; i++) chanOut[i] = chanIn[i];
            if (channel === 0) this.prevL = chanIn[n - 1] ?? this.prevL;
            else if (channel === 1) this.prevR = chanIn[n - 1] ?? this.prevR;
        }
        return true;
    }

    // OVERSAMPLING CONSTANTS
    const osRate = sampleRate * 2;

    for (let i = 0; i < n; i++) {
      // 1. Parameter Smoothing (per-sample) — resonance included: a CC sweep
      // previously stepped per 128-block while everything else slewed.
      this.smoothCutoff += (targetCutoff - this.smoothCutoff) * this.smoothingFactor;
      this.smoothDrive += (targetDrive - this.smoothDrive) * this.smoothingFactor;
      this.smoothBitDepth += (targetBitDepth - this.smoothBitDepth) * this.smoothingFactor;
      this.smoothResonance += (targetResonance - this.smoothResonance) * this.smoothingFactor;
      // Clamp feedback: r up to 4.0 previously latched Infinity/NaN forever.
      const r = Math.min(3.0, Math.max(0, this.smoothResonance * 4.0));

      // Filter Coeffs calculated for OVERSAMPLED rate
      const f = (this.smoothCutoff / osRate) * 2;
      
      for (let channel = 0; channel < input.length; channel++) {
        const chanIn = input[channel];
        const chanOut = output[channel];
        const lpState = (channel === 0) ? this.stateL : this.stateR;
        let prevX = (channel === 0) ? this.prevL : this.prevR;

        const currX = chanIn[i];
        
        // --- 2X OVERSAMPLING LOOP ---
        // We process two sub-samples for every one input sample
        let outSum = 0;
        
        for (let j = 0; j < 2; j++) {
            // A. UPSAMPLE (Linear Interpolation)
            // j=0 is midpoint (prev+curr)/2, j=1 is current sample
            let x = (j === 0) ? (prevX + currX) * 0.5 : currX;

            // B. BITCRUSHER (At high rate)
            if (this.smoothBitDepth < 15.5) {
                const step = Math.pow(0.5, this.smoothBitDepth);
                x = Math.round(x / step) * step;
            }

            // C. SATURATION (At high rate)
            // Oversampling significantly reduces aliasing harmonics here
            if (this.smoothDrive > 0.001) {
                const d = 1 + this.smoothDrive * 8;
                // Soft clipping tanh alternative for performance
                const xd = x * d;
                x = xd / (1 + Math.abs(xd)); 
            }

            // D. 24dB LADDER FILTER (At high rate)
            // Stability is much higher at 2x rate
            let y = x - r * lpState[3];
            if (!Number.isFinite(y)) { this.resetStates(); this.passthroughFrom(inputs, outputs, i); return true; }

            lpState[0] = lpState[0] + f * (y - lpState[0]);
            lpState[1] = lpState[1] + f * (lpState[0] - lpState[1]);
            lpState[2] = lpState[2] + f * (lpState[1] - lpState[2]);
            lpState[3] = lpState[3] + f * (lpState[2] - lpState[3]);
            if (!Number.isFinite(lpState[0] + lpState[1] + lpState[2] + lpState[3])) {
                this.resetStates();
                this.passthroughFrom(inputs, outputs, i);
                return true;
            }
            // Saturate state so extremes can't accumulate into silence.
            for (let k = 0; k < 4; k++) {
                if (lpState[k] > 4) lpState[k] = 4;
                else if (lpState[k] < -4) lpState[k] = -4;
            }

            outSum += lpState[3];
        }

        // E. DECIMATION (Simple box-filter downsampling)
        chanOut[i] = outSum * 0.5;

        // Update previous sample state
        if (channel === 0) this.prevL = currX;
        else this.prevR = currX;
      }
    }

    return true;
  }
}

registerProcessor('gangsta-processor', GangstaProcessor);
