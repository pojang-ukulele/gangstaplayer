import React from 'react';
import { StyleSheet, View, SafeAreaView, StatusBar, ScrollView } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AudioProvider } from './src/context/AudioContext';
import PlayerControls from './src/components/PlayerControls';
// import Playlist from './src/components/Playlist'; // Can hide for now to match UI
import SamplerGrid from './src/components/SamplerGrid';
import Visualizer from './src/components/Visualizer';
import Header from './src/components/Header';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AudioProvider>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" backgroundColor="#050505" />
          
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
            
            <Header />
            
            {/* User requested visual EQ blocks syncing dynamically to playing music below header */}
            <View style={styles.eqContainer}>
                <Visualizer /> 
            </View>

            <View style={styles.samplerContainer}>
              <SamplerGrid />
            </View>
            
            <View style={styles.controlsContainer}>
              <PlayerControls />
            </View>

          </ScrollView>
        </SafeAreaView>
      </AudioProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 20,
  },
  eqContainer: {
    height: 80,
    backgroundColor: '#050505',
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  samplerContainer: {
    marginBottom: 15,
    paddingHorizontal: 15,
  },
  controlsContainer: {
    paddingHorizontal: 15,
  },
});

