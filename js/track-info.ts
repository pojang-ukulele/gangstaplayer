/**
 * Track Info / Edit Tags modal for Gangsta Player Pro 3.
 * Retro MPC hardware styling (see styles.css `.modal-trackinfo`).
 * Focus trap + ESC handling come from modals.ts openModal/closeModal
 * and the global ESC handler in main.ts.
 */

import { state, Track } from './state';
import { openModal, closeModal } from './modals';
import { toast } from './toast';
import { logger } from './logger';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import { ensureAudio, audioCtx } from './audio';
import './types';

let _wired = false;
let _currentTrackId: string | null = null;

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function fileFormatOf(track: Track): string {
    const ext = track.path.split('.').pop()?.toUpperCase() ?? '';
    return ext ? ext.slice(0, 8) : 'UNKNOWN';
}

function fileNameOf(track: Track): string {
    return track.path.split(/[\\/]/).pop() || track.name;
}

async function probeAudio(track: Track): Promise<{ duration: number; sampleRate: number } | null> {
    try {
        const raw = await window.fileSystem?.readFile(track.path);
        if (!raw) return null;
        const buf = normalizeToArrayBuffer(raw);
        if (buf.byteLength === 0) return null;
        if (validateAudioSignature(buf, track.name)) return null;
        if (!ensureAudio() || !audioCtx) return null;
        const decoded = await audioCtx.decodeAudioData(buf.slice(0));
        return { duration: decoded.duration, sampleRate: decoded.sampleRate };
    } catch {
        return null;
    }
}

function el(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function setText(id: string, value: string): void {
    const node = el(id);
    if (node) node.innerText = value;
}

export function initTrackInfo(): void {
    if (_wired) return;
    _wired = true;
    const modal = el('trackInfoModal');
    const closeX = el('closeTrackInfo');
    const closeBtn = el('btnCloseTrackInfo');
    const saveBtn = el('btnSaveTags');

    if (closeX && modal) closeX.addEventListener('click', () => closeModal(modal));
    if (closeBtn && modal) closeBtn.addEventListener('click', () => closeModal(modal));
    if (saveBtn) saveBtn.addEventListener('click', () => void saveTags());

    // Backdrop click closes (confirm modal intentionally excluded elsewhere).
    window.addEventListener('click', (e) => {
        if (modal && e.target === modal) closeModal(modal);
    });
}

export async function openTrackInfo(track: Track): Promise<void> {
    const modal = el('trackInfoModal');
    if (!modal || !track) return;
    _currentTrackId = track.id;

    setText('infoFilename', fileNameOf(track));
    setText('infoDuration', track.duration > 0 ? formatDuration(track.duration) : 'ANALYZING...');
    setText('infoFormat', fileFormatOf(track));
    setText('infoSampleRate', 'PROBING...');
    setText('infoBPM', track.bpm && track.bpm > 0 ? `${track.bpm} BPM` : 'UNKNOWN');

    // Prefill tag fields from persisted metadata (DB) + current display name.
    let meta: Record<string, string> = {};
    try {
        const row = await window.database?.getTrack(track.path);
        const raw = (row as { metadata?: unknown } | null)?.metadata;
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof v === 'string') meta[k] = v.slice(0, 256);
            }
        }
    } catch { /* metadata is best-effort */ }
    const setInput = (id: string, v: string) => {
        const input = el(id) as HTMLInputElement | null;
        if (input) input.value = v;
    };
    setInput('tagTitle', meta.title ?? track.name);
    setInput('tagArtist', meta.artist ?? '');
    setInput('tagAlbum', meta.album ?? '');
    setInput('tagGenre', meta.genre ?? '');

    openModal(modal);

    // Lazy probe fills duration/sample-rate without blocking the modal.
    if (track.duration <= 0 || true) {
        void probeAudio(track).then((probe) => {
            if (!probe || _currentTrackId !== track.id) return;
            // Track may have been re-analyzed while probing — prefer live state.
            const live = state.playlist.find((t) => t.id === track.id);
            const dur = live && live.duration > 0 ? live.duration : probe.duration;
            setText('infoDuration', formatDuration(dur));
            setText('infoSampleRate', `${probe.sampleRate} Hz`);
        });
    }
}

async function saveTags(): Promise<void> {
    if (!_currentTrackId) return;
    const idx = state.playlist.findIndex((t) => t.id === _currentTrackId);
    if (idx < 0) {
        toast.error('TRACK NO LONGER IN PLAYLIST');
        return;
    }
    const read = (id: string): string => {
        const input = el(id) as HTMLInputElement | null;
        return (input?.value ?? '').slice(0, 256).trim();
    };
    const title = read('tagTitle');
    const artist = read('tagArtist');
    const album = read('tagAlbum');
    const genre = read('tagGenre');
    const metadata = { title, artist, album, genre };

    const next = [...state.playlist];
    next[idx] = {
        ...next[idx],
        ...(title ? { name: title.slice(0, 512) } : {}),
    };
    state.update({ playlist: next });

    try {
        await window.database?.upsertTrack({
            id: next[idx].id,
            path: next[idx].path,
            name: next[idx].name,
            duration: next[idx].duration,
            bpm: next[idx].bpm ?? 0,
            metadata,
        });
        toast.success('TAGS SAVED');
        logger.info(`[TrackInfo] Tags saved for ${next[idx].name}`);
    } catch (e) {
        logger.warn('[TrackInfo] Tag persist failed', e);
        toast.error('TAG SAVE FAILED');
    }
}
