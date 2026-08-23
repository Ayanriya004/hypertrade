import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';

const HYPERTRADE_X_URL = 'https://x.com/HyperTrade_X';

/** Full-width strip — same chrome as the demo-mode top banner. */
export function BankMaintenanceBanner() {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={styles.strip}
      onPress={() => Linking.openURL(HYPERTRADE_X_URL)}
      activeOpacity={0.85}
      accessibilityRole="link"
      accessibilityLabel={t('bankApply.maintenanceFollowX')}
    >
      <View style={styles.cluster}>
        <Text
          style={styles.text}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.82}
        >
          {t('bankApply.maintenanceBody')}
        </Text>
        <Ionicons name="open-outline" size={12} color={colors.accent.gold} style={styles.icon} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: `${colors.accent.gold}1F`,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.accent.gold}60`,
  },
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    maxWidth: '100%',
    minWidth: 0,
  },
  icon: {
    flexShrink: 0,
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
