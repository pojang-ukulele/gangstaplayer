// === PLAYER MODULE ===
import { audioCtx, resumeAudioContext, masterGain } from './audio';
import { settings } from './settings';
import { state, Track, PlaybackMode, LoopMode } from './state';
import { detectBPMWorker } from './worker-client';
import { toast } from './toast';
import { engine } from './audio-engine';
import { logger } from './logger';
import { normalizeToArrayBuffer } from './utils';
import { showConfirm } from './modals';
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
function revokeLater(url: string, delay = 5000): void {
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

async function getSafeUrl(filePath: string, isMain: boolean): Promise<string> {
    try {
        const rawData = await window.fileSystem.readFile(filePath);
        if (!rawData) {
            logger.warn(`[SafeURL] File unreadable: ${filePath}`);
            return filePath;
        }
        
        const arrayBuffer = normalizeToArrayBuffer(rawData);
        const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        
        if (isMain) {
            if (mainBlobUrl) revokeLater(mainBlobUrl);
            mainBlobUrl = url;
        } else {
            if (crossfadeBlobUrl) revokeLater(crossfadeBlobUrl);
            crossfadeBlobUrl = url;
        }
        return url;
    } catch (e) {
        logger.error("[SafeURL] Failed to create blob", e);
        return filePath; 
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
    engine.main.audio.loop = (mode === 'one');
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

export async function loadTrack(index: number): Promise<void> {
    const playlist = state.playlist;
    if (!playlist.length || index < 0 || index >= playlist.length) return;
    const track = playlist[index];
    state.update({ currentTrackIndex: index });
    if (renderPlaylistFn) renderPlaylistFn();
    
    engine.main.reset();
    logger.info(`[Player] Loading track: ${track.name} [ID: ${track.id}]`);
    const safeUrl = await getSafeUrl(track.path, true);
    engine.main.load(safeUrl);
    engine.main.audio.playbackRate = tempoSlider ? parseFloat(tempoSlider.value) : 1;
    
    const hasBpm = track.bpm !== null && track.bpm !== undefined && track.bpm > 0;
    state.update({ masterBPM: hasBpm ? (track.bpm as number) : 0 });

    if (trackTitle) {
        trackTitle.innerText = hasBpm ? `${track.name} [${track.bpm}bpm]` : track.name;
    }

    // Cancellation guard: if loadTrack is called again before this finishes, skip stale results
    const loadId = ++_loadTrackId;

    // Show spinner during async load (decoding + BPM analysis)
    if (trackSpinner) trackSpinner.classList.add('active');

    // Single-pass high-performance decoding
    (async () => {
        try {
            const rawData = await window.fileSystem.readFile(track.path);
            if (_loadTrackId !== loadId) {
                hideSpinnerIfCurrent(loadId, index);
                return; // cancelled by newer loadTrack call
            }
            
            const arrayBuffer = normalizeToArrayBuffer(rawData);
            
            // Use native decoder (reliable)
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            if (_loadTrackId !== loadId) {
                hideSpinnerIfCurrent(loadId, index);
                return; // cancelled
            }

            // 1. Detect BPM if missing
            if (!hasBpm) {
                const detectedValue = await detectBPMWorker(audioBuffer);
                if (_loadTrackId !== loadId) {
                    hideSpinnerIfCurrent(loadId, index);
                    return; // cancelled
                }
                track.bpm = detectedValue;
                state.update({ masterBPM: detectedValue });
                logger.info(`[Player] Async analysis complete: ${detectedValue} BPM`);
            }

            // Hide spinner now that analysis is done
            hideSpinnerIfCurrent(loadId, index);

            // 2. Final display update
            if (trackTitle && state.currentTrackIndex === index) {
                const bpmTxt = state.masterBPM > 0 ? ` [${state.masterBPM}bpm]` : "";
                trackTitle.innerText = `${track.name}${bpmTxt}`;
            }
        } catch (e) {
            logger.warn("[Player] Load/Analysis pipeline issue", e);
            hideSpinnerIfCurrent(loadId, index);
            // Don't show error to user — just show the track name
            if (trackTitle && state.currentTrackIndex === index) {
                trackTitle.innerText = track.name;
            }
        }
    })();
}

function updateControlsLock(locked: boolean): void {
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const lockable = [progressBar, playPauseBtn, stopBtn, nextBtn, prevBtn];
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
    
    if (!audioCtx) { // Check if audioCtx is available before resuming
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
    if (playlist[nextIdx].path === engine.main.audio.src && !targetIndex) return; 

    state.update({ isCrossfadeInProgress: true });
    updateControlsLock(true);

    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    engine.crossfade.reset();
    const safeUrl = await getSafeUrl(playlist[nextIdx].path, false);
    engine.crossfade.load(safeUrl);
    
    cross.lowEQ.gain.value = settings.autoMix.eqCrossfade ? -24 : 0;
    cross.midEQ.gain.value = settings.autoMix.eqCrossfade ? -6 : 0;
    cross.gain.gain.value = 0.001;
    cross.audio.playbackRate = engine.main.audio.playbackRate;

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

    const duration = customDuration !== null ? customDuration : settings.autoMix.trackDuration;
    const now = audioCtx.currentTime;

    // --- AUTOMATION: OUTGOING (Main) ---
    if (settings.autoMix.eqCrossfade) {
        main.lowEQ.gain.cancelScheduledValues(now);
        main.lowEQ.gain.setValueAtTime(0, now);
        main.lowEQ.gain.linearRampToValueAtTime(-24, now + duration * 0.8);
        main.midEQ.gain.linearRampToValueAtTime(-12, now + duration);
    }
    if (settings.autoMix.filterSweep) {
        main.lpFilter.frequency.cancelScheduledValues(now);
        main.lpFilter.frequency.setValueAtTime(20000, now);
        main.lpFilter.frequency.exponentialRampToValueAtTime(600, now + duration);
    }
    main.gain.gain.cancelScheduledValues(now);
    main.gain.gain.setValueAtTime(main.gain.gain.value, now);
    main.gain.gain.linearRampToValueAtTime(0.001, now + duration);

    // --- AUTOMATION: INCOMING (Crossfade) ---
    if (settings.autoMix.eqCrossfade) {
        cross.lowEQ.gain.cancelScheduledValues(now);
        cross.lowEQ.gain.setValueAtTime(-24, now);
        cross.lowEQ.gain.linearRampToValueAtTime(0, now + duration * 0.8); 
        cross.midEQ.gain.linearRampToValueAtTime(0, now + duration);
    }
    if (settings.autoMix.hpfSweep) {
        cross.hpFilter.frequency.cancelScheduledValues(now);
        cross.hpFilter.frequency.setValueAtTime(2000, now);
        cross.hpFilter.frequency.exponentialRampToValueAtTime(30, now + duration * 0.8);
    }
    cross.gain.gain.cancelScheduledValues(now);
    cross.gain.gain.setValueAtTime(0.001, now);
    cross.gain.gain.linearRampToValueAtTime(1, now + duration);

    setTimeout(() => { finishCrossfade(nextIdx); }, duration * 1000);
}

function finishCrossfade(nextIndex: number): void {
    if (!engine.crossfade.audio.src) {
        state.update({ isCrossfadeInProgress: false });
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        loadTrack(nextIndex).then(playTrack); 
        return;
    }
    
    // PROMOTE channel
    engine.swapChannels();
    
    // Swap tracked blob URLs safely
    const oldMainUrl = mainBlobUrl; 
    mainBlobUrl = crossfadeBlobUrl;
    crossfadeBlobUrl = ""; 
    
    // Nuking the old main only after it's definitely stopped and a new one is playing.
    if (oldMainUrl) revokeLater(oldMainUrl, 3000);

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
}

export function playTrack(): void {
    if (state.isCrossfadeInProgress || !state.playlist.length || !engine.main.audio) return;
    if (!audioCtx) { // Check if audioCtx is available
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
    engine.main.audio.pause();
    engine.main.audio.currentTime = 0;
    engine.crossfade.audio.pause();
    engine.crossfade.audio.src = "";
    
    state.update({ isPlaying: false, isCrossfadeInProgress: false });
    updateControlsLock(false);
    
    if (progressBar) progressBar.value = "0";
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
}

export function setupPlayerHandlers(): void {
    if (!engine.main.audio) return;
    
    engine.main.audio.ontimeupdate = () => {
        if (!isDraggingProgress && engine.main.audio.duration) {
            const progress = (engine.main.audio.currentTime / engine.main.audio.duration) * 100;
            if (progressBar) progressBar.value = progress.toString();
            if (timeDisplay) timeDisplay.innerText = formatTime(engine.main.audio.currentTime);
            if (state.isAutoMixEnabled && !state.isCrossfadeInProgress && engine.main.audio.duration > settings.autoMix.trackDuration * 2) {
                if (engine.main.audio.currentTime >= engine.main.audio.duration - settings.autoMix.trackDuration) {
                    startCrossfade();
                }
            }
        }
    };

    engine.main.audio.onended = () => {
        if (!state.isAutoMixEnabled && !state.isCrossfadeInProgress) {
            if (state.loopMode === 'one') {
                engine.main.audio.currentTime = 0;
                engine.main.audio.play();
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
    };

    engine.main.audio.onloadedmetadata = () => {
        if (totalTimeDisplay && engine.main.audio.duration) {
            totalTimeDisplay.innerText = formatTime(engine.main.audio.duration);
        }
    };

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
            if (state.isCrossfadeInProgress) return;
            const target = e.target as HTMLInputElement;
            if (engine.main.audio.duration) {
                engine.main.audio.currentTime = (parseFloat(target.value) / 100) * engine.main.audio.duration;
            }
            isDraggingProgress = false;
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
        tempoSlider.oninput = (e: Event) => {
            const target = e.target as HTMLInputElement;
            let val = parseFloat(target.value);
            if (Math.abs(val - 1.0) < 0.05) { val = 1.0; tempoSlider.value = "1.0"; }
            engine.main.audio.playbackRate = val;
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
            const val = parseFloat(masterVol!.value);
            if (engine.main.gain) {
                engine.main.gain.gain.value = 1.0;
            }
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
function hideSpinnerIfCurrent(loadId: number, expectedIndex: number): void {
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
