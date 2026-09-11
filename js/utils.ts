/**
 * Shared utility functions
 */
import { MAX_FILE_SIZE_BYTES } from './constants';

/**
 * Normalize IPC buffer data to a clean ArrayBuffer.
 * IPC can return ArrayBuffer, typed arrays (Uint8Array), or Node.js Buffer.
 * This robustly converts any variant to a standalone ArrayBuffer.
 *
 * Uses toString() cross-realm check instead of instanceof to avoid
 * failures when ts-jest/bundler creates isolated realm references.
 */
function isArrayBuffer(value: any): boolean {
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isSharedArrayBuffer(value: any): boolean {
    return Object.prototype.toString.call(value) === '[object SharedArrayBuffer]';
}

export function normalizeToArrayBuffer(data: any): ArrayBuffer {
    // Always-copy contract (enforced by tests): callers rely on a fresh
    // exclusive buffer because decodeAudioData detaches its input. Zero-copy
    // was evaluated and rejected — pooled IPC allocations (byteOffset !== 0)
    // and detach aliasing make the 1x transient copy the safe price.
    if (isArrayBuffer(data)) {
        return data.slice(0);
    }
    // SharedArrayBuffer cannot be passed to decodeAudioData — copy it.
    if (isSharedArrayBuffer(data)) {
        const view = new Uint8Array(data);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        return copy.buffer;
    }
    // Fast path: TypedArray (Uint8Array, Buffer, etc.) or has .buffer (e.g. DataView)
    if (data && typeof data === 'object') {
        // Node.js Buffer extends Uint8Array — check its buffer property
        if (data.buffer && isArrayBuffer(data.buffer)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        // If it's array-like but not a TypedArray, try to convert efficiently.
        // Bound: crafted {length: 1e9} objects previously allocated blindly.
        if (typeof data.length === 'number' && data.length > 0) {
            if (!Number.isInteger(data.length) || data.length > MAX_FILE_SIZE_BYTES) {
                throw new Error('normalizeToArrayBuffer: array-like length out of bounds');
            }
            const bytes = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                bytes[i] = data[i];
            }
            return bytes.buffer;
        }
    }
    // Unrecognized format — throw instead of silently producing garbage
    throw new Error(
        `normalizeToArrayBuffer: Unsupported data type (${typeof data}, ` +
        `${data?.constructor?.name ?? 'unknown'}). Expected ArrayBuffer or TypedArray.`
    );
}

// ==================== AUDIO FILE VALIDATION ====================
// Magic number signatures for common audio formats

const AUDIO_SIGNATURES: Record<string, { offset: number; bytes: number[] }> = {
    // WAV: "RIFF" at offset 0 + "WAVE" at offset 8
    'wav':  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
    // MP3 frame syncs — MPEG1 Layer3 (0xFB), MPEG2/2.5 variants (0xF3, 0xF2, 0xFA).
    // Previously only 0xFF 0xFB was checked and many valid MP3s were rejected.
    'mp3':   { offset: 0, bytes: [0xFF, 0xFB] },
    'mp3b':  { offset: 0, bytes: [0xFF, 0xF3] },
    'mp3c':  { offset: 0, bytes: [0xFF, 0xF2] },
    'mp3d':  { offset: 0, bytes: [0xFF, 0xFA] },
    'mp3v2': { offset: 0, bytes: [0x49, 0x44, 0x33] }, // "ID3" (tagged)
    // OGG: "OggS" at offset 0
    'ogg':  { offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53] }, // "OggS"
    // FLAC: "fLaC" at offset 0
    'flac': { offset: 0, bytes: [0x66, 0x4C, 0x61, 0x43] }, // "fLaC"
    // M4A/AAC: "ftyp" brand box at offset 4
    'm4a':  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // "ftyp"
    // WebM/Matroska: EBML header
    'webm': { offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] },
    // WAV (secondary): verify "WAVE" at offset 8 for RIFF files
    'wave': { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }, // "WAVE"
    // Big-endian WAV (RIFX) + RF64 (recordings >4GB) + AIFF (L6 gaps).
    'rifx': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x58] }, // "RIFX"
    'rf64': { offset: 0, bytes: [0x52, 0x46, 0x36, 0x34] }, // "RF64"
    'aiff': { offset: 0, bytes: [0x46, 0x4F, 0x52, 0x4D] }, // "FORM"
    'aiffBody': { offset: 8, bytes: [0x41, 0x49, 0x46, 0x46] }, // "AIFF"
};

/**
 * Validates that a file buffer contains an actual audio file by checking
 * magic number signatures. Prevents loading of non-audio files as audio.
 *
 * Returns null on success (valid audio), or an error message string on failure.
 */
export function validateAudioSignature(
    buffer: ArrayBuffer, 
    fileName?: string
): string | null {
    if (!buffer || buffer.byteLength < 4) {
        return 'File is too small to be a valid audio file';
    }

    const view = new DataView(buffer);
    // MP3 frame sync is 11 bits (0xFF + top-3-bits) AND valid layer bits
    // (L6): bare 0xFF Ex accepted JPEG APP markers (E0-EF) as MP3. Layer
    // 00 is reserved in MPEG — real frames always have nonzero layer bits.
    if (buffer.byteLength >= 2 && view.getUint8(0) === 0xFF) {
        const b1 = view.getUint8(1);
        if ((b1 & 0xE0) === 0xE0 && (b1 & 0x06) !== 0x00) return null;
    }
    const matches: string[] = [];

    // Check each known audio signature
    for (const [sigName, { offset, bytes }] of Object.entries(AUDIO_SIGNATURES)) {
        if (buffer.byteLength < offset + bytes.length) continue;

        let matchesSig = true;
        for (let i = 0; i < bytes.length; i++) {
            if (view.getUint8(offset + i) !== bytes[i]) {
                matchesSig = false;
                break;
            }
        }
        if (matchesSig) matches.push(sigName);
    }

    // RIFF/WAV requires both "RIFF" AND "WAVE" signatures
    const hasRiff = matches.includes('wav');
    const hasWave = matches.includes('wave');
    const isRealWav = hasRiff && hasWave;
    // RIFX/RF64 need the WAVE/ds64 body; AIFF needs FORM+AIFF (L6).
    const isRifxWav = matches.includes('rifx') && hasWave;
    const isRf64 = matches.includes('rf64');
    const isAiff = matches.includes('aiff') && matches.includes('aiffBody');
    const hasId3 = matches.includes('mp3v2');
    // ID3-wrapped audio (L6): strict offset-0 checks rejected tagged files.
    // Look past a valid ID3v2 tag for the real stream magic. A bare ID3 tag
    // alone previously passed (junk with an ID3 header wasted a worker copy +
    // decode) — so require inner evidence: scan a window past the tag end for
    // stream magic or an MPEG frame sync (padding between tag and frames is
    // real, but bounded; 8KB is generous).
    let id3InnerAudio = false;
    if (hasId3) {
        if (buffer.byteLength < 10) return `File does not contain recognized audio data${fileName ? ` (file: ${fileName})` : ''}`;
        const tagSize = ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14) | ((view.getUint8(8) & 0x7f) << 7) | (view.getUint8(9) & 0x7f);
        if (tagSize <= 0 || 10 + tagSize >= buffer.byteLength) return `File does not contain recognized audio data${fileName ? ` (file: ${fileName})` : ''}`;
        const inner = 10 + tagSize;
        const scanEnd = Math.min(buffer.byteLength - 4, inner + 8192);
        for (let p = inner; p <= scanEnd; p++) {
            const tag = String.fromCharCode(
                view.getUint8(p), view.getUint8(p + 1),
                view.getUint8(p + 2), view.getUint8(p + 3));
            if (tag === 'fLaC' || tag === 'OggS' || tag === 'RIFF' || tag === 'FORM') { id3InnerAudio = true; break; }
            if (view.getUint8(p) === 0xFF && p + 1 < buffer.byteLength) {
                const b1 = view.getUint8(p + 1);
                if ((b1 & 0xE0) === 0xE0 && (b1 & 0x06) !== 0x00) { id3InnerAudio = true; break; }
            }
        }
        if (!id3InnerAudio) return `File does not contain recognized audio data${fileName ? ` (file: ${fileName})` : ''}`;
    }
    const hasAudioSignature = isRealWav ||
        isRifxWav || isRf64 || isAiff ||
        matches.includes('mp3') ||
        matches.includes('mp3b') ||
        matches.includes('mp3c') ||
        matches.includes('mp3d') ||
        id3InnerAudio ||
        matches.includes('ogg') ||
        matches.includes('flac') ||
        matches.includes('m4a') ||
        matches.includes('webm');

    if (!hasAudioSignature) {
        const nameHint = fileName ? ` (file: ${fileName})` : '';
        return `File does not contain recognized audio data${nameHint}`;
    }

    return null; // null = valid audio
}

// ==================== DISPOSABLE ====================

/**
 * Leak-free cleanup helper. Collects teardown callbacks and DOM listeners;
 * calling dispose() runs them all exactly once (LIFO). Used by
 * VirtualScroller and other long-lived components.
 */
export class Disposable {
    private cleanups: Array<() => void> = [];
    private disposed = false;

    /** Register an arbitrary teardown callback. */
    add(cleanup: () => void): void {
        if (this.disposed) {
            try { cleanup(); } catch { /* ignore */ }
            return;
        }
        this.cleanups.push(cleanup);
    }

    /** Attach a DOM listener that is removed on dispose. */
    on<K extends keyof HTMLElementEventMap>(
        el: HTMLElement | Document | Window,
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean
    ): void {
        try {
            el.addEventListener(event, handler, options);
        } catch {
            return;
        }
        this.add(() => {
            try { el.removeEventListener(event, handler, options); } catch { /* ignore */ }
        });
    }

    /** Run all teardowns exactly once. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (let i = this.cleanups.length - 1; i >= 0; i--) {
            try { this.cleanups[i](); } catch { /* ignore */ }
        }
        this.cleanups.length = 0;
    }

    get isDisposed(): boolean { return this.disposed; }
}

// ==================== TIMING UTILITIES ====================

/**
 * Creates a throttled function that only invokes the provided function at most once per
 * every wait milliseconds.
 * 
 * @param func - The function to throttle
 * @param wait - The number of milliseconds to throttle invocations to
 * @returns A new throttled function
 */
export function throttle<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => ReturnType<T> {
    let lastExecuted = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: any = null;
    let result: ReturnType<T>;
    
    function invoke(): void {
        lastExecuted = Date.now();
        result = func.apply(lastThis, lastArgs as any);
    }
    
    function throttled(this: any, ...args: Parameters<T>): ReturnType<T> {
        const now = Date.now();
        const remaining = wait - (now - lastExecuted);
        
        lastThis = this;
        lastArgs = args;
        
        if (remaining <= 0 || remaining > wait) {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            invoke();
        } else if (!timeout) {
            timeout = setTimeout(invoke, remaining);
        }
        
        return result;
    }
    
    throttled.cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        lastExecuted = 0;
        lastArgs = null;
        lastThis = null;
    };
    
    return throttled as (...args: Parameters<T>) => ReturnType<T>;
}
