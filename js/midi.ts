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

export function getSelectedMidiId(): string { return selectedMidiId; }
export function setSelectedMidiDevice(id: string, name = ''): void {
    selectedMidiId = typeof id === 'string' && id ? id.slice(0, 256) : 'all';
    if (name) selectedMidiName = name.slice(0, 256);
    try {
        if (midiDeviceSelect) midiDeviceSelect.value = selectedMidiId;
    } catch { /* select may not contain the id yet */ }
    try { persistMidiDevice(selectedMidiId, selectedMidiName); } catch { /* ignore */ }
}

function readPersistedMidiDevice(): string | null {
    try {
        const raw = localStorage.getItem('ug_settings');
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (s && typeof s.midiDevice === 'string' && s.midiDevice) return s.midiDevice.slice(0, 256);
    } catch { /* ignore */ }
    return null;
}

function persistMidiDevice(id: string, name = ''): void {
    try {
        const raw = localStorage.getItem('ug_settings');
        const s = raw ? JSON.parse(raw) : {};
        if (s && typeof s === 'object') {
            s.midiDevice = id.slice(0, 256);
            if (name) s.midiDeviceName = name.slice(0, 256);
            localStorage.setItem('ug_settings', JSON.stringify(s));
        }
    } catch { /* ignore */ }
    try {
        if (name) localStorage.setItem('ug_midi_name', name.slice(0, 256));
        else if (selectedMidiName) localStorage.setItem('ug_midi_name', selectedMidiName.slice(0, 256));
    } catch { /* ignore */ }
}

let startPadFn: ((pad: number) => void) | null = null;
let stopPadFn: ((pad: number) => void) | null = null;
let activeVoicesRef: Record<number, any> | null = null;
let padVolumesRef: number[] | null = null;
let _midiAccessRequested = false;

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
            const clean: Record<number, number> = {};
            for (const [k, v] of Object.entries(data.padMidiMap)) {
                const note = Number(k);
                const pad = Number(v);
                if (Number.isInteger(note) && note >= 0 && note <= 127 && Number.isInteger(pad) && pad >= 0 && pad <= 15) {
                    clean[note] = pad;
                }
            }
            patch.padMidiMap = clean;
        }
        if (Array.isArray(data.padKeyMap) && data.padKeyMap.length === 16) {
            const keys = data.padKeyMap.map((k: unknown) => typeof k === 'string' ? k.slice(0, 8).toLowerCase() : '');
            if (keys.every((k: string) => typeof k === 'string' && k.length > 0)) {
                patch.padKeyMap = keys;
            }
        }
        if (data.controlMidiMap && typeof data.controlMidiMap === 'object') {
            const cleanCtrl: Record<number, string> = {};
            for (const [k, v] of Object.entries(data.controlMidiMap)) {
                const cc = Number(k);
                if (!Number.isInteger(cc) || cc < 0 || cc > 127) continue;
                if (typeof v !== 'string' || !v) continue;
                const id = v.slice(0, 64);
                if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
                cleanCtrl[cc] = id;
            }
            patch.controlMidiMap = cleanCtrl;
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
let _learnUnsub: (() => void) | null = null;
let _midiInit = false;

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
    
    const persistedMidi = readPersistedMidiDevice();
    if (persistedMidi) selectedMidiId = persistedMidi;
    try {
        const nm = localStorage.getItem('ug_midi_name');
        if (nm && !selectedMidiName) selectedMidiName = nm.slice(0, 256);
        if (!nm) {
            const raw = localStorage.getItem('ug_settings');
            const s = raw ? JSON.parse(raw) : null;
            if (s && typeof s.midiDeviceName === 'string') selectedMidiName = s.midiDeviceName.slice(0, 256);
        }
    } catch { /* ignore */ }

    if (midiDeviceSelect) {
        midiDeviceSelect.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            selectedMidiId = target.value;
            selectedMidiName = target.options[target.selectedIndex]?.text || '';
            persistMidiDevice(selectedMidiId);
        });
    }

    // Restore persisted mappings
    loadMidiMappings();
    // Auto-save on future changes
    subscribeMappingAutoSave();

    // Learn modes previously never timed out — a stray click stranded the
    // app capturing every incoming note/CC until a successful bind.
    // Guard re-init: duplicate subscriptions stacked duplicate 10s timers.
    let learnTimeout: ReturnType<typeof setTimeout> | null = null;
    if (_learnUnsub) { try { _learnUnsub(); } catch { /* ignore */ } _learnUnsub = null; }
    _learnUnsub = state.subscribe('isLearningMidi', (learning) => {
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
    if (_midiAccessRequested) return;
    _midiAccessRequested = true;
    if (!navigator.requestMIDIAccess) {
        console.error("WebMIDI not supported in this environment.");
        return;
    }
    navigator.requestMIDIAccess().then(onMIDISuccess, (e) => {
        _midiAccessRequested = false;
        onMIDIFailure();
    });
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
    } else if (!foundSelected) {
        // Selected device disconnected — fall back to ALL instead of dropping
        // every message (previously a stale ID bricked all MIDI input).
        selectedMidiId = 'all';
        selectedMidiName = '';
        try { midiDeviceSelect.value = 'all'; } catch { /* ignore */ }
        try { persistMidiDevice('all', ''); } catch { /* ignore */ }
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
        // 2. Unbind the control's old CC so one control can't accumulate many.
        for (const cc of Object.keys(newMap)) {
            if (newMap[Number(cc)] === target.id) delete newMap[Number(cc)];
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
    // Throttle: a knob sweep fires hundreds of CCs/sec; each input+change
    // previously ran settings save + localStorage + IPC.
    const now = Date.now();
    const last = (updateControlFromMidi as any).__last?.[targetId] ?? 0;
    const isFinal = value === 0 || value === 127;
    if (!isFinal && now - last < 60) return;
    ((updateControlFromMidi as any).__last ??= {})[targetId] = now;
    // Respect the slider's own range (tempo 0.5-1.5 vs volume 0-1).
    // Previously every CC was written as 0-1, parking tempo at the bottom.
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '1');
    const scaled = min + (value / 127) * (max - min);
    el.value = scaled.toString();
    el.dispatchEvent(new Event('input'));
    // Settings autosave listens to 'change' — without this MIDI moves evaporate on reload.
    try { el.dispatchEvent(new Event('change')); } catch { /* ignore */ }
}

function getMIDIMessage(message: any): void {
    try {
    const targetId = message?.target?.id;
    if (selectedMidiId !== 'all' && targetId !== undefined && targetId !== selectedMidiId) return;
    const raw = message?.data;
    if (!raw || typeof raw.length !== 'number' || raw.length < 3) return;
    const status = Number(raw[0]);
    const data1 = Number(raw[1]);
    const data2 = Number(raw[2]);
    if (!Number.isFinite(status) || !Number.isFinite(data1) || !Number.isFinite(data2)) return;
    if (data1 < 0 || data1 > 127 || data2 < 0 || data2 > 127) return;
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
        if (Number.isInteger(padIndex) && padIndex >= 0 && padIndex <= 15 && startPadFn) {
            startPadFn(padIndex);
            if (activeVoicesRef && activeVoicesRef[padIndex] && activeVoicesRef[padIndex].gain && padVolumesRef) {
                const base = padVolumesRef[padIndex] ?? 1;
                const vol = (data2 / 127) * base;
                try {
                    ensureAudio();
                    if (!audioCtx) return;
                    const g = activeVoicesRef[padIndex].gain.gain;
                    const t = audioCtx.currentTime;
                    g.cancelScheduledValues(t);
                    try { g.setValueAtTime(Math.max(0.0001, g.value), t); } catch { /* ignore */ }
                    g.linearRampToValueAtTime(Math.max(0.0001, vol), t + 0.005);
                } catch (e) {}
            }
        }
    } else if (cmd === 8 || (cmd === 9 && data2 === 0)) { // Note Off
        const padIndex = state.padMidiMap[data1];
        if (Number.isInteger(padIndex) && padIndex >= 0 && padIndex <= 15 && stopPadFn) {
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
    } catch (e) {
        try { logger.warn('[MIDI] Dropped malformed message', e); } catch { /* ignore */ }
    }
}
