/**
 * Primary CTA shown on the pre-KYC bank screens when the user hasn't picked a
 * residence yet. Prompts them to pick their country of residence (opens the
 * residence sheet) so they can see whether their country is supported — instead
 * defaulting to a misleading "not available, notify me" state.
 */
import React from 'react';
import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { BouncingDots } from '../BouncingDots';

type SelectRegionCtaProps = {
  onPress: () => void;
  compact?: boolean;
};

/** Same gold CTA shell with bouncing dots — used while waitlist interest is loading. */
export function BankApplyCtaLoading({ compact }: { compact?: boolean }) {
  return (
    <View style={compact ? styles.touchCompact : styles.touch}>
      <LinearGradient
        colors={[colors.accent.gold, colors.accent.purple]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.btn, compact && styles.btnCompact]}
      >
        <BouncingDots color={colors.background.primary} dotSize={4} />
      </LinearGradient>
    </View>
  );
}

export function SelectRegionCta({ onPress, compact }: SelectRegionCtaProps) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={compact ? styles.touchCompact : styles.touch}
    >
      <LinearGradient
        colors={[colors.accent.gold, colors.accent.purple]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.btn, compact && styles.btnCompact]}
      >
        <Ionicons name="location-outline" size={18} color={colors.background.primary} />
        <Text
          style={[styles.btnText, compact && styles.btnTextCompact]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.82}
        >
          {t('bankApply.selectRegionCta', 'Residence country')}
        </Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  touch: {
    alignSelf: 'stretch',
    flex: 1,
  },
  touchCompact: {
    flex: 1,
    alignSelf: 'stretch',
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  btnCompact: {
    flex: 1,
    width: '100%',
    minHeight: 46,
    paddingHorizontal: 12,
  },
  btnText: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
    letterSpacing: 0.2,
  },
  btnTextCompact: {
    fontSize: 13,
    lineHeight: 17,
  },
});
