import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from './ShimmerBone';

function NewsRowSkeleton({
  shimmerX,
  showDivider,
}: {
  shimmerX: Animated.AnimatedInterpolation<number>;
  showDivider: boolean;
}) {
  return (
    <View style={[styles.row, showDivider && styles.rowBorder]}>
      <View style={styles.rowHeader}>
        <ShimmerBone shimmerX={shimmerX} style={styles.chipBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.sourceBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.timeBone} />
      </View>
      <View style={styles.headlineRow}>
        <View style={styles.headlineCol}>
          <ShimmerBone shimmerX={shimmerX} style={styles.headlineBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.headlineBoneMid} />
          <ShimmerBone shimmerX={shimmerX} style={styles.summaryBone} />
        </View>
        <ShimmerBone shimmerX={shimmerX} style={styles.thumbBone} />
      </View>
    </View>
  );
}

type Props = {
  /** Matches MAX_NEWS_PER_CATEGORY on the news screen */
  rowCount?: number;
};

export function NewsListSkeleton({ rowCount = 10 }: Props) {
  const shimmerX = useShimmerX([-180, 180]);
  const n = Math.max(1, Math.min(rowCount, 10));

  return (
    <View
      style={styles.list}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: n }, (_, i) => (
        <NewsRowSkeleton key={i} shimmerX={shimmerX} showDivider={i > 0} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingTop: 4,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  chipBone: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  sourceBone: {
    width: 88,
    height: 12,
    borderRadius: 4,
    flex: 1,
    maxWidth: 140,
  },
  timeBone: {
    width: 28,
    height: 12,
    borderRadius: 4,
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headlineCol: {
    flex: 1,
    gap: 8,
  },
  headlineBone: {
    width: '100%',
    height: 16,
    borderRadius: 4,
  },
  headlineBoneMid: {
    width: '92%',
    height: 16,
    borderRadius: 4,
  },
  summaryBone: {
    width: '75%',
    height: 13,
    borderRadius: 4,
    marginTop: 2,
  },
  thumbBone: {
    width: 72,
    height: 72,
    borderRadius: 8,
  },
});
