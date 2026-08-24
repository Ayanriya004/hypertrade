/**
 * Skeleton placeholder for the home guest CTA carousel.
 * Shown from first paint until Privy is ready, only when the last session
 * was a guest — logged-in boots use AccountCardSkeleton instead.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { ShimmerBone, useShimmerX } from './skeleton/ShimmerBone';

export function GuestCtaSkeleton() {
  const shimmerX = useShimmerX([-220, 220]);

  return (
    <LinearGradient
      colors={['#1a1a2e', '#16213e', '#0f0f1a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.content}>
        <ShimmerBone shimmerX={shimmerX} style={styles.titleBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.subtitleBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.buttonBone} />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  content: {
    alignItems: 'center',
  },
  titleBone: {
    width: '52%',
    height: 22,
    borderRadius: 6,
    marginBottom: 10,
  },
  subtitleBone: {
    width: '78%',
    height: 14,
    borderRadius: 4,
    marginBottom: 18,
  },
  buttonBone: {
    width: 200,
    height: 40,
    borderRadius: 12,
  },
});
