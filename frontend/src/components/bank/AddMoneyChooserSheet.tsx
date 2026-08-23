/**
 * AddMoneyChooserSheet — small bottom sheet that fronts the two ways money
 * moves in or out of a Live user's HyperTrade account. Two modes, same
 * two-card layout (digital rail vs bank rail) so Add and Withdraw feel
 * symmetric:
 *
 * mode="add" (default):
 *   1. Digital Assets — USDC on Arbitrum → USD24 on Mantle via EIP-7702 +
 *      Ambire batched execute. Instant (~30s), gasless (we sponsor LZ fee),
 *      lives in `DigitalDepositBottomSheet.tsx`.
 *   2. Bank transfer — user's issued IBAN(s) act as a deposit
 *      address. UR mints the corresponding fiat OFT (USD24/EUR24/CHF24)
 *      on Mantle when funds settle. Takes 1–2 business days. Lives in
 *      `BankTransferBottomSheet.tsx`.
 *
 * mode="withdraw":
 *   1. Digital Assets — fiat (USD24/EUR24/CHF24) → USDC back to the user's
 *      wallet via gasless EIP-2612 permit onramp (`WithdrawBottomSheet.tsx`).
 *   2. Bank transfer — fiat out to an external bank account (cash pay-out,
 *      UR §6) via `SendBottomSheet.tsx`.
 *
 * Mirrors UR's own mobile pattern (popup menu beside the Add button). We
 * use a thin bottom sheet so the option cards can be larger / more
 * descriptive than an inline popover would allow.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Animated,
  Easing,
  Platform,
  PanResponder,
  Image,
  type ImageSourcePropType,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import { BANK_DIGITAL_WITHDRAW_PAUSED } from '../../lib/bankKycPause';

const USDC_ICON = require('../../../assets/images/usdc-icon.webp');

export type AddMoneyChoice = 'digital' | 'cash';

export interface AddMoneyChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (choice: AddMoneyChoice) => void;
  /** Set to false if the user has no IBANs issued yet — disables the Cash row. */
  cashAvailable?: boolean;
  /** 'add' (default) = fund the account; 'withdraw' = move cash out. Picks
   *  the i18n copy; routing of the chosen rail is the parent's job. */
  mode?: 'add' | 'withdraw';
}

const SHEET_TRAVEL = 600;

export function AddMoneyChooserSheet({
  visible,
  onClose,
  onPick,
  cashAvailable = true,
  mode = 'add',
}: AddMoneyChooserSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);

  const finishClose = useCallback(() => {
    setMounted(false);
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: SHEET_TRAVEL,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      closingRef.current = false;
      if (finished) finishClose();
    });
  }, [slideAnim, backdropAnim, finishClose]);

  const animateOpen = useCallback(() => {
    slideAnim.setValue(SHEET_TRAVEL);
    backdropAnim.setValue(0);
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim, backdropAnim]);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    if (visible && !wasVisible) {
      closingRef.current = false;
      setMounted(true);
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
        onPanResponderMove: (_, g) => {
          if (g.dy > 0) slideAnim.setValue(g.dy);
          else slideAnim.setValue(g.dy * 0.25);
        },
        onPanResponderRelease: (_, g) => {
          if (g.dy > 60 || g.vy > 0.45) animateClose();
          else {
            Animated.spring(slideAnim, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 5,
              speed: 18,
            }).start();
          }
        },
      }),
    [slideAnim, animateClose],
  );

  const handlePick = useCallback(
    (choice: AddMoneyChoice) => {
      if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
      // Close first, hand off to parent after the slide-out so the next
      // sheet opens against an empty stage.
      animateClose();
      setTimeout(() => onPick(choice), 220);
    },
    [animateClose, onPick],
  );

  const balanceLabels = useMemo(
    () => ({
      walletBalance: t('deposit.walletBalance'),
      bankBalance: t('deposit.bankBalance'),
    }),
    [t],
  );

  if (!mounted) return null;

  const isWithdraw = mode === 'withdraw';
  // Key prefix per mode; both blocks share the same shape in every locale.
  const p = isWithdraw ? 'withdrawChooser' : 'addMoney.chooser';
  const digitalWithdrawPaused = isWithdraw && BANK_DIGITAL_WITHDRAW_PAUSED;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={animateClose}
    >
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] }) },
          ]}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={animateClose} />
        </Animated.View>

        <View style={styles.sheetAnchor} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.sheetWrap,
              { transform: [{ translateY: slideAnim }] },
            ]}
          >
            <SafeAreaView edges={['bottom']} style={styles.safeArea}>
              <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom * 0.2 }]}>
                <View {...panResponder.panHandlers} style={styles.handleArea}>
                  <View style={styles.handle} />
                </View>
                <Text style={styles.title}>{t(`${p}.title`)}</Text>
              <Text style={styles.subtitle}>
                {t(`${p}.subtitle`)}
              </Text>

              <ChoiceCard
                gradient={['#1a2e3a', '#0f1b24']}
                accent={colors.accent.gold}
                imageIcon={USDC_ICON}
                title={t(`${p}.digital.title`)}
                subtitle={t(`${p}.digital.subtitle`, balanceLabels)}
                badge={
                  digitalWithdrawPaused
                    ? t('withdrawChooser.digital.upgradeBadge', 'Upgrade')
                    : t(`${p}.digital.badge`)
                }
                badgeEmphasized={digitalWithdrawPaused}
                secondaryBadge={
                  digitalWithdrawPaused
                    ? undefined
                    : t('addMoney.chooser.digital.moreAssets')
                }
                onPress={() => handlePick('digital')}
                disabled={digitalWithdrawPaused}
              />

              <View style={styles.gap} />

              <ChoiceCard
                gradient={['#2a1f3a', '#181024']}
                accent={colors.accent.purple}
                faIcon="bank"
                title={t(`${p}.cash.title`)}
                subtitle={t(`${p}.cash.subtitle`, balanceLabels)}
                badge={t(`${p}.cash.badge`)}
                footnote={
                  isWithdraw ? undefined : t('addMoney.chooser.cash.footnote')
                }
                onPress={() => handlePick('cash')}
                disabled={!cashAvailable}
                disabledLabel={cashAvailable ? undefined : t(`${p}.cash.disabled`)}
              />

              <TouchableOpacity style={styles.cancelRow} onPress={animateClose}>
                <Text style={styles.cancelText}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              </View>
            </SafeAreaView>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Choice card
// --------------------------------------------------------------------------- //

function ChoiceCard({
  gradient,
  accent,
  icon,
  faIcon,
  imageIcon,
  title,
  subtitle,
  badge,
  badgeEmphasized,
  secondaryBadge,
  footnote,
  onPress,
  disabled,
  disabledLabel,
}: {
  gradient: [string, string];
  accent: string;
  icon?: keyof typeof Ionicons.glyphMap;
  faIcon?: keyof typeof FontAwesome.glyphMap;
  imageIcon?: ImageSourcePropType;
  title: string;
  subtitle: string;
  badge: string;
  /** Keep the primary badge readable when the rest of the card is muted. */
  badgeEmphasized?: boolean;
  secondaryBadge?: string;
  footnote?: string;
  onPress: () => void;
  disabled?: boolean;
  disabledLabel?: string;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={styles.cardOuter}
    >
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.card}
      >
        <View style={[styles.cardBody, disabled && styles.cardMuted]}>
          <View style={[styles.iconCircle, { borderColor: `${accent}55`, backgroundColor: `${accent}18` }]}>
            {imageIcon ? (
              <Image source={imageIcon} style={styles.usdcCircleIcon} resizeMode="contain" />
            ) : faIcon ? (
              <FontAwesome name={faIcon} size={20} color={accent} />
            ) : (
              <Ionicons name={icon!} size={22} color={accent} />
            )}
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={styles.cardTitle}>{title}</Text>
            <Text style={styles.cardSubtitle} numberOfLines={2}>
              {subtitle}
            </Text>
            {!badgeEmphasized ? (
              <View style={styles.badgeRow}>
                <View style={[styles.badge, { borderColor: `${accent}55` }]}>
                  <Text style={[styles.badgeText, { color: accent }]}>{badge}</Text>
                </View>
                {secondaryBadge ? (
                  <View style={[styles.badge, { borderColor: `${accent}55` }]}>
                    <Text style={[styles.badgeText, { color: accent }]}>{secondaryBadge}</Text>
                  </View>
                ) : null}
                {disabled && disabledLabel ? (
                  <Text style={styles.disabledHint}>· {disabledLabel}</Text>
                ) : null}
              </View>
            ) : null}
            {footnote ? (
              <Text style={styles.cardFootnote} numberOfLines={2}>
                {footnote}
              </Text>
            ) : null}
          </View>
          {!disabled ? (
            <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
          ) : null}
        </View>
        {badgeEmphasized ? (
          <View style={styles.emphasizedBadgeRow}>
            <View
              style={[
                styles.badge,
                styles.badgeEmphasized,
                { backgroundColor: `${accent}28`, borderColor: accent },
              ]}
            >
              <Text style={[styles.badgeText, { color: accent }]}>{badge}</Text>
            </View>
            {disabledLabel ? <Text style={styles.disabledHint}>{disabledLabel}</Text> : null}
          </View>
        ) : null}
      </LinearGradient>
    </TouchableOpacity>
  );
}

// --------------------------------------------------------------------------- //
// Styles
// --------------------------------------------------------------------------- //

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheetAnchor: { flex: 1, justifyContent: 'flex-end', width: '100%' },
  sheetWrap: { width: '100%' },
  safeArea: { backgroundColor: 'transparent' },
  handleArea: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginBottom: 4,
  },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: colors.text.tertiary,
    marginBottom: 18,
  },
  cardOuter: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  card: {
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 16,
    gap: 10,
  },
  cardBody: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardMuted: {
    opacity: 0.5,
  },
  emphasizedBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 58,
  },
  gap: { height: 12 },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  usdcCircleIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
  },
  cardSubtitle: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeEmphasized: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  cardFootnote: {
    fontSize: 10,
    color: colors.text.tertiary,
    fontWeight: '600',
    marginTop: 5,
    lineHeight: 14,
  },
  disabledHint: {
    fontSize: 10,
    color: colors.text.tertiary,
    fontWeight: '600',
  },
  cancelRow: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 6,
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
  },
});
