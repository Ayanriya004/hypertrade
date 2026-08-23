/**
 * Lean master ↔ dedicated-sub USDC transfer sheet for AI agents.
 * Keyboard path matches ExternalWithdrawBottomSheet / TradeTransferBottomSheet
 * (KeyboardAwareScrollView — not RN KeyboardAvoidingView inside Modal).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  PanResponder,
  Keyboard,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';

import { colors } from '../theme/colors';

export type DedicatedTransferDirection = 'toDedicated' | 'toMain';

const SHEET_TRAVEL = 640;
/** Master↔sub is self-owned — no bridge-style floor. Match sendAsset 6dp. */
const MIN_USDC = 1e-6;
const USDC_DECIMALS = 6;

function formatUsdc(n: number): string {
  return (Math.floor(Math.max(0, n) * 100) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatMaxAmount(n: number): string {
  const truncated = Math.floor(Math.max(0, n) * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS;
  if (!(truncated > 0)) return '';
  return truncated.toFixed(USDC_DECIMALS).replace(/\.?0+$/, '');
}

export interface DedicatedTransferBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  agentName: string;
  /** Master free USDC available to send into the sub. */
  mainAvailableUsd: number;
  /** Sub free USDC available to pull back. */
  dedicatedAvailableUsd: number;
  busy: boolean;
  error: string | null;
  onTransfer: (args: { direction: DedicatedTransferDirection; usd: number }) => Promise<void>;
}

export function DedicatedTransferBottomSheet({
  visible,
  onClose,
  agentName,
  mainAvailableUsd,
  dedicatedAvailableUsd,
  busy,
  error,
  onTransfer,
}: DedicatedTransferBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);
  const [direction, setDirection] = useState<DedicatedTransferDirection>('toDedicated');
  const [amount, setAmount] = useState('');

  const liveAvailable = direction === 'toDedicated' ? mainAvailableUsd : dedicatedAvailableUsd;
  // Freeze "Available" while submitting so a post-tx refetch to $0 doesn't flash
  // insufficient / empty balance before the sheet closes on success.
  const availableAtBusyRef = useRef(liveAvailable);
  useEffect(() => {
    if (!busy) availableAtBusyRef.current = liveAvailable;
  }, [busy, liveAvailable]);
  const available = busy ? availableAtBusyRef.current : liveAvailable;
  const parsed = Number(amount);
  const canSubmit =
    !busy &&
    Number.isFinite(parsed) &&
    parsed >= MIN_USDC &&
    parsed <= available + 1e-9;

  const finishClose = useCallback(() => {
    setMounted(false);
    setAmount('');
    setDirection('toDedicated');
    onClose();
  }, [onClose]);

  /** User dismiss (backdrop / swipe / back). Blocked while a transfer is in flight. */
  const animateClose = useCallback(() => {
    if (closingRef.current || busy) return;
    closingRef.current = true;
    Keyboard.dismiss();
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
  }, [slideAnim, backdropAnim, finishClose, busy]);

  /**
   * Parent cleared `visible` (e.g. transfer succeeded). Must unmount even if
   * `busy` is still true — otherwise the sheet Modal stays up and the success
   * toast can land under it / freeze native touches after dismiss.
   */
  const forceCloseFromParent = useCallback(() => {
    if (closingRef.current) {
      closingRef.current = false;
    }
    Keyboard.dismiss();
    slideAnim.stopAnimation();
    backdropAnim.stopAnimation();
    slideAnim.setValue(SHEET_TRAVEL);
    backdropAnim.setValue(0);
    finishClose();
  }, [slideAnim, backdropAnim, finishClose]);

  const animateOpen = useCallback(() => {
    slideAnim.setValue(SHEET_TRAVEL);
    backdropAnim.setValue(0);
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
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
      setAmount('');
      setDirection('toDedicated');
      setMounted(true);
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      forceCloseFromParent();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, forceCloseFromParent]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !busy,
        onMoveShouldSetPanResponder: (_, g) => !busy && Math.abs(g.dy) > 4,
        onPanResponderMove: (_, g) => {
          if (busy) return;
          if (g.dy > 0) slideAnim.setValue(g.dy);
          else slideAnim.setValue(g.dy * 0.25);
        },
        onPanResponderRelease: (_, g) => {
          if (busy) return;
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
    [slideAnim, animateClose, busy],
  );

  const onMax = () => {
    setAmount(formatMaxAmount(available));
  };

  const onSubmit = async () => {
    if (!canSubmit) return;
    Keyboard.dismiss();
    await onTransfer({ direction, usd: parsed });
  };

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={busy ? undefined : animateClose}
    >
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] }) },
          ]}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={busy ? undefined : animateClose}
            disabled={busy}
          />
        </Animated.View>

        {/*
          Same keyboard path as ExternalWithdrawBottomSheet / TradeTransferBottomSheet.
          RN KeyboardAvoidingView inside Modal is unreliable on Android; KASV lifts
          the focused field. Keep offsets mild so the sheet doesn't jump too high.
        */}
        <View style={styles.kav} pointerEvents="box-none">
          <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <View {...panResponder.panHandlers} style={styles.handleArea}>
                <View style={styles.handle} />
              </View>

              <Text style={styles.title} numberOfLines={1}>
                {t('aiAgents.dedicatedTransferTitle')}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {agentName}
              </Text>

              <KeyboardAwareScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
                bottomOffset={Platform.OS === 'ios' ? 20 : 12}
                extraKeyboardSpace={Platform.OS === 'ios' ? 8 : 0}
              >
                <View style={styles.directionTabs}>
                  <TouchableOpacity
                    style={[
                      styles.directionTab,
                      direction === 'toDedicated' && styles.directionTabActive,
                    ]}
                    onPress={() => setDirection('toDedicated')}
                    disabled={busy}
                  >
                    <Text
                      style={[
                        styles.directionTabText,
                        direction === 'toDedicated' && styles.directionTabTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {t('aiAgents.dedicatedTransferToAgent')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.directionTab,
                      direction === 'toMain' && styles.directionTabActive,
                    ]}
                    onPress={() => setDirection('toMain')}
                    disabled={busy}
                  >
                    <Text
                      style={[
                        styles.directionTabText,
                        direction === 'toMain' && styles.directionTabTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {t('aiAgents.dedicatedTransferToMain')}
                    </Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.availableText}>
                  {t('aiAgents.dedicatedTransferAvailable')}{' '}
                  <Text style={styles.availableAmount}>
                    {formatUsdc(available)} {t('common.USDC')}
                  </Text>
                </Text>

                <View style={styles.amountRow}>
                  <TextInput
                    style={styles.amountInput}
                    value={amount}
                    onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={colors.text.tertiary}
                    editable={!busy}
                  />
                  <TouchableOpacity
                    style={styles.maxBtn}
                    onPress={onMax}
                    disabled={busy || available < MIN_USDC}
                  >
                    <Text style={styles.maxBtnText}>{t('common.max')}</Text>
                  </TouchableOpacity>
                </View>

                {!busy && parsed > available + 1e-9 ? (
                  <Text style={styles.warnText}>
                    {t('aiAgents.dedicatedTransferInsufficient')}
                  </Text>
                ) : null}
                {!busy && error ? <Text style={styles.warnText}>{error}</Text> : null}

                <TouchableOpacity
                  style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                  onPress={() => void onSubmit()}
                  disabled={!canSubmit}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.background.primary} />
                  ) : (
                    <Text style={styles.submitBtnText}>
                      {t('aiAgents.dedicatedTransferSubmit')}
                    </Text>
                  )}
                </TouchableOpacity>
              </KeyboardAwareScrollView>
            </View>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  kav: { width: '100%' },
  sheetWrap: { width: '100%' },
  sheet: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleArea: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    marginBottom: 2,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.secondary,
  },
  title: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 2,
  },
  subtitle: {
    color: colors.text.tertiary,
    fontSize: 13,
    marginBottom: 10,
  },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: 4 },
  directionTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  directionTab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: colors.background.secondary,
    alignItems: 'center',
  },
  directionTabActive: {
    backgroundColor: colors.accent.goldDark,
  },
  directionTabText: {
    color: colors.text.secondary,
    fontSize: 13,
    fontWeight: '700',
  },
  directionTabTextActive: {
    color: colors.text.primary,
  },
  availableText: {
    color: colors.text.secondary,
    fontSize: 13,
    marginBottom: 10,
  },
  availableAmount: {
    color: colors.text.primary,
    fontWeight: '700',
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  amountInput: {
    flex: 1,
    backgroundColor: colors.background.secondary,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text.primary,
    fontSize: 20,
    fontWeight: '700',
  },
  maxBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.background.secondary,
  },
  maxBtnText: {
    color: colors.accent.gold,
    fontWeight: '800',
    fontSize: 13,
  },
  warnText: {
    color: colors.status.error,
    fontSize: 12,
    marginBottom: 8,
  },
  submitBtn: {
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: colors.accent.gold,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.45 },
  submitBtnText: {
    color: colors.background.primary,
    fontSize: 16,
    fontWeight: '800',
  },
});
