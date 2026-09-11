/**
 * Centralized Reactive State Manager for Gangsta Player Pro 3
 */

/**
 * Shallow equality check for arrays and objects.
 * Returns true if both values have the same contents by === comparison.
 */
export function shallowEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const isArrayA = Array.isArray(a);
    const isArrayB = Array.isArray(b);
    if (isArrayA !== isArrayB) return false;
    if (isArrayA && isArrayB) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (a[key] !== b[key]) return false;
    }
    return true;
}

export interface Track {
    id: string;
    name: string;
    path: string;
    duration: number;
    bpm?: number;
}

export type PlaybackMode = 'continuous' | 'single';
export type LoopMode = 'off' | 'one' | 'all';

export interface AppStateData {
    isPlaying: boolean;
    currentTrackIndex: number;
    playbackMode: PlaybackMode;
    loopMode: LoopMode;
    masterBPM: number;
    playlist: Track[];
    selectedIndices: number[];
    isAutoMixEnabled: boolean;
    isCrossfadeInProgress: boolean;
    blendingIndex: number;
    isMidiActive: boolean;
    // MIDI & Key Mapping
    padMidiMap: Record<number, number>; 
    padKeyMap: string[]; 
    controlMidiMap: Record<number, string>; 
    isLearningMidi: boolean;
    midiLearnTarget: { type: 'pad' | 'control', id: number | string } | null;
    isLearningKey: boolean;
    keyLearnTargetPad: number | null;
}

type Listener<T> = (value: T, state: AppStateData) => void;

class ReactiveStore implements AppStateData {
    // === PRIVATE BACKING STORE (mutation only via update()) ===
    private _data: AppStateData = {
        isPlaying: false,
        currentTrackIndex: -1,
        playbackMode: 'continuous',
        loopMode: 'off',
        masterBPM: 0,
        playlist: [],
        selectedIndices: [],
        isAutoMixEnabled: false,
        isCrossfadeInProgress: false,
        blendingIndex: -1,
        isMidiActive: false,
        padMidiMap: { 36: 0, 37: 1, 38: 2, 39: 3, 40: 4, 41: 5, 42: 6, 43: 7, 44: 8, 45: 9, 46: 10, 47: 11, 48: 12, 49: 13, 50: 14, 51: 15 },
        padKeyMap: ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'],
        controlMidiMap: { 7: 'masterVol' },
        isLearningMidi: false,
        midiLearnTarget: null,
        isLearningKey: false,
        keyLearnTargetPad: null
    };

    // === READ-ONLY GETTERS (implement AppStateData interface) ===
    // Collection getters return copies — callers previously mutated the live
    // arrays/maps without update(), corrupting state with no notification.
    get isPlaying(): boolean { return this._data.isPlaying; }
    get currentTrackIndex(): number { return this._data.currentTrackIndex; }
    get playbackMode(): PlaybackMode { return this._data.playbackMode; }
    get loopMode(): LoopMode { return this._data.loopMode; }
    get masterBPM(): number { return this._data.masterBPM; }
    get playlist(): Track[] { return [...this._data.playlist]; }
    get selectedIndices(): number[] { return [...this._data.selectedIndices]; }
    get isAutoMixEnabled(): boolean { return this._data.isAutoMixEnabled; }
    get isCrossfadeInProgress(): boolean { return this._data.isCrossfadeInProgress; }
    get blendingIndex(): number { return this._data.blendingIndex; }
    get isMidiActive(): boolean { return this._data.isMidiActive; }
    get padMidiMap(): Record<number, number> { return { ...this._data.padMidiMap }; }
    get padKeyMap(): string[] { return [...this._data.padKeyMap]; }
    get controlMidiMap(): Record<number, string> { return { ...this._data.controlMidiMap }; }
    get isLearningMidi(): boolean { return this._data.isLearningMidi; }
    get midiLearnTarget(): { type: 'pad' | 'control', id: number | string } | null {
        const t = this._data.midiLearnTarget;
        return t ? { ...t } : null;
    }
    get isLearningKey(): boolean { return this._data.isLearningKey; }
    get keyLearnTargetPad(): number | null { return this._data.keyLearnTargetPad; }

    // === PUB/SUB INTERNALS ===
    private listeners: Map<keyof AppStateData, Set<Listener<any>>> = new Map();
    private globalListeners: Set<(state: AppStateData) => void> = new Set();

    /**
     * Subscribe to a specific state property change.
     * Unknown keys warn loudly instead of creating dead entries that never
     * fire (a typo'd key previously subscribed into the void silently).
     */
    subscribe<K extends keyof AppStateData>(key: K, fn: Listener<AppStateData[K]>): () => void {
        if (typeof key !== 'string' || !(key in this._data)) {
            console.warn(`[State] subscribe to unknown key`, key);
            return () => undefined;
        }
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key)!.add(fn);
        return () => this.listeners.get(key)!.delete(fn);
    }

    /**
     * Subscribe to any state change
     */
    subscribeAll(fn: (state: AppStateData) => void): () => void {
        this.globalListeners.add(fn);
        return () => this.globalListeners.delete(fn);
    }

    /**
     * Update state and trigger subscribers — ONLY way to mutate state.
     * NOTE: playlist Track objects must be treated as immutable. Mutating
     * `track.bpm` in place then calling `update({playlist:[...playlist]})`
     * is INVISIBLE here (same element refs => shallowEqual true => no notify).
     * Always replace the element with a new object (see replaceTrackInPlaylist).
     */
    update(patch: Partial<AppStateData>): boolean {
        const changedKeys: Array<keyof AppStateData> = [];
        let rejected = false;

        for (const [key, value] of Object.entries(patch)) {
            const k = key as keyof AppStateData;

            // Runtime validation for enums/numbers — invalid writes previously
            // flowed straight into player logic. Reject loudly (return false)
            // so callers know the patch was not (fully) applied.
            if (k === 'loopMode' && value !== 'off' && value !== 'one' && value !== 'all') { console.warn(`[State] rejected invalid loopMode`, value); rejected = true; continue; }
            if (k === 'playbackMode' && value !== 'continuous' && value !== 'single') { console.warn(`[State] rejected invalid playbackMode`, value); rejected = true; continue; }
            if (k === 'currentTrackIndex' && (typeof value !== 'number' || !Number.isInteger(value as number))) { console.warn(`[State] rejected invalid currentTrackIndex`, value); rejected = true; continue; }
            if ((k === 'masterBPM' || k === 'blendingIndex') && (typeof value !== 'number' || !Number.isFinite(value as number))) { console.warn(`[State] rejected invalid ${String(k)}`, value); rejected = true; continue; }
            // Collections must stay arrays — update({playlist:"junk"}) previously
            // flowed into .map/.length and crashed player/playlist render.
            if ((k === 'playlist' || k === 'selectedIndices' || k === 'padKeyMap') && !Array.isArray(value)) { console.warn(`[State] rejected invalid ${String(k)}`, value); rejected = true; continue; }
            if (k === 'playlist' && (value as unknown[]).length > 10000) { console.warn(`[State] rejected oversized playlist`, (value as unknown[]).length); rejected = true; continue; }
            // Flags must stay booleans — truthy-string drift broke strict checks.
            if ((k === 'isPlaying' || k === 'isAutoMixEnabled' || k === 'isCrossfadeInProgress' || k === 'isMidiActive' || k === 'isLearningMidi' || k === 'isLearningKey') && typeof value !== 'boolean') { console.warn(`[State] rejected invalid ${String(k)}`, value); rejected = true; continue; }
            // Maps must stay plain objects — null/array broke MIDI lookups.
            if ((k === 'padMidiMap' || k === 'controlMidiMap') && (value === null || typeof value !== 'object' || Array.isArray(value))) { console.warn(`[State] rejected invalid ${String(k)}`, value); rejected = true; continue; }
            if (k === 'midiLearnTarget' && value !== null) {
                const t = value as { type?: unknown; id?: unknown };
                if (typeof t !== 'object' || (t.type !== 'pad' && t.type !== 'control')) { console.warn(`[State] rejected invalid midiLearnTarget`, value); rejected = true; continue; }
                if (t.type === 'pad' && (!Number.isInteger(t.id as number) || (t.id as number) < 0 || (t.id as number) > 15)) { console.warn(`[State] rejected invalid midiLearnTarget`, value); rejected = true; continue; }
                if (t.type === 'control' && (typeof t.id !== 'string' || !(t.id as string) || (t.id as string).length > 256)) { console.warn(`[State] rejected invalid midiLearnTarget`, value); rejected = true; continue; }
            }
            if (k === 'keyLearnTargetPad' && value !== null && (!Number.isInteger(value as number) || (value as number) < 0 || (value as number) > 15)) { console.warn(`[State] rejected invalid keyLearnTargetPad`, value); rejected = true; continue; }

            // Shallow comparison for arrays AND plain objects (pad maps, learn
            // targets) — previously identical-content objects spuriously notified.
            const cur = (this._data as any)[k];
            const isDifferent = (Array.isArray(value) || (value !== null && typeof value === 'object'))
                ? !shallowEqual(cur, value)
                : cur !== value;

            if (isDifferent) {
                // Clone on store: callers must not retain a live ref into
                // _data via update({playlist:myArr}); myArr.push() would
                // otherwise mutate live state with zero notify.
                const stored = Array.isArray(value)
                    ? [...(value as unknown[])]
                    : (value !== null && typeof value === 'object' ? { ...(value as object) } : value);
                (this._data as any)[k] = stored;
                changedKeys.push(k);
            }
        }

        if (changedKeys.length > 0) {
            // Notify specific listeners — one throwing subscriber must not kill the rest.
            changedKeys.forEach(key => {
                const keyListeners = this.listeners.get(key);
                if (keyListeners) {
                    keyListeners.forEach(fn => {
                        try { fn((this._data as any)[key], this.getSnapshot()); }
                        catch (e) { console.error(`[State] listener for ${String(key)} threw`, e); }
                    });
                }
            });

            // Notify global listeners
            this.globalListeners.forEach(fn => {
                try { fn(this.getSnapshot()); } catch (e) { console.error('[State] global listener threw', e); }
            });
        }

        return !rejected;
    }

    /** Plain cloneable snapshot (no Maps/Sets/functions) for IPC/crash reports. */
    getSnapshot(): AppStateData {
        return {
            ...this._data,
            playlist: this._data.playlist.map(t => ({ ...t })),
            selectedIndices: [...this._data.selectedIndices],
            padMidiMap: { ...this._data.padMidiMap },
            padKeyMap: [...this._data.padKeyMap],
            controlMidiMap: { ...this._data.controlMidiMap },
            midiLearnTarget: this._data.midiLearnTarget ? { ...this._data.midiLearnTarget } : null,
        };
    }

    /** Immutable element replace — in-place track.bpm mutation is invisible to update(). */
    replaceTrack(id: string, patch: Partial<Track>): boolean {
        const idx = this._data.playlist.findIndex(t => t.id === id);
        if (idx < 0) return false;
        const next = [...this._data.playlist];
        next[idx] = { ...next[idx], ...patch };
        this.update({ playlist: next } as Partial<AppStateData>);
        return true;
    }
}

export const state = new ReactiveStore();
