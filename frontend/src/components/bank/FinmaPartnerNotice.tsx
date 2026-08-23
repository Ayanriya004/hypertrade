/**
 * FINMA licensing attribution for UR / SR Saphirstein AG (fintech provider).
 */
import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';

export const FINMA_LOGO = require('../../../assets/images/finma-logo.webp');

export const FINTECH_PROVIDER_NAME = 'SR Saphirstein AG';

type FinmaPartnerNoticeProps = {
  /** Tighter spacing when stacked under another line of copy. */
  compact?: boolean;
};

export function FinmaPartnerNotice({ compact = false }: FinmaPartnerNoticeProps) {
  const { t } = useTranslation();

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={styles.row}>
        <Image
          source={FINMA_LOGO}
          style={[styles.logo, compact && styles.logoCompact]}
          resizeMode="contain"
          accessibilityLabel="FINMA"
        />
        <Text style={[styles.caption, compact && styles.captionCompact]}>
          {t('bankApply.finma.caption', 'SR Saphirstein AG · FINMA-licensed')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 16,
    maxWidth: '100%',
  },
  wrapCompact: {
    marginTop: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    maxWidth: 320,
  },
  logo: {
    width: 36,
    height: 36,
    flexShrink: 0,
  },
  logoCompact: {
    width: 32,
    height: 32,
  },
  caption: {
    flexShrink: 1,
    fontSize: 10,
    lineHeight: 14,
    color: colors.text.muted,
    fontWeight: '500',
    textAlign: 'center',
  },
  captionCompact: {
    fontSize: 10,
    lineHeight: 13,
  },
});
