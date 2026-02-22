# CHANGELOG

## [v3.2.1] - 2026-02-22 - "Hardened Core & Modular Audio"

### 🛡️ Security Audit Fixes

- **Path Lockdown**: Sanitized IPC file handlers to prevent path traversal/remote access exploits.
- **Strict Spawn**: Disabled shell-mode spawning for the Sonetra backend to block command injection.
- **Cache Management**: Implemented LRU-style capacity limits for the Transition Cache (`MAX_CACHE_SIZE = 50`) to prevent memory leaks.
- **Secure Sandbox**: Enabled `sandbox: true` in Electron webPreferences.
- **Repo Hardening**: Performed pre-push audit; nuked duplicate `dist_source`, moved assets to `assets/` folder, and updated `.gitignore` to block local environments.
- **License Clarity**: Formally set license to Proprietary in `package.json`.

### 🏗️ Architecture Redesign

- **Audio Engine Extraction**: Created `js/audio-engine.js` to modularize the 2-channel signal path, decoupling it from the UI handlers.
- **Overhauled Player**: Refactored `js/player.js` into a clean orchestrator; added `AudioChannel` abstraction for seamless channel promoting.
- **Environment Parity**: Added support for `config.json` to allow manual overrides for Python and Sonetra paths.

### 💅 UI & Performance

- **Non-Blocking Modals**: Replaced legacy browser `alert()` and `confirm()` calls with a non-blocking Ninja-themed confirmation modal and toast system.
- **Visualizer Optimization**: Throttled heavy LED rack calculations (running logic every 2nd frame) to improve main-thread performance.

## [v3.2.0] - 2026-02-22 - "The Optimized Core Update"

### 🚀 Performance & Architecture

- **Centralized State**: Unified application state in `js/state.js` for better synchronization.
- **Web Workers**: Offloaded BPM detection and WAV recording to background threads.
- **Modular Cleanup**: Removed legacy `renderer.js` and decoupled business logic from orchestrator.

### 💅 UI/UX Improvements

- **Neon Toast System**: Replaced browser alerts with sleek, cyberpunk-themed notifications.
- **Async Feedback**: Added "Analyzing..." visual feedback during track loading.

### 🧪 Quality Assurance

- **Testing Suite**: Added Jest and Electron-Playwright for automated verification.

## [v3.1.1] - 2026-01-31 - "Drop It Like It's Hot"

### 📥 Drag & Drop Features

- **Drag & Drop Support**:
  - **Playlist**: Drag audio files (MP3/WAV) directly into the playlist to add them.
  - **Sampler Pads**: Drag audio files onto any pad to load or replace samples instantly.

## [v3.1.0] - 2026-01-26 - "The Physics & Flow Update"

### 🎹 Workflow & Physics Features

- **Pro Auto-Mix Engine**: Completely rewritten mixing logic.
  - **Balanced Crossfades**: Replaced exponential dips with Linear Power fades for punchy, constant-energy transitions.
  - **Zero-Latency Handoff**: New audio object swapping removes the tiny gap between tracks.
  - **Live Settings**: Toggling EQ/Filter effects works instantly during playback.
- **Magnetic Sliders**:
  - **Tempo Slider** snaps to 100% (1.0x) speed.
  - **Pad Vol Sliders** snap to Default (75%) level.
- **Play Button Context Menu**: Right-click the Play button to switch between:
  - **Continuous Playback**: Plays the next track automatically (Default).
  - **Stop After Current**: Stops playback after the current track finishes.
- **Loop Button Context Menu**: Right-click the Loop button to separate loop logic:
  - **Loop Off**: Normal playback.
  - **Loop Current**: Repeats the active song (Standard).
  - **Loop Playlist**: Wraps back to the first song after the last one finishes.

### 💅 Additional UI/UX Improvements

- **Pad Tooltips**: Context-aware help text ("Click to Load" vs "Right-Click for Options").
- **Pad Typography**: Increased number font size for better visibility.
- **Filename Display**: Loaded pads now show the sample name at the bottom in a sleek, smaller font.
- **Visual Feedback**: Real-time time display updates while scrubbing the timeline.

### 🐛 Bug Fixes

- Fixed "blasting" volume distortion by correcting crossfade summing curves.
- Fixed small audio glitch at end of Auto-Mix.

---
