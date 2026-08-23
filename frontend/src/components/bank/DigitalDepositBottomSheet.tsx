/**
 * DigitalDepositBottomSheet — turns Privy-held Arbitrum USDC into UR fiat (Phase 1: USD).
 *
 * End-to-end flow (Path F — EIP-7702 + Ambire + depositTokenViaUsdc):
 *
 *   1. User taps "Add money" on the Cash tab. We open this bottom sheet.
 *   2. User enters an amount in USDC. We POST /api/ur/deposit/quote to get
 *      output fiat, fees, quoteId, the four contract addresses we need
 *      (Ambire delegate, Fiat24CryptoDeposit, USDC, output fiat OFT), and
 *      `feeAmountViaNativeToken` (the LayerZero cross-chain fee in ETH wei).
 *   3. User confirms. We:
 *        a. (First-time only on this chain) ask Privy to sign an EIP-7702
 *           authorization binding the EOA to Ambire's delegate. Skipped if
 *           the EOA's code already starts with `0xef0100<ambire>`.
 *        b. Build the calls batch:
 *             [
 *               USDC.approve(deposit, amount),       // value 0
 *               Fiat24CryptoDeposit.depositTokenViaUsdc(USDC, fiatOFT, amount, 0)
 *                  // value = feeAmountViaNativeToken (LZ cross-chain fee)
 *             ]
 *        c. Compute Ambire's batch hash and sign it.
 *
 *           The deployed `AmbireAccount7702` at the UR delegate does NOT
 *           match the public v2 source — it pre-wraps the inner
 *           `keccak(abi.encode(eoa, chainId, nonce, calls))` with EIP-712
 *           `AmbireExecuteAccountOp` BEFORE calling ecrecover, even in
 *           "Unprotected" mode. Verified on-chain via
 *           debug_traceTransaction on tx 0x87f7e974… on Arb Sepolia.
 *
 *           So we compute the EIP-712 wrap ourselves, then sign with raw
 *           secp256k1 (NO EIP-191 wrap, NO mode byte). The 65-byte sig's
 *           trailing v ∈ {27,28} ≥ LastUnused triggers Ambire's
 *           Unprotected-mode coercion, which then ecrecovers the wrapped
 *           hash directly — recovering to the EOA, whose privileges are
 *           hardcoded to 2 in AmbireAccount7702.privileges().
 *
 *        d. POST everything to /api/ur/deposit/execute-7702 — the backend
 *           wraps it in a type-2 (or type-4 with auth list on the first
 *           delegation) transaction signed by our relayer pool and
 *           broadcasts (gasless for the user; the relayer pays both gas
 *           AND the LayerZero native fee).
 *   4. We poll /api/ur/jobs/:id until the job is terminal, then refresh
 *      the parent Cash tab so the new USD24 balance shows up.
 *
 * NOTE on chain: we use Arbitrum Sepolia (421614) for testnet. The
 * source chain flips to Arbitrum Mainnet (42161) once Adam grants
 * production access — controlled via EXPO_PUBLIC_UR_SOURCE_CHAIN_ID.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  Platform,
  useWindowDimensions,
  Animated,
  PanResponder,
  Pressable,
  Dimensions,
  Image,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import QRCodeStyled from 'react-native-qrcode-styled';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';
import { useEmbeddedEthereumWallet, useSign7702Authorization } from '@privy-io/expo';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  http,
  TransactionReceiptNotFoundError,
  type Hex,
} from 'viem';
// 7702 helpers — kept for the BACKUP manual auth-signing path (see
// USE_PRIVY_7702_HOOK below). `prepareAuthorization` fills in chainId + nonce,
// `hashAuthorization` returns the 32-byte digest the EOA signs (raw secp256k1,
// no EIP-191 prefix). EIP-7702 graduated out of viem/experimental, so import
// from the stable entrypoints. The primary path now uses Privy's
// useSign7702Authorization hook.
import { prepareAuthorization } from 'viem/actions';
import { hashAuthorization } from 'viem/utils';
import { arbitrumSepolia, arbitrum } from 'viem/chains';

import { colors } from '../../theme/colors';
import { txExplorerUrl } from '../../lib/explorer';
import { openHttpsUrl } from '../../lib/openHttpsUrl';
import { useAuth } from '../../providers/AuthContext';
import {
  fetchUrDepositQuote,
  fetchUrDeposit7702Info,
  fetchUrDepositCurrencies,
  executeUrDeposit7702,
  fetchUrJob,
  isUrDepositUserSuccess,
  isUrJobTerminal,
  type UrDepositCurrenciesResponse,
  type UrDepositQuoteResponse,
  type UrJobSummary,
  type UrDeposit7702Authorization,
  type UrDeposit7702Call,
  type CashAccountRow,
} from '../../lib/urApi';
import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import {
  AMBIRE_NONCE_ABI,
  computeAmbireBatchHash,
  normaliseAuth7702Signature,
  normaliseSig65,
} from '../../lib/ambire7702';
import { BankConfirmModal } from './BankConfirmModal';
import { BouncingDots } from '../BouncingDots';
import { CircleCurrencyFlag } from './CircleCountryFlag';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_TRAVEL = SCREEN_HEIGHT;
/** Min scroll area for the deposit target-currency picker. */
const DEPOSIT_PICKER_LIST_MIN_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);
const USDC_ICON = require('../../../assets/images/usdc-icon.webp');
const ARBITRUM_PILL_ICON = require('../../../assets/images/symbols/arb-icon.webp');

// EIP-7702 authorization signer selector.
//   true  → Privy's first-class `useSign7702Authorization` hook (added in
//           @privy-io/expo 0.68.0; we run 0.68.1). Cleaner, Privy-owned.
//   false → the manual viem `prepareAuthorization` + Privy `secp256k1_sign`
//           fallback we shipped before the hook existed (kept verbatim below
//           as a proven backup). Flip to false if the hook ever regresses —
//           both paths produce the same {chain_id,address,nonce,y_parity,r,s}.
// NOTE: this only swaps the SetCode AUTHORIZATION signature. The Ambire batch
// signing (computeAmbireBatchHash + secp256k1_sign) is unchanged either way.
const USE_PRIVY_7702_HOOK = true;

/** Recognizable wallet shorthand — prefix + longer suffix for the pill. */
function formatWalletAddressDisplay(address: string): string {
  const normalized = address.trim();
  if (normalized.length <= 20) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-10)}`;
}

// --------------------------------------------------------------------------- //
// Chain config
// --------------------------------------------------------------------------- //

/**
 * Source chain for UR deposits. Defaults to Arbitrum Sepolia for testnet.
 * Set EXPO_PUBLIC_UR_SOURCE_CHAIN_ID=42161 to flip to Arbitrum One.
 *
 * IMPORTANT: `process.env.EXPO_PUBLIC_*` is only inlined from REAL build-time
 * env vars / .env files — NOT from `app.json`'s `expo.extra`. Since we ship
 * this value via `extra` (app.json), we MUST read the `extra` fallback too,
 * exactly like `resolveSourceRpcUrl()` / `_layout.tsx` do. Without it a prod
 * build silently falls back to Arb Sepolia (wrong balance + "Arbitrum Sepolia"
 * label) even though app.json says 42161.
 */
const UR_SOURCE_CHAIN_EXTRA = (Constants.expoConfig?.extra as any)
  ?? (Constants as any).manifest2?.extra
  ?? (Constants as any).manifest?.extra;
const UR_SOURCE_CHAIN_ID = Number(
  process.env.EXPO_PUBLIC_UR_SOURCE_CHAIN_ID
    ?? UR_SOURCE_CHAIN_EXTRA?.EXPO_PUBLIC_UR_SOURCE_CHAIN_ID
    ?? '421614',
);

const UR_SOURCE_CHAIN =
  UR_SOURCE_CHAIN_ID === 42161 ? arbitrum : arbitrumSepolia;

/** Hex form used by `wallet_switchEthereumChain`. */
const UR_SOURCE_CHAIN_ID_HEX = `0x${UR_SOURCE_CHAIN_ID.toString(16)}` as const;

/**
 * Resolve the RPC URL for the active UR source chain.
 *
 * Default `http()` falls back to viem's public RPC for the chain, which is
 * heavily rate-limited on Arb Sepolia and frequently 429s on mobile —
 * causing `balanceOf` reads to silently fail. We prefer an explicit Alchemy
 * URL injected via Expo's `extra` field (set in app.json or per build).
 */
function resolveSourceRpcUrl(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extra = (Constants.expoConfig?.extra as any)
    ?? (Constants as any).manifest2?.extra
    ?? (Constants as any).manifest?.extra;
  if (UR_SOURCE_CHAIN_ID === 42161) {
    return (
      process.env.EXPO_PUBLIC_ARBITRUM_RPC_URL ||
      extra?.EXPO_PUBLIC_ARBITRUM_RPC_URL ||
      undefined
    );
  }
  // Arb Sepolia (and any other testnet override)
  return (
    process.env.EXPO_PUBLIC_ARB_SEPOLIA_RPC_URL ||
    extra?.EXPO_PUBLIC_ARB_SEPOLIA_RPC_URL ||
    undefined
  );
}

const ERC20_APPROVE_ABI = [
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
] as const;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

const FIAT24_DEPOSIT_VIA_USDC_ABI = [
  {
    type: 'function',
    name: 'depositTokenViaUsdc',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_inputToken', type: 'address' },
      { name: '_outputToken', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_amountOutMinimum', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const USDC_DECIMALS = 6;
const FIAT_DECIMALS = 2;

/** Per UR docs / contract: minimum deposit is 5 USDC. */
const MIN_USDC = 5;

const JOB_POLL_INTERVAL_MS = 2500;
const JOB_POLL_MAX_ATTEMPTS = 40; // ~100s before we surrender to background

/**
 * Post-success refresh cadence. UR's `/v1/balance` and `/v1/transactions`
 * indexers can lag the source-chain receipt by several seconds (LayerZero
 * hop on testnet plus UR's worker queue) — so we mark an "Incoming X CCY"
 * pill on the matching currency card (handled by `useUrAccount` via
 * `markIncoming`) and let the hook poll until the balance lands. The
 * sheet just calls `onSuccess` once with the credited amount; the
 * polling loop lives where the balance lives.
 */

/**
 * Resolve the human-decimal amount actually credited to the user's
 * target-currency wallet. We trust the backend's `target_amount` first
 * (it's been canonicalised against Fiat24's on-chain rate × spread —
 * see `_effective_deposit_target_amount` in `backend/server.py`).
 *
 * The `fallback` is the input USDC amount, which is the right answer
 * for the USDC -> USD24 1:1 path but quite wrong for EUR/CHF — so we
 * only use it when the backend hasn't populated `target_amount`.
 */
function pickCreditedAmount(
  targetAmountStr: string | null | undefined,
  fallback: number,
): number {
  if (!targetAmountStr) return fallback;
  const parsed = Number(String(targetAmountStr).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

type Stage =
  | 'input'
  | 'quoting'
  | 'review'
  | 'signing-auth'
  | 'signing-batch'
  | 'submitting'
  | 'polling'
  | 'success'
  | 'error';

interface Currency {
  code: string;
  label: string;
  /** Resolved from GET /ur/deposit/currencies; `loading` while probing. */
  status: 'loading' | 'available' | 'unavailable';
}

/** Display labels — availability comes from GET /ur/deposit/currencies. */
const DEPOSIT_CURRENCY_LABELS: Record<string, string> = {
  USD: 'US Dollar',
  EUR: 'Euro',
  CHF: 'Swiss Franc',
  CNH: 'Chinese Yuan',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  JPY: 'Japanese Yen',
};

const DEPOSIT_CURRENCY_ORDER = Object.keys(DEPOSIT_CURRENCY_LABELS);

function buildDepositCurrencies(
  probe: UrDepositCurrenciesResponse | null,
  targetsLoading: boolean,
): Currency[] {
  if (targetsLoading) {
    return DEPOSIT_CURRENCY_ORDER.map((code) => ({
      code,
      label: DEPOSIT_CURRENCY_LABELS[code] ?? code,
      status: 'loading' as const,
    }));
  }

  const availability = new Map(
    (probe?.currencies ?? []).map((row) => [row.code, row.available]),
  );
  return DEPOSIT_CURRENCY_ORDER.map((code) => {
    const probed = availability.get(code);
    const status: Currency['status'] =
      probed === true ? 'available' : probed === false ? 'unavailable' : code === 'USD' ? 'available' : 'unavailable';
    return {
      code,
      label: DEPOSIT_CURRENCY_LABELS[code] ?? code,
      status,
    };
  });
}

// --------------------------------------------------------------------------- //
// Component
// --------------------------------------------------------------------------- //

export interface DigitalDepositBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Called once after the source-chain receipt confirms. The parent uses
   * `incoming.amount` / `incoming.currency` to snapshot the user's current
   * balance and surface a pending pill on the matching currency card —
   * see `useUrAccount.markIncoming` and the "Incoming" UX in
   * `frontend/src/components/DepositPanel.tsx` for the same pattern.
   *
   * Passed undefined if the sheet decides nothing was actually credited
   * (e.g. the user aborted mid-flight or the receipt reverted).
   *
   * `sourceTxHash` / `sourceChainId` identify the cross-chain (LayerZero)
   * deposit so the parent can keep the "incoming" pill alive until the
   * destination credit truly lands, rather than a blind timer.
   */
  onSuccess?: (
    incoming?: {
      currency: string;
      amount: number;
      sourceTxHash?: string;
      sourceChainId?: number;
    },
  ) => Promise<void> | void;
  /**
   * Cross-chain deposits the parent currently considers in-flight (the
   * "incoming" pills from `useUrAccount.pendingIncoming`). Used for a tight
   * pre-sign guard: the 7702 Ambire batch is signed against the EOA's live
   * Ambire `nonce()`, which only bumps once the *source* tx mines — so a
   * second deposit started before the prior source tx confirms would reuse
   * the same nonce and revert on-chain. We refuse to sign until that source
   * receipt lands (the multi-minute LayerZero credit tail never blocks a
   * top-up). The backend enforces the same rule authoritatively.
   */
  inFlightDeposits?: { sourceTxHash?: string; sourceChainId?: number }[];
  /** Fiat account rows — used to show current balance in the target-currency picker. */
  cashRows?: CashAccountRow[];
}

export function DigitalDepositBottomSheet({
  visible,
  onClose,
  onSuccess,
  inFlightDeposits,
  cashRows = [],
}: DigitalDepositBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.min(windowHeight * 0.92, windowHeight - insets.top - 8);
  const { getAccessToken, walletAddress: canonicalAddress } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();
  // Privy's first-class EIP-7702 authorization signer (Expo SDK ≥ 0.68).
  // Used by the primary path in executeDeposit when USE_PRIVY_7702_HOOK.
  const { signAuthorization } = useSign7702Authorization();
  // Privy can hold MORE than one embedded wallet (auto-created + imported
  // UR test wallet under ENABLE_UR_TEST_WALLET_IMPORT, or just multiple
  // historical wallets). `wallets[0]` is order-dependent and can land on
  // the wrong key — making balance reads return 0 and signatures recover
  // to an EOA the URID contract doesn't recognise. AuthContext's
  // `walletAddress` already encodes the correct resolution (prefers the
  // imported URID-owner key when test-import mode is on). We pin both the
  // address and the provider-wallet to that canonical address.
  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return undefined;
    if (canonicalAddress) {
      const target = canonicalAddress.toLowerCase();
      const match = wallets.find((w) => w.address.toLowerCase() === target);
      if (match) return match;
    }
    return wallets[0];
  }, [wallets, canonicalAddress]);
  const eoaAddress = ((canonicalAddress || wallet?.address) || null) as Hex | null;

  const publicClient = useMemo(() => {
    const rpcUrl = resolveSourceRpcUrl();
    return createPublicClient({
      chain: UR_SOURCE_CHAIN,
      transport: rpcUrl ? http(rpcUrl) : http(),
    });
  }, []);

  const [amount, setAmount] = useState('');
  const [currencyProbe, setCurrencyProbe] = useState<UrDepositCurrenciesResponse | null>(null);
  const [currencyTargetsLoading, setCurrencyTargetsLoading] = useState(false);
  const supportedCurrencies = useMemo(
    () => buildDepositCurrencies(currencyProbe, currencyTargetsLoading),
    [currencyProbe, currencyTargetsLoading],
  );
  const [currency, setCurrency] = useState<Currency>(() =>
    buildDepositCurrencies(null, false).find((c) => c.status === 'available')!,
  );
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [showDepositQr, setShowDepositQr] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [usdcBalanceLoading, setUsdcBalanceLoading] = useState(false);
  const [quote, setQuote] = useState<UrDepositQuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('input');
  const [job, setJob] = useState<UrJobSummary | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const quoteSeqRef = useRef(0);
  const pollSeqRef = useRef(0);
  const incomingNotifiedRef = useRef(false);
  /** True once `onSuccess` ran with a source tx hash (blocks hash backfill loops). */
  const incomingNotifiedWithHashRef = useRef(false);
  /** Job id we already promoted to the success stage (blocks poll effect loops). */
  const depositSuccessJobIdRef = useRef<string | null>(null);

  const [mounted, setMounted] = useState(false);

  const spendableBalances = useSpendableMantleBalances({
    active: mounted,
    walletAddress: canonicalAddress,
    getAccessToken,
  });

  const depositPickerBalanceByCode = useMemo(() => {
    const base = supportedCurrencies.map((c) => {
      const row = cashRows.find((r) => r.currency === c.code);
      return {
        currency: c.code,
        amount: row?.amount ?? 0,
        amountStr: row?.amountStr ?? '0.00',
      };
    });
    const decorated = spendableBalances.decoratePickerOptions(base);
    return Object.fromEntries(decorated.map((o) => [o.currency, o]));
  }, [supportedCurrencies, cashRows, spendableBalances]);

  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);

  const canDismiss = useMemo(
    () => stage !== 'submitting' && stage !== 'polling',
    [stage],
  );

  const finishClose = useCallback(() => {
    setMounted(false);
    setConfirmOpen(false);
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
        duration: 200,
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
    requestAnimationFrame(() => {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 6,
          speed: 14,
        }),
        Animated.timing(backdropAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    });
  }, [slideAnim, backdropAnim]);

  const tryDismiss = useCallback(() => {
    if (!canDismiss) return;
    animateClose();
  }, [canDismiss, animateClose]);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    if (visible && !wasVisible) {
      closingRef.current = false;
      incomingNotifiedRef.current = false;
      incomingNotifiedWithHashRef.current = false;
      depositSuccessJobIdRef.current = null;
      setCurrencyProbe(null);
      setCurrencyTargetsLoading(true);
      setMounted(true);
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setCurrencyTargetsLoading(true);
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;
        const probe = await fetchUrDepositCurrencies(token, UR_SOURCE_CHAIN_ID);
        if (!cancelled) setCurrencyProbe(probe);
      } catch {
        if (!cancelled) setCurrencyProbe(null);
      } finally {
        if (!cancelled) setCurrencyTargetsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, getAccessToken]);

  useEffect(() => {
    if (currencyTargetsLoading) return;
    const current = supportedCurrencies.find((c) => c.code === currency.code);
    if (current?.status === 'available') return;
    const firstAvailable = supportedCurrencies.find((c) => c.status === 'available');
    if (firstAvailable) setCurrency(firstAvailable);
  }, [currencyTargetsLoading, currencyProbe, supportedCurrencies, currency.code]);

  const depositDisclaimer = useMemo(() => {
    if (currencyTargetsLoading) {
      return t('addMoney.disclaimerLoading', { min: MIN_USDC });
    }
    const targets = supportedCurrencies
      .filter((c) => c.status === 'available')
      .map((c) => c.code)
      .join(', ');
    if (!targets) {
      return t('addMoney.disclaimerUnavailable', { min: MIN_USDC });
    }
    return t('addMoney.disclaimer', { min: MIN_USDC, targets });
  }, [supportedCurrencies, currencyTargetsLoading, t]);

  const onPickCurrency = useCallback((c: Currency) => {
    if (c.status !== 'available') return;
    setCurrency(c);
    setShowCurrencyPicker(false);
    setQuote(null);
    setStage('input');
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => canDismiss,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          canDismiss && Math.abs(gestureState.dy) > 4,
        onPanResponderMove: (_, gestureState) => {
          if (gestureState.dy > 0) {
            slideAnim.setValue(gestureState.dy);
          } else {
            slideAnim.setValue(gestureState.dy * 0.25);
          }
        },
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 80 || gestureState.vy > 0.45) {
            animateClose();
          } else {
            Animated.spring(slideAnim, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 5,
              speed: 18,
            }).start();
          }
        },
      }),
    [canDismiss, slideAnim, animateClose],
  );

  // ─── Reset on close so a re-open lands on a clean slate ────────────────
  useEffect(() => {
    if (!visible) {
      const t = setTimeout(() => {
        setAmount('');
        setQuote(null);
        setQuoteError(null);
        setStage('input');
        setJob(null);
        setTxHash(null);
        setErrorMsg(null);
        setShowCurrencyPicker(false);
        setShowDepositQr(false);
        setAddressCopied(false);
        if (copyFeedbackTimerRef.current) {
          clearTimeout(copyFeedbackTimerRef.current);
          copyFeedbackTimerRef.current = null;
        }
        pollSeqRef.current += 1;
      }, 250); // wait for slide-out anim before clearing
      return () => clearTimeout(t);
    }
  }, [visible]);

  // ─── USDC balance for "Available" line and Max button ──────────────────
  useEffect(() => {
    if (!visible || !eoaAddress) {
      setUsdcBalance(null);
      setUsdcBalanceLoading(false);
      return;
    }
    let cancelled = false;
    setUsdcBalance(null);
    setUsdcBalanceLoading(true);
    void (async () => {
      try {
        // Resolve the USDC token the deposit gateway ACTUALLY expects via the
        // backend's LIVE `usdc()` read (same value the deposit quote builds the
        // approve/pull with). UR re-points this token on testnet, so a hardcoded
        // map can show a depositable balance for a token the gateway would
        // reject — and the deposit then reverts on `transferFrom`. We fall back
        // to the static map only if the live lookup fails, so the line still
        // renders on a flaky network.
        let usdcAddr: Hex | null = null;
        try {
          const token = await getAccessToken();
          if (token) {
            const info = await fetchUrDeposit7702Info(token, UR_SOURCE_CHAIN_ID);
            if (info?.usdc) usdcAddr = info.usdc as Hex;
          }
        } catch (infoErr) {
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[AddMoney] live USDC lookup failed, using static map', infoErr);
          }
        }
        if (!usdcAddr) usdcAddr = await getUsdcAddressForChain(UR_SOURCE_CHAIN_ID);
        if (!usdcAddr) return;
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[AddMoney] reading USDC balance', {
            chain: UR_SOURCE_CHAIN_ID,
            usdc: usdcAddr,
            eoa: eoaAddress,
            embeddedWallets: wallets?.map((w) => w.address) ?? [],
          });
        }
        const bal = await publicClient.readContract({
          address: usdcAddr,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [eoaAddress],
        });
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[AddMoney] USDC balance raw', bal.toString());
        }
        if (!cancelled) setUsdcBalance(bal);
      } catch (err) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[AddMoney] balance read failed', err);
        }
      } finally {
        if (!cancelled) setUsdcBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, eoaAddress, publicClient, wallets, getAccessToken]);

  const usdcBalanceFloat = useMemo(() => {
    if (usdcBalance === null) return null;
    try {
      return Number(formatUnits(usdcBalance, USDC_DECIMALS));
    } catch {
      return null;
    }
  }, [usdcBalance]);

  const amountNum = useMemo(() => {
    const n = Number(amount.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }, [amount]);

  const inputErr = useMemo(() => {
    if (!amount.trim()) return null;
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return t('addMoney.invalidAmount');
    }
    if (amountNum < MIN_USDC) {
      return t('addMoney.belowMin', { min: MIN_USDC });
    }
    if (usdcBalanceFloat !== null && amountNum > usdcBalanceFloat + 1e-9) {
      return t('addMoney.notEnough');
    }
    return null;
  }, [amount, amountNum, usdcBalanceFloat, t]);

  // All-in cost — mirrors WithdrawBottomSheet: for USDC→USD use send−receive
  // (nets network, spread, and any partner fee baked into the credited amount).
  // For other target fiats fall back to UR totalFee.
  const depositTotalFees = useMemo(() => {
    const d = quote?.data;
    if (!d) return null;

    // UR's `outputAmount` is the NET amount received (after all fees) per the
    // official quote spec; `outputAmountBeforeFee` is gross. Use net so the
    // fee row (send − receive) and the "You receive" line stay consistent.
    const receiveNum = parseFloat(d.outputAmount || d.outputAmountBeforeFee || '');
    const totalFeeNum = parseFloat(d.totalFee ?? '');

    if (
      currency.code === 'USD' &&
      Number.isFinite(amountNum) &&
      Number.isFinite(receiveNum) &&
      amountNum > receiveNum + 0.0005
    ) {
      return { value: amountNum - receiveNum, prefix: '$' as const };
    }

    if (Number.isFinite(totalFeeNum) && totalFeeNum > 0) {
      const prefix = currency.code === 'USD' ? ('$' as const) : (`${currency.code} ` as const);
      return { value: totalFeeNum, prefix };
    }

    const networkFeeNum = parseFloat(d.networkFee ?? '');
    if (Number.isFinite(networkFeeNum) && networkFeeNum > 0) {
      const prefix = currency.code === 'USD' ? ('$' as const) : (`${currency.code} ` as const);
      return { value: networkFeeNum, prefix };
    }

    return null;
  }, [quote, amountNum, currency.code]);

  // Credited amount shown on the final confirm popup — must match the review
  // screen's "You receive" (net of total fees), not the raw send amount.
  const confirmReceiveAmount = useMemo(
    () =>
      quote?.data.outputAmount ||
      quote?.data.outputAmountBeforeFee ||
      amount ||
      '0',
    [quote, amount],
  );

  // ─── Debounced quote fetch ─────────────────────────────────────────────
  // We READ `stage` to bail out when the user has committed (signing /
  // submitting / polling / success / error), but we deliberately do NOT
  // put `stage` in the dep array — the effect itself calls setStage(),
  // which would otherwise trigger an infinite refetch loop (each fetch
  // flips stage='quoting'→'review' every 450ms and the CTA visibly
  // blinks because it disables on `stage !== 'review'`).
  const stageRef = useRef(stage);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    const currentStage = stageRef.current;
    if (
      currentStage !== 'input' &&
      currentStage !== 'quoting' &&
      currentStage !== 'review'
    ) {
      return;
    }
    if (!amount.trim() || !Number.isFinite(amountNum) || amountNum < MIN_USDC || inputErr) {
      setQuote(null);
      if (currentStage !== 'input') setStage('input');
      return;
    }
    const handle = setTimeout(async () => {
      const mySeq = ++quoteSeqRef.current;
      setStage('quoting');
      setQuoteError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const resp = await fetchUrDepositQuote(token, {
          source_chain_id: UR_SOURCE_CHAIN_ID,
          source_token: 'USDC',
          source_amount: amount.trim(),
          target_currency: currency.code,
        });
        if (quoteSeqRef.current !== mySeq) return;
        setQuote(resp);
        setStage('review');
      } catch (e: unknown) {
        if (quoteSeqRef.current !== mySeq) return;
        const detail =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
          (e instanceof Error ? e.message : 'Quote failed');
        setQuoteError(String(detail));
        setStage('input');
      }
    }, 450);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, amountNum, currency.code, getAccessToken, inputErr]);

  const notifyIncoming = useCallback(
    async (opts: {
      targetAmount?: string | null;
      sourceTxHash?: string | null;
    }) => {
      const hash =
        (opts.sourceTxHash || txHash || '').trim() || undefined;
      const payload = {
        currency: currency.code,
        amount: pickCreditedAmount(opts.targetAmount, amountNum),
        sourceTxHash: hash,
        sourceChainId: UR_SOURCE_CHAIN_ID,
      };
      if (incomingNotifiedRef.current) {
        // One-time hash backfill when the first notify went out before broadcast
        // returned a hash. Never re-call onSuccess on every poll tick — that
        // retriggers parent refresh loops (bumpSpendableRefresh → re-render →
        // job effect → emitDepositSuccess again → Maximum update depth).
        if (hash && !incomingNotifiedWithHashRef.current) {
          incomingNotifiedWithHashRef.current = true;
          try {
            await onSuccess?.(payload);
          } catch {
            // Backfill tx hash / LZ link on an existing pill.
          }
        }
        return;
      }
      incomingNotifiedRef.current = true;
      if (hash) incomingNotifiedWithHashRef.current = true;
      try {
        await onSuccess?.(payload);
      } catch {
        // Best-effort — parent refresh must never unwind sheet success.
      }
    },
    [onSuccess, currency.code, amountNum, txHash],
  );

  const emitDepositSuccess = useCallback(
    async (updated: UrJobSummary) => {
      if (depositSuccessJobIdRef.current === updated.id) return;
      depositSuccessJobIdRef.current = updated.id;
      setStage('success');
      await notifyIncoming({
        targetAmount: updated.target_amount,
        sourceTxHash: updated.source_tx_hash || txHash,
      });
    },
    [notifyIncoming, txHash],
  );

  const emitDepositSuccessRef = useRef(emitDepositSuccess);
  useEffect(() => {
    emitDepositSuccessRef.current = emitDepositSuccess;
  }, [emitDepositSuccess]);

  // ─── Job polling effect (kicked off by `job`) ──────────────────────────
  useEffect(() => {
    if (!job) return;

    if (isUrDepositUserSuccess(job.status)) {
      void emitDepositSuccessRef.current(job);
      return;
    }
    if (isUrJobTerminal(job.status)) {
      if (job.status === 'failed') {
        setStage('error');
        setErrorMsg(job.error_message || t('addMoney.jobFailed'));
      }
      return;
    }

    const mySeq = ++pollSeqRef.current;
    let attempts = 0;
    let stopped = false;

    const poll = async () => {
      if (stopped || pollSeqRef.current !== mySeq) return;
      attempts += 1;
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const updated = await fetchUrJob(token, job.id);
        if (stopped || pollSeqRef.current !== mySeq) return;
        setJob(updated);
        if (isUrDepositUserSuccess(updated.status)) {
          await emitDepositSuccessRef.current(updated);
          return;
        }
        if (isUrJobTerminal(updated.status)) {
          setStage('error');
          setErrorMsg(
            updated.error_message || t('addMoney.jobFailed'),
          );
          return;
        }
        if (attempts >= JOB_POLL_MAX_ATTEMPTS) {
          // Source tx may still be confirming — bail to background so the
          // sheet never blocks the dashboard for the full LayerZero hop.
          await emitDepositSuccessRef.current(updated);
          return;
        }
        setTimeout(poll, JOB_POLL_INTERVAL_MS);
      } catch {
        // Transient network blip; keep trying until cap.
        if (attempts >= JOB_POLL_MAX_ATTEMPTS) {
          setStage('error');
          setErrorMsg(t('addMoney.pollFailed'));
          return;
        }
        setTimeout(poll, JOB_POLL_INTERVAL_MS);
      }
    };

    const id = setTimeout(poll, JOB_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(id);
    };
  }, [job, getAccessToken, t]);

  // ─── The big "confirm" handler ─────────────────────────────────────────
  const executeDeposit = useCallback(async () => {
    if (!wallet || !eoaAddress) {
      Toast.show({ type: 'error', text1: t('addMoney.noWallet') });
      return;
    }
    if (!quote) {
      Toast.show({ type: 'error', text1: t('addMoney.noQuote') });
      return;
    }
    const { addresses, raw_source_amount } = quote;
    if (
      !addresses.ambire_7702_delegate ||
      !addresses.deposit_contract ||
      !addresses.usdc ||
      !addresses.output_token
    ) {
      Toast.show({
        type: 'error',
        text1: t('addMoney.missingAddresses'),
      });
      return;
    }

    // Tight in-flight guard: block a new deposit only while a prior one's
    // source (Arbitrum) tx is still unconfirmed — that's the window where
    // both batches would sign the same Ambire nonce and the later one would
    // revert. The instant the source receipt lands the nonce bumps and
    // top-ups are safe (we never block for the LayerZero credit tail). A
    // confident "not mined" blocks; an RPC blip falls through to the backend,
    // which enforces the same rule and returns a clean 409.
    for (const dep of inFlightDeposits ?? []) {
      const pendingHash = (dep.sourceTxHash || '').trim() as Hex;
      if (!pendingHash) continue;
      try {
        await publicClient.getTransactionReceipt({ hash: pendingHash });
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) {
          Toast.show({
            type: 'info',
            text1: t('addMoney.depositInFlightTitle'),
            text2: t('addMoney.depositInFlightBody'),
          });
          return;
        }
      }
    }

    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});

    setErrorMsg(null);
    setTxHash(null);

    try {
      const provider = await wallet.getProvider();

      // Ensure provider is on the UR source chain before any signing — the
      // 7702 authorization is chain-bound and the Ambire batch hash includes
      // chainId, so a mismatched provider chain silently produces invalid
      // signatures.
      try {
        const chainIdHex = (await provider.request({
          method: 'eth_chainId',
          params: [],
        })) as string;
        const currentChainId = parseInt(chainIdHex, 16);
        if (currentChainId !== UR_SOURCE_CHAIN_ID) {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: UR_SOURCE_CHAIN_ID_HEX }],
          });
        }
      } catch (chainErr) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[AddMoney] chain switch failed', chainErr);
        }
      }

      const walletClient = createWalletClient({
        account: eoaAddress,
        chain: UR_SOURCE_CHAIN,
        transport: custom(provider),
      });

      // ─── 1. Determine 7702 delegation state ─────────────────────────
      const designatorPrefix = quote.designator_prefix.toLowerCase();
      const code = await publicClient.getCode({ address: eoaAddress });
      const codeHex = (code || '0x').toLowerCase();
      const expectedDesignator =
        designatorPrefix + addresses.ambire_7702_delegate.slice(2).toLowerCase();
      const isDelegated = codeHex === expectedDesignator;
      if (__DEV__) {
        // Auth signing (the bit our useSign7702Authorization refactor touches)
        // ONLY runs when isDelegated === false. If this logs `true`, the tx will
        // skip 7702 auth signing entirely — neither hook nor manual path fires.
        console.log('[AddMoney] isDelegated', isDelegated, 'eoaCode', codeHex);
      }

      // ─── 2. (Conditional) sign 7702 authorization ───────────────────
      let authorization: UrDeposit7702Authorization | undefined;
      if (!isDelegated) {
        setStage('signing-auth');
        // Read the EOA's chain nonce ourselves and pass it explicitly in BOTH
        // paths. If Privy fetches the nonce itself (via its provider on a
        // chain it doesn't natively route) we get a stale-cached `0`. The
        // EIP-7702 EVM validates `auth.nonce == authority.nonce` at inclusion;
        // on mismatch it silently drops the SetCode part and the tx still
        // "succeeds" as a no-op (~51k gas, zero logs, balances unchanged).
        // Explicitly reading removes that foot-gun. See ambire7702.ts /
        // ConvertBottomSheet for the forensic trail (tx 0x9b8ec8…0026).
        const eoaNonce = await publicClient.getTransactionCount({
          address: eoaAddress,
        });

        if (USE_PRIVY_7702_HOOK) {
          // PRIMARY — Privy useSign7702Authorization (Expo SDK ≥ 0.68).
          // `options.address` pins signing to the URID-owning EOA (NOT
          // wallets[0]). We still pass the explicit nonce (see above). The
          // hook returns a viem SignedAuthorization {address, chainId, nonce,
          // r, s, yParity} — already the canonical recovery byte, so no
          // normalise step is needed here.
          const signed = await signAuthorization(
            {
              contractAddress: addresses.ambire_7702_delegate as Hex,
              chainId: UR_SOURCE_CHAIN_ID,
              nonce: eoaNonce,
            },
            { address: eoaAddress },
          );
          // viem types `yParity` as optional, but a SIGNED authorization always
          // carries it. Fail loud instead of defaulting to a possibly-inverted
          // 0 (the exact silent-SetCode-drop bug the manual path's normalise
          // step guards against) — flip USE_PRIVY_7702_HOOK to false if seen.
          if (signed.yParity == null) {
            throw new Error('Privy 7702 authorization returned no yParity');
          }
          authorization = {
            chain_id: Number(signed.chainId),
            address: addresses.ambire_7702_delegate,
            nonce: Number(signed.nonce),
            y_parity: signed.yParity,
            r: signed.r,
            s: signed.s,
          };
          if (__DEV__) {
            console.log('[AddMoney] signed 7702 authorization (privy hook)', authorization);
          }
        } else {
          // BACKUP — manual viem prepareAuthorization + Privy secp256k1_sign,
          // the proven path used before the hook existed. Kept verbatim; flip
          // USE_PRIVY_7702_HOOK to false to re-enable. `normaliseAuth7702Signature`
          // recovers locally and refuses a mismatched yParity (Privy's
          // secp256k1_sign returns {0,1} on Arb Sepolia vs {27,28} elsewhere —
          // a naive v%2 silently inverts yParity and the EVM drops SetCode).
          const authPayload = await prepareAuthorization(walletClient, {
            address: addresses.ambire_7702_delegate as Hex,
            nonce: eoaNonce,
          });
          const authHash = hashAuthorization(authPayload);
          const authSigHex = (await provider.request({
            method: 'secp256k1_sign',
            params: [authHash],
          })) as Hex;
          const { r, s, yParity } = await normaliseAuth7702Signature({
            authHash,
            signature: authSigHex,
            authority: eoaAddress,
          });
          authorization = {
            chain_id: Number(authPayload.chainId),
            address: addresses.ambire_7702_delegate,
            nonce: Number(authPayload.nonce),
            y_parity: yParity,
            r,
            s,
          };
          if (__DEV__) {
            console.log('[AddMoney] signed 7702 authorization (manual fallback)', authorization);
          }
        }
      }

      // ─── 3. Build calls batch ───────────────────────────────────────
      // LayerZero cross-chain fee: must be forwarded as `value` on the
      // deposit call AND on the outer relayer tx. The relayer sponsors
      // both gas AND this native-token fee — the user pays in USDC only
      // (UR deducts feeAmountViaUsdc from outputAmount inside the bridge).
      const lzNativeFeeWei = (() => {
        const raw = quote.data.feeAmountViaNativeToken;
        if (!raw) return 0n;
        try {
          return BigInt(raw);
        } catch {
          return 0n;
        }
      })();

      const amountRaw = BigInt(raw_source_amount);
      const approveData = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [addresses.deposit_contract as Hex, amountRaw],
      });
      const depositData = encodeFunctionData({
        abi: FIAT24_DEPOSIT_VIA_USDC_ABI,
        functionName: 'depositTokenViaUsdc',
        args: [
          addresses.usdc as Hex,
          addresses.output_token as Hex,
          amountRaw,
          0n, // amountOutMinimum — for USDC input, no swap, no slippage risk
        ],
      });

      const calls: UrDeposit7702Call[] = [
        {
          to: addresses.usdc,
          value: '0',
          data: approveData,
        },
        {
          to: addresses.deposit_contract,
          value: lzNativeFeeWei.toString(),
          data: depositData,
        },
      ];

      // ─── 4. Sign Ambire batch ───────────────────────────────────────
      setStage('signing-batch');

      // Read current Ambire nonce. If the EOA isn't delegated yet OR has
      // never executed, the call returns 0 (or reverts which we treat as 0).
      let ambireNonce = 0n;
      try {
        ambireNonce = await publicClient.readContract({
          address: eoaAddress,
          abi: AMBIRE_NONCE_ABI,
          functionName: 'nonce',
        });
      } catch {
        ambireNonce = 0n;
      }

      const batchHash = computeAmbireBatchHash({
        eoa: eoaAddress,
        chainId: BigInt(UR_SOURCE_CHAIN_ID),
        nonce: ambireNonce,
        calls,
      });
      // Raw ECDSA sign: no EIP-191 wrap, no mode byte. The deployed
      // AmbireAccount7702 already did the EIP-712 wrap inside
      // computeAmbireBatchHash. Trailing v ∈ {27,28} (which secp256k1_sign
      // returns natively) is ≥ LastUnused (6), so the contract coerces
      // to SignatureMode.Unprotected and ecrecovers our wrapped hash
      // directly — recovering to the EOA.
      const batchSigRaw = (await provider.request({
        method: 'secp256k1_sign',
        params: [batchHash],
      })) as Hex;
      const batchSignature = normaliseSig65(batchSigRaw);

      // ─── 5. Submit to backend ───────────────────────────────────────
      setStage('submitting');
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const idempotencyKey = `addmoney-${eoaAddress.toLowerCase()}-${quote.data.quoteId}-${Date.now()}`;

      const resp = await executeUrDeposit7702(token, {
        idempotency_key: idempotencyKey,
        source_chain_id: UR_SOURCE_CHAIN_ID,
        source_token: 'USDC',
        source_amount: raw_source_amount,
        target_currency: currency.code,
        // Direct `depositTokenViaUsdc` (our Path-F) credits `outputAmountBeforeFee`
        // — UR's `outputAmount` further nets the aggregator-only `feeAmountViaUsdc`
        // which this path never charges. Verified on-chain (5 USDC -> 4.97 USD24,
        // matching `outputAmountBeforeFee`). Using it keeps the success card,
        // pill threshold and tx amount aligned with what actually lands.
        target_amount: quote.data.outputAmountBeforeFee || quote.data.outputAmount,
        quote_id: quote.data.quoteId,
        user_address: eoaAddress,
        calls,
        batch_signature: batchSignature,
        authorization,
      });

      if (resp.dispatch_error) {
        setStage('error');
        setErrorMsg(resp.dispatch_error);
        return;
      }

      setJob(resp.job);
      setTxHash(resp.tx_hash || null);
      setStage('polling');
      // Surface the incoming pill + LZ link as soon as the source tx is
      // broadcast — do not wait for job poll / LayerZero (tx list stays
      // Pending separately until credit lands).
      await notifyIncoming({
        targetAmount:
          resp.job?.target_amount ??
          quote.data.outputAmountBeforeFee ??
          quote.data.outputAmount,
        sourceTxHash: resp.tx_hash || resp.job?.source_tx_hash,
      });
    } catch (e: unknown) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        (e instanceof Error ? e.message : 'Deposit failed');
      setStage('error');
      setErrorMsg(String(detail));
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[AddMoney] handleConfirm error', e);
      }
    }
  }, [wallet, eoaAddress, quote, getAccessToken, currency.code, publicClient, t, notifyIncoming, amountNum, inFlightDeposits]);

  const onPressConfirm = useCallback(() => {
    setConfirmOpen(true);
  }, []);

  const handleConfirmModal = useCallback(() => {
    void executeDeposit();
    setConfirmOpen(false);
  }, [executeDeposit]);

  const setMax = useCallback(() => {
    if (usdcBalanceFloat === null) return;
    const max = Math.floor(usdcBalanceFloat * 100) / 100;
    setAmount(max.toFixed(2));
  }, [usdcBalanceFloat]);

  const sourceNetworkLabel =
    UR_SOURCE_CHAIN_ID === 42161
      ? t('addMoney.arbitrum')
      : t('addMoney.arbitrumSepolia');

  const copyDepositAddress = useCallback(async () => {
    if (!eoaAddress) return;
    await Clipboard.setStringAsync(eoaAddress);
    setAddressCopied(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = setTimeout(() => {
      setAddressCopied(false);
      copyFeedbackTimerRef.current = null;
    }, 2000);
  }, [eoaAddress]);

  const closeReceiveModal = useCallback(() => {
    setShowDepositQr(false);
    setAddressCopied(false);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    },
    [],
  );

  // ─── Render ────────────────────────────────────────────────────────────
  if (!mounted) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={tryDismiss}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={tryDismiss} />
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
          <View {...panResponder.panHandlers} style={styles.handleArea}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>{t('addMoney.title')}</Text>
            {canDismiss ? (
              <TouchableOpacity onPress={tryDismiss} hitSlop={12}>
                <Ionicons name="close" size={22} color={colors.text.secondary} />
              </TouchableOpacity>
            ) : null}
          </View>

          <KeyboardAwareScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formScrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            bottomOffset={36}
            extraKeyboardSpace={Platform.OS === 'ios' ? 20 : 24}
          >
              {stage === 'success' ? (
                <SuccessBody
                  // Show the actual credited amount. For USDC -> USD24 the
                  // on-chain credit is exactly 1:1; for USDC -> EUR24 /
                  // CHF24 it goes through Fiat24's `getExchangeRate ×
                  // getSpread` math (mirrored server-side in
                  // `_effective_deposit_target_amount`). Either way the
                  // job row's `target_amount` is the authoritative figure
                  // — we fall back to the input amount only if the row
                  // hasn't been populated yet (rare, pre-relayer-broadcast).
                  amount={pickCreditedAmount(job?.target_amount, amountNum).toFixed(2)}
                  currency={currency.code}
                  txHash={txHash}
                  onDone={tryDismiss}
                />
              ) : stage === 'error' ? (
                <ErrorBody
                  message={errorMsg || t('addMoney.unknownError')}
                  onRetry={() => {
                    setStage('input');
                    setErrorMsg(null);
                  }}
                  onClose={tryDismiss}
                />
              ) : stage === 'submitting' || stage === 'polling' ? (
                        <ProcessingBody
                          label={
                            stage === 'submitting'
                              ? t('addMoney.submitting')
                              : t('addMoney.polling')
                          }
                          txHash={txHash}
                          sourceChainId={UR_SOURCE_CHAIN_ID}
                        />
                      ) : stage === 'signing-auth' || stage === 'signing-batch' ? (
                        <ProcessingBody
                          label={
                            stage === 'signing-auth'
                              ? t('addMoney.signingAuth')
                              : t('addMoney.signingBatch')
                          }
                        />
                      ) : (
                        <>
                          {/* Source row */}
                          <View style={styles.section}>
                            <Text style={styles.sectionLabel}>{t('addMoney.from')}</Text>
                            <View style={styles.sourceCard}>
                              <View style={styles.sourceLeft}>
                                <Image source={USDC_ICON} style={styles.usdcIcon} />
                                <View style={{ marginLeft: 12 }}>
                                  <Text style={styles.sourceTitle}>USDC</Text>
                                  <Text style={styles.sourceSub}>{sourceNetworkLabel}</Text>
                                </View>
                              </View>
                              {eoaAddress ? (
                                <TouchableOpacity
                                  style={styles.availableTap}
                                  onPress={() => {
                                    setAddressCopied(false);
                                    setShowDepositQr(true);
                                  }}
                                  activeOpacity={0.75}
                                  accessibilityRole="button"
                                  accessibilityLabel={t('addMoney.receiveUsdcA11y')}
                                >
                                  <View style={styles.availableTapInner}>
                                    <View style={styles.receivePlusBadge}>
                                      <Ionicons name="add" size={14} color={colors.accent.gold} />
                                    </View>
                                    <View style={styles.availableTextCol}>
                                      <Text style={styles.balanceLabel}>
                                        {t('addMoney.available')}
                                      </Text>
                                      <View style={styles.balanceSlot}>
                                        {usdcBalanceLoading ? (
                                          <BouncingDots
                                            dotSize={4}
                                            color={colors.text.primary}
                                            pulse
                                          />
                                        ) : (
                                          <Text
                                            style={styles.balanceValue}
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                            minimumFontScale={0.55}
                                          >
                                            {usdcBalanceFloat === null
                                              ? '—'
                                              : usdcBalanceFloat.toLocaleString('en-US', {
                                                  minimumFractionDigits: 2,
                                                  maximumFractionDigits: 2,
                                                })}
                                          </Text>
                                        )}
                                      </View>
                                    </View>
                                  </View>
                                </TouchableOpacity>
                              ) : (
                                <View style={styles.availableTextCol}>
                                  <Text style={styles.balanceLabel}>
                                    {t('addMoney.available')}
                                  </Text>
                                  <View style={styles.balanceSlot}>
                                    {usdcBalanceLoading ? (
                                      <BouncingDots
                                        dotSize={4}
                                        color={colors.text.primary}
                                        pulse
                                      />
                                    ) : (
                                      <Text
                                        style={styles.balanceValue}
                                        numberOfLines={1}
                                        adjustsFontSizeToFit
                                        minimumFontScale={0.55}
                                      >
                                        {usdcBalanceFloat === null
                                          ? '—'
                                          : usdcBalanceFloat.toLocaleString('en-US', {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 2,
                                            })}
                                      </Text>
                                    )}
                                  </View>
                                </View>
                              )}
                            </View>
                          </View>

                          {/* Amount input */}
                          <View style={styles.section}>
                            <Text style={styles.sectionLabel}>{t('addMoney.amount')}</Text>
                            <View style={styles.amountRow}>
                              <TextInput
                                value={amount}
                                onChangeText={setAmount}
                                placeholder="0.00"
                                placeholderTextColor={colors.text.tertiary}
                                keyboardType="decimal-pad"
                                style={styles.amountInput}
                                editable={stage === 'input' || stage === 'quoting' || stage === 'review'}
                              />
                              <Text style={styles.amountSuffix}>USDC</Text>
                              <TouchableOpacity onPress={setMax} style={styles.maxButton}>
                                <Text style={styles.maxText}>{t('addMoney.max')}</Text>
                              </TouchableOpacity>
                            </View>
                            {inputErr ? (
                              <Text style={styles.errorText}>{inputErr}</Text>
                            ) : null}
                            {quoteError ? (
                              <Text style={styles.errorText}>{quoteError}</Text>
                            ) : null}
                          </View>

                          {/* Target currency */}
                          <View style={styles.section}>
                            <Text style={styles.sectionLabel}>{t('addMoney.to')}</Text>
                            <TouchableOpacity
                              style={styles.currencyRow}
                              onPress={() => setShowCurrencyPicker(true)}
                              activeOpacity={0.8}
                            >
                              <CircleCurrencyFlag currencyCode={currency.code} size={28} />
                              <View style={{ flex: 1, marginLeft: 12 }}>
                                <Text style={styles.currencyTitle}>{currency.code}</Text>
                                <Text style={styles.currencySub}>{currency.label}</Text>
                              </View>
                              <Ionicons
                                name="chevron-down"
                                size={18}
                                color={colors.text.tertiary}
                              />
                            </TouchableOpacity>
                          </View>

                          {/* Quote summary — credited receive + all-in total fees. */}
                          {quote ? (
                            <View style={styles.section}>
                              <View style={styles.quoteCard}>
                                <QuoteRow
                                  label={t('addMoney.youSend')}
                                  value={`${amount || '0'} USDC`}
                                />
                                {depositTotalFees ? (
                                  <QuoteRow
                                    label={t('withdrawSheet.reviewTotalFee')}
                                    value={`${depositTotalFees.prefix}${formatQuoteAmount(String(depositTotalFees.value))}`}
                                    muted
                                  />
                                ) : null}
                                <View style={styles.quoteDivider} />
                                <QuoteRow
                                  label={t('addMoney.youReceive')}
                                  value={`${
                                    quote.data.outputAmount ||
                                    quote.data.outputAmountBeforeFee ||
                                    amount ||
                                    '0'
                                  } ${currency.code}`}
                                  bold
                                />
                              </View>
                            </View>
                          ) : stage === 'quoting' ? (
                            <View style={styles.section}>
                              <View style={styles.quoteCard}>
                                <View style={styles.quoteLoadingRow}>
                                  <BouncingDots
                                    dotSize={5}
                                    color={colors.text.tertiary}
                                    pulse
                                  />
                                  <Text style={styles.quoteLoadingText}>
                                    {t('addMoney.quoting')}
                                  </Text>
                                </View>
                              </View>
                            </View>
                          ) : null}

                          {/* CTA */}
                          <TouchableOpacity
                            disabled={!quote || !!inputErr || stage !== 'review'}
                            onPress={onPressConfirm}
                            activeOpacity={0.85}
                            style={styles.ctaWrap}
                          >
                            <LinearGradient
                              colors={
                                !quote || !!inputErr || stage !== 'review'
                                  ? [colors.background.tertiary, colors.background.tertiary]
                                  : [colors.accent.gold, colors.accent.purple]
                              }
                              start={{ x: 0, y: 0 }}
                              end={{ x: 1, y: 0 }}
                              style={styles.cta}
                            >
                              <Text
                                style={[
                                  styles.ctaText,
                                  (!quote || !!inputErr || stage !== 'review') && {
                                    color: colors.text.tertiary,
                                  },
                                ]}
                              >
                                {t('addMoney.confirm')}
                              </Text>
                            </LinearGradient>
                          </TouchableOpacity>

                          <Text style={styles.disclaimer}>{depositDisclaimer}</Text>
                        </>
                      )}
          </KeyboardAwareScrollView>
        </Animated.View>

        {showCurrencyPicker ? (
          <DepositCurrencyPicker
            currencies={supportedCurrencies}
            balanceByCode={depositPickerBalanceByCode}
            onPick={onPickCurrency}
            current={currency}
            onCancel={() => setShowCurrencyPicker(false)}
          />
        ) : null}

        <BankConfirmModal
          visible={confirmOpen}
          title={t('addMoney.confirmTitle', 'Confirm deposit')}
          message={t('addMoney.confirmMessage', {
            send: amount || '0',
            receive: confirmReceiveAmount,
            currency: currency.code,
            defaultValue: `Deposit ${amount || '0'} USDC to receive ${confirmReceiveAmount} ${currency.code}?`,
          })}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleConfirmModal}
        />

        <Modal
          transparent
          visible={showDepositQr}
          animationType="fade"
          onRequestClose={closeReceiveModal}
        >
          <Pressable style={styles.qrBackdrop} onPress={closeReceiveModal}>
            <Pressable style={styles.qrCard} onPress={() => {}}>
              <TouchableOpacity
                onPress={closeReceiveModal}
                style={styles.qrCloseBtn}
                hitSlop={12}
              >
                <Ionicons name="close" size={22} color={colors.text.secondary} />
              </TouchableOpacity>
              <Text style={styles.qrTitle}>{t('addMoney.receiveUsdcTitle')}</Text>
              <Text style={styles.qrSubtitle}>
                {t('addMoney.receiveUsdcHint', { network: sourceNetworkLabel })}
              </Text>
              {eoaAddress ? (
                <>
                  <TouchableOpacity
                    style={styles.qrAddressPill}
                    onPress={copyDepositAddress}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.copyAddress')}
                  >
                    <Image
                      source={ARBITRUM_PILL_ICON}
                      style={styles.depositArbIcon}
                      resizeMode="contain"
                    />
                    <Text
                      style={styles.qrAddressText}
                      numberOfLines={1}
                      accessibilityLabel={eoaAddress}
                    >
                      {formatWalletAddressDisplay(eoaAddress)}
                    </Text>
                    {addressCopied ? (
                      <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
                    ) : (
                      <Ionicons name="copy-outline" size={16} color={colors.text.tertiary} />
                    )}
                  </TouchableOpacity>
                  <View style={styles.qrContainer}>
                    <QRCodeStyled
                      data={eoaAddress}
                      style={styles.qrCode}
                      pieceSize={6}
                      color="#000000"
                      pieceCornerType="rounded"
                      pieceBorderRadius={2}
                      isPiecesGlued
                      padding={16}
                      outerEyesOptions={{
                        topLeft: { borderRadius: 8 },
                        topRight: { borderRadius: 8 },
                        bottomLeft: { borderRadius: 8 },
                      }}
                      innerEyesOptions={{
                        borderRadius: 4,
                      }}
                    />
                  </View>
                </>
              ) : null}
              <Text style={styles.qrNetworkHint}>{sourceNetworkLabel}</Text>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Sub-components
// --------------------------------------------------------------------------- //

function formatQuoteAmount(raw: string | undefined): string {
  if (!raw) return '0.00';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function QuoteRow({
  label,
  value,
  muted,
  bold,
}: {
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
}) {
  return (
    <View style={styles.quoteRow}>
      <Text style={[styles.quoteLabel, muted && { color: colors.text.tertiary }]}>
        {label}
      </Text>
      <Text style={[styles.quoteValue, bold && styles.quoteValueBold]}>{value}</Text>
    </View>
  );
}

function ProcessingBody({
  label,
  txHash,
  sourceChainId,
}: {
  label: string;
  txHash?: string | null;
  sourceChainId?: number;
}) {
  return (
    <View style={styles.processingBlock}>
      <BouncingDots color={colors.text.primary} pulse />
      <Text style={styles.processingText}>{label}</Text>
      {txHash ? (
        <TouchableOpacity
          onPress={() => openTxExplorer(txHash, sourceChainId)}
          style={styles.txHashChip}
        >
          <Text style={styles.txHashChipText} numberOfLines={1}>
            {`${txHash.slice(0, 10)}…${txHash.slice(-8)}`}
          </Text>
          <Ionicons name="open-outline" size={14} color={colors.text.secondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function SuccessBody({
  amount,
  currency,
  txHash,
  onDone,
}: {
  amount: string;
  currency: string;
  txHash: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.processingBlock}>
      <View style={styles.successCircle}>
        <Ionicons name="checkmark" size={32} color={colors.background.primary} />
      </View>
      <Text style={styles.successTitle}>{t('addMoney.successTitle')}</Text>
      <Text style={styles.successAmount}>
        +{amount} {currency}
      </Text>
      {txHash ? (
        <TouchableOpacity
          onPress={() => openTxExplorer(txHash)}
          style={styles.txHashChip}
        >
          <Text style={styles.txHashChipText} numberOfLines={1}>
            {`${txHash.slice(0, 10)}…${txHash.slice(-8)}`}
          </Text>
          <Ionicons name="open-outline" size={14} color={colors.text.secondary} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={onDone} activeOpacity={0.85} style={styles.doneBtn}>
        <Text style={styles.doneBtnText}>{t('addMoney.successDone')}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ErrorBody({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.processingBlock}>
      <View style={styles.errorCircle}>
        <Ionicons name="alert" size={28} color={colors.status.warning} />
      </View>
      <Text style={styles.errorTitle}>{t('addMoney.errorTitle')}</Text>
      <Text style={styles.errorBody}>{message}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity onPress={onClose} style={styles.errorClose}>
          <Text style={styles.errorCloseText}>{t('addMoney.errorClose')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onRetry} style={styles.errorRetry}>
          <Text style={styles.errorRetryText}>{t('addMoney.errorRetry')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function DepositCurrencyPicker({
  onCancel,
  onPick,
  current,
  currencies,
  balanceByCode,
}: {
  onCancel: () => void;
  onPick: (c: Currency) => void;
  current: Currency;
  currencies: Currency[];
  balanceByCode: Record<
    string,
    { currency: string; amountStr: string; balanceLoading?: boolean }
  >;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'android' ? 32 : 20);
  const targetsLoading = currencies.some((c) => c.status === 'loading');

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.7)' }]}
        onPress={onCancel}
      />
      <View style={[styles.pickerSheet, { paddingBottom: bottomPad }]}>
        <View style={styles.pickerHandle} />
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>{t('addMoney.pickCurrency')}</Text>
          <TouchableOpacity onPress={onCancel} hitSlop={12} accessibilityRole="button">
            <Ionicons name="close" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        {targetsLoading ? (
          <Text style={styles.pickerLoadingHint}>{t('addMoney.targetsLoading')}</Text>
        ) : null}
        <ScrollView
          style={[styles.pickerList, { minHeight: DEPOSIT_PICKER_LIST_MIN_HEIGHT }]}
          contentContainerStyle={styles.pickerListContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {currencies.map((c) => {
            const isLoading = c.status === 'loading';
            const isAvailable = c.status === 'available';
            const balance = balanceByCode[c.code];
            return (
              <TouchableOpacity
                key={c.code}
                disabled={!isAvailable}
                onPress={() => onPick(c)}
                style={[
                  styles.pickerRow,
                  !isAvailable && !isLoading && styles.pickerRowDisabled,
                  isLoading && styles.pickerRowLoading,
                  c.code === current.code && isAvailable && styles.pickerRowActive,
                ]}
              >
                <CircleCurrencyFlag currencyCode={c.code} size={22} />
                <View style={styles.pickerRowMain}>
                  <Text style={styles.pickerRowCode}>{c.code}</Text>
                  <Text style={styles.pickerRowLabel} numberOfLines={1}>
                    {c.label}
                  </Text>
                </View>
                {isLoading ? (
                  <BouncingDots dotSize={4} color={colors.text.tertiary} pulse />
                ) : (
                  <View style={styles.pickerRowRight}>
                    {balance?.balanceLoading ? (
                      <BouncingDots dotSize={4} color={colors.text.tertiary} pulse />
                    ) : (
                      <Text style={styles.pickerBalance} numberOfLines={1}>
                        {balance?.amountStr ?? '0.00'} {c.code}
                      </Text>
                    )}
                    {!isAvailable ? (
                      <Text style={styles.comingSoon}>{t('addMoney.soon')}</Text>
                    ) : c.code === current.code ? (
                      <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
                    ) : null}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

// NOTE: `computeAmbireBatchHash`, `splitSignature`, `normaliseSig65`, and
// `AMBIRE_NONCE_ABI` were moved to `src/lib/ambire7702.ts` so the Convert
// (FX) flow on Mantle Sepolia can reuse the exact same Ambire EIP-712
// derivation. Do NOT inline that logic back into a single sheet — drift
// produces invalid signatures that ecrecover to random addresses, a class
// of bug we never want to debug twice.

// FALLBACK USDC addresses per chain. The authoritative token is whatever the
// deposit gateway's `usdc()` returns LIVE — fetched from the backend
// `/ur/deposit/7702/info` endpoint (and used by the deposit quote). UR
// flip-flops `usdc()` on Arb Sepolia between their test USDC (0x9972A35d…) and
// Circle's (0x75faf114…), so a hardcoded value here can silently desync from
// the token the deposit actually pulls (mismatch => `transferFrom`/swap revert
// with an EMPTY reason). This map is consulted ONLY when the live lookup fails.
const USDC_ADDRESSES: Record<number, Hex> = {
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
};

async function getUsdcAddressForChain(chainId: number): Promise<Hex | null> {
  return USDC_ADDRESSES[chainId] ?? null;
}

function openTxExplorer(txHash: string, chainId: number = UR_SOURCE_CHAIN_ID) {
  const url = txExplorerUrl(txHash, chainId);
  if (url) void openHttpsUrl(url).catch(() => {});
}

// --------------------------------------------------------------------------- //
// Styles
// --------------------------------------------------------------------------- //

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
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
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  pickerList: {
    flexGrow: 0,
  },
  pickerListContent: {
    gap: 8,
    paddingBottom: 4,
  },
  pickerHandle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheet: {
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 0,
    overflow: 'hidden',
    width: '100%',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border.primary,
  },
  formScroll: {
    flexGrow: 0,
  },
  formScrollContent: {
    flexGrow: 1,
    paddingBottom: 4,
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
  sourceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 14,
    padding: 14,
  },
  sourceLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  usdcIcon: { width: 36, height: 36, borderRadius: 18 },
  availableTap: {
    paddingLeft: 12,
    marginLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.border.primary,
    flexShrink: 1,
    minWidth: 0,
  },
  availableTapInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  availableTextCol: {
    alignItems: 'flex-end',
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 132,
  },
  receivePlusBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: `${colors.accent.gold}20`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  depositArbIcon: { width: 16, height: 16, flexShrink: 0 },
  qrAddressPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: `${colors.accent.gold}15`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}35`,
  },
  qrAddressText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.accent.gold,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  qrBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  qrCard: {
    backgroundColor: colors.background.card,
    borderRadius: 20,
    paddingTop: 44,
    paddingBottom: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  qrCloseBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
  },
  qrTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 6,
  },
  qrSubtitle: {
    fontSize: 13,
    color: colors.text.tertiary,
    textAlign: 'center',
    marginBottom: 16,
  },
  qrContainer: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 8,
    marginBottom: 12,
  },
  qrCode: { width: 180, height: 180 },
  qrNetworkHint: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  sourceTitle: { fontSize: 15, fontWeight: '800', color: colors.text.primary },
  sourceSub: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
  balanceLabel: { fontSize: 11, color: colors.text.tertiary, fontWeight: '600' },
  balanceSlot: {
    minHeight: 20,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  balanceValue: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
    alignSelf: 'stretch',
    textAlign: 'right',
    width: '100%',
  },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  amountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    color: colors.text.primary,
  },
  amountSuffix: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.secondary,
    marginRight: 10,
  },
  maxButton: {
    backgroundColor: colors.background.elevated,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  maxText: { fontSize: 11, fontWeight: '900', color: colors.accent.gold },

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

  quoteCard: {
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 14,
    padding: 14,
  },
  quoteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  quoteLabel: { fontSize: 13, color: colors.text.secondary },
  quoteValue: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  quoteValueBold: { fontSize: 16, fontWeight: '900', color: colors.accent.gold },
  quoteDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.primary,
    marginVertical: 6,
  },
  quoteFootnote: {
    marginTop: 10,
    fontSize: 11,
    color: colors.text.tertiary,
    textAlign: 'center',
  },
  quoteLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  quoteLoadingText: {
    fontSize: 13,
    color: colors.text.secondary,
  },

  errorText: {
    marginTop: 8,
    fontSize: 12,
    color: colors.status.warning,
    fontWeight: '600',
  },

  ctaWrap: {
    marginTop: 4,
    borderRadius: 14,
    overflow: 'hidden',
  },
  cta: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.background.primary,
    letterSpacing: 0.3,
  },
  disclaimer: {
    marginTop: 14,
    fontSize: 11,
    color: colors.text.tertiary,
    textAlign: 'center',
  },

  processingBlock: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 12,
    gap: 14,
  },
  processingText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
  },
  txHashChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.background.primary,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  txHashChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.secondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  successCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
  },
  successAmount: {
    fontSize: 26,
    fontWeight: '900',
    color: colors.accent.gold,
  },
  doneBtn: {
    marginTop: 12,
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 12,
  },
  doneBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
  },

  errorCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: `${colors.status.warning}22`,
    borderWidth: 1.5,
    borderColor: `${colors.status.warning}55`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.text.primary,
  },
  errorBody: {
    fontSize: 13,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  errorClose: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  errorCloseText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text.primary,
  },
  errorRetry: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
    backgroundColor: colors.accent.gold,
  },
  errorRetryText: {
    fontSize: 13,
    fontWeight: '900',
    color: colors.background.primary,
  },

  pickerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.text.primary,
  },
  pickerLoadingHint: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '600',
    marginBottom: 12,
    paddingHorizontal: 2,
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
  pickerRowDisabled: {
    opacity: 0.45,
  },
  pickerRowActive: {
    borderColor: colors.accent.gold,
  },
  pickerRowLoading: {
    opacity: 0.85,
  },
  comingSoon: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text.tertiary,
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
});
