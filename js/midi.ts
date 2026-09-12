import { audioCtx, ensureAudio } from './audio';
import { state, AppStateData } from './state';
import { toast } from './toast';
import { logger } from './logger';
import { showConfirm } from './modals';
import { MIDI_LEARN_TIMEOUT_MS } from './constants';

const MIDI_MAPPINGS_STORAGE_KEY = 'ug_midi_mappings';

/**
 * Allowlisted MIDI-control targets: faders/knobs only. MIDI must never
 * drive buttons or save/action controls — a CC sweep writing .value into a
 * button was silent garbage, and into a save/action control is a hazard.
 * Regex shape validation is kept; the allowlist is enforced on top.
 */
const MIDI_CONTROL_ALLOWLIST: ReadonlySet<string> = new Set(['masterVol', 'tempoSlider']);
function isAllowedMidiControl(id: unknown): id is string {
    if (typeof id !== 'string' || !id) return false;
    if (!MIDI_CONTROL_ALLOWLIST.has(id)) return false;
    return /^[A-Za-z0-9_-]+$/.test(id);
}

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
// Live access handle for stale-device checks when no statechange fires
// (sleep/unplug without event). Null until onMIDISuccess.
let liveMidiAccess: WebMidi.MIDIAccess | null = null;
let staleFallbackNotifiedFor = '';

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
    // M26: single-writer merge. settings.ts owns ug_settings — keep the
    // in-memory copy in sync so its next save does not last-wins clobber
    // this route, and merge (never blind-write) for the direct fallback.
    try {
        void import('./settings').then((m) => {
            try {
                const s = (m as unknown as { settings?: { midiDevice?: string } }).settings;
                if (s && s.midiDevice !== id) {
                    (m as unknown as { updateSettings?: (p: unknown) => void }).updateSettings?.({ midiDevice: id });
                }
            } catch { /* sync best-effort */ }
        }).catch(() => undefined);
    } catch { /* ignore */ }
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
                // Persisted bindings from older builds may target buttons or
                // removed controls — drop anything outside the allowlist.
                if (!MIDI_CONTROL_ALLOWLIST.has(id)) continue;
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
            // Persist the name too — re-pairing after unplug/replug matches
            // by name when the id changes. Id-only persist broke re-pairing.
            selectedMidiName = target.options[target.selectedIndex]?.text || '';
            persistMidiDevice(selectedMidiId, selectedMidiName);
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
        // Learn ended externally (Esc path, timeout, newer learn): retire
        // any pending steal-confirm token with it.
        if (!learning) { _learnGen++; return; }
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
    // Hung permission prompts previously left MIDI OFF silently forever with
    // no retry possible. Bound the wait; on timeout release the latch so a
    // later user gesture can retry.
    const midiReq = navigator.requestMIDIAccess();
    const midiTimeout = setTimeout(() => {
        if (!liveMidiAccess) {
            _midiAccessRequested = false;
            logger.warn('[MIDI] Access request timed out — retry on next user gesture');
            try { toast.info('MIDI PERMISSION TIMED OUT — CLICK AGAIN TO RETRY'); } catch { /* ignore */ }
        }
    }, 30000);
    try { (midiTimeout as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    midiReq.then(
        (access) => { try { clearTimeout(midiTimeout); } catch { /* ignore */ } onMIDISuccess(access); },
        (e) => {
            try { clearTimeout(midiTimeout); } catch { /* ignore */ }
            _midiAccessRequested = false;
            onMIDIFailure();
        }
    );
}

function onMIDISuccess(midiAccess: WebMidi.MIDIAccess): void {
    liveMidiAccess = midiAccess;
    updateMidiStatus(midiAccess);
    for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = getMIDIMessage;
    }
    midiAccess.onstatechange = (e: any) => {
        updateMidiStatus(midiAccess);
        if (e.port.type !== 'input') return;
        if (e.port.state === 'connected') {
            const input = e.port as WebMidi.MIDIInput;
            input.onmidimessage = getMIDIMessage;
        } else {
            // Detach disconnected ports — a zombie handler on a removed
            // device previously kept firing with a stale id.
            try { (e.port as WebMidi.MIDIInput).onmidimessage = null; } catch { /* ignore */ }
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
    } else if (!foundSelected && selectedMidiId !== 'all') {
        // Selected device disconnected — fall back to ALL instead of dropping
        // every message (previously a stale ID bricked all MIDI input).
        const missing = selectedMidiName || selectedMidiId;
        selectedMidiId = 'all';
        selectedMidiName = '';
        try { midiDeviceSelect.value = 'all'; } catch { /* ignore */ }
        try { persistMidiDevice('all', ''); } catch { /* ignore */ }
        try { toast.info(`MIDI DEVICE MISSING (${missing}) — USING ALL INPUTS`); } catch { /* ignore */ }
        logger.warn(`[MIDI] Selected device missing (${missing}) — fell back to ALL INPUTS`);
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
    // A denial after a prior success previously left isMidiActive stuck true.
    try { state.update({ isMidiActive: false }); } catch { /* ignore */ }
}

// H28: undo snapshot for stolen bindings — a learn that steals another
// pad/control's note/CC can be reverted instead of autosaving silently.
let _midiUndoBackup: { padMidiMap: Record<number, number>; controlMidiMap: Record<number, string> } | null = null;

export function undoMidiLearn(): boolean {
    if (!_midiUndoBackup) return false;
    const backup = _midiUndoBackup;
    _midiUndoBackup = null;
    state.update({ padMidiMap: { ...backup.padMidiMap }, controlMidiMap: { ...backup.controlMidiMap } });
    try { toast.info('MIDI BINDING RESTORED'); } catch { /* ignore */ }
    logger.info('[MIDI Learn] Binding steal undone');
    return true;
}

function stashMidiUndo(): void {
    _midiUndoBackup = {
        padMidiMap: { ...state.padMidiMap },
        controlMidiMap: { ...state.controlMidiMap },
    };
}

/**
 * Steal-confirm generation: showConfirm is queued/async, so a steal prompt
 * can outlive its learn session (Esc cancel, 10s timeout, newer learn). The
 * captured token is checked in onYes — a stale confirm becomes a no-op
 * instead of applying a binding the user already cancelled.
 */
let _learnGen = 0;

function cancelMidiLearn(): void {
    _learnGen++;
    state.update({ isLearningMidi: false, midiLearnTarget: null });
}

function applyPadBind(data1: number, padId: number): void {
    stashMidiUndo();
    const newMap = { ...state.padMidiMap };
    // 1. Remove ANY existing mapping for this specific note (stealing)
    for (const [note, padIdx] of Object.entries(newMap)) {
        if (Number(note) === data1) delete newMap[Number(note)];
    }
    // 2. Remove the old note for THIS pad
    for (const note in newMap) {
        if (newMap[note] === padId) delete newMap[note];
    }
    newMap[data1] = padId;
    state.update({ padMidiMap: newMap });
    toast.success(`PAD ${padId + 1} BOUND TO MIDI ${data1}`);
    cancelMidiLearn();
}

function applyControlBind(data1: number, ctrlId: string): void {
    if (!isAllowedMidiControl(ctrlId)) {
        logger.warn(`[MIDI Learn] Rejected non-allowlisted control '${String(ctrlId).slice(0, 64)}'`);
        try { toast.error('CONTROL CANNOT BE MIDI-MAPPED'); } catch { /* ignore */ }
        cancelMidiLearn();
        return;
    }
    stashMidiUndo();
    const newMap = { ...state.controlMidiMap };
    // 1. Unbind CC from others
    for (const [cc, ctrlId_] of Object.entries(newMap)) {
        if (Number(cc) === data1) delete newMap[Number(cc)];
    }
    // 2. Unbind the control's old CC so one control can't accumulate many.
    for (const cc of Object.keys(newMap)) {
        if (newMap[Number(cc)] === ctrlId) delete newMap[Number(cc)];
    }
    newMap[data1] = ctrlId;
    state.update({ controlMidiMap: newMap });
    toast.success(`${ctrlId.toUpperCase()} BOUND TO CC ${data1}`);
    cancelMidiLearn();
}

function handleMidiLearn(cmd: number, data1: number) {
    if (!state.midiLearnTarget) return;

    const target = state.midiLearnTarget;
    // OOB/stale learn targets (e.g. pad 99 from a dead menu) previously wrote
    // inert map entries, wasting the note/CC slot with no feedback.
    if (target.type === 'pad') {
        const padId = target.id as number;
        if (!Number.isInteger(padId) || padId < 0 || padId > 15) {
            logger.warn(`[MIDI Learn] Rejected invalid pad target ${String(target.id)}`);
            try { toast.error('INVALID MIDI LEARN TARGET'); } catch { /* ignore */ }
            cancelMidiLearn();
            return;
        }
    } else if (target.type === 'control') {
        const ctrlId = target.id as string;
        if (typeof ctrlId !== 'string' || !ctrlId || ctrlId.length > 256) {
            logger.warn('[MIDI Learn] Rejected invalid control target');
            try { toast.error('INVALID MIDI LEARN TARGET'); } catch { /* ignore */ }
            cancelMidiLearn();
            return;
        }
        if (!isAllowedMidiControl(ctrlId)) {
            logger.warn(`[MIDI Learn] Rejected non-allowlisted control '${String(ctrlId).slice(0, 64)}'`);
            try { toast.error('CONTROL CANNOT BE MIDI-MAPPED'); } catch { /* ignore */ }
            cancelMidiLearn();
            return;
        }
    } else {
        cancelMidiLearn();
        return;
    }
    logger.info(`[MIDI Learn] Learning ${target.type}:${target.id} from MIDI ${cmd === 9 ? 'Note' : 'CC'} ${data1}`);
    // NOTE (channel collision): bindings are channel-agnostic — note/CC
    // number only. The same note on another channel/device collides into the
    // same slot by design (single-slot maps); the steal confirm below is the
    // backstop and is kept for every collision.
    const learnToken = _learnGen;
    const ifFresh = (fn: () => void): (() => void) => () => {
        if (learnToken !== _learnGen) {
            logger.info('[MIDI Learn] Stale steal-confirm dropped (learn cancelled)');
            return;
        }
        fn();
    };

    if (target.type === 'pad') {
        const padId = target.id as number;
        const victim = state.padMidiMap[data1];
        // H28: stealing another pad's note must not autosave silently —
        // require explicit confirm and keep an undo snapshot.
        if (Number.isInteger(victim) && victim !== padId) {
            const victimPad = victim as number;
            try {
                showConfirm(
                    'STEAL MIDI BINDING?',
                    `Note ${data1} currently triggers PAD ${victimPad + 1}. Move it to PAD ${padId + 1}?`,
                    ifFresh(() => applyPadBind(data1, padId)),
                    () => cancelMidiLearn()
                );
            } catch {
                cancelMidiLearn();
            }
            return;
        }
        applyPadBind(data1, padId);
    } else if (target.type === 'control') {
        const ctrlId = target.id as string;
        const victim = state.controlMidiMap[data1];
        if (typeof victim === 'string' && victim !== ctrlId) {
            try {
                showConfirm(
                    'STEAL MIDI BINDING?',
                    `CC ${data1} currently controls ${victim.toUpperCase()}. Move it to ${ctrlId.toUpperCase()}?`,
                    ifFresh(() => applyControlBind(data1, ctrlId)),
                    () => cancelMidiLearn()
                );
            } catch {
                cancelMidiLearn();
            }
            return;
        }
        applyControlBind(data1, ctrlId);
    }
}

const _ccChangeTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function updateControlFromMidi(targetId: string, value: number) {
    // Allowlist first: faders/knobs only, never buttons/save actions.
    // (Shape regex is re-checked inside isAllowedMidiControl.)
    if (!isAllowedMidiControl(targetId)) {
        logger.warn(`[MIDI] CC ${value} ignored for non-mappable control '${String(targetId).slice(0, 64)}'`);
        return;
    }
    const el = document.getElementById(targetId) as HTMLInputElement;
    if (!el) return;
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.type || '').toLowerCase();
    // Bubbling events: delegated/document-level listeners (settings autosave)
    // previously missed the non-bubbling input/change from MIDI moves.
    const fire = (name: string): void => {
        try { el.dispatchEvent(new Event(name, { bubbles: true })); } catch { /* ignore */ }
    };
    // Checkboxes have no numeric value — a CC sweep previously wrote
    // toFixed(3) into .value (invisible, meaningless). Drive checked instead.
    if (type === 'checkbox') {
        const on = value >= 64;
        if ((el as HTMLInputElement).checked !== on) {
            (el as HTMLInputElement).checked = on;
            fire('input');
            fire('change');
        }
        return;
    }
    // Buttons and other non-value elements can't show a CC position —
    // writing .value into them was silent garbage. Skip loudly.
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
        logger.warn(`[MIDI] CC ${value} ignored for non-value control '${targetId}'`);
        return;
    }
    // Throttle: a knob sweep fires hundreds of CCs/sec; each input+change
    // previously ran settings save + localStorage + IPC.
    const now = Date.now();
    const last = (updateControlFromMidi as any).__last?.[targetId] ?? 0;
    const isFinal = value === 0 || value === 127;
    if (!isFinal && now - last < 30) return;
    ((updateControlFromMidi as any).__last ??= {})[targetId] = now;
    // Respect the slider's own range (tempo 0.5-1.5 vs volume 0-1).
    // Previously every CC was written as 0-1, parking tempo at the bottom.
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '1');
    const scaled = min + (value / 127) * (max - min);
    // Finer steps: keep sub-step precision (tempo CC steps are ~0.008, finer
    // than the 0.01 slider step) instead of coarse 2-decimal rounding.
    el.value = Number.isFinite(scaled) ? scaled.toFixed(3) : el.value;
    fire('input');
    // Batch the save: 'change' drives settings autosave (localStorage + IPC),
    // so coalesce it per control instead of firing on every CC tick. Final
    // positions (0/127) save immediately so a released knob never loses state.
    const prev = _ccChangeTimers[targetId];
    if (prev) clearTimeout(prev);
    if (isFinal) {
        delete _ccChangeTimers[targetId];
        // Settings autosave listens to 'change' — without this MIDI moves evaporate on reload.
        fire('change');
    } else {
        _ccChangeTimers[targetId] = setTimeout(() => {
            delete _ccChangeTimers[targetId];
            fire('change');
        }, 300);
    }
}

function getMIDIMessage(message: any): void {
    try {
    // Device filter: some browsers/bridges deliver messages without
    // message.target (undefined id). Fall back to accepting those — dropping
    // them would brick MIDI on those platforms. Genuine mismatches (a
    // different device id) are still filtered.
    const targetId = message?.target?.id;
    if (selectedMidiId !== 'all' && targetId !== undefined && targetId !== selectedMidiId) {
        // Stale-ID brick without statechange (sleep/unplug): if the selected
        // device is gone from live inputs, fall back to ALL once instead of
        // dropping every message forever.
        try {
            const stillThere = liveMidiAccess ? Array.from(liveMidiAccess.inputs.values()).some(i => i.id === selectedMidiId) : true;
            if (!stillThere) {
                const missing = selectedMidiName || selectedMidiId;
                selectedMidiId = 'all';
                selectedMidiName = '';
                try { if (midiDeviceSelect) midiDeviceSelect.value = 'all'; } catch { /* ignore */ }
                try { persistMidiDevice('all', ''); } catch { /* ignore */ }
                if (staleFallbackNotifiedFor !== missing) {
                    staleFallbackNotifiedFor = missing;
                    try { toast.info(`MIDI DEVICE MISSING (${String(missing).slice(0, 64)}) — USING ALL INPUTS`); } catch { /* ignore */ }
                    logger.warn(`[MIDI] Stale device ${missing} gone without statechange — fell back to ALL INPUTS`);
                }
            } else {
                return;
            }
        } catch { return; }
    }
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
                    // setTargetAtTime smoothing: exponential approach, no
                    // zipper steps on velocity jumps and no ramp pile-up when
                    // notes repeat faster than the 5ms linear ramp.
                    g.cancelScheduledValues(t);
                    try { g.setValueAtTime(Math.max(0.0001, g.value), t); } catch { /* ignore */ }
                    g.setTargetAtTime(Math.max(0.0001, vol), t, 0.008);
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
