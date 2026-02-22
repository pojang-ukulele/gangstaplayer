/**
 * Centralized State Manager for Gangsta Player Pro 3
 */

export const state = {
    // Playback State
    isPlaying: false,
    currentTrackIndex: -1,
    playbackMode: 'continuous', // 'continuous' | 'single'
    loopMode: 'off',           // 'off' | 'one' | 'all'
    
    // Audio Context State
    masterBPM: 0,
    
    // Playlist State
    playlist: [],
    selectedIndices: [],
    
    // UI State
    isAutoMixEnabled: false,
    isCrossfadeInProgress: false,
    blendingIndex: -1,

    // Listeners for state changes (simple reactivity)
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
