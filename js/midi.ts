// === MIDI SUPPORT ===
import { MIDI_NOTE_TO_PAD } from './constants';
import { audioCtx } from './audio';

interface MidiDeps {
    startPad: (pad: number) => void;
    stopPad: (pad: number) => void;
    activeVoices: Record<number, any>;
    padVolumes: number[];
}

let selectedMidiId = 'all';
let midiDeviceSelect: HTMLSelectElement | null = null;
let midiStatusEl: HTMLElement | null = null;

let startPadFn: ((pad: number) => void) | null = null;
let stopPadFn: ((pad: number) => void) | null = null;
let activeVoicesRef: Record<number, any> | null = null;
let padVolumesRef: number[] | null = null;

export function initMIDI(deps: MidiDeps): void {
    startPadFn = deps.startPad;
    stopPadFn = deps.stopPad;
    activeVoicesRef = deps.activeVoices;
    padVolumesRef = deps.padVolumes;
    
    midiDeviceSelect = document.getElementById('midiDeviceSelect') as HTMLSelectElement;
    midiStatusEl = document.getElementById('midiStatus');
    
    if (midiDeviceSelect) {
        midiDeviceSelect.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            selectedMidiId = target.value;
        });
    }
}

export function enableMIDI(): void {
    if (!navigator.requestMIDIAccess) {
        console.error("WebMIDI not supported in this environment.");
        return;
    }
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
}

function onMIDISuccess(midiAccess: WebMidi.MIDIAccess): void {
    updateMidiStatus(midiAccess);
    for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = getMIDIMessage;
    }
    midiAccess.onstatechange = (e: any) => {
        updateMidiStatus(midiAccess);
        if (e.port.type === 'input' && e.port.state === 'connected') {
            const input = e.port as WebMidi.MIDIInput;
            input.onmidimessage = getMIDIMessage;
        }
    };
}

function updateMidiStatus(midiAccess: WebMidi.MIDIAccess): void {
    if (!midiDeviceSelect || !midiStatusEl) return;
    midiDeviceSelect.innerHTML = '<option value="all">ALL INPUTS (Default)</option>';
    let deviceCount = 0;
    for (const input of midiAccess.inputs.values()) {
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

function onMIDIFailure(): void {
    if (midiStatusEl) {
        midiStatusEl.innerText = "MIDI: FAIL";
        midiStatusEl.style.color = "red";
    }
}

function getMIDIMessage(message: any): void {
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
            if (activeVoicesRef && activeVoicesRef[pad] && activeVoicesRef[pad].gain && padVolumesRef) {
                const vol = (velocity / 127) * (padVolumesRef[pad] || 1);
                try { activeVoicesRef[pad].gain.gain.setValueAtTime(vol, audioCtx.currentTime); } catch (e) {}
            }
        }
    }
}
