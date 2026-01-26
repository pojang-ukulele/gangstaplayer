// === PLAYER MODULE ===
import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants.js';
import { audioCtx, masterGain, resumeAudioContext } from './audio.js';
import { settings } from './settings.js';

export let masterBPM = 0;
export let isPlaying = false;
export let currentTrackIndex = 0;
export let playerAudio = new Audio();
playerAudio.crossOrigin = "anonymous";

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

// Core state
let isAutoMixEnabled = false;
let isCrossfadeInProgress = false;

// === TWO CHANNEL SIGNAL PATH ===
// Main Player Chain (Track 1)
const playerGain = audioCtx.createGain();
const player_lowEQ = audioCtx.createBiquadFilter();
const player_midEQ = audioCtx.createBiquadFilter();
const player_highEQ = audioCtx.createBiquadFilter();
const player_lpf = audioCtx.createBiquadFilter();

player_lowEQ.type = 'lowshelf'; player_lowEQ.frequency.value = 320;
player_midEQ.type = 'peaking'; player_midEQ.frequency.value = 1000; player_midEQ.Q.value = 0.5;
player_highEQ.type = 'highshelf'; player_highEQ.frequency.value = 3200;
player_lpf.type = 'lowpass'; player_lpf.frequency.value = 20000;

let currentSource = audioCtx.createMediaElementSource(playerAudio);
currentSource.connect(player_lowEQ);
player_lowEQ.connect(player_midEQ);
player_midEQ.connect(player_highEQ);
player_highEQ.connect(player_lpf);
player_lpf.connect(playerGain);
playerGain.connect(masterGain);

// Crossfade Player Chain (Track 2)
let crossfadeAudio = null;
let crossfadeSource = null;
const crossfadeGain = audioCtx.createGain();
const cf_lowEQ = audioCtx.createBiquadFilter();
const cf_midEQ = audioCtx.createBiquadFilter();
const cf_highEQ = audioCtx.createBiquadFilter();
const cf_hpf = audioCtx.createBiquadFilter();

cf_lowEQ.type = 'lowshelf'; cf_lowEQ.frequency.value = 320;
cf_midEQ.type = 'peaking'; cf_midEQ.frequency.value = 1000; cf_midEQ.Q.value = 0.5;
cf_highEQ.type = 'highshelf'; cf_highEQ.frequency.value = 3200;
cf_hpf.type = 'highpass'; cf_hpf.frequency.value = 30;

cf_lowEQ.connect(cf_midEQ);
cf_midEQ.connect(cf_highEQ);
cf_highEQ.connect(cf_hpf);
cf_hpf.connect(crossfadeGain);
crossfadeGain.connect(masterGain);

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
             // Disable AutoMix if enabling Loop
             if (!playerAudio.loop && isAutoMixEnabled) {
                 setAutoMixEnabled(false);
             }
             
             playerAudio.loop = !playerAudio.loop;
             if (playerAudio.loop) {
                 loopBtn.classList.add('loop-active');
             } else {
                 loopBtn.classList.remove('loop-active');
             }
        });
    }
}

export function setDependentState(deps) {
   // Kept for consistency if main calls it, or we rely on init
}

export function setAutoMixEnabled(val) {
    isAutoMixEnabled = val;
    if (autoMixBtn) {
        if (isAutoMixEnabled) {
            autoMixBtn.classList.add('active');
            // Disable Loop if AutoMix enabled
            if (playerAudio.loop) {
                 playerAudio.loop = false;
                 const loopBtn = document.getElementById('loopBtn');
                 if (loopBtn) loopBtn.classList.remove('loop-active');
            }
        }
        else autoMixBtn.classList.remove('active');
    }
}

export function toggleAutoMix() { setAutoMixEnabled(!isAutoMixEnabled); }
export function getMasterBPMRef() { return { get value() { return masterBPM; }, set value(v) { masterBPM = v; } }; }
export function getTempoSlider() { return tempoSlider; }
export function getPlayerAudio() { return playerAudio; }

export function detectBPM(buffer) {
    const data = buffer.getChannelData(0);
    const peaks = [];
    const minStep = Math.floor(BPM_MIN_STEP_SECONDS * buffer.sampleRate);
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > BPM_DETECTION_THRESHOLD) {
            peaks.push(i); i += minStep;
        }
    }
    if (peaks.length < 2) return 0;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpmValue = (buffer.sampleRate * 60) / avgInterval;
    return (bpmValue < 60 || bpmValue > 200) ? 0 : Math.round(bpmValue);
}

export async function loadTrack(index) {
    if (!playlistRef || index < 0 || index >= playlistRef.length) return;
    const track = playlistRef[index];
    currentTrackIndex = index;
    if (renderPlaylistFn) renderPlaylistFn();
    
    // Ensure volumes are reset
    playerGain.gain.cancelScheduledValues(audioCtx.currentTime);
    playerGain.gain.value = 1;
    player_lpf.frequency.cancelScheduledValues(audioCtx.currentTime);
    player_lpf.frequency.value = 20000;
    player_lowEQ.gain.value = 0;
    
    playerAudio.src = track.url;
    playerAudio.playbackRate = tempoSlider ? parseFloat(tempoSlider.value) : 1;
    
    // Fix: Check strictly for NULL to allow 0 (failed/no bpm) to skip analysis
    if (track.bpm !== null && track.bpm !== undefined) {
        masterBPM = track.bpm;
        const bpmText = masterBPM > 0 ? `[${masterBPM} BPM]` : "[BPM: --]";
        if (trackTitle) trackTitle.innerText = `${track.name} ${bpmText}`;
    } else {
        masterBPM = 0;
        if (trackTitle) trackTitle.innerText = `${track.name} [Analyzing...]`;
        try {
            const response = await fetch(track.url);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const detectedValue = detectBPM(audioBuffer);
            track.bpm = detectedValue; // Can be 0
            masterBPM = detectedValue;
            if (trackTitle && currentTrackIndex === index) {
                const bpmTxt = masterBPM > 0 ? `[${masterBPM} BPM]` : "[BPM: --]";
                trackTitle.innerText = `${track.name} ${bpmTxt}`;
            }
        } catch (e) {
            console.error("[Player] Analysis failed", e);
            track.bpm = 0; // Mark as analyzed (failed)
            if (trackTitle && currentTrackIndex === index) {
                trackTitle.innerText = track.name + " [BPM: Error]";
            }
        }
    }
}

function updateControlsLock(locked) {
    if (progressBar) {
        progressBar.disabled = locked;
        progressBar.style.opacity = locked ? '0.5' : '1';
        progressBar.style.cursor = locked ? 'not-allowed' : 'pointer';
    }
    if (playPauseBtn) {
        playPauseBtn.disabled = locked;
        playPauseBtn.style.opacity = locked ? '0.5' : '1';
        playPauseBtn.style.cursor = locked ? 'not-allowed' : 'pointer';
    }
    // Note: Stop button remains active
}

// === ADVANCED AUTO-MIX ENGINE ===

export async function startCrossfade(targetIndex = null, customDuration = null) {
    if (isCrossfadeInProgress || !playlistRef?.length) return;
    
    resumeAudioContext();
    const nextIdx = targetIndex !== null ? targetIndex : ((currentTrackIndex + 1) % playlistRef.length);
    if (playlistRef[nextIdx].url === playerAudio.src && !targetIndex) return; 

    isCrossfadeInProgress = true;
    updateControlsLock(true); // LOCK UI

    console.log(`[AutoMix] Starting transition to: ${playlistRef[nextIdx].name}`);
    
    if (setBlendingIndexFn) setBlendingIndexFn(nextIdx);
    if (autoMixBtn) autoMixBtn.classList.add('blending');

    crossfadeAudio = new Audio();
    crossfadeAudio.crossOrigin = "anonymous";
    crossfadeAudio.src = playlistRef[nextIdx].url;
    
    crossfadeSource = audioCtx.createMediaElementSource(crossfadeAudio);
    crossfadeSource.connect(cf_lowEQ);
    
    cf_lowEQ.gain.value = settings.autoMix.eqCrossfade ? -24 : 0;
    cf_midEQ.gain.value = settings.autoMix.eqCrossfade ? -6 : 0;
    crossfadeGain.gain.value = 0.001;

    // Match rate
    crossfadeAudio.playbackRate = playerAudio.playbackRate;

    try {
        await crossfadeAudio.play();
    } catch (e) {
        console.error("AutoMix Playback Failed", e);
        isCrossfadeInProgress = false;
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        return;
    }

    const duration = customDuration !== null ? customDuration : settings.autoMix.trackDuration;
    const now = audioCtx.currentTime;

    // --- AUTOMATION: OUTGOING (Track 1) ---
    // Balanced Mix: Linear Fade Out (prevents "blasting" overlap while staying audible)
    if (settings.autoMix.eqCrossfade) {
        player_lowEQ.gain.cancelScheduledValues(now);
        player_lowEQ.gain.setValueAtTime(0, now);
        player_lowEQ.gain.linearRampToValueAtTime(-24, now + duration * 0.8);
        player_midEQ.gain.linearRampToValueAtTime(-12, now + duration);
    }
    if (settings.autoMix.filterSweep) {
        player_lpf.frequency.cancelScheduledValues(now);
        player_lpf.frequency.setValueAtTime(20000, now);
        player_lpf.frequency.exponentialRampToValueAtTime(600, now + duration);
    }
    playerGain.gain.cancelScheduledValues(now);
    playerGain.gain.setValueAtTime(playerGain.gain.value, now);
    // Restoration: Linear fade out to 0 to prevent clipping (1+1=2 is too loud)
    playerGain.gain.linearRampToValueAtTime(0.001, now + duration);

    // --- AUTOMATION: INCOMING (Track 2) ---
    if (settings.autoMix.eqCrossfade) {
        cf_lowEQ.gain.cancelScheduledValues(now);
        cf_lowEQ.gain.setValueAtTime(-24, now);
        cf_lowEQ.gain.linearRampToValueAtTime(0, now + duration * 0.8); 
        cf_midEQ.gain.linearRampToValueAtTime(0, now + duration);
    }
    if (settings.autoMix.hpfSweep) {
        cf_hpf.frequency.cancelScheduledValues(now);
        cf_hpf.frequency.setValueAtTime(2000, now);
        cf_hpf.frequency.exponentialRampToValueAtTime(30, now + duration * 0.8);
    }
    crossfadeGain.gain.cancelScheduledValues(now);
    crossfadeGain.gain.setValueAtTime(0.001, now);
    // Restoration: Linear fade in from 0
    crossfadeGain.gain.linearRampToValueAtTime(1, now + duration);

    setTimeout(() => { finishCrossfade(nextIdx); }, duration * 1000);
}

function finishCrossfade(nextIndex) {
    if (!crossfadeAudio) {
        isCrossfadeInProgress = false;
        updateControlsLock(false);
        if (setBlendingIndexFn) setBlendingIndexFn(-1);
        if (autoMixBtn) autoMixBtn.classList.remove('blending');
        loadTrack(nextIndex).then(playTrack); 
        return;
    }
    
    // --- SEAMLESS HANDOFF (OBJECT SWAP) ---
    // Instead of pausing and seeking (which causes glitches), we PROMOTE the 
    // running crossfadeAudio to become the new playerAudio.
    
    const oldPlayer = playerAudio;
    const oldSource = currentSource;
    
    // 1. Reset Main Chain Params (Instantly) so the new track sounds right
    const now = audioCtx.currentTime;
    playerGain.gain.cancelScheduledValues(now);
    playerGain.gain.setValueAtTime(1, now);
    player_lowEQ.gain.cancelScheduledValues(now);
    player_lowEQ.gain.setValueAtTime(0, now);
    player_midEQ.gain.setValueAtTime(0, now);
    player_lpf.frequency.cancelScheduledValues(now);
    player_lpf.frequency.setValueAtTime(20000, now);

    // 2. Disconnect Source Nodes to swap chains
    // Disconnect playing crossfade source from Crossfade Chain
    crossfadeSource.disconnect();
    // Disconnect old main source from Main Chain
    if (oldSource) oldSource.disconnect();

    // 3. Connect New Source to Main Chain
    crossfadeSource.connect(player_lowEQ);
    currentSource = crossfadeSource; // Update reference

    // 4. Update Global Player Object
    playerAudio = crossfadeAudio; // Promote
    currentTrackIndex = nextIndex;
    
    // 5. Cleanup Old Object
    oldPlayer.pause();
    oldPlayer.src = "";
    
    // 6. Reset State
    crossfadeAudio = null;
    crossfadeSource = null;
    isCrossfadeInProgress = false;
    updateControlsLock(false);
    
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
    
    // 7. Re-bind Events to new object
    setupPlayerHandlers();
    
    // 8. Update UI
    if (renderPlaylistFn) renderPlaylistFn();
    if (trackTitle) {
         const t = playlistRef[nextIndex];
         if (t.bpm !== null && t.bpm !== undefined) {
             const txt = t.bpm > 0 ? `[${t.bpm} BPM]` : "[BPM: --]";
             trackTitle.innerText = `${t.name} ${txt}`;
         }
    }
}

export function playTrack() {
    if (isCrossfadeInProgress) return; // Ignore if mixing
    if (!playlistRef?.length || !playerAudio) return;
    resumeAudioContext();
    playerAudio.play().then(() => {
        isPlaying = true;
        if (playPauseBtn) playPauseBtn.innerText = "PAUSE";
        updateControlsLock(false);
    }).catch(console.error);
}

export function pauseTrack() {
    if (isCrossfadeInProgress) return; // Ignore if mixing
    if (playerAudio) playerAudio.pause();
    isPlaying = false;
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
}

export function stopPlayback() {
    if (playerAudio) { playerAudio.pause(); playerAudio.currentTime = 0; }
    if (crossfadeAudio) { crossfadeAudio.pause(); crossfadeAudio.src = ""; crossfadeAudio = null; }
    isPlaying = false;
    isCrossfadeInProgress = false;
    updateControlsLock(false); // Force unlock
    
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
    if (progressBar) progressBar.value = 0;
    
    if (setBlendingIndexFn) setBlendingIndexFn(-1);
    if (autoMixBtn) autoMixBtn.classList.remove('blending');
}

export function setupPlayerHandlers() {
    if (!playerAudio) return;
    
    // ... existing timeupdate ...
    playerAudio.addEventListener('timeupdate', () => {
        if (!isDraggingProgress && playerAudio.duration) {
            const progress = (playerAudio.currentTime / playerAudio.duration) * 100;
            if (progressBar) progressBar.value = progress;
            if (timeDisplay) timeDisplay.innerText = formatTime(playerAudio.currentTime);

            // Auto-Mix Trigger logic
            if (isAutoMixEnabled && !isCrossfadeInProgress && playerAudio.duration > settings.autoMix.trackDuration * 2) {
                if (playerAudio.currentTime >= playerAudio.duration - settings.autoMix.trackDuration) {
                    startCrossfade();
                }
            }
        }
    });

    playerAudio.addEventListener('ended', () => {
        if (!isAutoMixEnabled && !isCrossfadeInProgress) {
            const nextIndex = (currentTrackIndex + 1) % (playlistRef?.length || 1);
            loadTrack(nextIndex).then(() => playTrack());
        }
    });
    
    playerAudio.addEventListener('loadedmetadata', () => {
        if (totalTimeDisplay && playerAudio.duration) {
            totalTimeDisplay.innerText = formatTime(playerAudio.duration);
        }
    });

    if (progressBar) {
        progressBar.addEventListener('input', (e) => {
            isDraggingProgress = true;
            if (playerAudio.duration && timeDisplay) {
                 const val = parseFloat(e.target.value);
                 const seekTime = (val / 100) * playerAudio.duration;
                 timeDisplay.innerText = formatTime(seekTime);
            }
        });
        progressBar.addEventListener('change', (e) => {
            if (isCrossfadeInProgress) return; // Block seeking 
            if (playerAudio.duration) {
                playerAudio.currentTime = (parseFloat(e.target.value) / 100) * playerAudio.duration;
            }
            isDraggingProgress = false;
        });
    }

    if (masterVol) {
        // Initial set
        if (volKnob) {
             const v = parseFloat(masterVol.value);
             // Knob is 45px wide. Center is at 22.5px.
             // Range logic: 22.5px ... (100% - 22.5px)
             volKnob.style.left = `calc(22.5px + (100% - 45px) * ${v})`;
             volKnob.innerText = Math.round(v * 100) + '%';
        }

        masterVol.addEventListener('input', () => {
            const val = parseFloat(masterVol.value);
            masterGain.gain.value = val;
            if (volKnob) {
                volKnob.innerText = Math.round(val * 100) + '%';
                volKnob.style.left = `calc(22.5px + (100% - 45px) * ${val})`;
            }
        });
    }
    
    if (playPauseBtn) playPauseBtn.addEventListener('click', () => {
        if (isCrossfadeInProgress) return; // Block
        isPlaying ? pauseTrack() : playTrack();
    });
    
    if (stopBtn) stopBtn.addEventListener('click', stopPlayback);
    if (autoMixBtn) autoMixBtn.addEventListener('click', toggleAutoMix);

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => {
        if (isCrossfadeInProgress) return;
        if (isAutoMixEnabled) startCrossfade(null, settings.autoMix.btnDuration);
        else { currentTrackIndex = (currentTrackIndex + 1) % playlistRef.length; loadTrack(currentTrackIndex).then(playTrack); }
    });

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (isCrossfadeInProgress) return;
        if (isAutoMixEnabled) startCrossfade((currentTrackIndex - 1 + playlistRef.length) % playlistRef.length, settings.autoMix.btnDuration);
        else { currentTrackIndex = (currentTrackIndex - 1 + playlistRef.length) % playlistRef.length; loadTrack(currentTrackIndex).then(playTrack); }
    });
    
    if (tempoSlider) {
        tempoSlider.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            
            // MAGNETIC SNAP TO 1.0
            if (Math.abs(val - 1.0) < 0.05) {
                val = 1.0;
                tempoSlider.value = 1.0; // Visual snap
            }

            playerAudio.playbackRate = val;
            if (tempoVal) {
                let displayBPM = "---";
                if (masterBPM > 0) displayBPM = Math.round(masterBPM * val);
                tempoVal.innerText = `SPEED: ${Math.round(val * 100)}% (BPM: ${displayBPM})`;
            }
        });
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
