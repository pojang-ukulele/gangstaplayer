// === PLAYER MODULE ===
import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants';
import { audioCtx, resumeAudioContext, masterGain } from './audio';
import { settings } from './settings';
import { state, Track, PlaybackMode, LoopMode } from './state';
import { detectBPMWorker } from './worker-client';
import { toast } from './toast';
import { engine } from './audio-engine';
import { logger } from './logger';

interface PlayerDeps {
    playlist: Track[];
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
        const rawData = await (window as any).fileSystem.readFile(filePath);
        const blob = new Blob([rawData], { type: 'audio/mpeg' });
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
        return filePath; // Fallback
    }
}

// Local UI references
let isDraggingProgress = false;
let playPauseBtn: HTMLElement | null = null;
let stopBtn: HTMLElement | null = null;
let trackTitle: HTMLElement | null = null;
let progressBar: HTMLInputElement | null = null;
let timeDisplay: HTMLElement | null = null;
let totalTimeDisplay: HTMLElement | null = null;
let tempoSlider: HTMLInputElement | null = null;
let tempoVal: HTMLElement | null = null;
let autoMixBtn: HTMLElement | null = null;
let masterVol: HTMLInputElement | null = null;
let volKnob: HTMLElement | null = null;

let playlistRef: Track[] | null = null;
let renderPlaylistFn: (() => void) | null = null;
let setBlendingIndexFn: ((index: number) => void) | null = null;

// UI Helper for Confirmation
export function showConfirm(title: string, message: string, onYes: () => void): void {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    
    const close = () => { modal.style.display = 'none'; };
    
    if (yesBtn) {
        yesBtn.onclick = () => { onYes(); close(); };
    }
    if (noBtn) {
        noBtn.onclick = close;
    }
    modal.style.display = 'block';
}

export function setPlaybackMode(mode: PlaybackMode): void { state.update({ playbackMode: mode }); }
export function getPlaybackMode(): PlaybackMode { return state.playbackMode; }
export function setLoopMode(mode: LoopMode): void { 
    state.update({ loopMode: mode }); 
    engine.main.audio.loop = (mode === 'one');
}
export function getLoopMode(): LoopMode { return state.loopMode; }

export function initPlayer(deps: PlayerDeps): void {
    playlistRef = deps.playlist;
    renderPlaylistFn = deps.renderPlaylist;
    if (deps.setBlendingIndex) setBlendingIndexFn = deps.setBlendingIndex;
    
    playPauseBtn = document.getElementById('playPauseBtn');
    stopBtn = document.getElementById('stopBtn');
    trackTitle = document.getElementById('trackTitle');
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
        if (playPauseBtn) playPauseBtn.innerText = playing ? "PAUSE" : "PLAY";
    });

    state.subscribe('isAutoMixEnabled', (enabled) => {
        if (autoMixBtn) {
            autoMixBtn.classList.toggle('active', enabled);
            autoMixBtn.innerText = enabled ? 'AUTOMIX ON' : 'AUTOMIX OFF';
        }
    });

    state.subscribe('loopMode', (mode) => {
        const loopBtn = document.getElementById('loopBtn');
        if (loopBtn) {
            loopBtn.classList.toggle('active-loop', mode !== 'off');
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
    if (!playlistRef || index < 0 || index >= playlistRef.length) return;
    const track = playlistRef[index];
    state.update({ currentTrackIndex: index });
    if (renderPlaylistFn) renderPlaylistFn();
    
    engine.main.reset();
    logger.info(`[Player] Loading track: ${track.name} [ID: ${track.id}]`);
    const safeUrl = await getSafeUrl(track.path, true);
    engine.main.load(safeUrl);
    engine.main.audio.playbackRate = tempoSlider ? parseFloat(tempoSlider.value) : 1;
    
    if (track.bpm !== null && track.bpm !== undefined) {
        state.update({ masterBPM: track.bpm });
        const bpmText = state.masterBPM > 0 ? `[${state.masterBPM} BPM]` : "[BPM: --]";
        if (trackTitle) trackTitle.innerText = `${track.name} ${bpmText}`;
    } else {
        state.update({ masterBPM: 0 });
        if (trackTitle) trackTitle.innerText = `${track.name} [Analyzing...]`;
        try {
            const rawData = await (window as any).fileSystem.readFile(track.path);
            const arrayBuffer = rawData.buffer || rawData;
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const detectedValue = await detectBPMWorker(audioBuffer);
            track.bpm = detectedValue;
            state.update({ masterBPM: detectedValue });
            if (trackTitle && state.currentTrackIndex === index) {
                const bpmTxt = state.masterBPM > 0 ? `[${state.masterBPM} BPM]` : "[BPM: --]";
                trackTitle.innerText = `${track.name} ${bpmTxt}`;
            }
            logger.info(`[Player] Analysis finished for ${track.name}: ${detectedValue} BPM`);
        } catch (e) {
            logger.error("[Player] BPM Analysis failed", e);
            toast.error("BPM ANALYSIS FAILED");
            track.bpm = 0;
            if (trackTitle && state.currentTrackIndex === index) {
                trackTitle.innerText = track.name + " [BPM: Error]";
            }
        }
    }
}

function updateControlsLock(locked: boolean): void {
    const lockable = [progressBar, playPauseBtn];
    lockable.forEach(el => {
        if (el) {
            (el as any).disabled = locked;
            el.style.opacity = locked ? '0.5' : '1';
            el.style.cursor = locked ? 'not-allowed' : 'pointer';
        }
    });
}

export async function startCrossfade(targetIndex: number | null = null, customDuration: number | null = null): Promise<void> {
    if (state.isCrossfadeInProgress || !playlistRef?.length) return;
    
    resumeAudioContext();
    const nextIdx = targetIndex !== null ? targetIndex : ((state.currentTrackIndex + 1) % playlistRef.length);
    if (playlistRef[nextIdx].path === engine.main.audio.src && !targetIndex) return; 

    state.update({ isCrossfadeInProgress: true });
    updateControlsLock(true);

    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    engine.crossfade.reset();
    const safeUrl = await getSafeUrl(playlistRef[nextIdx].path, false);
    engine.crossfade.load(safeUrl);
    
    engine.crossfade.lowEQ.gain.value = settings.autoMix.eqCrossfade ? -24 : 0;
    engine.crossfade.midEQ.gain.value = settings.autoMix.eqCrossfade ? -6 : 0;
    engine.crossfade.gain.gain.value = 0.001;
    engine.crossfade.audio.playbackRate = engine.main.audio.playbackRate;

    try {
        await engine.crossfade.audio.play();
    } catch (e) {
        console.error("AutoMix Playback Failed", e);
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
        engine.main.lowEQ.gain.cancelScheduledValues(now);
        engine.main.lowEQ.gain.setValueAtTime(0, now);
        engine.main.lowEQ.gain.linearRampToValueAtTime(-24, now + duration * 0.8);
        engine.main.midEQ.gain.linearRampToValueAtTime(-12, now + duration);
    }
    if (settings.autoMix.filterSweep) {
        engine.main.lpFilter.frequency.cancelScheduledValues(now);
        engine.main.lpFilter.frequency.setValueAtTime(20000, now);
        engine.main.lpFilter.frequency.exponentialRampToValueAtTime(600, now + duration);
    }
    engine.main.gain.gain.cancelScheduledValues(now);
    engine.main.gain.gain.setValueAtTime(engine.main.gain.gain.value, now);
    engine.main.gain.gain.linearRampToValueAtTime(0.001, now + duration);

    // --- AUTOMATION: INCOMING (Crossfade) ---
    if (settings.autoMix.eqCrossfade) {
        engine.crossfade.lowEQ.gain.cancelScheduledValues(now);
        engine.crossfade.lowEQ.gain.setValueAtTime(-24, now);
        engine.crossfade.lowEQ.gain.linearRampToValueAtTime(0, now + duration * 0.8); 
        engine.crossfade.midEQ.gain.linearRampToValueAtTime(0, now + duration);
    }
    if (settings.autoMix.hpfSweep) {
        engine.crossfade.hpFilter.frequency.cancelScheduledValues(now);
        engine.crossfade.hpFilter.frequency.setValueAtTime(2000, now);
        engine.crossfade.hpFilter.frequency.exponentialRampToValueAtTime(30, now + duration * 0.8);
    }
    engine.crossfade.gain.gain.cancelScheduledValues(now);
    engine.crossfade.gain.gain.setValueAtTime(0.001, now);
    engine.crossfade.gain.gain.linearRampToValueAtTime(1, now + duration);

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
    
    setupPlayerHandlers();
    
    if (renderPlaylistFn) renderPlaylistFn();
    if (trackTitle && playlistRef) {
         const t = playlistRef[nextIndex];
         const txt = (t.bpm && t.bpm > 0) ? `[${t.bpm} BPM]` : "[BPM: --]";
         trackTitle.innerText = `${t.name} ${txt}`;
    }
}

export function playTrack(): void {
    if (state.isCrossfadeInProgress || !playlistRef?.length || !engine.main.audio) return;
    resumeAudioContext();
    engine.main.audio.play().then(() => {
        state.update({ isPlaying: true });
        updateControlsLock(false);
    }).catch(console.error);
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
                if (nextIndex >= (playlistRef?.length || 0)) {
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
    if (nextBtn && playlistRef) {
        nextBtn.addEventListener('click', () => {
            if (state.isCrossfadeInProgress) return;
            if (state.isAutoMixEnabled) startCrossfade(null, settings.autoMix.btnDuration);
            else loadTrack((state.currentTrackIndex + 1) % playlistRef!.length).then(playTrack);
        });
    }

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn && playlistRef) {
        prevBtn.addEventListener('click', () => {
            if (state.isCrossfadeInProgress) return;
            if (state.isAutoMixEnabled) startCrossfade((state.currentTrackIndex - 1 + playlistRef!.length) % playlistRef!.length, settings.autoMix.btnDuration);
            else loadTrack((state.currentTrackIndex - 1 + playlistRef!.length) % playlistRef!.length).then(playTrack);
        });
    }
    
    if (tempoSlider) {
        tempoSlider.oninput = (e: Event) => {
            const target = e.target as HTMLInputElement;
            let val = parseFloat(target.value);
            if (Math.abs(val - 1.0) < 0.05) { val = 1.0; tempoSlider!.value = "1.0"; }
            engine.main.audio.playbackRate = val;
            if (tempoVal) {
                const displayBPM = state.masterBPM > 0 ? Math.round(state.masterBPM * val) : "---";
                tempoVal.innerText = `SPEED: ${Math.round(val * 100)}% (BPM: ${displayBPM})`;
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
            engine.main.gain.gain.value = 1.0; 
            masterGain.gain.value = val;
            if (volKnob) {
                volKnob.innerText = Math.round(val * 100) + '%';
                volKnob.style.left = `calc(22.5px + (100% - 45px) * ${val})`;
            }
        };
    }
}

function formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
