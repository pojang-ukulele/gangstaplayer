import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import Slider from '@react-native-community/slider';
import * as DocumentPicker from 'expo-document-picker';
import { useAudio } from '../context/AudioContext';

const PlayerControls = () => {
  const { 
    isPlaying, togglePlay, stop, 
    playbackRate, setRate, 
    volume, setVolume, 
    startCrossfade, nextTrack, prevTrack,
    playlist, currentTrackIndex, addTracks, loadTrack,
  } = useAudio();

  const pickFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const newTracks = result.assets.map(asset => ({
          id: Math.random().toString(36).substr(2, 9),
          name: asset.name,
          uri: asset.uri,
          bpm: null,
        }));
        await addTracks(newTracks);
      }
    } catch (err) {
      console.error('Failed to pick audio files', err);
    }
  };

  // Get current track name
  const currentTrack = playlist[currentTrackIndex];
  const displayText = currentTrack ? currentTrack.name : 'INSERT TAPE...';

  return (
    <View style={styles.container}>
      
      {/* Tape Deck Container */}
      <View style={styles.tapeDeckBorder}>

        {/* Seek Bar */}
        <View style={styles.seekRow}>
          <Text style={styles.timeText}>0:00</Text>
          <Slider
            style={styles.seekSlider}
            minimumValue={0}
            maximumValue={1}
            value={0}
            minimumTrackTintColor="#39ff14"
            maximumTrackTintColor="#333"
            thumbTintColor="#39ff14"
          />
          <Text style={styles.timeText}>0:00</Text>
        </View>

        {/* Transport Row */}
        <View style={styles.transportRow}>
          <TouchableOpacity onPress={prevTrack} style={styles.transportBtn}>
            <Text style={styles.transportBtnText}>{'|<'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={togglePlay} style={styles.transportBtn}>
            <Text style={styles.transportBtnText}>{isPlaying ? 'PAUSE' : 'PLAY'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={startCrossfade} style={styles.transportBtn}>
             <Text style={styles.transportBtnText}>MIX</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={stop} style={styles.transportBtn}>
            <Text style={styles.transportBtnText}>STOP</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={nextTrack} style={styles.transportBtn}>
            <Text style={styles.transportBtnText}>{'>|'}</Text>
          </TouchableOpacity>
        </View>

        {/* Master Volume */}
        <View style={styles.sliderSection}>
          <Slider
            style={styles.wideSlider}
            minimumValue={0}
            maximumValue={1}
            value={volume}
            onSlidingComplete={setVolume}
            minimumTrackTintColor="#242424"
            maximumTrackTintColor="#333"
            thumbTintColor="#ccc"
          />
          <View style={styles.sliderLabelRow}>
             <Text style={[styles.sliderLabelTop, { textAlign: 'center', width: '100%', position: 'absolute' }]}>VOLUME</Text>
          </View>
        </View>

        {/* Chopper and Screwer */}
        <View style={styles.effectsSection}>
           <View style={styles.effectsTextRow}>
             <Text style={styles.effectsTitle}>CHOPPER AND SCREWER</Text>
             <View style={styles.effectsSwitch}>
               <Text style={styles.effectsSwitchText}>---</Text>
             </View>
             <Text style={styles.effectsValue}>{playbackRate.toFixed(2)}x</Text>
           </View>
           <Slider
            style={styles.wideSlider}
            minimumValue={0.5}
            maximumValue={2.0}
            value={playbackRate}
            onSlidingComplete={setRate}
            minimumTrackTintColor="#242424"
            maximumTrackTintColor="#333"
            thumbTintColor="#ccc"
          />
        </View>

      </View>

      {/* Playlist Section */}
      <View style={styles.playlistSection}>
        <View style={styles.playlistHeader}>
          <Text style={styles.playlistTitle}>TAPE DECK</Text>
          <TouchableOpacity onPress={pickFiles} style={styles.insertTapeBtn}>
            <Text style={styles.insertTapeBtnText}>[+] INSERT TAPE</Text>
          </TouchableOpacity>
        </View>

        {playlist.length === 0 ? (
          <TouchableOpacity onPress={pickFiles} style={styles.emptyPlaylist}>
            <Text style={styles.emptyPlaylistText}>No tapes loaded — tap to insert</Text>
          </TouchableOpacity>
        ) : (
          playlist.map((track, index) => (
            <TouchableOpacity
              key={track.id}
              onPress={() => loadTrack(index)}
              style={[
                styles.trackItem,
                index === currentTrackIndex && styles.trackItemActive,
              ]}
            >
              <Text style={styles.trackNumber}>{(index + 1).toString().padStart(2, '0')}</Text>
              <Text 
                style={[
                  styles.trackName,
                  index === currentTrackIndex && styles.trackNameActive,
                ]} 
                numberOfLines={1}
              >
                {track.name}
              </Text>
              {index === currentTrackIndex && (
                <Text style={styles.trackPlaying}>{isPlaying ? '▶' : '❚❚'}</Text>
              )}
            </TouchableOpacity>
          ))
        )}
      </View>

    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    paddingBottom: 20,
  },
  tapeDeckBorder: {
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 10,
  },
  tapeScreenContainer: {
    backgroundColor: '#051505',
    borderWidth: 1,
    borderColor: '#1a331a',
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
    shadowColor: '#39ff14',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 2,
  },
  tapeScreenText: {
    color: '#39ff14',
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  rainbowStrip: {
    flexDirection: 'row',
    height: 2,
    marginBottom: 15,
  },
  rainbowSegment: {
    flex: 1,
  },
  seekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  timeText: {
    color: '#39ff14',
    fontSize: 12,
    width: 35,
    textAlign: 'center',
  },
  seekSlider: {
    flex: 1,
    height: 30,
    marginHorizontal: 5,
  },
  transportRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  transportBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#2d5a2d',
    paddingVertical: 6,
    marginHorizontal: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#081408',
  },
  transportBtnText: {
    color: '#39ff14',
    fontSize: 9,
    fontWeight: 'bold',
  },
  sliderSection: {
    marginBottom: 15,
    justifyContent: 'center',
  },
  wideSlider: {
    height: 30,
    width: '100%',
  },
  sliderLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 15,
  },
  sliderLabelTop: {
    color: '#2d5a2d',
    fontSize: 9,
    fontWeight: 'bold',
  },
  effectsSection: {
    marginBottom: 5,
  },
  effectsTextRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 0,
  },
  effectsTitle: {
    color: '#a030f0',
    fontSize: 10,
    fontWeight: 'bold',
    flex: 1,
  },
  effectsSwitch: {
    backgroundColor: '#1a0a2a',
    borderWidth: 1,
    borderColor: '#3a1a5a',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  effectsSwitchText: {
    color: '#8a50d0',
    fontSize: 10,
  },
  effectsValue: {
    color: '#a030f0',
    fontSize: 10,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'right',
  },
  // Playlist section styles
  playlistSection: {
    marginTop: 15,
    borderWidth: 1,
    borderColor: '#1a331a',
    backgroundColor: '#0a0a0a',
    borderRadius: 6,
  },
  playlistHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a331a',
  },
  playlistTitle: {
    color: '#39ff14',
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  insertTapeBtn: {
    borderWidth: 1,
    borderColor: '#2d5a2d',
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: '#081408',
  },
  insertTapeBtnText: {
    color: '#39ff14',
    fontSize: 9,
    fontWeight: 'bold',
  },
  emptyPlaylist: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyPlaylistText: {
    color: '#333',
    fontSize: 11,
    fontStyle: 'italic',
  },
  trackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#111',
  },
  trackItemActive: {
    backgroundColor: '#0a1a0a',
    borderLeftWidth: 2,
    borderLeftColor: '#39ff14',
  },
  trackNumber: {
    color: '#333',
    fontSize: 10,
    fontWeight: 'bold',
    width: 22,
  },
  trackName: {
    color: '#888',
    fontSize: 12,
    flex: 1,
    marginLeft: 6,
  },
  trackNameActive: {
    color: '#39ff14',
    fontWeight: 'bold',
  },
  trackPlaying: {
    color: '#39ff14',
    fontSize: 10,
    marginLeft: 8,
  },
});

export default PlayerControls;
