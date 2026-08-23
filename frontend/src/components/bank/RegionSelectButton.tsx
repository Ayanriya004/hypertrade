/**
 * Globe / flag control for residence selection on bank apply & KYC flows.
 */
import React from 'react';
import { View, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { CircleCountryFlag } from './CircleCountryFlag';
import type { UrCountry } from '../../lib/urSupportedCountries';

const GLOBE_ICON = require('../../../assets/images/globe-icon.webp');

const ICON_SIZE = 40;
const BADGE_SIZE = 16;

type RegionSelectButtonProps = {
  selectedCountry: UrCountry | null;
  onPress: () => void;
};

export function RegionSelectButton({ selectedCountry, onPress }: RegionSelectButtonProps) {
  return (
    <TouchableOpacity activeOpacity={0.75} style={styles.button} onPress={onPress}>
      <View style={styles.iconWrap}>
        <View style={styles.iconClip}>
          {selectedCountry ? (
            <CircleCountryFlag countryCode={selectedCountry.code} size={ICON_SIZE} />
          ) : (
            <Image source={GLOBE_ICON} style={styles.globe} resizeMode="cover" />
          )}
        </View>
        {selectedCountry ? (
          <View style={[styles.badge, styles.badgeOk]}>
            <Ionicons name="checkmark" size={10} color={colors.background.primary} />
          </View>
        ) : null}
      </View>
      <Ionicons name="chevron-down" size={14} color={colors.text.tertiary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  iconWrap: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    position: 'relative',
  },
  iconClip: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: colors.background.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  globe: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.background.primary,
    zIndex: 1,
  },
  badgeOk: {
    backgroundColor: colors.status.success,
  },
});
