import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { SvgProps } from 'react-native-svg';
import * as CircleFlags from 'react-native-svg-circle-country-flags';
import { countryIsoToFlagKey, currencyToCountryIso } from '../../lib/bankCircleFlags';

type FlagComponent = React.ComponentType<SvgProps>;

const FLAG_MAP = CircleFlags as unknown as Record<string, FlagComponent>;

export type CircleCountryFlagProps = {
  /** ISO 3166-1 alpha-2 (e.g. `CH`, `US`) or `EU`. */
  countryCode: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

export function CircleCountryFlag({
  countryCode,
  size = 24,
  style,
}: CircleCountryFlagProps) {
  const key = countryIsoToFlagKey(countryCode);
  const Flag = FLAG_MAP[key];

  if (!Flag) {
    return (
      <View
        style={[
          styles.fallback,
          { width: size, height: size, borderRadius: size / 2 },
          style,
        ]}
      >
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.45) }]}>🌐</Text>
      </View>
    );
  }

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Flag width={size} height={size} />
    </View>
  );
}

export type CircleCurrencyFlagProps = {
  currencyCode: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

export function CircleCurrencyFlag({
  currencyCode,
  size = 24,
  style,
}: CircleCurrencyFlagProps) {
  const iso = currencyToCountryIso(currencyCode);
  if (!iso) {
    return (
      <View
        style={[
          styles.fallback,
          { width: size, height: size, borderRadius: size / 2 },
          style,
        ]}
      >
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.45) }]}>💱</Text>
      </View>
    );
  }
  return <CircleCountryFlag countryCode={iso} size={size} style={style} />;
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  fallbackText: {
    lineHeight: undefined,
  },
});
