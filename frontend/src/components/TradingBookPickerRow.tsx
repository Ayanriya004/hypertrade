import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import type { AiAgentView } from '../lib/api';
import { bookAgentStatusPillStyle } from '../lib/aiAgentStatusLabel';

export type TradingBookPickerOption = {
  id: 'master' | string;
  name: string;
  liveCount?: number;
  statusLabel?: string | null;
  statusKind?: AiAgentView['status'];
};

export function TradingBookPickerRow({
  option,
  active,
}: {
  option: TradingBookPickerOption;
  active: boolean;
}) {
  const liveCount = option.liveCount ?? 0;
  return (
    <>
      {option.id === 'master' ? (
        <Ionicons
          name="wallet-outline"
          size={16}
          color={active ? colors.accent.gold : colors.text.secondary}
        />
      ) : (
        <MaterialCommunityIcons
          name="robot-outline"
          size={16}
          color={active ? colors.accent.gold : colors.text.secondary}
        />
      )}
      <View style={styles.main}>
        <View style={styles.nameWrap}>
          <Text
            style={[styles.name, active && styles.nameActive]}
            numberOfLines={1}
          >
            {option.name}
          </Text>
        </View>
        {liveCount >= 1 ? (
          <Text style={[styles.count, active && styles.countActive]} numberOfLines={1}>
            ({liveCount})
          </Text>
        ) : null}
        {option.statusLabel ? (
          <View style={[styles.pill, bookAgentStatusPillStyle(option.statusKind)]}>
            <Text style={styles.pillText} numberOfLines={1}>
              {option.statusLabel}
            </Text>
          </View>
        ) : null}
      </View>
      {active ? (
        <Ionicons name="checkmark" size={16} color={colors.accent.gold} />
      ) : (
        <View style={styles.checkSpacer} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nameWrap: {
    flexShrink: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  nameActive: {
    color: colors.accent.gold,
  },
  count: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: colors.text.tertiary,
  },
  countActive: {
    color: colors.accent.gold,
  },
  pill: {
    flexShrink: 0,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
  pillText: {
    color: colors.text.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  checkSpacer: {
    width: 16,
    height: 16,
  },
});
