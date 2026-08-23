import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from './ShimmerBone';

const CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;

export function PortfolioBalanceCardSkeleton() {
  const shimmerX = useShimmerX([-220, 220]);

  return (
    <LinearGradient
      colors={[...CARD_GRADIENT]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
      <ShimmerBone shimmerX={shimmerX} style={styles.totalBone} />
      <View style={styles.breakdownRow}>
        <View style={styles.breakdownCol}>
          <ShimmerBone shimmerX={shimmerX} style={styles.rowLabelBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.rowValueBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.rowSubBone} />
        </View>
        <View style={styles.divider} />
        <View style={styles.breakdownCol}>
          <ShimmerBone shimmerX={shimmerX} style={styles.rowLabelBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.rowValueBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.rowSubBone} />
        </View>
      </View>
      <ShimmerBone shimmerX={shimmerX} style={styles.transferBone} />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  labelBone: {
    width: '42%',
    height: 14,
    borderRadius: 4,
    marginBottom: 10,
  },
  totalBone: {
    width: '58%',
    height: 32,
    borderRadius: 6,
    marginBottom: 18,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  breakdownCol: {
    flex: 1,
    gap: 6,
  },
  divider: {
    width: 1,
    alignSelf: 'stretch',
    minHeight: 52,
    backgroundColor: colors.border.primary,
  },
  rowLabelBone: {
    width: '55%',
    height: 12,
    borderRadius: 4,
  },
  rowValueBone: {
    width: '48%',
    height: 18,
    borderRadius: 4,
  },
  rowSubBone: {
    width: '72%',
    height: 10,
    borderRadius: 3,
  },
  transferBone: {
    marginTop: 16,
    width: '100%',
    height: 40,
    borderRadius: 10,
  },
});
