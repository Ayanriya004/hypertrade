import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { colors } from '../theme/colors';
import { fetchAlphaMacroSnapshot, fetchAlphaStockInfo } from '../lib/alphaVantage';

type StockInfoPanelProps = {
  symbol: string;
  category: string;
};

const formatNumber = (value?: string | number | null, digits = 2) => {
  if (value === null || value === undefined) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return '--';
  return num.toLocaleString('en-US', { maximumFractionDigits: digits });
};

const formatCompactUsd = (value?: string | number | null) => {
  if (value === null || value === undefined) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return '--';
  if (Math.abs(num) >= 1_000_000_000_000) return `$${(num / 1_000_000_000_000).toFixed(2)}T`;
  if (Math.abs(num) >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
};

const formatDate = (value?: string | null) => {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text style={styles.infoValue}>{value}</Text>
  </View>
);

export const StockInfoPanel = ({ symbol, category }: StockInfoPanelProps) => {
  const isStock = category === 'stock' && !!symbol;

  const stockQuery = useQuery({
    queryKey: ['alpha_stock_info', symbol],
    queryFn: () => fetchAlphaStockInfo(symbol),
    enabled: isStock,
    staleTime: 12 * 60 * 60 * 1000,
  });

  const macroQuery = useQuery({
    queryKey: ['alpha_macro_snapshot'],
    queryFn: fetchAlphaMacroSnapshot,
    enabled: isStock,
    staleTime: 12 * 60 * 60 * 1000,
  });

  const overview = stockQuery.data?.overview ?? {};
  const latestBalance = stockQuery.data?.latestBalanceSheet ?? null;
  const latestCash = stockQuery.data?.latestCashFlow ?? null;

  const macroSnapshot = useMemo(() => {
    if (!macroQuery.data) return null;
    const { gdp, cpi, inflation, unemployment } = macroQuery.data;
    return { gdp, cpi, inflation, unemployment };
  }, [macroQuery.data]);

  if (!isStock) return null;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Company Snapshot</Text>
        {(stockQuery.isLoading || macroQuery.isLoading) && (
          <ActivityIndicator size="small" color={colors.accent.gold} />
        )}
      </View>

      {stockQuery.isError ? (
        <Text style={styles.errorText}>Fundamentals unavailable right now.</Text>
      ) : (
        <>
          <InfoRow
            label="Next Earnings"
            value={formatDate(stockQuery.data?.nextEarningsDate ?? undefined)}
          />
          <InfoRow
            label="Market Cap"
            value={formatCompactUsd(overview.MarketCapitalization)}
          />
          <InfoRow
            label="Total Assets (FY)"
            value={formatCompactUsd(latestBalance?.totalAssets)}
          />
          <InfoRow
            label="Operating Cash Flow (FY)"
            value={formatCompactUsd(latestCash?.operatingCashflow)}
          />
        </>
      )}

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Macro Info</Text>
      {macroQuery.isError ? (
        <Text style={styles.errorText}>Macro data unavailable.</Text>
      ) : (
        <>
          <InfoRow
            label="Real GDP (latest)"
            value={macroSnapshot?.gdp ? formatNumber(macroSnapshot.gdp.value, 2) : '--'}
          />
          <InfoRow
            label="CPI (latest)"
            value={macroSnapshot?.cpi ? formatNumber(macroSnapshot.cpi.value, 2) : '--'}
          />
          <InfoRow
            label="Inflation (latest)"
            value={macroSnapshot?.inflation ? `${formatNumber(macroSnapshot.inflation.value, 2)}%` : '--'}
          />
          <InfoRow
            label="Unemployment (latest)"
            value={macroSnapshot?.unemployment ? `${formatNumber(macroSnapshot.unemployment.value, 2)}%` : '--'}
          />
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.card,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  infoLabel: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '700',
  },
  infoValue: {
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border.primary,
    marginVertical: 10,
  },
  errorText: {
    color: colors.text.tertiary,
    fontSize: 12,
    paddingVertical: 6,
  },
});
