# GANGSTA PLAYER PRO 3 - Changelog

All notable changes, updates, and bug fixes will be documented in this file.

---

## [2026-01-25]

### Changed
- **Replaced LOAD button on pads with right-click context menu**
  - Removed the "LOAD" button that appeared on pads after loading a sample
  - Added right-click context menu to all pads with "LOAD SAMPLE" option
  - Context menu now works on both empty and loaded pads

- **Replaced SYNC button on pads with right-click context menu**
  - Removed the "SYNC" button that appeared on pads after loading a sample
  - Added "SYNC" option to pad context menu (only visible when sample is loaded)
  - SYNC active state now shows visual indicator (red text with ✓ checkmark) in context menu
  - Context menu styling matches existing playlist right-click menu

### Improved
- Cleaner pad interface without overlay buttons
- More intuitive right-click workflow consistent with playlist controls

### Fixed
- **Resolved 50+ lint warnings in index.html**
  - Replaced all inline styles with CSS classes
  - Added accessibility attributes (title, for) to form elements and sliders
  - Added title attributes to select elements for screen reader support

- **Fixed CSS browser compatibility**
  - Added `-webkit-user-select` prefix for Safari compatibility
  - Context menus now use CSS `.hidden` class instead of inline display styles

- **Added 200+ lines of utility CSS classes** to `styles.css` for maintainability

### Code Cleanup (Phase 1 Optimization)

- **Removed ~115 lines of dead CSS** - `.sync-btn` and `.load-btn` styles no longer needed
- **Extracted constants to dedicated section** - `KEYBOARD_MAP`, `MIDI_NOTE_TO_PAD`, `BPM_DETECTION_THRESHOLD`, etc.
- **Improved code organization** in `renderer.js` with clear section headers

### Accessibility (Phase 2 Optimization)

- **Added ARIA attributes to sampler pads** - `role="button"`, `aria-label`, `aria-pressed`, `tabindex`
- **Added ARIA attributes to context menus** - `role="menu"`, `role="menuitem"`, `aria-hidden`
- **Dynamic aria-pressed toggle** on pad activation/deactivation
- **Dynamic aria-hidden toggle** when context menus show/hide

### Performance (Phase 4 Optimization)

- **Added debounce/throttle utility functions** for future slider optimization
- **Added SLIDER_DEBOUNCE_MS constant** (16ms = ~60fps)

### Module Structure (Phase 3 Optimization - COMPLETE)

- **Created `js/` module folder** with full ES module architecture:
  - `constants.js` (55 lines) - Constants, debounce/throttle utilities
  - `audio.js` (27 lines) - AudioContext, masterGain, analyser
  - `midi.js` (108 lines) - MIDI support with dependency injection
  - `sampler.js` (250 lines) - Pad creation, sample loading, playback
  - `player.js` (240 lines) - BPM detection, track player, auto-mix
  - `playlist.js` (280 lines) - Multi-select, drag-drop, context menu
  - `settings.js` (250 lines) - Device selection, preferences
  - `main.js` (240 lines) - Module orchestrator, event handlers
- **Updated `index.html`** to use ES modules (`type="module"`)
- **Legacy `renderer.js` preserved** as backup (commented out)

