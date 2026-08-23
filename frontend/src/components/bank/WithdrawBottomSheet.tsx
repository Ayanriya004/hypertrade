/**
 * WithdrawBottomSheet — cash-out URID fiat -> USDC, gasless via EIP-2612 permit.
 *
 * ARCHITECTURE (load-bearing — read before editing)
 * =================================================
 * External Wallet Access mode. Cash-out uses UR's gasless permit on-ramp
 * (NOT a relayer/7702 batch like Add Money / Convert):
 *
 *   input    → user enters amount + source fiat currency
 *   preparing→ resolve embedded wallet + provider
 *   quoting  → sign Full-Auth headers (personal_sign) + POST /ur/withdraw/quote
 *              (forwards to UR /api/v1/quote/onramp). One signature prompt.
 *   review   → show USDC out, fees, rate; user taps Confirm
 *   signing  → sign EIP-2612 permit (eth_signTypedData_v4) over the fiat token
 *   submitting→ POST /ur/withdraw/execute → UR /api/v1/onramp-with-permit
 *              (UR validates the permit, executes, pays gas)
 *   confirming→ poll /ur/jobs/:id until terminal
 *   success / error
 *
 * Unlike Convert, the quote needs a wallet Full-Auth signature (UR gates the
 * quote endpoint), so we use a REVIEW-SCREEN flow rather than live-as-you-type
 * quoting — one auth signature at "Continue", one permit at "Confirm".
 *
 * Signing helpers live in `lib/urOnrampAuth.ts` (mirror of
 * `backend/ur_onramp_permit.py`). API client in `lib/urApi.ts`.
 *
 * STATUS (2026-06-01): WORKING end-to-end. UR cleared the region flag on the
 *   QA URID, so the old retCode=10000 "Convert is unavailable in your region"
 *   no longer fires — submit settles on-chain (Mantle burn tx). The
 *   `regionBlocked` error path is retained as a safety net (mainnet/other
 *   accounts may still hit it). Job status now reconciles promptly server-side
 *   (backend `_reconcile_onramp_from_source_receipt`), so the sheet no longer
 *   hangs on "Finalising withdrawal…".
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
  KeyboardAvoidingView,
  Pressable,
  Alert,
  Image,
  Dimensions,
  ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { buildExchangeRateLine } from '../../lib/exchangeRateDisplay';
import { getMantleChain, resolveMantleChainId } from '../../lib/mantleFiatBalance';
import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import { useUrTransferLimit } from '../../hooks/useUrTransferLimit';
import { SpendableBalanceLine } from './SpendableBalanceLine';
import { CircleCurrencyFlag } from './CircleCountryFlag';

const USDC_ICON = require('../../../assets/images/usdc-icon.webp');
import { useAuth } from '../../providers/AuthContext';
import {
  fetchUrWithdrawInfo,
  requestUrWithdrawQuote,
  executeUrWithdraw,
  fetchUrJob,
  isUrJobTerminal,
  fetchUrLivenessToken,
  fetchUrLivenessStatus,
  fetchUrPendingRetry,
  cancelUrRetry,
  pendingRetryOriginalTxHash,
  requestUrRetryQuote,
  submitUrRetry,
  type UrWithdrawInfoResponse,
  type UrWithdrawQuoteResponse,
  type UrPendingRetry,
  type UrExtAuth,
  type CashAccountRow,
  defaultFromCurrency,
} from '../../lib/urApi';
import { buildFullAuth, signOnrampPermit } from '../../lib/urOnrampAuth';
import { launchSumsubKyc, isSumsubAvailable } from '../../lib/sumsubKyc';
import { useLiveQuote } from '../../hooks/useLiveQuote';
import { QuoteCountdownRing } from './QuoteCountdownRing';
import { BankConfirmModal } from './BankConfirmModal';
import { GRADIENT_BTN_SPINNER_BUSY, gradientConfirmTextBusy } from './bankSheetUi';
import { BouncingDots } from '../BouncingDots';

// ─────────────────────────────────────────────────────────────────────────── //
// Constants
// ─────────────────────────────────────────────────────────────────────────── //

const SHEET_TRAVEL = 800;
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const WITHDRAW_PICKER_LIST_MIN_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);
const CONFIRM_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;
const CONFIRM_GRADIENT_DISABLED = [colors.background.tertiary, colors.background.tertiary] as const;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const JOB_POLL_INTERVAL_MS = 1500;
const JOB_POLL_MAX_ATTEMPTS = 40;

const FX_CURRENCY_LABELS: Record<string, string> = {
  USD: 'US Dollar',
  EUR: 'Euro',
  CHF: 'Swiss Franc',
  CNH: 'Chinese Yuan',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  JPY: 'Japanese Yen',
};

function fxCurrencyLabel(code: string): string {
  return FX_CURRENCY_LABELS[code] ?? code;
}

type Stage =
  | 'input'
  | 'preparing'
  | 'quoting'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'error';

export interface WithdrawBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  cashRows: CashAccountRow[];
  /** Rolling-30-day transfer limit (CHF, 2dp) for a pre-flight block. */
  usedLimit?: number;
  clientLimit?: number;
  /** USD-equivalent rates (ISO → USD24/unit) to size the amount in CHF. */
  usdRates?: Record<string, number>;
  /**
   * Called once after the withdraw job reaches a terminal `completed`.
   * `incoming` describes the USDC arriving in the user's own connected wallet
   * (drives the sticky "USDC incoming to Wallet Balance" banner).
   */
  onSuccess?: (incoming?: {
    amount: string;
    destChainId: number;
  }) => Promise<void> | void;
}

export function WithdrawBottomSheet({
  visible,
  onClose,
  cashRows,
  usedLimit,
  clientLimit,
  usdRates,
  onSuccess,
}: WithdrawBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { getAccessToken, walletAddress } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();

  // Resolve the wallet matching the URID-owning EOA useAuth() exposes (NOT
  // wallets[0] — see ConvertBottomSheet for the full rationale).
  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return undefined;
    if (!walletAddress) return wallets[0];
    const target = walletAddress.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === target) ?? wallets[0];
  }, [wallets, walletAddress]);

  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);

  const spendableBalances = useSpendableMantleBalances({
    active: mounted,
    walletAddress,
    getAccessToken,
  });

  const [info, setInfo] = useState<UrWithdrawInfoResponse | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoErr, setInfoErr] = useState<string | null>(null);

  const initialFrom = useMemo(
    () => defaultFromCurrency(cashRows),
    [cashRows],
  );
  const [fromCurrency, setFromCurrency] = useState<string>(initialFrom);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [amount, setAmount] = useState<string>('');
  const [stage, setStage] = useState<Stage>('input');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Full-Auth signed once at Continue, reused for the submit + re-quotes.
  const authRef = useRef<UrExtAuth | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ amount: string; chain: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Live-quote reset, routed through a ref so close/reset handlers defined
  // above the hook can call it without ordering/dependency churn.
  const liveQuoteResetRef = useRef<() => void>(() => {});

  // Re-anchor when balances arrive: keep a manual pick, but drop a stale
  // zero-balance default once funded accounts are known.
  useEffect(() => {
    if (!cashRows.length) return;
    setFromCurrency((prev) => {
      const prevRow = cashRows.find((r) => r.currency === prev);
      if (!prevRow) return initialFrom;
      if (prevRow.amount <= 0) {
        const bestRow = cashRows.find((r) => r.currency === initialFrom);
        if ((bestRow?.amount ?? 0) > 0) return initialFrom;
      }
      return prev;
    });
  }, [cashRows, initialFrom]);

  // ─── Sheet open/close animation ─────────────────────────────────────────
  const finishClose = useCallback(() => {
    setMounted(false);
    setAmount('');
    liveQuoteResetRef.current();
    setStage('input');
    setErrMsg(null);
    setSuccessInfo(null);
    setConfirmOpen(false);
    setPickerOpen(false);
    authRef.current = null;
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
      setFromCurrency(defaultFromCurrency(cashRows));
      setAmount('');
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose, cashRows]);

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

  // ─── Info fetch ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setInfoLoading(true);
    setInfoErr(null);
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no token');
        const resp = await fetchUrWithdrawInfo(token);
        if (cancelled) return;
        setInfo(resp);
        if (!resp.supported) setInfoErr(t('withdrawSheet.unsupported'));
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? 'info_failed';
        setInfoErr(String(msg));
      } finally {
        if (!cancelled) setInfoLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mounted, getAccessToken, t]);

  // ─── Derived ───────────────────────────────────────────────────────────
  const spendable = spendableBalances.forCurrency(fromCurrency);
  const fromBalance = spendable?.amount ?? 0;
  const fromBalanceStr = spendable?.amountStr ?? '—';
  const amountNum = useMemo(() => {
    const n = parseFloat(amount.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const destChain = useMemo(() => {
    if (!info) return null;
    const id = info.default_dest_chain_id;
    return info.dest_chains.find((c) => c.chain_id === id) ?? info.dest_chains[0] ?? null;
  }, [info]);

  // Rolling-30-day limit pre-flight — withdrawals (on-ramp to USDC) draw from
  // the same CHF-denominated limit as every other outgoing fiat op.
  const transferLimit = useUrTransferLimit({
    usedLimit,
    clientLimit,
    amount: amountNum,
    currency: fromCurrency,
    usdRates,
  });
  const limitReached = transferLimit.block;

  const inputErr: string | null = useMemo(() => {
    if (spendableBalances.loading || !spendableBalances.ready) {
      if (spendableBalances.error) {
        return t('bankSheet.balanceUnavailable', {
          defaultValue: "Couldn't read your wallet balance. Try again.",
        });
      }
      return null;
    }
    if (!amount) return null;
    if (amountNum <= 0) return t('withdrawSheet.invalidAmount');
    if (amountNum > fromBalance) return t('withdrawSheet.notEnough', { currency: fromCurrency });
    return null;
  }, [amount, amountNum, fromBalance, fromCurrency, t, spendableBalances]);

  const buildWalletClient = useCallback(async (): Promise<{ client: WalletClient; userAddr: Hex }> => {
    if (!wallet || !walletAddress) throw new Error(t('withdrawSheet.noWallet'));
    if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(`Wallet mismatch: ${wallet.address} != ${walletAddress}. Please re-login.`);
    }
    const provider = await wallet.getProvider();
    const chain = getMantleChain(resolveMantleChainId(info?.mantle_chain_id));
    const client = createWalletClient({
      account: walletAddress as Hex,
      chain,
      transport: custom(provider),
    });
    return { client, userAddr: walletAddress as Hex };
  }, [wallet, walletAddress, info, t]);

  const friendlyError = useCallback((detail: string): string => {
    const lower = detail.toLowerCase();
    if (lower.includes('region')) return t('withdrawSheet.regionBlocked');
    if (lower.includes('expired') || lower.includes('10040')) return t('withdrawSheet.quoteExpired');
    return detail;
  }, [t]);

  // Fetch a quote with the cached Full-Auth (no new signature). Shared by the
  // initial Continue and the live auto-refresh.
  const runQuote = useCallback(
    async (token: string, auth: UrExtAuth): Promise<UrWithdrawQuoteResponse> => {
      if (!destChain || !walletAddress) throw new Error('not ready');
      return requestUrWithdrawQuote(token, {
        auth,
        source_currency: fromCurrency,
        source_amount: String(amountNum),
        dest_chain_id: destChain.chain_id,
        dest_token: 'USDC',
        auth_owner_address: walletAddress,
      });
    },
    [destChain, walletAddress, fromCurrency, amountNum],
  );

  const handleQuoteError = useCallback((err: unknown, fallbackStage: Stage) => {
    const detail =
      (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
      (err as { shortMessage?: string })?.shortMessage ??
      (err as { message?: string })?.message ?? t('withdrawSheet.unknownError');
    const lower = String(detail).toLowerCase();
    if (lower.includes('user rejected') || lower.includes('user denied')) {
      setStage(fallbackStage);
      return;
    }
    setErrMsg(friendlyError(String(detail)));
    setStage('error');
  }, [t, friendlyError]);

  // Live quote with expiry + silent auto-refresh (generic hook). Active only
  // while reviewing; reuses the cached Full-Auth so refreshes never prompt.
  // Hard errors (region/expired) flip us to the error screen.
  const liveQuote = useLiveQuote<UrWithdrawQuoteResponse>({
    active: stage === 'review',
    refetch: useCallback(async () => {
      const auth = authRef.current;
      if (!auth) throw new Error('not authorised');
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const resp = await runQuote(token, auth);
      return { quote: resp, ttlSeconds: resp.quote_ttl_seconds };
    }, [getAccessToken, runQuote]),
    isHardError: useCallback(
      (d: string) => {
        const l = d.toLowerCase();
        return l.includes('region') || l.includes('expired') || l.includes('10040');
      },
      [],
    ),
    onHardError: useCallback((d: string) => {
      setErrMsg(friendlyError(d));
      setStage('error');
    }, [friendlyError]),
  });
  const quote = liveQuote.quote;
  liveQuoteResetRef.current = liveQuote.reset;

  // ─── Stranded cash-out recovery (UR §5.1.6–5.1.8) ────────────────────────
  // A cash-out can land the burn on Mantle but fail the destination swap,
  // leaving USDC stranded on the dst chain. UR exposes a pending-retry record;
  // recovery re-quotes that failed swap, signs a fresh permit over the stranded
  // USDC and re-submits. NOTE: this fires whenever UR has a stranded record for
  // the account — testnet included (UR's QA env returns these too), not just
  // mainnet. The prompt on Continue is therefore expected if a prior cash-out
  // got stuck mid-transfer.
  const recoverPendingRetry = useCallback(
    async (pr: UrPendingRetry, auth: UrExtAuth) => {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setErrMsg(null);
      setStage('signing');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const { client, userAddr } = await buildWalletClient();
        const chainId = Number(String(pr.chainId).split(':').pop());

        const rq = await requestUrRetryQuote(token, {
          auth,
          chain_id: chainId,
          from_token: pr.fromToken,
          to_token: pr.toToken,
          amount: pr.amount,
          owner_address: userAddr,
        });
        const permit = rq.permit;
        if (!permit || !permit.name || !permit.version || permit.nonce == null) {
          throw new Error(t('withdrawSheet.retryUnavailable'));
        }
        const permitDeadline = Math.floor(Date.now() / 1000) + 1800;
        const sig = await signOnrampPermit(client, {
          account: userAddr,
          token: permit.token as Hex,
          spender: permit.spender as Hex,
          value: BigInt(permit.value),
          deadline: permitDeadline,
          chainId: permit.chain_id,
          name: permit.name,
          version: permit.version,
          nonce: permit.nonce,
        });

        setStage('submitting');
        const best = rq.result.best || {};
        await submitUrRetry(token, {
          auth,
          quote_id: String(rq.result.quoteId ?? ''),
          chain_id: permit.chain_id,
          original_tx_hash: pendingRetryOriginalTxHash(pr),
          usdc_amount: pr.amount,
          token_out: pr.toToken,
          min_amount_out: String(best.minAmountOut ?? rq.result.minAmountOut ?? '0'),
          aggregator: best.to || ZERO_ADDR,
          swap_calldata: best.swapCalldata || '0x',
          permit_deadline: permitDeadline,
          permit_v: sig.v,
          permit_r: sig.r,
          permit_s: sig.s,
        });

        setStage('confirming');
        setSuccessInfo({ amount: pr.amount, chain: String(chainId) });
        setStage('success');
        try {
          await onSuccess?.({ amount: String(pr.amount), destChainId: chainId });
        } catch { /* best-effort */ }
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { shortMessage?: string })?.shortMessage ??
          (err as { message?: string })?.message ?? t('withdrawSheet.unknownError');
        const lower = String(detail).toLowerCase();
        if (lower.includes('user rejected') || lower.includes('user denied')) {
          setStage('input');
          return;
        }
        setErrMsg(friendlyError(detail));
        setStage('error');
      }
    },
    [getAccessToken, buildWalletClient, onSuccess, t, friendlyError],
  );

  const cancelPendingRetry = useCallback(
    async (pr: UrPendingRetry, auth: UrExtAuth) => {
      setStage('input');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const txHash = pendingRetryOriginalTxHash(pr);
        await cancelUrRetry(token, {
          auth,
          ...(txHash ? { original_tx_hash: txHash } : {}),
        });
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string | Array<{ msg?: string }> } } })
            ?.response?.data?.detail ??
          (err as { message?: string })?.message ??
          t('withdrawSheet.unknownError');
        const msg = Array.isArray(detail)
          ? detail.map((d) => d?.msg).filter(Boolean).join(', ') || t('withdrawSheet.unknownError')
          : String(detail);
        Alert.alert(t('withdrawSheet.retryTitle'), friendlyError(msg));
      }
    },
    [getAccessToken, t, friendlyError],
  );

  const promptPendingRetry = useCallback(
    (pr: UrPendingRetry, auth: UrExtAuth) => {
      Alert.alert(
        t('withdrawSheet.retryTitle'),
        t('withdrawSheet.retryBody', { amount: pr.amount }),
        [
          {
            text: t('withdrawSheet.retryCancelAction'),
            style: 'destructive',
            onPress: () => { void cancelPendingRetry(pr, auth); },
          },
          { text: t('withdrawSheet.retryDismiss'), style: 'cancel', onPress: () => setStage('input') },
          { text: t('withdrawSheet.retryRecoverAction'), onPress: () => { void recoverPendingRetry(pr, auth); } },
        ],
      );
    },
    [t, cancelPendingRetry, recoverPendingRetry],
  );

  // ─── Continue: Full-Auth + quote → review ────────────────────────────────
  const onContinue = useCallback(async () => {
    if (inputErr || !info || !destChain || spendableBalances.balanceLocked) return;
    if (limitReached) {
      setErrMsg(transferLimit.message || t('withdrawSheet.unknownError'));
      setStage('error');
      return;
    }
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setErrMsg(null);
    setStage('preparing');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const { client, userAddr } = await buildWalletClient();

      setStage('quoting');
      const auth = await buildFullAuth(client, userAddr);
      authRef.current = auth;

      // Reuse the just-signed Full-Auth to check for a stranded prior cash-out.
      // If one exists, recover/cancel it before starting a fresh withdraw (UR
      // rejects a new onramp while a retry is pending). No extra signature.
      try {
        const pend = await fetchUrPendingRetry(token, { auth });
        if (pend.result) {
          setStage('input');
          promptPendingRetry(pend.result, auth);
          return;
        }
      } catch { /* non-fatal — proceed with the new withdraw */ }

      const resp = await runQuote(token, auth);
      liveQuote.seed(resp, resp.quote_ttl_seconds);
      setStage('review');
    } catch (err: unknown) {
      handleQuoteError(err, 'input');
    }
  }, [
    inputErr, info, destChain, getAccessToken, buildWalletClient,
    runQuote, liveQuote, handleQuoteError, promptPendingRetry,
    limitReached, transferLimit.message, spendableBalances.balanceLocked, t,
  ]);

  // ─── Liveness gate (UR §5.1.3/5.1.4) ─────────────────────────────────────
  // Larger mainnet cash-outs return needLiveness=true; the user must pass a
  // Sumsub liveness check before onramp-with-permit is accepted. No-op when the
  // quote doesn't require it (always the case on small/testnet amounts).
  const ensureLivenessIfNeeded = useCallback(
    async (token: string, auth: UrExtAuth): Promise<void> => {
      if (!quote?.result?.needLiveness) return;
      // Maybe already passed (and not expired) from a prior attempt.
      try {
        const st = await fetchUrLivenessStatus(token, { auth });
        if (String(st.result?.liveness_result ?? '').toLowerCase() === 'pass') return;
        if (st.result?.liveness_locked) {
          throw new Error(t('withdrawSheet.livenessLocked'));
        }
      } catch (e) {
        if (e instanceof Error && e.message === t('withdrawSheet.livenessLocked')) throw e;
        // status read is best-effort — fall through to mint + run
      }
      if (!isSumsubAvailable()) {
        throw new Error(t('withdrawSheet.livenessNeedsBuild'));
      }
      const minted = await fetchUrLivenessToken(token, { auth });
      const accessToken = minted.result?.access_token;
      if (!accessToken) throw new Error(t('withdrawSheet.livenessStartFailed'));
      await launchSumsubKyc({
        accessToken,
        getFreshToken: async () => {
          const r = await fetchUrLivenessToken(token, { auth });
          return r.result?.access_token || accessToken;
        },
      });
      // UR finalises liveness asynchronously — poll until pass/rejected.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const st = await fetchUrLivenessStatus(token, { auth });
          const res = String(st.result?.liveness_result ?? '').toLowerCase();
          if (res === 'pass') return;
          if (res === 'rejected') {
            throw new Error(st.result?.liveness_fail_reason || t('withdrawSheet.livenessRejected'));
          }
        } catch (e) {
          if (e instanceof Error && /reject/i.test(e.message)) throw e;
          // transient read error — keep polling
        }
      }
      throw new Error(t('withdrawSheet.livenessPending'));
    },
    [quote, t],
  );

  // ─── Confirm: permit + submit + poll ─────────────────────────────────────
  const executeWithdraw = useCallback(async () => {
    if (!quote || !info || !destChain) return;
    const auth = authRef.current;
    if (!auth) { setStage('input'); return; }
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setErrMsg(null);
    setStage('signing');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      // Mainnet compliance: pass liveness first if the quote demands it.
      await ensureLivenessIfNeeded(token, auth);
      const { client, userAddr } = await buildWalletClient();

      const permit = quote.permit;
      if (!permit.name || !permit.version || permit.nonce == null) {
        throw new Error('Permit domain unavailable — please retry');
      }
      const permitDeadline = Math.floor(Date.now() / 1000) + 1800;
      const sig = await signOnrampPermit(client, {
        account: userAddr,
        token: permit.token as Hex,
        spender: permit.spender as Hex,
        value: BigInt(permit.value),
        deadline: permitDeadline,
        chainId: permit.chain_id,
        name: permit.name,
        version: permit.version,
        nonce: permit.nonce,
      });

      setStage('submitting');
      const best = quote.result.best || {};
      const idempotencyKey = `withdraw-${userAddr.toLowerCase()}-${fromCurrency}-${Date.now()}`;
      const resp = await executeUrWithdraw(token, {
        auth,
        quote_id: quote.result.quoteId,
        idempotency_key: idempotencyKey,
        source_currency: fromCurrency,
        source_amount: String(amountNum),
        dest_chain_id: destChain.chain_id,
        dest_token: 'USDC',
        target_amount: quote.result.outputAmount,
        dst_aggregator: best.to || ZERO_ADDR,
        dst_token_out: destChain.usdc || quote.addresses.dest_token,
        dst_swap_calldata: best.swapCalldata || '0x',
        dst_min_amount_out: String(best.minAmountOut || '0'),
        permit_deadline: permitDeadline,
        permit_v: sig.v,
        permit_r: sig.r,
        permit_s: sig.s,
      });

      if (resp.dispatch_error) throw new Error(resp.dispatch_error);

      // Poll the job to terminal. UR's submit returns the Mantle burn tx;
      // the backend reconciler advances the job to completed.
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
          // transient — keep polling
        }
      }
      if (status === 'failed') {
        throw new Error(t('withdrawSheet.unknownError'));
      }
      // completed OR still confirming after timeout — either way the submit
      // landed; surface success and let the dashboard tx list reconcile.
      setSuccessInfo({ amount: quote.result.outputAmount, chain: destChain.name });
      setStage('success');
      try {
        await onSuccess?.({
          amount: String(quote.result.outputAmount),
          destChainId: destChain.chain_id,
        });
      } catch { /* best-effort */ }
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { shortMessage?: string })?.shortMessage ??
        (err as { message?: string })?.message ?? t('withdrawSheet.unknownError');
      const lower = String(detail).toLowerCase();
      if (lower.includes('user rejected') || lower.includes('user denied')) {
        setStage('review');
        return;
      }
      setErrMsg(friendlyError(String(detail)));
      setStage('error');
    }
  }, [
    quote, info, destChain, getAccessToken, buildWalletClient,
    fromCurrency, amountNum, onSuccess, t, friendlyError, ensureLivenessIfNeeded,
  ]);

  const onPressConfirm = useCallback(() => {
    setConfirmOpen(true);
  }, []);

  const handleConfirmModal = useCallback(() => {
    void executeWithdraw();
    setConfirmOpen(false);
  }, [executeWithdraw]);

  const setMax = useCallback(() => {
    if (!spendableBalances.ready || fromBalance <= 0) return;
    setAmount(spendable?.amountStr ?? String(fromBalance));
  }, [spendableBalances.ready, fromBalance, spendable?.amountStr]);

  const basePickerOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { currency: string; amount: number; amountStr: string }[] = [];
    for (const row of cashRows) {
      if (seen.has(row.currency)) continue;
      seen.add(row.currency);
      opts.push({ currency: row.currency, amount: row.amount, amountStr: row.amountStr });
    }
    return opts;
  }, [cashRows]);

  const pickerOptions = useMemo(
    () => spendableBalances.decoratePickerOptions(basePickerOptions),
    [basePickerOptions, spendableBalances],
  );

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent
      onRequestClose={closeable ? animateClose : undefined}>
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.65] }) }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeable ? animateClose : undefined} />
        </Animated.View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav} pointerEvents="box-none">
          <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}>
            <SafeAreaView edges={['bottom']} style={styles.safeArea}>
              <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom * 0.2 }]}>
                <View {...panResponder.panHandlers} style={styles.handleArea}>
                  <View style={styles.handle} />
                </View>

                {infoErr ? (
                  <ResultView kind="error" title={t('withdrawSheet.errorTitle')} body={infoErr}
                    primaryLabel={t('withdrawSheet.errorClose')} onPrimary={animateClose} />
                ) : infoLoading && !info ? (
                  <View style={styles.loadingBlock}>
                    <BouncingDots color={colors.text.primary} pulse />
                  </View>
                ) : stage === 'success' ? (
                  <ResultView kind="success" title={t('withdrawSheet.successTitle')}
                    body={t('withdrawSheet.successBody', {
                      amount: formatAmount(successInfo?.amount),
                      token: 'USDC',
                      chain: successInfo?.chain ?? destChain?.name ?? '',
                    })}
                    primaryLabel={t('withdrawSheet.successDone')} onPrimary={animateClose} />
                ) : stage === 'error' ? (
                  <ResultView kind="error" title={t('withdrawSheet.errorTitle')} body={errMsg}
                    primaryLabel={t('withdrawSheet.errorRetry')}
                    onPrimary={() => { setStage('input'); setErrMsg(null); }}
                    secondaryLabel={t('withdrawSheet.errorClose')} onSecondary={animateClose} />
                ) : stage === 'review' || stage === 'signing' || stage === 'submitting' || stage === 'confirming' ? (
                  <ReviewView
                    quote={quote}
                    fromCurrency={fromCurrency}
                    amount={String(amountNum)}
                    destName={destChain?.name ?? ''}
                    onConfirm={onPressConfirm}
                    onBack={() => setStage('input')}
                    stage={stage}
                    secondsLeft={liveQuote.secondsLeft}
                    quoteTtl={liveQuote.ttl}
                    refreshing={liveQuote.refreshing}
                    onRefreshNow={liveQuote.refreshNow}
                  />
                ) : (
                  <InputView
                    fromCurrency={fromCurrency}
                    fromBalanceStr={fromBalanceStr}
                    fromBalance={fromBalance}
                    fromBalanceLoading={spendableBalances.balanceLocked}
                    fromBalanceError={spendableBalances.error}
                    onRetryFromBalance={spendableBalances.refresh}
                    amount={amount}
                    onAmountChange={setAmount}
                    onMax={setMax}
                    onPickFrom={() => setPickerOpen(true)}
                    destName={destChain?.name ?? ''}
                    destToken={info?.dest_token ?? 'USDC'}
                    inputErr={inputErr}
                    limitReached={limitReached}
                    limitTitle={transferLimit.title}
                    limitText={transferLimit.message}
                    onContinue={onContinue}
                    stage={stage}
                  />
                )}
              </View>
            </SafeAreaView>
          </Animated.View>
        </KeyboardAvoidingView>

        {pickerOpen ? (
          <CurrencyPicker
            options={pickerOptions}
            currentlySelected={fromCurrency}
            onPick={(code) => { setFromCurrency(code); setPickerOpen(false); setAmount(''); liveQuote.reset(); }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null}

        <BankConfirmModal
          visible={confirmOpen}
          title={t('withdrawSheet.confirmTitle', 'Confirm withdrawal')}
          message={t('withdrawSheet.confirmMessage', {
            send: String(amountNum),
            from: fromCurrency,
            receive: formatAmount(quote?.result?.outputAmount),
            chain: destChain?.name ?? '',
            defaultValue:
              `Withdraw ${amountNum} ${fromCurrency} to receive ${formatAmount(quote?.result?.outputAmount)} USDC on ${destChain?.name ?? 'wallet'}?`,
          })}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleConfirmModal}
        />
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────── //
// Sub-views
// ─────────────────────────────────────────────────────────────────────────── //

function InputView({
  fromCurrency, fromBalanceStr, fromBalance, fromBalanceLoading, fromBalanceError,
  onRetryFromBalance, amount, onAmountChange, onMax,
  onPickFrom, destName, destToken, inputErr, limitReached, limitTitle, limitText, onContinue, stage,
}: {
  fromCurrency: string;
  fromBalanceStr: string;
  fromBalance: number;
  fromBalanceLoading: boolean;
  fromBalanceError: boolean;
  onRetryFromBalance: () => void;
  amount: string;
  onAmountChange: (s: string) => void;
  onMax: () => void;
  onPickFrom: () => void;
  destName: string;
  destToken: string;
  inputErr: string | null;
  limitReached: boolean;
  limitTitle: string;
  limitText: string;
  onContinue: () => void;
  stage: Stage;
}) {
  const { t } = useTranslation();
  const busy = stage === 'preparing' || stage === 'quoting';
  const balanceLocked = fromBalanceLoading || fromBalanceError;
  const canContinue = !busy && !inputErr && !limitReached && !balanceLocked && parseFloat(amount || '0') > 0;
  const ctaLabel = stage === 'preparing'
    ? t('withdrawSheet.preparing')
    : stage === 'quoting'
      ? t('withdrawSheet.authorising')
      : t('withdrawSheet.continue');

  return (
    <>
      <Text style={styles.title}>{t('withdrawSheet.title')}</Text>

      {limitReached ? (
        <View style={styles.blockBanner}>
          <Ionicons name="lock-closed" size={16} color="#e0a23b" />
          <View style={styles.blockBannerBody}>
            <Text style={styles.blockBannerTitle}>
              {limitTitle || t('bankLimit.fullyReachedTitle', { defaultValue: 'Monthly limit reached' })}
            </Text>
            <Text style={styles.blockBannerText}>
              {limitText || t('bankLimit.fullyReached', {
                defaultValue:
                  "You've reached your monthly transfer limit. It resets on a rolling 30-day basis.",
              })}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.block}>
        <View style={styles.rowBetween}>
          <Text style={styles.smallLabel}>{t('withdrawSheet.from')}</Text>
          <SpendableBalanceLine
            label={t('withdrawSheet.available')}
            currency={fromCurrency}
            amountStr={fromBalanceStr}
            loading={fromBalanceLoading}
            error={fromBalanceError}
            onRetry={onRetryFromBalance}
          />
        </View>
        <View style={styles.amountRow}>
          <TextInput
            value={amount}
            onChangeText={onAmountChange}
            placeholder="0"
            placeholderTextColor={colors.text.tertiary}
            keyboardType="decimal-pad"
            style={styles.amountInput}
            editable={!busy && !balanceLocked}
          />
          <TouchableOpacity onPress={onPickFrom} style={styles.currencyChip} disabled={busy}>
            <CircleCurrencyFlag currencyCode={fromCurrency} size={20} />
            <Text style={styles.currencyChipText}>{fromCurrency}</Text>
            <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onMax} disabled={fromBalance <= 0 || busy || balanceLocked}>
          <Text style={[styles.maxText, (fromBalance <= 0 || busy || balanceLocked) && { opacity: 0.4 }]}>
            {t('withdrawSheet.max')}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.arrowRow}>
        <View style={styles.swapLine} />
        <View style={styles.arrowBtn}>
          <Ionicons name="arrow-down" size={18} color={colors.accent.gold} />
        </View>
        <View style={styles.swapLine} />
      </View>

      <View style={styles.block}>
        <Text style={styles.smallLabel}>{t('withdrawSheet.to')}</Text>
        <View style={styles.destRow}>
          <View style={styles.destTokenBadge}>
            <Image source={USDC_ICON} style={styles.destTokenIcon} resizeMode="contain" />
            <Text style={styles.destTokenText}>{destToken}</Text>
          </View>
          <Text style={styles.destChainText}>
            {t('withdrawSheet.destinationHint', { token: destToken, chain: destName })}
          </Text>
        </View>
      </View>

      {inputErr ? <Text style={styles.errText}>{inputErr}</Text> : null}

      <Text style={styles.disclaimer}>
        {t('withdrawSheet.disclaimer', { token: destToken, chain: destName })}
      </Text>

      <ConfirmButton busy={busy} enabled={canContinue} label={ctaLabel}
        onPress={canContinue ? onContinue : undefined} />
    </>
  );
}

function ReviewView({
  quote, fromCurrency, amount, destName, onConfirm, onBack, stage,
  secondsLeft, quoteTtl, refreshing, onRefreshNow,
}: {
  quote: UrWithdrawQuoteResponse | null;
  fromCurrency: string;
  amount: string;
  destName: string;
  onConfirm: () => void;
  onBack: () => void;
  stage: Stage;
  secondsLeft: number;
  quoteTtl: number;
  refreshing: boolean;
  onRefreshNow: () => void;
}) {
  const { t } = useTranslation();
  const [rateInverted, setRateInverted] = useState(false);
  const busy = stage === 'signing' || stage === 'submitting' || stage === 'confirming';
  const r = quote?.result;
  useEffect(() => {
    setRateInverted(false);
  }, [fromCurrency, r?.exchangeRate]);
  const ctaLabel = (() => {
    switch (stage) {
      case 'signing': return t('withdrawSheet.signing');
      case 'submitting': return t('withdrawSheet.submitting');
      case 'confirming': return t('withdrawSheet.polling');
      default: return t('withdrawSheet.confirm');
    }
  })();

  // Flash the received amount whenever the quote refreshes to a new value, so
  // a silent re-quote is still visible to the user.
  const flash = useRef(new Animated.Value(0)).current;
  const prevOut = useRef<string | undefined>(r?.outputAmount);
  useEffect(() => {
    if (r?.outputAmount && prevOut.current && r.outputAmount !== prevOut.current) {
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 900, useNativeDriver: false }).start();
    }
    prevOut.current = r?.outputAmount;
  }, [r?.outputAmount, flash]);
  const receiveColor = flash.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.text.primary, colors.accent.gold],
  });

  // All-in cost: for USD→USDC use send−receive (nets network, spread, and any
  // partner fee baked into outputAmount). For other fiats fall back to UR totalFee.
  const totalFees = useMemo(() => {
    const sendNum = parseFloat(amount);
    const receiveNum = parseFloat(r?.outputAmount ?? '');
    const totalFeeNum = parseFloat(r?.totalFee ?? '');

    if (
      fromCurrency === 'USD' &&
      Number.isFinite(sendNum) &&
      Number.isFinite(receiveNum) &&
      sendNum > receiveNum + 0.0005
    ) {
      return { value: sendNum - receiveNum, prefix: '$' as const };
    }

    if (Number.isFinite(totalFeeNum) && totalFeeNum > 0) {
      return { value: totalFeeNum, prefix: `${fromCurrency} ` as const };
    }

    const networkFeeNum = parseFloat(r?.networkFee ?? '');
    if (Number.isFinite(networkFeeNum) && networkFeeNum > 0) {
      return { value: networkFeeNum, prefix: `${fromCurrency} ` as const };
    }
    return null;
  }, [amount, fromCurrency, r?.outputAmount, r?.totalFee, r?.networkFee]);

  return (
    <>
      <View style={styles.reviewHeader}>
        {!busy ? (
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        ) : <View style={{ width: 22 }} />}
        <Text style={styles.title}>{t('withdrawSheet.reviewTitle')}</Text>
        <View style={{ width: 22 }} />
      </View>

      {/* Live-quote freshness — tappable to refresh now. Hidden once the user
          commits (signing onward) since the quote is locked at that point. */}
      {!busy ? (
        <TouchableOpacity
          style={styles.freshRow}
          activeOpacity={0.7}
          onPress={onRefreshNow}
          accessibilityRole="button"
          accessibilityLabel={t('withdrawSheet.quoteTapRefresh')}
        >
          <Text style={styles.freshLabel}>
            {refreshing
              ? t('withdrawSheet.quoteRefreshing')
              : t('withdrawSheet.quoteRefreshIn', { s: Math.ceil(secondsLeft) })}
          </Text>
          <QuoteCountdownRing
            fraction={quoteTtl > 0 ? Math.max(0, Math.min(1, secondsLeft / quoteTtl)) : 0}
            seconds={secondsLeft}
            refreshing={refreshing}
          />
        </TouchableOpacity>
      ) : null}

      <View style={styles.reviewCard}>
        <ReviewRow label={t('withdrawSheet.reviewYouSend')} value={`${formatAmount(amount)} ${fromCurrency}`} strong />
        <View style={styles.reviewRow}>
          <Text style={styles.reviewRowLabel}>{t('withdrawSheet.reviewYouReceive')}</Text>
          <Animated.Text style={[styles.reviewRowValue, styles.reviewRowValueStrong, { color: receiveColor }]}>
            {`${formatAmount(r?.outputAmount)} USDC`}
          </Animated.Text>
        </View>
        <View style={styles.reviewDivider} />
        <ReviewRow label={t('withdrawSheet.reviewDestination')} value={`USDC · ${destName}`} />
        {r?.exchangeRate ? (
          <ReviewRow
            label={t('withdrawSheet.reviewRate')}
            value={buildExchangeRateLine({
              from: fromCurrency,
              to: 'USDC',
              rate: r.exchangeRate,
              inverted: rateInverted,
            })}
            onPressValue={() => setRateInverted((v) => !v)}
          />
        ) : null}
        {totalFees ? (
          <ReviewRow
            label={t('withdrawSheet.reviewTotalFee')}
            value={`${totalFees.prefix}${formatAmount(String(totalFees.value))}`}
          />
        ) : null}
      </View>

      <ConfirmButton busy={busy} enabled={!busy && !!r} label={ctaLabel}
        onPress={busy ? undefined : onConfirm} />
    </>
  );
}

function ReviewRow({
  label,
  value,
  strong,
  onPressValue,
}: {
  label: string;
  value: string;
  strong?: boolean;
  onPressValue?: () => void;
}) {
  const valueText = (
    <Text style={[styles.reviewRowValue, strong && styles.reviewRowValueStrong]}>{value}</Text>
  );
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewRowLabel}>{label}</Text>
      {onPressValue ? (
        <Pressable
          onPress={onPressValue}
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {valueText}
        </Pressable>
      ) : (
        valueText
      )}
    </View>
  );
}

function ConfirmButton({
  busy, enabled, label, onPress,
}: { busy: boolean; enabled: boolean; label: string; onPress?: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.confirmBtn, !busy && !enabled && styles.confirmBtnDisabled]}
      onPress={onPress}
      disabled={!enabled && !busy}
      activeOpacity={busy ? 1 : 0.85}
    >
      <LinearGradient
        colors={busy || enabled ? CONFIRM_GRADIENT : CONFIRM_GRADIENT_DISABLED}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.confirmGradient}
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

function ResultView({
  kind, title, body, primaryLabel, onPrimary, secondaryLabel, onSecondary,
}: {
  kind: 'success' | 'error';
  title: string;
  body: string | null;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.resultBlock}>
      <View style={[styles.resultIcon, { backgroundColor: kind === 'success' ? '#1d2c20' : '#2c1d1d' }]}>
        <Ionicons name={kind === 'success' ? 'checkmark' : 'alert'} size={28} color={kind === 'success' ? '#5dd47a' : '#e57373'} />
      </View>
      <Text style={styles.resultTitle}>{title}</Text>
      <Text style={styles.resultBody}>{body ?? t('withdrawSheet.unknownError')}</Text>
      {secondaryLabel && onSecondary ? (
        <View style={{ flexDirection: 'row', gap: 12, alignSelf: 'stretch' }}>
          <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={onSecondary}>
            <Text style={styles.secondaryBtnText}>{secondaryLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.confirmBtn, { flex: 1 }]} onPress={onPrimary}>
            <LinearGradient colors={CONFIRM_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.confirmGradient}>
              <Text style={styles.confirmText}>{primaryLabel}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={[styles.confirmBtn, { alignSelf: 'stretch' }]} onPress={onPrimary}>
          <LinearGradient colors={CONFIRM_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.confirmGradient}>
            <Text style={styles.confirmText}>{primaryLabel}</Text>
          </LinearGradient>
        </TouchableOpacity>
      )}
    </View>
  );
}

function CurrencyPicker({
  options, currentlySelected, onPick, onCancel,
}: {
  options: { currency: string; amount: number; amountStr: string; balanceLoading?: boolean }[];
  currentlySelected: string;
  onPick: (code: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'android' ? 32 : 20);

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Pressable style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.7)' }]} onPress={onCancel} />
      <View style={[styles.pickerSheet, { paddingBottom: bottomPad }]}>
        <View style={styles.pickerHandle} />
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>{t('withdrawSheet.pickCurrency')}</Text>
          <TouchableOpacity onPress={onCancel} hitSlop={12} accessibilityRole="button">
            <Ionicons name="close" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={[styles.pickerList, { minHeight: WITHDRAW_PICKER_LIST_MIN_HEIGHT }]}
          contentContainerStyle={styles.pickerListContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {options.map((item) => {
            const active = item.currency === currentlySelected;
            return (
              <TouchableOpacity
                key={item.currency}
                onPress={() => onPick(item.currency)}
                style={[styles.pickerRow, active && styles.pickerRowActive]}
              >
                <CircleCurrencyFlag currencyCode={item.currency} size={22} />
                <View style={styles.pickerRowMain}>
                  <Text style={styles.pickerRowCode}>{item.currency}</Text>
                  <Text style={styles.pickerRowLabel} numberOfLines={1}>
                    {fxCurrencyLabel(item.currency)}
                  </Text>
                </View>
                <View style={styles.pickerRowRight}>
                  {item.balanceLoading ? (
                    <BouncingDots dotSize={4} color={colors.text.tertiary} pulse />
                  ) : (
                    <Text style={styles.pickerBalance} numberOfLines={1}>
                      {item.amountStr} {item.currency}
                    </Text>
                  )}
                  {active ? (
                    <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────── //
// Helpers
// ─────────────────────────────────────────────────────────────────────────── //

function formatAmount(raw: string | undefined): string {
  if (!raw) return '0';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// ─────────────────────────────────────────────────────────────────────────── //
// Styles
// ─────────────────────────────────────────────────────────────────────────── //

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  kav: { width: '100%' },
  sheetWrap: { width: '100%' },
  safeArea: { backgroundColor: 'transparent' },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  pickerSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: colors.border.primary,
    paddingHorizontal: 20, paddingTop: 8, maxHeight: '75%',
  },
  pickerHandle: {
    width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border.primary,
    alignSelf: 'center', marginBottom: 12,
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 18,
  },
  pickerTitle: { fontSize: 17, fontWeight: '800', color: colors.text.primary },
  pickerList: { flexGrow: 0 },
  pickerListContent: { gap: 8, paddingBottom: 4 },
  handleArea: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginBottom: 4 },
  handle: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border.primary },
  loadingBlock: { paddingVertical: 48, alignItems: 'center' },
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
    borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: colors.border.primary,
  },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountInput: { flex: 1, fontSize: 28, fontWeight: '800', color: colors.text.primary, paddingVertical: 4 },
  currencyChip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background.card,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 999, gap: 6,
    borderWidth: 1, borderColor: colors.border.primary,
  },
  currencyChipText: { fontSize: 14, fontWeight: '800', color: colors.text.primary },
  maxText: { color: colors.accent.gold, fontSize: 11, fontWeight: '700', marginTop: 6, letterSpacing: 0.5 },
  arrowRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 14, gap: 12 },
  swapLine: { flex: 1, height: 1, backgroundColor: colors.border.primary },
  arrowBtn: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border.primary,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background.elevated,
  },
  destRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  destTokenBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.background.card, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 999, borderWidth: 1, borderColor: colors.border.primary,
  },
  destTokenIcon: { width: 18, height: 18, borderRadius: 9 },
  destTokenText: { fontSize: 14, fontWeight: '800', color: colors.text.primary },
  destChainText: { fontSize: 12, color: colors.text.tertiary },
  errText: { color: '#e57373', fontSize: 12, marginTop: 12, fontWeight: '600' },
  disclaimer: { fontSize: 11, color: colors.text.tertiary, marginTop: 14, lineHeight: 16 },
  confirmBtn: { marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  confirmBtnDisabled: { opacity: 0.7 },
  confirmGradient: { paddingVertical: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10 },
  confirmText: { fontSize: 15, fontWeight: '800', color: colors.background.primary, letterSpacing: 0.3 },
  secondaryBtn: {
    marginTop: 16, borderRadius: 14, paddingVertical: 16, alignItems: 'center',
    backgroundColor: colors.background.elevated, borderWidth: 1, borderColor: colors.border.primary,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  freshRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12, paddingHorizontal: 4,
  },
  freshLabel: { fontSize: 12, color: colors.text.tertiary, fontWeight: '600' },
  reviewCard: {
    backgroundColor: colors.background.elevated, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: colors.border.primary, gap: 12,
  },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewRowLabel: { fontSize: 13, color: colors.text.tertiary },
  reviewRowValue: { fontSize: 14, color: colors.text.secondary, fontWeight: '600' },
  reviewRowValueStrong: { fontSize: 16, color: colors.text.primary, fontWeight: '800' },
  reviewDivider: { height: 1, backgroundColor: colors.border.primary },
  resultBlock: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  resultIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  resultTitle: { fontSize: 18, fontWeight: '800', color: colors.text.primary },
  resultBody: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', lineHeight: 19, paddingHorizontal: 8, maxWidth: 320 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 12, backgroundColor: colors.background.primary,
    borderWidth: 1, borderColor: colors.border.primary,
  },
  pickerRowMain: { flex: 1, marginLeft: 10, minWidth: 0 },
  pickerRowCode: { fontSize: 15, fontWeight: '800', color: colors.text.primary },
  pickerRowLabel: { fontSize: 12, fontWeight: '500', color: colors.text.tertiary, marginTop: 1 },
  pickerRowRight: { alignItems: 'flex-end', gap: 4, marginLeft: 8, maxWidth: '38%' },
  pickerBalance: { fontSize: 11, fontWeight: '600', color: colors.text.secondary, textAlign: 'right' },
  pickerRowActive: { borderColor: colors.accent.gold },
});
