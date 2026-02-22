// === PLAYER MODULE ===
import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants.js';
import { audioCtx, resumeAudioContext } from './audio.js';
import { settings } from './settings.js';
import { state } from './state.js';
import { detectBPMWorker } from './worker-client.js';
import { toast } from './toast.js';
import { engine } from './audio-engine.js';

// Local UI references
let isDraggingProgress = false;
let playPauseBtn = null;
let stopBtn = null;
let trackTitle = null;
let progressBar = null;
let timeDisplay = null;
let totalTimeDisplay = null;
let tempoSlider = null;
let tempoVal = null;
let autoMixBtn = null;
let masterVol = null;
let volKnob = null;

let playlistRef = null;
let renderPlaylistFn = null;
let setBlendingIndexFn = null;

// UI Helper for Confirmation
function showConfirm(title, message, onYes) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    
    const close = () => { modal.style.display = 'none'; };
    
    yesBtn.onclick = () => { onYes(); close(); };
    noBtn.onclick = close;
    modal.style.display = 'block';
}

export function setPlaybackMode(mode) { state.update({ playbackMode: mode }); }
export function getPlaybackMode() { return state.playbackMode; }
export function setLoopMode(mode) { 
    state.update({ loopMode: mode }); 
    engine.main.audio.loop = (mode === 'one');
}
export function getLoopMode() { return state.loopMode; }

export function initPlayer(deps) {
    playlistRef = deps.playlist;
    renderPlaylistFn = deps.renderPlaylist;
    if (deps.setBlendingIndex) setBlendingIndexFn = deps.setBlendingIndex;
    
    playPauseBtn = document.getElementById('playPauseBtn');
    stopBtn = document.getElementById('stopBtn');
    trackTitle = document.getElementById('trackTitle');
    progressBar = document.getElementById('progressBar');
    timeDisplay = document.getElementById('currentTime');
    totalTimeDisplay = document.getElementById('totalTime');
    tempoSlider = document.getElementById('tempoSlider');
    tempoVal = document.getElementById('chopperBPM');
    autoMixBtn = document.getElementById('autoMixBtn');
    masterVol = document.getElementById('masterVol');
    volKnob = document.getElementById('volKnob');
    
    // LOOP LOGIC
    const loopBtn = document.getElementById('loopBtn');
    if (loopBtn) {
        loopBtn.addEventListener('click', () => {
             if (!engine.main.audio.loop && state.isAutoMixEnabled) {
                 setAutoMixEnabled(false);
             }
             
             engine.main.audio.loop = !engine.main.audio.loop;
             loopBtn.classList.toggle('loop-active', engine.main.audio.loop);
        });
    }
}

export function setAutoMixEnabled(val) {
    state.update({ isAutoMixEnabled: val });
    if (autoMixBtn) {
        if (state.isAutoMixEnabled) {
            autoMixBtn.classList.add('active');
            if (engine.main.audio.loop) {
                 engine.main.audio.loop = false;
                 const loopBtn = document.getElementById('loopBtn');
                 if (loopBtn) loopBtn.classList.remove('loop-active');
                 state.update({ loopMode: 'off' });
            }
        }
        else autoMixBtn.classList.remove('active');
    }
}

export function toggleAutoMix() { setAutoMixEnabled(!state.isAutoMixEnabled); }
export function getMasterBPMRef() { return { get value() { return state.masterBPM; }, set value(v) { state.update({ masterBPM: v }); } }; }
export function getTempoSlider() { return tempoSlider; }
export function getPlayerAudio() { return engine.main.audio; }

export async function loadTrack(index) {
    if (!playlistRef || index < 0 || index >= playlistRef.length) return;
    const track = playlistRef[index];
    state.update({ currentTrackIndex: index });
    if (renderPlaylistFn) renderPlaylistFn();
    
    engine.main.reset();
    engine.main.load(track.url);
    engine.main.audio.playbackRate = tempoSlider ? parseFloat(tempoSlider.value) : 1;
    
    if (track.bpm !== null && track.bpm !== undefined) {
        state.update({ masterBPM: track.bpm });
        const bpmText = state.masterBPM > 0 ? `[${state.masterBPM} BPM]` : "[BPM: --]";
        if (trackTitle) trackTitle.innerText = `${track.name} ${bpmText}`;
    } else {
        state.update({ masterBPM: 0 });
        if (trackTitle) trackTitle.innerText = `${track.name} [Analyzing...]`;
        try {
            const response = await fetch(track.url);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const detectedValue = await detectBPMWorker(audioBuffer);
            track.bpm = detectedValue;
            state.update({ masterBPM: detectedValue });
            if (trackTitle && state.currentTrackIndex === index) {
                const bpmTxt = state.masterBPM > 0 ? `[${state.masterBPM} BPM]` : "[BPM: --]";
                trackTitle.innerText = `${track.name} ${bpmTxt}`;
            }
        } catch (e) {
            console.error("[Player] Analysis failed", e);
            toast.error("BPM ANALYSIS FAILED");
            track.bpm = 0;
            if (trackTitle && state.currentTrackIndex === index) {
                trackTitle.innerText = track.name + " [BPM: Error]";
            }
        }
    }
}

function updateControlsLock(locked) {
    const lockable = [progressBar, playPauseBtn];
    lockable.forEach(el => {
        if (el) {
            el.disabled = locked;
            el.style.opacity = locked ? '0.5' : '1';
            el.style.cursor = locked ? 'not-allowed' : 'pointer';
        }
    });
}

export async function startCrossfade(targetIndex = null, customDuration = null) {
    if (state.isCrossfadeInProgress || !playlistRef?.length) return;
    
    resumeAudioContext();
    const nextIdx = targetIndex !== null ? targetIndex : ((state.currentTrackIndex + 1) % playlistRef.length);
    if (playlistRef[nextIdx].url === engine.main.audio.src && !targetIndex) return; 

    state.update({ isCrossfadeInProgress: true });
    updateControlsLock(true);

    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    engine.crossfade.reset();
    engine.crossfade.load(playlistRef[nextIdx].url);
    
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

function finishCrossfade(nextIndex) {
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
    state.update({ currentTrackIndex: nextIndex, isCrossfadeInProgress: false });
    updateControlsLock(false);
    
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
    
    setupPlayerHandlers();
    
    if (renderPlaylistFn) renderPlaylistFn();
    if (trackTitle) {
         const t = playlistRef[nextIndex];
         const txt = (t.bpm && t.bpm > 0) ? `[${t.bpm} BPM]` : "[BPM: --]";
         trackTitle.innerText = `${t.name} ${txt}`;
    }
}

export function playTrack() {
    if (state.isCrossfadeInProgress || !playlistRef?.length || !engine.main.audio) return;
    resumeAudioContext();
    engine.main.audio.play().then(() => {
        state.update({ isPlaying: true });
        if (playPauseBtn) playPauseBtn.innerText = "PAUSE";
        updateControlsLock(false);
    }).catch(console.error);
}

export function pauseTrack() {
    if (state.isCrossfadeInProgress) return;
    if (engine.main.audio) engine.main.audio.pause();
    state.update({ isPlaying: false });
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
}

export function stopPlayback() {
    engine.main.audio.pause();
    engine.main.audio.currentTime = 0;
    engine.crossfade.audio.pause();
    engine.crossfade.audio.src = "";
    
    state.update({ isPlaying: false, isCrossfadeInProgress: false });
    updateControlsLock(false);
    
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
    if (progressBar) progressBar.value = 0;
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
}

export function setupPlayerHandlers() {
    if (!engine.main.audio) return;
    
    engine.main.audio.addEventListener('timeupdate', () => {
        if (!isDraggingProgress && engine.main.audio.duration) {
            const progress = (engine.main.audio.currentTime / engine.main.audio.duration) * 100;
            if (progressBar) progressBar.value = progress;
            if (timeDisplay) timeDisplay.innerText = formatTime(engine.main.audio.currentTime);

            if (state.isAutoMixEnabled && !state.isCrossfadeInProgress && engine.main.audio.duration > settings.autoMix.trackDuration * 2) {
                if (engine.main.audio.currentTime >= engine.main.audio.duration - settings.autoMix.trackDuration) {
                    startCrossfade();
                }
            }
        }
    });

    engine.main.audio.addEventListener('ended', () => {
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
    });
    
    engine.main.audio.addEventListener('loadedmetadata', () => {
        if (totalTimeDisplay && engine.main.audio.duration) {
            totalTimeDisplay.innerText = formatTime(engine.main.audio.duration);
        }
    });

    if (progressBar) {
        progressBar.addEventListener('input', (e) => {
            isDraggingProgress = true;
            if (engine.main.audio.duration && timeDisplay) {
                 const seekTime = (parseFloat(e.target.value) / 100) * engine.main.audio.duration;
                 timeDisplay.innerText = formatTime(seekTime);
            }
        });
        progressBar.addEventListener('change', (e) => {
            if (state.isCrossfadeInProgress) return;
            if (engine.main.audio.duration) {
                engine.main.audio.currentTime = (parseFloat(e.target.value) / 100) * engine.main.audio.duration;
            }
            isDraggingProgress = false;
        });
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => {
        if (state.isCrossfadeInProgress) return;
        if (state.isAutoMixEnabled) startCrossfade(null, settings.autoMix.btnDuration);
        else loadTrack((state.currentTrackIndex + 1) % playlistRef.length).then(playTrack);
    });

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (state.isCrossfadeInProgress) return;
        if (state.isAutoMixEnabled) startCrossfade((state.currentTrackIndex - 1 + playlistRef.length) % playlistRef.length, settings.autoMix.btnDuration);
        else loadTrack((state.currentTrackIndex - 1 + playlistRef.length) % playlistRef.length).then(playTrack);
    });
    
    if (tempoSlider) {
        tempoSlider.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (Math.abs(val - 1.0) < 0.05) { val = 1.0; tempoSlider.value = 1.0; }
            engine.main.audio.playbackRate = val;
            if (tempoVal) {
                const displayBPM = state.masterBPM > 0 ? Math.round(state.masterBPM * val) : "---";
                tempoVal.innerText = `SPEED: ${Math.round(val * 100)}% (BPM: ${displayBPM})`;
            }
        });
    }

    if (playPauseBtn) playPauseBtn.onclick = () => {
        if (state.isCrossfadeInProgress) return;
        state.isPlaying ? pauseTrack() : playTrack();
    };
    if (stopBtn) stopBtn.onclick = stopPlayback;
    if (autoMixBtn) autoMixBtn.onclick = toggleAutoMix;
    
    // Master Volume linking
    const masterVol = document.getElementById('masterVol');
    if (masterVol) {
        masterVol.oninput = () => {
            const val = parseFloat(masterVol.value);
            engine.main.gain.gain.value = 1.0; // Audio node internal
            import('./audio.js').then(a => a.masterGain.gain.value = val);
            if (volKnob) {
                volKnob.innerText = Math.round(val * 100) + '%';
                volKnob.style.left = `calc(22.5px + (100% - 45px) * ${val})`;
            }
        };
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Export for confirm usage in other modules
export { showConfirm };
