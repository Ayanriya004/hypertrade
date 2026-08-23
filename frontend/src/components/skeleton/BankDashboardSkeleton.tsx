/**
 * Full-page shimmer for Bank while auth hydrates or UR account bootstraps.
 * Reuses Cash-tab carousel / tx list bones so the boot gate matches in-tab loaders.
 */
import React from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from './ShimmerBone';
import {
  BankTransactionListSkeleton,
  CurrencyAccountCarouselSkeleton,
} from './BankCashTabSkeleton';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARROUSEL_GAP = 12;
const CARROUSEL_SIDE_PAD = 20;
const ACCOUNT_CARD_WIDTH = Math.round(SCREEN_WIDTH * 0.62);
const ACCOUNT_CARD_HEIGHT = Math.round(ACCOUNT_CARD_WIDTH * 0.62);

/** Cash-tab body only — greeting, actions, accounts, transactions. */
export function BankCashContentSkeleton() {
  const shimmerX = useShimmerX([-160, 160]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.greeting}>
        <ShimmerBone shimmerX={shimmerX} style={styles.chipBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.totalBone} />
      </View>

      <View style={styles.quickActions}>
        {[0, 1, 2].map((i) => (
          <View key={`qa-${i}`} style={styles.actionCol}>
            <ShimmerBone shimmerX={shimmerX} style={styles.actionCircle} />
            <ShimmerBone shimmerX={shimmerX} style={styles.actionLabel} />
          </View>
        ))}
      </View>

      <CurrencyAccountCarouselSkeleton
        cardWidth={ACCOUNT_CARD_WIDTH}
        cardHeight={ACCOUNT_CARD_HEIGHT}
        sidePad={CARROUSEL_SIDE_PAD}
        gap={CARROUSEL_GAP}
      />

      <View style={styles.txHeader}>
        <ShimmerBone shimmerX={shimmerX} style={styles.txHeaderTitle} />
        <ShimmerBone shimmerX={shimmerX} style={styles.txHeaderLink} />
      </View>
      <BankTransactionListSkeleton rowCount={4} />
    </View>
  );
}

/** Full Bank chrome (header + tabs + cash body) for `/bank` auth boot. */
export function BankDashboardSkeleton() {
  const shimmerX = useShimmerX([-200, 200]);

  return (
    <SafeAreaView
      style={styles.root}
      edges={['top']}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.header}>
        <ShimmerBone shimmerX={shimmerX} style={styles.headerIcon} />
        <ShimmerBone shimmerX={shimmerX} style={styles.headerTitle} />
        <View style={styles.headerRight}>
          <ShimmerBone shimmerX={shimmerX} style={styles.headerIcon} />
          <ShimmerBone shimmerX={shimmerX} style={styles.headerIcon} />
        </View>
      </View>

      <View style={styles.tabBar}>
        <ShimmerBone shimmerX={shimmerX} style={styles.tabBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.tabBone} />
      </View>

      <BankCashContentSkeleton />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  headerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
  },
  headerTitle: {
    width: 72,
    height: 18,
    borderRadius: 6,
  },
  headerRight: {
    flexDirection: 'row',
    gap: 8,
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 4,
  },
  tabBone: {
    flex: 1,
    height: 40,
    borderRadius: 8,
  },
  greeting: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 12,
  },
  chipBone: {
    width: 120,
    height: 28,
    borderRadius: 14,
  },
  totalBone: {
    width: '58%',
    height: 36,
    borderRadius: 8,
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  actionCol: {
    alignItems: 'center',
    gap: 8,
  },
  actionCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  actionLabel: {
    width: 56,
    height: 12,
    borderRadius: 4,
  },
  txHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  txHeaderTitle: {
    width: 110,
    height: 16,
    borderRadius: 4,
  },
  txHeaderLink: {
    width: 64,
    height: 14,
    borderRadius: 4,
  },
});
