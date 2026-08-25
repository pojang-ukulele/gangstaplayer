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
    get isPlaying(): boolean { return this._data.isPlaying; }
    get currentTrackIndex(): number { return this._data.currentTrackIndex; }
    get playbackMode(): PlaybackMode { return this._data.playbackMode; }
    get loopMode(): LoopMode { return this._data.loopMode; }
    get masterBPM(): number { return this._data.masterBPM; }
    get playlist(): Track[] { return this._data.playlist; }
    get selectedIndices(): number[] { return this._data.selectedIndices; }
    get isAutoMixEnabled(): boolean { return this._data.isAutoMixEnabled; }
    get isCrossfadeInProgress(): boolean { return this._data.isCrossfadeInProgress; }
    get blendingIndex(): number { return this._data.blendingIndex; }
    get isMidiActive(): boolean { return this._data.isMidiActive; }
    get padMidiMap(): Record<number, number> { return this._data.padMidiMap; }
    get padKeyMap(): string[] { return this._data.padKeyMap; }
    get controlMidiMap(): Record<number, string> { return this._data.controlMidiMap; }
    get isLearningMidi(): boolean { return this._data.isLearningMidi; }
    get midiLearnTarget(): { type: 'pad' | 'control', id: number | string } | null { return this._data.midiLearnTarget; }
    get isLearningKey(): boolean { return this._data.isLearningKey; }
    get keyLearnTargetPad(): number | null { return this._data.keyLearnTargetPad; }

    // === PUB/SUB INTERNALS ===
    private listeners: Map<keyof AppStateData, Set<Listener<any>>> = new Map();
    private globalListeners: Set<(state: AppStateData) => void> = new Set();

    /**
     * Subscribe to a specific state property change
     */
    subscribe<K extends keyof AppStateData>(key: K, fn: Listener<AppStateData[K]>): () => void {
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
     * Update state and trigger subscribers — ONLY way to mutate state
     */
    update(patch: Partial<AppStateData>): void {
        const changedKeys: Array<keyof AppStateData> = [];
        
        for (const [key, value] of Object.entries(patch)) {
            const k = key as keyof AppStateData;
            
            // Reference equality check with shallow comparison for arrays
            const isDifferent = Array.isArray(value)
                ? !shallowEqual((this._data as any)[k], value)
                : (this._data as any)[k] !== value;

            if (isDifferent) {
                (this._data as any)[k] = value;
                changedKeys.push(k);
            }
        }

        if (changedKeys.length > 0) {
            // Notify specific listeners
            changedKeys.forEach(key => {
                const keyListeners = this.listeners.get(key);
                if (keyListeners) {
                    keyListeners.forEach(fn => fn((this._data as any)[key], this));
                }
            });

            // Notify global listeners
            this.globalListeners.forEach(fn => fn(this));
        }
    }
}

export const state = new ReactiveStore();
