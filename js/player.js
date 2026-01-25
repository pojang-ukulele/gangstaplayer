// === PLAYER MODULE ===
import { BPM_DETECTION_THRESHOLD, BPM_MIN_STEP_SECONDS } from './constants.js';
import { audioCtx, resumeAudioContext } from './audio.js';

export let masterBPM = 0;
export let isPlaying = false;
export let currentTrackIndex = 0;
let isDraggingProgress = false;

let playerAudio = null;
let playPauseBtn = null;
let stopBtn = null;
let trackTitle = null;
let progressBar = null;
let timeDisplay = null;
let tempoSlider = null;
let tempoVal = null;

let playlistRef = null;
let renderPlaylistFn = null;

export function initPlayer(deps) {
    playlistRef = deps.playlist;
    renderPlaylistFn = deps.renderPlaylist;
    playerAudio = document.getElementById('playerAudio');
    playPauseBtn = document.getElementById('playPauseBtn');
    stopBtn = document.getElementById('stopBtn');
    trackTitle = document.getElementById('trackTitle');
    progressBar = document.getElementById('progressBar');
    timeDisplay = document.getElementById('timeDisplay');
    tempoSlider = document.getElementById('tempoSlider');
    tempoVal = document.getElementById('tempoVal');
}

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
    const bpm = (buffer.sampleRate * 60) / avgInterval;
    return (bpm < 60 || bpm > 200) ? 0 : Math.round(bpm);
}

export async function loadTrack(index) {
    if (!playlistRef || index < 0 || index >= playlistRef.length) return;
    currentTrackIndex = index;
    if (renderPlaylistFn) renderPlaylistFn();
    if (playerAudio) {
        playerAudio.src = playlistRef[index].url;
        playerAudio.playbackRate = tempoSlider ? tempoSlider.value : 1;
    }
    if (trackTitle) trackTitle.innerText = playlistRef[index].name + " [Analyzing...]";
    try {
        const arrayBuffer = await (await fetch(playlistRef[index].url)).arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        masterBPM = detectBPM(audioBuffer);
        if (trackTitle) trackTitle.innerText = playlistRef[index].name + (masterBPM > 0 ? ` [${masterBPM} BPM]` : " [BPM: ?]");
    } catch (e) { if (trackTitle) trackTitle.innerText = playlistRef[index].name + " [BPM: Error]"; }
}

export function playTrack() {
    if (!playlistRef?.length || !playerAudio) return;
    resumeAudioContext();
    playerAudio.play().then(() => {
        isPlaying = true;
        if (playPauseBtn) playPauseBtn.innerText = "PAUSE";
    }).catch(console.error);
}

export function pauseTrack() {
    if (playerAudio) playerAudio.pause();
    isPlaying = false;
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
}

export function stopPlayback() {
    if (playerAudio) { playerAudio.pause(); playerAudio.currentTime = 0; }
    isPlaying = false;
    if (playPauseBtn) playPauseBtn.innerText = "PLAY";
    if (progressBar) progressBar.value = 0;
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function setupPlayerHandlers() {
    if (!playerAudio) return;
    playerAudio.addEventListener('timeupdate', () => {
        if (!isDraggingProgress && playerAudio.duration) {
            if (progressBar) progressBar.value = (playerAudio.currentTime / playerAudio.duration) * 100;
            if (timeDisplay) timeDisplay.innerText = `${formatTime(playerAudio.currentTime)} / ${formatTime(playerAudio.duration)}`;
        }
    });
    if (progressBar) {
        progressBar.addEventListener('input', () => isDraggingProgress = true);
        progressBar.addEventListener('change', (e) => {
            playerAudio.currentTime = (e.target.value / 100) * playerAudio.duration;
            isDraggingProgress = false;
        });
    }
    if (playPauseBtn) playPauseBtn.addEventListener('click', () => isPlaying ? pauseTrack() : playTrack());
    if (stopBtn) stopBtn.addEventListener('click', stopPlayback);
    if (tempoSlider && tempoVal) {
        tempoSlider.addEventListener('input', () => {
            tempoVal.innerText = parseFloat(tempoSlider.value).toFixed(2) + 'x';
            playerAudio.playbackRate = parseFloat(tempoSlider.value);
        });
    }
}
