/**
 * Single currency account card — the building block of the Cash tab's
 * horizontal carousel. Loosely modelled on Wise's account cards.
 *
 * Shows currency icon + code, a compact send action (icon), a "Currency
 * balance" label, and the balance in big type at the bottom.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  type ColorValue,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import type { CashAccountRow } from '../../lib/urApi';
import { FIAT_TOKEN_DECIMALS, floorFiatHuman } from '../../lib/mantleFiatBalance';
import { CircleCurrencyFlag } from './CircleCountryFlag';
import { SendIcon } from './SendIcon';
import { ShimmerBone, useShimmerX } from '../skeleton/ShimmerBone';

type GradientColors = readonly [ColorValue, ColorValue, ...ColorValue[]];

/** Same charcoal-blue as homepage account cards (`app/index.tsx`). */
const HOMEPAGE_CARD_GRADIENT: GradientColors = ['#1a1a2e', '#16213e', '#0f0f1a'];

const CURRENCY_GRADIENTS: Record<string, GradientColors> = {
  USD: HOMEPAGE_CARD_GRADIENT,
  EUR: ['#1f2a3a', '#101a24'],
  CHF: ['#3a1f1f', '#241010'],
  GBP: ['#2a1f3a', '#181024'],
  JPY: ['#3a2a1f', '#241810'],
  CNH: ['#3a1f2a', '#241018'],
  SGD: ['#1f3a3a', '#102424'],
  HKD: ['#3a3a1f', '#242410'],
};

const DEFAULT_GRADIENT: GradientColors = ['#1f1f2a', '#141420'];

/** Fiat24 ledger amounts from UR API — 2 dp for all currencies (JPY24 included). */
function formatCardBalance(amountStr: string, fallbackAmount: number): string {
  const parsed = Number(amountStr);
  const value = floorFiatHuman(
    Number.isFinite(parsed) ? parsed : fallbackAmount,
    FIAT_TOKEN_DECIMALS,
  );
  return value.toLocaleString('en-US', {
    minimumFractionDigits: FIAT_TOKEN_DECIMALS,
    maximumFractionDigits: FIAT_TOKEN_DECIMALS,
  });
}

/** Shimmer placeholder for the balance line — matches BankCashTabSkeleton card bones. */
function BalanceShimmer() {
  const shimmerX = useShimmerX([-120, 120]);
  return <ShimmerBone shimmerX={shimmerX} style={styles.balanceBone} />;
}

export interface CurrencyAccountCardProps {
  row: CashAccountRow;
  width: number;
  height: number;
  /** UR balance still loading — shimmer the amount instead of showing 0.00. */
  balanceLoading?: boolean;
  /** Opens the URID-to-URID transfer sheet for this currency. */
  onSendToUser?: () => void;
}

export function CurrencyAccountCard({
  row,
  width,
  height,
  balanceLoading = false,
  onSendToUser,
}: CurrencyAccountCardProps) {
  const { t } = useTranslation();
  const gradient = CURRENCY_GRADIENTS[row.currency] ?? DEFAULT_GRADIENT;

  return (
    <View style={[styles.outer, { width, height }]}>
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.card, { width, height }]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <View style={styles.flagWrap}>
              <CircleCurrencyFlag currencyCode={row.currency} size={28} />
            </View>
            <Text style={styles.currencyCode}>{row.currency}</Text>
          </View>
          {onSendToUser ? (
            <TouchableOpacity
              style={styles.sendIconBtn}
              onPress={onSendToUser}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('cash.sendToHypertradeUser')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <SendIcon size={16} color={colors.text.secondary} />
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.middleSpacer} />

        <View style={styles.ibanRow}>
          <Ionicons name="cash-outline" size={12} color={colors.text.tertiary} />
          <Text style={styles.ibanText} numberOfLines={1}>
            {t('cash.currencyBalance')}
          </Text>
        </View>

        {balanceLoading ? (
          <BalanceShimmer />
        ) : (
          <Text style={styles.balance} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {formatCardBalance(row.amountStr, row.amount)}
          </Text>
        )}
      </LinearGradient>
    </View>
  );
}

/**
 * Final tile at the end of the carousel inviting the user to add another
 * currency account. Kept visually distinct (dashed border, transparent bg).
 */
export interface AddAccountTileProps {
  width: number;
  height: number;
  onPress?: () => void;
}

export function AddAccountTile({ width, height, onPress }: AddAccountTileProps) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[
        styles.addOuter,
        { width, height },
      ]}
    >
      <View style={[styles.addCard, { width, height }]}>
        <View style={styles.addIconCircle}>
          <Ionicons name="add" size={22} color={colors.text.secondary} />
        </View>
        <Text style={styles.addTitle}>Open new account</Text>
        <Text style={styles.addSubtitle}>USD, CHF, EUR, CNH & more</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  outer: {
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  flagWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  currencyCode: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    letterSpacing: 0.5,
  },
  sendIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexShrink: 0,
  },
  middleSpacer: {
    flex: 1,
  },
  ibanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  ibanText: {
    fontSize: 11,
    color: colors.text.tertiary,
    fontWeight: '500',
    flex: 1,
  },
  /** Left-aligned slot so loader dots sit where the balance digits appear. */
  balanceRow: {
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  balanceBone: {
    width: '68%',
    height: 28,
    borderRadius: 6,
  },
  balance: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.text.primary,
    letterSpacing: -0.5,
  },
  incomingPill: {
    marginTop: 6,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,196,0,0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,196,0,0.45)',
  },
  incomingText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.accent.gold,
    letterSpacing: 0.3,
  },
  incomingCountBadge: {
    minWidth: 15,
    height: 15,
    borderRadius: 999,
    paddingHorizontal: 4,
    backgroundColor: 'rgba(255,196,0,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  incomingCountText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#1a1a2e',
  },
  addOuter: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  addCard: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.border.secondary,
    borderStyle: 'dashed',
    padding: 16,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  addIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  addTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
    textAlign: 'center',
  },
  addSubtitle: {
    fontSize: 10,
    color: colors.text.tertiary,
    textAlign: 'center',
  },
});
