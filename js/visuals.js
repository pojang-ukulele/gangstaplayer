// === VISUALS & LIGHTS MODULE ===
import { VISUALIZER_BARS } from './constants.js';
import { analyser, masterGain, audioCtx, resumeAudioContext } from './audio.js';

const dataArray = new Uint8Array(analyser.frequencyBinCount);
const visualizerBars = [];
const barColors = ['#ff0000', '#d4002b', '#aa0055', '#800080', '#990ae6', '#bc13fe', '#bc13fe', '#a030f0', '#8a50d0', '#7070b0', '#509090', '#30b070', '#20d050', '#10f030', '#39ff14', '#39ff14'];

let leds = [];
let scannerIndex = 0;
let scannerDirection = 1;
let lastScannerUpdate = 0;

export function initVisuals() {
    const visualizerContainer = document.getElementById('visualizer');
    if (!visualizerContainer) return;

    visualizerContainer.innerHTML = '';
    for (let i = 0; i < VISUALIZER_BARS; i++) {
        let bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.backgroundColor = barColors[i];
        visualizerContainer.appendChild(bar);
        visualizerBars.push(bar);
    }

    leds = [
        document.getElementById('l1'), document.getElementById('l2'), document.getElementById('l3'),
        document.getElementById('r1'), document.getElementById('r2'), document.getElementById('r3')
    ].filter(l => l !== null);
    
    setupScrews();

    masterLoop();
}

function setupScrews() {
    const screws = document.querySelectorAll('.screw');
    screws.forEach(screw => {
        let clicks = 0;
        screw.addEventListener('click', () => {
             clicks++;
             // Lefty-loosey attempts
             // User requested direction flip for BR
             let rotationDir = 1;
             
             // Debugging class detection
             console.log("Clicked screw classes:", screw.className);
             
             if (screw.matches('.br') || screw.classList.contains('br')) {
                 console.log("Matches BR! Reversing direction.");
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
                     hole.className = 'screw-hole ' + Array.from(screw.classList).find(c => ['tl','tr','bl','br'].includes(c));
                     if (screw.parentElement) screw.parentElement.insertBefore(hole, screw);
                 }
             }
        });
    });
}

function masterLoop() {
    requestAnimationFrame(masterLoop);
    analyser.getByteFrequencyData(dataArray);
    
    let totalVol = 0;
    for (let i = 0; i < dataArray.length; i++) totalVol += dataArray[i];
    let totalAvg = totalVol / dataArray.length;

    const BASS_THRESHOLD = 200;
    const MID_THRESHOLD = 160;
    const HIGH_THRESHOLD = 100;
    const AVG_THRESHOLD = 2;

    if (totalAvg > AVG_THRESHOLD) {
        const step = Math.floor(dataArray.length / 16);
        visualizerBars.forEach((bar, i) => {
            const value = dataArray[i * step];
            bar.style.height = Math.max(5, (value / 255) * 100) + '%';
        });

        let bassSum = 0, midSum = 0, highSum = 0;
        for (let i = 0; i < 5; i++) bassSum += dataArray[i];
        for (let i = 10; i < 30; i++) midSum += dataArray[i];
        for (let i = 80; i < 120; i++) highSum += dataArray[i];

        leds.forEach(l => l.classList.remove('lit'));
        if ((bassSum / 5) > BASS_THRESHOLD) { if(leds[0]) leds[0].classList.add('lit'); if(leds[5]) leds[5].classList.add('lit'); }
        if ((midSum / 20) > MID_THRESHOLD) { if(leds[1]) leds[1].classList.add('lit'); if(leds[4]) leds[4].classList.add('lit'); }
        if ((highSum / 40) > HIGH_THRESHOLD) { if(leds[2]) leds[2].classList.add('lit'); if(leds[3]) leds[3].classList.add('lit'); }
    } else {
        visualizerBars.forEach(bar => bar.style.height = '5%');
        const now = performance.now();
        if (now - lastScannerUpdate > 300) {
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

export function playStartupSound() {
    console.log("[Visuals] Triggering startup sound...");
    resumeAudioContext().then(() => {
        fetch('gun-load.wav')
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
            .then(audioBuffer => {
                const source = audioCtx.createBufferSource();
                const gain = audioCtx.createGain();
                source.buffer = audioBuffer;
                gain.gain.value = 0.6;
                source.connect(gain);
                gain.connect(masterGain);
                source.start(0);
            })
            .catch(e => console.error("[Visuals] Startup Sound Error:", e));
    });
}
