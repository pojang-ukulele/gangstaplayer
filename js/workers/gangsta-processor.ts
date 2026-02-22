/**
 * Gangsta AudioWorklet Processor
 * High-performance, low-latency DSP for real-time grit and character.
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

  private lowPassState = [0, 0, 0, 0]; // 4 stages for 24dB/oct

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];

    // Get parameter values (taking first value of the block for efficiency)
    const bitDepth = parameters.bitDepth[0];
    const drive = parameters.drive[0];
    const cutoff = parameters.filterCutoff[0];
    const resonance = parameters.filterResonance[0];

    // Pre-calculate filter coefficients (Simplified Moog-style)
    const f = (cutoff / sampleRate) * 2;
    const p = f * (1.8 - 0.8 * f);
    const k = p + p - 1.0;
    const t = (1.0 - p) * 1.386249;
    const t2 = 12.0 + t * t;
    const r = resonance * (t2 + 6.0 * t) / (t2 - 6.0 * t);

    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];

      for (let i = 0; i < inputChannel.length; i++) {
        let x = inputChannel[i];

        // 1. Bitcrusher
        if (bitDepth < 16) {
          const step = Math.pow(0.5, bitDepth);
          x = Math.round(x / step) * step;
        }

        // 2. Saturation (Soft Clipping)
        if (drive > 0) {
          const d = 1 + drive * 5;
          x = Math.tanh(x * d) / Math.tanh(d);
        }

        // 3. 24dB Moog-ish Filter
        // Note: For true stability and resonance, this needs a refined feedback loop
        // This is a simplified version for performance
        let y = x - r * this.lowPassState[3];
        
        // 4 cascaded 1st order sections
        this.lowPassState[0] = this.lowPassState[0] + f * (y - this.lowPassState[0]);
        this.lowPassState[1] = this.lowPassState[1] + f * (this.lowPassState[0] - this.lowPassState[1]);
        this.lowPassState[2] = this.lowPassState[2] + f * (this.lowPassState[1] - this.lowPassState[2]);
        this.lowPassState[3] = this.lowPassState[3] + f * (this.lowPassState[2] - this.lowPassState[3]);

        outputChannel[i] = this.lowPassState[3];
      }
    }

    return true;
  }
}

registerProcessor('gangsta-processor', GangstaProcessor);
