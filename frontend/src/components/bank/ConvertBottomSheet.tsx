/**
 * ConvertBottomSheet — gasless FX swap via EIP-7702 + Ambire + UR relayer on Mantle.
 *
 * ARCHITECTURE (load-bearing — read before editing)
 * =================================================
 *
 * We're in **External Wallet Access mode** (confirmed on-chain 2026-05-28):
 *   - URID NFT owner   = user's Privy EOA  (Fiat24Account.ownerOf)
 *   - USD24 balance    = sits AT the user's EOA, not at a UR vault
 *
 * Convert performs two on-chain calls (approve + moneyExchangeExactIn), but
 * the user signs OFF-CHAIN and our backend relayer broadcasts a type-4
 * (EIP-7702) tx paying MNT for gas. Identical pattern to Add Money on
 * Arbitrum Sepolia (`DigitalDepositBottomSheet.tsx`), just on Mantle Sepolia.
 *
 * USER FLOW
 * ---------
 *   1. User taps Convert; we fetch a live FX quote (`/ur/fx/quote`) read
 *      directly from Fiat24CryptoRelay on Mantle (eth_call only — no auth).
 *   2. User confirms. We:
 *        a. (First time on Mantle only) ask Privy to sign an EIP-7702
 *           SetCode authorization binding the EOA to our deployed Ambire
 *           delegate at 0x65a1Ec6a2bB2a32848AE94FBb44748A291d96dab. Skipped
 *           when the EOA's code already starts with `0xef0100<ambire>`.
 *        b. Build the calls batch:
 *             [
 *               fromToken.approve(relay, amount),    // value 0
 *               relay.moneyExchangeExactIn(inputToken, outputToken,
 *                                          amount, minOut),  // value 0
 *             ]
 *           Notice value=0 on both calls — FX has no LayerZero / cross-chain
 *           fee, unlike Add Money. Relayer just pays MNT for gas.
 *        c. Compute Ambire's batch hash via `computeAmbireBatchHash`
 *           (same logic as Add Money — see `lib/ambire7702.ts`) and sign it
 *           via Privy `secp256k1_sign` (raw secp256k1, no EIP-191 prefix).
 *        d. POST everything to `/api/ur/fx/execute-7702` — the backend
 *           wraps it in a type-4 transaction signed by the UR relayer pool
 *           (`UR_RELAYER_PRIVKEY_TESTNET`), funded with MNT on Mantle.
 *   3. Poll `/api/ur/jobs/:id` until terminal, then refresh balances.
 *
 * AMBIRE DELEGATE ON MANTLE
 * -------------------------
 * Ambire never deployed `AmbireAccount7702` to Mantle Sepolia. We deployed
 * a byte-for-byte identical copy ourselves via `backend/deploy_ambire_mantle.py`
 * (one-time bootstrap). The contract has no constructor logic and all
 * compile-time values are `constant` (not `immutable`), so the runtime
 * bytecode is fully portable — the deployed contract behaves identically
 * to Ambire's Arb Sepolia delegate.
 *
 * BACKEND SURFACE
 * ---------------
 *   GET  /api/ur/fx/info          : addresses (relay, tokens, ambire delegate)
 *   POST /api/ur/fx/quote         : on-chain rate read (no auth-gated UR call)
 *   POST /api/ur/fx/execute-7702  : relayer dispatch (gasless)
 *
 * NOT used (kept for reference, will be deleted later):
 *   POST /api/ur/fx/record        : old user-gas path; replaced by execute-7702
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildExchangeRateLine } from '../../lib/exchangeRateDisplay';
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
  Dimensions,
  ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { useEmbeddedEthereumWallet, useSign7702Authorization } from '@privy-io/expo';
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  type Hex,
} from 'viem';
// 7702 helpers — kept for the BACKUP manual auth-signing path (see
// USE_PRIVY_7702_HOOK below). `prepareAuthorization` fills in chainId + nonce
// from the wallet client; `hashAuthorization` returns the 32-byte digest the
// EOA must sign (raw secp256k1, no EIP-191 prefix). EIP-7702 graduated out of
// viem/experimental, so import from the stable entrypoints. The primary path
// now uses Privy's useSign7702Authorization hook.
import { prepareAuthorization } from 'viem/actions';
import { hashAuthorization } from 'viem/utils';

import { colors } from '../../theme/colors';
import { BouncingDots } from '../BouncingDots';
import { BankConfirmModal } from './BankConfirmModal';
import { GRADIENT_BTN_SPINNER_BUSY, gradientConfirmTextBusy } from './bankSheetUi';
import { useLiveQuote } from '../../hooks/useLiveQuote';
import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import { useUrTransferLimit } from '../../hooks/useUrTransferLimit';
import { QuoteCountdownRing } from './QuoteCountdownRing';
import { SpendableBalanceLine } from './SpendableBalanceLine';
import { CircleCurrencyFlag } from './CircleCountryFlag';
import { useAuth } from '../../providers/AuthContext';
import {
  getMantleChain,
  getMantlePublicClient,
  resolveMantleChainId,
} from '../../lib/mantleFiatBalance';
import {
  fetchUrFxInfo,
  fetchUrFxQuote,
  executeUrFx7702,
  type UrFxQuoteData,
  type UrFxQuoteResponse,
  type UrFxInfoResponse,
  type UrDeposit7702Authorization,
  type UrDeposit7702Call,
  type CashAccountRow,
  defaultFromCurrency,
} from '../../lib/urApi';
import {
  AMBIRE_NONCE_ABI,
  computeAmbireBatchHash,
  normaliseAuth7702Signature,
  normaliseSig65,
} from '../../lib/ambire7702';

// ─────────────────────────────────────────────────────────────────────────── //
// Constants
// ─────────────────────────────────────────────────────────────────────────── //

const SHEET_TRAVEL = 800;
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const CONVERT_PICKER_LIST_MIN_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);
const CONFIRM_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;
const CONFIRM_GRADIENT_DISABLED = [colors.background.tertiary, colors.background.tertiary] as const;
const QUOTE_DEBOUNCE_MS = 400;

// EIP-7702 authorization signer selector (see DigitalDepositBottomSheet for the
// full rationale).
//   true  → Privy's `useSign7702Authorization` hook (@privy-io/expo ≥ 0.68).
//   false → manual viem prepareAuthorization + Privy secp256k1_sign fallback,
//           kept verbatim below as a proven backup. Flip to false to re-enable.
// Only swaps the SetCode AUTHORIZATION signature; the Ambire batch signing is
// unchanged. NOTE: Mantle Sepolia (5003) is a custom chain Privy doesn't route
// natively, which is exactly why the explicit-nonce safeguard stays in both
// paths — keep an eye on the hook here when QA testing FX.
const USE_PRIVY_7702_HOOK = true;
// The FX relay rate has no server-issued TTL, but it CAN drift between read
// and broadcast (RATES_UPDATER can move it ±3%/update). We treat each quote
// as good for this long, then silently re-read on-chain so the displayed
// "you receive" + the minOut we sign are always fresh. Drives the countdown.
const CONVERT_QUOTE_TTL_SECONDS = 20;

// Job polling cadence after the relayer broadcasts. FX settles in 1
// Mantle block (~2s), so a tight 1.5s loop catches it quickly without
// hammering the backend. We give up after ~60s and surface the tx hash
// from the dashboard's Transactions list.
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

// Minimal ABI fragments — keep them inline so this file is self-contained.
// Same fragments live server-side in ur_chain.py (see FIAT24_RELAY_ABI).
const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const RELAY_SWAP_ABI = [
  {
    type: 'function',
    name: 'moneyExchangeExactIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_inputToken', type: 'address' },
      { name: '_outputToken', type: 'address' },
      { name: '_inputAmount', type: 'uint256' },
      { name: '_amountOutMinimum', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

type Stage =
  | 'input'
  | 'preparing'    // optimistic state right after click — wallet provider
                   // fetch, delegation check, ambire nonce read. Pre-signing.
  | 'signing-auth' // user is signing the EIP-7702 SetCode authorization
                   // (only on the first Convert — subsequent ones skip this
                   // stage because the EOA's delegation persists on-chain)
  | 'signing-batch' // user is signing the Ambire `execute(calls, sig)` hash
  | 'submitting'   // POSTing to /api/ur/fx/execute-7702; relayer is preparing
                   // to broadcast (next states are server-driven, not user)
  | 'confirming'   // job is `submitted`; we're polling for terminal status
  | 'success'
  | 'error';

export interface ConvertBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  cashRows: CashAccountRow[];
  /**
   * Rolling-30-day transfer limit from the UR profile (CHF-denominated, 2dp:
   * 100000 == 1000.00 CHF). When `usedLimit >= clientLimit`, Fiat24's token
   * contract blocks ALL transfers (the swap reverts with `STF`), so we
   * pre-flight it here and surface a clean message before the user signs —
   * instead of burning a relayer tx on a guaranteed on-chain revert.
   */
  usedLimit?: number;
  clientLimit?: number;
  /**
   * USD-equivalent rate map (ISO → USD24 per 1 unit) from the dashboard.
   * Used to size the input amount against the CHF-denominated rolling limit.
   */
  usdRates?: Record<string, number>;
  /**
   * Called once after the FX job reaches `completed`. The parent uses
   * `incoming.amount` / `incoming.currency` to snapshot the user's
   * current target-currency balance and surface a pending pill on the
   * matching card (see `useUrAccount.markIncoming` and
   * `frontend/src/components/DepositPanel.tsx` for the same pattern).
   */
  onSuccess?: (
    incoming?: { currency: string; amount: number },
  ) => Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────── //
// Component
// ─────────────────────────────────────────────────────────────────────────── //

export function ConvertBottomSheet({
  visible,
  onClose,
  cashRows,
  usedLimit,
  clientLimit,
  usdRates,
  onSuccess,
}: ConvertBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { getAccessToken, walletAddress } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();
  // Privy's first-class EIP-7702 authorization signer (Expo SDK ≥ 0.68).
  // Used by the primary path in the execute handler when USE_PRIVY_7702_HOOK.
  const { signAuthorization } = useSign7702Authorization();
  // CRITICAL: A Privy account can hold multiple embedded EOAs (e.g. the
  // default one Privy auto-creates AND a UR-imported test signer). Picking
  // `wallets[0]` blindly will sign with the wrong key — the symptom is the
  // sequencer returning "insufficient funds for gas, balance 0" because the
  // default Privy EOA holds zero MNT and zero USD24 (the UR test signer is
  // the one that actually owns the URID + fiat balances).
  //
  // Resolve the wallet that matches the address `useAuth()` exposes —
  // PrivyAuthProvider already does this selection for the rest of the app
  // (see PrivyAuthProvider.tsx, walletAddress useMemo). We mirror that
  // selection here so signing happens from the funded wallet.
  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return undefined;
    if (!walletAddress) return wallets[0];
    const target = walletAddress.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === target) ?? wallets[0];
  }, [wallets, walletAddress]);

  // Sheet animation refs
  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const [mounted, setMounted] = useState(false);

  // FX info (relay address, token addresses) — fetched once when sheet opens
  const [fxInfo, setFxInfo] = useState<UrFxInfoResponse | null>(null);
  const [fxInfoLoading, setFxInfoLoading] = useState(false);
  const [fxInfoErr, setFxInfoErr] = useState<string | null>(null);

  // Currency picker state
  const initialFrom = useMemo(
    () => defaultFromCurrency(cashRows),
    [cashRows],
  );
  const [fromCurrency, setFromCurrency] = useState<string>(initialFrom);
  const [toCurrency, setToCurrency] = useState<string>(() => {
    const alt = cashRows.find((r) => r.currency !== initialFrom)?.currency;
    return alt ?? (initialFrom === 'USD' ? 'EUR' : 'USD');
  });
  const [pickerOpen, setPickerOpen] = useState<'from' | 'to' | null>(null);

  const [amount, setAmount] = useState<string>('');
  // The live quote (value + countdown + silent auto-refresh) is owned by the
  // `useLiveQuote` hook declared after `amountNum` (its refetch closure needs
  // the parsed amount). `finishClose` runs before that declaration, so it
  // resets the quote through this ref — same pattern as WithdrawBottomSheet.
  const liveQuoteResetRef = useRef<null | (() => void)>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  // Below-min is NOT an error from a UX perspective — user is just typing a
  // value below the contract's minUsdExchangeAmount. Surface as a soft hint
  // instead of a red error so they get a useful "Min X USD" affordance.
  const [belowMinHint, setBelowMinHint] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>('input');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Snapshot of the success info captured at the moment we flip to
  // stage='success'. The live `quote` state gets cleared the moment we
  // leave stage='input' (see quote-fetch useEffect), so SuccessView would
  // otherwise read `quote?.data.outputAmount === undefined` →
  // formatAmount returns "0" → "You received 0 CHF". Capturing here
  // decouples the success UI from the live quote.
  const [successInfo, setSuccessInfo] = useState<{
    receivedAmount: string;
    receivedCurrency: string;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const spendableBalances = useSpendableMantleBalances({
    active: mounted,
    walletAddress,
    getAccessToken,
  });

  const mantleChainId = resolveMantleChainId(
    spendableBalances.chainId ?? fxInfo?.chain_id ?? null,
  );
  const mantleChain = useMemo(() => getMantleChain(mantleChainId), [mantleChainId]);
  const mantleClient = useMemo(
    () => getMantlePublicClient(mantleChainId),
    [mantleChainId],
  );

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
    setToCurrency((prev) =>
      prev !== fromCurrency && cashRows.some((r) => r.currency === prev)
        ? prev
        : cashRows.find((r) => r.currency !== fromCurrency)?.currency ??
          (fromCurrency === 'USD' ? 'EUR' : 'USD'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashRows, initialFrom]);

  // ─── Sheet open/close animation ─────────────────────────────────────────
  const finishClose = useCallback(() => {
    setMounted(false);
    setAmount('');
    liveQuoteResetRef.current?.();
    setQuoteErr(null);
    setStage('input');
    setErrMsg(null);
    setSuccessInfo(null);
    setConfirmOpen(false);
    setPickerOpen(null);
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: SHEET_TRAVEL,
        duration: 220,
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
      const from = defaultFromCurrency(cashRows);
      setFromCurrency(from);
      const alt = cashRows.find((r) => r.currency !== from)?.currency;
      setToCurrency(alt ?? (from === 'USD' ? 'EUR' : 'USD'));
      setAmount('');
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose, cashRows]);

  // Drag-down-to-close handler. We attach this to the small handle bar
  // (handleArea) rather than the whole sheet — wrapping the sheet would
  // steal touches from the TextInput / currency-chip buttons inside it and
  // break typing. Same pattern as DigitalDepositBottomSheet (which has the
  // same input-heavy layout and works correctly).
  const closeable = stage === 'input' || stage === 'success' || stage === 'error';
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => closeable,
        onMoveShouldSetPanResponder: (_, g) =>
          closeable && Math.abs(g.dy) > 4,
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

  // ─── FX info fetch ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setFxInfoLoading(true);
    setFxInfoErr(null);
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no token');
        const info = await fetchUrFxInfo(token);
        if (cancelled) return;
        setFxInfo(info);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? (err as { message?: string })?.message ?? 'info_failed';
        setFxInfoErr(String(msg));
      } finally {
        if (!cancelled) setFxInfoLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, getAccessToken]);

  const spendable = spendableBalances.forCurrency(fromCurrency);
  const spendableBalance = spendable?.amount ?? 0;
  const spendableBalanceStr = spendable?.amountStr ?? '—';

  // ─── Derived values ─────────────────────────────────────────────────────
  const amountNum = useMemo(() => {
    const n = parseFloat(amount.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const inputErr: string | null = useMemo(() => {
    if (spendableBalances.loading || fxInfoLoading || !spendableBalances.ready) {
      if (spendableBalances.error) {
        return t('bankSheet.balanceUnavailable', {
          defaultValue: "Couldn't read your wallet balance. Try again.",
        });
      }
      return null;
    }
    if (!amount) return null;
    if (amountNum <= 0) return t('convert.invalidAmount');
    if (fromCurrency === toCurrency) return t('convert.sameCurrency');
    if (amountNum > spendableBalance + 1e-9) {
      return t('convert.notEnough', { currency: fromCurrency });
    }
    return null;
  }, [
    amount,
    amountNum,
    spendableBalance,
    fromCurrency,
    toCurrency,
    t,
    spendableBalances.loading,
    spendableBalances.error,
    spendableBalances.ready,
    fxInfoLoading,
  ]);

  // ─── Pre-flight: rolling-30-day transfer limit ──────────────────────────
  //
  // When the account's used limit meets/exceeds its ceiling, Fiat24's token
  // contract blocks EVERY transfer — the swap's `transferFrom` reverts with
  // `STF` and the relayer's tx is burned. We catch it here (proactively, from
  // the profile the dashboard already fetched) so the user sees a clean
  // message and a disabled button instead of signing twice for a guaranteed
  // on-chain revert. `clientLimit === 0` means "no limit configured" → allow.
  // Per-transaction headroom check (not just fully-maxed): converts the input
  // amount to CHF and compares against `clientLimit - usedLimit`. Blocks with a
  // clear message before signing instead of a guaranteed on-chain revert.
  const transferLimit = useUrTransferLimit({
    usedLimit,
    clientLimit,
    amount: amountNum,
    currency: fromCurrency,
    usdRates,
  });
  const limitReached = transferLimit.block;

  // ─── Live quote: countdown + silent auto-refresh ────────────────────────
  //
  // The on-chain FX rate drifts (RATES_UPDATER moves it between our read and
  // the relayer's broadcast). `useLiveQuote` keeps the displayed "you receive"
  // — and the minOut we eventually sign — fresh: it counts down from when the
  // quote landed and re-reads the rate a few seconds before expiry. Active
  // only while on the input screen; the debounced effect below seeds it and
  // the ticker is a no-op until then (it needs a `fetchedAt`). Refresh reuses
  // the same backend read, so it never re-prompts the wallet.
  const liveQuote = useLiveQuote<UrFxQuoteResponse>({
    active: stage === 'input' && !limitReached && spendableBalances.ready,
    refetch: useCallback(async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const resp = await fetchUrFxQuote(token, {
        from_currency: fromCurrency,
        to_currency: toCurrency,
        input_amount: String(amountNum),
      });
      return { quote: resp, ttlSeconds: CONVERT_QUOTE_TTL_SECONDS };
    }, [getAccessToken, fromCurrency, toCurrency, amountNum]),
    fallbackTtlSeconds: CONVERT_QUOTE_TTL_SECONDS,
  });
  const quote = liveQuote.quote;
  const { seed: seedQuote, reset: resetQuote } = liveQuote;
  liveQuoteResetRef.current = liveQuote.reset;

  // Market-closed comes back on the quote (200, not an error) so the user can
  // still see the indicative rate but we block the action.
  const marketClosed = quote?.data.marketClosed ?? false;

  // ─── Quote fetching (debounced) ─────────────────────────────────────────
  //
  // We ALWAYS clear the previous quote/err/hint synchronously when the user
  // changes input, so stale messages never linger between debounces. The
  // backend's "Amount below minimum" 400 is treated as a soft hint (small
  // grey text) rather than a red error — it's just the user typing a value
  // below the contract's minUsdExchangeAmount on the way to a valid amount.
  useEffect(() => {
    // CRITICAL: only clear/refetch when we're actually in the input stage.
    // Previously this effect ran on every `stage` change too, which
    // nullified `quote` the moment the user clicked Convert (stage
    // transitioned input → approving). By the time we reached
    // stage='success', `quote?.data.outputAmount` was undefined and
    // SuccessView rendered "You received 0 CHF". The snapshot in
    // `successInfo` is a belt; this gate is the suspenders.
    if (stage !== 'input') return;
    resetQuote();
    setQuoteErr(null);
    setBelowMinHint(null);
    // No point quoting (or auto-refreshing) when the account is already over
    // its transfer limit — the swap can't settle. The banner explains why.
    if (inputErr || !amount || amountNum <= 0 || limitReached || !spendableBalances.ready) {
      setQuoteLoading(false);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    const handle = setTimeout(async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no token');
        const resp = await fetchUrFxQuote(token, {
          from_currency: fromCurrency,
          to_currency: toCurrency,
          input_amount: String(amountNum),
        });
        if (cancelled) return;
        // Seed the live quote + start the countdown. The hook owns the value
        // and refreshes it near expiry from here on.
        seedQuote(resp, CONVERT_QUOTE_TTL_SECONDS);
      } catch (err: unknown) {
        if (cancelled) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? (err as { message?: string })?.message ?? 'quote_failed';
        const detailStr = String(detail);
        // Parse "Amount below minimum: $X USD24 equivalent < $Y USD24 minimum"
        // to recover the min, then render as a hint instead of an error.
        const m = detailStr.match(/\$([0-9.]+)\s+USD24\s+minimum/i);
        if (detailStr.toLowerCase().includes('below minimum')) {
          setBelowMinHint(
            t('convert.belowMin', { min: m ? m[1] : '4.00' }),
          );
        } else {
          setQuoteErr(detailStr);
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    amount, amountNum, fromCurrency, toCurrency, getAccessToken, inputErr,
    stage, t, limitReached, seedQuote, resetQuote, spendableBalances.ready,
  ]);

  // ─── On-chain submit ────────────────────────────────────────────────────
  //
  // Defensive flow (each step explained inline):
  //
  //  1. LOUD chain switch — we do NOT proceed if we can't get the embedded
  //     wallet onto Mantle Sepolia. A silent switch failure was the most
  //     likely cause of Privy's opaque `-32000 "Missing or invalid parameters"`
  //     because Privy's internal viem public client would then run
  //     `eth_estimateGas` against the wrong chain, where our contract address
  //     doesn't exist and the simulator reverts.
  //
  //  2. PRE-SIMULATE both approve and swap via our own public client BEFORE
  //     asking the user to sign. viem `simulateContract` returns the real
  //     revert reason in clear text (`STF`, `PAUSED`, `RATES`, etc.) so a
  //     failed swap shows the user a useful message instead of "Missing or
  //     invalid parameters".
  //
  //  3. After approve mines, RE-READ allowance against the same publicClient
  //     to catch the rare case where the receipt landed but our node hasn't
  //     applied the state diff yet. Block the swap until allowance is large
  //     enough — otherwise we'd just re-hit STF.
  //
  //  4. __DEV__ breadcrumbs at every stage so the next failure tells us
  //     exactly where it died without another round trip.
  // ─── onConfirm: gasless Convert via 7702 + UR relayer ──────────────────
  //
  // High-level shape (mirror of Add Money on Arb Sepolia — see
  // DigitalDepositBottomSheet.tsx for the same pattern):
  //
  //   preparing      → checking delegation state on Mantle
  //   signing-auth   → user signs the 7702 SetCode authorization (first time only)
  //   signing-batch  → user signs the Ambire batch hash (every time)
  //   submitting     → POSTing to /api/ur/fx/execute-7702
  //   confirming     → waiting for the relayer's broadcast tx to confirm
  //   success        → on-chain settlement complete
  //
  // The user signs TWO things off-chain (or just one if already delegated):
  //   1. EIP-7702 authorization  — binds the EOA to the Ambire delegate
  //   2. Ambire batch hash       — authorises `[approve, moneyExchangeExactIn]`
  //
  // Both signatures use Privy's `secp256k1_sign` (raw secp256k1, no
  // EIP-191 prefix). The Ambire contract pre-wraps the inner hash with
  // its own EIP-712 wrap before ecrecover, so we compute that wrap
  // client-side via `computeAmbireBatchHash` (verified against the
  // deployed bytecode — see lib/ambire7702.ts header for the forensic
  // trail).
  //
  // No `wallet_switchEthereumChain`, no `eth_sendTransaction`, no
  // `eth_signTransaction` — none of those are needed because the user
  // never broadcasts a tx themselves. The relayer pays MNT for gas.
  // ───────────────────────────────────────────────────────────────────────
  const executeConvert = useCallback(async () => {
    if (!quote || inputErr || !wallet || !walletAddress) {
      setErrMsg(t('convert.noWallet') || 'Wallet not ready');
      return;
    }
    if (!spendableBalances.ready || !spendable) {
      setErrMsg(
        t('bankSheet.balanceUnavailable', {
          defaultValue: "Couldn't read your wallet balance. Try again.",
        }),
      );
      return;
    }
    // Pre-flight guards — bail BEFORE any signing prompt so a guaranteed
    // on-chain revert never costs the user two signatures + a burned relayer
    // tx. These mirror the exact reverts we'd otherwise hit:
    //   • limitReached  → Fiat24 token blocks transferFrom (`STF`)
    //   • marketClosed  → relay rejects the swap
    if (limitReached) {
      setErrMsg(transferLimit.message || t('convert.limitReached'));
      return;
    }
    if (marketClosed) {
      setErrMsg(t('convert.marketClosed'));
      return;
    }
    if (!fxInfo?.ambire_7702_delegate) {
      // Backend says no Ambire delegate is wired for this chain yet — that
      // means the relayer path can't broadcast and we have no user-gas
      // fallback. Refuse cleanly rather than silently broadcasting.
      setErrMsg(t('convert.unavailable') || 'Convert is not available on this chain yet');
      return;
    }
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    setErrMsg(null);

    // Optimistic stage flip — the button must visibly react on tap.
    // 'preparing' covers the wallet provider fetch + delegation check
    // (~300-800ms on a cold provider) before the first signing prompt.
    setStage('preparing');

    const inputTokenAddr = quote.addresses.input_token as Hex;
    const outputTokenAddr = quote.addresses.output_token as Hex;
    const relayAddr = quote.addresses.relay as Hex;
    const rawIn = BigInt(quote.raw.inputAmount);
    // 1% slippage protection. The relay's rate can drift between our
    // quote read and the relayer's broadcast if a RATES_UPDATER_ROBOT_ROLE
    // tx lands in between (max ±3% per update per contract).
    const minOut = (BigInt(quote.raw.outputAmount) * 99n) / 100n;
    const userAddr = walletAddress as Hex;
    const ambireDelegate = fxInfo.ambire_7702_delegate as Hex;
    const designatorPrefix = (fxInfo.designator_prefix || '0xef0100').toLowerCase();

    const log = (...args: unknown[]) => {
      if (__DEV__) console.log('[Convert]', ...args);
    };

    try {
      // Sanity: the wallet we're about to sign with MUST match the EOA
      // exposed by useAuth() — which is the URID-owning, fiat-holding
      // wallet. A mismatch means the embedded-wallet selection picked the
      // wrong EOA (the Privy default, with no URID / no balances) and the
      // signed authorization + batch would be against the wrong address.
      if (wallet.address.toLowerCase() !== userAddr.toLowerCase()) {
        throw new Error(
          `Wallet mismatch: signing wallet ${wallet.address} does not match funded EOA ${userAddr}. Please re-login.`,
        );
      }

      const provider = await wallet.getProvider();
      // walletClient is ONLY needed by `prepareAuthorization` so it can
      // pull chainId + nonce. We never call `sendTransaction` or any other
      // tx-broadcast method on it — the relayer does the broadcast.
      const walletClient = createWalletClient({
        account: userAddr,
        chain: mantleChain,
        transport: custom(provider),
      });

      // ─── 1. Determine 7702 delegation state ───────────────────────────
      // Once an EOA signs a SetCode authorization, its account code on
      // that chain becomes `0xef0100<delegate_addr>` (the EIP-7702
      // designator). Subsequent Convert calls skip the auth signing step
      // entirely — the relayer can send a type-2 tx that just hits the
      // already-delegated EOA's execute() entry point.
      const code = await mantleClient.getCode({ address: userAddr });
      const codeHex = (code || '0x').toLowerCase();
      const expectedDesignator =
        designatorPrefix + ambireDelegate.slice(2).toLowerCase();
      const isDelegated = codeHex === expectedDesignator;
      log(
        'eoa code:', codeHex,
        '\nexpected designator:', expectedDesignator,
        '\nisDelegated:', isDelegated,
      );

      // ─── 2. (Conditional) sign 7702 authorization ─────────────────────
      let authorization: UrDeposit7702Authorization | undefined;
      if (!isDelegated) {
        setStage('signing-auth');
        // CRITICAL: read the EOA's chain nonce ourselves and pass it
        // explicitly. If we let `prepareAuthorization` fetch the nonce
        // via the walletClient (which uses Privy's provider as transport),
        // we get a wrong value on chains Privy doesn't natively support —
        // notably Mantle Sepolia, which we add manually via `defineChain`
        // + `supportedChains` in `_layout.tsx`. Privy's provider then
        // returns `nonce=0` regardless of the EOA's actual chain history.
        //
        // The EIP-7702 EVM validates `auth.nonce == authority.nonce` at
        // tx inclusion. A wrong nonce makes the EVM SILENTLY DROP the
        // SetCode part — the type-4 tx still runs the outer call (which
        // hits the not-yet-delegated EOA → empty no-op → ~51k gas, zero
        // logs, balances unchanged). The receipt looks SUCCESSFUL, which
        // is how this bug evades all client-side checks.
        //
        // Forensically observed: tx 0x9b8ec8…0026 — gasUsed=51556,
        // logs=0, signed_nonce=0, actual_nonce=3 (from earlier manual
        // approve/swap txs the test wallet had done before we wired up
        // the relayer).
        const eoaNonce = await mantleClient.getTransactionCount({
          address: userAddr,
        });
        log('EOA chain nonce (for 7702 auth):', eoaNonce);

        if (USE_PRIVY_7702_HOOK) {
          // PRIMARY — Privy useSign7702Authorization (Expo SDK ≥ 0.68).
          // `options.address` pins signing to the URID-owning, fiat-holding
          // EOA (the same one useAuth() exposes), NOT wallets[0]. We pass the
          // explicit nonce (Mantle Sepolia is a custom chain — see above). The
          // hook returns a viem SignedAuthorization {address, chainId, nonce,
          // r, s, yParity} with the canonical recovery byte.
          const signed = await signAuthorization(
            {
              contractAddress: ambireDelegate,
              chainId: mantleChainId,
              nonce: eoaNonce,
            },
            { address: userAddr },
          );
          // viem types `yParity` as optional, but a SIGNED authorization always
          // carries it. Fail loud instead of defaulting to a possibly-inverted
          // 0 (the silent SetCode-drop bug the manual path's normalise guards) —
          // flip USE_PRIVY_7702_HOOK to false if ever seen.
          if (signed.yParity == null) {
            throw new Error('Privy 7702 authorization returned no yParity');
          }
          authorization = {
            chain_id: Number(signed.chainId),
            address: ambireDelegate,
            nonce: Number(signed.nonce),
            y_parity: signed.yParity,
            r: signed.r,
            s: signed.s,
          };
          log('signed 7702 authorization (privy hook)', authorization);
        } else {
          // BACKUP — manual viem prepareAuthorization + Privy secp256k1_sign,
          // the proven path used before the hook existed. Kept verbatim; flip
          // USE_PRIVY_7702_HOOK to false to re-enable.
          const authPayload = await prepareAuthorization(walletClient, {
            address: ambireDelegate,
            nonce: eoaNonce,
          });
          const authHash = hashAuthorization(authPayload);
          // Raw secp256k1 sign — no EIP-191 prefix. EIP-7702 specifies the
          // digest format directly; wallets MUST sign it as-is.
          const authSigHex = (await provider.request({
            method: 'secp256k1_sign',
            params: [authHash],
          })) as Hex;
          // CRITICAL: locally recover and verify the signer matches the EOA.
          // Privy's `secp256k1_sign` returns the recovery byte in different
          // conventions across chains ({0,1} on Arb Sepolia, {27,28} on
          // Mantle Sepolia). A naive `v % 2` mapping silently produces an
          // inverted yParity on the latter — the EVM then drops the SetCode
          // and the outer tx still mines as "success" (gasUsed ≈ 51k, zero
          // logs). See ambire7702.ts for the full forensic write-up.
          const { r, s, yParity } = await normaliseAuth7702Signature({
            authHash,
            signature: authSigHex,
            authority: userAddr,
          });
          authorization = {
            chain_id: Number(authPayload.chainId),
            address: ambireDelegate,
            // viem returns nonce as a bigint; the backend wants a plain JS
            // number (it's safely <2^53 — EOA nonces never get that high).
            nonce: Number(authPayload.nonce),
            y_parity: yParity,
            r,
            s,
          };
          log('signed 7702 authorization (manual fallback)', authorization);
        }
      }

      // ─── 3. On-chain balance preflight ────────────────────────────────
      // UR's indexed balance can lag the chain by a few seconds after Add
      // Money or another Convert. `transferFrom` reverts with `STF` when
      // the wallet holds less than `rawIn` — catch that before signing.
      const onChainBal = (await mantleClient.readContract({
        address: inputTokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [userAddr],
      })) as bigint;
      if (onChainBal < rawIn) {
        throw new Error(t('convert.notEnough', { currency: fromCurrency }));
      }
      log('on-chain input balance', onChainBal.toString(), 'need', rawIn.toString());

      // ─── 4. Build calls batch ─────────────────────────────────────────
      // FX has no LayerZero cross-chain fee → both calls have value=0.
      // The relayer's outer tx also carries value=0 since sum(values)=0.
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [relayAddr, rawIn],
      });
      const swapData = encodeFunctionData({
        abi: RELAY_SWAP_ABI,
        functionName: 'moneyExchangeExactIn',
        args: [inputTokenAddr, outputTokenAddr, rawIn, minOut],
      });
      const calls: UrDeposit7702Call[] = [
        { to: inputTokenAddr, value: '0', data: approveData },
        { to: relayAddr, value: '0', data: swapData },
      ];

      // ─── 5. Sign Ambire batch ─────────────────────────────────────────
      setStage('signing-batch');
      // Read AmbireAccount.nonce() from the (about-to-be) delegated EOA.
      // If the EOA isn't delegated yet, the call reverts (no code to call)
      // — we treat that as nonce=0, which is what Ambire defaults to on
      // first execute() after the SetCode landing in the same tx.
      let ambireNonce = 0n;
      try {
        ambireNonce = (await mantleClient.readContract({
          address: userAddr,
          abi: AMBIRE_NONCE_ABI,
          functionName: 'nonce',
        })) as bigint;
      } catch {
        ambireNonce = 0n;
      }
      log('ambire nonce:', ambireNonce.toString());

      const batchHash = computeAmbireBatchHash({
        eoa: userAddr,
        chainId: BigInt(mantleChainId),
        nonce: ambireNonce,
        calls,
      });
      // Raw ECDSA sign — see lib/ambire7702.ts for why no EIP-191 wrap
      // and why v must be ≥ 27 (LastUnused).
      const batchSigRaw = (await provider.request({
        method: 'secp256k1_sign',
        params: [batchHash],
      })) as Hex;
      const batchSignature = normaliseSig65(batchSigRaw);
      log('signed ambire batch', { batchHash, batchSignature });

      // ─── 6. Submit to backend relayer ─────────────────────────────────
      setStage('submitting');
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      // Idempotency key scoped to (user, currency pair, time) so a
      // double-tap on the confirm button is a no-op rather than a
      // double-broadcast. Includes a millisecond timestamp so a *new*
      // Convert with the same currency pair after the first one settles
      // still goes through.
      const idempotencyKey = `convert-${userAddr.toLowerCase()}-${fromCurrency}-${toCurrency}-${Date.now()}`;

      const resp = await executeUrFx7702(token, {
        idempotency_key: idempotencyKey,
        source_chain_id: mantleChainId,
        from_currency: fromCurrency,
        to_currency: toCurrency,
        source_amount: String(amountNum),
        target_amount: quote.data.outputAmount,
        user_address: userAddr,
        calls,
        batch_signature: batchSignature,
        authorization,
      });

      if (resp.dispatch_error) {
        throw new Error(resp.dispatch_error);
      }
      if (!resp.tx_hash) {
        throw new Error('Relayer did not return a transaction hash');
      }
      log('relayer broadcast', {
        jobId: resp.job.id,
        txHash: resp.tx_hash,
        via: resp.via,
      });

      // ─── 7. Wait for on-chain confirmation ────────────────────────────
      // Mantle Sepolia blocks every ~2s, so this usually resolves in a
      // couple of seconds. We poll the receipt directly via publicClient
      // rather than the job FSM because:
      //  - The relayer attached the tx_hash but the job kind=fx doesn't
      //    auto-advance past `submitted` (no UR webhook for in-chain FX).
      //  - The receipt is the ground truth: success → debit + credit
      //    landed; revert → nothing moved.
      setStage('confirming');
      const receipt = await mantleClient.waitForTransactionReceipt({
        hash: resp.tx_hash as Hex,
        confirmations: 1,
        timeout: 60_000,
      });
      if (receipt.status !== 'success') {
        throw new Error(
          t('convert.onChainRevert', {
            defaultValue:
              'Conversion failed on-chain. Check your balance and transfer limit, then try again.',
          }),
        );
      }
      log('receipt confirmed in block', receipt.blockNumber.toString());

      // Snapshot the success values BEFORE flipping stage. The quote-
      // clearing useEffect (only runs when stage === 'input') won't nuke
      // them now, but capturing here keeps the success view decoupled
      // from any future refactor of quote lifecycle.
      const receivedAmountNum = Number(quote.data.outputAmount);
      setSuccessInfo({
        receivedAmount: quote.data.outputAmount,
        receivedCurrency: toCurrency,
      });
      setStage('success');
      // Tell the parent how much is in-flight so it can surface the
      // "+X EUR incoming" pill on the matching card. The parent owns
      // the balance polling loop in `useUrAccount` and self-clears the
      // pill once UR's `/v1/balance` indexer catches up — no more
      // refresh storm here.
      try {
        await onSuccess?.({
          currency: toCurrency,
          amount: Number.isFinite(receivedAmountNum) ? receivedAmountNum : 0,
        });
      } catch {
        // Best-effort — a parent refresh blip never unwinds success.
      }
    } catch (err: unknown) {
      const detail =
        (err as { shortMessage?: string })?.shortMessage ??
        (err as { message?: string })?.message ??
        t('convert.unknownError');
      log('FAILED:', detail, err);
      const lower = String(detail).toLowerCase();
      if (lower.includes('user rejected') || lower.includes('user denied')) {
        // User cancelled a signing prompt — return them to input cleanly.
        setStage('input');
        return;
      }
      setErrMsg(String(detail));
      setStage('error');
    }
  }, [
    quote,
    inputErr,
    limitReached,
    transferLimit.message,
    marketClosed,
    wallet,
    walletAddress,
    fxInfo,
    fromCurrency,
    toCurrency,
    amountNum,
    onSuccess,
    getAccessToken,
    t,
    spendableBalances.ready,
    spendable,
    mantleChain,
    mantleChainId,
    mantleClient,
  ]);

  const onPressConfirm = useCallback(() => {
    if (spendableBalances.balanceLocked) return;
    setConfirmOpen(true);
  }, [spendableBalances.balanceLocked]);

  const handleConfirmModal = useCallback(() => {
    void executeConvert();
    setConfirmOpen(false);
  }, [executeConvert]);

  // ─── Helpers ────────────────────────────────────────────────────────────
  const swapDirection = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setFromCurrency(toCurrency);
    setToCurrency(fromCurrency);
    setAmount('');
    resetQuote();
  }, [fromCurrency, toCurrency, resetQuote]);

  const setMax = useCallback(() => {
    if (!spendableBalances.ready || spendableBalance <= 0) return;
    setAmount(spendable?.amountStr ?? spendableBalance.toFixed(2));
  }, [spendableBalances.ready, spendableBalance, spendable?.amountStr]);

  const basePickerOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { currency: string; amount: number; amountStr: string }[] = [];
    for (const row of cashRows) {
      if (seen.has(row.currency)) continue;
      seen.add(row.currency);
      opts.push({ currency: row.currency, amount: row.amount, amountStr: row.amountStr });
    }
    // Add fallback currencies that the relay supports but the user doesn't
    // hold yet — they can still SELECT it as a destination, even if balance is 0.
    if (fxInfo) {
      for (const sym of Object.keys(fxInfo.fiat_tokens)) {
        const code = sym.replace('24', '');
        if (!seen.has(code)) {
          seen.add(code);
          opts.push({ currency: code, amount: 0, amountStr: '0.00' });
        }
      }
    }
    return opts;
  }, [cashRows, fxInfo]);

  const pickerOptions = useMemo(
    () => spendableBalances.decoratePickerOptions(basePickerOptions),
    [basePickerOptions, spendableBalances],
  );

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={closeable ? animateClose : undefined}
    >
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.65] }) },
          ]}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={closeable ? animateClose : undefined}
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kav}
          pointerEvents="box-none"
        >
          <Animated.View
            style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}
          >
            <SafeAreaView edges={['bottom']} style={styles.safeArea}>
              <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom * 0.2 }]}>
                {/* Dedicated drag-handle hit area — panResponder attached HERE so
                   it doesn't fight the TextInput / chip buttons below. */}
                <View {...panResponder.panHandlers} style={styles.handleArea}>
                  <View style={styles.handle} />
                </View>

                {fxInfoErr ? (
                  <ErrorView
                    onClose={animateClose}
                    onRetry={() => {
                      setFxInfoErr(null);
                      setMounted(true);
                    }}
                    message={fxInfoErr}
                  />
                ) : stage === 'success' ? (
                  <SuccessView
                    onClose={animateClose}
                    receivedAmount={successInfo?.receivedAmount ?? ''}
                    receivedCurrency={successInfo?.receivedCurrency ?? toCurrency}
                  />
                ) : stage === 'error' ? (
                  <ErrorView
                    onClose={animateClose}
                    onRetry={() => {
                      setStage('input');
                      setErrMsg(null);
                    }}
                    message={errMsg}
                  />
                ) : (
                  <InputView
                    fromCurrency={fromCurrency}
                    toCurrency={toCurrency}
                    fromBalance={spendableBalance}
                    fromBalanceStr={spendableBalanceStr}
                    fromBalanceLoading={spendableBalances.balanceLocked}
                    fromBalanceError={spendableBalances.error}
                    onRetryFromBalance={spendableBalances.refresh}
                    amount={amount}
                    onAmountChange={setAmount}
                    onMax={setMax}
                    onSwap={swapDirection}
                    onPickFrom={() => setPickerOpen('from')}
                    onPickTo={() => setPickerOpen('to')}
                    quote={quote?.data ?? null}
                    quoteLoading={quoteLoading}
                    quoteErr={quoteErr}
                    belowMinHint={belowMinHint}
                    inputErr={inputErr}
                    onConfirm={onPressConfirm}
                    stage={stage}
                    limitReached={limitReached}
                    limitTitle={transferLimit.title}
                    limitText={transferLimit.message}
                    marketClosed={marketClosed}
                    quoteSecondsLeft={liveQuote.secondsLeft}
                    quoteFraction={liveQuote.fraction}
                    quoteRefreshing={liveQuote.refreshing}
                    onRefreshQuote={liveQuote.refreshNow}
                  />
                )}
              </View>
            </SafeAreaView>
          </Animated.View>
        </KeyboardAvoidingView>

        {pickerOpen ? (
          <CurrencyPicker
            options={pickerOptions}
            currentlySelected={pickerOpen === 'from' ? fromCurrency : toCurrency}
            otherSide={pickerOpen === 'from' ? toCurrency : fromCurrency}
            onPick={(code) => {
              if (pickerOpen === 'from') setFromCurrency(code);
              else setToCurrency(code);
              setPickerOpen(null);
              // Keep the source amount when exploring rates across "to" currencies.
              // Quote refetch is driven by the debounced effect on from/to change.
            }}
            onCancel={() => setPickerOpen(null)}
          />
        ) : null}

        <BankConfirmModal
          visible={confirmOpen}
          title={t('convert.confirmTitle', 'Confirm conversion')}
          message={t('convert.confirmMessage', {
            send: amount,
            from: fromCurrency,
            receive: formatAmount(quote?.data?.outputAmount),
            to: toCurrency,
            defaultValue:
              `Convert ${amount} ${fromCurrency} to ${formatAmount(quote?.data?.outputAmount)} ${toCurrency}?`,
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
  fromCurrency,
  toCurrency,
  fromBalance,
  fromBalanceStr,
  fromBalanceLoading,
  fromBalanceError,
  onRetryFromBalance,
  amount,
  onAmountChange,
  onMax,
  onSwap,
  onPickFrom,
  onPickTo,
  quote,
  quoteLoading,
  quoteErr,
  belowMinHint,
  inputErr,
  onConfirm,
  stage,
  limitReached,
  limitTitle,
  limitText,
  marketClosed,
  quoteSecondsLeft,
  quoteFraction,
  quoteRefreshing,
  onRefreshQuote,
}: {
  fromCurrency: string;
  toCurrency: string;
  fromBalance: number;
  fromBalanceStr: string;
  fromBalanceLoading: boolean;
  fromBalanceError: boolean;
  onRetryFromBalance: () => void;
  amount: string;
  onAmountChange: (s: string) => void;
  onMax: () => void;
  onSwap: () => void;
  onPickFrom: () => void;
  onPickTo: () => void;
  quote: UrFxQuoteData | null;
  quoteLoading: boolean;
  quoteErr: string | null;
  belowMinHint: string | null;
  inputErr: string | null;
  onConfirm: () => void;
  stage: Stage;
  limitReached: boolean;
  limitTitle: string;
  limitText: string;
  marketClosed: boolean;
  quoteSecondsLeft: number;
  quoteFraction: number;
  quoteRefreshing: boolean;
  onRefreshQuote: () => void;
}) {
  const { t } = useTranslation();
  const [rateInverted, setRateInverted] = useState(false);
  useEffect(() => {
    setRateInverted(false);
  }, [fromCurrency, toCurrency, quote?.exchangeRate]);
  const balanceLocked = fromBalanceLoading || fromBalanceError;
  // Every non-terminal stage past 'input' is "busy" — the user can't edit
  // amount/currency while the relayer flow is in flight. Each maps to a
  // distinct CTA label below so the user can tell what we're doing.
  const busy =
    stage === 'preparing' ||
    stage === 'signing-auth' ||
    stage === 'signing-batch' ||
    stage === 'submitting' ||
    stage === 'confirming';
  const canConfirm =
    !busy && !inputErr && !limitReached && !marketClosed && !!quote &&
    !quoteLoading && !balanceLocked && parseFloat(amount || '0') > 0;
  const showRate = !!quote && !quoteLoading && !inputErr;
  // Show the live-quote countdown ring only once a quote is on screen and we
  // aren't blocked. It depletes as the quote ages and silently re-reads near
  // expiry; tap it to force an immediate re-quote.
  const showCountdown = showRate && !limitReached && !marketClosed;

  // CTA label per stage. Wording is intentionally "we're doing this for
  // you" (not "confirm in your wallet") because the flow is GASLESS — the
  // user only signs hashes off-chain, never approves a tx in the wallet.
  // Two signature prompts may appear though (auth + batch on first
  // Convert, batch only on subsequent ones).
  const ctaLabel = (() => {
    switch (stage) {
      case 'preparing':
        return t('convert.preparing');
      case 'signing-auth':
        return t('convert.signingAuth');
      case 'signing-batch':
        return t('convert.signingBatch');
      case 'submitting':
        return t('convert.submitting');
      case 'confirming':
        return t('convert.polling');
      default:
        return t('convert.confirm');
    }
  })();

  return (
    <>
      <Text style={styles.title}>{t('convert.title')}</Text>

      {/* Pre-flight block: surfaced BEFORE any signing so a guaranteed
          on-chain revert never costs the user a signature. Limit takes
          priority over market-closed. */}
      {limitReached ? (
        <View style={styles.blockBanner}>
          <Ionicons name="lock-closed" size={16} color="#e0a23b" />
          <View style={styles.blockBannerBody}>
            <Text style={styles.blockBannerTitle}>
              {limitTitle || t('convert.limitReachedTitle')}
            </Text>
            <Text style={styles.blockBannerText}>
              {limitText || t('convert.limitReached')}
            </Text>
          </View>
        </View>
      ) : marketClosed ? (
        <View style={styles.blockBanner}>
          <Ionicons name="time-outline" size={16} color="#e0a23b" />
          <Text style={styles.blockBannerText}>{t('convert.marketClosed')}</Text>
        </View>
      ) : null}

      {/* FROM */}
      <View style={styles.fromBlock}>
          <View style={styles.rowBetween}>
          <Text style={styles.smallLabel}>{t('convert.from')}</Text>
          <SpendableBalanceLine
            label={t('convert.available')}
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
        <TouchableOpacity
          onPress={onMax}
          disabled={fromBalance <= 0 || busy || balanceLocked}
        >
          <Text
            style={[
              styles.maxText,
              (fromBalance <= 0 || busy || balanceLocked) && { opacity: 0.4 },
            ]}
          >
            {t('convert.max')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* SWAP arrow */}
      <View style={styles.swapRow}>
        <View style={styles.swapLine} />
        <TouchableOpacity
          onPress={onSwap}
          style={styles.swapBtn}
          accessibilityLabel={t('convert.swapDirection')}
          disabled={busy}
        >
          <Ionicons name="swap-vertical" size={18} color={colors.accent.gold} />
        </TouchableOpacity>
        <View style={styles.swapLine} />
      </View>

      {/* TO */}
      <View style={styles.toBlock}>
        <View style={styles.rowBetween}>
          <Text style={styles.smallLabel}>{t('convert.to')}</Text>
          {showRate ? (
            <View style={styles.rateRow}>
              <Pressable
                onPress={() => setRateInverted((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={t('convert.toggleRateDirection', 'Toggle exchange rate direction')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.smallLabelMuted}>
                  {buildExchangeRateLine({
                    from: fromCurrency,
                    to: toCurrency,
                    rate: quote?.exchangeRate,
                    inverted: rateInverted,
                  })}
                </Text>
              </Pressable>
              {showCountdown ? (
                <TouchableOpacity
                  onPress={onRefreshQuote}
                  disabled={busy || quoteRefreshing}
                  accessibilityLabel={t('convert.refreshQuote')}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <QuoteCountdownRing
                    fraction={quoteFraction}
                    seconds={quoteSecondsLeft}
                    refreshing={quoteRefreshing}
                    size={26}
                    stroke={2.5}
                  />
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
        <View style={styles.amountRow}>
          {quoteLoading ? (
            <View style={styles.receiveDots}>
              <BouncingDots dotSize={8} pulse />
            </View>
          ) : (
            <Text style={styles.amountReceive}>
              {quote ? formatAmount(quote.outputAmount) : '0'}
            </Text>
          )}
          <TouchableOpacity onPress={onPickTo} style={styles.currencyChip} disabled={busy}>
            <CircleCurrencyFlag currencyCode={toCurrency} size={20} />
            <Text style={styles.currencyChipText}>{toCurrency}</Text>
            <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Status row — priority order: red errors first, then soft hints,
          then a quiet loading indicator while a quote is in-flight. */}
      {inputErr ? (
        <Text style={styles.errText}>{inputErr}</Text>
      ) : quoteErr ? (
        <Text style={styles.errText}>{quoteErr}</Text>
      ) : belowMinHint ? (
        <Text style={styles.hintText}>{belowMinHint}</Text>
      ) : quoteLoading ? (
        <Text style={styles.quotingText}>{t('convert.quoting')}</Text>
      ) : null}

      <Text style={styles.disclaimer}>{t('convert.disclaimer')}</Text>

      <TouchableOpacity
        style={[
          styles.confirmBtn,
          !busy && !canConfirm && styles.confirmBtnDisabled,
        ]}
        onPress={busy ? undefined : onConfirm}
        disabled={!canConfirm && !busy}
        activeOpacity={busy ? 1 : 0.85}
      >
        <LinearGradient
          colors={busy || canConfirm ? CONFIRM_GRADIENT : CONFIRM_GRADIENT_DISABLED}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.confirmGradient}
        >
          {busy ? (
            <>
              <ActivityIndicator size="small" color={GRADIENT_BTN_SPINNER_BUSY} />
              <Text style={gradientConfirmTextBusy}>{ctaLabel}</Text>
            </>
          ) : (
            <Text
              style={[
                styles.confirmText,
                !canConfirm && { color: colors.text.tertiary },
              ]}
            >
              {ctaLabel}
            </Text>
          )}
        </LinearGradient>
      </TouchableOpacity>
    </>
  );
}

function SuccessView({
  onClose,
  receivedAmount,
  receivedCurrency,
}: {
  onClose: () => void;
  receivedAmount: string;
  receivedCurrency: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.resultBlock}>
      <View style={[styles.resultIcon, { backgroundColor: '#1d2c20' }]}>
        <Ionicons name="checkmark" size={28} color="#5dd47a" />
      </View>
      <Text style={styles.resultTitle}>{t('convert.successTitle')}</Text>
      <Text style={styles.resultBody}>
        {t('convert.successBody', {
          amount: formatAmount(receivedAmount),
          currency: receivedCurrency,
        })}
      </Text>
      {/* `alignSelf: 'stretch'` overrides `resultBlock`'s `alignItems:
          'center'`, which otherwise sizes intrinsic-width children to
          their content — leaving the Done button as a narrow pill
          centered awkwardly under the message. The on-chain tx hash is
          intentionally NOT shown here; it's surfaced in the dashboard's
          Transactions section so we keep the success modal clean. */}
      <TouchableOpacity
        style={[styles.confirmBtn, { alignSelf: 'stretch' }]}
        onPress={onClose}
      >
        <LinearGradient
          colors={CONFIRM_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.confirmGradient}
        >
          <Text style={styles.confirmText}>{t('convert.successDone')}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

function ErrorView({
  onClose,
  onRetry,
  message,
}: {
  onClose: () => void;
  onRetry: () => void;
  message: string | null;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.resultBlock}>
      <View style={[styles.resultIcon, { backgroundColor: '#2c1d1d' }]}>
        <Ionicons name="alert" size={28} color="#e57373" />
      </View>
      <Text style={styles.resultTitle}>{t('convert.errorTitle')}</Text>
      <Text style={styles.resultBody}>{message ?? t('convert.unknownError')}</Text>
      <View style={{ flexDirection: 'row', gap: 12, alignSelf: 'stretch' }}>
        <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={onClose}>
          <Text style={styles.secondaryBtnText}>{t('convert.errorClose')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.confirmBtn, { flex: 1 }]} onPress={onRetry}>
          <LinearGradient
            colors={CONFIRM_GRADIENT}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.confirmGradient}
          >
            <Text style={styles.confirmText}>{t('convert.errorRetry')}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CurrencyPicker({
  options,
  currentlySelected,
  otherSide,
  onPick,
  onCancel,
}: {
  options: { currency: string; amount: number; amountStr: string; balanceLoading?: boolean }[];
  currentlySelected: string;
  otherSide: string;
  onPick: (code: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'android' ? 32 : 20);

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.7)' }]}
        onPress={onCancel}
      />
      <View style={[styles.pickerSheet, { paddingBottom: bottomPad }]}>
        <View style={styles.pickerHandle} />
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>{t('convert.pickCurrency')}</Text>
          <TouchableOpacity onPress={onCancel} hitSlop={12} accessibilityRole="button">
            <Ionicons name="close" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={[styles.pickerList, { minHeight: CONVERT_PICKER_LIST_MIN_HEIGHT }]}
          contentContainerStyle={styles.pickerListContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {options.map((item) => {
            const disabled = item.currency === otherSide;
            const active = item.currency === currentlySelected;
            return (
              <TouchableOpacity
                key={item.currency}
                disabled={disabled}
                onPress={() => onPick(item.currency)}
                style={[
                  styles.pickerRow,
                  disabled && styles.pickerRowDisabled,
                  active && !disabled && styles.pickerRowActive,
                ]}
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
                  {active && !disabled ? (
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
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
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
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: 20,
    paddingTop: 8,
    maxHeight: '75%',
  },
  pickerHandle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
    alignSelf: 'center',
    marginBottom: 12,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  pickerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.text.primary,
  },
  pickerList: {
    flexGrow: 0,
  },
  pickerListContent: {
    gap: 8,
    paddingBottom: 4,
  },
  handleArea: {
    // Wider hit area than the visible bar so the drag works on a wide
    // strip across the top of the sheet (Apple HIG-ish: ~44pt tappable).
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginBottom: 4,
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 16,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  smallLabel: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
  smallLabelMuted: { fontSize: 11, color: colors.text.tertiary },
  availableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '62%',
    justifyContent: 'flex-end',
  },
  balanceRetryText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.gold,
  },
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  blockBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#e0a23b',
    marginBottom: 2,
  },
  blockBannerText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text.secondary },
  fromBlock: {
    backgroundColor: colors.background.elevated,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  toBlock: {
    backgroundColor: colors.background.elevated,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  amountInput: {
    flex: 1,
    fontSize: 28,
    fontWeight: '800',
    color: colors.text.primary,
    paddingVertical: 4,
  },
  receiveDots: {
    flex: 1,
    height: 36,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  amountReceive: {
    flex: 1,
    fontSize: 28,
    fontWeight: '800',
    color: colors.text.primary,
    paddingVertical: 4,
  },
  currencyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  currencyChipText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
  },
  maxText: {
    color: colors.accent.gold,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 6,
    letterSpacing: 0.5,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
    gap: 12,
  },
  swapLine: { flex: 1, height: 1, backgroundColor: colors.border.primary },
  swapBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.elevated,
  },
  errText: {
    color: '#e57373',
    fontSize: 12,
    marginTop: 12,
    fontWeight: '600',
  },
  hintText: {
    color: colors.text.tertiary,
    fontSize: 12,
    marginTop: 12,
    fontWeight: '600',
  },
  quotingText: { fontSize: 12, color: colors.text.tertiary, marginTop: 12 },
  disclaimer: {
    fontSize: 11,
    color: colors.text.tertiary,
    marginTop: 14,
    lineHeight: 16,
  },
  confirmBtn: {
    marginTop: 16,
    borderRadius: 14,
    overflow: 'hidden',
  },
  confirmBtnDisabled: { opacity: 0.7 },
  confirmGradient: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  confirmText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
    letterSpacing: 0.3,
  },
  secondaryBtn: {
    marginTop: 16,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  resultBlock: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 12,
  },
  resultIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
  },
  resultBody: {
    fontSize: 13,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: 8,
    maxWidth: 320,
  },
  txHashLine: {
    fontSize: 11,
    color: colors.text.tertiary,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  pickerRowMain: {
    flex: 1,
    marginLeft: 10,
    minWidth: 0,
  },
  pickerRowCode: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
  },
  pickerRowLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.text.tertiary,
    marginTop: 1,
  },
  pickerRowRight: {
    alignItems: 'flex-end',
    gap: 4,
    marginLeft: 8,
    maxWidth: '38%',
  },
  pickerBalance: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'right',
  },
  pickerRowDisabled: {
    opacity: 0.45,
  },
  pickerRowActive: {
    borderColor: colors.accent.gold,
  },
});
