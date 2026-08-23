import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from './ShimmerBone';

const CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;

function SummaryCardSkeleton({
  shimmerX,
}: {
  shimmerX: Animated.AnimatedInterpolation<number>;
}) {
  return (
    <LinearGradient
      colors={[...CARD_GRADIENT]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
    >
      <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
      <ShimmerBone shimmerX={shimmerX} style={styles.valueBone} />
    </LinearGradient>
  );
}

export function PortfolioSummaryCardsSkeleton() {
  const shimmerX = useShimmerX([-160, 160]);

  return (
    <View
      style={styles.row}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SummaryCardSkeleton shimmerX={shimmerX} />
      <SummaryCardSkeleton shimmerX={shimmerX} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 10,
  },
  card: {
    flex: 1,
    minWidth: 110,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  labelBone: {
    width: '65%',
    height: 13,
    borderRadius: 4,
    marginBottom: 10,
  },
  valueBone: {
    width: '78%',
    height: 24,
    borderRadius: 5,
  },
});
