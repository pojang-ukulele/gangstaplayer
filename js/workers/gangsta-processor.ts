/**
 * Gangsta AudioWorklet Processor - Hardened Edition
 * Features: Stereo isolation, Parameter smoothing, and Moog-Ladder DSP.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processorClass: any): void;

abstract class AudioWorkletProcessor {
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

class GangstaProcessor extends AudioWorkletProcessor {
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
  
  // Smoothing values
  private smoothCutoff = 20000;
  private smoothDrive = 0;
  private smoothBitDepth = 16;
  private smoothingFactor = 0.05; // Adjust for responsiveness vs "zipper noise"

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // Targets for smoothing
    const targetBitDepth = parameters.bitDepth[0];
    const targetDrive = parameters.drive[0];
    const targetCutoff = parameters.filterCutoff[0];
    const resonance = parameters.filterResonance[0];

    for (let i = 0; i < 128; i++) { // Worklets process in blocks of 128
      // 1. Parameter Smoothing (per-sample)
      this.smoothCutoff += (targetCutoff - this.smoothCutoff) * this.smoothingFactor;
      this.smoothDrive += (targetDrive - this.smoothDrive) * this.smoothingFactor;
      this.smoothBitDepth += (targetBitDepth - this.smoothBitDepth) * this.smoothingFactor;

      // Filter Coeffs (Recalculate with smoothed values)
      const f = (this.smoothCutoff / sampleRate) * 2;
      const p = f * (1.8 - 0.8 * f);
      const r = resonance * 4.0; // Resonance boost

      for (let channel = 0; channel < input.length; channel++) {
        const chanIn = input[channel];
        const chanOut = output[channel];
        const lpState = channel === 0 ? this.stateL : this.stateR;

        let x = chanIn[i];

        // --- STAGE 1: BITCRUSHER ---
        if (this.smoothBitDepth < 15.5) {
          const step = Math.pow(0.5, this.smoothBitDepth);
          x = Math.round(x / step) * step;
        }

        // --- STAGE 2: SATURATION ---
        if (this.smoothDrive > 0.01) {
          const d = 1 + this.smoothDrive * 8;
          x = Math.tanh(x * d) / Math.tanh(d);
        }

        // --- STAGE 3: 24dB LADDER FILTER ---
        // Simplified Moog-style with feedback
        let y = x - r * lpState[3];
        
        lpState[0] = lpState[0] + f * (y - lpState[0]);
        lpState[1] = lpState[1] + f * (lpState[0] - lpState[1]);
        lpState[2] = lpState[2] + f * (lpState[1] - lpState[2]);
        lpState[3] = lpState[3] + f * (lpState[2] - lpState[3]);

        chanOut[i] = lpState[3];
      }
    }

    return true;
  }
}

registerProcessor('gangsta-processor', GangstaProcessor);
