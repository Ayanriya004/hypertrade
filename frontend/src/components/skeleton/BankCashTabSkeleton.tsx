/**
 * Shimmer placeholders for the Bank Cash tab — currency carousel + tx list.
 * Matches layout of CurrencyAccountCard and TransactionRow without the
 * branded logo spinner used for full-screen gates.
 */
import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from './ShimmerBone';

const CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;

function CurrencyAccountCardSkeleton({
  width,
  height,
  shimmerX,
}: {
  width: number;
  height: number;
  shimmerX: Animated.AnimatedInterpolation<number>;
}) {
  return (
    <View style={[styles.cardOuter, { width, height }]}>
      <LinearGradient
        colors={[...CARD_GRADIENT]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.card, { width, height }]}
      >
        <View style={styles.cardHeader}>
          <ShimmerBone shimmerX={shimmerX} style={styles.flagBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.codeBone} />
        </View>
        <View style={styles.cardSpacer} />
        <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.balanceBone} />
      </LinearGradient>
    </View>
  );
}

export function CurrencyAccountCarouselSkeleton({
  cardWidth,
  cardHeight,
  count = 2,
  sidePad = 20,
  gap = 12,
}: {
  cardWidth: number;
  cardHeight: number;
  count?: number;
  sidePad?: number;
  gap?: number;
}) {
  const shimmerX = useShimmerX([-180, 180]);
  const n = Math.max(1, Math.min(3, count));

  return (
    <View
      style={[styles.carousel, { paddingHorizontal: sidePad, gap }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: n }, (_, i) => (
        <CurrencyAccountCardSkeleton
          key={`acct-skel-${i}`}
          width={cardWidth}
          height={cardHeight}
          shimmerX={shimmerX}
        />
      ))}
    </View>
  );
}

function TransactionRowSkeleton({
  shimmerX,
  showDivider,
}: {
  shimmerX: Animated.AnimatedInterpolation<number>;
  showDivider: boolean;
}) {
  return (
    <View style={[styles.txRow, showDivider && styles.txRowBorder]}>
      <ShimmerBone shimmerX={shimmerX} style={styles.txIconBone} />
      <View style={styles.txMiddle}>
        <ShimmerBone shimmerX={shimmerX} style={styles.txTitleBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.txSubtitleBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.txMetaBone} />
      </View>
      <View style={styles.txRight}>
        <ShimmerBone shimmerX={shimmerX} style={styles.txAmountBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.txStatusBone} />
      </View>
    </View>
  );
}

export function BankTransactionListSkeleton({ rowCount = 4 }: { rowCount?: number }) {
  const shimmerX = useShimmerX([-160, 160]);
  const n = Math.max(1, Math.min(6, rowCount));

  return (
    <View
      style={styles.txList}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: n }, (_, i) => (
        <TransactionRowSkeleton
          key={`tx-skel-${i}`}
          shimmerX={shimmerX}
          showDivider={i > 0}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  carousel: {
    flexDirection: 'row',
    paddingTop: 4,
    paddingBottom: 8,
  },
  cardOuter: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  card: {
    borderRadius: 16,
    padding: 16,
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  flagBone: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  codeBone: {
    width: 44,
    height: 16,
    borderRadius: 4,
  },
  cardSpacer: {
    flex: 1,
  },
  labelBone: {
    width: '52%',
    height: 11,
    borderRadius: 4,
    marginBottom: 8,
  },
  balanceBone: {
    width: '68%',
    height: 28,
    borderRadius: 6,
  },
  txList: {
    paddingBottom: 4,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  txRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  txIconBone: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  txMiddle: {
    flex: 1,
    gap: 6,
  },
  txTitleBone: {
    width: '72%',
    height: 14,
    borderRadius: 4,
  },
  txSubtitleBone: {
    width: '48%',
    height: 12,
    borderRadius: 4,
  },
  txMetaBone: {
    width: '36%',
    height: 11,
    borderRadius: 4,
  },
  txRight: {
    alignItems: 'flex-end',
    gap: 6,
    minWidth: 72,
  },
  txAmountBone: {
    width: 72,
    height: 14,
    borderRadius: 4,
  },
  txStatusBone: {
    width: 56,
    height: 18,
    borderRadius: 999,
  },
});
