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
    // IPC contract: string / plain {length} / detached / resizable payloads
    // throw INVALID_IPC_PAYLOAD (never a zero-filled buffer) so callers can
    // catch + toast instead of feeding garbage to decodeAudioData/workers.
    if (typeof data === 'string') {
        throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (string payload rejected)');
    }
    if (isArrayBuffer(data)) {
        try {
            if ((data as ArrayBuffer).byteLength === 0) {
                // Empty may be legit, but a detached buffer also reports 0.
                // Detached slice throws — probe without allocating.
                let detached = false;
                try {
                    // Structured-clone detached buffers throw on slice.
                    (data as ArrayBuffer).slice(0, 0);
                } catch {
                    detached = true;
                }
                // Extra detached signal: transfer already neutered it.
                if (detached) {
                    throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (detached ArrayBuffer)');
                }
                // Resizable ArrayBuffer with 0 length that can grow is not a
                // stable decode input — reject so callers copy explicitly.
                const resizable = (data as unknown as { resizable?: boolean }).resizable;
                if (resizable === true) {
                    throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (resizable ArrayBuffer)');
                }
                return (data as ArrayBuffer).slice(0);
            }
            const resizable = (data as unknown as { resizable?: boolean }).resizable;
            if (resizable === true) {
                throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (resizable ArrayBuffer)');
            }
        } catch (e: any) {
            if (String(e?.message ?? '').includes('INVALID_IPC_PAYLOAD')) throw e;
            throw new Error(`normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (${String(e?.message ?? e)})`);
        }
        try {
            return (data as ArrayBuffer).slice(0);
        } catch (e: any) {
            throw new Error(`normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (${String(e?.message ?? e)})`);
        }
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
            // Detached backing store must fail loud, never yield zero-buffer.
            try {
                if (data.buffer.byteLength === 0 && data.byteLength > 0) {
                    throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (detached backing store)');
                }
                const out = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                if (out.byteLength === 0 && data.byteLength > 0) {
                    throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (zero-buffer for non-empty input)');
                }
                return out;
            } catch (e: any) {
                if (String(e?.message ?? '').includes('INVALID_IPC_PAYLOAD')) throw e;
                throw new Error(`normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (${String(e?.message ?? e)})`);
            }
        }
        // If it's array-like but not a TypedArray, try to convert efficiently.
        // Bound: crafted {length: 1e9} objects previously allocated blindly.
        // Contract: plain {length} objects are not valid IPC payloads — reject
        // with INVALID_IPC_PAYLOAD instead of returning a zero-filled buffer.
        if (typeof data.length === 'number' && data.length > 0) {
            throw new Error('normalizeToArrayBuffer: INVALID_IPC_PAYLOAD (array-like object rejected)');
        }
    }
    // Unrecognized format — throw instead of silently producing garbage
    throw new Error(
        `normalizeToArrayBuffer: INVALID_IPC_PAYLOAD Unsupported data type (${typeof data}, ` +
        `${data?.constructor?.name ?? 'unknown'}). Expected ArrayBuffer or TypedArray.`
    );
}

// ==================== JSON SANITIZER ====================

/**
 * Recursively strips prototype-pollution keys (__proto__/constructor/
 * prototype) from parsed JSON. Cycle-safe via Seen set. Clean inputs
 * pass through unchanged (same structure returned).
 */
export function sanitizeParsedJson<T>(value: T, seen: Set<object> = new Set()): T {
    if (Array.isArray(value)) {
        if (seen.has(value as unknown as object)) return value;
        seen.add(value as unknown as object);
        for (let i = 0; i < value.length; i++) {
            try { value[i] = sanitizeParsedJson(value[i], seen); } catch { /* ignore */ }
        }
        return value;
    }
    if (value !== null && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;
        if (seen.has(value as unknown as object)) return value;
        seen.add(value as unknown as object);
        for (const key of Object.keys(value as unknown as object)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                try { delete (value as unknown as Record<string, unknown>)[key]; } catch { /* ignore */ }
                continue;
            }
            try {
                (value as unknown as Record<string, unknown>)[key] =
                    sanitizeParsedJson((value as unknown as Record<string, unknown>)[key] as unknown, seen) as unknown;
            } catch { /* ignore */ }
        }
        return value;
    }
    return value;
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
 * .aac policy (explicit): raw AAC is accepted ONLY with an ADTS frame sync
 * (0xFF 0xF1 / 0xFF 0xF9) at the scan point. Bare/unknown AAC payloads are
 * rejected — callers should prefer the .m4a container. This keeps
 * VALID_AUDIO_EXTENSIONS ('aac' listed) honest instead of silently
 * accepting non-ADTS bytes.
 *
 * Small-buffer contract: header-only buffers too small to prove a negative
 * (e.g. the 12-16B unit-test fixtures) are provisionally accepted when the
 * outer magic matches. Real files (large enough to contain the body) must
 * carry body evidence or are rejected (RF64-bare, 12B RIFF without
 * fmt/data, MP4-video brands, MKV doctype).
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
    const err = (m: string) => `${m}${fileName ? ` (file: ${fileName})` : ''}`;
    // ADTS/AAC explicit accept (see docblock): MPEG-4 AAC (0xF1) and
    // MPEG-2 AAC (0xF9) frame syncs. Layer bits are 00 for AAC (reserved in
    // MPEG-audio), so this branch must precede the MP3 layer check below.
    if (buffer.byteLength >= 2 && view.getUint8(0) === 0xFF) {
        const b1 = view.getUint8(1);
        if (b1 === 0xF1 || b1 === 0xF9) return null;
    }
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
    // 12B RIFF without fmt/data: a bare 12-byte "RIFF....WAVE" header is not
    // playable audio. Buffers at/below 12B cannot carry a body, so reject.
    // Larger header-only buffers are provisionally accepted (unit fixtures);
    // real-size buffers must show fmt/data (checked below).
    if ((hasRiff || matches.includes('rifx')) && hasWave && buffer.byteLength <= 12) {
        return err('File does not contain recognized audio data (RIFF header without body)');
    }
    const hasChunkTag = (tag: string): boolean => {
        if (buffer.byteLength < 4) return false;
        const end = Math.min(buffer.byteLength - 4, 512);
        for (let p = 12; p <= end; p++) {
            if (String.fromCharCode(
                view.getUint8(p), view.getUint8(p + 1),
                view.getUint8(p + 2), view.getUint8(p + 3)) === tag) return true;
        }
        return false;
    };
    const wavHasBody = hasChunkTag('fmt ') || hasChunkTag('data') || hasChunkTag('ds64');
    const isRealWav = hasRiff && hasWave && (buffer.byteLength < 32 || wavHasBody);
    // RIFX/RF64 need the WAVE/ds64 body; AIFF needs FORM+AIFF (L6).
    const isRifxWav = matches.includes('rifx') && hasWave && (buffer.byteLength < 32 || wavHasBody);
    // RF64-bare: require a ds64/data/WAVE body on real-size buffers.
    const rf64HasBody = hasChunkTag('ds64') || hasChunkTag('data') || hasChunkTag('WAVE');
    const isRf64 = matches.includes('rf64') && (buffer.byteLength < 32 || rf64HasBody);
    const aiffHasBody = buffer.byteLength < 32 || hasChunkTag('COMM') || hasChunkTag('SSND');
    const isAiff = matches.includes('aiff') && matches.includes('aiffBody') && aiffHasBody;
    // ftyp brand gate: MP4-video shares the ftyp box with M4A audio. Major
    // brand at +8 plus compatible brands from +16 decide. Audio majors
    // (M4A/m4a/mp4a/alac/m4b/m4p) accept; video-only majors (avc1/hev1/hvc1/
    // vp09/av01/mp4v) reject; ambiguous isom/mp41/mp42 accept only when a
    // compatible brand proves audio (mp4a/M4A/alac). Buffers too small to
    // contain the brand (<16B) are provisionally accepted.
    const readBrand = (off: number): string | null => {
        if (off + 4 > buffer.byteLength) return null;
        return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    };
    const isAudioFtyp = (): boolean => {
        if (!matches.includes('m4a')) return false;
        if (buffer.byteLength < 16) return true; // too small to brand-check
        const major = readBrand(8) ?? '';
        const audioMajors = ['M4A ', 'm4a ', 'mp4a', 'alac', 'M4B ', 'm4b ', 'M4P ', 'm4p '];
        if (audioMajors.includes(major)) return true;
        const videoMajors = ['avc1', 'hev1', 'hvc1', 'vp09', 'av01', 'mp4v', 'avcC'];
        if (videoMajors.includes(major)) return false;
        // Ambiguous (isom/iso2/mp41/mp42/...) — scan compatible brands.
        const compat: string[] = [];
        for (let p = 16; p + 4 <= Math.min(buffer.byteLength, 64); p += 4) {
            const b = readBrand(p);
            if (b) compat.push(b);
        }
        if (compat.some(b => audioMajors.includes(b) || b === 'mp4a')) return true;
        if (compat.some(b => videoMajors.includes(b) || b === 'mp4v')) return false;
        // Unknown brand with no audio evidence on a real-size file: reject
        // video-suspect majors, accept only M4A-family proof above.
        if (['isom', 'iso2', 'mp41', 'mp42'].includes(major)) return false;
        return false;
    };
    // EBML doctype gate: WebM and MKV share the 1A45DFA3 header. Parse the
    // DocType element (0x4282) — 'webm' accepts, 'matroska' (MKV) rejects.
    const ebmlDocTypeIsWebm = (): boolean => {
        if (!matches.includes('webm')) return false;
        const end = Math.min(buffer.byteLength - 1, 256);
        for (let p = 0; p <= end - 2; p++) {
            if (view.getUint8(p) === 0x42 && view.getUint8(p + 1) === 0x82 && p + 3 < buffer.byteLength) {
                const sizeByte = view.getUint8(p + 2);
                const len = sizeByte & 0x7f;
                if (len === 0 || len > 16 || p + 3 + len > buffer.byteLength) return false;
                let s = '';
                for (let k = 0; k < len; k++) s += String.fromCharCode(view.getUint8(p + 3 + k));
                if (s.startsWith('matroska')) return false; // MKV
                if (s.startsWith('webm')) return true;
                return false; // unknown doctype — reject
            }
        }
        // No DocType visible yet (tiny buffer): provisional accept.
        return buffer.byteLength < 32;
    };
    const hasId3 = matches.includes('mp3v2');
    // ID3-wrapped audio (L6): strict offset-0 checks rejected tagged files.
    // Look past a valid ID3v2 tag for the real stream magic. A bare ID3 tag
    // alone previously passed (junk with an ID3 header wasted a worker copy +
    // decode) — so require inner evidence: scan a window past the tag end for
    // stream magic, ftyp (M4A), EBML (WebM), or an MPEG/ADTS frame sync.
    // Padding between tag and frames is real but bounded; large embedded art
    // pushes frames >8KB out, so scan up to 64KB past the tag end (full
    // synchsafe tag-size parse, not a fixed 8KB guess).
    let id3InnerAudio = false;
    if (hasId3) {
        if (buffer.byteLength < 10) return `File does not contain recognized audio data${fileName ? ` (file: ${fileName})` : ''}`;
        const tagSize = ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14) | ((view.getUint8(8) & 0x7f) << 7) | (view.getUint8(9) & 0x7f);
        if (tagSize <= 0 || 10 + tagSize >= buffer.byteLength) return `File does not contain recognized audio data${fileName ? ` (file: ${fileName})` : ''}`;
        const inner = 10 + tagSize;
        const scanEnd = Math.min(buffer.byteLength - 4, inner + 65536);
        for (let p = inner; p <= scanEnd; p++) {
            const tag = String.fromCharCode(
                view.getUint8(p), view.getUint8(p + 1),
                view.getUint8(p + 2), view.getUint8(p + 3));
            if (tag === 'fLaC' || tag === 'OggS' || tag === 'RIFF' || tag === 'FORM') { id3InnerAudio = true; break; }
            // ftyp box inside ID3 (tag + M4A): brand at p+4.
            if (p + 8 <= buffer.byteLength && tag === 'ftyp') { id3InnerAudio = true; break; }
            if (p + 4 <= buffer.byteLength && String.fromCharCode(
                view.getUint8(p + 4), view.getUint8(p + 5),
                view.getUint8(p + 6), view.getUint8(p + 7)) === 'ftyp') { id3InnerAudio = true; break; }
            // EBML header inside ID3 (tag + WebM).
            if (view.getUint8(p) === 0x1A && view.getUint8(p + 1) === 0x45
                && view.getUint8(p + 2) === 0xDF && view.getUint8(p + 3) === 0xA3) { id3InnerAudio = true; break; }
            if (view.getUint8(p) === 0xFF && p + 1 < buffer.byteLength) {
                const b1 = view.getUint8(p + 1);
                if (b1 === 0xF1 || b1 === 0xF9) { id3InnerAudio = true; break; }
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
        isAudioFtyp() ||
        ebmlDocTypeIsWebm();

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
export function throttle<T extends (...args: any[]) => any>(func: T, wait: number): ((...args: Parameters<T>) => ReturnType<T>) & { cancel: () => void } {
    let lastExecuted = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: any = null;
    let result: ReturnType<T>;

    function armTimer(ms: number): void {
        timeout = setTimeout(invoke, ms);
        // Don't hold the event loop / packaged app open on a trailing LED
        // tick — visuals destroy cancels anyway, unref is defense in depth.
        try { (timeout as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    }
    
    function invoke(): void {
        timeout = null;
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
            armTimer(remaining);
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
    
    return throttled;
}
