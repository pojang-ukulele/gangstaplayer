// === CONSTANTS ===
const KEYBOARD_MAP = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'];
const MIDI_NOTE_TO_PAD = { 36: 0, 37: 1, 38: 2, 39: 3, 40: 4, 41: 5, 42: 6, 43: 7, 44: 8, 45: 9, 46: 10, 47: 11, 48: 12, 49: 13, 50: 14, 51: 15 };
const BPM_DETECTION_THRESHOLD = 0.6;
const BPM_MIN_STEP_SECONDS = 0.25;
const DRAG_THRESHOLD_PX = 5;
const DEFAULT_PAD_VOLUME = 0.75;
const DEFAULT_TRACK_FADE_SECONDS = 10;
const DEFAULT_BUTTON_FADE_SECONDS = 4;
const VISUALIZER_FFT_SIZE = 256;
const VISUALIZER_BARS = 16;
const SLIDER_DEBOUNCE_MS = 16; // ~60fps for smooth visual updates

// === UTILITY FUNCTIONS ===
/**
 * Debounce function - delays execution until after wait ms have elapsed since last call
 * @param {Function} fn - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @returns {Function} Debounced function
 */
function debounce(fn, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

/**
 * Throttle function - ensures function is called at most once per wait ms
 * @param {Function} fn - Function to throttle
 * @param {number} wait - Minimum ms between calls
 * @returns {Function} Throttled function
 */
function throttle(fn, wait) {
    let lastTime = 0;
    return function(...args) {
        const now = Date.now();
        if (now - lastTime >= wait) {
            lastTime = now;
            fn.apply(this, args);
        }
    };
}
// === SECURE IMPORTS VIA BRIDGE ===
const bridge = window.electronAPI;
const fsBridge = window.fileSystem;
// WebMIDI is loaded via script tag globally

// === WINDOW CONTROLS ===
document.getElementById('minBtn').addEventListener('click', () => bridge.minimize());
document.getElementById('maxBtn').addEventListener('click', () => bridge.maximize());
document.getElementById('closeBtn').addEventListener('click', () => bridge.close());

// === AUDIO CONTEXT ===
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const masterGain = audioCtx.createGain();
const analyser = audioCtx.createAnalyser();
analyser.fftSize = VISUALIZER_FFT_SIZE;
masterGain.connect(analyser);
analyser.connect(audioCtx.destination);

// === STATE ===
const padBuffers = {};
const padPaths = {};
const activeVoices = {};
const padVolumes = new Array(16).fill(DEFAULT_PAD_VOLUME);
const keyMap = KEYBOARD_MAP; // Alias for backwards compatibility
const padGrid = document.getElementById('padGrid');

// === MIDI SUPPORT ===
const midiStatusEl = document.getElementById('midiStatus');
const midiNoteToPad = MIDI_NOTE_TO_PAD; // Alias for backwards compatibility

function enableMIDI() {
    if (!navigator.requestMIDIAccess) {
        console.error("WebMIDI not supported in this environment.");
        return;
    }

    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
}

const midiDeviceSelect = document.getElementById('midiDeviceSelect');
let selectedMidiId = 'all';

function onMIDISuccess(midiAccess) {
    updateMidiStatus(midiAccess);

    // Listen to existing inputs
    for (let input of midiAccess.inputs.values()) {
        input.onmidimessage = getMIDIMessage;
    }

    // Listen for connection changes
    midiAccess.onstatechange = (e) => {
        updateMidiStatus(midiAccess);
        if (e.port.type === 'input') {
            if (e.port.state === 'connected') e.port.onmidimessage = getMIDIMessage;
        }
    };
}

function updateMidiStatus(midiAccess) {
    midiDeviceSelect.innerHTML = '<option value="all">ALL INPUTS (Default)</option>';
    let deviceCount = 0;

    for (let input of midiAccess.inputs.values()) {
        const option = document.createElement('option');
        option.value = input.id;
        option.text = input.name || `MIDI Device ${input.id}`;
        if (input.id === selectedMidiId) option.selected = true;
        midiDeviceSelect.appendChild(option);
        deviceCount++;
    }

    // Status text logic
    if (deviceCount > 0) {
        midiStatusEl.innerText = `MIDI: ON (${deviceCount})`;
        midiStatusEl.style.color = "#39ff14";
    } else {
        midiStatusEl.innerText = "MIDI: OFF (No Device)";
        midiStatusEl.style.color = "#666";
    }
}
midiDeviceSelect.addEventListener('change', (e) => selectedMidiId = e.target.value);

function onMIDIFailure() {
    console.error('Could not access your MIDI devices.');
    midiStatusEl.innerText = "MIDI: FAIL";
    midiStatusEl.style.color = "red";
    midiDeviceSelect.innerHTML = '<option>MIDI Access Denied</option>';
}

function getMIDIMessage(message) {
    // Filter by selected device if not 'all'
    if (selectedMidiId !== 'all' && message.target.id !== selectedMidiId) return;

    const [command, note, velocity] = message.data;
    const cmd = command >> 4;
    // channel = command & 0xf;
    // type = undefined; // 9 = note on, 8 = note off

    // Note Off (128) or Note On (144) with 0 velocity
    if (cmd === 8 || (cmd === 9 && velocity === 0)) {
        const pad = midiNoteToPad[note];
        if (pad !== undefined) stopPad(pad);
    }
    // Note On (144)
    else if (cmd === 9) {
        const pad = midiNoteToPad[note];
        if (pad !== undefined) {
            startPad(pad);
            // Handle Velocity Volume
            if (activeVoices[pad] && activeVoices[pad].gain) {
                // Normalize 0-127 to 0-1, multiply by padVolume
                const vol = (velocity / 127) * padVolumes[pad];
                try { activeVoices[pad].gain.gain.setValueAtTime(vol, audioCtx.currentTime); } catch (e) { }
            }
        }
    }
}

// Enable on first click
document.body.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    enableMIDI();
}, { once: true });

// ==================== ORIGINAL LOGIC ADAPTED ====================
for (let i = 0; i < 16; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pad-wrapper';

    const pad = document.createElement('div');
    pad.className = 'pad';
    pad.dataset.key = keyMap[i];
    pad.innerHTML = `<span>${keyMap[i].toUpperCase()}</span>`;
    
    // ARIA attributes for accessibility
    pad.setAttribute('role', 'button');
    pad.setAttribute('aria-label', `Sampler Pad ${i + 1} (Key: ${keyMap[i].toUpperCase()})`);
    pad.setAttribute('aria-pressed', 'false');
    pad.setAttribute('tabindex', '0');


    // NEW: Rec Button
    const recBtn = document.createElement('div');
    recBtn.className = 'rec-btn';
    recBtn.title = "Hold to Record";
    recBtn.onmousedown = (e) => { e.stopPropagation(); startRecording(i, recBtn); };
    recBtn.onmouseup = (e) => { e.stopPropagation(); stopRecording(i, recBtn, pad); };
    recBtn.onmouseleave = (e) => {
        if (recBtn.classList.contains('recording')) stopRecording(i, recBtn, pad);
    };
    recBtn.onclick = (e) => e.stopPropagation(); // Stop click from bubbling to pad (which opens Load Dialog)
    pad.appendChild(recBtn);

    // Right-click context menu for pads
    pad.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = document.getElementById('padContextMenu');
        const syncItem = document.getElementById('ctxSync');
        const syncDivider = document.getElementById('padCtxDivider');
        
        // Show SYNC option only if sample is loaded
        if (padBuffers[i]) {
            syncItem.classList.remove('hidden');
            syncDivider.classList.remove('hidden');
            // Update visual state
            if (padSyncState[i]) {
                syncItem.classList.add('sync-active');
            } else {
                syncItem.classList.remove('sync-active');
            }
        } else {
            syncItem.classList.add('hidden');
            syncDivider.classList.add('hidden');
        }
        
        menu.classList.remove('hidden');
        menu.setAttribute('aria-hidden', 'false');
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.dataset.padIndex = i;
    });

    pad.addEventListener('dragover', (e) => { e.preventDefault(); pad.style.borderColor = '#fff'; });
    pad.addEventListener('dragleave', (e) => { e.preventDefault(); pad.style.borderColor = 'rgba(255,255,255,0.1)'; });
    pad.addEventListener('drop', (e) => {
        e.preventDefault();
        pad.style.borderColor = 'rgba(255,255,255,0.1)';
        if (e.dataTransfer.files.length > 0) loadSampleFile(e.dataTransfer.files[0], i, pad);
    });
    pad.addEventListener('mousedown', () => startPad(i));
    pad.addEventListener('mouseup', () => stopPad(i));
    pad.addEventListener('mouseleave', () => stopPad(i));
    pad.addEventListener('click', async () => { 
        if (!padBuffers[i]) {
             const filePath = await bridge.openSampleDialog();
             if (filePath) loadSampleFromPath(filePath, i);
        }
    });
    const volSlider = document.createElement('input');
    volSlider.className = 'pad-slider';
    volSlider.type = 'range'; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.05;
    volSlider.value = 0.75;
    volSlider.addEventListener('input', (e) => {
        padVolumes[i] = parseFloat(e.target.value);
        if (activeVoices[i]) activeVoices[i].gain.gain.setValueAtTime(padVolumes[i], audioCtx.currentTime);
    });
    wrapper.appendChild(pad); wrapper.appendChild(volSlider); // Removed input append
    padGrid.appendChild(wrapper);
}

// Kept for Drag & Drop support
async function loadSampleFile(file, index, padElement) {
    try {
        // Use exposed API instead of webUtils directly
        const filePath = bridge.getPathForFile(file);
        // Reuse load logic via path if possible to unify, but file object is already here
        // We can just proceed as before for D&D
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = filePath;
        padElement.classList.add('loaded');
        // Detect BPM
        padBPMs[index] = detectBPM(audioBuffer);
    } catch (err) { console.error(err); }
}

async function loadSampleFromPath(path, index) {
    try {
        // BRIDGE CALL: Read file
        const buffer = await fsBridge.readFile(path);
        // Electron returns Uint8Array usually over IPC
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        padBuffers[index] = audioBuffer;
        padPaths[index] = path;
        padGrid.children[index].querySelector('.pad').classList.add('loaded');
        // Detect BPM
        padBPMs[index] = detectBPM(audioBuffer);
    } catch (e) { console.log(e); }
}

function startPad(index) {
    if (!padBuffers[index]) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const pad = padGrid.children[index].querySelector('.pad');
    pad.classList.add('active');
    pad.setAttribute('aria-pressed', 'true');

    if (activeVoices[index]) {
        try { activeVoices[index].source.stop(); } catch (e) { }
    }
    const source = audioCtx.createBufferSource();
    source.buffer = padBuffers[index];
    source.loop = true;
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(padVolumes[index], audioCtx.currentTime);

    // NEW: Sync Logic
    let rate = parseFloat(document.getElementById('tempoSlider').value);
    if (padSyncState[index] && masterBPM > 0 && padBPMs[index] > 0) {
        // Calculate required rate to match Master BPM
        let syncRate = masterBPM / padBPMs[index];
        // Apply Chopper modifier on top of Sync
        rate = syncRate * rate;
    }
    source.playbackRate.value = rate;

    source.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(0);

    activeVoices[index] = { source: source, gain: gainNode };
}

function stopPad(index) {
    if (activeVoices[index]) {
        try { activeVoices[index].source.stop(); } catch (e) { }
        activeVoices[index] = null;
    }
    const pad = padGrid.children[index].querySelector('.pad');
    if (pad) {
        pad.classList.remove('active');
        pad.setAttribute('aria-pressed', 'false');
    }
}

document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const index = keyMap.indexOf(e.key.toLowerCase());

    if (index !== -1) {
        if (e.ctrlKey) {
            // SPECIAL EXCEPTION: Ctrl+A is reserved for "Select All"
            if (e.key.toLowerCase() === 'a') return;

            // CTRL + KEY: START RECORDING PAD
            const wrapper = padGrid.children[index];
            if (wrapper) {
                const recBtn = wrapper.querySelector('.rec-btn');
                startRecording(index, recBtn);
            }
        } else {
            // NORMAL KEY: PLAY PAD OR OPEN LOAD
            if (padBuffers[index]) {
                startPad(index);
            } else {
                // Pad is empty - user can click to load via dialog
            }
        }
    }
});

document.addEventListener('keyup', (e) => {
    const index = keyMap.indexOf(e.key.toLowerCase());

    if (index !== -1) {
        // If we were recording (Ctrl was seemingly held or we simply assume Rec Stop on KeyUp)
        // We should check if that pad is currently recording
        const wrapper = padGrid.children[index];
        if (wrapper) {
            const recBtn = wrapper.querySelector('.rec-btn');
            if (recBtn.classList.contains('recording')) {
                const pad = wrapper.querySelector('.pad');
                stopRecording(index, recBtn, pad);
            } else {
                stopPad(index);
            }
        } else {
            stopPad(index);
        }
    }
});

// SAVE / LOAD KIT
window.saveKit = async function () {
    const savePath = await bridge.saveKit();
    if (!savePath) return;
    const kitData = { name: "My Custom Kit", pads: [] };
    for (let i = 0; i < 16; i++) {
        if (padPaths[i]) kitData.pads.push({ index: i, path: padPaths[i], volume: padVolumes[i] });
    }
    // BRIDGE CALL: Save File
    await fsBridge.saveFile(savePath, JSON.stringify(kitData, null, 2));
    alert("KIT SAVED SUCCESSFULLY!");
}

window.loadKitDialog = async function () {
    const loadPath = await bridge.loadKit();
    if (!loadPath) return;
    // BRIDGE CALL: Read File
    const rawData = await fsBridge.readFile(loadPath);
    // Convert buffer to string
    const textDecoder = new TextDecoder("utf-8");
    const jsonString = textDecoder.decode(rawData);
    const kitData = JSON.parse(jsonString);

    for (let i = 0; i < 16; i++) {
        padBuffers[i] = null; padPaths[i] = null;
        padGrid.children[i].querySelector('.pad').classList.remove('loaded');
    }
    kitData.pads.forEach(padInfo => {
        loadSampleFromPath(padInfo.path, padInfo.index);
        padGrid.children[padInfo.index].querySelector('.pad-slider').value = padInfo.volume;
        padVolumes[padInfo.index] = padInfo.volume;
    });
}

// PLAYER CODE
const playlistInput = document.getElementById('playlistInput');
const playlistEl = document.getElementById('playlist');
const trackTitle = document.getElementById('trackTitle');
const playPauseBtn = document.getElementById('playPauseBtn');
const visualizerContainer = document.getElementById('visualizer');
const progressBar = document.getElementById('progressBar');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const tempoSlider = document.getElementById('tempoSlider');
const playerAudio = new Audio();
playerAudio.crossOrigin = "anonymous";
const trackSource = audioCtx.createMediaElementSource(playerAudio);
trackSource.connect(masterGain);

// Master Recorder Logic (ScriptProcessor for true WAV)

const masterRecBtn = document.getElementById('masterRecBtn');
let isRecording = false;
let recNode = null;
let leftChannel = [];
let rightChannel = [];
let recordingLength = 0;

masterRecBtn.addEventListener('click', async () => {
    if (isRecording) {
        // STOP RECORDING
        isRecording = false;
        masterRecBtn.classList.remove('recording');

        // Disconnect
        if (recNode) {
            recNode.disconnect();
            masterGain.disconnect(recNode);
            recNode = null;
        }

        // ENCODE WAV
        const wavBuffer = createWavBuffer(leftChannel, rightChannel, recordingLength, audioCtx.sampleRate);
        const savePath = await bridge.saveAudioDialog();
        if (savePath) {
            await fsBridge.saveFile(savePath, new Uint8Array(wavBuffer));
            alert("Master Recording Saved Successfully!");
        }

    } else {
        // START RECORDING
        try {
            if (audioCtx.state === 'suspended') audioCtx.resume();

            leftChannel = [];
            rightChannel = [];
            recordingLength = 0;

            // BufferSize 4096, 2 Input, 2 Output
            recNode = audioCtx.createScriptProcessor(4096, 2, 2);

            recNode.onaudioprocess = (e) => {
                if (!isRecording) return;
                const left = e.inputBuffer.getChannelData(0);
                const right = e.inputBuffer.getChannelData(1);
                // We must clone the data
                leftChannel.push(new Float32Array(left));
                rightChannel.push(new Float32Array(right));
                recordingLength += 4096;
            };

            masterGain.connect(recNode);

            // Connect to zero gain to keep graph alive without feedback/doubling
            const zeroGain = audioCtx.createGain();
            zeroGain.gain.value = 0;
            recNode.connect(zeroGain);
            zeroGain.connect(audioCtx.destination);

            isRecording = true;
            masterRecBtn.classList.add('recording');

        } catch (e) {
            console.error("Master Rec Failed:", e);
            alert("Could not start recording.");
        }
    }
});

// WAV ENCODER HELPERS
function createWavBuffer(left, right, length, sampleRate) {
    const buffer = new ArrayBuffer(44 + length * 4); // 2 channels * 2 bytes (16-bit)
    const view = new DataView(buffer);
    const channels = 2;

    // Flatten buffers
    const leftBuffer = mergeBuffers(left, length);
    const rightBuffer = mergeBuffers(right, length);

    // Write Header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length * 4, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true); // Block align
    view.setUint16(34, 16, true); // 16-bit
    writeString(view, 36, 'data');
    view.setUint32(40, length * 4, true);

    // Write Data (Interleaved)
    let offset = 44;
    for (let i = 0; i < length; i++) {
        // Left
        let s = Math.max(-1, Math.min(1, leftBuffer[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, s, true);
        offset += 2;

        // Right
        s = Math.max(-1, Math.min(1, rightBuffer[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, s, true);
        offset += 2;
    }

    return buffer;
}

function mergeBuffers(channelBuffer, length) {
    const result = new Float32Array(length);
    let offset = 0;
    for (let i = 0; i < channelBuffer.length; i++) {
        result.set(channelBuffer[i], offset);
        offset += channelBuffer[i].length;
    }
    return result;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

let playlist = [];
let currentTrackIndex = 0;
let selectedIndices = []; // Multi-select array
let anchorIndex = -1; // Anchor for Shift+Click range selection
let isPlaying = false;
let isDraggingProgress = false;
// NEW: BPM Global Vars
let masterBPM = 0;
let padBPMs = {};
let isPlaylistLooping = false;
let padSyncState = {};
function toggleSync(index) {
    padSyncState[index] = !padSyncState[index];
}
function detectBPM(buffer) {
    const data = buffer.getChannelData(0);
    const peaks = [];
    const threshold = BPM_DETECTION_THRESHOLD;
    // Minimum time between beats to avoid counting the same kick drum twice
    const minStep = Math.floor(BPM_MIN_STEP_SECONDS * buffer.sampleRate);

    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > threshold) {
            peaks.push(i);
            // Skip forward to avoid re-triggering on same beat
            i += minStep;
        }
    }

    if (peaks.length < 5) return 0;
    const intervals = [];
    for (let i = 0; i < peaks.length - 1; i++) {
        intervals.push(peaks[i + 1] - peaks[i]);
    }
    // Sort and get median
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];

    let bpm = (buffer.sampleRate * 60) / median;

    // Clamp to reasonable rap/hip-hop range (60-180)
    // Sometimes double/half time is detected
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    return bpm;
}

playerAudio.addEventListener('timeupdate', () => {
    if (!isDraggingProgress && playerAudio.duration) {
        const progress = (playerAudio.currentTime / playerAudio.duration) * 100;
        progressBar.value = progress;
        currentTimeEl.innerText = formatTime(playerAudio.currentTime);
    }
});
playerAudio.addEventListener('loadedmetadata', () => {
    totalTimeEl.innerText = formatTime(playerAudio.duration);
    progressBar.max = 100;
});
progressBar.addEventListener('input', () => { isDraggingProgress = true; });
progressBar.addEventListener('change', (e) => {
    const seekTime = (e.target.value / 100) * playerAudio.duration;
    playerAudio.currentTime = seekTime;
    isDraggingProgress = false;
});
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}
playlistInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => { playlist.push({ name: file.name, url: URL.createObjectURL(file) }); });
    renderPlaylist();
    if (playlist.length > 0 && !playerAudio.src) loadTrack(0);
});

// Drag-and-drop reorder state
let draggedIndex = -1;
let draggedElement = null;
let isDragging = false;
let dragStartY = 0;
let dragThreshold = 8; // Pixels moved before drag starts

function renderPlaylist() {
    playlistEl.innerHTML = '';
    playlist.forEach((track, index) => {
        const li = document.createElement('li');
        li.innerText = track.name.substring(0, 30);
        li.dataset.index = index;
        if (index === currentTrackIndex) li.classList.add('playing');
        if (selectedIndices.includes(index)) {
            li.classList.add('selected');
            if (isDragging) li.classList.add('drag-placeholder');
        }

        // Disable native drag explicitly
        li.setAttribute('draggable', 'false');

        // Mousedown to start potential drag
        li.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left mouse button
            e.preventDefault(); // Prevent text selection/native drag
            draggedIndex = index;
            draggedElement = li;
            dragStartY = e.clientY;
            // NEW: Capture X start to calculate offset for horizontal tracking
            dragStartX = e.clientX; 
            isDragging = false; // Will become true if threshold exceeded
        });

        // Click to select ONLY (Visual update) - only if not dragging
        li.onclick = (e) => {
            if (isDragging) return;
            
            if (e.shiftKey) {
                // Shift: Range Selection
                if (anchorIndex === -1) anchorIndex = index;
                
                const start = Math.min(anchorIndex, index);
                const end = Math.max(anchorIndex, index);
                
                // If Ctrl is NOT held, clear previous selection first (Standard behavior)
                // If Ctrl IS held, we theoretically add this range to existing. 
                // For simplicity/standard, Shift usually defines the selection state relative to anchor.
                
                if (e.ctrlKey || e.metaKey) {
                    // Add range to existing
                    for (let i = start; i <= end; i++) {
                        if (!selectedIndices.includes(i)) selectedIndices.push(i);
                    }
                } else {
                    // Replace with range
                    selectedIndices = [];
                    for (let i = start; i <= end; i++) selectedIndices.push(i);
                }
                
            } else if (e.ctrlKey || e.metaKey) {
                // Ctrl: Toggle Selection
                anchorIndex = index;
                if (selectedIndices.includes(index)) {
                     selectedIndices = selectedIndices.filter(i => i !== index);
                } else {
                     selectedIndices.push(index);
                }
            } else {
                // Single Select
                anchorIndex = index;
                selectedIndices = [index];
            }
            renderPlaylist();
        };

        // Double Click to PLAY
        li.ondblclick = () => {
            if (isDragging) return;
            selectedIndices = [index];
            anchorIndex = index;
            currentTrackIndex = index;
            loadTrack(index);
            playTrack();
            renderPlaylist();
        };

        // Right click to remove (Custom Menu)
        li.oncontextmenu = (e) => {
            e.preventDefault();
            if (isDragging) return;
            if (!selectedIndices.includes(index)) {
                selectedIndices = [index];
                anchorIndex = index;
            }
            renderPlaylist();

            const menu = document.getElementById('contextMenu');
            menu.classList.remove('hidden');
            menu.setAttribute('aria-hidden', 'false');
            menu.style.left = e.pageX + 'px';
            menu.style.top = e.pageY + 'px';

            // Store index to remove
            menu.dataset.removeIndex = index;
        };


        playlistEl.appendChild(li);
    });


}

// Mouse move handler for drag reorder
// Note: We rely on live-reordering for visual feedback, so no floating clone is needed.

// GLOBAL: Aggressively kill native drag on playlist items to prevent ghosts
document.addEventListener('dragstart', (e) => {
    if (e.target && e.target.closest && e.target.closest('#playlist')) {
        e.preventDefault();
        return false;
    }
}, true); // Capturing phase

document.addEventListener('mousemove', (e) => {
    if (draggedIndex === -1) return;
    
    // Check if we've exceeded the drag threshold
    if (!isDragging && Math.abs(e.clientY - dragStartY) > dragThreshold) {
        isDragging = true;
        originalDragIndex = draggedIndex;
        
        // Ensure the dragged item is in the selection (if starting drag on unselected)
        if (!selectedIndices.includes(draggedIndex)) {
            selectedIndices = [draggedIndex];
            renderPlaylist(); // Update visuals immediately
        }
        
        // Mark placeholders (all selected)
        const items = playlistEl.querySelectorAll('li');
        selectedIndices.forEach(idx => {
            if (items[idx]) items[idx].classList.add('drag-placeholder');
        });
    }
    
    if (!isDragging) return;
    
    // Find which item we're hovering over
    const items = playlistEl.querySelectorAll('li');
    let targetIndex = -1;
    
    // Optimization: Only check items that are effectively under the cursor
    // But simplest is to reuse existing logic slightly modified
    
    for (let i = 0; i < items.length; i++) {
        // Skip if this item is part of the selection (moving over ourselves)
        if (selectedIndices.includes(i)) continue;
        
        const rect = items[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        
        // Check if we are "invading" this item's space
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
             targetIndex = i;
             break;
        }
    }
    
    // If we have a valid target index that is NOT in our selection
    if (targetIndex !== -1 && !selectedIndices.includes(targetIndex)) {
        
        const sorted = [...selectedIndices].sort((a, b) => a - b);
        const minSel = sorted[0];
        const maxSel = sorted[sorted.length - 1];
        
        // Determine direction relative to the group
        // If targetIndex > maxSel -> We are dragging DOWN past target
        // If targetIndex < minSel -> We are dragging UP past target
        
        if (targetIndex > maxSel) {
            // Dragging DOWN: Move 'target' to 'minSel' position (jump over group to top)
            // Implementation: Remove target, Insert at minSel
            const item = playlist[targetIndex];
            playlist.splice(targetIndex, 1);
            playlist.splice(minSel, 0, item);
            
            // Adjust indices
            // Target (was > group) removed -> No index change for group yet
            // Target inserted at minSel -> Group indices shift +1
            selectedIndices = selectedIndices.map(idx => idx + 1);
            
            // Adjust Current Track
            if (currentTrackIndex === targetIndex) currentTrackIndex = minSel;
            else if (selectedIndices.includes(currentTrackIndex + 1)) currentTrackIndex++; // Track was in group
           
        } else if (targetIndex < minSel) {
            // Dragging UP: Move 'target' to 'maxSel' position (jump over group to bottom)
            // Implementation: Remove target, Insert at maxSel (after adjustment)
            
            // Note: maxSel will decrease by 1 when we remove target (since target < minSel <= maxSel)
            // So we insert at (original maxSel). Because splice insert is 'before', we actually want to insert AFTER the group
            // The group effectively shifts -1.
            // Original: [T, S1, S2] -> Remove T -> [S1, S2] -> Insert T at 2 -> [S1, S2, T]
            
            const item = playlist[targetIndex];
            playlist.splice(targetIndex, 1);
            // After removal, indices > targetIndex shift down by 1.
            // So the group indices become (idx - 1).
            // We want to insert 'item' AFTER the group.
            // The last item of group is now at (maxSel - 1).
            // So we insert at (maxSel - 1) + 1 = maxSel.
            // Wait, splice(index, 0) inserts before.
            // [S1(0), S2(1)]. Insert at 2 -> [S1, S2, Item]. Correct.
            playlist.splice(maxSel, 0, item);
            
            // Group indices shift -1
            selectedIndices = selectedIndices.map(idx => idx - 1);
             
            // Adjust Current Track
             if (currentTrackIndex === targetIndex) currentTrackIndex = maxSel; // Target moved to bottom of group
             else if (selectedIndices.includes(currentTrackIndex - 1)) currentTrackIndex--; // Track was in group
        }
        
        renderPlaylist();
        
        // Update placeholders
        const newItems = playlistEl.querySelectorAll('li');
        // Clear old placeholders first? renderPlaylist does that naturally 
        // But we need to re-apply the class because renderPlaylist wipes it
        // actually renderPlaylist checks selectedIndices? 
        // We added specific 'dragging' class logic in renderPlaylist which checks draggedIndex
        // We need to update that to check selectedIndices + isDragging
        
        // Manually re-add placeholder class for now to avoid flicker or reliance on render logic only
        selectedIndices.forEach(idx => {
             if (newItems[idx]) newItems[idx].classList.add('drag-placeholder');
        });
        
        // Update dragClone text if needed
        if (draggedElement) {
             // Keeps following mouse
        }
    }
});

// Mouse up handler to complete drag
document.addEventListener('mouseup', (e) => {
    if (draggedIndex === -1) return;
    
    // Remove placeholder class
    if (draggedElement) {
        draggedElement.classList.remove('drag-placeholder', 'dragging');
    }
    
    // Final render
    if (isDragging) {
        renderPlaylist();
    }
    
    draggedIndex = -1;
    draggedElement = null;
    isDragging = false;
    originalDragIndex = -1;
});

// === EXTERNAL FILE DRAG & DROP (from Windows Explorer) ===
const validAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-m4a', 'audio/mp4'];
const validAudioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

function isValidAudioFile(file) {
    if (validAudioTypes.includes(file.type)) return true;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    return validAudioExtensions.includes(ext);
}

// Playlist drop zone
playlistEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show drop zone for external files (not internal reorder)
    if (e.dataTransfer.types.includes('Files')) {
        playlistEl.classList.add('drop-target');
        e.dataTransfer.dropEffect = 'copy';
    }
});

playlistEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    playlistEl.classList.remove('drop-target');
});

playlistEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    playlistEl.classList.remove('drop-target');
    
    const files = Array.from(e.dataTransfer.files).filter(isValidAudioFile);
    if (files.length === 0) return;
    
    console.log('[Playlist] Dropped', files.length, 'audio files');
    
    files.forEach(file => {
        playlist.push({ 
            name: file.name, 
            url: URL.createObjectURL(file),
            filePath: file.path // Store path for potential future use
        });
    });
    
    renderPlaylist();
    if (playlist.length > 0 && !playerAudio.src) loadTrack(0);
});

// Pad drop zones - defer setup until pads exist
function setupPadDropZones() {
    const pads = document.querySelectorAll('.pad');
    
    pads.forEach((pad, index) => {
        pad.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.types.includes('Files')) {
                pad.classList.add('drop-target');
                e.dataTransfer.dropEffect = 'copy';
            }
        });
        
        pad.addEventListener('dragleave', (e) => {
            e.preventDefault();
            pad.classList.remove('drop-target');
        });
        
        pad.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pad.classList.remove('drop-target');
            
            const files = Array.from(e.dataTransfer.files).filter(isValidAudioFile);
            if (files.length === 0) return;
            
            // Load the first valid audio file into this pad
            const file = files[0];
            console.log('[Pad', index, '] Dropped:', file.name);
            
            // Create URL and load into pad
            const url = URL.createObjectURL(file);
            loadPadAudio(index, url, file.name);
        });
    });
}

// Helper to load audio onto a pad
async function loadPadAudio(index, url, name) {
    try {
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        padBuffers[index] = audioBuffer;
        
        // Update pad visuals
        const pad = document.querySelectorAll('.pad')[index];
        if (pad) {
            // Clean filename for display (max 6 chars + ...)
            const shortName = name.length > 6 ? name.substring(0, 6) + '…' : name.split('.')[0];
            pad.innerText = shortName.toUpperCase();
            pad.classList.add('loaded');
        }
        
        // Detect BPM if possible
        const bpm = detectBPM(audioBuffer);
        if (bpm > 0) padBPMs[index] = bpm;
        
        console.log('[Pad', index, '] Loaded:', name, bpm > 0 ? `(${Math.round(bpm)} BPM)` : '');
    } catch (err) {
        console.error('[Pad', index, '] Load failed:', err);
    }
}

// Setup drop zones after DOM is ready
setTimeout(setupPadDropZones, 100);

// Click on empty playlist area to deselect
playlistEl.addEventListener('click', (e) => {
    // Only deselect if clicking directly on the playlist container (empty space)
    if (e.target === playlistEl) {
        selectedIndices = [];
        renderPlaylist();
    }
});

// GLOBAL CLICK TO CLOSE MENU
document.addEventListener('click', (e) => {
    const ctxMenu = document.getElementById('contextMenu');
    const padCtxMenu = document.getElementById('padContextMenu');
    ctxMenu.classList.add('hidden');
    ctxMenu.setAttribute('aria-hidden', 'true');
    padCtxMenu.classList.add('hidden');
    padCtxMenu.setAttribute('aria-hidden', 'true');
});

// CONTEXT MENU ACTIONS
const ctxMenu = document.getElementById('contextMenu');

// PAD CONTEXT MENU ACTIONS
const padCtxMenu = document.getElementById('padContextMenu');
document.getElementById('ctxLoadSample').addEventListener('click', async () => {
    const padIndex = parseInt(padCtxMenu.dataset.padIndex);
    if (!isNaN(padIndex)) {
        const filePath = await bridge.openSampleDialog();
        if (filePath) loadSampleFromPath(filePath, padIndex);
    }
});

document.getElementById('ctxSync').addEventListener('click', () => {
    const padIndex = parseInt(padCtxMenu.dataset.padIndex);
    if (!isNaN(padIndex)) {
        toggleSync(padIndex);
    }
});

document.getElementById('ctxPlay').addEventListener('click', () => {
    const index = parseInt(ctxMenu.dataset.removeIndex);
    if (!isNaN(index) && playlist[index]) {
        currentTrackIndex = index;
        selectedIndices = [index];
        loadTrack(index);
        playTrack();
        renderPlaylist();
    }
});

document.getElementById('ctxMoveUp').addEventListener('click', () => {
    if (selectedIndices.length === 0) return;
    
    // Sort indices ascending for proper movement
    const sorted = [...selectedIndices].sort((a, b) => a - b);
    const minIndex = sorted[0];
    
    // Can't move up if already at top
    if (minIndex <= 0) return;
    
    // Move all selected items up by 1
    sorted.forEach(idx => {
        const temp = playlist[idx];
        playlist[idx] = playlist[idx - 1];
        playlist[idx - 1] = temp;
    });
    
    // Update selected indices (all moved up by 1)
    selectedIndices = sorted.map(idx => idx - 1);
    
    // Update current track index if affected
    if (selectedIndices.includes(currentTrackIndex - 1)) {
        // Current track was in selected group, it moved
    } else if (sorted.includes(currentTrackIndex + 1)) {
        // Current track was swapped with a selected item
        currentTrackIndex++;
    }
    // Recalculate current track position
    const wasPlaying = sorted.includes(currentTrackIndex + 1);
    sorted.forEach(idx => {
        if (currentTrackIndex === idx) currentTrackIndex = idx - 1;
        else if (currentTrackIndex === idx - 1) currentTrackIndex = idx;
    });
    
    renderPlaylist();
});

document.getElementById('ctxMoveDown').addEventListener('click', () => {
    if (selectedIndices.length === 0) return;
    
    // Sort indices descending for proper movement (move from bottom up)
    const sorted = [...selectedIndices].sort((a, b) => b - a);
    const maxIndex = sorted[0];
    
    // Can't move down if already at bottom
    if (maxIndex >= playlist.length - 1) return;
    
    // Move all selected items down by 1 (starting from the last one)
    sorted.forEach(idx => {
        const temp = playlist[idx];
        playlist[idx] = playlist[idx + 1];
        playlist[idx + 1] = temp;
    });
    
    // Update selected indices (all moved down by 1)
    selectedIndices = sorted.map(idx => idx + 1);
    
    // Recalculate current track position  
    sorted.forEach(idx => {
        if (currentTrackIndex === idx) currentTrackIndex = idx + 1;
        else if (currentTrackIndex === idx + 1) currentTrackIndex = idx;
    });
    
    renderPlaylist();
});

document.getElementById('ctxRemove').addEventListener('click', () => {
    // Remove all selected items (in reverse order to preserve indices)
    const toRemove = [...selectedIndices].sort((a, b) => b - a);
    toRemove.forEach(idx => {
        if (idx >= 0 && idx < playlist.length) {
            playlist.splice(idx, 1);
            if (currentTrackIndex === idx) currentTrackIndex = Math.max(0, currentTrackIndex - 1);
            else if (currentTrackIndex > idx) currentTrackIndex--;
        }
    });
    if (currentTrackIndex >= playlist.length) currentTrackIndex = Math.max(0, playlist.length - 1);
    selectedIndices = [];
    renderPlaylist();
});

// Update renderPlaylist to toggle game

// Initialize on load

async function loadTrack(index) {
    if (index < 0 || index >= playlist.length) return;

    // IMMEDIATE UI UPDATE (Optimistic)
    Array.from(playlistEl.children).forEach(li => li.classList.remove('playing'));
    if (playlistEl.children[index]) playlistEl.children[index].classList.add('playing');

    playerAudio.src = playlist[index].url;
    playerAudio.playbackRate = tempoSlider.value;
    trackTitle.innerText = playlist[index].name + " [Analyzing...]";

    // Analyze Master BPM
    try {
        const arrayBuffer = await (await fetch(playlist[index].url)).arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        masterBPM = detectBPM(audioBuffer);

        let bpmText = " [BPM: ?]";
        if (masterBPM > 0) bpmText = ` [${Math.round(masterBPM)} BPM]`;
        trackTitle.innerText = playlist[index].name + bpmText;

        // Trigger manual update of chopper to refresh display
        tempoSlider.dispatchEvent(new Event('input'));
    } catch (e) {
        console.error("BPM Detect Failed? ", e);
        trackTitle.innerText = playlist[index].name + " [BPM: Error]";
    }
}
function playTrack() {
    if (playlist.length === 0) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    playerAudio.play().then(_ => { isPlaying = true; playPauseBtn.innerText = "PAUSE"; }).catch(e => console.log(e));
}
function pauseTrack() { playerAudio.pause(); isPlaying = false; playPauseBtn.innerText = "PLAY"; }
// Play/Pause Button Logic
playPauseBtn.addEventListener('click', () => { 
    // PREVENT interaction during Auto-Mix
    if (typeof isCrossfadeInProgress !== 'undefined' && isCrossfadeInProgress) return;
    
    if (isPlaying) pauseTrack(); 
    else playTrack(); 
});

// Stop Button Logic (Universal Emergency Reset)
document.getElementById('stopBtn').addEventListener('click', () => { 
    // ALWAYS PERFORM RESET (Universal Panic Button)
    console.log('[Stop] 🛑 Universal Reset Triggered');
    
    // 1. Stop Crossfade Audio if exists
    if (typeof crossfadeAudio !== 'undefined' && crossfadeAudio) {
        try { crossfadeAudio.pause(); } catch(e){}
        crossfadeAudio.src = '';
        crossfadeAudio = null;
    }
    
    // 2. Cancel ALL Scheduled Events & Reset Gains
    const now = audioCtx.currentTime;
    
    // Main Player
    if (typeof playerGain !== 'undefined') {
        playerGain.gain.cancelScheduledValues(now);
        playerGain.gain.setValueAtTime(1, now); // Reset to full vol
    }
    
    // Crossfade Player
    if (typeof crossfadeGain !== 'undefined') {
        crossfadeGain.gain.cancelScheduledValues(now);
        crossfadeGain.gain.setValueAtTime(0, now);
    }
    
    // EQs (Reset to flat)
    if (typeof player_lowEQ !== 'undefined') {
        player_lowEQ.gain.cancelScheduledValues(now); player_lowEQ.gain.setValueAtTime(0, now);
        player_midEQ.gain.cancelScheduledValues(now); player_midEQ.gain.setValueAtTime(0, now);
        player_highEQ.gain.cancelScheduledValues(now); player_highEQ.gain.setValueAtTime(0, now);
        player_lpf.frequency.cancelScheduledValues(now); player_lpf.frequency.setValueAtTime(20000, now);
    }
    
    if (typeof cf_lowEQ !== 'undefined') {
        cf_lowEQ.gain.cancelScheduledValues(now); cf_lowEQ.gain.setValueAtTime(-24, now);
        cf_midEQ.gain.cancelScheduledValues(now); cf_midEQ.gain.setValueAtTime(-6, now);
    }
    
    // 3. Reset State & UI
    isCrossfadeInProgress = false;
    if (typeof autoMixBtn !== 'undefined' && autoMixBtn) {
        autoMixBtn.classList.remove('processing');
        autoMixBtn.textContent = 'MIX';
    }
    
    // Re-enable Controls
    if (progressBar) { progressBar.style.pointerEvents = 'auto'; progressBar.style.opacity = '1'; }
    if (playPauseBtn) { playPauseBtn.style.pointerEvents = 'auto'; playPauseBtn.style.opacity = '1'; }
    
    // Clear playlist indicators
    if (typeof playlistEl !== 'undefined') {
        Array.from(playlistEl.children).forEach(li => li.classList.remove('mixing-in'));
    }

    pauseTrack(); 
    playerAudio.currentTime = 0; 
});
document.getElementById('nextBtn').addEventListener('click', () => {
    // Check for Auto-Mix
    if (typeof isAutoMixEnabled !== 'undefined' && isAutoMixEnabled && !autoMixBtn.classList.contains('processing')) {
        const nextIndex = (currentTrackIndex + 1) % playlist.length;
        startCrossfade(nextIndex, buttonMixDuration); // Use dynamic duration
    } else {
        currentTrackIndex = (currentTrackIndex + 1) % playlist.length; loadTrack(currentTrackIndex); playTrack();
    }
});
document.getElementById('prevBtn').addEventListener('click', () => {
    // Check for Auto-Mix
    if (typeof isAutoMixEnabled !== 'undefined' && isAutoMixEnabled && !autoMixBtn.classList.contains('processing')) {
        const prevIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        startCrossfade(prevIndex, buttonMixDuration); // Use dynamic duration
    } else {
        currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length; loadTrack(currentTrackIndex); playTrack();
    }
});
playerAudio.addEventListener('ended', async () => {
    // 1. CHECK LOOP FIRST (Highest Priority)
    if (isPlaylistLooping) {
        console.log('[Player] Looping Track...');
        playerAudio.currentTime = 0;
        playerAudio.play().catch(e => console.error("Loop Play Error:", e));
        return;
    }

    // Check if AUTO MIX is enabled
    if (typeof isAutoMixEnabled !== 'undefined' && isAutoMixEnabled && playlist.length > 1) {
        console.log('[AutoMix] Track ended, transitioning with mix...');
        // Simply go to next track - the mixing happens before the track ends
        // via the timeupdate listener
        currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
        loadTrack(currentTrackIndex);
        playTrack();
    } else {
        currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
        loadTrack(currentTrackIndex);
        playTrack();
    }
});

// Loop Button Logic
const loopBtn = document.getElementById('loopBtn');
if (loopBtn) {
    loopBtn.addEventListener('click', () => {
        isPlaylistLooping = !isPlaylistLooping;
        if (isPlaylistLooping) {
            loopBtn.classList.add('loop-active');
        } else {
            loopBtn.classList.remove('loop-active');
        }
    });
}
// NEW: Master Volume & Visual Knob Logic (75% Scale)
function updateVolKnob() {
    const volInput = document.getElementById('masterVol');
    const volKnob = document.getElementById('volKnob');
    if (!volInput || !volKnob) return;

    const val = parseFloat(volInput.value);
    const min = parseFloat(volInput.min) || 0;
    const max = parseFloat(volInput.max) || 1;
    const percent = (val - min) / (max - min);
    
    // The thumb moves from left=0 to left=(width - thumbWidth)
    // We must match the CSS width of the thumb/knob (45px)
    const thumbWidth = 45; 
    const containerWidth = volInput.offsetWidth;
    const maxLeft = containerWidth - thumbWidth;
    const leftPos = percent * maxLeft;
    
    volKnob.style.left = `${leftPos}px`;
    volKnob.innerText = `${Math.round(val * 100)}%`;
}

document.getElementById('masterVol').addEventListener('input', (e) => {
    masterGain.gain.value = e.target.value;
    updateVolKnob();
});
window.addEventListener('resize', updateVolKnob);
// Initial call after a short delay to ensure layout is done
setTimeout(updateVolKnob, 100);

// Startup Optimization: Wait for Fonts
document.fonts.ready.then(() => {
    console.log('[Startup] Fonts loaded, showing window.');
    // Small extra buffer for repaint
    setTimeout(() => bridge.appReadyToShow(), 100);
});
tempoSlider.addEventListener('input', (e) => {
    // NEW: Magnetic Snap
    let val = parseFloat(e.target.value);
    if (val > 0.95 && val < 1.05) {
        val = 1.0;
        tempoSlider.value = 1.0;
    }

    // Update Chopper Display
    let bpmText = "---";
    if (masterBPM > 0) bpmText = Math.round(masterBPM * val);
    try { document.getElementById('chopperBPM').innerText = `SPEED: ${Math.round(val * 100)}% (BPM: ${bpmText})`; } catch (e) { }

    // Apply to Player
    playerAudio.playbackRate = val;

    // Apply to Active Pads
    Object.values(activeVoices).forEach(voice => {
        if (voice && voice.source) {
            try { voice.source.playbackRate.value = val; } catch (e) { }
        }
    });
});

// NEW: GLOBAL KEY SHORTCUTS
document.addEventListener('keydown', (e) => {
    // Prevent default scrolling for arrow keys if playlist is involved (optional, but good for UI)
    if (['ArrowUp', 'ArrowDown', ' ', 'Delete'].includes(e.key)) {
        // e.preventDefault(); // Maybe don't prevent default everywhere?
    }

    if (e.key === ' ' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        if (isPlaying) pauseTrack(); else playTrack();
    }

    // Seek 5 seconds with Left/Right arrows
    if (e.key === 'ArrowLeft' && playerAudio.src) {
        e.preventDefault();
        playerAudio.currentTime = Math.max(0, playerAudio.currentTime - 5);
    }
    if (e.key === 'ArrowRight' && playerAudio.src) {
        e.preventDefault();
        playerAudio.currentTime = Math.min(playerAudio.duration, playerAudio.currentTime + 5);
    }

    if (playlist.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            // Get anchor index (last selected, or -1 if none)
            const anchor = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : -1;
            let newIndex = anchor + 1;
            if (newIndex >= playlist.length) newIndex = 0;
            
            if (e.shiftKey && selectedIndices.length > 0) {
                // Toggle selection - if already selected, remove; otherwise add
                if (selectedIndices.includes(newIndex)) {
                    // Moving down into already-selected territory - shrink by removing anchor
                    if (selectedIndices.length > 1) {
                        selectedIndices.pop(); // Remove the last (anchor)
                    }
                } else {
                    // Extend selection
                    selectedIndices.push(newIndex);
                }
            } else {
                // Single selection
                selectedIndices = [newIndex];
            }
            renderPlaylist();
            // Scroll into view (use the new anchor)
            const scrollTo = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : newIndex;
            if (playlistEl.children[scrollTo]) playlistEl.children[scrollTo].scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            // Get anchor index (last selected, or 0 if none)
            const anchor = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : 0;
            let newIndex = anchor - 1;
            if (newIndex < 0) newIndex = playlist.length - 1;
            
            if (e.shiftKey && selectedIndices.length > 0) {
                // Toggle selection - if already selected, remove; otherwise add
                if (selectedIndices.includes(newIndex)) {
                    // Moving up into already-selected territory - shrink by removing anchor
                    if (selectedIndices.length > 1) {
                        selectedIndices.pop(); // Remove the last (anchor)
                    }
                } else {
                    // Extend selection
                    selectedIndices.push(newIndex);
                }
            } else {
                // Single selection
                selectedIndices = [newIndex];
            }
            renderPlaylist();
            const scrollTo = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : newIndex;
            if (playlistEl.children[scrollTo]) playlistEl.children[scrollTo].scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter') {
            // Universal Stop / Emergency Reset via Stop Button
            const stopBtn = document.getElementById('stopBtn');
            if (stopBtn) stopBtn.click();
        }
        if (e.key === 'Delete') {
            if (selectedIndices.length > 0) {
                // Remove all selected items (in reverse order to preserve indices)
                const toRemove = [...selectedIndices].sort((a, b) => b - a);
                toRemove.forEach(idx => {
                    if (idx >= 0 && idx < playlist.length) {
                        playlist.splice(idx, 1);
                        if (currentTrackIndex === idx) currentTrackIndex = Math.max(0, currentTrackIndex - 1);
                        else if (currentTrackIndex > idx) currentTrackIndex--;
                    }
                });
                if (currentTrackIndex >= playlist.length) currentTrackIndex = Math.max(0, playlist.length - 1);
                selectedIndices = [];
                renderPlaylist();
            }
        }
    }

    // Ctrl + A: Select All
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectedIndices = playlist.map((_, i) => i);
        renderPlaylist();
    }
});

// VISUALIZER & LIGHTS
const dataArray = new Uint8Array(analyser.frequencyBinCount);
const visualizerBars = [];
const barColors = ['#ff0000', '#d4002b', '#aa0055', '#800080', '#990ae6', '#bc13fe', '#bc13fe', '#a030f0', '#8a50d0', '#7070b0', '#509090', '#30b070', '#20d050', '#10f030', '#39ff14', '#39ff14'];
for (let i = 0; i < 16; i++) {
    let bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.backgroundColor = barColors[i];
    visualizerContainer.appendChild(bar);
    visualizerBars.push(bar);
}
const leds = [document.getElementById('l1'), document.getElementById('l2'), document.getElementById('l3'), document.getElementById('r1'), document.getElementById('r2'), document.getElementById('r3')];
let scannerIndex = 0;
let scannerDirection = 1;
let lastScannerUpdate = 0;

function masterLoop() {
    requestAnimationFrame(masterLoop);
    analyser.getByteFrequencyData(dataArray);
    let totalVol = 0;
    for (let i = 0; i < dataArray.length; i++) totalVol += dataArray[i];
    let totalAvg = totalVol / dataArray.length;

    // CONSTANTS FOR VISUALIZER
    const BASS_THRESHOLD = 200;
    const MID_THRESHOLD = 160;
    const HIGH_THRESHOLD = 100;
    const AVG_THRESHOLD = 2;

    if (totalAvg > AVG_THRESHOLD) {
        let bassSum = 0, midSum = 0, highSum = 0;
        const step = Math.floor(dataArray.length / 16);
        visualizerBars.forEach((bar, i) => {
            const value = dataArray[i * step];
            bar.style.height = Math.max(5, (value / 255) * 100) + '%';
        });
        for (let i = 0; i < 5; i++) bassSum += dataArray[i];
        for (let i = 10; i < 30; i++) midSum += dataArray[i];
        for (let i = 80; i < 120; i++) highSum += dataArray[i];
        leds.forEach(l => l.classList.remove('lit'));
        if ((bassSum / 5) > BASS_THRESHOLD) { leds[0].classList.add('lit'); leds[5].classList.add('lit'); }
        if ((midSum / 20) > MID_THRESHOLD) { leds[1].classList.add('lit'); leds[4].classList.add('lit'); }
        if ((highSum / 40) > HIGH_THRESHOLD) { leds[2].classList.add('lit'); leds[3].classList.add('lit'); }
    } else {
        visualizerBars.forEach(bar => bar.style.height = '5%');
        const now = performance.now();
        if (now - lastScannerUpdate > 300) {
            leds.forEach(l => l.classList.remove('lit'));
            if (scannerIndex === 0) { leds[0].classList.add('lit'); leds[5].classList.add('lit'); }
            if (scannerIndex === 1) { leds[1].classList.add('lit'); leds[4].classList.add('lit'); }
            if (scannerIndex === 2) { leds[2].classList.add('lit'); leds[3].classList.add('lit'); }
            scannerIndex += scannerDirection;
            if (scannerIndex >= 2 || scannerIndex <= 0) scannerDirection *= -1;
            lastScannerUpdate = now;
        }
    }
}
masterLoop();

// NEW: Settings UI Logic
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');
const inputDeviceSelect = document.getElementById('inputDeviceSelect');
const outputDeviceSelect = document.getElementById('outputDeviceSelect');
// Global vars for recording
let selectedInputId = 'default';
let selectedOutputId = 'default';

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        settingsModal.style.display = 'block';
        refreshAudioDevices();
    });
}
if (closeSettings) closeSettings.addEventListener('click', () => settingsModal.style.display = 'none');
const helpBtn = document.getElementById('helpBtn');
const openHelpFromSettings = document.getElementById('openHelpFromSettings'); // NEW
const helpModal = document.getElementById('helpModal');
const closeHelp = document.getElementById('closeHelp');

// Full Screen Logic
const fullScreenToggle = document.getElementById('fullScreenToggle');
if (fullScreenToggle) {
    fullScreenToggle.addEventListener('change', (e) => {
        bridge.setFullScreen(e.target.checked);
    });
}

// Track where Help was opened from
let helpOpenedFromSettings = false;

// Support both old footer button (if it existed) and new button
if (helpBtn) helpBtn.addEventListener('click', () => {
    helpOpenedFromSettings = false;
    helpModal.style.display = 'block';
});
if (openHelpFromSettings) {
    openHelpFromSettings.addEventListener('click', () => {
        helpOpenedFromSettings = true;
        settingsModal.style.display = 'none'; // Close settings
        helpModal.style.display = 'block'; // Open help
    });
}
if (closeHelp) closeHelp.addEventListener('click', () => {
    helpModal.style.display = 'none';
    // Return to Settings if opened from there
    if (helpOpenedFromSettings) {
        settingsModal.style.display = 'block';
        helpOpenedFromSettings = false;
    }
});

// Auto-Mix Modal Logic
const autoMixModal = document.getElementById('autoMixModal');
const btnOpenAutoMix = document.getElementById('btnOpenAutoMix');
const closeAutoMix = document.getElementById('closeAutoMix');

if (btnOpenAutoMix) {
    btnOpenAutoMix.addEventListener('click', () => {
        autoMixModal.style.display = 'block';
    });
}
if (closeAutoMix) {
    closeAutoMix.addEventListener('click', () => {
        autoMixModal.style.display = 'none';
    });
}
// Also close with the CLOSE button inside the modal
const closeAutoMixBtn = document.getElementById('closeAutoMixBtn');
if (closeAutoMixBtn) {
    closeAutoMixBtn.addEventListener('click', () => {
        autoMixModal.style.display = 'none';
    });
}

window.addEventListener('click', (e) => {
    if (e.target == helpModal) {
        helpModal.style.display = 'none';
        // Return to Settings if opened from there
        if (helpOpenedFromSettings) {
            settingsModal.style.display = 'block';
            helpOpenedFromSettings = false;
        }
    }
    if (e.target == settingsModal) settingsModal.style.display = 'none';
    if (e.target == autoMixModal) autoMixModal.style.display = 'none';
});

// === SETTINGS PERSISTENCE & SLIDERS ===
const defaultSettings = {
    fullScreen: false,
    inputDevice: 'default',
    outputDevice: 'default',
    midiDevice: 'all',
    autoMix: {
        eqCrossfade: true,
        filterSweep: true,
        hpfSweep: true,
        bpmSync: true,
        trackDuration: 16.0,
        btnDuration: 4.0
    }
};

// Cache DOM elements for settings to avoid repeated queries
const mixOptEQCrossfade = document.getElementById('mixOptEQCrossfade');
const mixOptFilterSweep = document.getElementById('mixOptFilterSweep');
const mixOptHPFSweep = document.getElementById('mixOptHPFSweep');
const mixOptBPMSync = document.getElementById('mixOptBPMSync');

let autoMixDuration = 10.0;
let buttonMixDuration = 4.0;

function loadSettings() {
    try {
        const saved = localStorage.getItem('ug_settings');
        if (saved) {
            const s = JSON.parse(saved);
            // Apply Settings
            if (fullScreenToggle) fullScreenToggle.checked = !!s.fullScreen;
            // Devices are async, set IDs to be selected when list refreshes
            if (s.inputDevice) selectedInputId = s.inputDevice;
            if (s.outputDevice) selectedOutputId = s.outputDevice;
            if (s.midiDevice) selectedMidiId = s.midiDevice;
            
            if (s.autoMix) {
                if (mixOptEQCrossfade) mixOptEQCrossfade.checked = !!s.autoMix.eqCrossfade;
                if (mixOptFilterSweep) mixOptFilterSweep.checked = !!s.autoMix.filterSweep;
                if (mixOptHPFSweep) mixOptHPFSweep.checked = !!s.autoMix.hpfSweep;
                if (mixOptBPMSync) mixOptBPMSync.checked = !!s.autoMix.bpmSync;
                
                // Durations
                autoMixDuration = parseFloat(s.autoMix.trackDuration) || 10.0;
                buttonMixDuration = parseFloat(s.autoMix.btnDuration) || 4.0;
                
                updateSliderUI('sliderTrackFade', 'valTrackFade', autoMixDuration);
                updateSliderUI('sliderBtnFade', 'valBtnFade', buttonMixDuration);
            }
        }
    } catch(e) { console.error("Load Settings Error", e); }
}

function saveSettings() {
    const s = {
        fullScreen: fullScreenToggle ? fullScreenToggle.checked : false,
        inputDevice: selectedInputId,
        outputDevice: selectedOutputId,
        midiDevice: selectedMidiId,
        autoMix: {
            eqCrossfade: mixOptEQCrossfade ? mixOptEQCrossfade.checked : true,
            filterSweep: mixOptFilterSweep ? mixOptFilterSweep.checked : true,
            hpfSweep: mixOptHPFSweep ? mixOptHPFSweep.checked : true,
            bpmSync: mixOptBPMSync ? mixOptBPMSync.checked : false,
            trackDuration: autoMixDuration,
            btnDuration: buttonMixDuration
        }
    };
    localStorage.setItem('ug_settings', JSON.stringify(s));
}

function restoreDefaults() {
    if(confirm("Restore all settings to default?")) {
        localStorage.removeItem('ug_settings');
        // Reset Variables
        autoMixDuration = 10.0;
        buttonMixDuration = 4.0;
        // Reset UI manually
        if (fullScreenToggle) fullScreenToggle.checked = false;
        if (mixOptEQCrossfade) mixOptEQCrossfade.checked = true;
        if (mixOptFilterSweep) mixOptFilterSweep.checked = true;
        if (mixOptHPFSweep) mixOptHPFSweep.checked = true;
        if (mixOptBPMSync) mixOptBPMSync.checked = false;
        updateSliderUI('sliderTrackFade', 'valTrackFade', 10.0);
        updateSliderUI('sliderBtnFade', 'valBtnFade', 4.0);
        // Save clean
        saveSettings();
        alert("Defaults Restored!");
    }
}

document.getElementById('restoreDefaultsBtn').addEventListener('click', restoreDefaults);

// Auto-Save Listeners
const settingIds = ['fullScreenToggle', 'inputDeviceSelect', 'outputDeviceSelect', 'midiDeviceSelect', 
                    'mixOptEQCrossfade', 'mixOptFilterSweep', 'mixOptHPFSweep', 'mixOptBPMSync'];

settingIds.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('change', saveSettings);
});

// Slider Logic with Magnetic Snap
function setupMagneticSlider(sliderId, labelId, isTrackFade) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    const defaultVal = isTrackFade ? 10.0 : 4.0;

    slider.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        
        // Magnetic Snap (within 1.0 for track, 0.5 for btn)
        const snapRange = isTrackFade ? 1.5 : 0.8;
        if (val > defaultVal - snapRange && val < defaultVal + snapRange) {
            val = defaultVal;
            slider.value = defaultVal; // Visual snap
        }

        label.innerText = val.toFixed(1) + 's';
        
        if (isTrackFade) autoMixDuration = val;
        else buttonMixDuration = val;
        
        saveSettings();
    });
}

function updateSliderUI(sliderId, labelId, val) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (slider && label) {
        slider.value = val;
        label.innerText = val.toFixed(1) + 's';
    }
}

setupMagneticSlider('sliderTrackFade', 'valTrackFade', true);
setupMagneticSlider('sliderBtnFade', 'valBtnFade', false);

// Init
setTimeout(loadSettings, 500); // Small delay to ensure DOM and Devices ready

async function refreshAudioDevices() {
    inputDeviceSelect.innerHTML = '';
    outputDeviceSelect.innerHTML = '';

    // Explicitly request permission to get labels
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { }

    const devices = await navigator.mediaDevices.enumerateDevices();
    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `${device.kind} - ${device.deviceId.substring(0, 8)}...`;

        if (device.kind === 'audioinput') {
            inputDeviceSelect.appendChild(option);
            if (device.deviceId === selectedInputId) option.selected = true;
        } else if (device.kind === 'audiooutput') {
            outputDeviceSelect.appendChild(option);
            if (device.deviceId === selectedOutputId) option.selected = true;
        }
    });
}
inputDeviceSelect.addEventListener('change', (e) => selectedInputId = e.target.value);
outputDeviceSelect.addEventListener('change', async (e) => {
    selectedOutputId = e.target.value;
    // Apply Output to main element if setSinkId is supported (Chrome/Edge Only)
    if (playerAudio.setSinkId) {
        try { await playerAudio.setSinkId(selectedOutputId); } catch (err) { console.error(err); }
    }
});


// NEW: Recording Logic
let mediaRecorders = {};
let audioChunks = {};

async function startRecording(index, btn) {
    // If already recording (double click safety)
    if (btn.classList.contains('recording')) return;

    try {
        await fsBridge.ensureRecordingsDir();

        const constraints = { audio: { deviceId: selectedInputId !== 'default' ? { exact: selectedInputId } : undefined } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        const recorder = new MediaRecorder(stream);
        mediaRecorders[index] = recorder;
        audioChunks[index] = [];

        recorder.ondataavailable = (e) => audioChunks[index].push(e.data);
        recorder.onstop = async () => {
            const blob = new Blob(audioChunks[index], { type: 'audio/wav' });
            // Clean up stream immediately
            stream.getTracks().forEach(track => track.stop());

            const arrayBuffer = await blob.arrayBuffer();
            const fileName = `rec_pad_${index + 1}_${Date.now()}.wav`;

            // Save via IPC
            const filePath = await fsBridge.saveRecording(arrayBuffer, fileName);

            // Auto-load to pad
            const decodedBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer()); // Clone buffer
            padBuffers[index] = decodedBuffer;
            padPaths[index] = filePath;

            // Update UI
            const padElement = padGrid.children[index].firstElementChild;
            padElement.classList.add('loaded');
            // Detect BPM
            padBPMs[index] = detectBPM(decodedBuffer);
            padElement.querySelector('.sync-btn').style.display = 'block'; // Force show
            padElement.querySelector('.load-btn').style.display = 'block';
        };

        recorder.start();
        btn.classList.add('recording');

    } catch (err) {
        console.error("Recording init failed", err);
        alert("Recording Failed: " + err.message);
        btn.classList.remove('recording');
    }
}

function stopRecording(index, btn, pad) {
    if (!mediaRecorders[index] || mediaRecorders[index].state === 'inactive') return;
    mediaRecorders[index].stop();
    btn.classList.remove('recording');
}
// NEW: Startup Sound
// NEW: Startup Sound (Web Audio API Version for Reliability)
function playStartupSound() {
    console.log("Loading startup sound...");

    // Resume context immediately (Autoplay policy switch in main.js allows this)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => console.log("AudioContext Resumed for Startup"));
    }

    fetch('gun-load.wav')
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            const source = audioCtx.createBufferSource();
            const gain = audioCtx.createGain();

            source.buffer = audioBuffer;
            gain.gain.value = 0.6;

            source.connect(gain);
            gain.connect(masterGain); // Connect to main master gain (visualizer etc)

            source.start(0);
            console.log("Startup sound triggered via Web Audio API");
        })
        .catch(e => console.error("Startup Sound Error:", e));
}
playStartupSound();

// NEW: Screw Easter Egg
const screws = document.querySelectorAll('.screw');
screws.forEach(screw => {
    let clicks = 0;
    let rotation = 0;
    screw.addEventListener('click', () => {
        if (screw.classList.contains('screw-hole')) return; // Stop interaction if already unscrewed
        clicks++;

        // Unscrew rotation
        rotation -= (15 + Math.random() * 30); // Rotate left 15-45 deg
        screw.style.transform = `rotate(${rotation}deg)`;
        screw.classList.add('loose');

        // Drop logic
        if (clicks >= 10) {
            // Create a clone for the falling animation
            const clone = screw.cloneNode(true);
            const rect = screw.getBoundingClientRect();

            // Position clone exactly where original is
            clone.style.position = 'fixed'; // Use fixed to escape container
            clone.style.top = rect.top + 'px';
            clone.style.left = rect.left + 'px';
            clone.style.zIndex = '1000';
            document.body.appendChild(clone);

            // Animate clone
            requestAnimationFrame(() => {
                clone.style.transition = 'all 1s ease-in';
                clone.style.transform = `translateY(1200px) rotate(${rotation - 720}deg)`;
                clone.style.opacity = '0';
            });

            // Turn original into a hole
            screw.className = 'screw-hole ' + screw.className.replace('screw', '').replace('loose', '').trim();
            screw.style.transform = 'none'; // Holes don't rotate

        // Remove clone
            setTimeout(() => clone.remove(), 600);
        }
    });
});

// ==================== PRO DJ AUTO-MIX FEATURE ====================
const sonetraAPI = window.sonetra;
const autoMixBtn = document.getElementById('autoMixBtn');
let isAutoMixEnabled = false;
let isAutoMixServerRunning = false;
let isCrossfadeInProgress = false;
let crossfadeAudio = null;
let crossfadeSource = null;
// const CROSSFADE_DURATION = 16; // Removed hardcoded const

// === Create audio processing chain for Track 1 (current) ===
let playerGain = audioCtx.createGain();

// 3-band EQ for Track 1
let player_lowEQ = audioCtx.createBiquadFilter();
player_lowEQ.type = 'lowshelf';
player_lowEQ.frequency.value = 320;
player_lowEQ.gain.value = 0;

let player_midEQ = audioCtx.createBiquadFilter();
player_midEQ.type = 'peaking';
player_midEQ.frequency.value = 1000;
player_midEQ.Q.value = 0.5;
player_midEQ.gain.value = 0;

let player_highEQ = audioCtx.createBiquadFilter();
player_highEQ.type = 'highshelf';
player_highEQ.frequency.value = 3200;
player_highEQ.gain.value = 0;

// Low-pass filter for sweep effect
let player_lpf = audioCtx.createBiquadFilter();
player_lpf.type = 'lowpass';
player_lpf.frequency.value = 20000;
player_lpf.Q.value = 1;

// Chain: source -> lowEQ -> midEQ -> highEQ -> lpf -> gain -> master
trackSource.disconnect();
trackSource.connect(player_lowEQ);
player_lowEQ.connect(player_midEQ);
player_midEQ.connect(player_highEQ);
player_highEQ.connect(player_lpf);
player_lpf.connect(playerGain);
playerGain.connect(masterGain);

// === Create audio processing chain for Track 2 (incoming) ===
let crossfadeGain = audioCtx.createGain();

let cf_lowEQ = audioCtx.createBiquadFilter();
cf_lowEQ.type = 'lowshelf';
cf_lowEQ.frequency.value = 320;
cf_lowEQ.gain.value = -24; // Start with bass cut

let cf_midEQ = audioCtx.createBiquadFilter();
cf_midEQ.type = 'peaking';
cf_midEQ.frequency.value = 1000;
cf_midEQ.Q.value = 0.5;
cf_midEQ.gain.value = 0;

let cf_highEQ = audioCtx.createBiquadFilter();
cf_highEQ.type = 'highshelf';
cf_highEQ.frequency.value = 3200;
cf_highEQ.gain.value = 0;

// High-pass filter for incoming track
let cf_hpf = audioCtx.createBiquadFilter();
cf_hpf.type = 'highpass';
cf_hpf.frequency.value = 30;
cf_hpf.Q.value = 0.7;

crossfadeGain.connect(masterGain);

// Mix settings object - reads from checkbox elements
const mixSettings = {
    get eqCrossfade() { 
        const el = document.getElementById('mixOptEQCrossfade');
        return el ? el.checked : true;
    },
    get filterSweep() {
        const el = document.getElementById('mixOptFilterSweep');
        return el ? el.checked : true;
    },
    get hpfSweep() {
        const el = document.getElementById('mixOptHPFSweep');
        return el ? el.checked : true;
    },
    get bpmSync() {
        const el = document.getElementById('mixOptBPMSync');
        return el ? el.checked : true; // Default true
    }
};


if (autoMixBtn) {
    // Toggle AUTO MIX
    autoMixBtn.addEventListener('click', async () => {
        if (isAutoMixEnabled) {
            // Disable AUTO MIX
            isAutoMixEnabled = false;
            autoMixBtn.classList.remove('active');
            autoMixBtn.textContent = 'MIX';
            console.log('[AutoMix] Disabled');
        } else {
            // Enable AUTO MIX
            autoMixBtn.classList.add('processing');
            autoMixBtn.textContent = '...';
            
            // Start server if not running (optional - for future Sonetra features)
            if (!isAutoMixServerRunning && sonetraAPI) {
                console.log('[AutoMix] Starting Sonetra server...');
                try {
                    const result = await sonetraAPI.startServer();
                    if (result.success) {
                        isAutoMixServerRunning = true;
                        console.log('[AutoMix] Server started on port', result.port);
                    } else {
                        console.warn('[AutoMix] Server not available, using local crossfade:', result.error);
                    }
                } catch (err) {
                    console.warn('[AutoMix] Server not available, using local crossfade');
                }
            }
            
            isAutoMixEnabled = true;
            autoMixBtn.classList.remove('processing');
            autoMixBtn.classList.add('active');
            autoMixBtn.textContent = 'MIX';
            console.log('[AutoMix] Enabled - crossfade will start', autoMixDuration, 'seconds before track end');
        }
    });
    
    // Monitor track time to start crossfade before end
    playerAudio.addEventListener('timeupdate', () => {
        if (!isAutoMixEnabled || isCrossfadeInProgress || playlist.length < 2) return;
        
        const timeRemaining = playerAudio.duration - playerAudio.currentTime;
        
        // Start crossfade when we're autoMixDuration seconds from the end
        if (timeRemaining > 0 && timeRemaining <= autoMixDuration && playerAudio.duration > autoMixDuration * 2) {
            startCrossfade();
        }
    });
    
    console.log('[AutoMix] Module initialized');
} else {
    console.warn('[AutoMix] Button not found - skipping initialization');
}

// Start DJ transition to next track
// Start DJ transition to target track
async function startCrossfade(targetIndex = null, customDuration = null) {
    if (isCrossfadeInProgress) return;
    isCrossfadeInProgress = true;
    
    // Use provided index or default to next
    const nextIndex = targetIndex !== null ? targetIndex : ((currentTrackIndex + 1) % playlist.length);
    console.log('[DJ MIX] 🎧 Starting pro DJ transition to:', playlist[nextIndex].name);
    
    // Disable Slider & Play Button
    if (progressBar) {
        progressBar.style.pointerEvents = 'none';
        progressBar.style.opacity = '0.5';
    }
    if (playPauseBtn) {
        playPauseBtn.style.pointerEvents = 'none';
        playPauseBtn.style.opacity = '0.5';
    }
    
    // Create incoming track audio
    crossfadeAudio = new Audio();
    crossfadeAudio.crossOrigin = "anonymous";
    crossfadeAudio.src = playlist[nextIndex].url;
    crossfadeAudio.volume = 1;
    
    // Connect incoming track through EQ chain
    crossfadeSource = audioCtx.createMediaElementSource(crossfadeAudio);
    crossfadeSource.connect(cf_lowEQ);
    cf_lowEQ.connect(cf_midEQ);
    cf_midEQ.connect(cf_highEQ);
    cf_highEQ.connect(cf_hpf);
    cf_hpf.connect(crossfadeGain);
    
    // Reset EQ states for incoming track
    cf_lowEQ.gain.value = -24;  // Bass fully cut initially
    cf_midEQ.gain.value = -6;   // Slight mid cut
    cf_highEQ.gain.value = 0;
    crossfadeGain.gain.value = 0.01;
    
    // Reset outgoing track EQ to flat
    player_lowEQ.gain.cancelScheduledValues(audioCtx.currentTime);
    player_lowEQ.gain.value = 0;
    player_midEQ.gain.cancelScheduledValues(audioCtx.currentTime);
    player_midEQ.gain.value = 0;
    player_highEQ.gain.cancelScheduledValues(audioCtx.currentTime);
    player_highEQ.gain.value = 0;
    player_lpf.frequency.cancelScheduledValues(audioCtx.currentTime);
    player_lpf.frequency.value = 20000;
    playerGain.gain.cancelScheduledValues(audioCtx.currentTime);
    playerGain.gain.value = 1;
    
    // Wait for track to load
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 8000);
        crossfadeAudio.addEventListener('canplaythrough', () => {
            clearTimeout(timeout);
            resolve();
        }, { once: true });
        crossfadeAudio.load();
    });
    
    // Match playback rate if BPM Sync enabled
    if (mixSettings.bpmSync) {
        crossfadeAudio.playbackRate = playerAudio.playbackRate;
    } else {
        crossfadeAudio.playbackRate = 1.0;
    }
    crossfadeAudio.play();
    
    // Calculate transition timing
    const now = audioCtx.currentTime;
    const timeRemaining = playerAudio.duration - playerAudio.currentTime;
    // Use custom duration if strictly provided, else clamp to time remaining
    const maxDuration = customDuration !== null ? customDuration : autoMixDuration;
    // If custom duration is set, we use it directly (assuming user wants to force it even if timeRemaining is huge)
    // But we still shouldn't exceed actual timeRemaining if it's very short (unlikely for mid-song skip)
    const transitionDuration = Math.min(timeRemaining, maxDuration);
    
    // === PRO DJ EQ CROSSFADE (Bass Swap Technique) ===
    // Phase 1 (0-25%): Bring in new track with bass cut
    // Phase 2 (25-50%): BASS SWAP - cut outgoing bass, bring in new bass
    // Phase 3 (50-75%): Cut outgoing mids, start filter sweep
    // Phase 4 (75-100%): Fade out remaining, new track fully in
    
    const t1 = transitionDuration * 0.25;
    const t2 = transitionDuration * 0.50;
    const t3 = transitionDuration * 0.75;
    const t4 = transitionDuration;
    
    console.log('[DJ MIX] 🎚️ Effects:', 
        'EQ=' + mixSettings.eqCrossfade, 
        'LPF=' + mixSettings.filterSweep,
        'HPF=' + mixSettings.hpfSweep,
        'Sync=' + mixSettings.bpmSync
    );
    
    // === OUTGOING TRACK EQ AUTOMATION ===
    
    if (mixSettings.eqCrossfade) {
        // Bass: Fully cut by Phase 2 (the swap moment)
        player_lowEQ.gain.setValueAtTime(0, now);
        player_lowEQ.gain.linearRampToValueAtTime(-6, now + t1);
        player_lowEQ.gain.linearRampToValueAtTime(-24, now + t2);
        
        // Mids: Start cutting at Phase 2
        player_midEQ.gain.setValueAtTime(0, now);
        player_midEQ.gain.setValueAtTime(0, now + t1);
        player_midEQ.gain.linearRampToValueAtTime(-12, now + t3);
        player_midEQ.gain.linearRampToValueAtTime(-24, now + t4);
        
        // Highs: Gradual cut
        player_highEQ.gain.setValueAtTime(0, now);
        player_highEQ.gain.linearRampToValueAtTime(-6, now + t2);
        player_highEQ.gain.linearRampToValueAtTime(-18, now + t4);
    }
    
    if (mixSettings.filterSweep) {
        // Low-pass filter sweep (the "underwater" exit effect)
        player_lpf.frequency.setValueAtTime(20000, now);
        player_lpf.frequency.setValueAtTime(20000, now + t2);
        player_lpf.frequency.exponentialRampToValueAtTime(600, now + t4);
    }
    
    // Master gain
    playerGain.gain.setValueAtTime(1, now);
    playerGain.gain.setValueAtTime(0.9, now + t2);
    playerGain.gain.exponentialRampToValueAtTime(0.01, now + t4);
    
    // === INCOMING TRACK EQ AUTOMATION ===
    
    if (mixSettings.eqCrossfade) {
        // Bring in with bass cut, DROP THE BASS at Phase 2
        cf_lowEQ.gain.setValueAtTime(-24, now);
        cf_lowEQ.gain.setValueAtTime(-24, now + t1);
        cf_lowEQ.gain.linearRampToValueAtTime(-3, now + t2);  // 🔊 BASS DROP!
        cf_lowEQ.gain.linearRampToValueAtTime(0, now + t3);
        
        // Mids: Bring in gradually
        cf_midEQ.gain.setValueAtTime(-6, now);
        cf_midEQ.gain.linearRampToValueAtTime(-2, now + t2);
        cf_midEQ.gain.linearRampToValueAtTime(0, now + t3);
        
        // Highs: Already there
        cf_highEQ.gain.setValueAtTime(0, now);
    }
    
    if (mixSettings.hpfSweep) {
        // High-pass sweep on incoming track (thin to full)
        cf_hpf.frequency.setValueAtTime(2000, now);  // Start thin
        cf_hpf.frequency.exponentialRampToValueAtTime(500, now + t1);
        cf_hpf.frequency.exponentialRampToValueAtTime(100, now + t2);
        cf_hpf.frequency.exponentialRampToValueAtTime(30, now + t3);  // Full bass
    }
    
    // Master gain: Smooth fade in
    crossfadeGain.gain.setValueAtTime(0.01, now);
    crossfadeGain.gain.exponentialRampToValueAtTime(0.5, now + t1);
    crossfadeGain.gain.linearRampToValueAtTime(0.85, now + t2);
    crossfadeGain.gain.linearRampToValueAtTime(1, now + t3);
    
    // Update UI
    autoMixBtn.classList.add('processing');
    autoMixBtn.textContent = 'MIX';
    
    // Add mixing-in indicator to incoming track in playlist
    if (playlistEl.children[nextIndex]) {
        playlistEl.children[nextIndex].classList.add('mixing-in');
    }
    
    // Complete transition
    setTimeout(() => {
        finishCrossfade(nextIndex);
    }, transitionDuration * 1000);
}

// Complete the DJ transition
function finishCrossfade(nextIndex) {
    console.log('[DJ MIX] ✅ Transition complete!');
    
    // Remove mixing-in indicator
    Array.from(playlistEl.children).forEach(li => li.classList.remove('mixing-in'));
    
    if (crossfadeAudio) {
        currentTrackIndex = nextIndex;
        
        const targetTime = crossfadeAudio.currentTime;
        const currentRate = crossfadeAudio.playbackRate;
        
        // Update UI immediately
        trackTitle.innerText = playlist[nextIndex].name;
        Array.from(playlistEl.children).forEach(li => li.classList.remove('playing'));
        if (playlistEl.children[nextIndex]) {
            playlistEl.children[nextIndex].classList.add('playing');
        }
        
        // Reset EQ to flat
        player_lowEQ.gain.cancelScheduledValues(audioCtx.currentTime);
        player_lowEQ.gain.value = 0;
        player_midEQ.gain.cancelScheduledValues(audioCtx.currentTime);
        player_midEQ.gain.value = 0;
        player_highEQ.gain.cancelScheduledValues(audioCtx.currentTime);
        player_highEQ.gain.value = 0;
        player_lpf.frequency.cancelScheduledValues(audioCtx.currentTime);
        player_lpf.frequency.value = 20000;
        
        // Keep main player silent initially
        playerGain.gain.cancelScheduledValues(audioCtx.currentTime);
        playerGain.gain.value = 0;
        
        // Pre-load main player with target track
        playerAudio.src = playlist[nextIndex].url;
        playerAudio.playbackRate = currentRate;
        
        // Wait for main player to be ready to play seamlessly
        const onCanPlay = () => {
            playerAudio.removeEventListener('canplaythrough', onCanPlay);
            
            // Sync to crossfade position (it's still playing)
            const syncTime = crossfadeAudio ? crossfadeAudio.currentTime : targetTime;
            playerAudio.currentTime = syncTime;
            
            // Start playing main player (still silent via playerGain)
            playerAudio.play().then(() => {
                const now = audioCtx.currentTime;
                const fadeTime = 0.15; // 150ms seamless crossfade
                
                // Fade IN main player
                playerGain.gain.setValueAtTime(0, now);
                playerGain.gain.linearRampToValueAtTime(1, now + fadeTime);
                
                // Fade OUT crossfade player simultaneously
                crossfadeGain.gain.cancelScheduledValues(now);
                crossfadeGain.gain.setValueAtTime(crossfadeGain.gain.value, now);
                crossfadeGain.gain.linearRampToValueAtTime(0, now + fadeTime);
                
                // Cleanup after seamless fade
                setTimeout(() => {
                    // Stop crossfade audio (the old incoming that's now handed off)
                    if (crossfadeAudio) {
                        crossfadeAudio.pause();
                        crossfadeAudio.src = '';
                        crossfadeAudio = null;
                    }
                    crossfadeSource = null;
                    
                    // Reset crossfade chain defaults
                    crossfadeGain.gain.value = 0;
                    cf_lowEQ.gain.value = -24;
                    cf_midEQ.gain.value = -6;
                    cf_hpf.frequency.value = 30;
                    
                    // Unlock state
                    isCrossfadeInProgress = false;
                    autoMixBtn.classList.remove('processing');
                    autoMixBtn.textContent = 'MIX';
                    
                    // Re-enable Slider & Play Button (Delayed until fully settled)
                    if (progressBar) { progressBar.style.pointerEvents = 'auto'; progressBar.style.opacity = '1'; }
                    if (playPauseBtn) { playPauseBtn.style.pointerEvents = 'auto'; playPauseBtn.style.opacity = '1'; }
                }, fadeTime * 1000 + 50);
            }).catch(e => {
                console.error("AutoMix Handoff Failed:", e);
                // Fallback: just keep crossfade audio playing
                playerGain.gain.value = 0;
                crossfadeGain.gain.value = 1;
                isCrossfadeInProgress = false;
                autoMixBtn.classList.remove('processing');
                autoMixBtn.textContent = 'MIX';
                
                // Re-enable Slider (Fallback)
                if (progressBar) {
                    progressBar.style.pointerEvents = 'auto';
                    progressBar.style.opacity = '1';
                }
                
                // Re-enable Slider (Fallback)
                if (progressBar) {
                    progressBar.style.pointerEvents = 'auto';
                    progressBar.style.opacity = '1';
                }
            });
        };
        
        playerAudio.addEventListener('canplaythrough', onCanPlay, { once: true });
        playerAudio.load();
        
        // Timeout fallback if canplaythrough doesn't fire
        setTimeout(() => {
            playerAudio.removeEventListener('canplaythrough', onCanPlay);
            // If still in progress, try direct approach
            if (isCrossfadeInProgress && crossfadeAudio) {
                console.log('[DJ MIX] Fallback handoff triggered');
                playerAudio.currentTime = crossfadeAudio.currentTime;
                playerAudio.play().catch(() => {});
                playerGain.gain.value = 1;
                crossfadeGain.gain.value = 0;
                if (crossfadeAudio) {
                    crossfadeAudio.pause();
                    crossfadeAudio.src = '';
                    crossfadeAudio = null;
                }
                isCrossfadeInProgress = false;
                autoMixBtn.classList.remove('processing');
            }
        }, 3000);
    } else {
        // Fallback if no crossfade audio (shouldn't happen in mix)
        isCrossfadeInProgress = false;
        autoMixBtn.classList.remove('processing');
        autoMixBtn.textContent = 'MIX';
        
        // Re-enable Slider & Play Button (Immediate Fail)
        if (progressBar) { progressBar.style.pointerEvents = 'auto'; progressBar.style.opacity = '1'; }
        if (playPauseBtn) { playPauseBtn.style.pointerEvents = 'auto'; playPauseBtn.style.opacity = '1'; }
    }
}
