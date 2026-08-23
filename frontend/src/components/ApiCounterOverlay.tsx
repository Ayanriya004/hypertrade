/**
 * ApiCounterOverlay — FPS-style HUD that floats in the top-right corner.
 *
 * Shows:
 *   • Total requests in the last 10 s + RPS
 *   • Top 5 endpoints by call count
 *   • Flashes red when a 429 / rate-limit is detected
 *
 * Only rendered when __DEV__ is true.  Tap the badge to expand / collapse.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiTracker, type TrackerSnapshot } from '../lib/apiTracker';

const MAX_ENDPOINTS = 6;

export function ApiCounterOverlay() {
  const [snap, setSnap] = useState<TrackerSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const flashAnim = useRef(new Animated.Value(0)).current;

  // Subscribe to periodic snapshots
  useEffect(() => {
    apiTracker.install(); // safe to call multiple times
    const handler = (s: TrackerSnapshot) => setSnap(s);
    apiTracker.subscribe(handler);
    return () => {
      apiTracker.unsubscribe(handler);
    };
  }, []);

  // Flash animation on rate-limit
  useEffect(() => {
    if (snap?.hasRateLimit) {
      Animated.sequence([
        Animated.timing(flashAnim, { toValue: 1, duration: 150, useNativeDriver: false }),
        Animated.timing(flashAnim, { toValue: 0, duration: 600, useNativeDriver: false }),
      ]).start();
    }
  }, [snap?.hasRateLimit, snap?.lastRequestTime, flashAnim]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  if (!snap) return null;

  const bgColor = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0.70)', 'rgba(200,30,30,0.85)'],
  });

  const rpsColor = snap.rps > 3 ? '#ff5555' : snap.rps > 1.5 ? '#ffaa33' : '#55ff55';

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.root, { backgroundColor: bgColor }]}
    >
      <TouchableOpacity onPress={toggle} activeOpacity={0.7}>
        <View style={styles.badgeRow}>
          <Text style={[styles.rpsText, { color: rpsColor }]}>
            {snap.rps.toFixed(1)} r/s
          </Text>
          <Text style={styles.totalText}>
            {snap.totalInWindow} / 10s
          </Text>
          {snap.hasRateLimit && <Text style={styles.rateLimitBadge}>429!</Text>}
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.detail}>
          {snap.endpoints.slice(0, MAX_ENDPOINTS).map((ep, i) => (
            <View key={`${ep.method}-${ep.url}-${i}`} style={styles.epRow}>
              <Text style={styles.epMethod}>{ep.method}</Text>
              <Text
                style={[styles.epUrl, ep.lastStatus === 429 && styles.epUrl429]}
                numberOfLines={1}
              >
                {ep.url}
              </Text>
              <Text style={[styles.epCount, ep.count >= 5 && styles.epCountHigh]}>
                ×{ep.count}
              </Text>
            </View>
          ))}
          {snap.endpoints.length > MAX_ENDPOINTS && (
            <Text style={styles.moreText}>+{snap.endpoints.length - MAX_ENDPOINTS} more</Text>
          )}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 50,
    right: 8,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    zIndex: 99999,
    elevation: 99999,
    minWidth: 100,
    maxWidth: 260,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rpsText: {
    fontSize: 12,
    fontWeight: '900',
    fontFamily: 'monospace',
  },
  totalText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ccc',
    fontFamily: 'monospace',
  },
  rateLimitBadge: {
    fontSize: 10,
    fontWeight: '900',
    color: '#ff3333',
    backgroundColor: 'rgba(255,0,0,0.2)',
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
  detail: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.15)',
    paddingTop: 4,
  },
  epRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 1,
  },
  epMethod: {
    fontSize: 8,
    fontWeight: '800',
    color: '#888',
    fontFamily: 'monospace',
    width: 28,
  },
  epUrl: {
    fontSize: 9,
    fontWeight: '600',
    color: '#aaa',
    fontFamily: 'monospace',
    flex: 1,
  },
  epUrl429: {
    color: '#ff5555',
  },
  epCount: {
    fontSize: 10,
    fontWeight: '800',
    color: '#ddd',
    fontFamily: 'monospace',
    minWidth: 22,
    textAlign: 'right',
  },
  epCountHigh: {
    color: '#ff9933',
  },
  moreText: {
    fontSize: 8,
    color: '#666',
    textAlign: 'right',
    fontFamily: 'monospace',
  },
});
