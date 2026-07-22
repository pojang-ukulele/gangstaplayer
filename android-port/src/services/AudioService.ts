import { Audio, AVPlaybackStatus, AVPlaybackStatusSuccess } from 'expo-av';

export type Track = {
  id: string;
  name: string;
  uri: string;
  bpm: number | null;
};

export type PlayerState = {
  isPlaying: boolean;
  currentTrackIndex: number;
  playbackRate: number;
  volume: number;
  metering: number;
};

export class Deck {
  private sound: Audio.Sound | null = null;
  private onStatusUpdate?: (status: AVPlaybackStatus) => void;

  constructor(onStatusUpdate?: (status: AVPlaybackStatus) => void) {
    this.onStatusUpdate = onStatusUpdate;
  }

  async load(uri: string, initialState: Partial<PlayerState>) {
    if (this.sound) {
      await this.sound.unloadAsync();
    }
    const { sound } = await Audio.Sound.createAsync(
      { uri },
      { 
        shouldPlay: false, 
        rate: initialState.playbackRate || 1.0,
        shouldCorrectPitch: true,
        volume: initialState.volume || 1.0,
        progressUpdateIntervalMillis: 50, // Higher frequency for visualizer
      },
      this.onStatusUpdate
    );
    this.sound = sound;
  }

  async play() {
    if (this.sound) await this.sound.playAsync();
  }

  async pause() {
    if (this.sound) await this.sound.pauseAsync();
  }

  async setRate(rate: number) {
    if (this.sound) await this.sound.setRateAsync(rate, true);
  }

  async setVolume(vol: number) {
    if (this.sound) await this.sound.setVolumeAsync(vol);
  }

  async unload() {
    if (this.sound) {
      await this.sound.unloadAsync();
      this.sound = null;
    }
  }

  async setPosition(millis: number) {
    if (this.sound) await this.sound.setPositionAsync(millis);
  }
}

class AudioService {
  private mainDeck: Deck;
  private xFadeDeck: Deck;
  private samplerPads: (Audio.Sound | null)[] = new Array(16).fill(null);
  private statusCallback?: (status: AVPlaybackStatus) => void;

  private state: PlayerState = {
    isPlaying: false,
    currentTrackIndex: -1,
    playbackRate: 1.0,
    volume: 1.0,
    metering: 0,
  };

  private static instance: AudioService;

  private constructor() {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    this.mainDeck = new Deck((status) => this.handleStatusUpdate(status));
    this.xFadeDeck = new Deck();
  }

  public static getInstance(): AudioService {
    if (!AudioService.instance) {
      AudioService.instance = new AudioService();
    }
    return AudioService.instance;
  }

  private handleStatusUpdate(status: AVPlaybackStatus) {
    if (!status.isLoaded) return;
    
    const successStatus = status as any;
    
    // Update internal state
    this.state.isPlaying = successStatus.isPlaying;
    
    // Metering logic (standardized to 0-1)
    if (successStatus.metering !== undefined) {
      // expo-av metering is typically dB (-160 to 0)
      const db = successStatus.metering;
      const normalized = Math.max(0, (db + 60) / 60); // Simple normalization
      this.state.metering = normalized;
    }

    if (this.statusCallback) {
      this.statusCallback(status);
    }
  }

  public setStatusCallback(callback: (status: AVPlaybackStatus) => void) {
    this.statusCallback = callback;
  }

  async loadTrack(uri: string) {
    await this.mainDeck.load(uri, this.state);
  }

  async play() { await this.mainDeck.play(); }
  async pause() { await this.mainDeck.pause(); }
  async setRate(rate: number) { 
    this.state.playbackRate = rate;
    await this.mainDeck.setRate(rate); 
  }
  async setVolume(vol: number) { 
    this.state.volume = vol;
    await this.mainDeck.setVolume(vol); 
  }

  async setPosition(millis: number) {
    if (this.mainDeck) await this.mainDeck.setPosition(millis);
  }

  // CROSSFADE LOGIC
  async startCrossfade(nextUri: string, durationMillis: number = 8000) {
    if (this.state.isPlaying) {
      // 1. Load next deck
      await this.xFadeDeck.load(nextUri, { ...this.state, volume: 0 });
      await this.xFadeDeck.play();

      // 2. Perform Ramps (Simulated via setInterval as expo-av lacks native volume ramps over time)
      const steps = 20;
      const stepTime = durationMillis / steps;
      let currentStep = 0;

      const interval = setInterval(async () => {
        currentStep++;
        const progress = currentStep / steps;
        
        // Main deck fades out, xFade fades in
        await this.mainDeck.setVolume(this.state.volume * (1 - progress));
        await this.xFadeDeck.setVolume(this.state.volume * progress);

        if (currentStep >= steps) {
          clearInterval(interval);
          // Promote xFade to main
          const temp = this.mainDeck;
          this.mainDeck = this.xFadeDeck;
          this.xFadeDeck = temp;
          await this.xFadeDeck.unload();
        }
      }, stepTime);
    }
  }

  // MASTER RECORDING (Limited to Mic + Internal mix simulation)
  private recorder: Audio.Recording | null = null;
  async startRecording() {
    try {
      await Audio.requestPermissionsAsync();
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      this.recorder = recording;
    } catch (err) {
      console.error('Failed to start recording', err);
    }
  }

  async stopRecording() {
    if (!this.recorder) return;
    await this.recorder.stopAndUnloadAsync();
    const uri = this.recorder.getURI();
    this.recorder = null;
    return uri;
  }

  // Sampler logic with improved cleanup and state tracking
  private padStatusCallbacks: ((index: number, status: AVPlaybackStatus) => void)[] = [];

  public setPadStatusCallback(callback: (index: number, status: AVPlaybackStatus) => void) {
    this.padStatusCallbacks.push(callback);
  }

  async loadPad(index: number, uri: string) {
    if (this.samplerPads[index]) {
      await this.samplerPads[index]!.unloadAsync();
    }
    const { sound } = await Audio.Sound.createAsync(
      { uri }, 
      { shouldPlay: false },
      (status) => {
        this.padStatusCallbacks.forEach(cb => cb(index, status));
      }
    );
    this.samplerPads[index] = sound;
  }

  async triggerPad(index: number) {
    const pad = this.samplerPads[index];
    if (pad) {
      await pad.replayAsync();
    }
  }

  async stopPad(index: number) {
    const pad = this.samplerPads[index];
    if (pad) {
      await pad.stopAsync();
    }
  }

  public getMetering() {
    return this.state.metering;
  }
}

export const audioService = AudioService.getInstance();
