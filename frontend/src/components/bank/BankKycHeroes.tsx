/**
 * Hero visuals for pre-KYC marketing (Cash + Card tabs).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { HypertradeCardVisual } from './HypertradeCardVisual';
import { CircleCountryFlag } from './CircleCountryFlag';

/** Stack of currency disks hinting at multi-currency IBAN benefits. */
export function CashHero() {
  const items: { sym: string; countryIso: string; tint: string }[] = [
    { sym: '$', countryIso: 'US', tint: colors.accent.gold },
    { sym: '€', countryIso: 'EU', tint: colors.accent.purple },
    { sym: '₣', countryIso: 'CH', tint: colors.status.success },
    { sym: '¥', countryIso: 'CN', tint: colors.status.error },
  ];
  return (
    <View style={cashHeroStyles.row}>
      {items.map((it, idx) => (
        <View
          key={it.countryIso}
          style={[
            cashHeroStyles.disk,
            { marginLeft: idx === 0 ? 0 : -18, zIndex: items.length - idx },
          ]}
        >
          <LinearGradient
            colors={[`${it.tint}40`, `${it.tint}10`]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={cashHeroStyles.diskGradient}
          >
            <Text style={[cashHeroStyles.diskSym, { color: it.tint }]}>{it.sym}</Text>
            <CircleCountryFlag
              countryCode={it.countryIso}
              size={22}
              style={cashHeroStyles.diskFlag}
            />
          </LinearGradient>
        </View>
      ))}
    </View>
  );
}

const cashHeroStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  disk: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  diskGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  diskSym: {
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 32,
  },
  diskFlag: {
    marginTop: 4,
  },
});

/** Compact HyperTrade card preview for the Card-tab hero. */
export function CardHero() {
  return (
    <View style={cardHeroStyles.wrap}>
      <HypertradeCardVisual maxWidth={240} hero />
    </View>
  );
}

const cardHeroStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: 4,
  },
});
