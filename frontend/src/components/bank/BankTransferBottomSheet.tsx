/**
 * BankTransferBottomSheet — fiat top-up via SEPA / SWIFT bank transfer.
 *
 * Managed Custody mode gives every Live URID one or more IBAN accounts
 * (CHF, EUR, USD, …) that act as deposit addresses. When the user wires
 * fiat to one of them, UR mints the matching OFT (USD24/EUR24/CHF24) on
 * Mantle and it shows up in `/v1/balance`. No on-chain action from us —
 * this sheet is purely a copy / share UI for the bank coordinates.
 *
 * Currencies with no IBAN issued for this URID are dimmed out in the
 * picker; the user can still see what's coming.
 *
 * NOTE on testnet: UR issues CHF + EUR IBANs by default for the test
 * URID. USD / SGD / HKD / JPY / GBP IBANs only land once UR provisions
 * them per partner. We fall back to a "Coming soon" tile rather than
 * hiding the rows so the user sees what's promised.
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
  Share,
  Dimensions,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import type { UrBankAccount } from '../../lib/urApi';
import { formatPaymentReference } from './AccountInfoSheet';
import { CircleCurrencyFlag } from './CircleCountryFlag';

// --------------------------------------------------------------------------- //
// Catalogue of currencies we surface in the picker, in display order.
// `available` is decided at render time by checking profile.bankAccounts.
// --------------------------------------------------------------------------- //

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

// --------------------------------------------------------------------------- //
// Component
// --------------------------------------------------------------------------- //

export interface BankTransferBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Map of currency code → list of issued bank accounts (from profile.bankAccounts). */
  bankAccounts: Record<string, UrBankAccount[]>;
  /** URID to show in the reference field — helps UR ops match incoming wires. */
  urId?: number | null;
  /** Defaults to first issued currency. */
  initialCurrency?: string;
}

export function BankTransferBottomSheet({
  visible,
  onClose,
  bankAccounts,
  urId,
  initialCurrency,
}: BankTransferBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.min(windowHeight * 0.92, windowHeight - insets.top - 8);
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);

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
  const [pickerOpen, setPickerOpen] = useState(false);

  // Re-sync selected when the issued set changes (e.g. UR provisions a new IBAN).
  useEffect(() => {
    if (!issuedCurrencies.includes(selected) && issuedCurrencies.length > 0) {
      setSelected(issuedCurrencies[0]);
    }
  }, [issuedCurrencies, selected]);

  const accounts = bankAccounts?.[selected] || [];
  const account = accounts[0];

  // ─── Sheet lifecycle (slide + backdrop) ───────────────────────────────
  const finishClose = useCallback(() => {
    setMounted(false);
    setPickerOpen(false);
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: SHEET_TRAVEL, duration: 220, useNativeDriver: true }),
      Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
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
      Animated.timing(backdropAnim, { toValue: 1, duration: 240, useNativeDriver: true }),
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

  // ─── Copy / share ────────────────────────────────────────────────────
  const handleCopy = useCallback(
    async (label: string, value: string) => {
      if (!value) return;
      await Clipboard.setStringAsync(value);
      if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
      Toast.show({
        type: 'success',
        text1: t('addCash.copied', { label }),
        text2: value,
        visibilityTime: 1800,
      });
    },
    [t],
  );

  const handleShare = useCallback(async () => {
    if (!account) return;
    const body = [
      `Beneficiary: HyperTrade · URID ${urId ?? ''}`.trim(),
      `IBAN: ${account.account}`,
      account.bic ? `BIC/SWIFT: ${account.bic}` : null,
      account.bankName ? `Bank: ${account.bankName}` : null,
      account.bankAddress ? `Address: ${account.bankAddress}` : null,
      urId ? `Reference: ${formatPaymentReference(urId)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await Share.share({ message: body });
    } catch {
      /* user dismissed */
    }
  }, [account, urId]);

  const label = CURRENCY_CATALOGUE.find((c) => c.code === selected)?.label ?? selected;

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={animateClose}
    >
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
              <Text style={styles.title}>{t('addCash.title')}</Text>
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
                {/* Currency picker */}
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('addCash.currency')}</Text>
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
                </View>

                {/* IBAN card */}
                {account ? (
                  <>
                    <View style={styles.section}>
                      <View style={styles.ibanCard}>
                        <LinearGradient
                          colors={['rgba(199,153,87,0.10)', 'rgba(199,153,87,0.02)']}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 1, y: 1 }}
                          style={styles.ibanGradient}
                        >
                          <Text style={styles.ibanLabel}>
                            {t('addCash.iban', { currency: selected })}
                          </Text>
                          <Text style={styles.ibanValue} numberOfLines={2}>
                            {formatIban(account.account)}
                          </Text>
                          <TouchableOpacity
                            style={styles.copyChip}
                            onPress={() =>
                              handleCopy(t('addCash.iban', { currency: selected }), account.account)
                            }
                            activeOpacity={0.85}
                          >
                            <Ionicons name="copy-outline" size={14} color={colors.accent.gold} />
                            <Text style={styles.copyChipText}>
                              {t('addCash.copy')}
                            </Text>
                          </TouchableOpacity>
                        </LinearGradient>
                      </View>

                      <View style={styles.detailsCard}>
                        <DetailRow
                          label={t('addCash.bank')}
                          value={account.bankName}
                          onCopy={() => handleCopy(t('addCash.bank'), account.bankName)}
                        />
                        <View style={styles.divider} />
                        <DetailRow
                          label={t('addCash.bic')}
                          value={account.bic}
                          mono
                          onCopy={() => handleCopy(t('addCash.bic'), account.bic)}
                        />
                        {account.bankAddress ? (
                          <>
                            <View style={styles.divider} />
                            <DetailRow
                              label={t('addCash.bankAddress')}
                              value={account.bankAddress}
                              onCopy={() =>
                                handleCopy(t('addCash.bankAddress'), account.bankAddress)
                              }
                              multiline
                            />
                          </>
                        ) : null}
                        {urId ? (
                          <>
                            <View style={styles.divider} />
                            <DetailRow
                              label={t('addCash.reference')}
                              value={formatPaymentReference(urId)}
                              mono
                              onCopy={() =>
                                handleCopy(t('addCash.reference'), formatPaymentReference(urId))
                              }
                              hint={t('addCash.referenceHint')}
                            />
                          </>
                        ) : null}
                      </View>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={handleShare}
                      style={styles.shareCtaWrap}
                    >
                      <LinearGradient
                        colors={[colors.accent.gold, colors.accent.purple]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.shareCta}
                      >
                        <Ionicons name="share-outline" size={16} color={colors.background.primary} />
                        <Text style={styles.shareCtaText}>
                          {t('addCash.share')}
                        </Text>
                      </LinearGradient>
                    </TouchableOpacity>

                    <View style={styles.footnoteBlock}>
                      <Ionicons
                        name="time-outline"
                        size={14}
                        color={colors.text.tertiary}
                      />
                      <Text style={styles.footnoteText}>{t('addCash.footnote')}</Text>
                    </View>
                  </>
                ) : (
                  <ComingSoonBlock currency={selected} label={label} />
                )}
              </ScrollView>
        </Animated.View>

        {/* Currency picker overlay */}
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

// --------------------------------------------------------------------------- //
// Sub-components
// --------------------------------------------------------------------------- //

function DetailRow({
  label,
  value,
  onCopy,
  mono,
  multiline,
  hint,
}: {
  label: string;
  value?: string;
  onCopy?: () => void;
  mono?: boolean;
  multiline?: boolean;
  hint?: string;
}) {
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
              letterSpacing: 0.4,
            },
          ]}
          numberOfLines={multiline ? 3 : 1}
        >
          {value}
        </Text>
        {hint ? <Text style={styles.detailHint}>{hint}</Text> : null}
      </View>
      {onCopy ? (
        <TouchableOpacity onPress={onCopy} hitSlop={10} style={styles.detailCopyBtn}>
          <Ionicons name="copy-outline" size={16} color={colors.text.secondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function ComingSoonBlock({
  currency,
  label,
}: {
  currency: string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.comingSoonWrap}>
      <View style={styles.comingSoonIcon}>
        <CircleCurrencyFlag currencyCode={currency} size={32} />
      </View>
      <Text style={styles.comingSoonTitle}>
        {t('addCash.notIssued.title', { currency })}
      </Text>
      <Text style={styles.comingSoonBody}>{t('addCash.notIssued.body', { label })}</Text>
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
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.currencyTitle}>{c.code}</Text>
                  <Text style={styles.currencySub}>{c.label}</Text>
                </View>
                {!issued ? (
                  <Text style={styles.pickerSoon}>
                    {t('common.soon', 'Soon')}
                  </Text>
                ) : c.code === current ? (
                  <Ionicons name="checkmark" size={20} color={colors.accent.gold} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function formatIban(iban: string): string {
  if (!iban) return '';
  // Group by 4: CHxx xxxx xxxx xxxx xxxx xxx (visual only — the copy
  // action returns the unformatted value).
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

// --------------------------------------------------------------------------- //
// Styles
// --------------------------------------------------------------------------- //

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
  section: {
    marginBottom: 16,
  },
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

  ibanCard: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${colors.accent.gold}33`,
    marginBottom: 12,
  },
  ibanGradient: {
    padding: 16,
  },
  ibanLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  ibanValue: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 1,
    lineHeight: 24,
    marginBottom: 14,
  },
  copyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}44`,
    backgroundColor: `${colors.accent.gold}10`,
  },
  copyChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.accent.gold,
    letterSpacing: 0.4,
  },

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
    color: colors.text.primary,
    fontWeight: '600',
  },
  detailHint: {
    fontSize: 11,
    color: colors.text.tertiary,
    marginTop: 6,
    lineHeight: 15,
  },
  detailCopyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.primary,
  },

  shareCtaWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 12,
  },
  shareCta: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareCtaText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.background.primary,
    letterSpacing: 0.3,
  },

  footnoteBlock: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  footnoteText: {
    flex: 1,
    fontSize: 11,
    color: colors.text.tertiary,
    lineHeight: 16,
  },

  comingSoonWrap: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 28,
    gap: 10,
  },
  comingSoonIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
  },
  comingSoonBody: {
    fontSize: 12,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 16,
  },

  // Picker overlay
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    padding: 20,
  },
  pickerCard: {
    marginBottom: 20,
    padding: 16,
    backgroundColor: colors.background.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  pickerTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 12,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.background.primary,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  pickerRowActive: {
    borderColor: colors.accent.gold,
  },
  pickerSoon: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text.tertiary,
  },
});
