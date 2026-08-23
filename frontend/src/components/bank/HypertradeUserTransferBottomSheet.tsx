/**
 * HypertradeUserTransferBottomSheet — URID-to-URID fiat transfer (P2P).
 *
 * Gasless EIP-2612 permit flow (spender = fiat token contract):
 *   input → review → sign permit → POST /ur/transfer/execute → poll job
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  TextInput,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { useEmbeddedEthereumWallet } from '@privy-io/expo';
import {
  createWalletClient,
  custom,
  type Hex,
  type WalletClient,
} from 'viem';

import { colors } from '../../theme/colors';
import { getMantleChain, getDefaultMantleChainId } from '../../lib/mantleFiatBalance';
import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import { useUrTransferLimit } from '../../hooks/useUrTransferLimit';
import { SpendableBalanceLine } from './SpendableBalanceLine';
import { GRADIENT_BTN_SPINNER_BUSY, gradientConfirmTextBusy } from './bankSheetUi';
import { useAuth } from '../../providers/AuthContext';
import {
  fetchUrTransferPermitInfo,
  executeUrTransfer,
  fetchUrJob,
  fetchUrTransferRecipients,
  saveUrTransferRecipient,
  deleteUrTransferRecipient,
  isUrJobTerminal,
  defaultFromCurrency,
  type UrPayoutPermit,
  type UrExtAuth,
  type UrP2pRecipient,
  type CashAccountRow,
} from '../../lib/urApi';
import { buildFullAuth, signOnrampPermit } from '../../lib/urOnrampAuth';
import { formatUridDisplay } from './AccountInfoSheet';

const SHEET_TRAVEL = 720;
const CONFIRM_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;
const CONFIRM_GRADIENT_DISABLED = [colors.background.tertiary, colors.background.tertiary] as const;
const JOB_POLL_INTERVAL_MS = 1500;
const JOB_POLL_MAX_ATTEMPTS = 40;

type Stage =
  | 'input'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'error';

export interface HypertradeUserTransferBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  cashRows: CashAccountRow[];
  /** Pre-selected source currency (from the account card badge). */
  initialCurrency?: string | null;
  /** Sender's URID — blocks self-transfers in the UI. */
  senderUrid?: number | null;
  /** Rolling-30-day transfer limit (CHF, 2dp). UR confirmed P2P draws from it. */
  usedLimit?: number;
  clientLimit?: number;
  /** USD-equivalent rates (ISO → USD24/unit) to size the amount in CHF. */
  usdRates?: Record<string, number>;
  onSuccess?: () => Promise<void> | void;
}

export function HypertradeUserTransferBottomSheet({
  visible,
  onClose,
  cashRows,
  initialCurrency,
  senderUrid,
  usedLimit,
  clientLimit,
  usdRates,
  onSuccess,
}: HypertradeUserTransferBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.min(windowHeight * 0.88, windowHeight - insets.top - 12);
  const { getAccessToken, walletAddress } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();
  // Resolve the wallet matching the URID-owning EOA (NOT wallets[0]). Under
  // ENABLE_UR_TEST_WALLET_IMPORT the imported UR-whitelisted signer is often
  // not the first embedded wallet — signing with the wrong one makes UR reject
  // the Full-Auth with retCode=10001 "authentication failure".
  const wallet = useMemo(() => {
    if (!walletAddress) return wallets[0];
    const target = walletAddress.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === target) ?? wallets[0];
  }, [wallets, walletAddress]);

  const [mounted, setMounted] = useState(false);

  const spendableBalances = useSpendableMantleBalances({
    active: mounted,
    walletAddress,
    getAccessToken,
  });

  const [stage, setStage] = useState<Stage>('input');
  const [fromCurrency, setFromCurrency] = useState(() =>
    initialCurrency ?? defaultFromCurrency(cashRows),
  );
  const [amount, setAmount] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [permit, setPermit] = useState<UrPayoutPermit | null>(null);
  const [recipientBinding, setRecipientBinding] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [successRecipient, setSuccessRecipient] = useState('');
  const [savedRecipients, setSavedRecipients] = useState<UrP2pRecipient[]>([]);
  const [saveLabel, setSaveLabel] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  /** Set only when the user explicitly picks from the saved list — never on open. */
  const [pickedSavedId, setPickedSavedId] = useState<string | null>(null);
  const [savedPickerOpen, setSavedPickerOpen] = useState(false);
  const [preparingReview, setPreparingReview] = useState(false);

  const accountIdHint = useMemo(
    () => t('hypertradeUserTransferSheet.accountIdHint', {
      accountInfo: t('cash.accountInfo'),
      cashTab: t('cash.tabCash'),
    }),
    [t],
  );

  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(false);
  const authRef = useRef<UrExtAuth | null>(null);
  const transferInFlightRef = useRef(false);

  const finishClose = useCallback(() => {
    setMounted(false);
    setAmount('');
    setRecipientId('');
    setPermit(null);
    setRecipientBinding(null);
    setStage('input');
    setErrMsg(null);
    setSuccessRecipient('');
    setSaveLabel('');
    setPickedSavedId(null);
    setSavedPickerOpen(false);
    setPreparingReview(false);
    authRef.current = null;
    transferInFlightRef.current = false;
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: SHEET_TRAVEL, duration: 220, useNativeDriver: true }),
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
        duration: 260,
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
      setFromCurrency(initialCurrency ?? defaultFromCurrency(cashRows));
      setAmount('');
      setRecipientId('');
      setSaveLabel('');
      setPickedSavedId(null);
      setSavedPickerOpen(false);
      setPreparingReview(false);
      setStage('input');
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose, cashRows, initialCurrency]);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;
        const rows = await fetchUrTransferRecipients(token);
        if (!cancelled) setSavedRecipients(rows);
      } catch {
        // non-fatal — manual entry still works
      }
    })();
    return () => { cancelled = true; };
  }, [mounted, getAccessToken]);

  const spendable = spendableBalances.forCurrency(fromCurrency);
  const fromBalance = spendable?.amount ?? 0;
  const fromBalanceStr = spendable?.amountStr ?? '—';
  const amountNum = useMemo(() => {
    const n = parseFloat(amount.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const recipientDigits = recipientId.replace(/\D/g, '');
  const recipientUrid = recipientDigits ? parseInt(recipientDigits, 10) : null;

  // Rolling-30-day limit pre-flight — UR confirmed P2P transfers consume the
  // same CHF-denominated limit as FX / payouts / card spend.
  const transferLimit = useUrTransferLimit({
    usedLimit,
    clientLimit,
    amount: amountNum,
    currency: fromCurrency,
    usdRates,
  });
  const limitReached = transferLimit.block;
  const matchingSaved = useMemo(
    () => savedRecipients.find((r) => String(r.recipient_ur_id) === recipientDigits),
    [savedRecipients, recipientDigits],
  );
  const canSaveRecipient =
    !!recipientDigits &&
    recipientUrid != null &&
    senderUrid !== recipientUrid &&
    saveLabel.trim().length > 0 &&
    !saveBusy;

  const friendlyError = useCallback((detail: string): string => detail, []);

  const onPickSaved = useCallback((row: UrP2pRecipient) => {
    setRecipientId(String(row.recipient_ur_id));
    setSaveLabel(row.label);
    setPickedSavedId(row.id);
    setSavedPickerOpen(false);
  }, []);

  const onClearRecipient = useCallback(() => {
    setRecipientId('');
    setSaveLabel('');
    setPickedSavedId(null);
  }, []);

  const onSaveRecipient = useCallback(async () => {
    if (!canSaveRecipient || !recipientDigits) return;
    setSaveBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const saved = await saveUrTransferRecipient(token, {
        recipient_ur_id: recipientDigits,
        label: saveLabel.trim(),
      });
      setSavedRecipients((prev) => {
        const rest = prev.filter((r) => r.id !== saved.id && r.recipient_ur_id !== saved.recipient_ur_id);
        return [saved, ...rest];
      });
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? t('hypertradeUserTransferSheet.unknownError');
      setErrMsg(friendlyError(String(detail)));
      setStage('error');
    } finally {
      setSaveBusy(false);
    }
  }, [canSaveRecipient, recipientDigits, saveLabel, getAccessToken, t, friendlyError]);

  const onDeleteSaved = useCallback(async (row: UrP2pRecipient) => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      await deleteUrTransferRecipient(token, row.id);
      setSavedRecipients((prev) => prev.filter((r) => r.id !== row.id));
      if (recipientDigits === String(row.recipient_ur_id)) {
        onClearRecipient();
      }
    } catch {
      // ignore
    }
  }, [getAccessToken, recipientDigits, onClearRecipient]);

  const buildWalletClient = useCallback(async (): Promise<{ client: WalletClient; userAddr: Hex }> => {
    if (!wallet || !walletAddress) throw new Error(t('hypertradeUserTransferSheet.noWallet'));
    if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(`Wallet mismatch: ${wallet.address} != ${walletAddress}. Please re-login.`);
    }
    const provider = await wallet.getProvider();
    const chain = getMantleChain(getDefaultMantleChainId());
    const client = createWalletClient({
      account: walletAddress as Hex,
      chain,
      transport: custom(provider),
    });
    return { client, userAddr: walletAddress as Hex };
  }, [wallet, walletAddress, t]);

  const ensureAuth = useCallback(async (): Promise<UrExtAuth> => {
    if (authRef.current) return authRef.current;
    const { client, userAddr } = await buildWalletClient();
    const auth = await buildFullAuth(client, userAddr);
    authRef.current = auth;
    return auth;
  }, [buildWalletClient]);

  const inputErr: string | null = useMemo(() => {
    if (spendableBalances.loading || !spendableBalances.ready) {
      if (spendableBalances.error) {
        return t('bankSheet.balanceUnavailable', {
          defaultValue: "Couldn't read your wallet balance. Try again.",
        });
      }
      return null;
    }
    if (!amount && !recipientId) return null;
    if (!recipientDigits) return t('hypertradeUserTransferSheet.invalidAccountId');
    if (senderUrid != null && recipientUrid === senderUrid) {
      return t('hypertradeUserTransferSheet.selfTransfer');
    }
    if (!amount) return null;
    if (amountNum <= 0) return t('hypertradeUserTransferSheet.invalidAmount');
    if (amountNum > fromBalance) {
      return t('hypertradeUserTransferSheet.notEnough', { currency: fromCurrency });
    }
    return null;
  }, [
    amount,
    amountNum,
    fromBalance,
    fromCurrency,
    recipientDigits,
    recipientId,
    recipientUrid,
    senderUrid,
    t,
    spendableBalances,
  ]);

  const onContinue = useCallback(async () => {
    if (inputErr || amountNum <= 0 || !recipientDigits || preparingReview || spendableBalances.balanceLocked) return;
    if (limitReached) {
      setErrMsg(transferLimit.message || t('hypertradeUserTransferSheet.unknownError'));
      setStage('error');
      return;
    }
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setErrMsg(null);
    setPreparingReview(true);
    setPermit(null);
    setRecipientBinding(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const auth = await ensureAuth();
      if (!walletAddress) throw new Error(t('hypertradeUserTransferSheet.noWallet'));
      const resp = await fetchUrTransferPermitInfo(token, {
        auth,
        currency: fromCurrency,
        amount: String(amountNum),
        owner_address: walletAddress,
        to_account_id: recipientDigits,
      });
      if (!resp.permit) throw new Error(t('hypertradeUserTransferSheet.permitUnavailable'));
      setPermit(resp.permit);
      setRecipientBinding(resp.recipient_binding ?? null);
      setStage('review');
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? t('hypertradeUserTransferSheet.unknownError');
      setErrMsg(friendlyError(String(detail)));
      setStage('error');
    } finally {
      setPreparingReview(false);
    }
  }, [
    inputErr, amountNum, recipientDigits, preparingReview, getAccessToken, ensureAuth,
    walletAddress, fromCurrency, t, friendlyError,
    limitReached, transferLimit.message, spendableBalances.balanceLocked,
  ]);

  const fetchPermitForTransfer = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');
    const auth = await ensureAuth();
    if (!walletAddress) throw new Error(t('hypertradeUserTransferSheet.noWallet'));
    const resp = await fetchUrTransferPermitInfo(token, {
      auth,
      currency: fromCurrency,
      amount: String(amountNum),
      owner_address: walletAddress,
      to_account_id: recipientDigits,
    });
    if (!resp.permit) throw new Error(t('hypertradeUserTransferSheet.permitUnavailable'));
    setPermit(resp.permit);
    const binding = resp.recipient_binding ?? null;
    setRecipientBinding(binding);
    return { permit: resp.permit, recipientBinding: binding };
  }, [getAccessToken, ensureAuth, walletAddress, fromCurrency, amountNum, recipientDigits, t]);

  const executeTransfer = useCallback(async () => {
    if (!recipientDigits || transferInFlightRef.current) return;
    transferInFlightRef.current = true;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setErrMsg(null);
    setStage('signing');
    try {
      let activePermit = permit;
      let activeBinding = recipientBinding;
      if (!activePermit) {
        const fresh = await fetchPermitForTransfer();
        activePermit = fresh.permit;
        activeBinding = fresh.recipientBinding;
      }
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const { client, userAddr } = await buildWalletClient();
      // Sign a FRESH Full-Auth right before submit. The set signed at review
      // can expire (deadline window) while the user dwells or retries after a
      // transient UR failure, which UR rejects as retCode=10001 auth failure.
      const auth = await buildFullAuth(client, userAddr);
      authRef.current = auth;
      if (!activePermit.name || !activePermit.version || activePermit.nonce == null) {
        throw new Error(t('hypertradeUserTransferSheet.permitUnavailable'));
      }
      const permitDeadline = Math.floor(Date.now() / 1000) + 1800;
      const sig = await signOnrampPermit(client, {
        account: userAddr,
        token: activePermit.token as Hex,
        spender: activePermit.spender as Hex,
        value: BigInt(activePermit.value),
        deadline: permitDeadline,
        chainId: activePermit.chain_id,
        name: activePermit.name,
        version: activePermit.version,
        nonce: activePermit.nonce,
      });

      setStage('submitting');
      const idempotencyKey = `transfer-${userAddr.toLowerCase()}-${fromCurrency}-${recipientDigits}-${Date.now()}`;
      const resp = await executeUrTransfer(token, {
        auth,
        idempotency_key: idempotencyKey,
        currency: fromCurrency,
        amount: String(amountNum),
        to_account_id: recipientDigits,
        recipient_binding: activeBinding,
        permit_amount: String(amountNum),
        permit_deadline: permitDeadline,
        permit_v: sig.v,
        permit_r: sig.r,
        permit_s: sig.s,
      });
      if (resp.dispatch_error) throw new Error(resp.dispatch_error);

      setStage('confirming');
      let jobId = resp.job?.id;
      let status = resp.job?.status;
      let attempts = 0;
      while (jobId && !isUrJobTerminal(status) && attempts < JOB_POLL_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
        attempts += 1;
        try {
          const job = await fetchUrJob(token, jobId);
          status = job.status;
        } catch {
          // transient
        }
      }
      if (status === 'failed') throw new Error(t('hypertradeUserTransferSheet.unknownError'));
      setSuccessRecipient(formatUridDisplay(recipientUrid ?? 0));
      setStage('success');
      try { await onSuccess?.(); } catch { /* best-effort */ }
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { shortMessage?: string })?.shortMessage ??
        (err as { message?: string })?.message ?? t('hypertradeUserTransferSheet.unknownError');
      const lower = String(detail).toLowerCase();
      if (lower.includes('user rejected') || lower.includes('user denied')) {
        setStage('review');
        return;
      }
      setErrMsg(friendlyError(String(detail)));
      setStage('error');
    } finally {
      transferInFlightRef.current = false;
    }
  }, [
    permit, recipientBinding, recipientDigits, getAccessToken, buildWalletClient, fetchPermitForTransfer,
    fromCurrency, amountNum, recipientUrid, onSuccess, t, friendlyError,
  ]);

  const closeable = stage === 'input' || stage === 'review' || stage === 'success' || stage === 'error';
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => closeable,
        onMoveShouldSetPanResponder: (_, g) => closeable && Math.abs(g.dy) > 4,
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
    [closeable, slideAnim, animateClose],
  );

  const setMax = useCallback(() => {
    if (!spendableBalances.ready || fromBalance <= 0) return;
    setAmount(spendable?.amountStr ?? String(fromBalance));
  }, [spendableBalances.ready, fromBalance, spendable?.amountStr]);

  if (!mounted) return null;

  const busy = stage === 'signing' || stage === 'submitting' || stage === 'confirming';
  const isInputStage = stage === 'input';
  const balanceLocked = spendableBalances.balanceLocked;
  const canContinue = !inputErr && !limitReached && amountNum > 0 && !!recipientDigits && !preparingReview && !balanceLocked;
  const canSend = stage === 'review' && !!permit && !busy;
  const busyLabel =
    stage === 'signing'
      ? t('hypertradeUserTransferSheet.signing')
      : stage === 'submitting'
        ? t('hypertradeUserTransferSheet.submitting')
        : t('hypertradeUserTransferSheet.polling');

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={animateClose}>
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View
          style={[styles.backdrop, { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) }]}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={closeable ? animateClose : undefined}
          />
        </Animated.View>

        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}>
          <SafeAreaView
            edges={['bottom']}
            style={[styles.safeArea, isInputStage && { maxHeight: sheetMaxHeight }]}
          >
            <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom * 0.2 }]}>
              <View {...panResponder.panHandlers} style={styles.handleArea}>
                <View style={styles.handle} />
              </View>

              {stage === 'success' ? (
                <View style={styles.resultBlock}>
                  <Ionicons name="checkmark-circle" size={48} color={colors.accent.gold} />
                  <Text style={styles.resultTitle}>{t('hypertradeUserTransferSheet.successTitle')}</Text>
                  <Text style={styles.resultBody}>
                    {t('hypertradeUserTransferSheet.successBody', {
                      amount: formatNum(amountNum),
                      currency: fromCurrency,
                      recipient: successRecipient,
                    })}
                  </Text>
                  <TouchableOpacity style={[styles.secondaryBtn, styles.actionBtnFull]} onPress={animateClose}>
                    <Text style={styles.secondaryBtnText}>{t('hypertradeUserTransferSheet.done')}</Text>
                  </TouchableOpacity>
                </View>
              ) : stage === 'error' ? (
                <View style={styles.resultBlock}>
                  <Ionicons name="alert-circle" size={48} color="#e57373" />
                  <Text style={styles.resultTitle}>{t('hypertradeUserTransferSheet.errorTitle')}</Text>
                  <Text style={styles.resultBody}>{errMsg}</Text>
                  <TouchableOpacity
                    style={[styles.secondaryBtn, styles.actionBtnFull]}
                    onPress={() => {
                      setStage('input');
                      setErrMsg(null);
                      setPermit(null);
                      setRecipientBinding(null);
                    }}
                  >
                    <Text style={styles.secondaryBtnText}>{t('hypertradeUserTransferSheet.retry')}</Text>
                  </TouchableOpacity>
                </View>
              ) : stage === 'review' || busy ? (
                <>
                  <Text style={styles.title}>{t('hypertradeUserTransferSheet.reviewTitle')}</Text>
                  <View style={styles.reviewCard}>
                    <ReviewRow
                      label={t('hypertradeUserTransferSheet.reviewYouSend')}
                      value={`${formatNum(amountNum)} ${fromCurrency}`}
                      strong
                    />
                    <View style={styles.reviewDivider} />
                    <ReviewRow
                      label={t('hypertradeUserTransferSheet.reviewRecipient')}
                      value={formatUridDisplay(recipientUrid ?? 0)}
                    />
                    <View style={styles.reviewDivider} />
                    <ReviewRow
                      label={t('sendSheet.feeLabel')}
                      value={t('sendSheet.feeFree')}
                      highlight
                    />
                  </View>
                  {errMsg ? <Text style={styles.errText}>{errMsg}</Text> : null}
                  <ConfirmButton
                    busy={busy}
                    enabled={canSend}
                    label={busy ? busyLabel : t('hypertradeUserTransferSheet.send')}
                    onPress={canSend ? () => void executeTransfer() : undefined}
                  />
                  {!busy ? (
                    <TouchableOpacity
                      style={[styles.secondaryBtn, styles.actionBtnFull]}
                      onPress={() => {
                        setStage('input');
                        setPermit(null);
                        setRecipientBinding(null);
                      }}
                    >
                      <Text style={styles.secondaryBtnText}>{t('hypertradeUserTransferSheet.back')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : (
                <KeyboardAwareScrollView
                  style={styles.formScroll}
                  contentContainerStyle={styles.formScrollContent}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  showsVerticalScrollIndicator={false}
                  bottomOffset={20}
                  extraKeyboardSpace={Platform.OS === 'ios' ? 8 : 12}
                >
                  <Text style={styles.title}>{t('hypertradeUserTransferSheet.title')}</Text>
                  {limitReached ? (
                    <View style={styles.blockBanner}>
                      <Ionicons name="lock-closed" size={16} color="#e0a23b" />
                      <View style={styles.blockBannerBody}>
                        <Text style={styles.blockBannerTitle}>
                          {transferLimit.title ||
                            t('bankLimit.fullyReachedTitle', { defaultValue: 'Monthly limit reached' })}
                        </Text>
                        <Text style={styles.blockBannerText}>
                          {transferLimit.message ||
                            t('bankLimit.fullyReached', {
                              defaultValue:
                                "You've reached your monthly transfer limit. It resets on a rolling 30-day basis.",
                            })}
                        </Text>
                      </View>
                    </View>
                  ) : null}
                  <View style={styles.block}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.smallLabel}>{t('hypertradeUserTransferSheet.from')}</Text>
                      <SpendableBalanceLine
                        label={t('hypertradeUserTransferSheet.available')}
                        currency={fromCurrency}
                        amountStr={fromBalanceStr}
                        loading={balanceLocked}
                        error={spendableBalances.error}
                        onRetry={spendableBalances.refresh}
                      />
                    </View>
                    <View style={styles.amountRow}>
                      <TextInput
                        style={styles.amountInput}
                        value={amount}
                        onChangeText={setAmount}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor={colors.text.tertiary}
                        editable={!balanceLocked}
                      />
                      <View style={styles.currencyChip}>
                        <Text style={styles.currencyChipText}>{fromCurrency}</Text>
                      </View>
                    </View>
                    <TouchableOpacity onPress={setMax} disabled={fromBalance <= 0 || balanceLocked}>
                      <Text style={[styles.maxText, (fromBalance <= 0 || balanceLocked) && { opacity: 0.4 }]}>
                        {t('hypertradeUserTransferSheet.max')}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.field}>
                    <View style={styles.recipientHeader}>
                      <Text style={styles.fieldLabel}>{t('hypertradeUserTransferSheet.recipientAccountId')}</Text>
                      {recipientDigits ? (
                        <TouchableOpacity
                          onPress={onClearRecipient}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={styles.clearLink}>{t('hypertradeUserTransferSheet.clearRecipient')}</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <TextInput
                      style={styles.fieldInput}
                      value={recipientId}
                      onChangeText={(text) => {
                        setRecipientId(text);
                        const digits = text.replace(/\D/g, '');
                        if (pickedSavedId) {
                          const picked = savedRecipients.find((r) => r.id === pickedSavedId);
                          if (!picked || String(picked.recipient_ur_id) !== digits) {
                            setPickedSavedId(null);
                            setSaveLabel('');
                          }
                        }
                      }}
                      keyboardType="number-pad"
                      placeholder={t('hypertradeUserTransferSheet.accountIdPlaceholder')}
                      placeholderTextColor={colors.text.tertiary}
                      autoCorrect={false}
                    />
                    <Text style={styles.fieldHint}>{accountIdHint}</Text>
                  </View>

                  {savedRecipients.length > 0 ? (
                    <View style={styles.savedSection}>
                      <TouchableOpacity
                        style={[styles.savedPickerToggle, matchingSaved && styles.savedPickerToggleActive]}
                        onPress={() => setSavedPickerOpen((v) => !v)}
                        activeOpacity={0.85}
                      >
                        <Ionicons
                          name={matchingSaved ? 'person-circle' : 'people-outline'}
                          size={18}
                          color={matchingSaved ? colors.accent.gold : colors.text.secondary}
                        />
                        {matchingSaved ? (
                          <View style={styles.savedPickerSelected}>
                            <Text style={styles.savedPickerSelectedName} numberOfLines={1}>
                              {matchingSaved.label}
                            </Text>
                            <Text style={styles.savedPickerSelectedSub} numberOfLines={1}>
                              {formatUridDisplay(matchingSaved.recipient_ur_id)}
                            </Text>
                          </View>
                        ) : (
                          <Text style={styles.savedPickerToggleText}>
                            {t('hypertradeUserTransferSheet.chooseSavedRecipient')}
                          </Text>
                        )}
                        <Ionicons
                          name={savedPickerOpen ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={colors.text.tertiary}
                        />
                      </TouchableOpacity>
                      {savedPickerOpen ? (
                        <View style={styles.savedPickerList}>
                          {savedRecipients.map((row) => {
                            const active = pickedSavedId === row.id;
                            return (
                              <TouchableOpacity
                                key={row.id}
                                style={[styles.contactRow, active && styles.contactRowActive]}
                                onPress={() => onPickSaved(row)}
                                activeOpacity={0.85}
                              >
                                <View style={styles.contactAvatar}>
                                  <Ionicons name="person-outline" size={16} color={colors.text.secondary} />
                                </View>
                                <View style={styles.contactBody}>
                                  <Text style={styles.contactName} numberOfLines={1}>{row.label}</Text>
                                  <Text style={styles.contactSub} numberOfLines={1}>
                                    {formatUridDisplay(row.recipient_ur_id)}
                                  </Text>
                                </View>
                                {active ? (
                                  <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
                                ) : (
                                  <TouchableOpacity
                                    onPress={() => void onDeleteSaved(row)}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('hypertradeUserTransferSheet.removeSaved')}
                                  >
                                    <Ionicons name="close-circle-outline" size={18} color={colors.text.tertiary} />
                                  </TouchableOpacity>
                                )}
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ) : null}
                    </View>
                  ) : null}

                  {recipientDigits && senderUrid !== recipientUrid ? (
                    <View style={styles.field}>
                      <Text style={styles.fieldLabel}>{t('hypertradeUserTransferSheet.saveLabel')}</Text>
                      <View style={styles.saveRow}>
                        <TextInput
                          style={[styles.fieldInput, styles.saveInput]}
                          value={saveLabel}
                          onChangeText={setSaveLabel}
                          placeholder={t('hypertradeUserTransferSheet.saveLabelPlaceholder')}
                          placeholderTextColor={colors.text.tertiary}
                          autoCorrect={false}
                        />
                        <TouchableOpacity
                          style={[styles.saveBtn, !canSaveRecipient && styles.saveBtnDisabled]}
                          onPress={() => void onSaveRecipient()}
                          disabled={!canSaveRecipient}
                          activeOpacity={0.85}
                        >
                          <Text style={styles.saveBtnText}>
                            {matchingSaved
                              ? t('hypertradeUserTransferSheet.updateSaved')
                              : t('hypertradeUserTransferSheet.saveRecipient')}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}

                  {inputErr ? <Text style={styles.errText}>{inputErr}</Text> : null}
                  <Text style={styles.disclaimer}>{t('hypertradeUserTransferSheet.disclaimer')}</Text>
                  <ConfirmButton
                    busy={preparingReview}
                    enabled={canContinue}
                    label={preparingReview ? t('withdrawSheet.preparing') : t('hypertradeUserTransferSheet.continue')}
                    onPress={canContinue ? () => void onContinue() : undefined}
                  />
                </KeyboardAwareScrollView>
              )}
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function ReviewRow({
  label,
  value,
  strong,
  highlight,
}: {
  label: string;
  value: string;
  strong?: boolean;
  highlight?: boolean;
}) {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewRowLabel}>{label}</Text>
      <Text
        style={[
          styles.reviewRowValue,
          strong && styles.reviewRowValueStrong,
          highlight && styles.feeFreeText,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function ConfirmButton({
  busy, enabled, label, onPress,
}: { busy: boolean; enabled: boolean; label: string; onPress?: () => void }) {
  const interactive = !!onPress && (enabled || busy);
  return (
    <TouchableOpacity
      style={[styles.confirmBtn, !interactive && styles.confirmBtnDisabled]}
      onPress={onPress}
      disabled={!interactive}
      activeOpacity={busy ? 1 : 0.85}
    >
      <LinearGradient
        colors={busy || enabled ? CONFIRM_GRADIENT : CONFIRM_GRADIENT_DISABLED}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.confirmGradient}
        pointerEvents="none"
      >
        {busy ? (
          <>
            <ActivityIndicator size="small" color={GRADIENT_BTN_SPINNER_BUSY} />
            <Text style={gradientConfirmTextBusy}>{label}</Text>
          </>
        ) : (
          <Text style={[styles.confirmText, !enabled && { color: colors.text.tertiary }]}>{label}</Text>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheetWrap: { width: '100%' },
  safeArea: { backgroundColor: 'transparent' },
  formScroll: { flexGrow: 0, flexShrink: 1 },
  formScrollContent: { paddingBottom: 8 },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleArea: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginBottom: 4 },
  handle: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border.primary },
  title: { fontSize: 20, fontWeight: '800', color: colors.text.primary, marginBottom: 16 },
  blockBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(224,162,59,0.10)',
    borderColor: 'rgba(224,162,59,0.35)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  blockBannerBody: { flex: 1 },
  blockBannerTitle: { fontSize: 13, fontWeight: '800', color: '#e0a23b', marginBottom: 2 },
  blockBannerText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text.secondary },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  smallLabel: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
  smallLabelMuted: { fontSize: 11, color: colors.text.tertiary },
  block: {
    backgroundColor: colors.background.elevated,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 14,
  },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountInput: { flex: 1, fontSize: 24, fontWeight: '800', color: colors.text.primary, paddingVertical: 2 },
  field: { marginBottom: 4 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, marginBottom: 6 },
  fieldInput: {
    backgroundColor: colors.background.elevated,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  fieldHint: { fontSize: 11, color: colors.text.tertiary, marginTop: 6, lineHeight: 16 },
  currencyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  currencyChipText: { fontSize: 14, fontWeight: '800', color: colors.text.primary },
  maxText: { color: colors.accent.gold, fontSize: 11, fontWeight: '700', marginTop: 6, letterSpacing: 0.5 },
  errText: { color: '#e57373', fontSize: 12, marginTop: 8, fontWeight: '600' },
  disclaimer: { fontSize: 11, color: colors.text.tertiary, marginTop: 10, lineHeight: 16 },
  confirmBtn: { marginTop: 16, borderRadius: 14, overflow: 'hidden', alignSelf: 'stretch' },
  confirmBtnDisabled: { opacity: 0.7 },
  confirmGradient: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  confirmText: { fontSize: 15, fontWeight: '800', color: colors.background.primary, letterSpacing: 0.3 },
  secondaryBtn: {
    marginTop: 12,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  actionBtnFull: { alignSelf: 'stretch', width: '100%' },
  secondaryBtnText: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
  reviewCard: {
    backgroundColor: colors.background.elevated,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 12,
    marginBottom: 4,
  },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewRowLabel: { fontSize: 13, color: colors.text.secondary },
  reviewRowValue: {
    fontSize: 14,
    color: colors.text.primary,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 12,
  },
  reviewRowValueStrong: { fontSize: 16, fontWeight: '800' },
  feeFreeText: { color: colors.accent.gold, fontWeight: '700' },
  reviewDivider: { height: 1, backgroundColor: colors.border.primary },
  recipientHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  clearLink: { fontSize: 12, fontWeight: '700', color: colors.accent.gold },
  savedSection: { marginTop: 10, marginBottom: 4 },
  savedPickerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.elevated,
  },
  savedPickerToggleActive: { borderColor: colors.accent.gold },
  savedPickerToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  savedPickerSelected: { flex: 1, minWidth: 0 },
  savedPickerSelectedName: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  savedPickerSelectedSub: { fontSize: 11, color: colors.text.tertiary, marginTop: 1 },
  savedPickerList: { marginTop: 8 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 8,
    backgroundColor: colors.background.elevated,
  },
  contactRowActive: { borderColor: colors.accent.gold },
  contactAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.card,
  },
  contactBody: { flex: 1, minWidth: 0 },
  contactName: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  contactSub: { fontSize: 11, color: colors.text.tertiary, marginTop: 2 },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveInput: { flex: 1, marginBottom: 0 },
  saveBtn: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  saveBtnDisabled: { opacity: 0.45 },
  saveBtnText: { fontSize: 12, fontWeight: '700', color: colors.accent.gold },
  resultBlock: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 12,
    alignSelf: 'stretch',
  },
  resultTitle: { fontSize: 20, fontWeight: '800', color: colors.text.primary, textAlign: 'center' },
  resultBody: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 8 },
});
