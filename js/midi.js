// === MIDI SUPPORT ===
import { MIDI_NOTE_TO_PAD } from './constants.js';
import { audioCtx } from './audio.js';

let selectedMidiId = 'all';
let midiDeviceSelect = null;
let midiStatusEl = null;

let startPadFn = null;
let stopPadFn = null;
let activeVoicesRef = null;
let padVolumesRef = null;

export function initMIDI(deps) {
    startPadFn = deps.startPad;
    stopPadFn = deps.stopPad;
    activeVoicesRef = deps.activeVoices;
    padVolumesRef = deps.padVolumes;
    
    midiDeviceSelect = document.getElementById('midiDeviceSelect');
    midiStatusEl = document.getElementById('midiStatus');
    
    if (midiDeviceSelect) {
        midiDeviceSelect.addEventListener('change', (e) => selectedMidiId = e.target.value);
    }
}

export function enableMIDI() {
    if (!navigator.requestMIDIAccess) {
        console.error("WebMIDI not supported in this environment.");
        return;
    }
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
}

function onMIDISuccess(midiAccess) {
    updateMidiStatus(midiAccess);
    for (let input of midiAccess.inputs.values()) {
        input.onmidimessage = getMIDIMessage;
    }
    midiAccess.onstatechange = (e) => {
        updateMidiStatus(midiAccess);
        if (e.port.type === 'input' && e.port.state === 'connected') {
            e.port.onmidimessage = getMIDIMessage;
        }
    };
}

function updateMidiStatus(midiAccess) {
    if (!midiDeviceSelect || !midiStatusEl) return;
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
    if (deviceCount > 0) {
        midiStatusEl.innerText = `MIDI: ON (${deviceCount})`;
        midiStatusEl.style.color = "#39ff14";
    } else {
        midiStatusEl.innerText = "MIDI: OFF (No Device)";
        midiStatusEl.style.color = "#666";
    }
}

function onMIDIFailure() {
    if (midiStatusEl) {
        midiStatusEl.innerText = "MIDI: FAIL";
        midiStatusEl.style.color = "red";
    }
}

function getMIDIMessage(message) {
    if (selectedMidiId !== 'all' && message.target.id !== selectedMidiId) return;
    const [command, note, velocity] = message.data;
    const cmd = command >> 4;
    if (cmd === 8 || (cmd === 9 && velocity === 0)) {
        const pad = MIDI_NOTE_TO_PAD[note];
        if (pad !== undefined && stopPadFn) stopPadFn(pad);
    } else if (cmd === 9) {
        const pad = MIDI_NOTE_TO_PAD[note];
        if (pad !== undefined && startPadFn) {
            startPadFn(pad);
            if (activeVoicesRef && activeVoicesRef[pad] && activeVoicesRef[pad].gain) {
                const vol = (velocity / 127) * (padVolumesRef[pad] || 1);
                try { activeVoicesRef[pad].gain.gain.setValueAtTime(vol, audioCtx.currentTime); } catch (e) {}
            }
        }
    }
}
