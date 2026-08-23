/**
 * AccountInfoSheet — consolidated account identifiers for Live UR users.
 *
 * Surfaces URID, wallet address, and IBAN rails (per currency) in one place
 * with per-field copy actions. Opened from the Cash tab greeting chip.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Animated,
  Easing,
  Platform,
  PanResponder,
  Dimensions,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import type { UrBankAccount } from '../../lib/urApi';
import { CircleCurrencyFlag } from './CircleCountryFlag';

const CURRENCY_CATALOGUE: Array<{ code: string; label: string }> = [
  { code: 'USD', label: 'US Dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'CHF', label: 'Swiss Franc' },
  { code: 'CNH', label: 'Chinese Yuan' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'SGD', label: 'Singapore Dollar' },
  { code: 'HKD', label: 'Hong Kong Dollar' },
  { code: 'JPY', label: 'Japanese Yen' },
];

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_TRAVEL = SCREEN_HEIGHT;

export function formatUridDisplay(urId: number): string {
  return String(urId).padStart(8, '0');
}

export function formatPaymentReference(urId: number): string {
  return `UR-${formatUridDisplay(urId)}`;
}

export interface AccountInfoSheetProps {
  visible: boolean;
  onClose: () => void;
  urId?: number | null;
  walletAddress?: string | null;
  bankAccounts: Record<string, UrBankAccount[]>;
  initialCurrency?: string;
}

export function AccountInfoSheet({
  visible,
  onClose,
  urId,
  walletAddress,
  bankAccounts,
  initialCurrency,
}: AccountInfoSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.min(windowHeight * 0.92, windowHeight - insets.top - 8);
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const issuedCurrencies = useMemo(
    () =>
      Object.keys(bankAccounts || {}).filter(
        (k) => Array.isArray(bankAccounts[k]) && bankAccounts[k].length > 0,
      ),
    [bankAccounts],
  );

  const defaultCurrency = useMemo(() => {
    if (initialCurrency && issuedCurrencies.includes(initialCurrency)) {
      return initialCurrency;
    }
    return issuedCurrencies[0] || CURRENCY_CATALOGUE[0].code;
  }, [initialCurrency, issuedCurrencies]);

  const [selected, setSelected] = useState<string>(defaultCurrency);

  useEffect(() => {
    if (!issuedCurrencies.includes(selected) && issuedCurrencies.length > 0) {
      setSelected(issuedCurrencies[0]);
    }
  }, [issuedCurrencies, selected]);

  const account = bankAccounts?.[selected]?.[0];
  const uridText = urId != null ? formatUridDisplay(urId) : null;
  const paymentReference = urId != null ? formatPaymentReference(urId) : null;

  const finishClose = useCallback(() => {
    setMounted(false);
    setPickerOpen(false);
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
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 240,
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
          if (g.dy > 80 || g.vy > 0.45) animateClose();
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

  const label = CURRENCY_CATALOGUE.find((c) => c.code === selected)?.label ?? selected;

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={animateClose}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] }) },
          ]}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={animateClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 16),
              maxHeight: sheetMaxHeight,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          <View {...panResponder.panHandlers}>
            <View style={styles.handleArea}>
              <View style={styles.handle} />
            </View>
            <View style={styles.header}>
              <Text style={styles.title}>{t('cash.accountInfoTitle')}</Text>
              <TouchableOpacity onPress={animateClose} hitSlop={12}>
                <Ionicons name="close" size={22} color={colors.text.secondary} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('cash.accountInfoIdentity')}</Text>
                  <View style={styles.detailsCard}>
                    <DetailRow
                      label={t('cash.accountInfoAccountId')}
                      value={uridText ?? undefined}
                      mono
                      copyValue={uridText ?? undefined}
                    />
                    {walletAddress ? (
                      <>
                        <View style={styles.divider} />
                        <DetailRow
                          label={t('cash.accountInfoWallet')}
                          value={walletAddress}
                          mono
                          multiline
                          copyValue={walletAddress}
                        />
                      </>
                    ) : null}
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('cash.accountInfoBank')}</Text>
                  <TouchableOpacity
                    style={styles.currencyRow}
                    onPress={() => setPickerOpen(true)}
                    activeOpacity={0.8}
                  >
                    <CircleCurrencyFlag currencyCode={selected} size={28} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.currencyTitle}>{selected}</Text>
                      <Text style={styles.currencySub}>{label}</Text>
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.text.tertiary} />
                  </TouchableOpacity>

                  {account ? (
                    <View style={[styles.detailsCard, { marginTop: 12 }]}>
                      <DetailRow
                        label={t('addCash.iban', { currency: selected })}
                        value={formatIban(account.account)}
                        mono
                        multiline
                        copyValue={account.account}
                      />
                      <View style={styles.divider} />
                      <DetailRow
                        label={t('addCash.bank')}
                        value={account.bankName}
                        copyValue={account.bankName}
                      />
                      <View style={styles.divider} />
                      <DetailRow
                        label={t('addCash.bic')}
                        value={account.bic}
                        mono
                        copyValue={account.bic}
                      />
                      {account.bankAddress ? (
                        <>
                          <View style={styles.divider} />
                          <DetailRow
                            label={t('addCash.bankAddress')}
                            value={account.bankAddress}
                            multiline
                            copyValue={account.bankAddress}
                          />
                        </>
                      ) : null}
                      {paymentReference ? (
                        <>
                          <View style={styles.divider} />
                          <DetailRow
                            label={t('addCash.reference')}
                            value={paymentReference}
                            mono
                            copyValue={paymentReference}
                            hint={t('addCash.referenceHint')}
                          />
                        </>
                      ) : null}
                    </View>
                  ) : (
                    <View style={styles.comingSoonWrap}>
                      <Text style={styles.comingSoonTitle}>
                        {t('addCash.notIssued.title', { currency: selected })}
                      </Text>
                      <Text style={styles.comingSoonBody}>
                        {t('addCash.notIssued.body', { label })}
                      </Text>
                    </View>
                  )}
                </View>
              </ScrollView>
        </Animated.View>

        <CurrencyPickerModal
          visible={pickerOpen}
          onClose={() => setPickerOpen(false)}
          issuedCurrencies={issuedCurrencies}
          current={selected}
          onPick={(c) => {
            setSelected(c);
            setPickerOpen(false);
          }}
        />
      </View>
    </Modal>
  );
}

const COPY_FEEDBACK_MS = 2000;

function DetailRow({
  label,
  value,
  copyValue,
  mono,
  multiline,
  hint,
}: {
  label: string;
  value?: string;
  /** When set, shows a copy button that briefly flips to a green checkmark on success. */
  copyValue?: string;
  mono?: boolean;
  multiline?: boolean;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!copyValue) return;
    await Clipboard.setStringAsync(copyValue);
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }, [copyValue]);

  if (!value) return null;
  return (
    <View style={styles.detailRow}>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text
          style={[
            styles.detailValue,
            mono && {
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              letterSpacing: 0.3,
            },
          ]}
          numberOfLines={multiline ? 4 : 2}
        >
          {value}
        </Text>
        {hint ? <Text style={styles.detailHint}>{hint}</Text> : null}
      </View>
      {copyValue ? (
        <TouchableOpacity onPress={handleCopy} hitSlop={10} style={styles.detailCopyBtn}>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={copied ? colors.status.success : colors.text.secondary}
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function CurrencyPickerModal({
  visible,
  onClose,
  issuedCurrencies,
  current,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  issuedCurrencies: string[];
  current: string;
  onPick: (code: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>{t('addCash.pickCurrency')}</Text>
          {CURRENCY_CATALOGUE.map((c) => {
            const issued = issuedCurrencies.includes(c.code);
            return (
              <TouchableOpacity
                key={c.code}
                disabled={!issued}
                onPress={() => onPick(c.code)}
                style={[
                  styles.pickerRow,
                  !issued && { opacity: 0.4 },
                  c.code === current && styles.pickerRowActive,
                ]}
              >
                <CircleCurrencyFlag currencyCode={c.code} size={24} />
                <Text style={styles.pickerRowText}>{c.code}</Text>
                <Text style={styles.pickerRowSub}>{c.label}</Text>
                {c.code === current ? (
                  <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 0,
    width: '100%',
    overflow: 'hidden',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border.primary,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  handleArea: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 8,
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.text.primary,
  },
  section: { marginBottom: 16 },
  sectionLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  currencyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 14,
    padding: 14,
  },
  currencyTitle: { fontSize: 15, fontWeight: '800', color: colors.text.primary },
  currencySub: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
  detailsCard: {
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 11,
    color: colors.text.tertiary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.primary,
    lineHeight: 20,
  },
  detailHint: {
    fontSize: 11,
    color: colors.text.tertiary,
    marginTop: 6,
    lineHeight: 16,
  },
  detailCopyBtn: {
    paddingTop: 18,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border.primary,
  },
  comingSoonWrap: {
    marginTop: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 6,
  },
  comingSoonBody: {
    fontSize: 13,
    color: colors.text.tertiary,
    lineHeight: 19,
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  pickerCard: {
    backgroundColor: colors.background.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 12,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 10,
  },
  pickerRowActive: {
    backgroundColor: `${colors.accent.gold}10`,
    borderRadius: 10,
    paddingHorizontal: 8,
  },
  pickerRowText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
    width: 44,
  },
  pickerRowSub: {
    flex: 1,
    fontSize: 13,
    color: colors.text.tertiary,
  },
});
