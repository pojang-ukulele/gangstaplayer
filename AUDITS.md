# Gangsta Player Pro 3 — Code Audits Report

Version: 4.20.1 | Date: 2026-09-17 | Tests: 20 suites, 150/150 passed between each audit

## 1. Electron main-process / IPC boundary — COMPLETED

Verified `main.ts:55-284,918-997`:
- `validatePath:91` only canonicalizes (normalize/resolve, null-byte + length + absolute checks). Safety correctly delegated to `isSavePathAllowed:158` / `isReadPathAllowed:271` gates.
- `fs:save-file:512` + `fs:read-file:667` + `show-item:740` have TOCTOU pinning (`open O_NOFOLLOW + fstat + realpath`), ext allowlists, ADS/UNC reject, blocked basenames (`gangsta.db*`, `config.json`, logs).
- `dialogReturnedPaths` Map with 1h TTL, LRU 64 — no bulk-wipe bug.
- Window `sandbox:true, contextIsolation:true, webSecurity:true`, `will-navigate` deny non-file, `openHandler` deny.

Gaps:
- `db:get-track:950` passes raw `trackPath` to DB with no `validatePath`/consent — DB lookup oracle.
- `validatePath` allows `..` by design, relies on callers — fragile if new handler forgets gate.
- Writes keyed lexical only, reads add realpath alias — alias confusion possible.

Tests: 150/150 passed.

## 2. Preload bridge over-exposure — COMPLETED

Verified `preload.ts:1-141`:
- 4 bridges only: `electronAPI:20`, `fileSystem:63`, `sonetra:94` (cached/precompute + `onRestartStatus`), `database:121`. No `shell`/`fs` direct, only `webUtils.getPathForFile`.
- Pre-clone caps: `cleanPath:9`, `cleanData:14` (1B–100MB), crash snapshot 256KB `:54`, `appendLog` 2000 chars, `search` 256, `upsert` 512KB.
- `getPathForFile:32` bounded to File objects with `name`, try/catch → `''`.
- `openExternal:46` pinned to `'README.md'` literal + main exact-match.
- `webPreferences` locked down.

Gaps: `database.getTrack/search/getAll` fully callable, main `db:get-track` has no consent gate (confirms Audit 1). `saveFile` relies entirely on main allowlist. `SonetraAPI` types declare start/stop/analyze not actually exposed — type/impl drift.

Tests: 150/150 passed.

## 3. Untrusted deserialization — COMPLETED

Verified `js/session.ts:395-454`, `js/utils.ts:22-141`:
- `loadSession` 25MB cap `:403`, `JSON.parse` in try→rollback, checksum verify (warn-only legacy), `version!==1` abort. Shaped-copy restore with `slice` + `clampNum` + ext gates.
- Kit load `sampler.ts:2625` has no pre-decode size cap — relies on main 100MB gate.
- `normalizeToArrayBuffer` always-copy, rejects string/array-like/resizable/detached with `INVALID_IPC_PAYLOAD`, realm `toString()` check.
- `validateAudioSignature` table + WAV `fmt/data` scan, ftyp brand gate, EBML doctype, ID3 synchsafe + inner scan — provisional `<32B` fixtures accept fake headers.

Gaps: no `__proto__` key filter (relies on shaped copy), arbitrary `path` restore → `readFile` fails closed via consent gate, `decodeAudioData` OOM bounded by 100MB/sequential+2-slot pool.

Tests: 150/150 passed.

## 4. Sonetra Python subprocess — COMPLETED

Verified `sonetra-bridge.ts:302-401,717-806`:
- `_ensureDependencies:302` fast-path import check, on fail returns manual `npm run setup:sonetra` — no auto `pip install`.
- `_resolvePythonCmd:717` order: config bare `py|python|python3` → resolved file must be python basename + inside `venv`/`python-embed` or system allowlist else reject.
- `startServer:380` 10s cooldown + `_starting` re-entry guard, `spawn` with `shell:false, windowsHide:true`, cleanEnv, `mkdtemp` cwd, 2KB log truncation, crash restart max 3 with backoff.
- `createTransition/analyzeTrack` style allowlist, `isSafeAudioPath` + 100MB/4MB caps, timeouts, retry + circuit breaker.
- Main cache: sha256 keys, 50 entries/200MB LRU, 50MB IPC cap, `inFlight` cap 2. `requirements.txt` exact pins.

Tests: 150/150 passed.

## 5. Audio resource lifecycle / DoS — COMPLETED

Verified `js/audio-engine.ts:344-413`, `js/player.ts:185-244`:
- `AudioEngine` boots cross muted, `initWorklets` 5 retries 200ms backoff, `swapChannels:399` fully sync + cancels outgoing automation + resets retired deck.
- `revokeLater:185` caps 10 pending (oldest sync-revoke), `trackBlobUrl:206` revokes prior, `getSafeUrl:217` gates 0/100MB + signature + optional verify-decode.
- Sampler `activeVoices[16]` pooled gains, `startPad` clamps rate 0.5–1.5 + beat-quant clamps, `stopPad` nulls + releases.
- Recorder 90k-block/90M-sample caps, worker BPM 90s + 30s timeout/2-strikes kill.

Gaps: blob timers leak under skip storm (bounded), `BufferSource.stop()` throw swallowed (safe via prior stop), ctx resume gesture-only, worklet fallback asymmetric, `masterLoop` perpetual rAF (hidden-paused).

Tests: 150/150 passed.

## 6. SQLite handling — COMPLETED

Verified `db-manager.ts:20-99,140-189`:
- `WAL + NORMAL + busy_timeout 5000 + foreign_keys ON`, tables `tracks/kits/settings` + indexes.
- `upsertTrack` guards id/path, lengths, ext, nullbyte/ADS/UNC + consent gate (lazy bridge + recordings/dialog). Named-params `INSERT … ON CONFLICT(path) DO UPDATE`.
- `getTrackByPath:140` `WHERE path=?`, `getAllTracks:147` int-clamped LIMIT, metadata excluded, 5000 cap.
- `searchTracks:157` slices 256, escapes `[\\%_]` with `ESCAPE`, parameterized, 200-row cap.
- `close:170` `wal_checkpoint(TRUNCATE)` + close, singleton guard, `shutdownMain` wired to quit/signals/exception.

Gaps: SQLi closed; leading `%x%` full-scan DoS possible (output capped, scan not); `get-track` unvalidated oracle + case/separator duplicates; no `saveKit/loadKit` impl despite AGENTS claim.

Tests: 150/150 passed.

## 7. Renderer injection / XSS — COMPLETED

Verified `js/playlist.ts:661-695`, `index.html:1-12`:
- No `eval`/`new Function`/`document.write`. `innerHTML=''` only for clears.
- Sole template `sampler.ts:1789` interpolates only `${safeKey}` (via `escapeAttr`) + int — filenames via `textContent`.
- Playlist rows use `li.title` + `textContent`, player/toasts/confirm/MIDI use `innerText`, settings console uses `escapeHtml:464`.
- CSP locked: `script 'self'`, `style/font 'self'`, `img self+data+blob`, `media self+blob+data`, `connect self+127.0.0.1/localhost`, `worker 'self'`, `object 'none'`, `form 'none'`. No inline scripts.

Gaps: `li.title` tooltips reflect raw filename, `escapeAttr` misses `/`, no DOMPurify — relies on textContent discipline.

Tests: 150/150 passed.

## 8. Dependencies + runtime EOL — COMPLETED

Verified `package.json:1-134`, `sonetra-requirements.txt:4-10`:
- `electron ^30.0.0` — Chromium 124, EOL Aug-2024, 2+ yrs stale, missing 2024–26 RCE fixes. Runtime minimal (`better-sqlite3 ^11`, `form-data ^4`), `overrides` for glob CVE.
- Python pins exact 2023-era, manual install only.
- `build.js` externals correct, prod = minify only (no obfuscation), `asar:true`, allowlist + `!**/*.map`, `asarUnpack` `.node` + workers, no `publish/autoUpdater` in pkg, no entitlements/notarize.
- No `.env`/keys, child env minimal, port `8765` loopback-only.

Checks: `npm test` 150/150 passed; `npm run audit` → 23 vulns (2 low, 1 moderate, 19 high, 1 critical) — `node-tar` DoS chain + `tmp` traversal, fix via `npm audit fix`.

## 9. Logging / crash-report leakage — COMPLETED

Verified `log-manager.ts:1-242`:
- Ring 1MB, file `userData/gangsta_log.txt`, level/source allowlist, strips newlines/ANSI + 2000 slice, ERROR/WARN immediate flush else 10s unref, 10MB single `.1` rotation throttled 30s.
- `generatePostMortem:146` unique filename, prune keep 10, snapshot 256KB cap, systemSpecs, logs 512KB tail, tmpdir fallback.
- Renderer 500-entry ring, sessionId prefix, INFO throttle + WARN/ERROR dedup, retry-once persist.
- Main `append-log` + `crash-report` + `get-log-path` with pre-clone guards.

Gaps: absolute paths/track names + system specs persist in logs + crash JSON (world-readable tmp pre-relocate), filename injection closed for newlines/ANSI but disk holds raw names, INFO RAM-only loss on crash, `getLogPath` leaks userData layout.

Tests: 150/150 passed.

## 10. State races — COMPLETED

Verified `js/state.ts:42-161`:
- `ReactiveStore` private `_data`, getters copy/frozen (`playlist` deep-freeze), `subscribe` unknown-key warn, `update` validates + `shallowEqual` gates + try/catch notify. In-place `track.bpm=` invisible by design.
- Crossfade `_loadTrackId` supersede + `crossfadeGen` token checked after every await + `isCrossfadeInProgress`, `play/pause` refuse while blending, `finish` guards → sync `swapChannels`, `stop` no-resurrect.
- Crash-recovery 1.5MB slot cap, v1 + 14d expiry, staging-verify→promote, restore aborts blend + ESC-cancel, autosave 30s only if dirty + `beforeunload`.
- Playlist anchor/pivot, `removeSelectedTracks` refuses while filtering, aborts crossfade first, remaps current/blend.

Gaps: `blendingIndex` vs `engine.main` skew if swap throws mid-promote; in-place mutation silent; `stopAllPads` vs `startPad` without token.

Tests: 150/150 passed.

## Priority fixes

1. `db:get-track` consent/normalize + case-normalize paths (Audits 1, 2, 6).
2. `npm audit fix` + plan Electron 30 → supported + refresh Python pins (Audit 8).
3. Kit `JSON` size cap + `__proto__` key filter (Audit 3).
4. `blendingIndex`/engine truth reconcile + track immutability lint (Audit 10).
5. Log redaction for absolute paths + restrict crash JSON perms (Audit 9).
