/**
 * AddToMobileWalletSheet — manual add-to-wallet instructions (Path B).
 *
 * Shown after the card is revealed so the user can copy PAN/expiry/CVV and
 * enter them in Apple Wallet / Google Wallet. Push provisioning can replace
 * this sheet later without changing the platform resolver.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import Toast from 'react-native-toast-message';

import { colors } from '../../theme/colors';
import {
  openMobileWalletApp,
  type MobileWalletProvider,
} from '../../lib/mobileWallet';

export interface AddToMobileWalletSheetProps {
  visible: boolean;
  onClose: () => void;
  provider: MobileWalletProvider;
  cardHolder?: string | null;
  /** Card reveal still in progress — show loader, keep steps dimmed. */
  preparing?: boolean;
}

export function AddToMobileWalletSheet({
  visible,
  onClose,
  provider,
  cardHolder,
  preparing = false,
}: AddToMobileWalletSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const walletName =
    provider === 'apple_pay'
      ? t('cash.mobileWallet.walletNameApple', 'Apple Wallet')
      : provider === 'google_pay'
        ? t('cash.mobileWallet.walletNameGoogle', 'Google Wallet')
        : t('cash.mobileWallet.walletNameAlipay', 'Alipay');

  const title =
    provider === 'apple_pay'
      ? t('cash.mobileWallet.sheetTitleApple', 'Add to Apple Wallet')
      : provider === 'google_pay'
        ? t('cash.mobileWallet.sheetTitleGoogle', 'Add to Google Wallet')
        : t('cash.mobileWallet.sheetTitleAlipay', 'Add to Alipay');

  const steps =
    provider === 'alipay'
      ? [
          t(
            'cash.mobileWallet.stepReveal',
            'Your card details are shown on the card above — tap the copy icon next to the number if you need it.',
          ),
          t(
            'cash.mobileWallet.stepAlipayNav',
            'In Alipay home screen, click Add Card → Enter Card Details → Add.',
          ),
          t(
            'cash.mobileWallet.stepAlipayAdd',
            'Enter your Mastercard number, expiry, and CVV{{holder}}. Complete passport verification if prompted.',
            {
              holder: cardHolder
                ? t('cash.mobileWallet.stepHolder', ', and name: {{name}}', { name: cardHolder })
                : '',
            },
          ),
          t(
            'cash.mobileWallet.stepVerify',
            'Complete any verification steps from your bank or wallet provider.',
          ),
        ]
      : [
          t(
            'cash.mobileWallet.stepReveal',
            'Your card details are shown on the card above — tap the copy icon next to the number if you need it.',
          ),
          t(
            'cash.mobileWallet.stepOpen',
            'Open {{wallet}} on your phone.',
            { wallet: walletName },
          ),
          t(
            'cash.mobileWallet.stepAdd',
            'Choose Add card (or +) and enter your card number, expiry, and CVV{{holder}}.',
            {
              holder: cardHolder
                ? t('cash.mobileWallet.stepHolder', ', and name: {{name}}', { name: cardHolder })
                : '',
            },
          ),
          t(
            'cash.mobileWallet.stepVerify',
            'Complete any verification steps from your bank or wallet provider.',
          ),
        ];

  const handleOpenWallet = async () => {
    if (preparing) return;
    const opened = await openMobileWalletApp(provider);
    if (!opened) {
      Toast.show({
        type: 'info',
        text1: t('cash.mobileWallet.openFailedTitle', "Couldn't open {{wallet}}", { wallet: walletName }),
        text2: t(
          'cash.mobileWallet.openFailedSubtitle',
          'Open it from your home screen, then add your card manually.',
        ),
        visibilityTime: 3200,
      });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.grabber} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>
          {preparing
            ? t(
                'cash.mobileWallet.preparingDetails',
                'Loading your card details — confirm the wallet signature if prompted.',
              )
            : t('cash.mobileWallet.sheetSubtitle', 'Enter your virtual card details')}
        </Text>

        {preparing ? (
          <View style={styles.preparingRow}>
            <ActivityIndicator color={colors.text.primary} />
            <Text style={styles.preparingText}>
              {t('cash.mobileWallet.preparingHint', 'Revealing card on the image above…')}
            </Text>
          </View>
        ) : null}

        <View style={[styles.steps, preparing && styles.stepsDimmed]}>
          {steps.map((step, idx) => (
            <View key={idx} style={styles.stepRow}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepBadgeText}>{idx + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {Platform.OS !== 'web' ? (
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.primaryBtn, preparing && styles.primaryBtnDisabled]}
            disabled={preparing}
            onPress={() => void handleOpenWallet()}
          >
            <Ionicons name="open-outline" size={18} color={colors.background.primary} />
            <Text style={styles.primaryBtnText}>
              {t('cash.mobileWallet.openWallet', 'Open {{wallet}}', { wallet: walletName })}
            </Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity activeOpacity={0.8} style={styles.secondaryBtn} onPress={onClose}>
          <Text style={styles.secondaryBtnText}>{t('common.done', 'Done')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.background.elevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
    marginBottom: 14,
  },
  title: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.text.tertiary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    marginBottom: 16,
  },
  preparingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
  },
  preparingText: {
    flex: 1,
    color: colors.text.secondary,
    fontSize: 14,
    lineHeight: 20,
  },
  steps: {
    gap: 12,
    marginBottom: 18,
  },
  stepsDimmed: {
    opacity: 0.45,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.background.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepBadgeText: {
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    color: colors.text.secondary,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.text.primary,
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 10,
  },
  primaryBtnDisabled: {
    opacity: 0.45,
  },
  primaryBtnText: {
    color: colors.background.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  secondaryBtnText: {
    color: colors.text.secondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
