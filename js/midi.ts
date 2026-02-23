import { audioCtx } from './audio';
import { state } from './state';
import { toast } from './toast';
import { logger } from './logger';

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
        state.update({ isMidiActive: true });
    } else {
        midiStatusEl.innerText = "MIDI: OFF (No Device)";
        midiStatusEl.style.color = "#666";
        state.update({ isMidiActive: false });
    }
}

function onMIDIFailure(): void {
    if (midiStatusEl) {
        midiStatusEl.innerText = "MIDI: FAIL";
        midiStatusEl.style.color = "red";
    }
}

function handleMidiLearn(cmd: number, data1: number) {
    if (!state.midiLearnTarget) return;

    const target = state.midiLearnTarget;
    logger.info(`[MIDI Learn] Learning ${target.type}:${target.id} from MIDI ${cmd === 9 ? 'Note' : 'CC'} ${data1}`);

    if (target.type === 'pad') {
        const newMap = { ...state.padMidiMap };
        // 1. Remove ANY existing mapping for this specific note (stealing)
        for (const [note, padIdx] of Object.entries(newMap)) {
            if (Number(note) === data1) delete newMap[Number(note)];
        }
        // 2. Remove the old note for THIS pad
        for (const note in newMap) {
            if (newMap[note] === target.id) delete newMap[note];
        }
        newMap[data1] = target.id as number;
        state.update({ padMidiMap: newMap });
        toast.success(`PAD ${Number(target.id) + 1} BOUND TO MIDI ${data1}`);
    } else if (target.type === 'control') {
        const newMap = { ...state.controlMidiMap };
        // 1. Unbind CC from others
        for (const [cc, ctrlId] of Object.entries(newMap)) {
            if (Number(cc) === data1) delete newMap[Number(cc)];
        }
        newMap[data1] = target.id as string;
        state.update({ controlMidiMap: newMap });
        toast.success(`${String(target.id).toUpperCase()} BOUND TO CC ${data1}`);
    }

    state.update({ isLearningMidi: false, midiLearnTarget: null });
}

function updateControlFromMidi(targetId: string, value: number) {
    const normalized = value / 127;
    const el = document.getElementById(targetId) as HTMLInputElement;
    if (el) {
        el.value = normalized.toString();
        el.dispatchEvent(new Event('input'));
    }
}

function getMIDIMessage(message: any): void {
    if (selectedMidiId !== 'all' && message.target.id !== selectedMidiId) return;
    const [status, data1, data2] = message.data;
    const cmd = status >> 4;

    // Handle Learn Mode
    if (state.isLearningMidi && state.midiLearnTarget) {
        if (cmd === 9 || cmd === 11) { // Note On or CC
            handleMidiLearn(cmd, data1);
        }
        return;
    }

    // Pad triggers (Note On/Off)
    if (cmd === 9 && data2 > 0) { // Note On
        const padIndex = state.padMidiMap[data1];
        if (padIndex !== undefined && startPadFn) {
            startPadFn(padIndex);
            if (activeVoicesRef && activeVoicesRef[padIndex] && activeVoicesRef[padIndex].gain && padVolumesRef) {
                const vol = (data2 / 127) * (padVolumesRef[padIndex] || 1);
                try { activeVoicesRef[padIndex].gain.gain.setValueAtTime(vol, audioCtx.currentTime); } catch (e) {}
            }
        }
    } else if (cmd === 8 || (cmd === 9 && data2 === 0)) { // Note Off
        const padIndex = state.padMidiMap[data1];
        if (padIndex !== undefined && stopPadFn) {
            stopPadFn(padIndex);
        }
    }

    // CC messages (Knobs/Sliders)
    if (cmd === 11) {
        const targetId = state.controlMidiMap[data1];
        if (targetId) {
            updateControlFromMidi(targetId, data2);
        }
    }
}
