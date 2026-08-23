/**
 * CardSettingsSheet — card-management bottom sheet (freeze, details, limits,
 * report lost/stolen).
 *
 * Production shell: rows that act on an issued card are gated by `available`
 * (card provisioned ⇒ KYC-Live). Until then they show an "available once your
 * card is issued" hint and are inert, so the sheet lights up automatically the
 * moment UR returns a real card. Freeze is wired to the backend when a card
 * exists, and falls back to an optimistic local toggle for the pre-issue demo.
 *
 * Animation scaffold mirrors AddMoneyChooserSheet for a consistent feel.
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
  Switch,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import { CircleCurrencyFlag } from './CircleCountryFlag';
import { STATEMENT_CURRENCY_OPTIONS } from '../../lib/urStatement';

export interface CardSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  /** A card has been issued (gate for freeze / details / limits). */
  available: boolean;
  frozen: boolean;
  freezeBusy?: boolean;
  onToggleFreeze: (next: boolean) => void;
  onReportLost: () => void;
  /** Open the notifications inbox (deposit/card/verification alerts live there). */
  onOpenNotifications: () => void;
  /** Current default spend currency (UR card-currency), e.g. USD. */
  cardCurrency?: string | null;
  currencyBusy?: boolean;
  onSelectCurrency: (currency: string) => void;
}

const SHEET_TRAVEL = 600;

export function CardSettingsSheet({
  visible,
  onClose,
  available,
  frozen,
  freezeBusy,
  onToggleFreeze,
  onReportLost,
  onOpenNotifications,
  cardCurrency,
  currencyBusy,
  onSelectCurrency,
}: CardSettingsSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);
  const [currencyModalOpen, setCurrencyModalOpen] = useState(false);

  const finishClose = useCallback(() => {
    setMounted(false);
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: SHEET_TRAVEL, duration: 200, useNativeDriver: true }),
      Animated.timing(backdropAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
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
      Animated.timing(backdropAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
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

  // Drag-to-dismiss from anywhere on the sheet. `onStart` stays false so taps
  // pass through to the switches/rows; we only claim the gesture once the user
  // actually drags vertically (dy dominant), matching the cash sheets' feel.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) => g.dy > 3 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_, g) => {
          if (g.dy > 0) slideAnim.setValue(g.dy);
        },
        onPanResponderRelease: (_, g) => {
          if (g.dy > 60 || g.vy > 0.45) animateClose();
          else {
            Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 5, speed: 18 }).start();
          }
        },
      }),
    [slideAnim, animateClose],
  );

  const haptic = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  }, []);

  if (!mounted) return null;

  const gateHint = t('cash.cardSettings.lockedHint');

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={animateClose}>
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] }) },
          ]}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={animateClose} />
        </Animated.View>

        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}>
          <SafeAreaView edges={['bottom']} style={styles.safeArea}>
            <View
              style={[styles.sheet, { paddingBottom: 20 + insets.bottom * 0.2 }]}
              {...panResponder.panHandlers}
            >
              <View style={styles.handleZone}>
                <View style={styles.handle} />
                <Text style={styles.title}>{t('cash.cardSettings.title')}</Text>
              </View>

              {/* Freeze card */}
              <View style={styles.row}>
                <View style={[styles.rowIcon, frozen && styles.rowIconActive]}>
                  <Ionicons
                    name={frozen ? 'snow' : 'snow-outline'}
                    size={20}
                    color={frozen ? colors.accent.gold : colors.text.secondary}
                  />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>{t('cash.cardSettings.freeze')}</Text>
                  <Text style={styles.rowSub}>
                    {frozen ? t('cash.cardSettings.freezeOnSub') : t('cash.cardSettings.freezeOffSub')}
                  </Text>
                </View>
                {freezeBusy ? (
                  <ActivityIndicator size="small" color={colors.accent.gold} />
                ) : (
                  <Switch
                    value={frozen}
                    onValueChange={(v) => {
                      haptic();
                      onToggleFreeze(v);
                    }}
                    trackColor={{ false: colors.background.tertiary, true: `${colors.accent.gold}99` }}
                    thumbColor={frozen ? colors.accent.gold : '#f4f3f4'}
                  />
                )}
              </View>

              {/* Default spend currency */}
              <SettingRow
                icon="cash-outline"
                title={t('cash.cardSettings.defaultCurrency')}
                sub={
                  available
                    ? cardCurrency
                      ? t('cash.cardSettings.defaultCurrencyValue', { currency: cardCurrency })
                      : t('cash.cardSettings.defaultCurrencyUnset')
                    : gateHint
                }
                disabled={!available || currencyBusy}
                trailing={
                  currencyBusy ? (
                    <ActivityIndicator size="small" color={colors.accent.gold} />
                  ) : available && cardCurrency ? (
                    <CircleCurrencyFlag currencyCode={cardCurrency} size={22} />
                  ) : undefined
                }
                onPress={() => {
                  if (available && !currencyBusy) setCurrencyModalOpen(true);
                }}
              />

              {/* Card transactions — opens the notifications inbox on the Card tab. */}
              <SettingRow
                icon="card-outline"
                title={t('cash.cardSettings.cardTransactions')}
                sub={t('cash.cardSettings.cardTransactionsSub')}
                onPress={() => {
                  haptic();
                  animateClose();
                  onOpenNotifications();
                }}
              />

              {/* Report lost or stolen */}
              <SettingRow
                icon="alert-circle-outline"
                title={t('cash.cardSettings.report')}
                sub={t('cash.cardSettings.reportSub')}
                danger
                onPress={() => {
                  haptic();
                  onReportLost();
                }}
              />

              <TouchableOpacity style={styles.cancelRow} onPress={animateClose}>
                <Text style={styles.cancelText}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>

      <CardDefaultCurrencyModal
        visible={currencyModalOpen}
        selected={cardCurrency ?? ''}
        onClose={() => setCurrencyModalOpen(false)}
        onSelect={(ccy) => {
          setCurrencyModalOpen(false);
          onSelectCurrency(ccy);
        }}
      />
    </Modal>
  );
}

function CardDefaultCurrencyModal({
  visible,
  selected,
  onClose,
  onSelect,
}: {
  visible: boolean;
  selected: string;
  onClose: () => void;
  onSelect: (currency: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.currencyModalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.currencyModalCard} onStartShouldSetResponder={() => true}>
          <Text style={styles.currencyModalTitle}>{t('cash.cardSettings.defaultCurrency')}</Text>
          <Text style={styles.currencyModalHint}>{t('cash.cardSettings.defaultCurrencyHint')}</Text>
          {STATEMENT_CURRENCY_OPTIONS.map((code) => {
            const active = selected.toUpperCase() === code;
            return (
              <TouchableOpacity
                key={code}
                style={[styles.currencyModalRow, active && styles.currencyModalRowActive]}
                onPress={() => onSelect(code)}
              >
                <CircleCurrencyFlag currencyCode={code} size={22} style={styles.currencyModalFlag} />
                <Text style={styles.currencyModalCode}>{code}</Text>
                {active ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
                ) : (
                  <View style={styles.currencyModalCheckSpacer} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function SettingRow({
  icon,
  title,
  sub,
  onPress,
  disabled,
  danger,
  trailing,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, disabled && styles.rowDisabled]}
      activeOpacity={disabled ? 1 : 0.7}
      onPress={disabled ? undefined : onPress}
    >
      <View style={styles.rowIcon}>
        <Ionicons
          name={icon}
          size={20}
          color={danger ? colors.status.error : colors.text.secondary}
        />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, danger && { color: colors.status.error }]}>{title}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      {disabled ? (
        <Ionicons name="lock-closed" size={15} color={colors.text.muted} />
      ) : trailing ? (
        trailing
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheetWrap: { width: '100%' },
  safeArea: { backgroundColor: 'transparent' },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleZone: { paddingBottom: 8 },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
    marginBottom: 14,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  rowDisabled: { opacity: 0.55 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  rowIconActive: {
    borderColor: `${colors.accent.gold}55`,
    backgroundColor: `${colors.accent.gold}18`,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  rowSub: { fontSize: 12, color: colors.text.tertiary },
  cancelRow: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  cancelText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
  currencyModalOverlay: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  currencyModalCard: {
    backgroundColor: colors.background.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    gap: 8,
    maxHeight: '70%',
  },
  currencyModalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
  },
  currencyModalHint: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.text.tertiary,
    marginBottom: 4,
  },
  currencyModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 12,
    gap: 10,
  },
  currencyModalRowActive: {
    backgroundColor: `${colors.accent.gold}14`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}44`,
  },
  currencyModalFlag: {},
  currencyModalCode: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  currencyModalCheckSpacer: { width: 20 },
});
