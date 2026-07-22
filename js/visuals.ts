// === VISUALS & LIGHTS MODULE ===
import { VISUALIZER_BARS } from './constants';
import { analyser, masterGain, audioCtx, resumeAudioContext } from './audio';
import { logger } from './logger';
import { state } from './state';
import { throttle } from './utils';
import { BASS_THRESHOLD, MID_THRESHOLD, HIGH_THRESHOLD, AVG_THRESHOLD, SCANNER_INTERVAL_MS, LED_FRAME_SKIP } from './constants';

let dataArray: Uint8Array | null = null;
if (analyser) {
    dataArray = new Uint8Array(analyser.frequencyBinCount);
}
const visualizerBars: HTMLElement[] = [];
const barColors = ['#ff0000', '#d4002b', '#aa0055', '#800080', '#990ae6', '#bc13fe', '#bc13fe', '#a030f0', '#8a50d0', '#7070b0', '#509090', '#30b070', '#20d050', '#10f030', '#39ff14', '#39ff14'];

let leds: HTMLElement[] = [];
let scannerIndex = 0;
let scannerDirection = 1;
let lastScannerUpdate = 0;

export function initVisuals(): void {
    const visualizerContainer = document.getElementById('visualizer');
    if (visualizerContainer) {
        visualizerContainer.innerHTML = '';
        for (let i = 0; i < VISUALIZER_BARS; i++) {
            const bar = document.createElement('div');
            bar.className = 'bar';
            bar.style.backgroundColor = barColors[i];
            visualizerContainer.appendChild(bar);
            visualizerBars.push(bar);
        }
    }
    
    leds = ([
        document.getElementById('l1'), document.getElementById('l2'), document.getElementById('l3'),
        document.getElementById('r1'), document.getElementById('r2'), document.getElementById('r3')
    ].filter(l => l !== null)) as HTMLElement[];
    
    setupScrews();
    
    masterLoop();
}

function setupScrews(): void {
    const screws = document.querySelectorAll<HTMLElement>('.screw');
    screws.forEach(screw => {
        let clicks = 0;
        screw.addEventListener('click', () => {
             clicks++;
              // Lefty-loosey attempts
              let rotationDir = 1;
              
              // Debugging class detection
              logger.debug("Clicked screw classes:", screw.className);
              
              if (screw.matches('.br') || screw.classList.contains('br')) {
                  logger.debug("Matches BR! Reversing direction.");
                  rotationDir = -1;
              }

              const rotation = clicks * 60 * rotationDir; 
              const lift = 1 + (clicks * 0.05); // Subtle rise
              
              screw.style.transform = `rotate(${rotation}deg) scale(${lift})`;
              
              // Visual feedback: shadow gets deeper as it comes out?
              screw.style.boxShadow = `${clicks}px ${clicks}px ${clicks+2}px rgba(0,0,0,0.5)`;

              if (clicks >= 7) {
                  if (!screw.classList.contains('dropped')) {
                      screw.classList.add('dropped');
                      // Create hole
                      const hole = document.createElement('div');
                      const posClass = Array.from(screw.classList).find(c => ['tl','tr','bl','br'].includes(c));
                      hole.className = 'screw-hole ' + (posClass || '');
                      if (screw.parentElement) screw.parentElement.insertBefore(hole, screw);
                  }
              }
          });
      });
}

const updateLEDs = throttle((dataArray: Uint8Array, leds: HTMLElement[]) => {
    let bassSum = 0, midSum = 0, highSum = 0;
    for (let i = 0; i < 5; i++) bassSum += dataArray[i];
    for (let i = 10; i < 30; i++) midSum += dataArray[i];
    for (let i = 80; i < 120; i++) highSum += dataArray[i];

    if (leds.length >= 6) {
        leds[0].classList.toggle('lit', (bassSum / 5) > BASS_THRESHOLD);
        leds[5].classList.toggle('lit', (bassSum / 5) > BASS_THRESHOLD);
        leds[1].classList.toggle('lit', (midSum / 20) > MID_THRESHOLD);
        leds[4].classList.toggle('lit', (midSum / 20) > MID_THRESHOLD);
        leds[2].classList.toggle('lit', (highSum / 40) > HIGH_THRESHOLD);
        leds[3].classList.toggle('lit', (highSum / 40) > HIGH_THRESHOLD);
    }
}, 100);

function masterLoop(): void {
    requestAnimationFrame(masterLoop);
    // Skip expensive processing when tab is hidden
    if (document.hidden) return;
    if (analyser && dataArray) analyser.getByteFrequencyData(dataArray as unknown as Uint8Array<ArrayBuffer>);
    
    let totalVol = 0;
    let totalAvg = 0;
    if (dataArray) {
        for (let i = 0; i < dataArray.length; i++) totalVol += dataArray[i];
        totalAvg = totalVol / dataArray.length;
    }
    
    // Force EQ-reactive mode when crossfade is blending (both channels are always producing audio)
    const isAudioActive = totalAvg > AVG_THRESHOLD || state.isCrossfadeInProgress;
    
    if (isAudioActive && dataArray && visualizerBars.length > 0) {
        // Only update visualizer bars every frame
        const step = Math.floor(dataArray.length / 16);
        for (let i = 0; i < 16; i++) {
            const value = dataArray[i * step];
            if (visualizerBars[i]) {
                visualizerBars[i].style.height = Math.max(5, (value / 255) * 100) + '%';
            }
        }
        
        // Update LEDs using throttled function
        updateLEDs(dataArray as Uint8Array, leds);
    } else {
        visualizerBars.forEach(bar => bar.style.height = '5%');
        const now = performance.now();
        if (now - lastScannerUpdate > SCANNER_INTERVAL_MS) {
            leds.forEach(l => l.classList.remove('lit'));
            if (scannerIndex === 0) { if(leds[0]) leds[0].classList.add('lit'); if(leds[5]) leds[5].classList.add('lit'); }
            if (scannerIndex === 1) { if(leds[1]) leds[1].classList.add('lit'); if(leds[4]) leds[4].classList.add('lit'); }
            if (scannerIndex === 2) { if(leds[2]) leds[2].classList.add('lit'); if(leds[3]) leds[3].classList.add('lit'); }
            scannerIndex += scannerDirection;
            if (scannerIndex >= 2 || scannerIndex <= 0) scannerDirection *= -1;
            lastScannerUpdate = now;
        }
    }
}


export function playStartupSound(): void {
    logger.info("[Visuals] Triggering startup sound...");
    
    resumeAudioContext().then(() => {
        const soundPath = 'assets/gun-load.wav';
        logger.info(`[Visuals] Fetching startup sound from: ${soundPath}`);
        
        // Use standard fetch + decodeAudioData for highest reliability on startup
        fetch(soundPath)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(arrayBuffer => {
                logger.debug("[Visuals] Startup sound binary loaded, decoding...");
                // Note: We use the context's native decoder here to avoid any worker-pool race conditions on boot
                return audioCtx.decodeAudioData(arrayBuffer);
            })
            .then(audioBuffer => {
                logger.info("[Visuals] Startup sound decoded, initiating playback.");
                const source = audioCtx.createBufferSource();
                const gain = audioCtx.createGain();
                source.buffer = audioBuffer;
                gain.gain.value = 0.6;
                source.connect(gain);
                gain.connect(masterGain);
                source.start(0);
                logger.info("[Visuals] Startup sound playback started.");
            })
            .catch((e: any) => {
                logger.error(`[Visuals] Startup Sound Error: ${e.message || String(e)}`);
                // Fallback for extreme cases: try playing via native Audio element (bypasses Web Audio chain)
                try {
                    const audio = new Audio(soundPath);
                    audio.volume = 0.6;
                    audio.play().catch((pErr: any) => logger.error(`[Visuals] Native Audio Fallback failed: ${pErr.message || String(pErr)}`));
                } catch (fallbackErr: any) {
                    logger.error(`[Visuals] All startup sound attempts failed: ${fallbackErr.message || String(fallbackErr)}`);
                }
            });
    }).catch(e => logger.error(`[Visuals] Audio Context Resume failed: ${e.message}`));
}

