/**
 * Shared decoded-audio cache: one decode serves analysis + playback.
 * Bounded: max 3 entries AND 100MB total, oldest evicted first.
 */

interface DecodedEntry {
    bytes: ArrayBuffer;
    buffer: AudioBuffer;
    duration: number;
}

const _cache = new Map<string, DecodedEntry>();
let _totalBytes = 0;
const MAX_ENTRIES = 3;
const MAX_BYTES = 100 * 1024 * 1024;

function evictOldest(): void {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) return;
    const e = _cache.get(oldest);
    if (e) _totalBytes -= e.bytes.byteLength || 0;
    _cache.delete(oldest);
    if (_cache.size === 0) _totalBytes = 0;
    if (_totalBytes < 0) _totalBytes = 0;
}

export function getDecoded(trackId: string): DecodedEntry | undefined {
    try {
        if (!trackId) return undefined;
        return _cache.get(trackId);
    } catch { return undefined; }
}

export function storeDecoded(trackId: string, bytes: ArrayBuffer, buffer: AudioBuffer, duration: number): void {
    try {
        if (!trackId || !bytes || !buffer) return;
        const prev = _cache.get(trackId);
        if (prev) {
            _totalBytes -= prev.bytes.byteLength || 0;
            _cache.delete(trackId);
        }
        _cache.set(trackId, { bytes, buffer, duration });
        _totalBytes += bytes.byteLength || 0;
        while ((_cache.size > MAX_ENTRIES || _totalBytes > MAX_BYTES) && _cache.size > 0) evictOldest();
    } catch { /* ignore */ }
}

export function evictDecoded(trackId: string): void {
    try {
        const e = _cache.get(trackId);
        if (e) _totalBytes -= e.bytes.byteLength || 0;
        _cache.delete(trackId);
        if (_totalBytes < 0) _totalBytes = 0;
    } catch { /* ignore */ }
}

export function clearDecoded(): void {
    _cache.clear();
    _totalBytes = 0;
}
