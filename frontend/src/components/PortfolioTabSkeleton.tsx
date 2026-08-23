/**
 * Shimmer skeleton rows for PortfolioTabs (positions / orders / history).
 * Static Views only — no Reanimated layout/exit so close/cancel FadeOut on
 * real rows is unaffected.
 */
import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../theme/colors';
import { ShimmerBone, useShimmerX } from './skeleton/ShimmerBone';

export type PortfolioTabSkeletonVariant = 'positions' | 'orders' | 'history';

type Props = {
  variant: PortfolioTabSkeletonVariant;
  count?: number;
};

function SkeletonRow({
  variant,
  shimmerX,
  showTopBorder,
}: {
  variant: PortfolioTabSkeletonVariant;
  shimmerX: Animated.AnimatedInterpolation<number>;
  showTopBorder: boolean;
}) {
  const isHistory = variant === 'history';

  return (
    <View style={[styles.row, showTopBorder && styles.rowBorder]}>
      <View style={styles.rowContent}>
        <View style={styles.rowLeft}>
          <View style={styles.titleRow}>
            {!isHistory ? (
              <ShimmerBone shimmerX={shimmerX} style={styles.leverageBone} />
            ) : null}
            <ShimmerBone shimmerX={shimmerX} style={styles.symbolBone} />
            <ShimmerBone shimmerX={shimmerX} style={styles.pillBone} />
            {!isHistory ? (
              <ShimmerBone shimmerX={shimmerX} style={styles.tagBone} />
            ) : null}
          </View>
          <View style={styles.metricsGrid}>
            <View style={styles.metricColumn}>
              <ShimmerBone shimmerX={shimmerX} style={styles.metricBone} />
              <ShimmerBone shimmerX={shimmerX} style={styles.metricBone} />
              {!isHistory ? (
                <ShimmerBone shimmerX={shimmerX} style={styles.metricBoneShort} />
              ) : null}
            </View>
            <View style={styles.metricColumn}>
              <ShimmerBone shimmerX={shimmerX} style={styles.metricBone} />
              <ShimmerBone shimmerX={shimmerX} style={styles.metricBone} />
            </View>
          </View>
        </View>
        {!isHistory ? (
          <View style={styles.actionsCol}>
            <ShimmerBone shimmerX={shimmerX} style={styles.actionBone} />
            {variant === 'positions' ? (
              <ShimmerBone shimmerX={shimmerX} style={styles.actionBone} />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function PortfolioTabSkeleton({ variant, count = 2 }: Props) {
  const shimmerX = useShimmerX([-160, 160]);
  const n = Math.max(1, Math.min(3, count));

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: n }, (_, i) => (
        <SkeletonRow
          key={`${variant}-skel-${i}`}
          variant={variant}
          shimmerX={shimmerX}
          showTopBorder={i > 0}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 8,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 2,
  },
  rowLeft: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  leverageBone: {
    width: 28,
    height: 18,
    borderRadius: 5,
  },
  symbolBone: {
    width: 52,
    height: 18,
    borderRadius: 5,
  },
  pillBone: {
    width: 36,
    height: 18,
    borderRadius: 5,
  },
  tagBone: {
    width: 44,
    height: 18,
    borderRadius: 5,
  },
  metricsGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricColumn: {
    flex: 1,
    gap: 6,
  },
  metricBone: {
    width: '72%',
    height: 12,
    borderRadius: 4,
  },
  metricBoneShort: {
    width: '55%',
    height: 12,
    borderRadius: 4,
  },
  actionsCol: {
    width: 110,
    gap: 6,
    alignItems: 'flex-end',
  },
  actionBone: {
    width: '100%',
    height: 28,
    borderRadius: 8,
  },
});
