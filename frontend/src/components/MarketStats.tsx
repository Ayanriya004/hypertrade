import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { Asset } from '../lib/api';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../providers/CurrencyProvider';
import { TweenedStatText } from './TweenedStatText';

interface MarketStatsProps {
  assets: Asset[];
}

const MarketStatsComponent: React.FC<MarketStatsProps> = ({ assets }) => {
  const { t } = useTranslation();
  const { formatDisplayVolume } = useDisplayCurrency();

  // Single pass over the universe — three reductions in one loop avoids
  // walking the array three times on every refetch tick. Memoized so we
  // skip the recompute entirely when `assets` ref is stable (the parent
  // now feeds in a deferred reference, so unchanged refetches cost zero).
  const { gainers, losers, totalVolume } = React.useMemo(() => {
    let g = 0;
    let l = 0;
    let vol = 0;
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (a.change24h) {
        if (a.change24h > 0) g++;
        else if (a.change24h < 0) l++;
      }
      if (a.dayNtlVlm) {
        const v = parseFloat(a.dayNtlVlm);
        if (Number.isFinite(v)) vol += v;
      }
    }
    return { gainers: g, losers: l, totalVolume: vol };
  }, [assets]);

  const formatVolume = useCallback(
    (vol: number) => formatDisplayVolume(vol),
    [formatDisplayVolume],
  );
  const formatCount = useCallback((n: number) => String(Math.round(n)), []);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#1a1a2e', '#151525', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.statCard}
      >
        <View style={styles.gainersLosersContent}>
          <View style={styles.gainersLosersRow}>
            <View style={styles.gainersLosersColumn}>
              <View style={styles.gainersLosersItem}>
                <Ionicons name="trending-up" size={14} color={colors.status.success} />
                <TweenedStatText
                  value={gainers}
                  format={formatCount}
                  style={[styles.statValue, { color: colors.status.success, marginLeft: 4 }]}
                />
              </View>
              <Text style={styles.statLabel} numberOfLines={1}>{t('home.gainers')}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.gainersLosersColumn}>
              <View style={styles.gainersLosersItem}>
                <Ionicons name="trending-down" size={14} color={colors.status.error} />
                <TweenedStatText
                  value={losers}
                  format={formatCount}
                  style={[styles.statValue, { color: colors.status.error, marginLeft: 4 }]}
                />
              </View>
              <Text style={styles.statLabel} numberOfLines={1}>{t('home.losers')}</Text>
            </View>
          </View>
        </View>
      </LinearGradient>

      <LinearGradient
        colors={['#1a1a2e', '#151525', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.statCard}
      >
        <View style={[styles.iconContainer, { backgroundColor: `${colors.accent.gold}20` }]}>
          <Ionicons name="bar-chart" size={18} color={colors.accent.gold} />
        </View>
        <View style={styles.volumeContent}>
          <TweenedStatText
            value={totalVolume}
            format={formatVolume}
            style={styles.statValue}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          />
          <Text style={styles.statLabel}>{t('home.volume24h')}</Text>
        </View>
      </LinearGradient>
    </View>
  );
};

export const MarketStats = React.memo(MarketStatsComponent);

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
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gainersLosersContent: {
    flex: 1,
  },
  gainersLosersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
  },
  gainersLosersColumn: {
    alignItems: 'center',
    flex: 1,
  },
  volumeContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gainersLosersItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: colors.border.primary,
    marginHorizontal: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
  },
  statLabel: {
    fontSize: 11,
    color: colors.text.tertiary,
    marginTop: 2,
    textAlign: 'center',
  },
});
