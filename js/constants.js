// === CONSTANTS ===
export const KEYBOARD_MAP = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'];
export const MIDI_NOTE_TO_PAD = { 36: 0, 37: 1, 38: 2, 39: 3, 40: 4, 41: 5, 42: 6, 43: 7, 44: 8, 45: 9, 46: 10, 47: 11, 48: 12, 49: 13, 50: 14, 51: 15 };
export const BPM_DETECTION_THRESHOLD = 0.6;
export const BPM_MIN_STEP_SECONDS = 0.25;
export const DRAG_THRESHOLD_PX = 5;
export const DEFAULT_PAD_VOLUME = 0.75;
export const DEFAULT_TRACK_FADE_SECONDS = 10;
export const DEFAULT_BUTTON_FADE_SECONDS = 4;
export const VISUALIZER_FFT_SIZE = 256;
export const VISUALIZER_BARS = 16;
export const SLIDER_DEBOUNCE_MS = 16;

// === UTILITY FUNCTIONS ===
export function debounce(fn, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

export function throttle(fn, wait) {
    let lastTime = 0;
    return function(...args) {
        const now = Date.now();
        if (now - lastTime >= wait) {
            lastTime = now;
            fn.apply(this, args);
        }
    };
}
