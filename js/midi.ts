import { audioCtx, ensureAudio } from './audio';
import { state, AppStateData } from './state';
import { toast } from './toast';
import { logger } from './logger';
import { MIDI_LEARN_TIMEOUT_MS } from './constants';

const MIDI_MAPPINGS_STORAGE_KEY = 'ug_midi_mappings';

interface MidiDeps {
    startPad: (pad: number) => void;
    stopPad: (pad: number) => void;
    activeVoices: Record<number, { source: AudioBufferSourceNode; gain: GainNode } | null>;
    padVolumes: number[];
}

let selectedMidiId = 'all';
let selectedMidiName = '';
let midiDeviceSelect: HTMLSelectElement | null = null;
let midiStatusEl: HTMLElement | null = null;

let startPadFn: ((pad: number) => void) | null = null;
let stopPadFn: ((pad: number) => void) | null = null;
let activeVoicesRef: Record<number, any> | null = null;
let padVolumesRef: number[] | null = null;

// --- MIDI Mapping Persistence ---

function saveMidiMappings(): void {
    try {
        const data = {
            padMidiMap: state.padMidiMap,
            padKeyMap: state.padKeyMap,
            controlMidiMap: state.controlMidiMap,
        };
        localStorage.setItem(MIDI_MAPPINGS_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        logger.warn('[MIDI] Failed to persist mappings', e);
    }
}

function loadMidiMappings(): void {
    try {
        const saved = localStorage.getItem(MIDI_MAPPINGS_STORAGE_KEY);
        if (!saved) return;
        const data = JSON.parse(saved);
        const patch: Partial<AppStateData> = {};
        if (data.padMidiMap && typeof data.padMidiMap === 'object') {
            patch.padMidiMap = data.padMidiMap;
        }
        if (Array.isArray(data.padKeyMap) && data.padKeyMap.length === 16) {
            patch.padKeyMap = data.padKeyMap;
        }
        if (data.controlMidiMap && typeof data.controlMidiMap === 'object') {
            patch.controlMidiMap = data.controlMidiMap;
        }
        if (Object.keys(patch).length > 0) {
            state.update(patch);
            logger.info('[MIDI] Restored saved mappings');
        }
    } catch (e) {
        logger.warn('[MIDI] Failed to load saved mappings', e);
    }
}

// Auto-save whenever any mapping changes
let _mappingUnsubs: (() => void)[] | null = null;

function subscribeMappingAutoSave(): void {
    // Clean up previous subscriptions if any
    if (_mappingUnsubs) {
        _mappingUnsubs.forEach(fn => fn());
    }
    _mappingUnsubs = [
        state.subscribe('padMidiMap', saveMidiMappings),
        state.subscribe('padKeyMap', saveMidiMappings),
        state.subscribe('controlMidiMap', saveMidiMappings),
    ];
}

// ---

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
            selectedMidiName = target.options[target.selectedIndex]?.text || '';
        });
    }

    // Restore persisted mappings
    loadMidiMappings();
    // Auto-save on future changes
    subscribeMappingAutoSave();

    // Learn modes previously never timed out — a stray click stranded the
    // app capturing every incoming note/CC until a successful bind.
    let learnTimeout: ReturnType<typeof setTimeout> | null = null;
    state.subscribe('isLearningMidi', (learning) => {
        if (learnTimeout) {
            clearTimeout(learnTimeout);
            learnTimeout = null;
        }
        if (!learning) return;
        learnTimeout = setTimeout(() => {
            if (!state.isLearningMidi) return;
            state.update({ isLearningMidi: false, midiLearnTarget: null });
            toast.info("MIDI LEARN TIMED OUT");
            logger.info('[MIDI] Learn mode timed out');
        }, MIDI_LEARN_TIMEOUT_MS);
    });
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
    let foundSelected = false;
    for (const input of midiAccess.inputs.values()) {
        const option = document.createElement('option');
        option.value = input.id;
        option.text = input.name || `MIDI Device ${input.id}`;
        // Try matching by ID first, then by name (handles device re-pairing)
        if (input.id === selectedMidiId || (selectedMidiName && input.name === selectedMidiName)) {
            option.selected = true;
            foundSelected = true;
        }
        midiDeviceSelect.appendChild(option);
        deviceCount++;
    }
    if (foundSelected && selectedMidiId !== 'all') {
        // Update the stored ID in case it changed but name matched
        selectedMidiId = midiDeviceSelect.value;
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
    const el = document.getElementById(targetId) as HTMLInputElement;
    if (!el) return;
    // Respect the slider's own range (tempo 0.5-1.5 vs volume 0-1).
    // Previously every CC was written as 0-1, parking tempo at the bottom.
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '1');
    const scaled = min + (value / 127) * (max - min);
    el.value = scaled.toString();
    el.dispatchEvent(new Event('input'));
}

function getMIDIMessage(message: any): void {
    if (selectedMidiId !== 'all' && message.target.id !== selectedMidiId) return;
    const [status, data1, data2] = message.data;
    const cmd = status >> 4;

    // Handle Learn Mode (Note-On with velocity only — Note-Off/cmd-8 must
    // never become a binding or pads trigger on release and never on hit)
    if (state.isLearningMidi && state.midiLearnTarget) {
        if (cmd === 9 && data2 > 0) { // Note On
            handleMidiLearn(cmd, data1);
        } else if (cmd === 11) { // CC
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
                try {
                    ensureAudio();
                    if (!audioCtx) return;
                    activeVoicesRef[padIndex].gain.gain.cancelScheduledValues(audioCtx.currentTime);
                    activeVoicesRef[padIndex].gain.gain.setValueAtTime(vol, audioCtx.currentTime);
                } catch (e) {}
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
