// === CONSTANTS ===
export const DEFAULT_PAD_VOLUME = 0.75;
export const VISUALIZER_FFT_SIZE = 256;
export const VISUALIZER_BARS = 16;

// === BPM Detection ===
/** Amplitude threshold for peak detection 0.0–1.0 */
export const BPM_DETECTION_THRESHOLD = 0.1;
/** Minimum seconds between peaks to prevent double-counting */
export const BPM_MIN_STEP_SECONDS = 0.3;

// === Audio ===
export const DEFAULT_MASTER_VOLUME = 0.75;
export const DEFAULT_TEMPO = 1.0;
export const STARTUP_SOUND_VOLUME = 0.6;
export const LOWSHELF_FREQ = 320;
export const PEAKING_FREQ = 1000;
export const PEAKING_Q = 0.5;
export const HIGHSHELF_FREQ = 3200;
export const LOWPASS_FREQ = 20000;
export const HIGHPASS_FREQ = 30;

// === UI Timing ===
export const BLINK_INTERVAL_MS = 500;
export const TOAST_DURATION_MS = 3000;
export const PROGRESS_UPDATE_INTERVAL_MS = 100;
export const SLIDER_SNAP_THRESHOLD = 0.05;

// === Crossfade / AutoMix ===
export const DEFAULT_TRACK_DURATION_S = 10.0;
export const DEFAULT_BTN_DURATION_S = 4.0;
export const CROSSFADE_RAMP_LOW_DB = -24;
export const CROSSFADE_RAMP_MID_DB = -12;
export const CROSSFADE_LP_SWEEP_HZ = 600;
export const CROSSFADE_HP_SWEEP_HZ = 2000;

// === Visualizer / LEDs ===
export const BASS_THRESHOLD = 200;
export const MID_THRESHOLD = 160;
export const HIGH_THRESHOLD = 100;
export const AVG_THRESHOLD = 2;
export const SCANNER_INTERVAL_MS = 300;
export const LED_FRAME_SKIP = 2;

// === Sampler ===
export const NUM_PADS = 16;
export const WAVEFORM_POINTS = 100;
export const POOL_SIZE = 32;
export const PAD_MIDI_START_NOTE = 36;
export const PAD_MIDI_NOTES = [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
export const DEFAULT_PAD_KEY_MAP = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'];

// === Blob URL Management ===
export const BLOB_REVOKE_DELAY_MS = 5000;
export const BLOB_REVOKE_CROSSFADE_MS = 3000;

// === Security ===
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const VALID_AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac'];

// === Crash Recovery ===
export const AUTO_SAVE_INTERVAL_MS = 30000;
export const MIN_SAVE_INTERVAL_MS = 10000;
export const MAX_SNAPSHOTS = 3;

// === Misc ===
export const MAX_PLAYLIST_SEARCH_RESULTS = 1000;
export const MIDI_LEARN_TIMEOUT_MS = 10000;
