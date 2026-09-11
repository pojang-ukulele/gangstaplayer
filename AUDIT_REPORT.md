# Paranoid Full-Codebase Audit — Gangsta Player Pro 3

> Generated: 2026-09-11. 3 lanes: main-process / audio pipeline / renderer UI-state. All file:line verified by direct reads. No good news.

## Project functions (baseline for audit)

- Electron main (`main.ts`): window 1050x900 frameless, IPC handlers for window/dialogs/fs/sonetra/db/logging, path allowlists, rate limits, crash handlers.
- Preload (`preload.ts`): `electronAPI/fileSystem/sonetra/database` bridges.
- Renderer entry (`js/main.ts`): init order Worklets→Sampler→Player→Playlist→MIDI→Settings→Visuals, pad/control/play/loop context menus, SPACE/ENTER/arrows/pad shortcuts, first-click resume+MIDI, crash-report hooks.
- Audio: `audio-engine.ts` (2x AudioChannel + swap), `audio.ts` (AudioContext singleton + masterGain→analyser), `player.ts` (load/play/pause/stop/crossfade/modes), workers (`audio-worker` BPM+WAV, `gangsta-processor` FX, `recorder-processor` capture), `recorder-client.ts`, `worker-client.ts`.
- UI/state: `playlist.ts` (virtual scroller, DnD, SHIFT/CTRL select, BPM queue), `sampler.ts` (16 pads, SYNC, record, kits), `midi.ts` (learn, Note/CC), `session.ts` (full save/load), `crash-recovery.ts` (snapshots), `state.ts` (ReactiveStore), `settings.ts`, `visuals.ts`, `modals/toast/logger/types/reactive/ui`.
- Backend: `sonetra-bridge.ts` (Python FastAPI spawn/health/transition/analyze), `db-manager.ts` (better-sqlite3 WAL), `log-manager.ts` (ring buffer + post-mortem), `scripts/build.js` (esbuild).

---

# CRITICAL

## C1 — No `before-quit`/`will-quit`/`SIGTERM` cleanup, Darwin leaks DB + Python
`main.ts:843-854,865-873` cleanup only on `win 'close'` (`void stopServer()` fire-and-forget). Missing `before-quit/will-quit/SIGINT/SIGTERM`. Trigger: Cmd+Q / dock quit / taskkill / macOS close-then-quit. Impact: dirty SQLite WAL, orphaned `uvicorn :8765` blocks next launch, `dialogReturnedPaths` persists on `activate` re-create.

## C2 — `uncaughtException` destroys forensics before post-mortem
`main.ts:876-886` calls `logManager.close()` (`log-manager.ts:98-104` flushes + clears buffer) _then_ `generatePostMortem()` reads `getBufferContents()` (`log-manager.ts:169`) → empty logs. `generatePostMortem` does sync `readdirSync/statSync/writeFileSync` (`log-manager.ts:124-172`) with no guard — throw escapes `.catch` chain, `app.exit(1)` never reached → hung dead process.

## C3 — Renderer-triggerable arbitrary Python execution
`sonetra-bridge.ts:311-334` `_loadConfig` trusts `__dirname/config.json` (`pythonPath/sonetraPath/port`), `:657-706` `spawn()`s `pythonPath` (basename check only), `:339-363` trusts `sonetraPath` if contains `src/api/main*.py`, `:459-464` `cwd=srcPath`. `:406-418` auto-runs `scripts/setup-sonetra.js` via `process.execPath` (120s) on any `createTransition/analyzeTrack` auto-start (`:869-874,967-972`). Renderer `sonetra:create-transition` rate-limit only 2s (`main.ts:694`). Impact: user-level RCE, no checksum/prompt.

## C4 — `getDbManager()` busy-spin blocks main loop
`db-manager.ts:182-194` `while(Date.now()<end){}` up to 2s on concurrent first-use. Trigger: 2x parallel `db:*` at cold start. Impact: all IPC/dialogs frozen; compounds sync `better-sqlite3` into watchdog kill. No async mutex, no eager `whenReady` init.

## C5 — `fs:save-file` TOCTOU redirect
`main.ts:420-444` `lstatSync→realpathSync→await writeFile(validated)`. No `O_EXCL/O_NOFOLLOW`, write follows links. Trigger: swap symlink/dir between check and write. Impact: overwrite arbitrary `*.json/*.wav` outside allowlist.

## C6 — Renderer-asserted file consent, no gesture proof
`main.ts:454-470` `fs:consent-file` + `sonetra-bridge.ts:76-107` only check existence/ext/size. Trigger: compromised renderer sends any existing `*.wav/mp3/...` path. Impact: read any ≤100MB audio file + `showItemInFolder` existence probe, zero dialog. Path-keyed maps (`main.ts:140-196`, `sonetra-bridge.ts:44-53`) allow replace-between-consent-and-read.

## C7 — Closed-context rebuild drops deck, orphans master chain
`js/audio-engine.ts:98-124` rebuild recreates `<audio>` but drops `blob:` src (`106`), nulls nodes+worklet. `js/audio.ts:44-50` creates new `masterGain→analyser→destination` without disconnecting old; `audio-engine.ts:175-181` reconnects to new master. Trigger: device switch / suspend closes `AudioContext`. Impact: silent empty deck, UI lies, recorder tap (`recorder-client.ts:15` old `sourceNode`) records silence, double-output if old ctx resumes.

## C8 — Worklet never re-injected after rebuild
`js/audio-engine.ts:121,132-135` nulls `workletNode` (dead `void hadWorklet`); `js/audio.ts:112-113` only re-registers modules. Nothing recalls `initWorklets`. Impact: permanent silent FX loss, asymmetric blends (`audio-engine.ts:280-282` warns only).

## C9 — `swapChannels()` not atomic, endpoints leak
`js/audio-engine.ts:285-319` guard lives only in callers (`player.ts:499,315,715`). Cancels gains only (`289-297`), sets gain 0 but never resets EQ/LP/HP. `js/player.ts:631-633,618-624` ramps outgoing to `0.001` not 0, leaves LP 600Hz / EQ -24dB. Trigger: every automix, stale `finishCrossfade` timer, double `stopPlayback`. Impact: ghost bleed at -60dB, next life as incoming starts filtered, background-tab late timer (`655-659` wall vs audio clock) = extended double-play.

## C10 — `loadTrack` commits index before verification
`js/player.ts:322` `state.update({currentTrackIndex})` before 15s read + 15s decode (`333,373`). Failures `336-360,376-385` return without rollback. Impact: highlight + index point at dead track while old audio plays, `masterBPM` stale.

## C11 — Memory-tripling blob path + recorder flatten OOM
`js/player.ts:372,391-392` + `getSafeUrl:182,188` `slice(0)` verify copy + `slice(0)` blob copy + `Blob` → ~300MB transient for 100MB file (`constants.ts:49`), size checked after full read. `js/recorder-client.ts:131-146` `Float32Array(totalLength)` per channel + `.slice()` copy again; `MAX_SAMPLES=90M` ≈720MB stereo. Trigger: large file / 30min take. Impact: tab crash on stop; `chunks>=90000` (`34`) silently truncates.

## C12 — Worker transfer neuters reuse / copies huge
`js/worker-client.ts:168-179` copies every channel for `AudioBuffer` path (~400MB); `:183-185` transfers `ch.buffer` neutering caller. Impact: main-thread jank, second encode sees detached 0-len → `Invalid length`.

## C13 — `load()` while playing, revoke-while-buffering
`js/audio-engine.ts:239-241` bare `audio.src=url`, no `pause/load/readyState` handshake. Trigger: rapid skip (5s `revokeLater` window `player.ts:142-152`). Impact: in-flight abort, `Source Error`, old URL revoked while new element streaming.

## C14 — `unhandledrejection` → crash-report loop
`js/main.ts:770-779` calls `logger.error` + `logger.generateCrashReport` fire-and-forget. `js/logger.ts:104-115` is `async` and can reject (IPC down) → re-fires `unhandledrejection` → infinite storm.

## C15 — Playlist handlers gated behind restore prompt
`js/main.ts:521-528` `setupPlaylistHandlers()` only inside `checkAndRestore().then()`. If user never answers `showConfirm` (`crash-recovery.ts:435-446`), file-input/DnD/context-menu/mousedown-defocus never wired. Dead playlist.

## C16 — `addTracks` lost-write on concurrent adds
`js/playlist.ts:350-351,410` snapshots `[...state.playlist]`, pushes, `update`. Two rapid calls (dialog+drop, double-drop) copy same base; second overwrites first. Entries vanish while `enqueueAnalysis` survives.

## C17 — Sampler voice double-release / leak
`js/sampler.ts:752-753` `acquireGain()` null → return after `createBufferSource()` — orphaned source. `:819-831` `onended` + `:852-871` `stopPad` both `releaseGain` + null; race pushes same `GainNode` twice into `_gainPool` (`:96-98` no identity check) → double-connected on reuse.

## C18 — Session load destroys state before validation
`js/session.ts:336-341` clears `playlist/selected/current/isPlaying` after snapshot but before parsing. Rollback `:237-260` restores pads + listed keys only — `blendingIndex/isCrossfadeInProgress` stale, live `AudioChannel.src` not stopped, analysis queue cleared (`:333-335`) killing survivors. Partial `loadSampleFromPath` hang = bricked session.

## C19 — Kit schema drift = silent loss
`js/sampler.ts:1291-1293` saves `{index,path,vol}` only. `js/session.ts:163-171` saves `{index,path,vol,bpm,sync,loopStart/End}`. `js/sampler.ts:1335-1346` restores only `vol` (no clamp, no `bpm/sync/loop/waveform`), parallel fire-and-forget (OOM note in `session.ts:368` ignored here). `REC_*` skipped on save (`:1301`) but session/crash try restore by path → guaranteed fail.

---

# HIGH

- **H1 — `stopServer` resurrects after intentional stop** `sonetra-bridge.ts:752-787` leaves `isRunning=true` during kill; `:486-505` `on('close')` → `_attemptRestart()`. `restartServer():597-602` stop→start races 5s wait. Port double-spawn, infinite loop. Missing `intentionalStop` flag.
- **H2 — `taskkill /f /t` PID-reuse kill** `sonetra-bridge.ts:636-644,767-775` no `exitCode/killed` check on Win (Unix has it `:780`). Fast-exit + PID recycle → kills innocent process.
- **H3 — One dialog pick whitelists whole dir for Sonetra** `main.ts:363,667` `addAllowedAudioDir(dirname)`; `sonetra-bridge.ts:136-185` accepts any audio under dirs. Pick one sample in `~/Downloads` → all audio there readable. 64-entry cap (`:218-234`) never expires.
- **H4 — Orphaned IPC attack surface** Handled+bridged but zero call sites: `fs:save-recording` (`main.ts:533`), `fs:ensure-recordings-dir` (`524`), `sonetra:start/stop/restart/get-status/create/analyze` (`675-707`), `db:search/get-all` only via dead paths.
- **H5 — Dead DB `kits`/`settings` tables** `db-manager.ts:46-57,120-152` vs `main.ts:767-813` (tracks only) + `preload.ts:55-60` (no kit bridge). Rots, invites unsanitized 1MB JSON insert.
- **H6 — Cache unbounded clone + weak key** `main.ts:387-399,709-755` length-check + `resolve` only; `get-cached-transition` clones up to 50MB per call (`720-723`) with 250ms limit — parallel freeze/OOM. `inFlightPrecompute` never times out.
- **H7 — Logger main-thread stall + path leak** `log-manager.ts:79-93` sync I/O per ERROR/WARN + 10s flush; renderer spam 20/s (`main.ts:622-636`) → jank. `fs:get-log-path` discloses absolute `userData` (`638-640`, `log-manager.ts:110-112`). Single `.1` rotation, INFO sits in RAM 10s.
- **H8 — Master BPM never follows automix** `js/player.ts:397,427-429` set only in `loadTrack`; `startCrossfade:581-594` + `finishCrossfade:693` never update. Tempo display, SYNC rate, BPM-sync math (`590`) drift to outgoing BPM.
- **H9 — BPM-sync double-tempo + mid-blend clobber** `js/player.ts:590-591` `mainRate*(cur/nxt)` where `mainRate` already includes tempo, clamped 0.5-1.5 (2.25→1.5 wrong). `:902-903` overwrites `cross.playbackRate` mid-blend on slider input.
- **H10 — Asymmetric EQ + `setTarget` vs `linearRamp` mixing** `constants.ts:28-29` `-24/-12`; `player.ts:581-582` incoming `-24/-6`, outgoing to `-12` (`624`), incoming from `-6` (`641-642`) + LP 600Hz / HP 2000Hz → mid hole. `623,632` `setValueAtTime(.value)` after cancel (stale value); master `setTargetAtTime τ0.02` (`952`) vs linear/exponential → snaps.
- **H11 — Duration incoherence + loop-one vs AutoMix** `player.ts:613-614` clamps 0.5-60s; `788` gate `duration > trackDuration*2`; `btnDuration` same path so 0.1s lies. 60s on 70s track → never blends, falls to `ended:799-814` hard-cut. `276-281` clears `loop-one` only via `setAutoMixEnabled`; direct `setLoopMode('one')` (`220-226`) bypasses → blend fights restart.
- **H12 — Play/pause lies, un-awaited imports, NaN rate** `playTrack:721-724` true only on resolve, never false on stall; no `pause/waiting/playing` listeners. `pauseTrack:729-730` unconditional false. `resumeAudioContext` fire-and-forget (`720,525`, `audio.ts:70-82`). `906-913` `void import('./sampler')` per tempo tick → storm. `394` unclamped `parseFloat` → throw inside `loadTrack().then(playTrack)` (`812,829,875,888`) without `catch` → unhandled rejection.
- **H13 — Recorder START/STOP races, worker death cascade, BPM collapse** `recorder-client.ts:48-63` double-`start()` wipes chunks; `stop:88` vs DATA `onmessage` (`29`); `dispose:170-179` never removes handler, mid-take drops silently. `worker-client.ts:98-112` 30s timeout, `>=2` terminates + `failAllPending` → bulk queue fails at once; `postMessage` into corpse (`65`) lost. `audio-worker.ts:64-67` `minStep=0` → `i+=0` infinite/OOM; `0` for silence *and* crushed master (`71,76`), `-1`→`0` (`worker-client.ts:155`); folding `60-180` (`89-90`) wrong for <30/>210.
- **H14 — Stale `blendingIndex` + `selected/current` desync** `playlist.ts:227-229` setter only; `crash-recovery.ts:226-253` never touches `blendingIndex/isCrossfadeInProgress`; `session.ts:336-341` omits them → permanent `[MIXING IN...]` (`468-474`). `state.ts:48-49,70-75` no invariant; `session.ts:344-353` no `currentTrackIndex` adjust; `crash-recovery.ts:38-54,248-253` drops `selectedIndices`. Filtered `selectedIndices=[viewIdx]` (`680-683`) vs `ctxIndex=fullIdx` (`679,706`); `removeSelected:1052-1082` interprets view as full → wrong delete (masked only because `:1054-1057` blocks filtered removes → `ctxRemove` dead when filtered).
- **H15 — First-click `once` race, SPACE live during blend** `main.ts:798-801` `body.click once → resume+enableMIDI`. Keyboard-first never fires → suspended audio, `MIDI:OFF` forever; denied once → never retries (`midi.ts:210-221`). `main.ts:361-368` SPACE live mid-blend; `382` seek blocked but `392-413` nav forwarded; ENTER `stopPlayback` (`369-372`) with no visible `abortCrossfade` → stale timer promoted.
- **H16 — Key-bind steals + MIDI learn gaps + re-wire drops** `sampler.ts:1107-1121` swaps silently, no confirm/undo (vs MIDI `midi.ts:356-368` + `undo:290-298`). No blacklist: `space/enter/arrows/delete` strand transport; `sampler.ts:1123` + `main.ts:305-414` double-fire; `CTRL+key` (`1125-1126`) collides `CTRL+A` (`main.ts:403-406`). `midi.ts:448-455` learn only `cmd9 vel>0` + `cmd11`; vel-zero exits without feedback (`476-480`); 10s timeout (`201-206`) + open prompt (`359-367`) leaves target dangling. `midi.ts:223-234` never unwires `disconnected`; filter (`436`) accepts undefined → flood; `237-277` falls back to `all`.
- **H17 — Recording strands mic** `sampler.ts:1149-1231` `__pending__` + `__cancel_*` 15s TTL (`1241`); double `startRecording` early-return (`1150`) leaves `__pending__` forever if `getUserMedia` hangs. `stopAllRecordings:1250-1269` skips `__cancel_*`, deletes `__pending__` without stopping `stream`. `onstop` decode fail (`1209-1211`) leaves stale buffers, no `ug:dataChanged`.

---

# MEDIUM

- **M1 `validatePath()` permits `..` (`main.ts:72-84`)**. Case-folds both sides (`sonetra-bridge.ts:59-68`) — breaks Linux. Missing canonical `realpath` compare.
- **M2 Save allowlist 64-LRU/1h TTL, no consume** (`main.ts:38-63,97-131`). One save → 1h overwrite window for any `*.json/*.wav`; LRU flushes approval. `SAVE_BLOCKED_BASENAMES` only 4 names — `gangsta.db-journal`, `config.json`, `*.node` overwritable. ADS/UNC regex (`102-103`) misses `//server/share`.
- **M3 Double-`realpath` fallback + post-read race** (`main.ts:486-522,591-619`). Grow past 100MB between `stat` and read; `showItemInFolder` no cap, leaks existence. Missing `open+fstat+read` on fd.
- **M4 Sonetra HTTP `localhost` no auth, health race** (`sonetra-bridge.ts:247-248,731-747`, `:507-544` `unref`d timers → orphan). `analyzeTrack` (`960-1043`) bypasses breaker. Filenames unsanitized.
- **M5 Status fan-out no backpressure** (`main.ts:758-763` single window; `sonetra-bridge.ts:267-282` never unregistered → duplicates; `preload.ts:46-52` double-subscribe unchecked `main.ts:536`).
- **M6 Build divergence** (`scripts/build.js:33-42,56-69` externals must mirror `package.json:76-112` — drift = packaged-only crash, warns only `:246`). `filesToCopy:129-136` omits `config.json` → dead packaged; omits `Sonetra-AI-Mixer-main` → `_findSonetraPath:339-363` null → AI dead.
- **M7 `ensureNodes` copies dead blob** (`audio-engine.ts:162` without blob check vs `106`). `revokeLater` between → revoked URL. Trigger: double-bind throw (`153-172`).
- **M8 `initWorklet` swallows race, `reset()` leaves automation** (`audio-engine.ts:198-214` warn only; retry `:270-279` insufficient on `file://`. `reset():217-220` early-return; worklet state (`gangsta-processor.ts:42-45`) never reset; `muteCrossfade:260-263` untracked).
- **M9 `stopPlayback` throw + leak, `abortCrossfade` snaps deck** (`player.ts:740` unguarded `currentTime=0`; `742` sync-kill then double-revoke `750-753`; main blob never revoked. `abortCrossfade:468-471` `main.reset()` mid-play even when idle.)
- **M10 Element listener leak on rebuild** (`player.ts:777-778` `__ugWired` + `771` `onReplaced`; old `timeupdate/ended/loadedmetadata` retained forever. Double-`onReplaced` orphans element.)
- **M11 `getSafeUrl` vs `loadTrack` divergent validation** (`player.ts:165-194` `verifyDecode` only crossfade path; `trackId` dropped `167` → cache miss → re-read, TOCTOU `327-329` claims to fix).
- **M12 Recorder WAV rate-lock warn-only, processor glitches** (`recorder-client.ts:153-159` no resample; `:125` drops blocks. `gangsta-processor:54-59` ignores ch>0 mismatch; `79` `chanIn[-1]` when `n=0`; `134,140-143` NaN repeats quantum. Bypass `69-71` requires both target+smoothed. `recorder-processor:66-79` copies every quantum, idle CPU; `flush:48-63` assumes uniform length.)
- **M13 Analyser single-point-of-failure** (`audio.ts:48-49` serial chain; `fftSize=256` no validation. Recorder tap unknown.)
- **M14 ReactiveStore shallow trap + globals persist** (`state.ts:162-164,206-214` in-place `track.bpm` invisible. `subscribe:121-135` never auto-unsub except playlist `171-172`, sampler `1094`, MIDI `141-151,195`; `anchor/pivot/press/selectDragging` globals persist after `vScroller` destroy `72,217`.)
- **M15 VirtualScroller stale-row / filtered-index** (`reactive/ui.ts:90-153` reuses nodes; `mousedown pressWasSelected` (`playlist.ts:504`) reads full list while `idx` view-relative → misclassified. `focusPlayingTrack` scrolls view idx (`762`) while `currentTrackIndex` full → exit-filter jumps.)
- **M16 BPM storm / duplicate queue** (`playlist.ts:238,251-261` 2 concurrent + 256 cap, but `reanalyze:776-786` no clear → duplicates; DB-hit writes `duration:0` (`270-275`); miss decodes full file (`309`) — huge FLAC OOMs.)
- **M17 Session vs snapshot schema mismatch + rotation lie** (`SessionData:107-133` vs `CrashSnapshot:38-54`. Quota 1.5MB/slot (`81`) vs drops `>1.5MB` (`97`); keeps live+`_1`+staging (+legacy `_2`) but prompt says “max 3”; `clearSnapshots:213-224` purges all on success (`354`) and discard (`442`).)
- **M18 Restore-while-playing** (`restoreSnapshot:226-370` never pauses/aborts vs `clearPlaylist:795-801`. 8s/pad + 60s budget (`300-314`) while old track plays; index points into new list while audio is old.)
- **M19 Settings validation gaps** (`loadSettings:108-151` no device check; `saveSettings:195-244` blind clone drops future keys. HTML `max 20/8` (`index.html:256,264`) vs code `60/30` (`settings.ts:160-161,441`); `restoreDefaults:319-344` misses UI selects/vol/tempo/fullscreen.)
- **M20 Visuals/modal/toast/logger** (`visuals.ts:158-218` 60fps idle scanner `205-216`; minimized still pumps FFT + `slice` (`199-203`, sum `172-175`). `analyser` null → DOM write every frame. `modals.ts:74-88` `(modal as any)`; `showConfirm:143-188` overwrites `onclick` — click-outside (`settings.ts:89-99`) bypasses `close()` → `_confirmOpen` stuck → wedged. `toast.ts:34-102` cap 6 + dedup `40-66` false-dedups legit `(x2)`. `logger.ts:179-230` throttles swallow bursts; `catch(()=>undefined)` hides quota; `DEBUG` never persisted; `104-115` re-enters throttle.)
- **M21 Context-menu dead/overlap** (`main.ts:130-131,281` MIDI-learn hidden when `!isMidiActive`; false until first device (`midi.ts:271`). Play `607-631` / loop `653-677` don't hide control/loop/sampler → overlapping. `playlist.ts:1224-1239` 150ms hide races `main.ts:710-738` global hide.)

---

# LOW

- **L1 Rate-limiter eviction + un-limited keys** (`main.ts:266-278` 64-LRU; `281-289` un-limited → flicker; `db:upsert/get-all` un-limited → grind.)
- **L2 `app:open-external` search-path** (`main.ts:291-314` `%PATH%` `notepad.exe`, fallback `shell.openPath` hijackable. Missing `C:\\Windows\\System32\\notepad.exe`.)
- **L3 Crash snapshot double-JSON** (`main.ts:642-655` + `log-manager.ts:133-139` counts 256KB twice, BigInt/circular → null. `appState` string (`168`) → double-parse.)
- **L4 `db:upsert/get` no path validation, cap mismatch** (`main.ts:767-789` raw path; `db-manager.ts:65-101` length/type only. `LIMIT 5000` (`110-117`) vs 1000 (`155-167`) untested. `undefined` vs `null` inconsistent.)
- **L5 Rejection burst never exits** (`main.ts:891-911` ≥50/min only writes report, limps on corrupted state; `885` always `exit(1)`.)
- **L6 Magic-number gaps** (`utils.ts:63-83,91-148`: `0xFF Ex` false-accepts JPEG; `m4a:78` any `ftyp`; `webm:80` any EBML; strict `fLaC` rejects ID3-FLAC; no RIFX/RF64/AIFF; `hasId3:126-130` accepts ID3+anything. `fileName` never passed (`player.ts:176,355`).)
- **L7 Normalize slow-path + masking** (`utils.ts:37-51` element-wise copy, 100M iters; resizable `slice(0)` throw; catch → `null` masks bugs (`player.ts:130-135`).)
- **L8 Dead code / drift** (`audio-engine.ts:132-135`; `player.ts:950-951` `__ugAudioCtx`; `worker-client.ts:155` `-1→0`; `audio-worker.ts:55-56` dup `constants.ts:7-10`; `player.ts:582` `-6` vs `-12`; `blendingIndex` never `state.update`; no `Disposable` use despite `utils.ts:157-198` — `revokeLater/muteCrossfade/withLoadStepTimeout:53-64` detached decode + `droppedAudioFiles` `37-39` 10GB retained.)
- **L9 `types.ts` lies + 37 `as any`** (`types.ts:57-62` non-optional yet `?.`/`try` everywhere (`main.ts:167,454,536`, `playlist.ts:86,119`). `getMissingBridges:68-74` skips `sonetra`; `playlist.ts:388` casts. Hits: `midi.ts:399,402`, `player.ts:570,777-778,909,950`, `main.ts:535,544`, `modals.ts:74-75`, `settings.ts:158`, `sampler.ts:1154,1174-75,1235,1240-41,1256-59`, `toast.ts:50-101`, `visuals.ts:94-95`, `state.ts:161,167,178`, `utils.ts:219`.)
- **L10 Tests: zero coverage on critical paths, mocked-wrong** (No tests for playlist VirtualScroller/DnD/anchor/reorder/clear, sampler SYNC/pool/`getUserMedia` fail, crash rotation/quota/staging, session checksum/version, modals trap/queue, visuals rAF/hidden, toast overflow/dedup, logger throttle, settings clamp/merge. `session.test.ts:34-98` never calls real save/load; fake `version:'4.20.1', padStates[]` vs real `version:1:number, pads:Record`. `midi.test.ts:12-95` never touches `getMIDIMessage/handleMidiLearn`. `settings.test.ts:159-161` via `updateSettings` not `loadSettings`. `state.test.ts:96-107` never tests in-place mutation invisibility. `smoke.test.js:58-168` happy-path only.)
