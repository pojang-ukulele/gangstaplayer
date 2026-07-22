/**
 * Session Save/Load module for Gangsta Player Pro 3
 *
 * Serializes and restores the full app state:
 *   - Kit (pad samples, volumes, BPMs, sync)
 *   - Playlist (track list)
 *   - Settings (AutoMix configuration)
 *   - UI state (volume, tempo, loop mode, playback mode)
 */

import './types';
import { state, Track, LoopMode, PlaybackMode } from './state';
import { settings } from './settings';
import { toast } from './toast';
import { logger } from './logger';
import {
    padPaths,
    padVolumes,
    padBPMs,
    padSyncState,
    loadSampleFromPath,
    padBuffers,
    padWaveforms,
} from './sampler';

// ==================== SESSION INTEGRITY ====================
// Secret key for HMAC-SHA256. Generated per-session or persisted.
// In production, this should be derived from a user password or hardware token.
// For enterprise deployment, move this to a secure enclave.
let _sessionKey: CryptoKey | null = null;

const SESSION_KEY_STORAGE = 'ug_session_hmac_key';

/**
 * Generate or retrieve the crypto key used for session HMAC.
 * Uses Web Crypto API (SubtleCrypto) with SHA-256.
 */
async function getSessionKey(): Promise<CryptoKey> {
    if (_sessionKey) return _sessionKey;

    // Try to load existing key from localStorage (raw bytes base64-encoded)
    const rawKey = localStorage.getItem(SESSION_KEY_STORAGE);
    if (rawKey) {
        try {
            const keyBytes = Uint8Array.from(atob(rawKey), c => c.charCodeAt(0));
            _sessionKey = await crypto.subtle.importKey(
                'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
            );
            return _sessionKey;
        } catch (e) {
            logger.warn('[Session] Failed to restore HMAC key, generating new one');
        }
    }

    // Generate a new random HMAC key
    _sessionKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']
    );

    // Persist the key to localStorage (base64 encoded)
    const exported = await crypto.subtle.exportKey('raw', _sessionKey);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    localStorage.setItem(SESSION_KEY_STORAGE, base64);

    return _sessionKey;
}

/**
 * Compute an HMAC-SHA256 signature for session data (integrity check).
 */
async function computeHMAC(data: string): Promise<string> {
    const key = await getSessionKey();
    const enc = new TextEncoder();
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    // Convert ArrayBuffer to hex string
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Verify HMAC-SHA256 signature (returns true if signature matches).
 */
async function verifyHMAC(data: string, expectedSignature: string): Promise<boolean> {
    const actualSignature = await computeHMAC(data);
    // Constant-time comparison to prevent timing attacks
    let match = true;
    const expectedBytes = hexToBytes(expectedSignature);
    const actualBytes = hexToBytes(actualSignature);
    if (expectedBytes.length !== actualBytes.length) return false;
    for (let i = 0; i < expectedBytes.length; i++) {
        if (expectedBytes[i] !== actualBytes[i]) match = false;
    }
    return match;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

// === Types ===

interface SessionPad {
    index: number;
    path: string;
    vol: number;
    bpm?: number;
    sync?: boolean;
}

interface SessionData {
    version: number;
    name: string;
    signature?: string; // HMAC-SHA256 integrity check
    kit: {
        pads: SessionPad[];
    };
    playlist: Track[];
    settings: {
        autoMix: {
            eqCrossfade: boolean;
            filterSweep: boolean;
            hpfSweep: boolean;
            bpmSync: boolean;
            trackDuration: number;
            btnDuration: number;
        };
    };
    ui: {
        masterVolume: number;
        tempoValue: number;
        loopMode: LoopMode;
        playbackMode: PlaybackMode;
        isAutoMixEnabled: boolean;
    };
}

const SESSION_VERSION = 1;

// === Dialogs ===

async function getSavePath(): Promise<string | undefined> {
    // Use electronAPI if available (desktop), else fall back to download
    if (window.electronAPI?.saveAudioDialog) {
        const result = await window.electronAPI.saveAudioDialog();
        // saveAudioDialog returns a path — we use it for .session.json
        return result;
    }
    return undefined;
}

async function getOpenPath(): Promise<string | undefined> {
    if (window.electronAPI?.openSampleDialog) {
        return await window.electronAPI.openSampleDialog();
    }
    return undefined;
}

// === Save ===

export async function saveSession(): Promise<void> {
    try {
        // For desktop, prompt for save path
        let filePath: string | undefined;

        if (window.electronAPI?.saveKit) {
            // Reuse the save dialog — returns a file path for a JSON save
            filePath = await window.electronAPI.saveKit();
            if (!filePath) return;
            // Ensure .session.json extension
            if (!filePath.endsWith('.session.json')) {
                filePath = filePath.replace(/\.json$/, '') + '.session.json';
            }
        } else {
            toast.error("SESSION SAVE NOT AVAILABLE");
            return;
        }

        // Collect pad data
        const pads: SessionPad[] = [];
        for (let i = 0; i < 16; i++) {
            if (padPaths[i]) {
                pads.push({
                    index: i,
                    path: padPaths[i],
                    vol: padVolumes[i] ?? 0.75,
                    bpm: padBPMs[i] || undefined,
                    sync: padSyncState[i] || undefined,
                });
            }
        }

const session: SessionData = {
            version: SESSION_VERSION,
            name: "Gangsta Session",
            signature: undefined, // Will be set after HMAC computation
            kit: { pads },
            playlist: state.playlist,
            settings: {
                autoMix: {
                    eqCrossfade: settings.autoMix.eqCrossfade,
                    filterSweep: settings.autoMix.filterSweep,
                    hpfSweep: settings.autoMix.hpfSweep,
                    bpmSync: settings.autoMix.bpmSync,
                    trackDuration: settings.autoMix.trackDuration,
                    btnDuration: settings.autoMix.btnDuration,
                },
            },
            ui: {
                masterVolume: parseFloat((document.getElementById('masterVol') as HTMLInputElement)?.value || '1'),
                tempoValue: parseFloat((document.getElementById('tempoSlider') as HTMLInputElement)?.value || '1'),
                loopMode: state.loopMode,
                playbackMode: state.playbackMode,
                isAutoMixEnabled: state.isAutoMixEnabled,
            },
        };

        // Compute HMAC signature for integrity verification
        const sessionJson = JSON.stringify(session, null, 2);
        session.signature = await computeHMAC(sessionJson);

        const fs = window.fileSystem;
        if (fs?.saveFile) {
            await fs.saveFile(filePath, new TextEncoder().encode(JSON.stringify(session, null, 2)));
            toast.success("SESSION SAVED");
            logger.info(`[Session] Saved to ${filePath}`);
        }
    } catch (err) {
        logger.error('[Session] Save failed', err);
        toast.error("SESSION SAVE FAILED");
    }
}

// === Load ===

export async function loadSession(): Promise<void> {
    try {
        let filePath: string | undefined;

        if (window.electronAPI?.loadKit) {
            filePath = await window.electronAPI.loadKit();
            if (!filePath) return;
        } else {
            toast.error("SESSION LOAD NOT AVAILABLE");
            return;
        }

        const fs = window.fileSystem;
        if (!fs?.readFile) {
            toast.error("SESSION LOAD NOT AVAILABLE");
            return;
        }

        const rawData = await fs.readFile(filePath);
        const jsonStr = new TextDecoder().decode(rawData);
        const session: SessionData = JSON.parse(jsonStr);

        // Verify HMAC signature for integrity
        if (session.signature) {
            const sessionJsonWithoutSig = JSON.stringify({ ...session, signature: undefined }, null, 2);
            const isValid = await verifyHMAC(sessionJsonWithoutSig, session.signature);
            if (!isValid) {
                logger.error('[Session] HMAC verification failed - session may have been tampered with');
                toast.error("SESSION CORRUPTED - LOAD ABORTED");
                return;
            }
        } else {
            // Legacy session without signature - warn but allow loading (for backward compatibility)
            logger.warn('[Session] No HMAC signature found - loading legacy session (no integrity check)');
        }

        if (session.version !== SESSION_VERSION) {
            logger.warn(`[Session] Version mismatch: expected ${SESSION_VERSION}, got ${session.version}`);
        }

        // 1. Clear existing state
        state.update({
            playlist: [],
            selectedIndices: [],
            currentTrackIndex: -1,
            isPlaying: false,
        });

        // 2. Load playlist
        if (Array.isArray(session.playlist)) {
            state.update({ playlist: session.playlist });
        }

        // 3. Load kit
        if (session.kit?.pads && Array.isArray(session.kit.pads)) {
            // Clear existing pads
            for (let i = 0; i < 16; i++) {
                padBuffers[i] = undefined!;
                padPaths[i] = '';
                padWaveforms[i] = undefined!;
                padBPMs[i] = 0;
                padSyncState[i] = false;
            }

            // Load each pad asynchronously
            const loadPromises = session.kit.pads.map(async (p) => {
                if (p.path) {
                    await loadSampleFromPath(p.path, p.index);
                    if (p.vol !== undefined) padVolumes[p.index] = p.vol;
                    if (p.bpm !== undefined) padBPMs[p.index] = p.bpm;
                    if (p.sync !== undefined) padSyncState[p.index] = p.sync;

                    // Update the volume slider UI
                    const grid = document.getElementById('padGrid');
                    const slider = grid?.children[p.index]?.querySelector('.pad-slider') as HTMLInputElement;
                    if (slider) slider.value = (p.vol ?? 0.75).toString();
                }
            });
            await Promise.allSettled(loadPromises);
        }

        // 4. Restore settings
        if (session.settings?.autoMix) {
            const { eqCrossfade, filterSweep, hpfSweep, bpmSync, trackDuration, btnDuration } = session.settings.autoMix;
            settings.autoMix.eqCrossfade = eqCrossfade ?? true;
            settings.autoMix.filterSweep = filterSweep ?? true;
            settings.autoMix.hpfSweep = hpfSweep ?? true;
            settings.autoMix.bpmSync = bpmSync ?? false;
            settings.autoMix.trackDuration = trackDuration ?? 10;
            settings.autoMix.btnDuration = btnDuration ?? 4;
            (await import('./settings')).saveSettings();
        }

        // 5. Restore UI
        if (session.ui) {
            const volSlider = document.getElementById('masterVol') as HTMLInputElement;
            if (volSlider && session.ui.masterVolume !== undefined) {
                volSlider.value = session.ui.masterVolume.toString();
                volSlider.dispatchEvent(new Event('input'));
            }

            const tempo = document.getElementById('tempoSlider') as HTMLInputElement;
            if (tempo && session.ui.tempoValue !== undefined) {
                tempo.value = session.ui.tempoValue.toString();
                tempo.dispatchEvent(new Event('input'));
            }

            if (session.ui.loopMode) {
                state.update({ loopMode: session.ui.loopMode });
            }
            if (session.ui.playbackMode) {
                state.update({ playbackMode: session.ui.playbackMode });
            }
            if (session.ui.isAutoMixEnabled !== undefined) {
                state.update({ isAutoMixEnabled: session.ui.isAutoMixEnabled });
            }
        }

        toast.success("SESSION LOADED");
        logger.info(`[Session] Loaded from ${filePath}`);
    } catch (err) {
        logger.error('[Session] Load failed', err);
        toast.error("SESSION LOAD FAILED");
    }
}
