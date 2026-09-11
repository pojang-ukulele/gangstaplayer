/**
 * Client for communicating with the Audio Processing Worker.
 *
 * The worker is lazily recreatable: if it dies (script error, OOM), pending
 * requests are rejected with typed errors and the next call spawns a fresh
 * worker. Previously a single crash left every future request hanging forever
 * because postMessage into a dead worker silently disappears.
 */

import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants';

type RequestKind = 'BPM' | 'WAVE';

interface PendingRequest {
    kind: RequestKind;
    resolve: (value: any) => void;
    reject: (err: Error) => void;
}

function workerUrl(): string {
    try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : undefined;
        if (base) return new URL('js/workers/audio-worker.js', base).toString();
    } catch { /* fall through */ }
    return 'js/workers/audio-worker.js';
}

let worker: Worker | null = null;
const pendingRequests = new Map<number, PendingRequest>();
let requestId = 0;
let consecutiveTimeouts = 0;
const MAX_CONSECUTIVE_TIMEOUTS = 2;
// Spawn backoff: a missing/broken worker script previously caused an infinite
// spawn/fail loop, each queued request waiting out its full 30s timeout.
let spawnFailCount = 0;
let spawnCoolUntil = 0;
const SPAWN_COOLDOWN_MS = 60000;
function noteSpawnFailure(): void {
    spawnFailCount++;
    if (spawnFailCount >= 3) {
        spawnCoolUntil = Date.now() + SPAWN_COOLDOWN_MS;
        spawnFailCount = 0;
    }
}

function spawnWorker(): Worker {
    // Resolve lazily (not at import time) so packaged file:// baseURIs and
    // late <base> changes don't freeze a broken URL forever.
    const url = workerUrl();
    let w: Worker;
    try {
        w = new Worker(url);
    } catch (e) {
        if (url !== 'js/workers/audio-worker.js') {
            try {
                w = new Worker('js/workers/audio-worker.js');
            } catch (e2) {
                noteSpawnFailure();
                throw e2;
            }
        } else {
            noteSpawnFailure();
            throw e;
        }
    }

    w!.onmessage = (e: MessageEvent) => {
        // A healthy response resets the crash counter.
        spawnFailCount = 0;
        const { type, bpm, blob, id } = e.data || {};
        const request = pendingRequests.get(id);
        if (!request) return;
        pendingRequests.delete(id);
        if (type === 'BPM_RESULT' && request.kind === 'BPM') {
            request.resolve(typeof bpm === 'number' ? bpm : 0);
        } else if (type === 'WAVE_RESULT' && request.kind === 'WAVE') {
            request.resolve(blob);
        } else {
            request.reject(new Error(`Worker returned unexpected response (type=${type})`));
        }
    };

    w!.onerror = (err) => {
        console.error('[WorkerClient] Audio worker error:', err.message, err.filename, err.lineno);
        noteSpawnFailure();
        failAllPending(new Error(`Audio worker crashed: ${err.message || 'unknown error'}`));
        // Mark dead so the next request spawns a fresh worker instead of
        // posting into a corpse and waiting forever.
        if (worker === w) worker = null;
    };

    w!.onmessageerror = (err) => {
        console.error('[WorkerClient] Audio worker message error:', err);
        // Structured-clone failure (e.g. neutered buffer) is known instantly —
        // previously pending ids hung until the 30s timeout despite that.
        failAllPending(new Error('Audio worker message error: response could not be deserialized'));
    };

    return w!;
}

function failAllPending(err: Error): void {
    for (const [id, request] of Array.from(pendingRequests)) {
        pendingRequests.delete(id);
        try {
            request.reject(err);
        } catch { /* listener error */ }
    }
}

function getWorker(): Worker {
    if (Date.now() < spawnCoolUntil) {
        throw new Error('Audio worker cooling down after repeated crashes');
    }
    if (!worker) {
        console.warn('[WorkerClient] Spawning audio worker');
        worker = spawnWorker();
    }
    return worker;
}

function post(kind: RequestKind, buildMessage: (id: number) => { type: string; payload: any }, transfer: Transferable[], timeoutMs = 30000): Promise<any> {
    do {
        requestId = (requestId + 1) % 1000000000;
    } while (pendingRequests.has(requestId));
    const id = requestId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                consecutiveTimeouts++;
                // Hung worker: terminate AND fail every other queued request —
                // previously only the timed-out call rejected while the rest
                // waited on a dead worker until their own 30s timeout.
                if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && worker) {
                    try { worker.terminate(); } catch { /* ignore */ }
                    worker = null;
                    consecutiveTimeouts = 0;
                    failAllPending(new Error('Audio worker terminated after repeated timeouts'));
                }
                reject(new Error(`Audio worker timed out (${kind})`));
            }
        }, timeoutMs);
        const wrappedResolve = (v: any) => { clearTimeout(timer); consecutiveTimeouts = 0; resolve(v); };
        const wrappedReject = (e: Error) => { clearTimeout(timer); reject(e); };
        pendingRequests.set(id, { kind, resolve: wrappedResolve, reject: wrappedReject });
        try {
            const message = buildMessage(id);
            getWorker().postMessage({ ...message, id }, transfer);
        } catch (e: any) {
            clearTimeout(timer);
            pendingRequests.delete(id);
            reject(new Error(`Failed to post to audio worker: ${e?.message || e}`));
        }
    });
}

/**
 * Detect BPM of an audio buffer using a worker.
 * Rejects (never hangs) if the worker is unavailable or crashes.
 */
function isAudioBufferLike(v: unknown): v is AudioBuffer {
    return !!v && typeof (v as AudioBuffer).getChannelData === 'function'
        && typeof (v as AudioBuffer).sampleRate === 'number'
        && typeof (v as AudioBuffer).numberOfChannels === 'number';
}

export function detectBPMWorker(audioBuffer: AudioBuffer, options?: { threshold?: number; minStepSeconds?: number }): Promise<number> {
    if (!isAudioBufferLike(audioBuffer)) return Promise.reject(new Error('Invalid AudioBuffer'));
    // Cap analysis to the first ~90s mono — full-length DJ mixes previously
    // copied ~600MB into the worker and always timed out.
    const sr = audioBuffer.sampleRate;
    if (!Number.isFinite(sr) || sr < 3000 || sr > 192000) {
        return Promise.reject(new Error('Invalid sample rate'));
    }
    const full = audioBuffer.getChannelData(0);
    const maxLen = Math.min(full.length, Math.floor(sr * 90));
    const data = new Float32Array(full.subarray(0, maxLen));
    // Clamp analyst params: minStepSeconds <= 0 previously reached the worker
    // as minStep=0 and hung it in an i+=0 infinite loop (H13).
    const threshold = options?.threshold;
    const minStep = options?.minStepSeconds;
    return post('BPM', (id) => ({
        type: 'DETECT_BPM',
        payload: {
            data,
            sampleRate: sr,
            threshold: typeof threshold === 'number' && threshold > 0 && threshold <= 1 ? threshold : BPM_DETECTION_THRESHOLD,
            minStepSeconds: typeof minStep === 'number' && minStep > 0 && minStep <= 5 ? minStep : BPM_MIN_STEP_SECONDS
        },
        id
    }), [data.buffer]).then((bpm) => typeof bpm === 'number' && bpm > 0 ? bpm : 0);
}
/**
 * Convert an AudioBuffer (or pre-built channel object) to a WAV Blob using a worker.
 */
export function bufferToWaveWorker(audioBuffer: AudioBuffer | { numberOfChannels: number; sampleRate: number; channels: Float32Array[] }, len: number): Promise<Blob> {
    const safeLen = Math.floor(Number(len));
    if (!Number.isInteger(safeLen) || safeLen <= 0 || safeLen > 268435456) {
        return Promise.reject(new Error('Invalid encode length'));
    }
    let bufferPayload: { numberOfChannels: number; sampleRate: number; channels: Float32Array[] };
    const transferables: ArrayBufferLike[] = [];

    if (isAudioBufferLike(audioBuffer)) {
        // Copy only what gets encoded (C12): the old full-channel copy moved
        // ~400MB for a 100MB stereo file even when len was smaller.
        const channels: Float32Array[] = [];
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            const src = audioBuffer.getChannelData(i);
            const data = new Float32Array(src.subarray(0, Math.min(src.length, safeLen)));
            channels.push(data);
            transferables.push(data.buffer);
        }
        bufferPayload = {
            numberOfChannels: audioBuffer.numberOfChannels,
            sampleRate: audioBuffer.sampleRate,
            channels
        };
    } else {
        // Already in transfer format (from recorder optimization)
        bufferPayload = audioBuffer;
        for (const ch of audioBuffer.channels) {
            transferables.push(ch.buffer);
        }
    }
    // Neutered (already-transferred) inputs decode to 0-length and fail
    // inside the worker as 'Invalid length' (C12) — fail here with a cause.
    for (const ch of bufferPayload.channels) {
        if (!ch || ch.length === 0) {
            return Promise.reject(new Error('Encode buffer empty or already transferred'));
        }
    }

    // Length-scaled timeout: a flat 30s previously killed legit long takes
    // on slow CPUs (then a second timeout terminated the worker, killing
    // other queued jobs). Encode cost scales with samples — ~5M samples/sec
    // is conservative; capped at 120s so a dead worker still fails fast.
    const encodeTimeoutMs = Math.min(120000, 30000 + Math.ceil(safeLen / 5000000) * 1000);
    return post('WAVE', (id) => ({
        type: 'BUFFER_TO_WAVE',
        payload: { buffer: bufferPayload, len: safeLen },
        id
    }), transferables as Transferable[], encodeTimeoutMs).then((blob) => {
        if (!(blob instanceof Blob)) {
            throw new Error('Worker did not return a WAV blob');
        }
        return blob;
    });
}
