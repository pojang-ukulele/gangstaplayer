/**
 * High-Fidelity AudioWorklet Recorder Processor
 * Captures raw PCM data directly from the audio thread.
 */

// Inform TS about the processor globals without redeclaring them
declare function registerProcessor(name: string, processorClass: any): void;

// Define a minimal interface for the class to satisfy the compiler
interface AudioWorkletProcessorInstance {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, any>): boolean;
}

// We use an any cast for the base class since it's provided by the environment
const BaseProcessor = (globalThis as any).AudioWorkletProcessor as {
    new(): AudioWorkletProcessorInstance;
};

class RecorderProcessor extends BaseProcessor {
  private isRecording = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'START') {
        this.isRecording = true;
      } else if (event.data.type === 'STOP') {
        this.isRecording = false;
        // Acknowledge so the client knows all DATA blocks are flushed.
        // Without this, stop() compiled WAV while final blocks were in flight
        // and the recording tail got truncated.
        this.port.postMessage({ type: 'STOPPED' });
      }
    };
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, any>) {
    if (!this.isRecording) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;
    
    // Standard block size is 128
    const channels = input.map(ch => new Float32Array(ch));
    
    this.port.postMessage({
      type: 'DATA',
      payload: channels
    }, channels.map(ch => ch.buffer));

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
