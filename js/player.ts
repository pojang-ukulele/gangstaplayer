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

async function getSafeUrl(filePath: string, isMain: boolean, verifyDecode = false): Promise<string> {
    try {
        const rawData = await window.fileSystem.readFile(filePath);
        if (!rawData) {
            logger.warn(`[SafeURL] File unreadable: ${filePath}`);
            return "";
        }
        const arrayBuffer = normalizeToArrayBuffer(rawData);
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
            logger.warn(`[SafeURL] Rejected bad size (${arrayBuffer.byteLength}): ${filePath}`);
            return "";
        }
        const sigErr = validateAudioSignature(arrayBuffer);
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
    for (const url of [mainBlobUrl, crossfadeBlobUrl]) {
        if (url && url.startsWith('blob:')) {
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
    const loadId = ++_loadTrackId;
    state.update({ currentTrackIndex: index });
    if (renderPlaylistFn) renderPlaylistFn();
    
    engine.main.reset();
    logger.info(`[Player] Loading track: ${track.name} [ID: ${track.id}]`);
    // Single IPC read shared by playback blob + decode/BPM. Previously this
    // read the file twice (2x I/O, 2x RAM, TOCTOU). decodeAudioData detaches
    // its input, so the blob gets a copy.
    let sharedBuffer: ArrayBuffer | null = null;
    try {
        const rawData = await window.fileSystem.readFile(track.path);
        if (rawData) sharedBuffer = normalizeToArrayBuffer(rawData);
    } catch (e) {
        logger.warn(`[Player] Read failed for ${track.path}`, e);
    }
    if (loadId !== _loadTrackId) return;
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
    const sigErr = validateAudioSignature(sharedBuffer);
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
    try {
        if (ensureAudio() && audioCtx && sharedBuffer) {
            const verifyCopy = sharedBuffer.slice(0);
            verifiedBuffer = await audioCtx.decodeAudioData(verifyCopy);
        }
    } catch (decErr) {
        logger.warn(`[Player] Decode verification failed for ${track.path}`, decErr);
        toast.error("TRACK UNDECODABLE — KEPT PREVIOUS TRACK");
        hideSpinnerIfCurrent(loadId);
        return;
    }
    if (loadId !== _loadTrackId) { hideSpinnerIfCurrent(loadId); return; }
    const blobCopy = sharedBuffer.slice(0);
    const safeUrl = trackBlobUrl(URL.createObjectURL(new Blob([blobCopy], { type: 'audio/mpeg' })), true);
    engine.main.load(safeUrl);
    engine.main.audio.playbackRate = tempoSlider ? parseFloat(tempoSlider.value) : 1;

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

/** Abort any armed blend so delete/stop can't be resurrected by a stale timer. */
export function abortCrossfade(): void {
    crossfadeGen++;
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

    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    engine.crossfade.reset();
    const safeUrl = await getSafeUrl(playlist[nextIdx].path, false, true);
    if (!safeUrl) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        toast.error("NEXT TRACK UNREADABLE — CROSSFADE ABORTED");
        return;
    }
    engine.crossfade.load(safeUrl);

    // Sonetra AI: pre-warm only. Cached AI transitions are generated in the
    // background for future mixes; live AI-stem playback is NOT implemented
    // (checkbox previously implied it was). Guard indices — currentTrackIndex
    // can be -1 on an empty/fresh playlist.
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

    cross.lowEQ.gain.value = settings.autoMix.eqCrossfade ? -24 : 0;
    cross.midEQ.gain.value = settings.autoMix.eqCrossfade ? -6 : 0;
    cross.gain.gain.value = 0.001;
    cross.audio.playbackRate = engine.main.audio.playbackRate;
    // BPM Sync (was a dead checkbox): tempo-match incoming to outgoing.
    if (settings.autoMix.bpmSync) {
        const curBpm = playlist[state.currentTrackIndex]?.bpm ?? 0;
        const nxtBpm = playlist[nextIdx]?.bpm ?? 0;
        if (curBpm > 0 && nxtBpm > 0) {
            const matched = engine.main.audio.playbackRate * (curBpm / nxtBpm);
            cross.audio.playbackRate = Math.min(1.5, Math.max(0.5, matched));
            logger.info(`[AutoMix] BPM sync ${curBpm}->${nxtBpm} rate=${cross.audio.playbackRate.toFixed(3)}`);
        }
    }

    try {
        await engine.crossfade.audio.play();
    } catch (e) {
        logger.error("AutoMix Playback Failed", e);
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        return;
    }

    const rawDuration = customDuration !== null ? customDuration : settings.autoMix.trackDuration;
    const duration = Number.isFinite(rawDuration) ? Math.min(60, Math.max(0.5, rawDuration)) : settings.autoMix.trackDuration;
    const now = audioCtx.currentTime;

    // --- AUTOMATION: OUTGOING (Main) ---
    if (settings.autoMix.eqCrossfade) {
        main.lowEQ.gain.cancelScheduledValues(now);
        main.lowEQ.gain.setValueAtTime(0, now);
        main.lowEQ.gain.linearRampToValueAtTime(CROSSFADE_RAMP_LOW_DB, now + duration * 0.8);
        main.midEQ.gain.cancelScheduledValues(now);
        main.midEQ.gain.setValueAtTime(main.midEQ.gain.value, now);
        main.midEQ.gain.linearRampToValueAtTime(CROSSFADE_RAMP_MID_DB, now + duration);
    }
    if (settings.autoMix.filterSweep) {
        main.lpFilter.frequency.cancelScheduledValues(now);
        main.lpFilter.frequency.setValueAtTime(20000, now);
        main.lpFilter.frequency.exponentialRampToValueAtTime(CROSSFADE_LP_SWEEP_HZ, now + duration);
    }
    main.gain.gain.cancelScheduledValues(now);
    main.gain.gain.setValueAtTime(main.gain.gain.value, now);
    main.gain.gain.linearRampToValueAtTime(0.001, now + duration);

    // --- AUTOMATION: INCOMING (Crossfade) ---
    if (settings.autoMix.eqCrossfade) {
        cross.lowEQ.gain.cancelScheduledValues(now);
        cross.lowEQ.gain.setValueAtTime(CROSSFADE_RAMP_LOW_DB, now);
        cross.lowEQ.gain.linearRampToValueAtTime(0, now + duration * 0.8);
        cross.midEQ.gain.cancelScheduledValues(now);
        cross.midEQ.gain.setValueAtTime(cross.midEQ.gain.value, now);
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

    const gen = ++crossfadeGen;
    if (crossfadeTimer) clearTimeout(crossfadeTimer);
    crossfadeTimer = setTimeout(() => {
        crossfadeTimer = null;
        if (gen !== crossfadeGen) return;
        finishCrossfade(nextIdx);
    }, duration * 1000);
}

function finishCrossfade(nextIndex: number): void {
    // Stale timer (aborted by stop/delete) must never resurrect audio.
    if (!state.isCrossfadeInProgress) return;
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= state.playlist.length) {
        abortCrossfade();
        return;
    }
    if (!engine.crossfade.audio.src) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        loadTrack(nextIndex).then(playTrack).catch(() => undefined);
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

    state.update({ currentTrackIndex: nextIndex, isCrossfadeInProgress: false });
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
    resumeAudioContext();
    engine.main.audio.play().then(() => {
        state.update({ isPlaying: true });
        updateControlsLock(false);
    }).catch((e) => logger.error(e));
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
    crossfadeGen++;
    if (crossfadeTimer) { clearTimeout(crossfadeTimer); crossfadeTimer = null; }
    engine.main.audio.pause();
    engine.main.audio.currentTime = 0;
    engine.crossfade.audio.pause();
    engine.crossfade.audio.src = "";

    // Cancel any in-flight crossfade automation — otherwise scheduled gain/EQ
    // ramps keep running and the next replay starts muted or swept.
    engine.main.reset();
    engine.crossfade.reset();

    // The crossfade source is dead now; reclaim its blob URL
    if (crossfadeBlobUrl) {
        revokeLater(crossfadeBlobUrl);
        crossfadeBlobUrl = "";
    }

    state.update({ isPlaying: false, isCrossfadeInProgress: false });
    updateControlsLock(false);

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

    el.addEventListener('timeupdate', () => {
        if (!isCurrentMain()) return;
        if (!isDraggingProgress && el.duration) {
            const progress = (el.currentTime / el.duration) * 100;
            if (progressBar) progressBar.value = progress.toString();
            if (timeDisplay) timeDisplay.innerText = formatTime(el.currentTime);
            if (state.isAutoMixEnabled && !state.isCrossfadeInProgress && el.duration > settings.autoMix.trackDuration * 2) {
                if (el.currentTime >= el.duration - settings.autoMix.trackDuration) {
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
            loadTrack(nextIndex).then(() => playTrack());
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
                loadTrack(nextIndex).then(() => playTrack());
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
                if (seekable && seekable.length === 0) return;
                engine.main.audio.currentTime = Math.min(Math.max(0, ratio * d), d);
            } catch { /* seeking during load/after delete must not throw */ }
        };
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.onclick = () => {
            if (state.isCrossfadeInProgress || !state.playlist.length) return;
            if (state.isAutoMixEnabled) startCrossfade(null, settings.autoMix.btnDuration);
            else {
                const nextIdx = (state.currentTrackIndex + 1) % state.playlist.length;
                loadTrack(nextIdx).then(playTrack);
            }
        };
    }

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.onclick = () => {
            if (state.isCrossfadeInProgress || !state.playlist.length) return;
            if (state.isAutoMixEnabled) startCrossfade((state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length, settings.autoMix.btnDuration);
            else {
                const prevIdx = (state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length;
                loadTrack(prevIdx).then(playTrack);
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
            // Keep the incoming deck in sync mid-blend — previously only main moved.
            try {
                if (state.isCrossfadeInProgress) engine.crossfade.audio.playbackRate = val;
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
        masterVol.oninput = () => {
            // Master volume belongs ONLY to masterGain — touching the channel
            // gain here would stomp crossfade fade automation.
            const val = parseFloat(masterVol!.value);
            if (masterGain) {
                masterGain.gain.value = val;
            }
            if (volKnob) {
                volKnob.innerText = Math.round(val * 100) + '%';
                volKnob.style.left = `calc(22.5px + (100% - 47px) * ${val})`;
            }
        };
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
