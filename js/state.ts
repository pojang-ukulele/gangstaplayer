/**
 * Centralized Reactive State Manager for Gangsta Player Pro 3
 */

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
}

type Listener<T> = (value: T, state: AppStateData) => void;

class ReactiveStore implements AppStateData {
    // === STATE DATA ===
    isPlaying = false;
    currentTrackIndex = -1;
    playbackMode: PlaybackMode = 'continuous';
    loopMode: LoopMode = 'off';
    masterBPM = 0;
    playlist: Track[] = [];
    selectedIndices: number[] = [];
    isAutoMixEnabled = false;
    isCrossfadeInProgress = false;
    blendingIndex = -1;

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
     * Update state and trigger subscribers
     */
    update(patch: Partial<AppStateData>): void {
        const changedKeys: Array<keyof AppStateData> = [];
        
        for (const [key, value] of Object.entries(patch)) {
            const k = key as keyof AppStateData;
            
            // Check for equality (including shallow array check for playlist/selectedIndices)
            const isDifferent = Array.isArray(value) 
                ? JSON.stringify(this[k]) !== JSON.stringify(value)
                : this[k] !== value;

            if (isDifferent) {
                (this as any)[k] = value;
                changedKeys.push(k);
            }
        }

        if (changedKeys.length > 0) {
            // Notify specific listeners
            changedKeys.forEach(key => {
                const keyListeners = this.listeners.get(key);
                if (keyListeners) {
                    keyListeners.forEach(fn => fn((this as any)[key], this));
                }
            });

            // Notify global listeners
            this.globalListeners.forEach(fn => fn(this));
        }
    }
}

export const state = new ReactiveStore();
