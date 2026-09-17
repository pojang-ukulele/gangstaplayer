import { audioCtx, ensureAudio } from './audio';
import { storeDecoded } from './decoded-cache';
import { MAX_FILE_SIZE_BYTES } from './constants';
import './types';

const MAX_PCM_TOTAL = 100 * 1024 * 1024;
const MAX_HEADER_LEN = 64 * 1024;

export async function keyFor(canonicalPath: string, size: number, mtimeMs: number): Promise<string | null> {
    try {
        if (typeof canonicalPath !== 'string' || !canonicalPath || canonicalPath.length > 32760) return null;
        if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || size < 0 || mtimeMs < 0) return null;
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return null;
        const raw = new TextEncoder().encode(`${canonicalPath}||${Math.floor(size)}||${Math.floor(mtimeMs)}`);
        const digest = await subtle.digest('SHA-256', raw);
        const arr = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        if (!/^[0-9a-f]{64}$/.test(hex)) return null;
        return hex;
    } catch { return null; }
}

function encodePcm(audioBuffer: AudioBuffer): Uint8Array | null {
    try {
        const channels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
        if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) return null;
        if (!Number.isInteger(length) || length <= 0) return null;
        const hbytes = new TextEncoder().encode(JSON.stringify({ v: 1, channels, sampleRate, length }));
        if (hbytes.length === 0 || hbytes.length > MAX_HEADER_LEN) return null;
        const total = 4 + hbytes.length + channels * length * 4;
        if (!Number.isSafeInteger(total) || total > MAX_PCM_TOTAL || total > MAX_FILE_SIZE_BYTES) return null;
        const out = new Uint8Array(total);
        new DataView(out.buffer).setUint32(0, hbytes.length, true);
        out.set(hbytes, 4);
        let off = 4 + hbytes.length;
        for (let c = 0; c < channels; c++) {
            const ch = audioBuffer.getChannelData(c);
            if (!ch || ch.length !== length) return null;
            out.set(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength), off);
            off += ch.byteLength;
        }
        return out;
    } catch { return null; }
}

interface DecodedPcm {
    channels: number;
    sampleRate: number;
    length: number;
    headerLen: number;
    raw: Uint8Array;
}

function decodePcm(raw: Uint8Array): DecodedPcm | null {
    try {
        if (!raw || raw.byteLength < 5 || raw.byteLength > MAX_PCM_TOTAL) return null;
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const hlen = view.getUint32(0, true);
        if (hlen === 0 || hlen > MAX_HEADER_LEN || 4 + hlen > raw.byteLength) return null;
        const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hlen)));
        if (!header || header.v !== 1) return null;
        const channels = header.channels;
        const sampleRate = header.sampleRate;
        const length = header.length;
        if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
        if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) return null;
        if (!Number.isInteger(length) || length <= 0) return null;
        if (4 + hlen + channels * length * 4 !== raw.byteLength) return null;
        return { channels, sampleRate, length, headerLen: hlen, raw };
    } catch { return null; }
}

function toAudioBuffer(entry: DecodedPcm): AudioBuffer | null {
    try {
        if (!ensureAudio() || !audioCtx) return null;
        const buf = audioCtx.createBuffer(entry.channels, entry.length, entry.sampleRate);
        const base = 4 + entry.headerLen;
        for (let c = 0; c < entry.channels; c++) {
            const src = new Float32Array(entry.raw.buffer, entry.raw.byteOffset + base + c * entry.length * 4, entry.length);
            const copy = new Float32Array(entry.length);
            copy.set(src);
            buf.copyToChannel(copy, c);
        }
        return buf;
    } catch { return null; }
}

function encodeWav16(buffer: AudioBuffer): ArrayBuffer | null {
    try {
        const channels = buffer.numberOfChannels;
        const sampleRate = Math.floor(buffer.sampleRate);
        const length = buffer.length;
        const dataBytes = length * channels * 2;
        if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || 44 + dataBytes > MAX_FILE_SIZE_BYTES) return null;
        const ab = new ArrayBuffer(44 + dataBytes);
        const v = new DataView(ab);
        const writeStr = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF');
        v.setUint32(4, 36 + dataBytes, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        v.setUint32(16, 16, true);
        v.setUint16(20, 1, true);
        v.setUint16(22, channels, true);
        v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * channels * 2, true);
        v.setUint16(32, channels * 2, true);
        v.setUint16(34, 16, true);
        writeStr(36, 'data');
        v.setUint32(40, dataBytes, true);
        const chData: Array<Float32Array<ArrayBufferLike>> = [];
        for (let c = 0; c < channels; c++) chData.push(buffer.getChannelData(c));
        let off = 44;
        for (let i = 0; i < length; i++) {
            for (let c = 0; c < channels; c++) {
                let s = chData[c][i];
                if (!Number.isFinite(s)) s = 0;
                s = Math.max(-1, Math.min(1, s));
                v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
                off += 2;
            }
        }
        return ab;
    } catch { return null; }
}

export async function getDiskAudio(filePath: string, trackId?: string): Promise<AudioBuffer | null> {
    try {
        if (typeof filePath !== 'string' || !filePath || filePath.length > 32760) return null;
        const fsApi = window.fileSystem;
        const pcApi = window.pcmCache;
        if (!fsApi || typeof fsApi.statFile !== 'function') return null;
        if (!pcApi || typeof pcApi.get !== 'function') return null;
        const stat = await fsApi.statFile(filePath);
        if (!stat || !Number.isFinite(stat.size) || !Number.isFinite(stat.mtimeMs)) return null;
        if (stat.size <= 0 || stat.size > MAX_FILE_SIZE_BYTES) return null;
        const key = await keyFor(filePath, stat.size, stat.mtimeMs);
        if (!key) return null;
        const raw = await pcApi.get(key);
        if (!raw || !(raw instanceof Uint8Array)) return null;
        if (raw.byteLength === 0 || raw.byteLength > MAX_PCM_TOTAL) return null;
        const entry = decodePcm(raw);
        if (!entry) return null;
        const audioBuffer = toAudioBuffer(entry);
        if (!audioBuffer) return null;
        if (trackId) {
            try {
                const wav = encodeWav16(audioBuffer);
                if (wav && wav.byteLength > 0) storeDecoded(trackId, wav, audioBuffer, audioBuffer.duration);
            } catch { /* ignore */ }
        }
        return audioBuffer;
    } catch { return null; }
}

export async function putDiskAudio(filePath: string, audioBuffer: AudioBuffer): Promise<boolean> {
    try {
        if (typeof filePath !== 'string' || !filePath || filePath.length > 32760) return false;
        if (!audioBuffer) return false;
        const fsApi = window.fileSystem;
        const pcApi = window.pcmCache;
        if (!fsApi || typeof fsApi.statFile !== 'function') return false;
        if (!pcApi || typeof pcApi.put !== 'function') return false;
        const stat = await fsApi.statFile(filePath);
        if (!stat || !Number.isFinite(stat.size) || !Number.isFinite(stat.mtimeMs)) return false;
        if (stat.size <= 0 || stat.size > MAX_FILE_SIZE_BYTES) return false;
        const key = await keyFor(filePath, stat.size, stat.mtimeMs);
        if (!key) return false;
        const payload = encodePcm(audioBuffer);
        if (!payload) return false;
        return await pcApi.put(key, payload);
    } catch { return false; }
}
