# GANGSTA PLAYER PRO 3

![Main Interface Placeholder](https://via.placeholder.com/800x450?text=Gangsta+Player+Pro+3+Main+UI)
![Sampler Pads View](https://via.placeholder.com/400x300?text=16-Pad+Sampler+View)
![Settings Panel](https://via.placeholder.com/400x300?text=Settings+%26+Automation)
*The ultimate ghetto-tech sampler, tape deck, and DJ mixing application.*

---

## 🔥 FEATURES

### 🎹 16-PAD SAMPLER

- **Drag & Drop:** Drop any audio file onto a pad to load it instantly.
- **Click to Load:** Click an empty pad to open a file browser.
- **Hold to Play:** Hold the mouse button (or keyboard key) on a loaded pad to play it — release to stop.
- **Keyboard Mapped:** Play pads with your keyboard (`1-4`, `Q-R`, `A-F`, `Z-V`).
- **MIDI Support:** Plug in your MIDI controller and start finger drumming instantly.
- **Pad Recording:** Hold `CTRL + Pad Key` or click the small `[REC]` button to record directly from your mic.
- **BPM Detection:** Each loaded pad auto-detects its BPM for sync.
- **Right-Click Menu:**
  - **LOAD SAMPLE** — Browse and load an audio file.
  - **SYNC** — Match the pad's tempo to the master track (beat-quantized start). Click again to deactivate. Shows ✓ when active.
  - **MIDI LEARN** — Assign a MIDI note to trigger this pad (visible when MIDI is active).
  - **KEY BIND** — Reassign which keyboard key triggers this pad.

### 📼 TAPE DECK PLAYER

- **Drag & Drop:** Drag audio files directly into the playlist to add them.
- **Playlist System:** Load up your MP3s/WAVs and keep the vibe going.
- **Multi-Select:** Hold `SHIFT` and press `↑/↓` (or Click) to select multiple tracks. Use `CTRL`+Click to toggle.
- **Master Chopper & Screwer:** Use the global tempo slider to slow that track down. **Real-time screw.**
- **Magnetic Snap:** Slider snaps to 100% speed so you don't mess up the flow.
- **Drag & Drop Reorder:** Select single or multiple tracks and drag them to move the whole block in real-time.

### 🎧 AI AUTO-MIX

- **Pro DJ Transitions:** Automatically mixes between tracks using professional techniques:
  - **Bass Swap:** Cuts bass on outgoing, drops it on incoming.
  - **Filter Sweeps:** Low-pass filter exit and High-pass filter entry.
- **BPM Sync:** Matches the tempo of the next song to the current one for seamless mixing.
- **Auto-Cruise:** Just hit "MIX" and let it flow using proper crossfades.
- **Fast Mix:** Hit Next/Prev buttons (`>|` or `|<`) for a fast 4-second DJ cut.
- **Transport Lock:** Progress/seek/tempo/Next/Prev lock during crossfade blending for stability — STOP (and ENTER) always stays armed and aborts the blend.
- **Sonetra AI (pre-warm only):** When enabled, blends trigger background AI-transition generation for future mixes; live AI-stem playback is not implemented.
- **Customizable:** Open Settings (`⚙️`) to toggle effects and customize fade durations.

### 🎙️ STUDIO RECORDING

- **Master Rec:** Hit the big RED button to record your **entire performance** (beats + music) to a high-quality `.wav` file.
- **Visualizer:** 16-band frequency analyzer with "Scanner" LED rack.
- **AudioWorklet Capture:** Zero-latency PCM capture via dedicated AudioWorkletProcessor.

### 🛡️ SECURITY & RELIABILITY

- **Path Validation:** All file I/O hardened against directory traversal, null-byte injection, and oversized payloads. Reads are restricted to media/kit file types (`wav/mp3/ogg/flac/m4a/aac/webm/json`); writes are limited to `.json`/`.wav` via dialog-approved paths or the app `recordings/` directory (database and log files are never writable from the renderer).
- **Lazy Audio Engine:** The AudioContext and sampler/deck signal chains build on first use and rebuild after a closed-context reset — a pre-gesture failure no longer bricks audio permanently.
- **Session Integrity:** Session files carry a SHA-256 corruption-evidence checksum (not attacker-proof by design — no secret is stored); corrupt/edited files abort load.
- **Single Instance Lock:** Only one app instance can run at a time (protects the track database).
- **Crash Recovery:** Persistent auto-save snapshots every 30s with post-mortem diagnostic reports.
- **Audio Signature Validation:** Magic-number verification ensures only valid WAV/MP3/OGG/FLAC/M4A/WebM files are loaded.
- **Worklet Race Protection:** Retry logic for AudioWorklet initialization prevents silent engine startup failures.
- **Recoverable Audio Worker:** BPM/WAV worker crashes reject pending work with clear errors and respawn on demand — no permanent hangs.

---

## ⌨️ KEYBOARD SHORTCUTS

### Playback Controls

| Action | Key |
| :--- | :--- |
| **Play / Pause** | `SPACE` |
| **Stop / Play Selected** | `ENTER` |
| **Seek Back 5 Seconds** | `←` (Left Arrow) |
| **Seek Forward 5 Seconds** | `→` (Right Arrow) |

### Playlist Navigation

| Action | Key |
| :--- | :--- |
| **Navigate Down** | `↓` (Down Arrow) |
| **Navigate Up** | `↑` (Up Arrow) |
| **Multi-Select (Extend)** | `SHIFT` + `↑` / `↓` |
| **Delete Selected Track(s)** | `DELETE` / `BACKSPACE` |

### Sampler Pads

| Action | Key |
| :--- | :--- |
| **Trigger Pad** | `1, 2, 3, 4, Q, W, E, R, A, S, D, F, Z, X, C, V` |
| **Record to Pad** | `CTRL` + Pad Key (Hold) |

### Other

| Action | Control |
| :--- | :--- |
| **Master Volume** | Slick Knob Slider |
| **Tempo/Speed** | Chopper & Screwer Slider |
| **Settings** | `⚙️` Button |
| **Close Modal / Context Menu** | `ESC` |

---

## 📖 HOW TO USE

### Getting Started

1. **Load Audio:** Click `[+] LOAD AUDIO` or drag & drop audio files into the playlist.
2. **Play a Track:** Double-click a track to play it, or select with arrows and press `ENTER`.
3. **Playback Modes:** Right-click the **PLAY** button to toggle between:
   - **Continuous Playback:** Automatically plays the next song.
   - **Stop After Current:** Stops after the song finishes.
4. **Loop Modes:** Right-click the **LOOP** button to toggle between:
   - **Loop Off:** Plays normally (Default).
   - **Loop Current:** Repeats the current track.
   - **Loop Playlist:** Wraps around to the start after the last track.
5. **Adjust Speed:** Use the Chopper & Screwer slider to slow down or speed up playback.

### Multi-Select Tracks

1. Use `↑` / `↓` arrows to navigate the playlist.
2. Hold `SHIFT` and press `↑` / `↓` OR Click another track to select a range.
3. Hold `CTRL` and Click to add/remove individual tracks.
4. Drag the selected tracks to move them all at once.
5. Press `DELETE` to remove all selected tracks at once.

### Using the Sampler Pads

1. **Load a Sample:** Right-click any pad → "LOAD SAMPLE", drag & drop an audio file, or click an empty pad.
2. **Play:** Hold the corresponding key (`1-4`, `Q-R`, `A-F`, `Z-V`) or hold the mouse on the pad. Release to stop.
3. **Record:** Hold `CTRL` + pad key or click the [REC] button on a pad to record from your mic.
4. **Sync:** Right-click a loaded pad → "SYNC" to match its tempo to the master track. The pad's BPM is auto-detected, and playback starts beat-aligned with the playlist. A checkmark (✓) indicates SYNC is active; click SYNC again to deactivate.
5. **MIDI Learn:** Right-click a pad → "MIDI LEARN" (when MIDI is active), then press a note on your controller to bind it.
6. **Key Bind:** Right-click a pad → "KEY BIND", then press any key to reassign the trigger key.

### Auto-Mix Mode

1. Click the `MIX` button to enable Auto-Mix.
2. Songs will automatically crossfade with professional DJ effects.
3. Use the `>|` and `|<` buttons for quick 4-second mixes.
4. Customize fade durations in Settings → AUTOMIX SETTINGS.

### Save Your Session

- **Save Kit / Load Kit:** Click `SAVE KIT` / `LOAD KIT` to save or restore your sampler pad configuration (samples by path + volumes). Mic-recorded pads have no source file and are not included in kits.
- **Save Session / Load Session:** Click `SAVE SESSION` to capture everything — pads, playlist, AutoMix settings, volume/tempo/loop/mode — into a single integrity-checked `.session.json` file. `LOAD SESSION` restores it all.
- **Master Record:** Click the big `REC` button to record your entire output to WAV.

---

## 🛡️ Security & Reliability

- **Sandboxed File I/O**: The renderer process can only write files to paths returned by native OS save dialogs or to the app's `userData` directory. All file paths are validated for traversal attacks, null-byte injection, size limits, and media file types.
- **Audio Validation**: Incoming audio files are checked for valid magic-number signatures (WAV, MP3, OGG, FLAC, M4A, WebM) before decoding, preventing non-audio files from crashing the pipeline.
- **AutoMix Crash Recovery**: The AI mixer server auto-restarts on failure with backoff (max 3 attempts). Python dependencies are auto-installed via pip when the server starts (non-blocking).
- **Memory Safety**: Blob URLs are revoked with a delayed "graveyard" mechanism to prevent race conditions during rapid track skipping, and reclaimed on app exit.
- **Test Coverage**: 77 automated tests covering audio engine, player logic, settings persistence, state management, and utility functions, plus a Playwright smoke test. Run `npm run typecheck` before committing.

---

## 🛠️ DEVELOPMENT & INSTALLATION

### Prerequisites

- **Node.js**: v18+ Recommended
- **Python**: v3.10+ (Required for Sonetra AI bridge functionality)

> **Note**: Sonetra AI mixing requires a running/local Python FastAPI server (setup in `sonetra-bridge.js`). If not using AI features, you can skip the Python dependency.

### Setup

```bash
git clone https://github.com/coreyshearwater/ug-gangsta-player-pro-3.git
npm install

# (Optional) Setup Sonetra AI dependencies:
npm run setup:sonetra      # macOS/Linux
npm run setup:sonetra:win  # Windows
```

### Start Development

```bash
npm start
```

### Production Build

To generate a minified, obfuscated build:

```bash
node scripts/build.js --prod
```

To bundle into an installer:

```bash
npm run dist
```

### Testing & Typecheck

```bash
npm test        # Jest suite (77 tests across 6 files, incl. Playwright smoke)
npm run typecheck  # tsc --noEmit — esbuild does NOT typecheck; run this before committing
```

---

## 📜 LICENSE & CREDITS

**Gangsta Player Pro 3** is open-source software licensed under the **MIT License**. See the [LICENSE](LICENSE) file for full details.

### Third-Party Software

This software uses components from **Sonetra AI** (Sonetra-AI-Mixer), which is also licensed under the **MIT License**.

> Copyright (c) Sonetra AI Contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---
