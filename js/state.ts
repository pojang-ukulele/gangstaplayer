/**
 * Centralized State Manager for Gangsta Player Pro 3
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

export interface AppState {
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
    listeners: Array<(state: AppState) => void>;
    subscribe: (fn: (state: AppState) => void) => () => void;
    notify: () => void;
    update: (patch: Partial<Omit<AppState, 'subscribe' | 'notify' | 'update' | 'listeners'>>) => void;
}

export const state: AppState = {
    // Playback State
    isPlaying: false,
    currentTrackIndex: -1,
    playbackMode: 'continuous',
    loopMode: 'off',
    
    // Audio Context State
    masterBPM: 0,
    
    // Playlist State
    playlist: [],
    selectedIndices: [],
    
    // UI State
    isAutoMixEnabled: false,
    isCrossfadeInProgress: false,
    blendingIndex: -1,

    // Listeners for state changes
    listeners: [],
    
    subscribe(fn) {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter(l => l !== fn);
        };
    },
    
    notify() {
        this.listeners.forEach(fn => fn(this));
    },

    update(patch) {
        Object.assign(this, patch);
        this.notify();
    }
};
