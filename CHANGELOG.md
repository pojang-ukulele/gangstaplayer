# CHANGELOG

## [v3.1.0] - 2026-01-26 - "The Physics & Flow Update"

### 🔥 New Features
- **Pro Auto-Mix Engine**: Completely rewritten mixing logic.
    - **Balanced Crossfades**: Replaced exponential dips with Linear Power fades for punchy, constant-energy transitions.
    - **Zero-Latency Handoff**: New audio object swapping removes the tiny gap between tracks.
    - **Live Settings**: Toggling EQ/Filter effects works instantly during playback.
- **Magnetic Sliders**:
    - **Tempo Slider** snaps to 100% (1.0x) speed.
    - **Pad Vol Sliders** snap to Default (75%) level.

### 💅 UI/UX Improvements
- **Pad Tooltips**: Context-aware help text ("Click to Load" vs "Right-Click for Options").
- **Pad Typography**: Increased number font size for better visibility.
- **Filename Display**: Loaded pads now show the sample name at the bottom in a sleek, smaller font.
- **Visual Feedback**: Real-time time display updates while scrubbing the timeline.

### 🐛 Bug Fixes
- Fixed "blasting" volume distortion by correcting crossfade summing curves.
- Fixed small audio glitch at end of Auto-Mix.

---