# GANGSTA PLAYER PRO

![Main Interface Placeholder](https://via.placeholder.com/800x450?text=Gangsta+Player+Pro+Main+UI)
![Sampler Pads View](https://via.placeholder.com/400x300?text=16-Pad+Sampler+View)
![Settings Panel](https://via.placeholder.com/400x300?text=Settings+&+Customization)
*The ultimate ghetto-tech sampler for the streets.*

## 💀 ABOUT DA SOFTWARE

This is the ultimate **ghetto-tech sampler and tape deck** for the streets. **Gangsta Player Pro 3** turns your PC into a beat-making, chopper-screwing powerhouse. Whether you're laying down tracks or just slowing down the classics, this tool has the grit you need. It also works flawlessly as a basic music audio player for your daily listening.

---

## 🔥 FEATURES

### 🎹 16-PAD SAMPLER

- **Drag & Drop:** Drop any audio file onto a pad to load it.
- **Right-Click Menu:** Right-click any pad to load samples or enable sync.
- **Keyboard Mapped:** Play pads with your keyboard (1-4, Q-R, A-F, Z-V).
- **MIDI Support:** Plug in your MIDI controller and start finger drumming instantly.
- **Pad Recording:** Hold `CTRL + Pad Key` or click the small [REC] button to record directly from your mic.
- **Sync Mode:** Right-click a loaded pad and select SYNC to match its tempo to the master track.

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
- **Customizable:** Open Settings (`⚙️`) to toggle effects and customize fade durations.

### 🎙️ STUDIO RECORDING

- **Master Rec:** Hit the big RED button to record your **entire performance** (beats + music) to a high-quality `.wav` file.
- **Visualizer:** 16-band frequency analyzer with "Scanner" LED rack.

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
| **Delete Selected Track(s)** | `DELETE` |

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

1. **Load a Sample:** Right-click any pad and select "LOAD SAMPLE", or drag & drop an audio file onto it.
2. **Play:** Press the corresponding key (`1-4`, `Q-R`, `A-F`, `Z-V`) or click/hold the pad.
3. **Record:** Hold `CTRL` + pad key or click the [REC] button on a pad to record from your mic.
4. **Sync:** Right-click a loaded pad and select "SYNC" to match its tempo to the master track. A checkmark (✓) indicates SYNC is active.

### Auto-Mix Mode

1. Click the `MIX` button to enable Auto-Mix.
2. Songs will automatically crossfade with professional DJ effects.
3. Use the `>|` and `|<` buttons for quick 4-second mixes.
4. Customize fade durations in Settings → AUTOMIX SETTINGS.

### Save Your Session

- **Save Kit:** Click `SAVE KIT` to save your sampler pad configuration.
- **Load Kit:** Click `LOAD KIT` to restore a saved configuration.
- **Master Record:** Click the big `REC` button to record your entire output to WAV.

---

## 🛠️ DEVELOPMENT & INSTALLATION

### Prerequisites

- **Node.js**: v18+ Recommended
- **Python**: v3.10+ (Required for Sonetra AI bridge functionality)

> **Note**: Sonetra AI mixing requires a running/local Python FastAPI server (setup in `sonetra-bridge.js`). If not using AI features, you can skip the Python dependency.

### Setup

1. `git clone https://github.com/coreyshearwater/gangstaplayer-mod.git`
2. `npm install`
3. `npm start`

### Production Build

To generate a minified, obfuscated build:
`node scripts/build.js`

To bundle into an installer:
`npm run dist`

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
