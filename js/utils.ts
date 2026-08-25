/**
 * Shared utility functions
 */

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

export function normalizeToArrayBuffer(data: any): ArrayBuffer {
    // Fast path: already an ArrayBuffer
    if (isArrayBuffer(data)) {
        return data.slice(0);
    }
    // Fast path: TypedArray (Uint8Array, Buffer, etc.) or has .buffer (e.g. DataView)
    if (data && typeof data === 'object') {
        // Node.js Buffer extends Uint8Array — check its buffer property
        if (data.buffer && isArrayBuffer(data.buffer)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        // If it's array-like but not a TypedArray, try to convert efficiently
        if (typeof data.length === 'number' && data.length > 0) {
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
    const hasAudioSignature = isRealWav ||
        matches.includes('mp3') ||
        matches.includes('mp3b') ||
        matches.includes('mp3c') ||
        matches.includes('mp3d') ||
        matches.includes('mp3v2') || // ID3 tag - could be any audio
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
