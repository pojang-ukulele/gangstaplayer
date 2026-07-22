import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useAudio } from '../context/AudioContext';

const NUM_LEDS = 8;

const Header = () => {
  const { isPlaying } = useAudio();
  const [activeIndex, setActiveIndex] = useState(-1);
  const [direction, setDirection] = useState(1); // 1 = right, -1 = left
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isPlaying) {
      let idx = 0;
      let dir = 1;
      intervalRef.current = setInterval(() => {
        setActiveIndex(idx);
        idx += dir;
        if (idx >= NUM_LEDS - 1) { dir = -1; idx = NUM_LEDS - 1; }
        if (idx <= 0) { dir = 1; idx = 0; }
      }, 100);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setActiveIndex(-1);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying]);

  const getLedStyle = (i: number) => {
    if (!isPlaying || activeIndex < 0) return styles.ledDark;
    
    const dist = Math.abs(i - activeIndex);
    if (dist === 0) return styles.ledBright;
    if (dist === 1) return styles.ledMedium;
    if (dist === 2) return styles.ledDim;
    return styles.ledDark;
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>UG PLAYER PRO 3</Text>
      
      <View style={styles.subtextContainer}>
        <Text style={styles.subtextYellow}>[CRACKED BY OG RAJIZ]</Text>
        <Text style={styles.subtextGreen}>FULLY WORKING</Text>
      </View>

      <View style={styles.ledRow}>
        {Array.from({ length: NUM_LEDS }).map((_, i) => (
          <View key={i} style={[styles.led, getLedStyle(i)]} />
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingTop: 20,
    paddingBottom: 20,
    alignItems: 'center',
    backgroundColor: '#050505',
  },
  title: {
    color: '#39ff14',
    fontSize: 32,
    fontWeight: 'bold',
    letterSpacing: 2,
    marginBottom: 10,
  },
  subtextContainer: {
    alignItems: 'center',
    marginBottom: 15,
  },
  subtextYellow: {
    color: '#a8a815',
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
    fontFamily: 'monospace',
  },
  subtextGreen: {
    color: '#1e8014',
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: 'monospace',
  },
  ledRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 20,
  },
  led: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  ledDark: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
  },
  ledBright: {
    backgroundColor: '#ff0000',
    shadowColor: '#ff0000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 8,
  },
  ledMedium: {
    backgroundColor: '#cc0000',
    shadowColor: '#cc0000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 4,
  },
  ledDim: {
    backgroundColor: '#550000',
    borderWidth: 1,
    borderColor: '#880000',
  },
});

export default Header;
