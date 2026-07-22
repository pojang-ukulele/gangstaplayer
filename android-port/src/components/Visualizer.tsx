import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, Animated } from 'react-native';
import { useAudio } from '../context/AudioContext';

const barColors = ['#ff0000', '#d4002b', '#aa0055', '#800080', '#990ae6', '#bc13fe', '#bc13fe', '#a030f0', '#8a50d0', '#7070b0', '#509090', '#30b070', '#20d050', '#10f030', '#39ff14', '#39ff14'];

const Visualizer = () => {
  const { metering } = useAudio();
  const bars = useRef(Array.from({ length: 16 }).map(() => new Animated.Value(0.1))).current;

  useEffect(() => {
    bars.forEach((bar, i) => {
      const factor = 1 - (i / 16) * 0.5; 
      const jitter = 0.8 + Math.random() * 0.4;
      const targetValue = Math.min(100, metering * 100 * factor * jitter);

      Animated.spring(bar, {
        toValue: Math.max(5, targetValue),
        friction: 4,
        tension: 40,
        useNativeDriver: false,
      }).start();
    });
  }, [metering]);

  return (
    <View style={styles.container}>
      <View style={styles.visualizer}>
        {bars.map((bar, i) => (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              {
                backgroundColor: barColors[i],
                height: bar.interpolate({
                  inputRange: [0, 100],
                  outputRange: ['5%', '100%'],
                }),
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.scannerLine} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    backgroundColor: '#0a1a0a',
  },
  visualizer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 80,
    zIndex: 2,
  },
  bar: {
    width: '5%',
    opacity: 0.8,
  },
  scannerLine: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    height: 1,
    backgroundColor: 'rgba(57, 255, 20, 0.4)',
    shadowColor: '#39ff14',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 5,
    zIndex: 1,
  },
});

export default Visualizer;
