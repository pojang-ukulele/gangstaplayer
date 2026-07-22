import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, Alert } from 'react-native';
import Slider from '@react-native-community/slider';
import * as DocumentPicker from 'expo-document-picker';
import { useAudio } from '../context/AudioContext';

const Pad = ({ index }: { index: number }) => {
  const { triggerPad, stopPad, loadPad, loadedPads, activePads } = useAudio();
  const isLoaded = loadedPads.includes(index);
  const isActive = activePads.includes(index);
  const [padName, setPadName] = useState<string | null>(null);

  const handlePadPress = async () => {
    if (isLoaded) {
      // Pad has audio loaded — trigger playback
      await triggerPad(index);
    } else {
      // Pad is empty — open file picker
      try {
        const result = await DocumentPicker.getDocumentAsync({
          type: 'audio/*',
          copyToCacheDirectory: true,
        });

        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          const name = asset.name || `Pad ${index + 1}`;
          setPadName(name);
          await loadPad(index, asset.uri, name);
        }
      } catch (err) {
        console.error('Failed to pick audio for pad', err);
        Alert.alert('Error', 'Failed to load audio file');
      }
    }
  };

  const handlePadRelease = async () => {
    if (isLoaded) {
      await stopPad(index);
    }
  };

  return (
    <View style={styles.padWrapper}>
      <Pressable
        style={({ pressed }) => [
          styles.pad,
          isLoaded && styles.padLoaded,
          isActive && styles.padActive,
          pressed && styles.padPressed
        ]}
        onPressIn={handlePadPress}
        onPressOut={handlePadRelease}
        delayLongPress={0}
      >
        <View style={styles.padTopRow}>
           <View style={styles.recordButton}>
              <Text style={styles.recordButtonText}>HOLD TO{'\n'}RECORD</Text>
           </View>
           <View style={styles.syncButton}>
              <Text style={styles.syncButtonText}>SYNC</Text>
           </View>
        </View>

        <View style={styles.padCenterTextContainer}>
          {isLoaded && padName ? (
            <Text style={styles.padLoadedText} numberOfLines={2}>
              {padName}
            </Text>
          ) : (
            <Text style={styles.padCenterText}>
              Tap to load audio{'\n'}or use REC
            </Text>
          )}
        </View>
      </Pressable>

      <View style={styles.sliderContainer}>
        <Slider
          style={styles.padSlider}
          minimumValue={0}
          maximumValue={1}
          value={0.8}
          minimumTrackTintColor="#555"
          maximumTrackTintColor="#222"
          thumbTintColor="#aaa"
        />
      </View>
    </View>
  );
};

const SamplerGrid = () => {
  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {/* Only 4 pads now (2x2) */}
        {Array.from({ length: 4 }).map((_, i) => (
          <Pad key={i} index={i} />
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  padWrapper: {
    width: '48%',
    marginBottom: 8,
  },
  pad: {
    aspectRatio: 1.8, // Wide and short
    backgroundColor: '#0a100c',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1a2a1c',
    padding: 6,
    justifyContent: 'space-between',
  },
  padLoaded: {
    backgroundColor: '#112211', 
    borderColor: '#2d5a2d',
  },
  padActive: {
    backgroundColor: '#1a331a',
    borderColor: '#39ff14',
    shadowColor: '#39ff14',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    elevation: 5,
  },
  padPressed: {
    opacity: 0.8,
  },
  padTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  recordButton: {
    backgroundColor: '#8b0000',
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  recordButtonText: {
    color: '#ffaaaa',
    fontSize: 6,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  syncButton: {
    backgroundColor: '#1a202c',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#2d3748',
  },
  syncButtonText: {
    color: '#a0aec0',
    fontSize: 6,
    fontWeight: 'bold',
  },
  padCenterTextContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  padCenterText: {
    color: '#1a331a',
    fontSize: 7,
    textAlign: 'center',
  },
  padLoadedText: {
    color: '#39ff14',
    fontSize: 8,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  sliderContainer: {
    marginTop: 4,
    paddingHorizontal: 5,
  },
  padSlider: {
    height: 16,
    width: '100%',
  },
});

export default SamplerGrid;
export { Pad };

