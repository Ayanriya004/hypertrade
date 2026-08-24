/**
 * Boot placeholder for the logged-in home AccountCard.
 * Same chrome / minHeight as the real card so Privy restore does not
 * shrink a guest-CTA skeleton into the two-column account row.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { ShimmerBone, useShimmerX } from './skeleton/ShimmerBone';

/** Loaded AccountCard border-box height (padding 16×2 + two-column content). */
export const HOME_ACCOUNT_CARD_MIN_HEIGHT = 114;

export function AccountCardSkeleton() {
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
      <View style={styles.mainRow}>
        <View style={styles.col}>
          <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.valueBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.subBone} />
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <ShimmerBone shimmerX={shimmerX} style={styles.labelBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.valueBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.subBone} />
        </View>
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
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    minHeight: HOME_ACCOUNT_CARD_MIN_HEIGHT,
    justifyContent: 'center',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  col: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  divider: {
    width: 1,
    height: 60,
    backgroundColor: colors.border.primary,
    marginHorizontal: 16,
  },
  labelBone: {
    width: 88,
    height: 12,
    borderRadius: 4,
  },
  valueBone: {
    width: 112,
    height: 28,
    borderRadius: 6,
    marginTop: 8,
  },
  subBone: {
    width: 64,
    height: 12,
    borderRadius: 4,
    marginTop: 8,
  },
});
