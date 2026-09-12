// === PLAYER MODULE ===
import { audioCtx, resumeAudioContext, masterGain, ensureAudio } from './audio';
import { settings, isAiEnabled } from './settings';
import { state, Track, PlaybackMode, LoopMode } from './state';
import { detectBPMWorker } from './worker-client';
import { toast } from './toast';
import { engine } from './audio-engine';
import { logger } from './logger';
import { normalizeToArrayBuffer, validateAudioSignature } from './utils';
import {
    BLOB_REVOKE_DELAY_MS,
    BLOB_REVOKE_CROSSFADE_MS,
    CROSSFADE_RAMP_LOW_DB,
    CROSSFADE_RAMP_MID_DB,
    CROSSFADE_LP_SWEEP_HZ,
    CROSSFADE_HP_SWEEP_HZ,
    SLIDER_SNAP_THRESHOLD,
    MAX_FILE_SIZE_BYTES,
} from './constants';
import './types';

interface PlayerDeps {
    renderPlaylist: () => void;
    setBlendingIndex?: (index: number) => void;
}

let mainBlobUrl: string = "";
let crossfadeBlobUrl: string = "";

/**
 * Dropped-file bytes cache (DnD regression fix).
 * A File dropped from an arbitrary folder (Downloads/Desktop) carries its own
 * user-consent gesture, so playback/decode/BPM use file.arrayBuffer()
 * directly instead of an IPC re-read that fail-closed allowlists deny.
 * Keyed by the resolved disk path from getPathForFile; bounded LRU.
 */
const droppedAudioFiles = new Map<string, File>();
const droppedAudioById = new Map<string, File>();
const MAX_DROPPED_FILES = 100;
// L8: 100 files x 100MB = up to 10GB pinned. Budget total bytes too.
const MAX_DROPPED_BYTES = 500 * 1024 * 1024;
let _droppedBytes = 0;

/** Load-step timeout: a hung IPC read or decode must surface, never stall silent. */
const LOAD_READ_TIMEOUT_MS = 15000;
const LOAD_DECODE_TIMEOUT_MS = 15000;

class LoadStepTimeoutError extends Error {
    constructor(step: string) {
        super(`[Player] ${step} timed out`);
        this.name = 'LoadStepTimeoutError';
    }
}

function withLoadStepTimeout<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
            timer = null;
            reject(new LoadStepTimeoutError(step));
        }, ms);
        promise.then(
            (v) => { if (timer) clearTimeout(timer); resolve(v); },
            (e) => { if (timer) clearTimeout(timer); reject(e); }
        );
    });
}

/**
 * Fade duration sanitized against corrupt persisted settings. settings.autoMix
 * comes from localStorage JSON — NaN/undefined/Infinity previously flowed into
 * linearRampToValueAtTime(NaN) (throws mid-blend) and setTimeout(NaN) (instant
 * swap). Always returns a finite clamped value.
 */
function safeFadeSeconds(customDuration: number | null = null): number {
    const DEFAULT_FADE = 10;
    const raw = customDuration !== null ? customDuration : (settings as any)?.autoMix?.trackDuration;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_FADE;
    return Math.min(60, Math.max(0.5, raw));
}

/**
 * Renderer mirror of main-process canonicalReadKey (main.ts): resolve-ish
 * normalization + case-fold. No node:path here — slash-normalize and
 * lowercase so `C:\Music\A.mp3` hits the same entry as `c:/music/a.mp3`.
 */
function canonicalDroppedKey(p: string): string {
    try {
        let k = String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
        if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
        return k.toLowerCase();
    } catch {
        return String(p ?? '').toLowerCase();
    }
}

function evictOldest(m: Map<string, File>): void {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
}

export function cacheDroppedAudio(filePath: string, file: File, trackId?: string): void {
    try {
        if (!filePath || !file) return;
        const key = canonicalDroppedKey(filePath);
        const prev = droppedAudioFiles.get(key);
        if (prev) _droppedBytes -= prev.size || 0;
        if (droppedAudioFiles.has(key)) droppedAudioFiles.delete(key);
        droppedAudioFiles.set(key, file);
        _droppedBytes += file.size || 0;
        const evictPath = (): void => {
            const oldest = droppedAudioFiles.keys().next().value;
            if (oldest === undefined) return;
            const f = droppedAudioFiles.get(oldest);
            if (f) _droppedBytes -= f.size || 0;
            droppedAudioFiles.delete(oldest);
        };
        while ((droppedAudioFiles.size > MAX_DROPPED_FILES || _droppedBytes > MAX_DROPPED_BYTES) && droppedAudioFiles.size > 0) evictPath();
        // Accounting drift (unknown sizes) must never pin the counter high.
        if (droppedAudioFiles.size === 0) _droppedBytes = 0;
        if (_droppedBytes < 0) _droppedBytes = 0;
        if (trackId) {
            if (droppedAudioById.has(trackId)) droppedAudioById.delete(trackId);
            droppedAudioById.set(trackId, file);
            while (droppedAudioById.size > MAX_DROPPED_FILES) evictOldest(droppedAudioById);
        }
    } catch { /* ignore */ }
}

export function getDroppedAudioFile(filePath: string, trackId?: string): File | undefined {
    try {
        if (trackId) {
            const byId = droppedAudioById.get(trackId);
            if (byId) return byId;
        }
        const hit = droppedAudioFiles.get(canonicalDroppedKey(filePath));
        if (hit) return hit;
        return droppedAudioFiles.get(filePath);
    } catch { return undefined; }
}

/**
 * Read audio bytes for a track path: dropped File first, IPC fallback.
 * Returns a detached ArrayBuffer or null when unreadable.
 */
export async function readAudioBytesForPath(filePath: string, trackId?: string): Promise<ArrayBuffer | null> {
    const dropped = getDroppedAudioFile(filePath, trackId);
    if (dropped) {
        try {
            if (typeof dropped.size === 'number') {
                if (dropped.size === 0 || dropped.size > MAX_FILE_SIZE_BYTES) return null;
            }
            const buf = await dropped.arrayBuffer();
            if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_FILE_SIZE_BYTES) return null;
            // Fresh exclusive buffer — no extra slice (C11: the old slice(0)
            // doubled every dropped-file load for nothing).
            return buf;
        } catch { /* fall through to IPC */ }
    }
    try {
        const rawData = await window.fileSystem.readFile(filePath);
        if (!rawData) return null;
        return normalizeToArrayBuffer(rawData);
    } catch {
        return null;
    }
}

/**
 * Revokes a Blob URL after a delay to ensure the browser has finished buffering.
 * Prevents "Source Error" when skipping tracks rapidly.
 */
function revokeLater(url: string, delay = BLOB_REVOKE_DELAY_MS): void {
    if (!url || !url.startsWith('blob:')) return;
    setTimeout(() => {
        try {
            URL.revokeObjectURL(url);
            logger.debug(`[Player] Revoked stale URL: ${url}`);
        } catch (e) {
            // URL might already be revoked
        }
    }, delay);
}

function trackBlobUrl(url: string, isMain: boolean): string {
    if (isMain) {
        if (mainBlobUrl) revokeLater(mainBlobUrl);
        mainBlobUrl = url;
    } else {
        if (crossfadeBlobUrl) revokeLater(crossfadeBlobUrl);
        crossfadeBlobUrl = url;
    }
    return url;
}

async function getSafeUrl(filePath: string, isMain: boolean, verifyDecode = false, trackId?: string): Promise<string> {
    try {
        // trackId threads through so dropped-file bytes resolve by id exactly
        // like loadTrack — previously the crossfade path dropped it and
        // re-read via IPC, diverging from loadTrack validation (M11).
        const arrayBuffer = await readAudioBytesForPath(filePath, trackId);
        if (!arrayBuffer) {
            logger.warn(`[SafeURL] File unreadable: ${filePath}`);
            return "";
        }
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            logger.warn(`[SafeURL] Rejected bad size (${arrayBuffer.byteLength}): ${filePath}`);
            return "";
        }
        // L6: pass the file name so the validator can apply extension-aware
        // judgments (ID3-wrapped FLAC, header/extension mismatches).
        const sigErr = validateAudioSignature(arrayBuffer, filePath.split(/[\\/]/).pop());
        if (sigErr) {
            logger.warn(`[SafeURL] Rejected non-audio file: ${filePath} (${sigErr})`);
            return "";
        }
        if (verifyDecode && ensureAudio() && audioCtx) {
            try { await audioCtx.decodeAudioData(arrayBuffer.slice(0)); }
            catch {
                logger.warn(`[SafeURL] Rejected undecodable file: ${filePath}`);
                return "";
            }
        }
        // Blob wraps the ORIGINAL buffer — the old extra slice(0) tripled
        // peak RAM (read + verify copy + blob copy). decodeAudioData detaches
        // only the verify copy, so the original stays intact here.
        const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
        return trackBlobUrl(URL.createObjectURL(blob), isMain);
    } catch (e) {
        logger.error("[SafeURL] Failed to create blob", e);
        return "";
    }
}

// Local UI references
let isDraggingProgress = false;
let playPauseBtn: HTMLElement | null = null;
let stopBtn: HTMLElement | null = null;
let trackTitle: HTMLElement | null = null;
let trackSpinner: HTMLElement | null = null;
let progressBar: HTMLInputElement | null = null;
let timeDisplay: HTMLElement | null = null;
let totalTimeDisplay: HTMLElement | null = null;
let tempoSlider: HTMLInputElement | null = null;
let tempoVal: HTMLElement | null = null;
let autoMixBtn: HTMLElement | null = null;
let masterVol: HTMLInputElement | null = null;
let volKnob: HTMLElement | null = null;

let renderPlaylistFn: (() => void) | null = null;
let setBlendingIndexFn: ((index: number) => void) | null = null;

// Cancellation token for loadTrack race condition
let _loadTrackId = 0;


export function setPlaybackMode(mode: PlaybackMode): void { state.update({ playbackMode: mode }); }
export function getPlaybackMode(): PlaybackMode { return state.playbackMode; }
export function setLoopMode(mode: LoopMode): void {
    // LOOP ONE and AutoMix fight over track endings (H11) — setting one
    // directly must clear the other, mirroring setAutoMixEnabled.
    if (mode === 'one' && state.isAutoMixEnabled) {
        state.update({ isAutoMixEnabled: false });
    }
    state.update({ loopMode: mode });
    // Apply to both channels: after a swap the promoted element must inherit
    // the flag or LOOP ONE silently dies post-crossfade.
    engine.main.audio.loop = (mode === 'one');
    engine.crossfade.audio.loop = false;
}
export function getLoopMode(): LoopMode { return state.loopMode; }

export function initPlayer(deps: PlayerDeps): void {
    renderPlaylistFn = deps.renderPlaylist;
    if (deps.setBlendingIndex) setBlendingIndexFn = deps.setBlendingIndex;
    
    playPauseBtn = document.getElementById('playPauseBtn');
    stopBtn = document.getElementById('stopBtn');
    trackTitle = document.getElementById('trackTitle');
    trackSpinner = document.getElementById('trackSpinner');
    progressBar = document.getElementById('progressBar') as HTMLInputElement;
    timeDisplay = document.getElementById('currentTime');
    totalTimeDisplay = document.getElementById('totalTime');
    tempoSlider = document.getElementById('tempoSlider') as HTMLInputElement;
    tempoVal = document.getElementById('chopperBPM');
    autoMixBtn = document.getElementById('autoMixBtn');
    masterVol = document.getElementById('masterVol') as HTMLInputElement;
    volKnob = document.getElementById('volKnob');
    
    // === REACTIVE SUBSCRIPTIONS ===
    state.subscribe('isPlaying', (playing) => {
        if (playPauseBtn) {
            playPauseBtn.innerText = playing ? "PAUSE" : "PLAY";
            playPauseBtn.setAttribute('aria-pressed', String(playing));
        }
    });

    state.subscribe('isAutoMixEnabled', (enabled) => {
        if (autoMixBtn) {
            autoMixBtn.classList.toggle('active', enabled);
            autoMixBtn.setAttribute('aria-pressed', String(enabled));
        }
        const cb = document.getElementById('mixOptEnableAI') as HTMLInputElement | null;
        if (cb && cb.checked !== enabled) cb.checked = enabled;
    });

    state.subscribe('loopMode', (mode) => {
        const loopBtn = document.getElementById('loopBtn');
        if (loopBtn) {
            loopBtn.classList.toggle('active-loop', mode !== 'off');
            loopBtn.setAttribute('aria-pressed', String(mode !== 'off'));
        }
        engine.main.audio.loop = (mode === 'one');
        engine.crossfade.audio.loop = false;
    });

    setupPlayerHandlers();
}

export function setAutoMixEnabled(val: boolean): void {
    state.update({ isAutoMixEnabled: val });
    if (val && state.loopMode === 'one') {
        state.update({ loopMode: 'off' });
    }
}

export function toggleAutoMix(): void { setAutoMixEnabled(!state.isAutoMixEnabled); }
export function getMasterBPMRef(): { value: number } { 
    return { 
        get value() { return state.masterBPM; }, 
        set value(v: number) { state.update({ masterBPM: v }); } 
    }; 
}
export function getTempoSlider(): HTMLInputElement | null { return tempoSlider; }
export function getPlayerAudio(): HTMLAudioElement { return engine.main.audio; }

/** Immediately revoke tracked blob URLs (called on app teardown). */
export function disposePlayerUrls(): void {
    // Detach first: revoking a URL still assigned to a live <audio> src
    // kills in-flight playback with a source error. Only revoke once no
    // element references the URL.
    try { engine.main.audio.removeAttribute('src'); } catch { /* ignore */ }
    try { engine.main.audio.load(); } catch { /* ignore */ }
    try { engine.crossfade.audio.removeAttribute('src'); } catch { /* ignore */ }
    try { engine.crossfade.audio.load(); } catch { /* ignore */ }
    for (const url of [mainBlobUrl, crossfadeBlobUrl]) {
        if (url && url.startsWith('blob:')) {
            if (engine.main.audio.src === url || engine.crossfade.audio.src === url) continue;
            try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        }
    }
    mainBlobUrl = "";
    crossfadeBlobUrl = "";
}

export async function loadTrack(index: number): Promise<void> {
    // Loading into main mid-crossfade would clobber the outgoing channel's
    // gain/EQ automation while the blend is running.
    if (state.isCrossfadeInProgress) return;
    const playlist = state.playlist;
    if (!playlist.length || index < 0 || index >= playlist.length) return;
    const track = playlist[index];
    // Claim the generation BEFORE any await so overlapping calls can't both
    // assign audio.src — stale resolutions are discarded below.
    // Index commits only after the file proves loadable (C10) — failures
    // leave highlight + index on the previous live track.
    const loadId = ++_loadTrackId;
    
    engine.main.reset();
    logger.info(`[Player] Loading track: ${track.name} [ID: ${track.id}]`);
    // Single IPC read shared by playback blob + decode/BPM. Previously this
    // read the file twice (2x I/O, 2x RAM, TOCTOU). decodeAudioData detaches
    // its input, so the blob gets a copy.
    let sharedBuffer: ArrayBuffer | null = null;
    logger.debug(`[Player] loadId=${loadId} read start: ${track.path}`);
    try {
        sharedBuffer = await withLoadStepTimeout(readAudioBytesForPath(track.path, track.id), LOAD_READ_TIMEOUT_MS, 'read');
    } catch (e) {
        if (e instanceof LoadStepTimeoutError) {
            logger.warn(`[Player] Load read timed out loadId=${loadId} path=${track.path}`);
            toast.error("TRACK LOAD TIMED OUT — KEPT PREVIOUS TRACK");
            hideSpinnerIfCurrent(loadId);
            return;
        }
        logger.warn(`[Player] Read failed for ${track.path}`, e);
    }
    logger.debug(`[Player] loadId=${loadId} read done bytes=${sharedBuffer?.byteLength ?? 'null'}`);
    if (loadId !== _loadTrackId) { logger.debug(`[Player] loadId=${loadId} superseded after read`); return; }
    if (!sharedBuffer) {
        toast.error("TRACK UNREADABLE — KEPT PREVIOUS TRACK");
        hideSpinnerIfCurrent(loadId);
        return;
    }
    if (sharedBuffer.byteLength === 0 || sharedBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
        toast.error("TRACK TOO LARGE OR EMPTY — KEPT PREVIOUS TRACK");
        hideSpinnerIfCurrent(loadId);
        return;
    }
    const sigErr = validateAudioSignature(sharedBuffer, track.name);
    if (sigErr) {
        toast.error("INVALID AUDIO FILE — KEPT PREVIOUS TRACK");
        logger.warn(`[Player] Rejected non-audio: ${track.path} (${sigErr})`);
        hideSpinnerIfCurrent(loadId);
        return;
    }
    // Show spinner during decode verification (src is not swapped until the
    // file proves decodable — previously a corrupt file clobbered the deck).
    if (trackSpinner) trackSpinner.classList.add('active');

    // Verify decodability BEFORE touching the live deck. Uses a detached copy
    // so sharedBuffer stays intact for the playback blob.
    let verifiedBuffer: AudioBuffer | null = null;
    logger.debug(`[Player] loadId=${loadId} decode start: ${track.path}`);
    try {
        if (ensureAudio() && audioCtx && sharedBuffer) {
            const verifyCopy = sharedBuffer.slice(0);
            verifiedBuffer = await withLoadStepTimeout(audioCtx.decodeAudioData(verifyCopy), LOAD_DECODE_TIMEOUT_MS, 'decode');
        }
    } catch (decErr) {
        if (decErr instanceof LoadStepTimeoutError) {
            logger.warn(`[Player] Load decode timed out loadId=${loadId} path=${track.path}`);
            toast.error("TRACK DECODE TIMED OUT — KEPT PREVIOUS TRACK");
            hideSpinnerIfCurrent(loadId);
            return;
        }
        logger.warn(`[Player] Decode verification failed for ${track.path}`, decErr);
        toast.error("TRACK UNDECODABLE — KEPT PREVIOUS TRACK");
        hideSpinnerIfCurrent(loadId);
        return;
    }
    logger.debug(`[Player] loadId=${loadId} decode done`);
    if (loadId !== _loadTrackId) { logger.debug(`[Player] loadId=${loadId} superseded after decode`); hideSpinnerIfCurrent(loadId); return; }
    const live = state.playlist;
    if (index < 0 || index >= live.length || live[index]?.id !== track.id) { logger.debug(`[Player] loadId=${loadId} cancelled: playlist changed`); hideSpinnerIfCurrent(loadId); return; }
    // Blob wraps the ORIGINAL sharedBuffer (C11) — the old slice(0) kept a
    // third full-size copy alive next to the read buffer + verify copy.
    const safeUrl = trackBlobUrl(URL.createObjectURL(new Blob([sharedBuffer], { type: 'audio/mpeg' })), true);
    // Handshake before trusting the deck (C13): bare src assignment while a
    // previous load is buffering aborts it with a media error.
    const loadOk = await engine.main.loadAsync(safeUrl);
    if (loadId !== _loadTrackId) { logger.debug(`[Player] loadId=${loadId} superseded during handshake`); return; }
    if (!loadOk) {
        logger.warn(`[Player] Load handshake failed for ${track.path}`);
        toast.error("TRACK FAILED TO LOAD — KEPT PREVIOUS TRACK");
        hideSpinnerIfCurrent(loadId);
        return;
    }
    // Commit the index only now — read, signature, decode, and handshake
    // all passed, so highlight + index + audio agree (C10).
    state.update({ currentTrackIndex: index });
    if (renderPlaylistFn) renderPlaylistFn();
    try {
        const r = tempoSlider ? parseFloat(tempoSlider.value) : 1;
        // NaN rate previously poisoned the element and threw inside the
        // loadTrack().then(playTrack) chain as an unhandled rejection (H12).
        engine.main.audio.playbackRate = Number.isFinite(r) ? Math.min(4, Math.max(0.25, r)) : 1;
    } catch { /* ignore */ }

    const hasBpm = track.bpm !== null && track.bpm !== undefined && track.bpm > 0;
    state.update({ masterBPM: hasBpm ? (track.bpm as number) : 0 });

    if (trackTitle) {
        trackTitle.innerText = hasBpm ? `${track.name} [${track.bpm}bpm]` : track.name;
    }

    // Reuse the verified decode for BPM (no second decode pass)
    const preDecoded: AudioBuffer | null = verifiedBuffer;
    verifiedBuffer = null;
    sharedBuffer = null;
    (async () => {
        try {
            const audioBuffer = preDecoded;
            if (!audioBuffer) { hideSpinnerIfCurrent(loadId); return; }
            if (_loadTrackId !== loadId) {
                hideSpinnerIfCurrent(loadId);
                return; // cancelled
            }

            // 1. Detect BPM if missing
            if (!hasBpm) {
                const detectedValue = await detectBPMWorker(audioBuffer);
                if (_loadTrackId !== loadId) {
                    hideSpinnerIfCurrent(loadId);
                    return; // cancelled
                }
                const pIdx = state.playlist.findIndex(t => t.id === track.id);
                if (pIdx >= 0) {
                    const next = [...state.playlist];
                    next[pIdx] = { ...next[pIdx], bpm: detectedValue };
                    state.update({ masterBPM: detectedValue, playlist: next });
                } else {
                    state.update({ masterBPM: detectedValue });
                }
                if (renderPlaylistFn) renderPlaylistFn();
                logger.info(`[Player] Async analysis complete: ${detectedValue} BPM`);
            }

            // Hide spinner now that analysis is done
            hideSpinnerIfCurrent(loadId);

            // 2. Final display update
            if (trackTitle && state.currentTrackIndex === index) {
                const bpmTxt = state.masterBPM > 0 ? ` [${state.masterBPM}bpm]` : "";
                trackTitle.innerText = `${track.name}${bpmTxt}`;
            }
        } catch (e) {
            logger.warn("[Player] Load/Analysis pipeline issue", e);
            hideSpinnerIfCurrent(loadId);
            // Don't show error to user — just show the track name
            if (trackTitle && state.currentTrackIndex === index) {
                trackTitle.innerText = track.name;
            }
        }
    })();
}

let crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
let crossfadeGen = 0;
/**
 * Incoming/main rate ratio established at blend start. Tempo-slider moves
 * mid-blend scale both decks by it so the BPM match survives (H9) instead
 * of the slider clobbering the incoming rate.
 */
let crossfadeRateRatio = 1;
/** Cached sampler module for per-tick tempo fan-out (H12: no import() per event). */
let _samplerMod: typeof import('./sampler') | null = null;

/** Element-safe tempo clamp — match ratios legitimately reach 0.25–4. */
function clampTempoRate(r: number): number {
    return Number.isFinite(r) ? Math.min(4, Math.max(0.25, r)) : 1;
}

/** Abort any armed blend so delete/stop can't be resurrected by a stale timer.
 * crossfadeGen IS the crossfadeToken: bumped on every startCrossfade, abort,
 * and stop so all async continuations (loadAsync, play, loadTrack chains)
 * can bail when stale. A second blend can start immediately after abort
 * because the flag + lock reset here. */
export function abortCrossfade(reason?: string): void {
    crossfadeGen++;
    if (reason) logger.debug(`[AutoMix] Crossfade aborted: ${reason}`);
    crossfadeRateRatio = 1;
    if (crossfadeTimer) { clearTimeout(crossfadeTimer); crossfadeTimer = null; }
    try { engine.crossfade.audio.pause(); } catch { /* ignore */ }
    // Reclaim the incoming blob URL — removeSelectedTracks clears src but the
    // tracked URL otherwise leaks until the next load.
    if (crossfadeBlobUrl) {
        revokeLater(crossfadeBlobUrl);
        crossfadeBlobUrl = "";
    }
    try {
        engine.main.reset();
        engine.crossfade.reset();
    } catch { /* ignore */ }
    state.update({ isCrossfadeInProgress: false });
    updateControlsLock(false);
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
}

function updateControlsLock(locked: boolean): void {
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const loopBtn = document.getElementById('loopBtn');
    // Sliders must lock too: dragging volume mid-blend executes
    // gain automation on the outgoing channel and desyncs the mix.
    // STOP stays enabled so an in-flight blend is always abortable —
    // previously stopBtn was disabled and finishCrossfade resurrected audio.
    const lockable = [progressBar, playPauseBtn, nextBtn, prevBtn, loopBtn, masterVol, tempoSlider];
    lockable.forEach(el => {
        if (el) {
            (el as HTMLButtonElement | HTMLInputElement).disabled = locked;
            el.style.opacity = locked ? '0.5' : '1';
            el.style.cursor = locked ? 'not-allowed' : 'pointer';
            el.style.pointerEvents = locked ? 'none' : 'auto';
        }
    });
}

export async function startCrossfade(targetIndex: number | null = null, customDuration: number | null = null): Promise<void> {
    const playlist = state.playlist;
    if (state.isCrossfadeInProgress || !playlist.length) return;
    // Never blend from silence — a stopped/empty deck produces a fade from nothing.
    try {
        const src = engine.main.audio?.src || '';
        if (!src || engine.main.audio.readyState === 0) {
            logger.warn('[AutoMix] Crossfade refused: deck has no loaded source');
            return;
        }
    } catch { return; }
    if (targetIndex !== null && (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= playlist.length)) {
        logger.warn(`[AutoMix] Rejected OOB crossfade target ${targetIndex}`);
        return;
    }
    
    if (!ensureAudio() || !audioCtx) { // Check if audioCtx is available before resuming
        toast.error("Audio not available for crossfade. Please refresh the page.");
        return;
    }
    // Check that all audio chain nodes are available
    const main = engine.main;
    const cross = engine.crossfade;
    if (!main.gain || !main.lowEQ || !main.midEQ || !main.highEQ || !main.lpFilter || !main.hpFilter ||
        !cross.gain || !cross.lowEQ || !cross.midEQ || !cross.highEQ || !cross.lpFilter || !cross.hpFilter) {
        toast.error("Audio chain not ready. Please restart the app.");
        return;
    }
    resumeAudioContext();
    const nextIdx = targetIndex !== null ? targetIndex : ((state.currentTrackIndex + 1) % playlist.length);
    // Only bail when auto-advancing into the track that's already loaded.
    // (Comparing against audio.src is useless here — src is a blob: URL.)
    if (targetIndex === null && nextIdx === state.currentTrackIndex) return;

    state.update({ isCrossfadeInProgress: true });
    updateControlsLock(true);
    const myGen = ++crossfadeGen;
    const expectedId = playlist[nextIdx]?.id;

    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    engine.crossfade.reset();
    const safeUrl = await getSafeUrl(playlist[nextIdx].path, false, true, playlist[nextIdx].id);
    if (myGen !== crossfadeGen || !state.isCrossfadeInProgress) return;
    if (!safeUrl) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        toast.error("NEXT TRACK UNREADABLE — CROSSFADE ABORTED");
        return;
    }
    const liveList = state.playlist;
    if (!expectedId || liveList[nextIdx]?.id !== expectedId) {
        abortCrossfade();
        return;
    }
    // Handshake the incoming deck before automating it (C13) — a dead
    // source must abort the blend, not ride silent under automation.
    const incomingOk = await engine.crossfade.loadAsync(safeUrl);
    if (myGen !== crossfadeGen || !state.isCrossfadeInProgress) return;
    if (!incomingOk) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        toast.error("NEXT TRACK UNPLAYABLE — CROSSFADE ABORTED");
        return;
    }

    // Sonetra AI: pre-warm only. Cached AI transitions are generated in the
    // background for future mixes; live AI-stem playback is NOT implemented
    // (checkbox previously implied it was). Guard indices — currentTrackIndex
    // can be -1 on an empty/fresh playlist.
    // Safety: the AI lookup + rate setup + EQ/filter/gain automation below
    // run inside one try — any throw aborts the blend (incoming stopped,
    // URL revoked, flag + lock reset) and rethrows so callers see the
    // failure instead of deadlocking with isCrossfadeInProgress stuck true.
    // Blend sound is unchanged; this only adds failure cleanup.
    try {
    const aiOn = typeof isAiEnabled === 'function' ? isAiEnabled() : settings.autoMix.enableAI;
    if (aiOn && window.sonetra) {
        const cur = playlist[state.currentTrackIndex];
        const nxt = playlist[nextIdx];
        if (cur && nxt) {
            // Check cache first so getCachedTransition is not dead code and we
            // avoid duplicate 100MB uploads when the transition already exists.
            window.sonetra.getCachedTransition(cur.path, nxt.path)
                .then((cached) => {
                    if (cached && (cached as any).success) {
                        logger.info('[AutoMix] Sonetra transition cache: hit');
                        return;
                    }
                    return window.sonetra.precomputeTransition(cur.path, nxt.path)
                        .then((r) => logger.info(`[AutoMix] Sonetra transition cache: ${r.success ? (r.cached ? 'hit' : 'generated') : r.error}`));
                })
                .catch(() => { /* offline / server down — non-fatal */ });
        }
    }

    // Mirror the outgoing ramp depths (H10): incoming starts exactly where
    // outgoing ends so the blend has no mid hole. Uses constants, not magic.
    cross.lowEQ.gain.value = settings.autoMix.eqCrossfade ? CROSSFADE_RAMP_LOW_DB : 0;
    cross.midEQ.gain.value = settings.autoMix.eqCrossfade ? CROSSFADE_RAMP_MID_DB : 0;
    cross.gain.gain.value = 0.001;
    try {
        const mainRate = engine.main.audio.playbackRate;
        cross.audio.playbackRate = clampTempoRate(mainRate);
    } catch { /* ignore */ }
    // BPM Sync (was a dead checkbox): tempo-match incoming to outgoing.
    // matched = mainRate * cur/nxt, clamped to element range 0.25–4 (H9) —
    // the old 0.5–1.5 clamp corrupted genuine 2:1 tempo matches.
    if (settings.autoMix.bpmSync) {
        const curBpm = playlist[state.currentTrackIndex]?.bpm ?? 0;
        const nxtBpm = playlist[nextIdx]?.bpm ?? 0;
        if (curBpm > 0 && nxtBpm > 0) {
            const matched = clampTempoRate(engine.main.audio.playbackRate * (curBpm / nxtBpm));
            cross.audio.playbackRate = matched;
            logger.info(`[AutoMix] BPM sync ${curBpm}->${nxtBpm} rate=${cross.audio.playbackRate.toFixed(3)}`);
        }
    }
    try {
        const base = engine.main.audio.playbackRate || 1;
        crossfadeRateRatio = cross.audio.playbackRate / base;
        if (!Number.isFinite(crossfadeRateRatio) || crossfadeRateRatio <= 0) crossfadeRateRatio = 1;
    } catch { crossfadeRateRatio = 1; }

    try {
        await engine.crossfade.audio.play();
    } catch (e) {
        if (myGen !== crossfadeGen) return;
        logger.error("AutoMix Playback Failed", e);
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        return;
    }
    if (myGen !== crossfadeGen || !state.isCrossfadeInProgress) return;
    if (state.playlist[nextIdx]?.id !== expectedId) {
        abortCrossfade();
        return;
    }

    const rawDuration = customDuration !== null ? customDuration : settings.autoMix.trackDuration;
    let duration = safeFadeSeconds(rawDuration);
    // A 60s blend on a 70s track never completes (H11): the timeupdate gate
    // needs duration*2 of runway. Cap the blend at half the outgoing length.
    try {
        const mainLen = engine.main.audio.duration;
        if (Number.isFinite(mainLen) && mainLen > 0) {
            duration = Math.min(duration, Math.max(0.5, mainLen / 2 - 0.25));
        }
    } catch { /* unknown length — keep requested duration */ }
    const now = audioCtx.currentTime;

    // --- AUTOMATION: OUTGOING (Main) ---
    // Explicit start values, never param.value-after-cancel (H10): .value
    // reads back stale intrinsics once automation is cancelled.
    if (settings.autoMix.eqCrossfade) {
        main.lowEQ.gain.cancelScheduledValues(now);
        main.lowEQ.gain.setValueAtTime(0, now);
        main.lowEQ.gain.linearRampToValueAtTime(CROSSFADE_RAMP_LOW_DB, now + duration * 0.8);
        main.midEQ.gain.cancelScheduledValues(now);
        main.midEQ.gain.setValueAtTime(0, now);
        main.midEQ.gain.linearRampToValueAtTime(CROSSFADE_RAMP_MID_DB, now + duration);
    }
    if (settings.autoMix.filterSweep) {
        main.lpFilter.frequency.cancelScheduledValues(now);
        main.lpFilter.frequency.setValueAtTime(20000, now);
        main.lpFilter.frequency.exponentialRampToValueAtTime(CROSSFADE_LP_SWEEP_HZ, now + duration);
    }
    main.gain.gain.cancelScheduledValues(now);
    main.gain.gain.setValueAtTime(1, now);
    main.gain.gain.linearRampToValueAtTime(0.001, now + duration);

    // --- AUTOMATION: INCOMING (Crossfade) ---
    if (settings.autoMix.eqCrossfade) {
        cross.lowEQ.gain.cancelScheduledValues(now);
        cross.lowEQ.gain.setValueAtTime(CROSSFADE_RAMP_LOW_DB, now);
        cross.lowEQ.gain.linearRampToValueAtTime(0, now + duration * 0.8);
        cross.midEQ.gain.cancelScheduledValues(now);
        cross.midEQ.gain.setValueAtTime(CROSSFADE_RAMP_MID_DB, now);
        cross.midEQ.gain.linearRampToValueAtTime(0, now + duration);
    }
    if (settings.autoMix.hpfSweep) {
        cross.hpFilter.frequency.cancelScheduledValues(now);
        cross.hpFilter.frequency.setValueAtTime(CROSSFADE_HP_SWEEP_HZ, now);
        cross.hpFilter.frequency.exponentialRampToValueAtTime(30, now + duration * 0.8);
    }
    cross.gain.gain.cancelScheduledValues(now);
    cross.gain.gain.setValueAtTime(0.001, now);
    cross.gain.gain.linearRampToValueAtTime(1, now + duration);

    const gen = myGen;
    if (crossfadeTimer) clearTimeout(crossfadeTimer);
    crossfadeTimer = setTimeout(() => {
        crossfadeTimer = null;
        if (gen !== crossfadeGen) return;
        finishCrossfade(nextIdx, expectedId);
    }, duration * 1000);
    } catch (e) {
        // Abort only if this blend is still current — a concurrent abort/stop
        // already bumped the token and a newer blend may be running; aborting
        // again would clobber it. Rethrow preserves the rejection for callers.
        if (myGen === crossfadeGen) abortCrossfade('automation-failed');
        throw e;
    }
}

function finishCrossfade(nextIndex: number, expectedId?: string): void {
    // Stale timer (aborted by stop/delete) must never resurrect audio.
    if (!state.isCrossfadeInProgress) return;
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= state.playlist.length) {
        abortCrossfade();
        return;
    }
    if (expectedId && state.playlist[nextIndex]?.id !== expectedId) {
        abortCrossfade();
        return;
    }
    if (!engine.crossfade.audio.src) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        // STOP-during-load guard: a stop/abort bumps the token while
        // loadTrack is in flight; the stale continuation must not resurrect.
        const _tok = crossfadeGen;
        loadTrack(nextIndex).then(() => { if (_tok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
        return;
    }

    // PROMOTE channel
    engine.swapChannels();

    // Swap tracked blob URLs safely
    const oldMainUrl = mainBlobUrl;
    mainBlobUrl = crossfadeBlobUrl;
    crossfadeBlobUrl = "";

    // Nuking the old main only after it's definitely stopped and a new one is playing.
    if (oldMainUrl) revokeLater(oldMainUrl, BLOB_REVOKE_CROSSFADE_MS);

    // Master BPM follows the PROMOTED track (H8) — tempo display, SYNC
    // rate, and BPM-sync math all keyed off the outgoing BPM before.
    const promotedBpm = state.playlist[nextIndex]?.bpm ?? 0;
    state.update({
        currentTrackIndex: nextIndex,
        isCrossfadeInProgress: false,
        masterBPM: promotedBpm > 0 ? promotedBpm : 0,
    });
    crossfadeRateRatio = 1;
    updateControlsLock(false);

    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');


    if (renderPlaylistFn) renderPlaylistFn();
    if (trackTitle && state.playlist.length > nextIndex) {
         const t = state.playlist[nextIndex];
         const txt = (t.bpm && t.bpm > 0) ? `[${t.bpm} BPM]` : "[BPM: --]";
         trackTitle.innerText = `${t.name} ${txt}`;
     }
    // Incoming channel's loadedmetadata was ignored mid-blend (not main yet) —
    // refresh total time from the promoted element.
    try {
        const d = engine.main.audio.duration;
        if (totalTimeDisplay && Number.isFinite(d) && d > 0) totalTimeDisplay.innerText = formatTime(d);
    } catch { /* ignore */ }
}

export function playTrack(): void {
    if (state.isCrossfadeInProgress || !state.playlist.length || !engine.main.audio) return;
    if (!ensureAudio() || !audioCtx) { // Check if audioCtx is available
        toast.error("Audio not available. Please refresh the page.");
        return;
    }
    void playTrackAsync().catch(() => undefined);
}

async function playTrackAsync(): Promise<void> {
    if (state.isCrossfadeInProgress || !state.playlist.length || !engine.main.audio) return;
    // Token against STOP-during-load resurrection: stop/abort bump it, so any
    // continuation after an await bails instead of replaying a dead deck.
    const _tok = crossfadeGen;
    // A closed-context rebuild swaps in an empty <audio> element (C7) — the
    // old blob: URL is gone, so re-load the current track instead of playing
    // silence while the UI claims playback.
    if (engine.main.needsReload) {
        const idx = state.currentTrackIndex;
        if (idx >= 0 && idx < state.playlist.length) {
            logger.warn('[Player] Deck rebuilt — re-loading current track');
            void loadTrack(idx).then(() => { if (_tok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
        } else {
            toast.error("AUDIO DEVICE CHANGED — RELOAD A TRACK");
        }
        return;
    }
    // Chain play() after the resume attempt (H12): firing play() into a
    // suspended context rejects and leaves the UI claiming playback.
    try { await resumeAudioContext(); } catch { /* play attempt still runs below */ }
    if (_tok !== crossfadeGen) return;
    if (state.isCrossfadeInProgress) return;
    try {
        await engine.main.audio.play();
        if (_tok !== crossfadeGen) return;
        state.update({ isPlaying: true });
        updateControlsLock(false);
    } catch (e) {
        logger.error('[Player] play() failed', e);
    }
}

export function pauseTrack(): void {
    if (state.isCrossfadeInProgress) return;
    if (engine.main.audio) engine.main.audio.pause();
    state.update({ isPlaying: false });
}

export function stopPlayback(): void {
    // Abort any pending blend first so finishCrossfade can't resurrect audio.
    // Also invalidate in-flight loadTrack decodes that would swap title/BPM under a stopped UI.
    _loadTrackId++;
    // Shared abort path: bumps the token (stale loadTrack/play continuations
    // bail), clears the timer, stops the incoming deck, revokes its URL,
    // cancels automation via reset, and resets flag + lock.
    abortCrossfade('stop');
    try { engine.main.audio.pause(); } catch { /* ignore */ }
    try { engine.main.audio.currentTime = 0; } catch { /* sourceless element — ignore (M9) */ }
    try { engine.crossfade.audio.src = ""; } catch { /* ignore */ }

    state.update({ isPlaying: false });
    // stopPlayback invalidates in-flight loadTrack generations, which makes
    // hideSpinnerIfCurrent(loadId) a no-op for the superseded load — the
    // spinner would stick forever on stop-during-slow-load. Hide directly.
    try { trackSpinner?.classList.remove('active'); } catch { /* ignore */ }

    if (progressBar) progressBar.value = "0";
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
}

export function setupPlayerHandlers(): void {
    // Wire BOTH channel elements. swapChannels() promotes the other element
    // after every crossfade — listeners bound to a single element die with the
    // first swap, freezing the progress bar and auto-advance. Each listener
    // guards on element identity so only the CURRENT main channel acts.
    for (const channel of [engine.main, engine.crossfade]) {
        wireChannelHandlers(channel.audio);
        // AudioContext rebuilds recreate the <audio> element — rewire it.
        channel.onReplaced = (newAudio) => wireChannelHandlers(newAudio);
    }
    setupTransportHandlers();
}

function wireChannelHandlers(el: HTMLAudioElement): void {
    if (!el || (el as any).__ugWired) return;
    (el as any).__ugWired = true;

    const isCurrentMain = () => engine.main.audio === el;

    // Element-driven truth (H12): external pauses (device loss, auto-pause)
    // and stall-then-start must reflect in state, not just play()/pause().
    el.addEventListener('pause', () => {
        if (!isCurrentMain()) return;
        if (state.isPlaying) state.update({ isPlaying: false });
    });
    el.addEventListener('playing', () => {
        if (!isCurrentMain()) return;
        if (!state.isPlaying) state.update({ isPlaying: true });
    });

    el.addEventListener('timeupdate', () => {
        if (!isCurrentMain()) return;
        if (!isDraggingProgress && el.duration) {
            const progress = (el.currentTime / el.duration) * 100;
            if (progressBar) progressBar.value = progress.toString();
            if (timeDisplay) timeDisplay.innerText = formatTime(el.currentTime);
            const fadeSecs = safeFadeSeconds();
            if (state.isAutoMixEnabled && !state.isCrossfadeInProgress && el.duration > fadeSecs * 2) {
                if (el.currentTime >= el.duration - fadeSecs) {
                    void startCrossfade().catch(() => undefined);
                }
            }
        }
    });

    el.addEventListener('ended', () => {
        if (!isCurrentMain()) return;
        if (state.isCrossfadeInProgress) return;
        if (state.isAutoMixEnabled) {
            // Short tracks never reach the timeupdate crossfade threshold
            // (duration <= 2*trackDuration). Advance instead of stalling dead.
            if (state.loopMode === 'one') {
                el.currentTime = 0;
                el.play().catch(() => undefined);
                return;
            }
            let nextIndex = state.currentTrackIndex + 1;
            if (nextIndex >= state.playlist.length) {
                if (state.loopMode === 'all') nextIndex = 0;
                else { stopPlayback(); return; }
            }
            const _autoTok = crossfadeGen;
            loadTrack(nextIndex).then(() => { if (_autoTok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
            return;
        }
        if (!state.isAutoMixEnabled && !state.isCrossfadeInProgress) {
            if (state.loopMode === 'one') {
                el.currentTime = 0;
                el.play().catch(() => undefined);
                return;
            }

            if (state.playbackMode === 'single') stopPlayback();
            else {
                let nextIndex = state.currentTrackIndex + 1;
                if (nextIndex >= state.playlist.length) {
                    if (state.loopMode === 'all') nextIndex = 0;
                    else { stopPlayback(); return; }
                }
                const _advTok = crossfadeGen;
                loadTrack(nextIndex).then(() => { if (_advTok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
            }
        }
    });

    el.addEventListener('loadedmetadata', () => {
        if (!isCurrentMain()) return;
        if (totalTimeDisplay && el.duration) {
            totalTimeDisplay.innerText = formatTime(el.duration);
        }
    });
}

function setupTransportHandlers(): void {
    if (progressBar) {
        progressBar.oninput = (e: Event) => {
            isDraggingProgress = true;
            const target = e.target as HTMLInputElement;
            if (engine.main.audio.duration && timeDisplay) {
                 const seekTime = (parseFloat(target.value) / 100) * engine.main.audio.duration;
                 timeDisplay.innerText = formatTime(seekTime);
            }
        };
        progressBar.onchange = (e: Event) => {
            isDraggingProgress = false;
            if (state.isCrossfadeInProgress) return;
            const target = e.target as HTMLInputElement;
            try {
                const d = engine.main.audio.duration;
                const ratio = parseFloat(target.value) / 100;
                if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(ratio)) return;
                if (engine.main.audio.readyState === 0 || !engine.main.audio.src) return;
                const seekable = engine.main.audio.seekable;
                // Silent ignore previously made fresh-blob drags feel broken.
                if (seekable && seekable.length === 0) { try { toast.info('TRACK STILL LOADING — SEEK NOT READY'); } catch { /* ignore */ } return; }
                engine.main.audio.currentTime = Math.min(Math.max(0, ratio * d), d);
            } catch { /* seeking during load/after delete must not throw */ }
        };
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.onclick = () => {
            if (state.isCrossfadeInProgress || !state.playlist.length) return;
            if (state.isAutoMixEnabled) void startCrossfade(null, settings.autoMix.btnDuration).catch(() => undefined);
            else {
                const nextIdx = (state.currentTrackIndex + 1) % state.playlist.length;
                const _nextTok = crossfadeGen;
                loadTrack(nextIdx).then(() => { if (_nextTok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
            }
        };
    }

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.onclick = () => {
            if (state.isCrossfadeInProgress || !state.playlist.length) return;
            if (state.isAutoMixEnabled) void startCrossfade((state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length, settings.autoMix.btnDuration).catch(() => undefined);
            else {
                const prevIdx = (state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length;
                const _prevTok = crossfadeGen;
                loadTrack(prevIdx).then(() => { if (_prevTok !== crossfadeGen) return; playTrack(); }).catch(() => undefined);
            }
        };
    }

    if (tempoSlider) {
        const slider = tempoSlider;
        slider.oninput = (e: Event) => {
            const target = e.target as HTMLInputElement;
            let val = parseFloat(target.value);
            if (!Number.isFinite(val)) return;
            val = Math.min(1.5, Math.max(0.5, val));
            if (Math.abs(val - 1.0) < SLIDER_SNAP_THRESHOLD) { val = 1.0; slider.value = "1.0"; }
            try { engine.main.audio.playbackRate = val; } catch { /* ignore */ }
            // Mid-blend the incoming deck follows at the blend-start ratio so
            // slider moves scale the whole mix without breaking the BPM match
            // (H9) — the old absolute assignment destroyed the match.
            try {
                if (state.isCrossfadeInProgress) {
                    engine.crossfade.audio.playbackRate = clampTempoRate(val * crossfadeRateRatio);
                }
            } catch { /* ignore */ }
            // Cached module: the old void import() per input event re-fetched
            // the chunk on every tempo tick (H12).
            try {
                const applyTempo = (m: typeof import('./sampler')): void => {
                    for (const [k, v] of Object.entries(m.activeVoices)) {
                        if (!v?.source) continue;
                        // SYNC voices were previously skipped here, freezing
                        // them at the old tempo while everything else moved
                        // (desync — the opposite of SYNC's intent). Recompute
                        // their BPM-matched rate from the new slider value.
                        try {
                            if ((m.padSyncState as unknown as Record<number, boolean>)[Number(k)]) {
                                const pb = (m.padBPMs as unknown as Record<number, number>)[Number(k)] ?? 0;
                                const mb = state.masterBPM ?? 0;
                                const r = (pb > 0 && mb > 0) ? val * (mb / pb) : val;
                                v.source.playbackRate.value = clampTempoRate(r);
                            } else {
                                v.source.playbackRate.value = val;
                            }
                        } catch { /* ignore */ }
                    }
                };
                if (_samplerMod) applyTempo(_samplerMod);
                else {
                    void import('./sampler').then(m => {
                        _samplerMod = m;
                        applyTempo(m);
                    }).catch(() => undefined);
                }
            } catch { /* ignore */ }
            if (tempoVal) {
                const displayBpm = state.masterBPM > 0 ? Math.round(state.masterBPM * val) : "---";
                tempoVal.innerText = `SPEED: ${Math.round(val * 100)}% (BPM: ${displayBpm})`;
            }
        };
    }

    if (playPauseBtn) playPauseBtn.onclick = () => {
        if (state.isCrossfadeInProgress) return;
        state.isPlaying ? pauseTrack() : playTrack();
    };
    if (stopBtn) stopBtn.onclick = stopPlayback;
    if (autoMixBtn) autoMixBtn.onclick = toggleAutoMix;

    if (masterVol) {
        // Knob is 45px wide and centered via translate(-50%, -50%), so its
        // center must travel inset: 22.5px at 0%, (100% - 24.5px) at 100%.
        // NOTE: calc() with `*` is invalid in some browsers and gets dropped,
        // leaving the knob stuck at its CSS default (overflowing the track).
        // Solve the multiply in JS and emit a plain `pct% +/- px` calc.
        const positionVolKnob = (raw: number): void => {
            if (!volKnob) return;
            const v = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 1));
            volKnob.innerText = Math.round(v * 100) + '%';
            const pct = v * 100;
            const px = 22.5 - 47 * v;
            volKnob.style.left = px < 0
                ? `calc(${pct.toFixed(2)}% - ${Math.abs(px).toFixed(2)}px)`
                : `calc(${pct.toFixed(2)}% + ${px.toFixed(2)}px)`;
        };
        masterVol.oninput = () => {
            // Master volume belongs ONLY to masterGain — touching the channel
            // gain here would stomp crossfade fade automation.
            const val = parseFloat(masterVol!.value);
            if (masterGain && Number.isFinite(val)) {
                try {
                    masterGain.gain.setTargetAtTime(Math.min(1, Math.max(0, val)), masterGain.context.currentTime, 0.02);
                } catch { try { masterGain.gain.value = val; } catch { /* ignore */ } }
            }
            positionVolKnob(val);
        };
        // Sync knob on init so first paint (and session/crash restores that
        // dispatch `input`) starts inside the track instead of overflowing.
        positionVolKnob(parseFloat(masterVol.value));
    }
}

/**
 * Hide the track spinner only if the given loadId is still the current one.
 * Prevents stale async completions from hiding the spinner for a newer loadTrack call.
 */
function hideSpinnerIfCurrent(loadId: number): void {
    if (_loadTrackId === loadId && trackSpinner) {
        trackSpinner.classList.remove('active');
    }
}

function formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
