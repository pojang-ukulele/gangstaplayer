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
  // Batch 8 quanta per message: ~300 msg/s previously flooded the main thread.
  private batch: Float32Array[][] = [];
  private readonly BATCH_SIZE = 8;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'START') {
        this.isRecording = true;
        this.batch = [];
      } else if (event.data.type === 'STOP') {
        this.isRecording = false;
        this.flush();
        // Acknowledge so the client knows all DATA blocks are flushed.
        // Without this, stop() compiled WAV while final blocks were in flight
        // and the recording tail got truncated.
        this.port.postMessage({ type: 'STOPPED' });
      }
    };
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    const flat: Float32Array[][] = this.batch;
    this.batch = [];
    // Flatten batch into per-channel contiguous arrays. Channel count comes
    // from the first well-formed block — a malformed leading block previously
    // threw away the valid tail.
    const first = flat.find(b => Array.isArray(b) && b.length > 0);
    if (!first) return;
    const numCh = first.length;
    const perChannel: Float32Array[][] = [];
    for (let c = 0; c < numCh; c++) {
      let total = 0;
      for (const block of flat) total += block[c]?.length ?? 0;
      const merged = new Float32Array(total);
      let off = 0;
      for (const block of flat) {
        const src = block[c];
        if (src && src.length) { merged.set(src, off); off += src.length; }
      }
      perChannel.push([merged] as unknown as Float32Array[]);
    }
    // Send as one message per channel-group to cut postMessage rate 8x.
    const payload = perChannel.map(g => g[0]);
    this.port.postMessage({ type: 'DATA', payload }, payload.map(ch => ch.buffer));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, any>) {
    // Passthrough first: the client holds node→zeroGain→destination so the
    // worklet never runs sink-less (suspended worklets capture nothing).
    // Muted downstream — capture behavior is unchanged.
    try {
      const src = inputs[0];
      const dst = outputs[0];
      if (src && dst) {
        const m = Math.min(src.length, dst.length);
        for (let c = 0; c < m; c++) {
          const s = src[c];
          const d = dst[c];
          if (s && d) d.set(s.subarray(0, Math.min(s.length, d.length)));
        }
      }
    } catch { /* capture path below still runs */ }
    if (!this.isRecording) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Standard block size is 128
    const channels = input.map(ch => new Float32Array(ch));
    // Zero-length blocks carry no samples — skip so they can't poison the
    // channel-count scan or produce empty DATA payloads downstream.
    if (channels.every(c => c.length === 0)) return true;

    this.batch.push(channels);
    if (this.batch.length >= this.BATCH_SIZE) this.flush();

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
