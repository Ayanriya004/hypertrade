import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import { BouncingDots } from '../BouncingDots';

type SpendableBalanceLineProps = {
  label: string;
  currency: string;
  amountStr: string;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
};

export function SpendableBalanceLine({
  label,
  currency,
  amountStr,
  loading,
  error,
  onRetry,
}: SpendableBalanceLineProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}: </Text>
      {loading ? (
        <BouncingDots dotSize={4} color={colors.text.tertiary} pulse />
      ) : error ? (
        <TouchableOpacity onPress={onRetry} hitSlop={8} disabled={!onRetry}>
          <Text style={styles.retry}>
            {t('bankSheet.balanceRetry', { defaultValue: 'Tap to retry' })}
          </Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.value}>
          {amountStr} {currency}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '62%',
    justifyContent: 'flex-end',
  },
  label: {
    fontSize: 11,
    color: colors.text.tertiary,
  },
  value: {
    fontSize: 11,
    color: colors.text.tertiary,
  },
  retry: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.gold,
  },
});
