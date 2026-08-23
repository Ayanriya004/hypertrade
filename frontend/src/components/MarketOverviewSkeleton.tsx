/**
 * Skeleton for home Market Overview (gainers/losers + 24h volume cards).
 * Shown while RWA/crypto asset lists are loading; matches MarketStats layout.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { ShimmerBone, useShimmerX } from './skeleton/ShimmerBone';

const CARD_GRADIENT = ['#1a1a2e', '#151525', '#0f0f1a'] as const;

export function MarketOverviewSkeleton() {
  const shimmerX = useShimmerX([-160, 160]);

  return (
    <View
      style={styles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <LinearGradient
        colors={[...CARD_GRADIENT]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.statCard}
      >
        <View style={styles.gainersLosersRow}>
          <View style={styles.column}>
            <ShimmerBone shimmerX={shimmerX} style={styles.valueBone} />
            <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
          </View>
          <View style={styles.divider} />
          <View style={styles.column}>
            <ShimmerBone shimmerX={shimmerX} style={styles.valueBone} />
            <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
          </View>
        </View>
      </LinearGradient>

      <LinearGradient
        colors={[...CARD_GRADIENT]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.statCard}
      >
        <ShimmerBone shimmerX={shimmerX} style={styles.iconBone} />
        <View style={styles.volumeContent}>
          <ShimmerBone shimmerX={shimmerX} style={styles.volumeValueBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  statCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 10,
    overflow: 'hidden',
  },
  gainersLosersRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  column: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: colors.border.primary,
    marginHorizontal: 4,
  },
  volumeContent: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  iconBone: {
    width: 36,
    height: 36,
    borderRadius: 10,
  },
  valueBone: {
    width: 36,
    height: 18,
    borderRadius: 4,
  },
  volumeValueBone: {
    width: '72%',
    height: 18,
    borderRadius: 4,
  },
  labelBone: {
    width: 48,
    height: 11,
    borderRadius: 3,
  },
});
