import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { colors } from '../src/theme/colors';
import { fetchAssets, fetchCryptoAssets, type Asset } from '../src/lib/api';
import { useBuilderConfig } from '../src/providers/BuilderConfigProvider';
import { getSpotBuilderFeeTenthsBps } from '../src/lib/hyperliquid';
import {
  computeProtocolFeeRates,
  DEFAULT_PERP_MAKER_RATE,
  DEFAULT_PERP_TAKER_RATE,
  DEFAULT_SPOT_MAKER_RATE,
  DEFAULT_SPOT_TAKER_RATE,
  formatFeePercent,
} from '../src/lib/hip3Fees';
import { BANKING_ENABLED } from '../src/lib/bankingEnabled';

type FeeRow = {
  category: string;
  assets: string;
  taker: string;
  maker: string;
};

type OtherFeeValue = 'free' | '0.2%' | '1USDC' | '5USD' | '50USD';

const OTHER_FEES_CORE: { key: string; fee: OtherFeeValue }[] = [
  { key: 'walletCreation', fee: 'free' },
  { key: 'deposits', fee: 'free' },
  { key: 'walletToTrade', fee: 'free' },
  { key: 'tradeToWallet', fee: '1USDC' },
  { key: 'withdrawals', fee: 'free' },
];

/** Tier-3 neobank / card / IBAN rows — hidden when EXPO_PUBLIC_ENABLE_BANKING=false. */
const OTHER_FEES_BANKING: { key: string; fee: OtherFeeValue }[] = [
  { key: 'cardCreation', fee: 'free' },
  { key: 'cardMaintenance', fee: 'free' },
  { key: 'cardRefundRequests', fee: '1USDC' },
  { key: 'eurIbanTransferIn', fee: 'free' },
  { key: 'eurIbanTransferOut', fee: 'free' },
  { key: 'chfIbanTransferIn', fee: 'free' },
  { key: 'chfIbanTransferOut', fee: 'free' },
  { key: 'usdIbanTransferIn', fee: '5USD' },
  { key: 'usdIbanTransferOut', fee: '50USD' },
];

const OTHER_FEES = BANKING_ENABLED
  ? [...OTHER_FEES_CORE, ...OTHER_FEES_BANKING]
  : OTHER_FEES_CORE;

function formatOtherFeeValue(fee: OtherFeeValue, freeLabel: string): string {
  switch (fee) {
    case 'free':
      return freeLabel;
    case '1USDC':
      return '1 USDC';
    case '5USD':
      return '5 USD';
    case '50USD':
      return '50 USD';
    default:
      return fee;
  }
}

function formatRateRange(rates: number[], digits = 3): string {
  if (!rates.length) return '--';
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  if (Math.abs(max - min) < 1e-10) return formatFeePercent(min, digits);
  return `${formatFeePercent(min, digits)}–${formatFeePercent(max, digits)}`;
}

function sampleSymbols(assets: Asset[], max = 3): string {
  const names = assets.map((a) => a.symbol || a.coin).filter(Boolean);
  if (!names.length) return '—';
  const shown = names.slice(0, max);
  return names.length > max ? `${shown.join(', ')}...` : shown.join(', ');
}

function ratesForAssets(
  assets: Asset[],
  builderRate: number,
  kind: 'perp' | 'spot',
): { takers: number[]; makers: number[] } {
  const takers: number[] = [];
  const makers: number[] = [];
  for (const a of assets) {
    const protocol = computeProtocolFeeRates({
      takerRate: kind === 'spot' ? DEFAULT_SPOT_TAKER_RATE : DEFAULT_PERP_TAKER_RATE,
      makerRate: kind === 'spot' ? DEFAULT_SPOT_MAKER_RATE : DEFAULT_PERP_MAKER_RATE,
      kind,
      isHip3: kind === 'perp' && !!a.isHip3,
      deployerFeeScale: a.deployerFeeScale,
      growthMode: a.growthMode,
    });
    takers.push(protocol.takerRate + builderRate);
    makers.push(protocol.makerRate + builderRate);
  }
  return { takers, makers };
}

export default function FeesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { builderFeeRate } = useBuilderConfig();
  const spotBuilderRate = getSpotBuilderFeeTenthsBps() * 0.00001;

  const { data: hip3Data, isLoading: hip3Loading } = useQuery({
    queryKey: ['fees_page_hip3_assets'],
    queryFn: fetchAssets,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const { data: cryptoData, isLoading: cryptoLoading } = useQuery({
    queryKey: ['fees_page_crypto_assets'],
    queryFn: fetchCryptoAssets,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const tradingRows: FeeRow[] = useMemo(() => {
    const hip3 = hip3Data?.assets ?? [];
    const crypto = cryptoData?.assets ?? [];

    const majors = crypto.filter((a) => !a.isHip3 && a.category === 'crypto');
    const forex = [
      ...hip3.filter((a) => a.category === 'forex'),
      ...crypto.filter((a) => a.category === 'forex'),
    ];
    const equities = hip3.filter((a) => a.category === 'stock');
    const commodities = hip3.filter((a) => a.category === 'commodity');

    const majorRates = ratesForAssets(
      majors.length ? majors.slice(0, 8) : [{ isHip3: false } as Asset],
      builderFeeRate,
      'perp',
    );
    const forexRates = ratesForAssets(
      forex.length ? forex : [{ isHip3: false } as Asset],
      builderFeeRate,
      'perp',
    );
    const equityRates = ratesForAssets(
      equities.length ? equities : [{ isHip3: true, growthMode: true, deployerFeeScale: 1 } as Asset],
      builderFeeRate,
      'perp',
    );
    const commodityRates = ratesForAssets(
      commodities.length ? commodities : [{ isHip3: true, deployerFeeScale: 1 } as Asset],
      builderFeeRate,
      'perp',
    );
    const spotRates = ratesForAssets([{ isHip3: false } as Asset], spotBuilderRate, 'spot');

    return [
      {
        category: 'perpMajor',
        assets: sampleSymbols(majors.length ? majors : [{ symbol: 'BTC' } as Asset]),
        taker: formatRateRange(majorRates.takers),
        maker: formatRateRange(majorRates.makers),
      },
      {
        category: 'perpForex',
        assets: sampleSymbols(forex.length ? forex : [{ symbol: 'EUR' } as Asset]),
        taker: formatRateRange(forexRates.takers),
        maker: formatRateRange(forexRates.makers),
      },
      {
        category: 'perpEquities',
        assets: sampleSymbols(equities.length ? equities : [{ symbol: 'TSLA' } as Asset]),
        taker: formatRateRange(equityRates.takers),
        maker: formatRateRange(equityRates.makers),
      },
      {
        category: 'perpCommodities',
        assets: sampleSymbols(commodities.length ? commodities : [{ symbol: 'GOLD' } as Asset]),
        taker: formatRateRange(commodityRates.takers),
        maker: formatRateRange(commodityRates.makers),
      },
      {
        category: 'spotMajor',
        assets: 'BTC, ETH, SOL...',
        taker: formatRateRange(spotRates.takers),
        maker: formatRateRange(spotRates.makers),
      },
    ];
  }, [builderFeeRate, cryptoData?.assets, hip3Data?.assets, spotBuilderRate]);

  const startsAtLabel = useMemo(() => {
    // "Starts at" = cheapest fee shown in the table (taker or maker).
    // First % in a range string is the min ("0.033%" or "0.033%–0.060%").
    const mins = tradingRows
      .filter((r) => r.category.startsWith('perp'))
      .flatMap((r) => [r.taker, r.maker])
      .flatMap((label) => {
        const m = label.match(/([\d.]+)%/);
        return m ? [parseFloat(m[1])] : [];
      })
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!mins.length) return '0.045%';
    return `${Math.min(...mins).toFixed(3)}%`;
  }, [tradingRows]);

  const loading = hip3Loading || cryptoLoading;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('fees.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <LinearGradient
          colors={[`${colors.accent.gold}12`, `${colors.accent.purple}12`]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.compareBanner}
        >
          <View style={styles.compareRow}>
            <View style={styles.compareItem}>
              <Text style={styles.compareLabel}>{t('fees.binance')}</Text>
              <Text style={styles.compareFeeStrike}>0.100%</Text>
              <Text style={styles.compareNote}>{t('fees.standardUser')}</Text>
            </View>
            <View style={styles.compareDivider} />
            <View style={styles.compareItem}>
              <Text style={[styles.compareLabel, { color: colors.accent.gold }]}>HyperTrade</Text>
              <Text style={styles.compareFeeGood}>{startsAtLabel}</Text>
              <Text style={[styles.compareNote, { color: colors.accent.gold }]}>{t('fees.startsAt')}</Text>
            </View>
          </View>
        </LinearGradient>

        <Text style={styles.sectionNote}>{t('fees.tradingFeesNote')}</Text>

        <Text style={styles.sectionTitle}>{t('fees.tradingFees')}</Text>

        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, styles.cellWide]}>{t('fees.market')}</Text>
          <Text style={styles.tableHeaderCell}>{t('fees.taker')}</Text>
          <Text style={styles.tableHeaderCell}>{t('fees.maker')}</Text>
        </View>

        {loading && !hip3Data && !cryptoData ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.accent.gold} />
          </View>
        ) : (
          tradingRows.map((row, idx) => (
            <View key={row.category} style={[styles.tableRow, idx % 2 === 0 && styles.tableRowAlt]}>
              <View style={styles.cellWide}>
                <Text style={styles.cellLabel}>{t(`fees.categories.${row.category}`)}</Text>
                <Text style={styles.cellAssets}>{row.assets}</Text>
              </View>
              <View style={styles.cellNarrow}>
                <Text style={styles.cellFee}>{row.taker}</Text>
              </View>
              <View style={styles.cellNarrow}>
                <Text style={styles.cellFee}>{row.maker}</Text>
              </View>
            </View>
          ))
        )}

        {/*<View style={styles.discountedNote}>
          <View style={styles.discountedBadge}>
            <Ionicons name="flash-outline" size={12} color={colors.status.success} />
            <Text style={styles.discountedBadgeText}>{t('fees.discounted')}</Text>
          </View>
          <Text style={styles.discountedText}>{t('fees.discountedNote')}</Text>
        </View>
*/}
        <Text style={styles.sectionTitle}>{t('fees.otherFees')}</Text>

        {OTHER_FEES.map((item, idx) => (
          <View key={item.key} style={[styles.otherFeeRow, idx % 2 === 0 && styles.tableRowAlt]}>
            <Text style={styles.otherFeeLabel}>{t(`fees.other.${item.key}`)}</Text>
            <View style={styles.otherFeeBadge}>
              <Text style={[
                styles.otherFeeValue,
                item.fee === 'free' && { color: colors.status.success },
              ]}>
                {formatOtherFeeValue(item.fee, t('fees.free'))}
              </Text>
            </View>
          </View>
        ))}

        <View style={styles.rewardsNote}>
          <Ionicons name="trophy-outline" size={16} color={colors.accent.gold} />
          <Text style={styles.rewardsNoteText}>{t('fees.rewardsNote')}</Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text.primary },
  backButton: { padding: 6 },
  headerSpacer: { width: 28 },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingBottom: 56 },

  compareBanner: {
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}20`,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  compareItem: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  compareDivider: {
    width: 1,
    height: 48,
    backgroundColor: colors.border.primary,
    marginHorizontal: 8,
  },
  compareLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  compareFeeStrike: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text.tertiary,
    textDecorationLine: 'line-through',
  },
  compareFeeGood: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.accent.gold,
  },
  compareNote: {
    fontSize: 11,
    color: colors.text.tertiary,
  },

  sectionNote: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.text.secondary,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 10,
    marginTop: 8,
  },

  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  tableHeaderCell: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
    textAlign: 'right',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  tableRowAlt: {
    backgroundColor: colors.background.secondary,
  },
  cellWide: { flex: 2.2 },
  cellNarrow: { flex: 1, alignItems: 'flex-end' },
  cellLabel: { fontSize: 13, fontWeight: '700', color: colors.text.primary },
  cellAssets: { fontSize: 11, color: colors.text.tertiary, marginTop: 2 },
  cellFee: { fontSize: 12, fontWeight: '700', color: colors.text.primary, textAlign: 'right' },

  loadingRow: {
    paddingVertical: 28,
    alignItems: 'center',
  },

  discountedNote: {
    marginTop: 14,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: `${colors.status.success}10`,
    borderWidth: 1,
    borderColor: `${colors.status.success}25`,
    gap: 8,
  },
  discountedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
  },
  discountedBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.status.success,
    textTransform: 'uppercase',
  },
  discountedText: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.text.secondary,
  },

  otherFeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  otherFeeLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.text.primary,
    paddingRight: 12,
  },
  otherFeeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  otherFeeValue: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.primary,
  },

  rewardsNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: `${colors.accent.gold}10`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}25`,
  },
  rewardsNoteText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: colors.text.secondary,
  },
});
