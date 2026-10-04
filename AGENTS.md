# Gangsta Player Pro 3 — Agent Guide

## Project Overview

Electron-based desktop ghetto-tech sampler, tape deck, and DJ mixing application. Turns the PC into a beat-making, chopper-screwing powerhouse with 16-pad sampler, playlist player, AI auto-mix, and studio recording.

- **Version:** 4.20.1
- **License:** MIT
- **Main repo:** https://github.com/coreyshearwater/ug-gangsta-player-pro-3

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron v30 |
| Language | TypeScript (strict mode, ESNext modules) |
| Bundler | esbuild (via `scripts/build.js`) |
| Testing | Jest (77 tests), Playwright (smoke) |
| Audio | Web Audio API, WebMIDI |
| Storage | better-sqlite3 (track metadata) |
| AI Mixer | Local DSP engine (EQ crossfade, filter sweeps, BPM sync — Sonetra Python backend removed) |
| Packaging | electron-builder (NSIS for Win, DMG for Mac) |

## Project Structure

```
├── main.ts                     # Electron main process (322 lines)
├── preload.ts                  # Context bridge (52 lines)
├── js/main.ts                  # Renderer entry, UI init, event wiring (589 lines)
├── js/audio.ts                 # Web Audio context, master gain, analyser, worklets (96 lines)
├── js/modals.ts                # Unified modal open/close with focus mgmt (80 lines)
├── js/audio-engine.ts          # AudioChannel class, engine singleton, crossfade channels (124 lines)
├── js/player.ts                # Player controls, crossfade logic, track loading (533 lines)
├── js/playlist.ts              # Playlist UI, drag-drop, multi-select, virtual scroller (555 lines)
├── js/sampler.ts               # 16-pad sampler, recording, kit persistence (720 lines)
├── js/session.ts               # Full session save/load: kit, playlist, settings, UI state (364 lines)
├── js/crash-recovery.ts        # Auto-save snapshots, restore prompt, data loss prevention (308 lines)
├── js/visuals.ts               # 16-band frequency analyzer, LED rack, screws (186 lines)
├── js/midi.ts                  # WebMIDI input handling, MIDI learn (219 lines)
├── js/state.ts                 # Central reactive state manager (167 lines)
├── js/settings.ts              # Settings persistence, AutoMix config, modals (355 lines)
├── js/recorder-client.ts       # High-fidelity master recording via AudioWorklet (70 lines)
├── js/worker-client.ts         # Web Worker client for BPM detection + WAV conversion (119 lines)
├── js/constants.ts             # App constants, utility helpers (68 lines)
├── js/utils.ts                 # normalizeToArrayBuffer, validateAudioSignature, Disposable class, debounce, throttle (250 lines)
├── js/toast.ts                 # Toast notification system (46 lines)
├── js/logger.ts                # Client-side logging with disk persistence (186 lines)
├── js/types.ts                 # TypeScript type definitions & window augmentations (96 lines)
├── js/reactive/ui.ts           # VirtualScroller + reactive element helpers (110 lines)
├── js/workers/audio-worker.ts  # Web Worker: BPM detection + WAV encoding (116 lines)
├── js/workers/gangsta-processor.ts # AudioWorkletProcessor: gangsta effects (108 lines)
├── js/workers/recorder-processor.ts # AudioWorkletProcessor: capture (43 lines)
├── db-manager.ts               # SQLite database manager (108 lines)
├── log-manager.ts              # Logging system with ring buffer + crash reports (93 lines)
├── scripts/build.js            # esbuild bundler script (137 lines)
├── index.html                  # Renderer HTML entry point (299 lines)
├── styles.css                  # Dark theme, custom scrollbar, animations (2122 lines)
├── tests/                      # Jest + Playwright test suite (6 files)
│   ├── audio-engine.test.ts    # AudioChannel/AudioEngine tests (13 tests)
│   ├── player.test.ts          # Player logic tests
│   ├── settings.test.ts        # Settings save/load/validation tests (8 tests)
│   ├── smoke.test.js           # Playwright smoke test
│   ├── state.test.ts           # ReactiveStore tests
│   └── utils.test.ts           # Utility function tests
├── android-port/               # React Native (Expo) Android port
└── assets/                     # Static assets (incl. startup sound)
```

## Main Process (`main.ts`)

**Window creation:** 1050x900 frameless, sandboxed, contextIsolation: true, preload: preload.js.

**IPC Handlers:**

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `app:minimize` | Render→Main | Minimize window |
| `app:maximize` | Render→Main | Toggle maximize/unmaximize |
| `app:close` | Render→Main | Close window (also closes DB) |
| `app:set-fullscreen` | Render→Main | Full screen toggle |
| `app:ready-to-show` | Render→Main | Show window when ready |
| `app:open-external` | Render→Main | Open README in Notepad (win32 only) |
| `app:generate-crash-report` | Render→Main | Generate crash report JSON |
| `dialog:save-kit` | Render→Main | Save dialog for sampler kit (JSON) |
| `dialog:load-kit` | Render→Main | Open dialog for loading kit (JSON) |
| `dialog:save-audio` | Render→Main | Save dialog for WAV master recording |
| `dialog:open-sample` | Render→Main | Open dialog for audio samples (wav/mp3/ogg/flac) |
| `fs:save-file` | Render→Main | Write file (dialog-returned or userData paths only) |
| `fs:read-file` | Render→Main | Read file as Buffer (validated absolute path, no traversal) |
| `fs:ensure-recordings-dir` | Render→Main | Create recordings directory |
| `fs:save-recording` | Render→Main | Save recording buffer to userData/recordings |
| `fs:append-log` | Render→Main | Persist log entry to disk |
| `fs:get-log-path` | Render→Main | Return current log file path |
| `db:upsert-track` | Render→Main | Insert/update track metadata |
| `db:get-track` | Render→Main | Get track by path |
| `db:search-tracks` | Render→Main | Search tracks by name/path (LIKE %) |
| `db:get-all-tracks` | Render→Main | Get all tracks (sorted by name) |

**Security:** Path validation via `validatePath()` — normalizes path, rejects if contains null byte or attempts directory traversal. `fs:save-file` tracks dialog-returned paths via `dialogReturnedPaths` Set and only allows those or `userData` directory. `fs:read-file` validates the path is absolute, not a symlink to a blocked location, and that the file actually exists.

**Crash protection:** `uncaughtException` handler generates post-mortem report with system specs + log buffer, then exits.

## Preload (`preload.ts`)

Four context bridges exposed via `contextBridge.exposeInMainWorld`:

- `window.electronAPI` — minimize, maximize, close, setFullScreen, saveKit, loadKit, saveAudioDialog, **getPathForFile** (via `webUtils.getPathForFile`), openSampleDialog, appReadyToShow, openExternal, generateCrashReport
- `window.fileSystem` — saveFile, readFile, ensureRecordingsDir, saveRecording, appendLog, getLogPath
- `window.database` — upsertTrack, getTrack, searchTracks, getAllTracks
- `window.pcmCache` — decoded-audio PCM disk cache (get/put, hex-keyed)

## Renderer Entry (`js/main.ts`)

**Init order:** Worklets → Sampler → Player → Playlist → MIDI → Settings → Visuals → Handlers → Startup sound.

**Key responsibilities:**
- Window control button wiring (min/max/close)
- Pad mouse/keyboard/MIDI event wiring per-pad
- Pad context menu: LOAD SAMPLE, SYNC, MIDI LEARN, KEY BIND
- Control (slider) context menu: MIDI LEARN
- Play button context menu: CONTINUOUS / STOP AFTER CURRENT
- Loop button context menu: OFF / ONE / ALL
- Master recording button: HighFidelityRecorder start/stop/save
- Global keyboard shortcuts: SPACE (play/pause), ENTER (stop), arrows (playlist nav)
- Global crash handlers: window.onerror + onunhandledrejection → logger.generateCrashReport
- Document click handler (once): resumeAudioContext + enableMIDI

## Audio Engine (`js/audio-engine.ts`)

**`AudioChannel` class:**
- Audio element + complete signal chain: `Source → LowEQ(lowshelf 320Hz) → MidEQ(peaking 1kHz Q0.5) → HighEQ(highshelf 3.2kHz) → LPFilter(lowpass 20kHz) → HPFilter(highpass 30Hz) → Gain → MasterGain`
- `initWorklet()` — injects `gangsta-processor` AudioWorkletNode between HPFilter and Gain (safe fallback if not ready)
- `reset()` — cancels all scheduled values, resets gains/filters to defaults
- `load(url)` — sets audio.src

**`AudioEngine` class:** Two AudioChannel instances: `main` (active) + `crossfade` (incoming).
- `swapChannels()` — swaps main↔crossfade references, clears crossfade audio
- `initWorklets(retries=3)` — retries worklet injection with backoff

**Singleton:** `export const engine = new AudioEngine()`

## Audio Context (`js/audio.ts`)

- `audioCtx` — singleton AudioContext (webkit fallback)
- `masterGain` — master volume GainNode
- `analyser` — AnalyserNode (FFT size from constants)
- `resumeAudioContext()` — resumes if suspended
- `bufferToWave(ab)` — delegates to worker for WAV encoding
- `initWorklets()` — registers gangsta-processor + recorder-processor AudioWorklets (singleton)
- `createAudioBuffer(data)` — reconstructs AudioBuffer from decoded PCM data
- `DecodeResult` interface: numberOfChannels, sampleRate, length, duration, channels

## Player (`js/player.ts`)

**State management:** PlaybackMode (continuous|single), LoopMode (off|one|all), isAutoMixEnabled, isCrossfadeInProgress.

| Function | Purpose |
|----------|---------|
| `initPlayer(deps)` | Cache DOM refs, subscribe to state changes, call setupPlayerHandlers |
| `loadTrack(index)` | Load track from playlist, decode audio via IPC `readFile` + `normalizeToArrayBuffer`, detect BPM (async), update UI |
| `playTrack()` | Resume context + play (guarded against crossfade) |
| `pauseTrack()` | Pause (guarded) |
| `stopPlayback()` | Stop + reset both channels, clear crossfade state |
| `setAutoMixEnabled(val)` | Toggle AutoMix, disable loop-one if enabling |
| `toggleAutoMix()` | Toggle helper |
| `startCrossfade(targetIndex, customDuration?)` | Full AutoMix transition: EQ automation, filter sweeps, gain ramps, channel swap |
| `setPlaybackMode(mode)` / `getPlaybackMode()` | Playback mode control |
| `setLoopMode(mode)` / `getLoopMode()` | Loop mode control + updates audio.loop |
| `getMasterBPMRef()` | Reactive ref to masterBPM |
| `getTempoSlider()` / `getPlayerAudio()` | Accessors |
| `showConfirm(title, msg, onYes)` | Non-blocking confirmation modal (lives in player.ts) |

**Crossfade automation:**
- Outgoing channel: gain ramp to 0, EQ cut (low -24dB, mid -12dB), LP filter sweep 20kHz→600Hz
- Incoming channel: gain ramp to 1, EQ restore, HP filter sweep 2kHz→30Hz
- Timings controlled by `settings.autoMix.trackDuration` / `btnDuration`

**Blob URL management:** `getSafeUrl()` reads file via IPC, creates blob URL, tracks main/crossfade URLs, revokes stale URLs after delay.

## Playlist (`js/playlist.ts`)

**Virtual scroller** via `VirtualScroller<Track>` — only renders visible rows.

| Function | Purpose |
|----------|---------|
| `initPlaylist(deps)` | Init virtual scroller, load tracks from DB, setup search listener |
| `addTracksToPlaylist(files)` | Add File[] from DnD or dialog, kick off BPM analysis, auto-select first track |
| `renderPlaylist()` | Force refresh of virtual scroller |
| `handlePlaylistNavigation(e)` | ArrowUp/Down keyboard nav with SHIFT multi-select, Delete/Backspace to remove |
| `removeSelectedTracks()` | Remove selected indices (sorted desc), adjust selection |
| `setBlendingIndex(index)` | Update UI for crossfade blending indicator |
| `setupPlaylistHandlers()` | Wire file input, drag-drop, context menu actions (Remove, Move Up, Move Down, Play) |

**Track model:** `{ id, name, path, duration, bpm }`

**BPM analysis:** Background worker per track — check DB cache first, then decode via Web Audio, run `detectBPMResilient` (+ `resolveBpmPersist` skip-persist policy), persist to DB.

**Selection:** Multi-select via SHIFT (range) + CTRL (toggle), anchor/pivot pattern.

## Sampler (`js/sampler.ts`)

**16 pads** with keyboard mapping + MIDI mapping + mouse interaction.

**Exported state:**
- `padBuffers[0..15]` — loaded AudioBuffers
- `padPaths[0..15]` — file names/paths
- `activeVoices[0..15]` — active { source, gain } or null
- `padVolumes[0..15]` — per-pad volume (default 0.75)
- `padBPMs[0..15]` — detected BPMs
- `padSyncState[0..15]` — SYNC toggle

| Function | Purpose |
|----------|---------|
| `initSampler(deps)` | Create pad grid, subscribe to padKeyMap changes |
| `loadSampleFile(file, index)` | Load File to pad, detect BPM |
| `loadSampleFromPath(path, index)` | Load file path to pad via IPC + `normalizeToArrayBuffer` |
| `startPad(index)` | Create BufferSource → Gain → masterGain. Loop enabled. SYNC mode: beat-quantized start offset, BPM-matching playback rate |
| `stopPad(index)` | Stop + disconnect active voice |
| `toggleSync(index)` | Toggle SYNC mode on/off |
| `createPadGrid()` | Build DOM for all 16 pads |
| `setupPadKeyboardHandlers()` | keydown/keyup for pad triggers, CTRL+key = record, key learn mode |
| `saveKit()` | Serialize pads to JSON, save via dialog |
| `loadKitDialog()` | Load kit JSON, restore samples + volumes |

**Pad recording:** getUserMedia → MediaRecorder → decodeAudioData → padBuffers[index].

**SYNC mode:** When enabled + master BPM available + pad BPM available:
- `playbackRate = (masterBPM / padBPM) * tempoSlider`
- `startOffset = beatPhase * padBeatDuration` — beat-quantized start

## MIDI (`js/midi.ts`)

| Function | Purpose |
|----------|---------|
| `initMIDI(deps)` | Cache device select dropdown, wire change handler |
| `enableMIDI()` | Request MIDI access (called once on first user click) |
| `onMIDISuccess(access)` | Wire onmidimessage for all inputs, listen for device changes |
| `onMIDIFailure()` | Update status to FAIL |

**MIDI message handling (`getMIDIMessage`):**
- Note On (cmd=9, velocity>0) → trigger pad via padMidiMap, apply velocity to gain
- Note Off (cmd=8 or cmd=9 velocity=0) → stop pad
- CC (cmd=11) → map to controls via controlMidiMap, dispatch input event
- MIDI learn mode → captures Note/CC, updates padMidiMap or controlMidiMap

**MIDI learn:** `handleMidiLearn(cmd, data1)` — steals binding (removes old mappings), shows toast.

## Session (`js/session.ts`)

**Full session serialization** — saves and restores the entire app state in one operation.

| Function | Purpose |
|----------|---------|
| `saveSession()` | Serializes kit (pads, volumes, BPMs, sync), playlist, settings, UI state (volume, tempo, loop mode, playback mode) to JSON |
| `loadSession()` | Restores full state from JSON file via dialog |
| `exportSession()` | Export session to a user-chosen file path |
| `importSession()` | Import session from a user-chosen file path |

## Crash Recovery (`js/crash-recovery.ts`)

**Auto-save snapshots** with periodic backup to prevent data loss.

| Function | Purpose |
|----------|---------|
| `initCrashRecovery(deps)` | Start periodic auto-save interval (every 30s); check for existing snapshot on startup |
| `checkForCrashRecovery()` | On startup, checks localStorage for saved snapshots and offers to restore |
| `saveSnapshot()` | Writes current app state (kit, playlist, playback position, settings) to localStorage |
| `restoreFromSnapshot()` | Restores full app state from the latest snapshot |
| `clearSnapshots()` | Clears all stored snapshots after successful recovery |

**Snapshot storage:** localStorage under keys `ug_crash_snapshot` and `ug_crash_snapshot_bak` (backup). Maximum 3 historical snapshots maintained rotationally.

## State (`js/state.ts`)

**`ReactiveStore`** class with pub/sub pattern using shallow referential checks (no JSON.stringify).

**State shape (`AppStateData`):**
- `isPlaying`, `currentTrackIndex`, `playbackMode`, `loopMode`, `masterBPM`
- `playlist: Track[]`, `selectedIndices: number[]`
- `isAutoMixEnabled`, `isCrossfadeInProgress`, `blendingIndex`
- `isMidiActive`
- `padMidiMap`, `padKeyMap`, `controlMidiMap`
- `isLearningMidi`, `midiLearnTarget`
- `isLearningKey`, `keyLearnTargetPad`

| Method | Purpose |
|--------|---------|
| `subscribe(key, fn)` | Listen to specific property changes (returns unsubscribe) |
| `subscribeAll(fn)` | Listen to any state change |
| `update(patch)` | Partial update, reference-equality check, notify specific + global listeners |

## Settings (`js/settings.ts`)

**`Settings` interface:** fullScreen, inputDevice, outputDevice, midiDevice, autoMix.

**AutoMix settings:** eqCrossfade, filterSweep, hpfSweep, bpmSync, trackDuration (default 10s), btnDuration (default 4s).

| Function | Purpose |
|----------|---------|
| `initSettings(deps)` | Wire settings button/modal, click-outside close, Escape key handler |
| `loadSettings()` | Load from localStorage, apply to UI, set fullscreen |
| `saveSettings()` | Read UI values, persist to localStorage, actuate fullscreen |
| `setupSettingsHandlers()` | Wire AutoMix modal, auto-save on toggle change, duration sliders, restore defaults, help modal |

## Visuals (`js/visuals.ts`)

**16-bar frequency analyzer** + 6 LED rack + decorative screws.

| Function | Purpose |
|----------|---------|
| `initVisuals()` | Create bar elements, cache LEDs, setup screws, start master loop |
| `playStartupSound()` | Fetch `assets/gun-load.wav`, decode, play via buffer source (fallback: Audio element) |

**`masterLoop()`** (rAF):
- Read analyser frequency data (FFT size 256)
- 16 bars: height = (value/255) * 100%
- LEDs: left/right pairs for bass (5 bins avg > 200), mid (20 bins > 160), high (40 bins > 100)
- Idle scanner: LED cycling animation when no audio
- Crossfade bypass: always show active during blend

## Recorder Client (`js/recorder-client.ts`)

**`HighFidelityRecorder`** class — captures master output via AudioWorkletNode.

| Method | Purpose |
|--------|---------|
| `init()` | Create AudioWorkletNode 'recorder-processor', connect source, wire message handler |
| `start()` | Clear chunks, post START message |
| `stop()` | Post STOP message, compile WAV from chunks, return Blob |
| `dispose()` | Disconnect node, clear chunks |

**WAV compilation:** Flattens Float32Array chunks into AudioBuffer → delegates to `bufferToWave()` (worker-based WAV encoder).

## Worker Client (`js/worker-client.ts`)

Single `audio-worker.js` instance with request/response pattern.

| Function | Purpose |
|----------|---------|
| `detectBPMWithConfidence(audioBuffer)` | Send channel 0 data to worker, get BPM + confidence. Transfers ArrayBuffer for zero-copy |
| `detectBPMResilient(audioBuffer)` | One confident attempt + one relaxed-threshold retry; callers gate persistence via `resolveBpmPersist` |
| `bufferToWaveWorker(audioBuffer, len)` | Send multi-channel data to worker, get WAV Blob. Transfers all channel buffers |

## Utilities (`js/utils.ts`)

Contains shared pure functions used across the renderer:

| Function / Class | Purpose |
|------------------|---------|
| `normalizeToArrayBuffer(data)` | Robustly converts IPC return data (ArrayBuffer, Uint8Array, Buffer) to a clean, standalone ArrayBuffer. Uses `toString()` cross-realm check instead of `instanceof`. Throws for unsupported types. |
| `validateAudioSignature(buffer, fileName?)` | Checks magic number signatures (RIFF/WAVE, MP3 sync bits, OggS, fLaC) to verify a buffer contains valid audio data. Returns `null` on success or error string on failure. |
| `isValidAudio(arrayBuffer)` | Convenience boolean wrapper around `validateAudioSignature`. |
| `Disposable` class | Manages cleanup callbacks with `add()` and `on(el, event, handler)` methods. Calling `dispose()` tears down all registered listeners/timers. Used by `VirtualScroller` to prevent listener leaks. |

## AI Mixer (local DSP — Sonetra removed)

Mixing is handled entirely by the local DSP engine (EQ crossfade, filter sweeps, BPM sync), fully offline. The former Sonetra Python FastAPI backend (`sonetra-bridge.ts`, `sonetra:*` IPC, preload `sonetra` bridge) was removed; the audio-consent allowlist it owned now lives in `db-manager.ts` (`isAllowedAudioFile`/`isAllowedAudioDirForPath`/`addAllowedAudioFile`).

## DB Manager (`db-manager.ts`)

SQLite via better-sqlite3, WAL mode + NORMAL sync.

**Tables:** tracks (id, path, name, duration, bpm, metadata, last_analyzed), kits, settings.

| Method | Purpose |
|--------|---------|
| `upsertTrack(track)` | INSERT OR UPDATE on path conflict |
| `getTrackByPath(path)` | SELECT by path |
| `getAllTracks()` | SELECT * ORDER BY name |
| `searchTracks(query)` | SELECT WHERE name LIKE or path LIKE |
| `saveKit(id, name, path, data)` | INSERT OR UPDATE kit |
| `loadKit(path)` | SELECT kit by path |
| `close()` | Close database connection |

## Log Manager (`log-manager.ts`)

**Ring buffer** (1MB max) + immediate flush for ERROR/CRITICAL.

| Method | Purpose |
|--------|---------|
| `log(level, source, message)` | Add to ring buffer, flush high-interest events immediately |
| `info(msg)` / `error(msg)` | Shortcuts scoped to MAIN |
| `getBufferContents()` | Return full ring buffer |
| `getLogPath()` | Return log file path |
| `generatePostMortem(snapshot)` | Create crash_report_*.json with system specs + logs + app state |

## Build System (`scripts/build.js`)

esbuild bundles:
- Main process → `app-build/main.js` (node, external: electron/fsevents/better-sqlite3)
- Preload → `app-build/preload.js` (node, external: electron)
- Renderer `js/main.ts` → `app-build/js/main.js` (browser, ESM)
- Workers → `app-build/js/workers/audio-worker.js`, `gangsta-processor.js`, `recorder-processor.js`
- Assets copied: `index.html`, `styles.css`, `icon.png`, `package.json` (minimal), `README.md`, `assets/*`

## IPC Communication

All communication via `contextBridge` in `preload.ts`. Four bridges:

```
electronAPI  →  window controls, dialogs, crash reports, getPathForFile
fileSystem   →  file read/write, recording, logging
database     →  track metadata CRUD
```

## Audio Pipeline

1. Tape deck: `<audio>` → MediaElementSource → AudioChannel EQ/filter chain → masterGain → analyser → destination
2. Sampler: AudioBufferSourceNode → GainNode → masterGain (same chain)
3. Crossfade: Two AudioChannels swapped atomically via `engine.swapChannels()`
4. Recording: masterGain → recorder-processor AudioWorkletNode → Float32Array chunks → WAV
5. Visualizer: AnalyserNode.getByteFrequencyData() → 16 bars + 6 LEDs

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Build dev + launch Electron |
| `npm test` | Run Jest test suite (77 tests) |
| `npm run build:prod` | Minified obfuscated production build |
| `npm run dist` | Package into installer (electron-builder) |
| `npm run audit` | Run npm audit at high severity level |
| `npm run audit:fix` | Fix npm audit issues |

## Global Keyboard Shortcuts

| Key | Action |
|-----|--------|
| SPACE | Play/Pause (blocked during crossfade) |
| ENTER | Stop playback |
| ← / → | Seek back/forward 5 seconds |
| ↑ / ↓ | Playlist navigation |
| SHIFT + ↑ / ↓ | Multi-select range |
| DELETE / BACKSPACE | Remove selected tracks |
| 1-4, Q-R, A-F, Z-V | Trigger sampler pads |
| CTRL + Pad Key | Record to pad |
| ESC | Close topmost modal / context menu |

## Testing

```
npm test
```
Jest config in `jest.config.js` (21 lines) — matches `tests/**/*.test.js`. Uses Node environment. Smoke test uses Playwright.

Six test files: `audio-engine.test.ts` (13 tests), `player.test.ts`, `settings.test.ts` (8 tests), `smoke.test.js`, `state.test.ts`, `utils.test.ts`. Total: 77+ tests.

## Style & Conventions

- **TypeScript strict mode** enabled
- No comments in code unless necessary
- ES modules (`import`/`export`) throughout
- DOM access via `document.getElementById` and direct event listeners
- Dark theme with CSS custom properties in `styles.css`
- Custom scrollbars, no external UI framework
- Drag-and-drop uses native HTML5 DnD API
- Multi-select uses SHIFT/CTRL + click pattern
- IPC returns raw values (Buffer for file data, Track objects for DB, etc.) — call sites check for null/undefined.
- State management: ReactiveStore with property-specific subscriptions
- AudioContext singleton with worklet registration protection
- Blob URL lifecycle: created on track load, revoked after delay
- Event listener cleanup: `Disposable` class in `utils.ts` for leak-free components
- Audio buffer handling: `normalizeToArrayBuffer()` must be used for all IPC-returned audio data to prevent Electron realm-crossing ArrayBuffer bugs
- Audio file validation: `validateAudioSignature()` should be called on incoming audio buffers to reject non-audio files early
- **No `window as any` casts** — always import `./types` and use typed `window.xxx` references
