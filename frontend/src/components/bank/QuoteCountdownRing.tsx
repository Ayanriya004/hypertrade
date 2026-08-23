/**
 * QuoteCountdownRing — small circular timer that depletes as a live quote
 * ages, used by quoted flows (withdraw today; multi-asset Add Money later).
 *
 * Pairs with `useLiveQuote` (hooks/useLiveQuote.ts): pass its `fraction`,
 * `secondsLeft`, and `refreshing`. Shows a spinner while a re-quote is in
 * flight, otherwise the whole-second count remaining; turns red in the final
 * seconds before auto-refresh fires.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { colors } from '../../theme/colors';

export function QuoteCountdownRing({
  fraction,
  seconds,
  refreshing,
  warnAtSeconds = 3,
  size = 30,
  stroke = 3,
}: {
  /** Remaining fraction of the TTL, 0..1 (1 = fresh). */
  fraction: number;
  /** Seconds remaining (for the numeric label). */
  seconds: number;
  /** True while a re-quote is in flight. */
  refreshing: boolean;
  warnAtSeconds?: number;
  size?: number;
  stroke?: number;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, fraction));
  const offset = circumference * (1 - clamped);
  const ringColor = seconds <= warnAtSeconds ? '#e57373' : colors.accent.gold;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={colors.border.primary} strokeWidth={stroke} fill="none"
        />
        {!refreshing ? (
          <Circle
            cx={size / 2} cy={size / 2} r={radius}
            stroke={ringColor} strokeWidth={stroke} fill="none"
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      {refreshing ? (
        <ActivityIndicator size="small" color={colors.accent.gold} />
      ) : (
        <Text style={styles.ringText}>{Math.ceil(seconds)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ringText: { fontSize: 11, fontWeight: '800', color: colors.text.secondary },
});
