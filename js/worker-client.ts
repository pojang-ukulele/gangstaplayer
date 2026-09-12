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

function workerUrlCandidates(): string[] {
    // file:// + asar: document.baseURI in a packaged Electron renderer is a
    // file:// URL inside app.asar where `new Worker()` cannot load scripts
    // left packed. The build unpacks js/workers (asarUnpack) so the resolved
    // file URL loads; dev uses the http/baseURI URL. Try every candidate in
    // order — spawnWorker fails loud (WORKER_UNAVAILABLE) when all miss.
    const out: string[] = [];
    try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : undefined;
        if (base) {
            try { out.push(new URL('js/workers/audio-worker.js', base).toString()); } catch { /* next */ }
        }
    } catch { /* fall through */ }
    out.push('js/workers/audio-worker.js');
    return [...new Set(out)];
}

function workerUrl(): string {
    return workerUrlCandidates()[0] || 'js/workers/audio-worker.js';
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
    const candidates = workerUrlCandidates();
    let lastErr: unknown = null;
    let w: Worker | null = null;
    for (const url of candidates) {
        try {
            w = new Worker(url);
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (!w) {
        noteSpawnFailure();
        throw new Error(`WORKER_UNAVAILABLE: audio worker failed to spawn (${candidates.join(', ')}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }

    w!.onmessage = (e: MessageEvent) => {
        // A healthy response resets the crash counter.
        spawnFailCount = 0;
        const { type, bpm, confidence, blob, id } = e.data || {};
        // Id-less replies are dropped without leaking: no pending entry is
        // touched, nothing is resolved or rejected.
        if (id === undefined || id === null) return;
        const request = pendingRequests.get(id);
        if (!request) return;
        pendingRequests.delete(id);
        if (type === 'BPM_RESULT' && request.kind === 'BPM') {
            request.resolve(typeof bpm === 'number' ? { bpm, confidence: typeof confidence === 'string' ? confidence : 'none' } : { bpm: 0, confidence: 'none' });
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
        // Null the worker: a deserializing worker is untrustworthy for queued
        // jobs — the next call spawns fresh instead of timing out one by one.
        if (worker === w) {
            try { w!.terminate(); } catch { /* ignore */ }
            worker = null;
        }
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
        // Fail loud (not a silent cooldown): callers surface this to toast/log
        // instead of hanging until a timeout.
        throw new Error('WORKER_UNAVAILABLE: audio worker cooling down after repeated crashes');
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

export type BpmConfidence = 'high' | 'medium' | 'low' | 'none';
export interface BpmAnalysis {
    /** BPM value, or null when the analysis needs review (low-confidence/-1). Never 0-as-analyzed. */
    bpm: number | null;
    confidence: BpmConfidence;
    /** True when callers must retry/other-means and must NOT cache as analyzed 0. */
    needsReview: boolean;
}

/**
 * Detect BPM with a confidence flag (mono fast path: channel-0, 90s cap).
 * Low-confidence and -1 results resolve to { bpm: null, needsReview: true }
 * so callers retry instead of caching a bogus analyzed 0. Octave-fold limits:
 * the worker corrects one 2x octave error into 60-180 (usable 30-210);
 * triplets and <30/>210 extremes are needs-review by design.
 */
export function detectBPMWithConfidence(audioBuffer: AudioBuffer, options?: { threshold?: number; minStepSeconds?: number }): Promise<BpmAnalysis> {
    if (!isAudioBufferLike(audioBuffer)) return Promise.reject(new Error('Invalid AudioBuffer'));
    // Cap analysis to the first ~90s mono — full-length DJ mixes previously
    // copied ~600MB into the worker and always timed out.
    const sr = audioBuffer.sampleRate;
    if (!Number.isFinite(sr) || sr < 3000 || sr > 192000) {
        return Promise.reject(new Error('Invalid sample rate'));
    }
    // Copy before transfer: getChannelData returns a live view into the
    // AudioBuffer — transferring it would neuter the caller's buffer for
    // later decode/play. This transient copy is the safe price.
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
    }), [data.buffer]).then((res: { bpm?: number; confidence?: BpmConfidence }) => {
        const bpm = typeof res?.bpm === 'number' ? res.bpm : 0;
        const confidence: BpmConfidence = res?.confidence === 'high' || res?.confidence === 'medium' || res?.confidence === 'low' ? res.confidence : 'none';
        if (bpm <= 0 || confidence === 'low' || confidence === 'none') {
            return { bpm: null, confidence, needsReview: true };
        }
        return { bpm, confidence, needsReview: false };
    });
}

/**
 * Legacy BPM entry (kept for existing deck/playlist callers): resolves a
 * number, 0 when analysis needs review. New code should prefer
 * detectBPMWithConfidence() and skip caching needs-review results.
 */
export function detectBPMWorker(audioBuffer: AudioBuffer, options?: { threshold?: number; minStepSeconds?: number }): Promise<number> {
    return detectBPMWithConfidence(audioBuffer, options).then((r) => (r.needsReview || r.bpm === null ? 0 : r.bpm));
}

export interface BpmPersistDecision {
    /** BPM to store: the fresh value when usable, otherwise the prior value. */
    bpm: number | undefined;
    /** True when the fresh analysis was usable and should be cached. */
    persisted: boolean;
    /** True when the fresh analysis needs review and must NOT be cached. */
    needsReview: boolean;
}

/**
 * Skip-persist policy for BPM results (single source of truth for all
 * deck/playlist/pad callers): a low-confidence / -1 / null / 0 fresh result
 * resolves to the PRIOR value with persisted:false so a bogus analyzed 0
 * never clobbers a good cached BPM in DB or state. Accepts the legacy
 * number shape too (<=0 counts as needs-review).
 */
export function resolveBpmPersist(
    fresh: BpmAnalysis | number | null | undefined,
    priorBpm?: number | null
): BpmPersistDecision {
    const prior = typeof priorBpm === 'number' && Number.isFinite(priorBpm) && priorBpm > 0
        ? priorBpm
        : undefined;
    let bpm: number | null = null;
    if (typeof fresh === 'number') {
        if (Number.isFinite(fresh) && fresh > 0) bpm = fresh;
    } else if (fresh && typeof fresh === 'object') {
        if (!fresh.needsReview && typeof fresh.bpm === 'number' && Number.isFinite(fresh.bpm) && fresh.bpm > 0) {
            bpm = fresh.bpm;
        }
    }
    if (bpm !== null) return { bpm, persisted: true, needsReview: false };
    return { bpm: prior, persisted: false, needsReview: true };
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
        // Already in transfer format (from recorder optimization) — copy
        // before transfer so the caller's Float32Arrays survive (transfer
        // neuters the sent buffer; sending the caller's view would blank
        // their live recording data).
        const channels: Float32Array[] = [];
        for (const ch of audioBuffer.channels) {
            if (!ch || ch.length === 0) {
                return Promise.reject(new Error('Encode buffer empty or already transferred'));
            }
            const copy = new Float32Array(ch.subarray(0, Math.min(ch.length, safeLen)));
            channels.push(copy);
            transferables.push(copy.buffer);
        }
        bufferPayload = {
            numberOfChannels: audioBuffer.numberOfChannels,
            sampleRate: audioBuffer.sampleRate,
            channels
        };
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
