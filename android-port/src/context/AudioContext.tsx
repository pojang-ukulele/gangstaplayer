import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { audioService, PlayerState, Track } from '../services/AudioService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AVPlaybackStatus, AVPlaybackStatusSuccess } from 'expo-av';

interface AudioContextType {
  isPlaying: boolean;
  currentTrackIndex: number;
  playlist: Track[];
  playbackRate: number;
  volume: number;
  metering: number;
  loadedPads: number[];
  activePads: number[];
  isLooping: boolean;
  togglePlay: () => Promise<void>;
  stop: () => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
  loadTrack: (index: number) => Promise<void>;
  nextTrack: () => Promise<void>;
  prevTrack: () => Promise<void>;
  toggleLoop: () => void;
  addTracks: (tracks: Track[]) => Promise<void>;
  removeTrack: (id: string) => void;
  loadPad: (index: number, uri: string, name: string) => Promise<void>;
  triggerPad: (index: number) => Promise<void>;
  stopPad: (index: number) => Promise<void>;
  startCrossfade: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | undefined>;
}

const AudioContext = createContext<AudioContextType | undefined>(undefined);

const STORAGE_KEY_PLAYLIST = '@gpp3_playlist';

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(-1);
  const [playlist, setPlaylist] = useState<Track[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [metering, setMetering] = useState(0);
  const [loadedPads, setLoadedPads] = useState<number[]>([]);
  const [activePads, setActivePads] = useState<number[]>([]);
  const [isLooping, setIsLooping] = useState(false);

  // Initialization & Persistence
  useEffect(() => {
    const loadPersistedData = async () => {
      try {
        const savedPlaylist = await AsyncStorage.getItem(STORAGE_KEY_PLAYLIST);
        if (savedPlaylist) {
          setPlaylist(JSON.parse(savedPlaylist));
        }
      } catch (e) {
        console.warn('Failed to load playlist', e);
      }
    };
    loadPersistedData();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY_PLAYLIST, JSON.stringify(playlist));
  }, [playlist]);

  // Audio Service Listener
  useEffect(() => {
    audioService.setStatusCallback((status: AVPlaybackStatus) => {
      if (status.isLoaded) {
        const successStatus = status as any; // Cast to any to access metering safely in this environment
        setIsPlaying(successStatus.isPlaying);
        
        if (successStatus.didJustFinish && !successStatus.isLooping) {
            // Check for loop state
            if (isLooping) {
                audioService.play();
            } else {
                // Autoplay next logic could go here, or handled by current behavior
            }
        }

        if (successStatus.metering !== undefined) {
          const db = successStatus.metering;
          const level = Math.max(0, (db + 60) / 60);
          setMetering(level);
        }
      }
    });

    audioService.setPadStatusCallback((index, status) => {
      if (status.isLoaded) {
        setLoadedPads(prev => prev.includes(index) ? prev : [...prev, index]);
        const successStatus = status as AVPlaybackStatusSuccess;
        if (successStatus.isPlaying) {
          setActivePads(prev => prev.includes(index) ? prev : [...prev, index]);
        } else {
          setActivePads(prev => prev.filter(i => i !== index));
        }
      }
    });
  }, [isLooping]);

  const addTracks = async (newTracks: Track[]) => {
    setPlaylist((prev: Track[]) => [...prev, ...newTracks]);
  };

  const removeTrack = (id: string) => {
    setPlaylist((prev: Track[]) => prev.filter((t: Track) => t.id !== id));
  };

  const togglePlay = async () => {
    if (isPlaying) {
      await audioService.pause();
    } else {
      await audioService.play();
    }
  };

  const stop = async () => {
    await audioService.pause();
    await audioService.setPosition(0);
  };

  const setRate = async (rate: number) => {
    await audioService.setRate(rate);
    setPlaybackRate(rate);
  };

  const setVolumeLevel = async (vol: number) => {
    await audioService.setVolume(vol);
    setVolume(vol);
  };

  const loadTrack = async (index: number) => {
    if (playlist[index]) {
      await audioService.loadTrack(playlist[index].uri);
      setCurrentTrackIndex(index);
      await audioService.play();
    }
  };

  const nextTrack = async () => {
    if (playlist.length === 0) return;
    const nextIdx = (currentTrackIndex + 1) % playlist.length;
    await loadTrack(nextIdx);
  };

  const prevTrack = async () => {
    if (playlist.length === 0) return;
    const prevIdx = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    await loadTrack(prevIdx);
  };

  const toggleLoop = () => {
    const newState = !isLooping;
    setIsLooping(newState);
    // Note: Deck.load sets shouldCorrectPitch: true, we might want to tell audioService about loop too
  };

  const loadPad = async (index: number, uri: string, name: string) => {
    await audioService.loadPad(index, uri);
    setLoadedPads(prev => prev.includes(index) ? prev : [...prev, index]);
  };

  const startCrossfade = async () => {
    const nextIndex = (currentTrackIndex + 1) % playlist.length;
    if (playlist[nextIndex]) {
      await audioService.startCrossfade(playlist[nextIndex].uri);
      setCurrentTrackIndex(nextIndex);
    }
  };

  return (
    <AudioContext.Provider value={{
      isPlaying,
      currentTrackIndex,
      playlist,
      playbackRate,
      volume,
      metering,
      loadedPads,
      activePads,
      isLooping,
      togglePlay,
      setRate,
      setVolume: setVolumeLevel,
      loadTrack,
      nextTrack,
      prevTrack,
      toggleLoop,
      addTracks,
      removeTrack,
      loadPad,
      triggerPad: (i: number) => audioService.triggerPad(i),
      stopPad: (i: number) => audioService.stopPad(i),
      startCrossfade,
      startRecording: () => audioService.startRecording(),
      stopRecording: async () => {
        const uri = await audioService.stopRecording();
        return uri || undefined;
      },
      stop, // Added stop to match context
    } as any}>
      {children}
    </AudioContext.Provider>
  );
};

export const useAudio = () => {
  const context = useContext(AudioContext);
  if (!context) throw new Error('useAudio must be used within an AudioProvider');
  return context;
};
