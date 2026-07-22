import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity, FlatList } from 'react-native';
import { useAudio } from '../context/AudioContext';
import * as DocumentPicker from 'expo-document-picker';
import { Plus, Trash2, GripVertical } from 'lucide-react-native';
import DraggableFlatList, { ScaleDecorator, RenderItemParams } from 'react-native-draggable-flatlist';
import { Track } from '../services/AudioService';

const Playlist = () => {
  const { playlist, currentTrackIndex, loadTrack, addTracks } = useAudio();

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      multiple: true,
    });
    
    if (!result.canceled) {
      const newTracks = result.assets.map(asset => ({
        id: Math.random().toString(36).substr(2, 9),
        name: asset.name,
        uri: asset.uri,
        bpm: null,
      }));
      addTracks(newTracks);
    }
  };

  const renderTrack = ({ item, drag, isActive, getIndex }: RenderItemParams<Track>) => {
    const index = getIndex();
    const isCurrent = index === currentTrackIndex;

    return (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={drag}
          onPress={() => index !== undefined && loadTrack(index)}
          disabled={isActive}
          style={[
            styles.trackItem,
            isCurrent && styles.activeTrack,
            isActive && styles.draggingTrack
          ]}
        >
          <GripVertical size={20} color="#555" />
          <View style={styles.trackInfo}>
            <Text style={[styles.trackName, isCurrent && styles.activeText]}>{item.name}</Text>
            <Text style={styles.trackBpm}>{item.bpm ? `${item.bpm} BPM` : '--- BPM'}</Text>
          </View>
        </TouchableOpacity>
      </ScaleDecorator>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>TAPE DECK</Text>
        <TouchableOpacity onPress={pickFiles} style={styles.addButton}>
          <Plus size={20} color="#39ff14" />
        </TouchableOpacity>
      </View>
      <DraggableFlatList
        data={playlist}
        onDragEnd={({ data }) => {/* handle reorder */}}
        keyExtractor={(item) => item.id}
        renderItem={renderTrack}
        containerStyle={styles.list}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  title: {
    color: '#39ff14',
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  addButton: {
    padding: 5,
  },
  list: {
    flex: 1,
  },
  trackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    backgroundColor: '#0a0a0a',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  activeTrack: {
    backgroundColor: '#001a00',
    borderLeftWidth: 3,
    borderLeftColor: '#39ff14',
  },
  draggingTrack: {
    backgroundColor: '#222',
  },
  trackInfo: {
    marginLeft: 15,
    flex: 1,
  },
  trackName: {
    color: '#ccc',
    fontSize: 16,
  },
  activeText: {
    color: '#39ff14',
    fontWeight: 'bold',
  },
  trackBpm: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
});

export default Playlist;
