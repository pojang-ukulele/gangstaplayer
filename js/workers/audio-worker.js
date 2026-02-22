/**
 * Audio Processing Worker for Gangsta Player Pro 3
 * Handles high-latency tasks like BPM detection and WAV encoding
 */

self.onmessage = function(e) {
    const { type, payload, id } = e.data;

    switch (type) {
        case 'DETECT_BPM':
            const bpm = detectBPM(payload.data, payload.sampleRate);
            self.postMessage({ type: 'BPM_RESULT', bpm, id });
            break;
        case 'BUFFER_TO_WAVE':
            const waveBlob = bufferToWave(payload.buffer, payload.len);
            self.postMessage({ type: 'WAVE_RESULT', blob: waveBlob, id });
            break;
    }
};

function detectBPM(data, sampleRate) {
    const BPM_DETECTION_THRESHOLD = 0.1;
    const BPM_MIN_STEP_SECONDS = 0.3;
    
    const peaks = [];
    const minStep = Math.floor(BPM_MIN_STEP_SECONDS * sampleRate);
    
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > BPM_DETECTION_THRESHOLD) {
            peaks.push(i);
            i += minStep;
        }
    }
    
    if (peaks.length < 2) return 0;
    
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i] - peaks[i - 1]);
    }
    
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpmValue = (sampleRate * 60) / avgInterval;
    
    return (bpmValue < 60 || bpmValue > 200) ? 0 : Math.round(bpmValue);
}

function bufferToWave(abuffer, len) {
    const numOfChan = abuffer.numberOfChannels;
    const totalLength = len * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const channels = abuffer.channels;
    let i;
    let sample;
    let offset = 0;
    let pos = 0;

    function setUint16(data) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data) {
        view.setUint32(pos, data, true);
        pos += 4;
    }

    // write WAVE header
    setUint32(0x46464952);                         // "RIFF"
    setUint32(totalLength - 8);                         // file length - 8
    setUint32(0x45564157);                         // "WAVE"

    setUint32(0x20746d66);                         // "fmt " chunk
    setUint32(16);                                 // length = 16
    setUint16(1);                                  // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2);                      // block-align
    setUint16(16);                                 // 16-bit (hardcoded)

    setUint32(0x61746164);                         // "data" - chunk
    setUint32(totalLength - pos - 4);                   // chunk length

    // write interleaved data
    while (pos < totalLength) {
        for (i = 0; i < numOfChan; i++) {             // interleave channels
            sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
            sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF); // scale to 16-bit signed int
            view.setInt16(pos, sample, true);          // write 16-bit sample
            pos += 2;
        }
        offset++;                                     // next sample
    }

    return new Blob([buffer], { type: "audio/wav" });
}
