/**
 * Gangsta AudioWorklet Processor - Master Guru Edition
 * Features: 
 * - 2x Oversampling (Linear Upsampling / Decimation)
 * - Anti-Aliasing DSP Chain
 * - Stereo isolation & Parameter smoothing
 * - Hardened Moog-Ladder DSP (Stability-Enhanced)
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processorClass: any): void;

// Define a minimal interface for the class to satisfy the compiler
interface AudioWorkletProcessorInstance {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, any>): boolean;
}

const GBaseProcessor = (globalThis as any).AudioWorkletProcessor as {
    new(): AudioWorkletProcessorInstance;
};

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
  private smoothingFactor = 0.05; 

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // Targets for smoothing
    const targetBitDepth = parameters.bitDepth[0];
    const targetDrive = parameters.drive[0];
    const targetCutoff = parameters.filterCutoff[0];
    const resonance = parameters.filterResonance[0];

    // OVERSAMPLING CONSTANTS
    const osRate = sampleRate * 2;
    const r = resonance * 4.0;

    for (let i = 0; i < 128; i++) {
      // 1. Parameter Smoothing (per-sample)
      this.smoothCutoff += (targetCutoff - this.smoothCutoff) * this.smoothingFactor;
      this.smoothDrive += (targetDrive - this.smoothDrive) * this.smoothingFactor;
      this.smoothBitDepth += (targetBitDepth - this.smoothBitDepth) * this.smoothingFactor;

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
            
            lpState[0] = lpState[0] + f * (y - lpState[0]);
            lpState[1] = lpState[1] + f * (lpState[0] - lpState[1]);
            lpState[2] = lpState[2] + f * (lpState[1] - lpState[2]);
            lpState[3] = lpState[3] + f * (lpState[2] - lpState[3]);

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
