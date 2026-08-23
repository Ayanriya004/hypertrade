/**
 * CardLimitRings — Daily contactless + rolling 30-day account gauges from UR `/api/v2/card`.
 *
 * Limits are server-authoritative in CHF; we display the remaining headroom in
 * USD via the dashboard FX map (`usdRates[code]` = USD per 1 unit of `code`).
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { convertChfToCurrency } from '../../lib/urTransferLimit';
import {
  bucketRemaining,
  bucketUsagePct,
  resolveAccountRollingLimit,
  resolveContactlessDailyLimit,
  type UrCardLimitBucket,
  type UrCardLimitsBuckets,
} from '../../lib/urCardLimits';

const DISPLAY_CURRENCY = 'USD';

function fmtAmount(n: number): string {
  // Force en-US so "12221" never reads as a tiny decimal on locales where
  // "." is the thousands separator (e.g. de-DE → "12.221").
  return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function ProgressRing({
  pct,
  size = 68,
  stroke = 6,
  children,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  children: React.ReactNode;
}) {
  const clamped = Math.min(1, Math.max(0, pct));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * clamped;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.background.tertiary}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.status.success}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.ringCenter]}>{children}</View>
    </View>
  );
}

function LimitGauge({
  bucket,
  label,
  usdRates,
}: {
  bucket: UrCardLimitBucket;
  label: string;
  usdRates?: Record<string, number> | null;
}) {
  const { t } = useTranslation();
  const pct = bucketUsagePct(bucket);
  const leftChf = bucketRemaining(bucket) ?? Math.max(0, bucket.max - bucket.used);
  const leftUsd = convertChfToCurrency(leftChf, DISPLAY_CURRENCY, usdRates);
  const displayAmount = leftUsd != null ? leftUsd : leftChf;
  const displayCurrency = leftUsd != null ? DISPLAY_CURRENCY : 'CHF';

  return (
    <View style={styles.col}>
      <ProgressRing pct={pct}>
        <Text style={styles.ringPct}>{Math.round(pct * 100)}%</Text>
      </ProgressRing>
      <Text style={styles.colLabel}>{label}</Text>
      <Text style={styles.colSub}>
        {t('cash.cardLimits.left', {
          amount: fmtAmount(displayAmount),
          currency: displayCurrency,
          defaultValue: '{{amount}} {{currency}} left',
        })}
      </Text>
    </View>
  );
}

export function CardLimitRings({
  limits,
  usdRates,
}: {
  limits: UrCardLimitsBuckets | null;
  usdRates?: Record<string, number> | null;
}) {
  const { t } = useTranslation();

  const daily = useMemo(
    () => resolveContactlessDailyLimit(limits?.contactless),
    [limits?.contactless],
  );
  const monthly = useMemo(
    () => resolveAccountRollingLimit(limits?.account),
    [limits?.account],
  );

  if (!daily && !monthly) return null;

  return (
    <View style={styles.card}>
      {daily ? (
        <>
          <LimitGauge
            bucket={daily}
            label={t('cash.cardLimits.daily', 'Daily contactless')}
            usdRates={usdRates}
          />
          {monthly ? <View style={styles.divider} /> : null}
        </>
      ) : null}
      {monthly ? (
        <LimitGauge
          bucket={monthly}
          label={t('cash.cardLimits.monthly', '30-day limit')}
          usdRates={usdRates}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.card,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    paddingVertical: 16,
    // Match walletButtonsRow horizontal inset (paddingHorizontal: 20).
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 8,
  },
  col: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: 8,
    backgroundColor: colors.border.primary,
  },
  ringCenter: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  ringPct: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '800',
  },
  colLabel: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  colSub: {
    color: colors.text.tertiary,
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 4,
  },
});
