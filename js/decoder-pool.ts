/**
 * Dedicated Decoder Worker Pool
 * Manages a set of worker threads for parallel audio decoding.
 */

interface DecodeResult {
    numberOfChannels: number;
    sampleRate: number;
    length: number;
    duration: number;
    channels: Float32Array[];
}

class DecoderWorkerInstance {
    private worker: Worker;
    private busy = false;
    private currentRequestId: number | null = null;
    private resolve: ((value: DecodeResult) => void) | null = null;
    private reject: ((reason: any) => void) | null = null;

    constructor(scriptPath: string) {
        this.worker = new Worker(scriptPath);
        this.worker.onmessage = (e) => this.handleMessage(e);
    }

    public isBusy(): boolean {
        return this.busy;
    }

    public decode(id: number, arrayBuffer: ArrayBuffer): Promise<DecodeResult> {
        this.busy = true;
        this.currentRequestId = id;
        
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            this.worker.postMessage({ id, arrayBuffer }, [arrayBuffer]);
        });
    }

    private handleMessage(e: MessageEvent) {
        const { id, type, payload, error } = e.data;
        if (id !== this.currentRequestId) return;

        if (type === 'DECODE_SUCCESS' && this.resolve) {
            this.resolve(payload);
        } else if (type === 'DECODE_ERROR' && this.reject) {
            this.reject(new Error(error));
        }

        this.busy = false;
        this.currentRequestId = null;
        this.resolve = null;
        this.reject = null;
        
        // Trigger pool to check for queued tasks
        decoderPool.processQueue();
    }
}

class DecoderPool {
    private poolSize = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 6));
    private workers: DecoderWorkerInstance[] = [];
    private queue: { id: number; arrayBuffer: ArrayBuffer; resolve: any; reject: any }[] = [];
    private requestIdCounter = 0;

    constructor() {
        for (let i = 0; i < this.poolSize; i++) {
            this.workers.push(new DecoderWorkerInstance('js/workers/decoder-worker.js'));
        }
    }

    public decode(arrayBuffer: ArrayBuffer): Promise<DecodeResult> {
        const id = this.requestIdCounter++;
        return new Promise((resolve, reject) => {
            this.queue.push({ id, arrayBuffer, resolve, reject });
            this.processQueue();
        });
    }

    public processQueue() {
        if (this.queue.length === 0) return;

        const idleWorker = this.workers.find(w => !w.isBusy());
        if (!idleWorker) return;

        const task = this.queue.shift();
        if (task) {
            idleWorker.decode(task.id, task.arrayBuffer)
                .then(task.resolve)
                .catch(task.reject);
        }
    }
}

export const decoderPool = new DecoderPool();
