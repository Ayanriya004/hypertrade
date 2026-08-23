/**
 * SendBottomSheet — cash pay-out (URID fiat -> external bank), gasless EIP-2612.
 *
 * ARCHITECTURE (load-bearing — read before editing)
 * =================================================
 * External Wallet Access §6 "Cash pay-out". Same gasless permit machinery as
 * WithdrawBottomSheet (reuses buildFullAuth + signOnrampPermit), but the
 * destination is a bank account instead of USDC:
 *
 *   input      → amount + source fiat currency (validated vs balance + min)
 *   recipient  → pick a saved contact OR add a new IBAN recipient
 *   verifying  → sign Full-Auth (personal_sign, one prompt, cached) +
 *                POST /ur/payout/verify-{contact,reference}
 *                -> {contactId, purposeId, refId}; then /ur/payout/permit-info
 *                -> EIP-2612 permit scaffold (token/spender/value/domain)
 *   review     → amount, fee, recipient; user taps Send
 *   signing    → sign EIP-2612 permit (eth_signTypedData_v4) over the fiat token
 *   submitting → POST /ur/payout/execute -> UR /api/v1/payout-with-permit
 *   confirming → poll /ur/jobs/:id until terminal
 *   success / error
 *
 * Signing helpers live in `lib/urOnrampAuth.ts`. API client in `lib/urApi.ts`.
 *
 * TESTNET BLOCKERS: bank payouts (wire to external IBAN) are often not
 * executable on Mantle Sepolia even when verify-* succeeds — UR may return
 * retCode=10000 on payout-with-permit. Needs Live KYC + mainnet banking
 * rails for a real end-to-end test. Also: rolling 30-day CHF limit headroom.
 *
 * PAYOUT SOURCE CURRENCIES: only those returned by `/ur/payout/config`
 * (UR `/banks/payout/fees` — typically EUR/CHF/USD/CNH). JPY/SGD/HKD balances
 * are IBAN/deposit currencies, not bank-payout debit currencies.
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
  FlatList,
  Pressable,
  useWindowDimensions,
  KeyboardAvoidingView,
  Dimensions,
  ScrollView,
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
import { getMantleChain, getDefaultMantleChainId, resolveMantleChainId } from '../../lib/mantleFiatBalance';
import { useAuth } from '../../providers/AuthContext';
import {
  fetchUrPayoutConfig,
  fetchUrPayoutBanks,
  fetchUrPayoutContacts,
  fetchUrBankByIban,
  fetchUrCountryCities,
  fetchUrPaymentPurposes,
  dedupeUrCities,
  extractUrPayoutRefParams,
  formatIbanForUrWire,
  findUrCountryCity,
  isUrCitySupported,
  isUrZipValid,
  getUrPayoutCountryMeta,
  resolveUrPayoutAccountMode,
  type UrCountryCity,
  type UrPayoutAccountMode,
  pickIbanPlaceholder,
  verifyUrPayoutContact,
  verifyUrPayoutReference,
  fetchUrPayoutPermitInfo,
  executeUrPayout,
  fetchUrJob,
  isUrJobTerminal,
  buildUrPayoutMetadata,
  getUrPayoutContactBankName,
  normalizeIbanAccount,
  isIbanStructurallyComplete,
  type UrPayoutCurrencyConfig,
  type UrPaymentPurpose,
  type UrPayoutContact,
  type UrPayoutMetadata,
  type UrPayoutRefParams,
  type UrPayoutPermit,
  type UrExtAuth,
  type CashAccountRow,
  type UrBankCountry,
  type UrBankByIban,
  buildPayoutCurrencyOptions,
  defaultFromCurrency,
} from '../../lib/urApi';
import { buildFullAuth, signOnrampPermit } from '../../lib/urOnrampAuth';
import { BankConfirmModal } from './BankConfirmModal';
import { GRADIENT_BTN_SPINNER_BUSY, gradientConfirmTextBusy } from './bankSheetUi';
import { BouncingDots } from '../BouncingDots';
import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import { useUrTransferLimit } from '../../hooks/useUrTransferLimit';
import { SpendableBalanceLine } from './SpendableBalanceLine';
import { CircleCurrencyFlag } from './CircleCountryFlag';

// ─────────────────────────────────────────────────────────────────────────── //
// Constants
// ─────────────────────────────────────────────────────────────────────────── //

const SHEET_TRAVEL = 800;
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SEND_PICKER_LIST_MIN_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);
const CONFIRM_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;
const CONFIRM_GRADIENT_DISABLED = [colors.background.tertiary, colors.background.tertiary] as const;

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
  | 'recipient'
  | 'verifying'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'error';

/** The recipient + ref params resolved before we can submit. */
interface ResolvedRecipient {
  contactId: string;
  purposeId: string;
  refId: string;
  label: string;
  metadata: UrPayoutMetadata;
}

export interface SendBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  cashRows: CashAccountRow[];
  /** Rolling-30-day transfer limit (CHF, 2dp) for a pre-flight block. */
  usedLimit?: number;
  clientLimit?: number;
  /** USD-equivalent rates (ISO → USD24/unit) to size the amount in CHF. */
  usdRates?: Record<string, number>;
  onSuccess?: () => Promise<void> | void;
}

export function SendBottomSheet({
  visible,
  onClose,
  cashRows,
  usedLimit,
  clientLimit,
  usdRates,
  onSuccess,
}: SendBottomSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.min(windowHeight * 0.88, windowHeight - insets.top - 12);
  const { getAccessToken, walletAddress } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();

  // Resolve the wallet matching the URID-owning EOA (NOT wallets[0] — see
  // ConvertBottomSheet for the rationale).
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

  // Per-currency fee + minimum payout (smallest units, 2dp).
  const [config, setConfig] = useState<UrPayoutCurrencyConfig[] | null>(null);
  const [mantleChainId, setMantleChainId] = useState<number>(getDefaultMantleChainId());
  const [purposes, setPurposes] = useState<UrPaymentPurpose[]>([]);
  const [payoutCountries, setPayoutCountries] = useState<UrBankCountry[]>([]);
  const [countryCities, setCountryCities] = useState<UrCountryCity[]>([]);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [savedContacts, setSavedContacts] = useState<UrPayoutContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);

  const payoutCurrencyOptions = useMemo(
    () => buildPayoutCurrencyOptions(cashRows, config ?? []),
    [cashRows, config],
  );

  const initialFrom = useMemo(
    () => defaultFromCurrency(payoutCurrencyOptions),
    [payoutCurrencyOptions],
  );
  const [fromCurrency, setFromCurrency] = useState<string>(initialFrom);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [amount, setAmount] = useState<string>('');
  const [stage, setStage] = useState<Stage>('input');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Full-Auth signed once when we start verifying; reused for permit-info +
  // execute (valid 20 min).
  const authRef = useRef<UrExtAuth | null>(null);
  const [recipient, setRecipient] = useState<ResolvedRecipient | null>(null);
  const [permit, setPermit] = useState<UrPayoutPermit | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ amount: string; recipient: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-anchor when balances or payout config arrive: keep a manual pick, but
  // drop currencies UR does not wire for bank payout (JPY/SGD/HKD, etc.).
  useEffect(() => {
    if (!payoutCurrencyOptions.length) return;
    const supported = new Set(payoutCurrencyOptions.map((r) => r.currency));
    setFromCurrency((prev) => {
      if (!supported.has(prev)) return initialFrom;
      const prevRow = payoutCurrencyOptions.find((r) => r.currency === prev);
      if (!prevRow) return initialFrom;
      if (prevRow.amount <= 0) {
        const bestRow = payoutCurrencyOptions.find((r) => r.currency === initialFrom);
        if ((bestRow?.amount ?? 0) > 0) return initialFrom;
      }
      return prev;
    });
  }, [payoutCurrencyOptions, initialFrom]);

  // ─── Sheet open/close animation ─────────────────────────────────────────
  const resetState = useCallback(() => {
    setAmount('');
    setStage('input');
    setErrMsg(null);
    setSuccessInfo(null);
    setConfirmOpen(false);
    setPickerOpen(false);
    setRecipient(null);
    setPermit(null);
    authRef.current = null;
    setSavedContacts([]);
    setContactsLoading(false);
  }, []);

  const finishClose = useCallback(() => {
    setMounted(false);
    resetState();
    onClose();
  }, [onClose, resetState]);

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
      setFromCurrency(defaultFromCurrency(payoutCurrencyOptions));
      setAmount('');
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose, payoutCurrencyOptions]);

  const closeable =
    stage === 'input' || stage === 'recipient' || stage === 'review' ||
    stage === 'success' || stage === 'error';
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
              toValue: 0, useNativeDriver: true, bounciness: 5, speed: 18,
            }).start();
          }
        },
      }),
    [closeable, slideAnim, animateClose],
  );

  const buildWalletClient = useCallback(async (overrideChainId?: number): Promise<{ client: WalletClient; userAddr: Hex }> => {
    if (!wallet || !walletAddress) throw new Error(t('sendSheet.noWallet'));
    if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(`Wallet mismatch: ${wallet.address} != ${walletAddress}. Please re-login.`);
    }
    const provider = await wallet.getProvider();
    const chain = getMantleChain(resolveMantleChainId(overrideChainId ?? mantleChainId));
    const client = createWalletClient({
      account: walletAddress as Hex,
      chain,
      transport: custom(provider),
    });
    return { client, userAddr: walletAddress as Hex };
  }, [wallet, walletAddress, mantleChainId, t]);

  // ─── Config / purposes / saved contacts fetch ────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setSetupLoading(true);
    setSetupErr(null);
    setContactsLoading(true);
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no token');
        const [cfg, purp, banks, cities] = await Promise.all([
          fetchUrPayoutConfig(token),
          fetchUrPaymentPurposes(token).catch(() => [] as UrPaymentPurpose[]),
          fetchUrPayoutBanks(token).catch(() => [] as UrBankCountry[]),
          fetchUrCountryCities(token).catch(() => [] as UrCountryCity[]),
        ]);
        if (cancelled) return;
        setConfig(cfg.currencies);
        setMantleChainId(cfg.mantle_chain_id);
        setPurposes(purp);
        setPayoutCountries(banks);
        setCountryCities(cities);

        // Saved beneficiaries live on UR GET /v2/br (Full-Auth), not partner /v1/profile.
        try {
          if (wallet && walletAddress) {
            const { client, userAddr } = await buildWalletClient(cfg.mantle_chain_id);
            const auth = await buildFullAuth(client, userAddr);
            if (!cancelled) authRef.current = auth;
            const br = await fetchUrPayoutContacts(token, { auth });
            if (!cancelled) {
              setSavedContacts(br.contacts.filter((c) => !!c.contactId));
            }
          } else if (!cancelled) {
            setSavedContacts([]);
          }
        } catch (contactErr) {
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[SendBottomSheet] payout contacts failed:', contactErr);
          }
          if (!cancelled) setSavedContacts([]);
        } finally {
          if (!cancelled) setContactsLoading(false);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? 'setup_failed';
        setSetupErr(String(msg));
        setContactsLoading(false);
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mounted, getAccessToken, wallet, walletAddress, buildWalletClient]);

  // ─── Derived ───────────────────────────────────────────────────────────
  const spendable = spendableBalances.forCurrency(fromCurrency);
  const fromBalance = spendable?.amount ?? 0;
  const fromBalanceStr = spendable?.amountStr ?? '—';
  const amountNum = useMemo(() => {
    const n = parseFloat(amount.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const currencyConfig = useMemo(
    () => config?.find((c) => c.currency === fromCurrency) ?? null,
    [config, fromCurrency],
  );
  const feeMajor = useMemo(
    () => (currencyConfig ? Number(currencyConfig.fee) / 100 : 0),
    [currencyConfig],
  );
  const minMajor = useMemo(
    () => (currencyConfig ? Number(currencyConfig.min_payout) / 100 : 0),
    [currencyConfig],
  );
  const maxMajor = useMemo(
    () => (currencyConfig ? Number(currencyConfig.max_payout) / 100 : 0),
    [currencyConfig],
  );

  // Rolling-30-day limit pre-flight. Blocks both the fully-maxed case AND a
  // single transfer that overshoots the remaining headroom (UR confirmed all
  // outgoing fiat, incl. payouts, draws from the same CHF-denominated limit).
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
    if (amountNum <= 0) return t('sendSheet.invalidAmount');
    if (amountNum > fromBalance) return t('sendSheet.notEnough', { currency: fromCurrency });
    if (minMajor > 0 && amountNum < minMajor) {
      return t('sendSheet.belowMin', { min: formatNum(minMajor), currency: fromCurrency });
    }
    if (maxMajor > 0 && amountNum > maxMajor) {
      return t('sendSheet.aboveMax', { max: formatNum(maxMajor), currency: fromCurrency });
    }
    return null;
  }, [amount, amountNum, fromBalance, fromCurrency, minMajor, maxMajor, t, spendableBalances]);

  const friendlyError = useCallback((detail: string): string => {
    const lower = detail.toLowerCase();
    if (lower.includes('region')) return t('sendSheet.regionBlocked');
    if (lower.includes('limit')) return t('sendSheet.limitReached');
    if (lower.includes('expired')) return t('sendSheet.quoteExpired');
    return detail;
  }, [t]);

  // Ensure a cached Full-Auth (sign once, reuse for verify + permit + submit).
  const ensureAuth = useCallback(async (): Promise<UrExtAuth> => {
    if (authRef.current) return authRef.current;
    const { client, userAddr } = await buildWalletClient();
    const auth = await buildFullAuth(client, userAddr);
    authRef.current = auth;
    return auth;
  }, [buildWalletClient]);

  // After a recipient is resolved, fetch the permit scaffold + move to review.
  const resolvePermitAndReview = useCallback(
    async (resolved: ResolvedRecipient) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const auth = await ensureAuth();
      if (!walletAddress) throw new Error(t('sendSheet.noWallet'));
      const resp = await fetchUrPayoutPermitInfo(token, {
        auth,
        currency: fromCurrency,
        amount: String(amountNum),
        owner_address: walletAddress,
      });
      setRecipient(resolved);
      setPermit(resp.permit);
      setStage('review');
    },
    [getAccessToken, ensureAuth, walletAddress, fromCurrency, amountNum, t],
  );

  const handleStageError = useCallback((err: unknown, fallbackStage: Stage) => {
    const detail =
      (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
      (err as { shortMessage?: string })?.shortMessage ??
      (err as { message?: string })?.message ?? t('sendSheet.unknownError');
    const lower = String(detail).toLowerCase();
    if (lower.includes('user rejected') || lower.includes('user denied')) {
      setStage(fallbackStage);
      return;
    }
    setErrMsg(friendlyError(String(detail)));
    setStage('error');
  }, [t, friendlyError]);

  // ─── input → recipient ─────────────────────────────────────────────────
  const onContinue = useCallback(() => {
    if (inputErr || amountNum <= 0 || spendableBalances.balanceLocked) return;
    if (limitReached) {
      setErrMsg(transferLimit.message || t('sendSheet.limitReached'));
      setStage('error');
      return;
    }
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setStage('recipient');
  }, [inputErr, amountNum, limitReached, transferLimit.message, t, spendableBalances.balanceLocked]);

  // Use a saved contact: just needs a reference → verify-reference.
  const onUseContact = useCallback(
    async (contact: UrPayoutContact, reference: string) => {
      if (!contact.contactId) return;
      setStage('verifying');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const auth = await ensureAuth();
        const refParams: UrPayoutRefParams = await verifyUrPayoutReference(token, {
          auth, reference,
        });
        await resolvePermitAndReview({
          contactId: contact.contactId,
          purposeId: refParams.purposeId,
          refId: refParams.refId,
          label: contactLabel(contact),
          metadata: buildUrPayoutMetadata({
            holder: contact.name ?? '',
            bankName: getUrPayoutContactBankName(contact),
            account: contact.fullAccount ?? contact.account ?? '',
            reference,
          }),
        });
      } catch (err: unknown) {
        handleStageError(err, 'recipient');
      }
    },
    [getAccessToken, ensureAuth, resolvePermitAndReview, handleStageError],
  );

  // Add a new IBAN recipient → verify-contact.
  const onAddRecipient = useCallback(
    async (form: NewRecipientForm) => {
      setStage('verifying');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const auth = await ensureAuth();
        const result = await verifyUrPayoutContact(token, {
          auth,
          account: form.accountMode === 'iban'
            ? formatIbanForUrWire(form.account)
            : form.account,
          bankName: form.bankName,
          bic: form.bic || undefined,
          purpose: form.purpose,
          reference: form.reference,
          creditor: {
            name: form.name,
            street: form.street,
            city: form.city,
            zip: form.zip,
            country: form.country,
          },
        });
        const rp = extractUrPayoutRefParams(result);
        if (!rp?.contactId) throw new Error(t('sendSheet.contactFailed'));
        await resolvePermitAndReview({
          contactId: rp.contactId,
          purposeId: rp.purposeId,
          refId: rp.refId,
          label: payoutRecipientLabel({
            name: form.name,
            bankName: form.bankName,
            account: form.account,
          }),
          metadata: buildUrPayoutMetadata({
            holder: form.name,
            bankName: form.bankName,
            account: form.account,
            reference: form.reference,
          }),
        });
      } catch (err: unknown) {
        handleStageError(err, 'recipient');
      }
    },
    [getAccessToken, ensureAuth, resolvePermitAndReview, handleStageError, t],
  );

  // ─── review → permit + submit + poll ─────────────────────────────────────
  const executeSend = useCallback(async () => {
    if (!recipient || !permit) return;
    const auth = authRef.current;
    if (!auth) { setStage('recipient'); return; }
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setErrMsg(null);
    setStage('signing');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const { client, userAddr } = await buildWalletClient();

      if (!permit.name || !permit.version || permit.nonce == null) {
        throw new Error(t('sendSheet.permitUnavailable'));
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
      const idempotencyKey = `payout-${userAddr.toLowerCase()}-${fromCurrency}-${Date.now()}`;
      const resp = await executeUrPayout(token, {
        auth,
        idempotency_key: idempotencyKey,
        currency: fromCurrency,
        amount: String(amountNum),
        contact_id: recipient.contactId,
        purpose_id: recipient.purposeId,
        ref: recipient.refId,
        // TODO(ur-fee): confirm the payout fee model with UR. We assume the
        // fee is DEDUCTED from the sent amount (recipient gets amount - fee),
        // so the permit amount == the payout amount (matches UR's doc example
        // where permitAmount == amount). If UR instead charges the fee ON TOP,
        // this must become amount + fee and the review "recipient gets" line
        // should show the full amount. Matters for USD ($50 fee).
        permit_amount: String(amountNum),
        permit_deadline: permitDeadline,
        permit_v: sig.v,
        permit_r: sig.r,
        permit_s: sig.s,
        metadata: recipient.metadata,
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
          // transient — keep polling
        }
      }
      if (status === 'failed') throw new Error(t('sendSheet.unknownError'));
      setSuccessInfo({ amount: String(amountNum), recipient: recipient.label });
      setStage('success');
      try { await onSuccess?.(); } catch { /* best-effort */ }
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { shortMessage?: string })?.shortMessage ??
        (err as { message?: string })?.message ?? t('sendSheet.unknownError');
      const lower = String(detail).toLowerCase();
      if (lower.includes('user rejected') || lower.includes('user denied')) {
        setStage('review');
        return;
      }
      setErrMsg(friendlyError(String(detail)));
      setStage('error');
    }
  }, [
    recipient, permit, getAccessToken, buildWalletClient,
    fromCurrency, amountNum, onSuccess, t, friendlyError,
  ]);

  const handleConfirmModal = useCallback(() => {
    void executeSend();
    setConfirmOpen(false);
  }, [executeSend]);

  const setMax = useCallback(() => {
    if (!spendableBalances.ready || fromBalance <= 0) return;
    setAmount(spendable?.amountStr ?? String(fromBalance));
  }, [spendableBalances.ready, fromBalance, spendable?.amountStr]);

  const pickerOptions = useMemo(
    () => spendableBalances.decoratePickerOptions(payoutCurrencyOptions),
    [payoutCurrencyOptions, spendableBalances],
  );

  const ibanPlaceholder = useMemo(
    () => pickIbanPlaceholder(payoutCountries, t('sendSheet.ibanPlaceholder')),
    [payoutCountries, t],
  );

  if (!mounted) return null;

  const isRecipientStage = stage === 'recipient';

  const sheetInner = (
    <>
      <View {...panResponder.panHandlers} style={styles.handleArea}>
        <View style={styles.handle} />
      </View>

      {setupErr ? (
        <ResultView kind="error" title={t('sendSheet.errorTitle')} body={setupErr}
          primaryLabel={t('sendSheet.errorClose')} onPrimary={animateClose} />
      ) : setupLoading && !config ? (
        <View style={styles.loadingBlock}>
          <BouncingDots color={colors.text.primary} pulse />
        </View>
      ) : stage === 'success' ? (
        <ResultView kind="success" title={t('sendSheet.successTitle')}
          body={t('sendSheet.successBody', {
            amount: formatNum(Number(successInfo?.amount ?? amountNum)),
            currency: fromCurrency,
            recipient: successInfo?.recipient ?? recipient?.label ?? '',
          })}
          primaryLabel={t('sendSheet.successDone')} onPrimary={animateClose} />
      ) : stage === 'error' ? (
        <ResultView kind="error" title={t('sendSheet.errorTitle')} body={errMsg}
          primaryLabel={t('sendSheet.errorRetry')}
          onPrimary={() => { setStage('input'); setErrMsg(null); }}
          secondaryLabel={t('sendSheet.errorClose')} onSecondary={animateClose} />
      ) : stage === 'verifying' ? (
        <View style={styles.loadingBlock}>
          <BouncingDots color={colors.text.primary} pulse />
          <Text style={styles.loadingText}>{t('sendSheet.verifying')}</Text>
        </View>
      ) : stage === 'review' || stage === 'signing' || stage === 'submitting' || stage === 'confirming' ? (
        <ReviewView
          fromCurrency={fromCurrency}
          amount={String(amountNum)}
          feeMajor={feeMajor}
          recipientLabel={recipient?.label ?? ''}
          onConfirm={() => setConfirmOpen(true)}
          onBack={() => setStage('recipient')}
          stage={stage}
        />
      ) : isRecipientStage ? (
        <RecipientView
          contacts={savedContacts}
          contactsLoading={contactsLoading}
          purposes={purposes}
          payoutCountries={payoutCountries}
          countryCities={countryCities}
          ibanPlaceholder={ibanPlaceholder}
          onUseContact={onUseContact}
          onAddRecipient={onAddRecipient}
          onBack={() => setStage('input')}
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
          feeMajor={feeMajor}
          minMajor={minMajor}
          maxMajor={maxMajor}
          limitReached={limitReached}
          limitTitle={transferLimit.title}
          limitText={transferLimit.message}
          inputErr={inputErr}
          onContinue={onContinue}
        />
      )}
    </>
  );

  const sheetNode = (
    <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: slideAnim }] }]}>
      <SafeAreaView
        edges={['bottom']}
        style={[styles.safeArea, isRecipientStage && { maxHeight: sheetMaxHeight }]}
      >
        <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom * 0.2 }]}>
          {sheetInner}
        </View>
      </SafeAreaView>
    </Animated.View>
  );

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent
      onRequestClose={closeable ? animateClose : undefined}>
      <View style={styles.root} pointerEvents="box-none">
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.65] }) }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeable ? animateClose : undefined} />
        </Animated.View>

        {isRecipientStage ? sheetNode : (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.kav}
            pointerEvents="box-none"
          >
            {sheetNode}
          </KeyboardAvoidingView>
        )}

        {pickerOpen ? (
          <CurrencyPicker
            options={pickerOptions}
            currentlySelected={fromCurrency}
            onPick={(code) => { setFromCurrency(code); setPickerOpen(false); setAmount(''); }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null}

        <BankConfirmModal
          visible={confirmOpen}
          title={t('sendSheet.confirmTitle')}
          message={t('sendSheet.confirmMessage', {
            send: formatNum(amountNum),
            from: fromCurrency,
            recipient: recipient?.label ?? '',
            defaultValue:
              `Send ${formatNum(amountNum)} ${fromCurrency} to ${recipient?.label ?? 'recipient'}?`,
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

function MetaBadge({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaBadge}>
      <Text style={styles.metaBadgeLabel}>{label}</Text>
      <Text style={styles.metaBadgeValue}>{value}</Text>
    </View>
  );
}

function InputView({
  fromCurrency, fromBalanceStr, fromBalance, fromBalanceLoading, fromBalanceError,
  onRetryFromBalance, amount, onAmountChange, onMax,
  onPickFrom, feeMajor, minMajor, maxMajor, limitReached, limitTitle, limitText, inputErr, onContinue,
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
  feeMajor: number;
  minMajor: number;
  maxMajor: number;
  limitReached: boolean;
  limitTitle: string;
  limitText: string;
  inputErr: string | null;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const balanceLocked = fromBalanceLoading || fromBalanceError;
  const canContinue = !inputErr && !limitReached && !balanceLocked && parseFloat(amount || '0') > 0;

  return (
    <>
      <Text style={styles.title}>{t('sendSheet.title')}</Text>

      {limitReached ? (
        <View style={styles.blockBanner}>
          <Ionicons name="alert-circle" size={18} color={colors.accent.gold} />
          <View style={styles.blockBannerBody}>
            <Text style={styles.blockBannerTitle}>
              {limitTitle || t('sendSheet.limitReachedTitle')}
            </Text>
            <Text style={styles.blockBannerText}>
              {limitText || t('sendSheet.limitReached')}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.block}>
        <View style={styles.rowBetween}>
          <Text style={styles.smallLabel}>{t('sendSheet.from')}</Text>
          <SpendableBalanceLine
            label={t('sendSheet.available')}
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
            editable={!balanceLocked}
          />
          <TouchableOpacity onPress={onPickFrom} style={styles.currencyChip}>
            <CircleCurrencyFlag currencyCode={fromCurrency} size={20} />
            <Text style={styles.currencyChipText}>{fromCurrency}</Text>
            <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onMax} disabled={fromBalance <= 0 || balanceLocked}>
          <Text style={[styles.maxText, (fromBalance <= 0 || balanceLocked) && { opacity: 0.4 }]}>
            {t('sendSheet.max')}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.metaBadgeRow}>
        {minMajor > 0 ? (
          <MetaBadge
            label={t('sendSheet.minLabel')}
            value={`${formatNum(minMajor)} ${fromCurrency}`}
          />
        ) : null}
        {maxMajor > 0 ? (
          <MetaBadge
            label={t('sendSheet.maxLabel')}
            value={`${formatNum(maxMajor)} ${fromCurrency}`}
          />
        ) : null}
        <MetaBadge
          label={t('sendSheet.feeLabel')}
          value={formatPayoutFeeValue(feeMajor, fromCurrency, t)}
        />
      </View>

      {inputErr ? <Text style={styles.errText}>{inputErr}</Text> : null}

      <Text style={styles.disclaimer}>{t('sendSheet.disclaimer')}</Text>

      <ConfirmButton busy={false} enabled={canContinue} label={t('sendSheet.continue')}
        onPress={canContinue ? onContinue : undefined} />
    </>
  );
}

interface NewRecipientForm {
  account: string;
  accountMode: UrPayoutAccountMode;
  bankName: string;
  bic?: string;
  name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  reference: string;
  purpose: number;
}

function RecipientView({
  contacts,
  contactsLoading,
  purposes,
  payoutCountries,
  countryCities,
  ibanPlaceholder,
  onUseContact,
  onAddRecipient,
  onBack,
}: {
  contacts: UrPayoutContact[];
  contactsLoading: boolean;
  purposes: UrPaymentPurpose[];
  payoutCountries: UrBankCountry[];
  countryCities: UrCountryCity[];
  ibanPlaceholder: string;
  onUseContact: (c: UrPayoutContact, reference: string) => void;
  onAddRecipient: (form: NewRecipientForm) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { getAccessToken } = useAuth();
  const [adding, setAdding] = useState(contacts.length === 0);

  useEffect(() => {
    if (contacts.length > 0) setAdding(false);
  }, [contacts.length]);

  const [reference, setReference] = useState('');
  const [selectedContact, setSelectedContact] = useState<UrPayoutContact | null>(null);

  const [country, setCountry] = useState('');
  const [account, setAccount] = useState('');
  const [bankName, setBankName] = useState('');
  const [bic, setBic] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [zip, setZip] = useState('');
  const [street, setStreet] = useState('');
  const [newReference, setNewReference] = useState('');
  const [purpose, setPurpose] = useState<number | null>(purposes[0]?.value ?? null);
  const [selectedBankName, setSelectedBankName] = useState('');
  const [resolvingIban, setResolvingIban] = useState(false);
  const [ibanErr, setIbanErr] = useState<string | null>(null);
  const [ibanLookupStatus, setIbanLookupStatus] = useState<'found' | 'miss' | null>(null);
  const [lookupProvidedBic, setLookupProvidedBic] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [zipTouched, setZipTouched] = useState(false);

  const countryEntry = useMemo(
    () => (country.length === 2 ? findUrCountryCity(countryCities, country) : undefined),
    [countryCities, country],
  );
  const payoutMeta = useMemo(
    () => (country.length === 2 ? getUrPayoutCountryMeta(payoutCountries, country) : undefined),
    [payoutCountries, country],
  );
  const accountMode = useMemo(
    () => resolveUrPayoutAccountMode(payoutMeta),
    [payoutMeta],
  );
  const selectedBank = useMemo(
    () => payoutMeta?.banks?.find((b) => b.name === selectedBankName) ?? null,
    [payoutMeta, selectedBankName],
  );
  const accountClean = useMemo(() => {
    if (accountMode === 'iban') return normalizeIbanAccount(account);
    return account.replace(/\s+/g, '');
  }, [account, accountMode]);
  const ibanComplete = useMemo(
    () => accountMode === 'iban' && isIbanStructurallyComplete(accountClean),
    [accountMode, accountClean],
  );
  const bicRequired = accountMode === 'iban'
    ? ibanLookupStatus === 'miss' && !lookupProvidedBic
    : accountMode === 'local'
      ? !lookupProvidedBic
      : false;

  const countryOptions = useMemo(
    () => [...countryCities]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        key: c.countryCode.iso2,
        label: `${c.name} (${c.countryCode.iso2})`,
      })),
    [countryCities],
  );
  const cityOptions = useMemo(
    () => dedupeUrCities(countryEntry?.cities ?? []).map((c) => ({ key: c, label: c })),
    [countryEntry],
  );
  const bankOptions = useMemo(
    () => (payoutMeta?.banks ?? []).map((b) => ({ key: b.name, label: b.name })),
    [payoutMeta],
  );

  const resetAccountFields = useCallback(() => {
    setAccount('');
    setBankName('');
    setBic('');
    setSelectedBankName('');
    setIbanErr(null);
    setIbanLookupStatus(null);
    setLookupProvidedBic(false);
  }, []);

  const handleSelectCountry = useCallback((iso2: string) => {
    setCountry(iso2);
    setCity('');
    setZip('');
    setZipTouched(false);
    resetAccountFields();
    setCountryOpen(false);
  }, [resetAccountFields]);

  const handleIbanChange = useCallback((text: string) => {
    const clean = normalizeIbanAccount(text);
    setAccount(formatIbanDisplay(clean));
    setIbanErr(null);
    setIbanLookupStatus(null);
    setLookupProvidedBic(false);
  }, []);

  const handleSelectBank = useCallback((bankKey: string) => {
    const bank = payoutMeta?.banks?.find((b) => b.name === bankKey);
    setSelectedBankName(bankKey);
    if (bank) {
      setBankName(bank.name);
      if (bank.bic) {
        setBic(bank.bic.toUpperCase());
        setLookupProvidedBic(true);
      } else {
        setBic('');
        setLookupProvidedBic(false);
      }
    }
    setBankOpen(false);
  }, [payoutMeta]);

  useEffect(() => {
    if (accountMode !== 'iban' || !ibanComplete) {
      setResolvingIban(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setResolvingIban(true);
      setIbanErr(null);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const bank = await fetchUrBankByIban(token, accountClean);
        if (cancelled) return;
        if (bank) {
          const resolvedName = resolveBankLookupName(bank);
          if (resolvedName) setBankName(resolvedName);
          if (bank.bic) {
            setBic(bank.bic.toUpperCase());
            setLookupProvidedBic(true);
          } else {
            setLookupProvidedBic(false);
          }
          setIbanLookupStatus('found');
          setIbanErr(null);
        } else {
          setLookupProvidedBic(false);
          setIbanLookupStatus('miss');
          setIbanErr(t('sendSheet.bankLookupMiss'));
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? '';
        const softMiss =
          /invalid iban|10009|not found/i.test(detail) ||
          (err as { response?: { status?: number } })?.response?.status === 404;
        setIbanLookupStatus('miss');
        setLookupProvidedBic(false);
        setIbanErr(softMiss ? t('sendSheet.bankLookupMiss') : (detail || t('sendSheet.bankLookupMiss')));
      } finally {
        if (!cancelled) setResolvingIban(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountClean, ibanComplete, accountMode, getAccessToken, t]);

  const purposeLabel = useMemo(
    () => purposes.find((p) => p.value === purpose)?.name ?? t('sendSheet.selectPurpose'),
    [purposes, purpose, t],
  );
  const countryLabel = useMemo(
    () => countryOptions.find((o) => o.key === country)?.label ?? t('sendSheet.selectCountry'),
    [countryOptions, country, t],
  );
  const cityLabel = city || t('sendSheet.selectCity');
  const bankLabel = selectedBankName || t('sendSheet.selectBank');

  const ibanCountryMismatch = accountMode === 'iban'
    && country.length === 2
    && ibanComplete
    && accountClean.slice(0, 2) !== country;
  const cityInvalid = country.length === 2 && city.trim().length > 0 && !isUrCitySupported(countryEntry, city);
  const zipInvalid = zipTouched && zip.trim().length > 0 && !isUrZipValid(countryEntry, zip);

  const accountReady = accountMode === 'iban'
    ? ibanComplete && bankName.trim().length > 0 && (lookupProvidedBic || bic.trim().length >= 6) && !ibanCountryMismatch
    : accountMode === 'local'
      ? !!selectedBank && accountClean.length >= 4 && bankName.trim().length > 0
        && (lookupProvidedBic || bic.trim().length >= 6)
      : false;

  const canSubmitNew =
    country.length === 2 &&
    !!countryEntry &&
    !!accountMode &&
    accountReady &&
    name.trim().length > 1 &&
    isUrCitySupported(countryEntry, city) &&
    isUrZipValid(countryEntry, zip) &&
    street.trim().length > 0 &&
    newReference.trim().length > 0 &&
    purpose != null &&
    !resolvingIban;

  const submitNew = useCallback(() => {
    if (!canSubmitNew || purpose == null || !accountMode) return;
    onAddRecipient({
      account: accountClean,
      accountMode,
      bankName: bankName.trim(),
      bic: bic.trim() ? bic.trim().toUpperCase() : undefined,
      name: name.trim(),
      street: street.trim(),
      city: city.trim(),
      zip: zip.trim(),
      country: country.trim().toUpperCase(),
      reference: newReference.trim(),
      purpose,
    });
  }, [
    canSubmitNew, purpose, accountMode, onAddRecipient, accountClean, bankName, bic,
    name, street, city, zip, country, newReference,
  ]);

  const closeOtherMenus = (except?: 'country' | 'city' | 'bank' | 'purpose') => {
    if (except !== 'country') setCountryOpen(false);
    if (except !== 'city') setCityOpen(false);
    if (except !== 'bank') setBankOpen(false);
    if (except !== 'purpose') setPurposeOpen(false);
  };

  return (
    <KeyboardAwareScrollView
      style={styles.recipientScroll}
      contentContainerStyle={styles.recipientScrollContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      bottomOffset={20}
      extraKeyboardSpace={Platform.OS === 'ios' ? 8 : 12}
    >
      <View style={styles.reviewHeader}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text.secondary} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('sendSheet.recipientTitle')}</Text>
        <View style={{ width: 22 }} />
      </View>

      {!adding ? (
        <>
          {contactsLoading && contacts.length === 0 ? (
            <View style={styles.recipientContactsLoading}>
              <BouncingDots color={colors.text.primary} pulse />
            </View>
          ) : null}

          {contacts.map((c, i) => {
            const active = selectedContact?.contactId === c.contactId;
            return (
              <TouchableOpacity
                key={c.contactId ?? String(i)}
                style={[styles.contactRow, active && styles.contactRowActive]}
                onPress={() => setSelectedContact(c)}
              >
                <View style={styles.contactAvatar}>
                  <Ionicons name="business-outline" size={18} color={colors.accent.gold} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{c.name ?? maskAccount(c.account ?? '')}</Text>
                  <Text style={styles.contactSub}>
                    {[getUrPayoutContactBankName(c), maskAccount(c.account ?? c.fullAccount ?? '')].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} /> : null}
              </TouchableOpacity>
            );
          })}

          {selectedContact ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('sendSheet.reference')}</Text>
              <TextInput
                value={reference}
                onChangeText={setReference}
                placeholder={t('sendSheet.referencePlaceholder')}
                placeholderTextColor={colors.text.tertiary}
                style={styles.fieldInput}
              />
              <Text style={styles.fieldHint}>{t('sendSheet.referenceHint')}</Text>
            </View>
          ) : null}

          <ConfirmButton
            busy={false}
            enabled={!!selectedContact && reference.trim().length > 0}
            label={t('sendSheet.continue')}
            onPress={
              selectedContact && reference.trim().length > 0
                ? () => onUseContact(selectedContact, reference.trim())
                : undefined
            }
          />

          <TouchableOpacity style={styles.linkBtn} onPress={() => setAdding(true)}>
            <Ionicons name="add" size={16} color={colors.accent.gold} />
            <Text style={styles.linkBtnText}>{t('sendSheet.addRecipient')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.requiredHint}>{t('sendSheet.requiredHint')}</Text>

          <Field label={t('sendSheet.country')} required>
            <TouchableOpacity
              style={styles.selectInput}
              onPress={() => { closeOtherMenus('country'); setCountryOpen(true); }}
            >
              <Text style={[styles.selectText, !country && { color: colors.text.tertiary }]}>
                {country ? countryLabel : t('sendSheet.selectCountry')}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.text.secondary} />
            </TouchableOpacity>
            <SearchableSelect
              visible={countryOpen}
              title={t('sendSheet.selectCountry')}
              options={countryOptions}
              selected={country}
              searchPlaceholder={t('sendSheet.searchCountry')}
              emptyText={t('sendSheet.noMatches')}
              onSelect={handleSelectCountry}
              onClose={() => setCountryOpen(false)}
            />
          </Field>

          {country.length === 2 && !accountMode ? (
            <Text style={styles.errText}>{t('sendSheet.countryUnsupported')}</Text>
          ) : null}

          {accountMode === 'iban' ? (
            <>
              <Field label={t('sendSheet.iban')} required>
                <TextInput
                  value={account}
                  onChangeText={handleIbanChange}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={payoutMeta?.ibanMetadata?.placeholder ?? ibanPlaceholder}
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.fieldInput}
                />
                <Text style={styles.fieldHint}>{t('sendSheet.ibanHint')}</Text>
                {resolvingIban ? <Text style={styles.fieldHint}>{t('sendSheet.resolvingBank')}</Text> : null}
                {ibanComplete && ibanErr ? <Text style={styles.errText}>{ibanErr}</Text> : null}
                {ibanCountryMismatch ? (
                  <Text style={styles.errText}>{t('sendSheet.ibanCountryMismatch')}</Text>
                ) : null}
              </Field>

              <Field label={t('sendSheet.bankName')} required>
                <TextInput
                  value={bankName}
                  onChangeText={setBankName}
                  placeholder={t('sendSheet.bankNamePlaceholder')}
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.fieldInput}
                />
              </Field>

              <Field label={t('sendSheet.bic')} required={bicRequired}>
                <TextInput
                  value={bic}
                  onChangeText={(text) => setBic(text.replace(/\s+/g, '').toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={t('sendSheet.bicPlaceholder')}
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.fieldInput}
                />
              </Field>
            </>
          ) : null}

          {accountMode === 'local' ? (
            <>
              <Field label={t('sendSheet.bankName')} required>
                <TouchableOpacity
                  style={styles.selectInput}
                  onPress={() => { closeOtherMenus('bank'); setBankOpen((o) => !o); }}
                >
                  <Text style={[styles.selectText, !selectedBankName && { color: colors.text.tertiary }]}>
                    {bankLabel}
                  </Text>
                  <Ionicons name={bankOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.text.secondary} />
                </TouchableOpacity>
                {bankOpen ? (
                  <View style={styles.selectMenu}>
                    {bankOptions.map((o) => (
                      <TouchableOpacity key={o.key} style={styles.selectMenuRow}
                        onPress={() => handleSelectBank(o.key)}>
                        <Text style={styles.selectMenuText}>{o.label}</Text>
                        {o.key === selectedBankName ? <Ionicons name="checkmark" size={16} color={colors.accent.gold} /> : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </Field>

              <Field label={t('sendSheet.accountNumber')} required>
                <TextInput
                  value={account}
                  onChangeText={setAccount}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={selectedBank?.accountPlaceholder ?? t('sendSheet.accountNumberPlaceholder')}
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.fieldInput}
                />
                {selectedBank?.accountNotice ? (
                  <Text style={styles.fieldHint}>{selectedBank.accountNotice}</Text>
                ) : (
                  <Text style={styles.fieldHint}>{t('sendSheet.localAccountHint')}</Text>
                )}
              </Field>
            </>
          ) : null}

          <Field label={t('sendSheet.recipientName')} required>
            <TextInput value={name} onChangeText={setName}
              placeholder={t('sendSheet.recipientNamePlaceholder')}
              placeholderTextColor={colors.text.tertiary} style={styles.fieldInput} />
          </Field>

          <Field label={t('sendSheet.street')} required>
            <TextInput value={street} onChangeText={setStreet}
              placeholder={t('sendSheet.streetPlaceholder')}
              placeholderTextColor={colors.text.tertiary} style={styles.fieldInput} />
          </Field>

          <Field label={t('sendSheet.city')} required>
            <TouchableOpacity
              style={styles.selectInput}
              onPress={() => {
                if (!countryEntry) return;
                closeOtherMenus('city');
                setCityOpen(true);
              }}
              disabled={!countryEntry}
            >
              <Text style={[styles.selectText, !city && { color: colors.text.tertiary }]}>
                {cityLabel}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.text.secondary} />
            </TouchableOpacity>
            <SearchableSelect
              visible={cityOpen && !!countryEntry}
              title={t('sendSheet.selectCity')}
              options={cityOptions}
              selected={city}
              searchPlaceholder={t('sendSheet.searchCity')}
              emptyText={t('sendSheet.noMatches')}
              onSelect={setCity}
              onClose={() => setCityOpen(false)}
            />
            {cityInvalid ? <Text style={styles.errText}>{t('sendSheet.cityInvalid')}</Text> : null}
          </Field>

          <Field label={t('sendSheet.zip')} required>
            <TextInput
              value={zip}
              onChangeText={setZip}
              onBlur={() => setZipTouched(true)}
              placeholder="0000"
              placeholderTextColor={colors.text.tertiary}
              style={styles.fieldInput}
            />
            {zipInvalid ? <Text style={styles.errText}>{t('sendSheet.zipInvalid')}</Text> : null}
          </Field>

          <Field label={t('sendSheet.purpose')} required>
            <TouchableOpacity
              style={styles.selectInput}
              onPress={() => { closeOtherMenus('purpose'); setPurposeOpen((o) => !o); }}
            >
              <Text style={[styles.selectText, purpose == null && { color: colors.text.tertiary }]}>
                {purposeLabel}
              </Text>
              <Ionicons name={purposeOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.text.secondary} />
            </TouchableOpacity>
            {purposeOpen ? (
              <View style={styles.selectMenu}>
                {purposes.map((p) => (
                  <TouchableOpacity key={p.value} style={styles.selectMenuRow}
                    onPress={() => { setPurpose(p.value); setPurposeOpen(false); }}>
                    <Text style={styles.selectMenuText}>{p.name}</Text>
                    {p.value === purpose ? <Ionicons name="checkmark" size={16} color={colors.accent.gold} /> : null}
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </Field>

          <Field label={t('sendSheet.reference')} required>
            <TextInput value={newReference} onChangeText={setNewReference}
              placeholder={t('sendSheet.referencePlaceholder')}
              placeholderTextColor={colors.text.tertiary} style={styles.fieldInput} />
            <Text style={styles.fieldHint}>{t('sendSheet.referenceHint')}</Text>
          </Field>

          <ConfirmButton busy={false} enabled={canSubmitNew}
            label={t('sendSheet.continue')} onPress={canSubmitNew ? submitNew : undefined} />

          {contacts.length > 0 ? (
            <TouchableOpacity style={styles.linkBtn} onPress={() => setAdding(false)}>
              <Ionicons name="arrow-back" size={16} color={colors.accent.gold} />
              <Text style={styles.linkBtnText}>{t('sendSheet.backToContacts')}</Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </KeyboardAwareScrollView>
  );
}

function Field({
  label, children, style, required,
}: { label: string; children: React.ReactNode; style?: object; required?: boolean }) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>
        {label}
        {required ? <Text style={styles.requiredMark}> *</Text> : null}
      </Text>
      {children}
    </View>
  );
}

type SelectOption = { key: string; label: string };

/**
 * Full-screen searchable picker. Virtualized FlatList + live filter so long
 * lists (e.g. every city in Switzerland) stay smooth instead of freezing the
 * form. Rendered in a Modal to avoid nesting a VirtualizedList in a ScrollView.
 */
function SearchableSelect({
  visible, title, options, selected, searchPlaceholder, emptyText, onSelect, onClose,
}: {
  visible: boolean;
  title: string;
  options: SelectOption[];
  selected?: string;
  searchPlaceholder: string;
  emptyText: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  useEffect(() => { if (!visible) setQuery(''); }, [visible]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    // Prefix matches first (typing "Z" surfaces Zürich/Zurich before "Lenzburg"),
    // then any substring match.
    const starts: SelectOption[] = [];
    const contains: SelectOption[] = [];
    for (const o of options) {
      const label = o.label.toLowerCase();
      if (label.startsWith(q)) starts.push(o);
      else if (label.includes(q)) contains.push(o);
    }
    return [...starts, ...contains];
  }, [options, query]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.pickerModalRoot}>
        <Pressable style={styles.pickerBackdrop} onPress={onClose} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.searchSheet, { paddingBottom: insets.bottom + 12 }]}
        >
          <View style={styles.pickerGrabber} />
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={colors.text.secondary} />
            </TouchableOpacity>
          </View>
          <View style={styles.pickerSearch}>
            <Ionicons name="search" size={16} color={colors.text.tertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={colors.text.tertiary}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.pickerSearchInput}
            />
            {query.length > 0 ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color={colors.text.tertiary} />
              </TouchableOpacity>
            ) : null}
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(item, idx) => `${item.key}-${idx}`}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            windowSize={10}
            removeClippedSubviews
            style={styles.pickerList}
            contentContainerStyle={filtered.length === 0 ? styles.pickerListEmpty : undefined}
            ListEmptyComponent={<Text style={styles.pickerEmpty}>{emptyText}</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.pickerOptionRow}
                onPress={() => { onSelect(item.key); onClose(); }}
              >
                <Text style={styles.pickerOptionText}>{item.label}</Text>
                {item.key === selected ? (
                  <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
                ) : null}
              </TouchableOpacity>
            )}
          />
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function ReviewView({
  fromCurrency, amount, feeMajor, recipientLabel, onConfirm, onBack, stage,
}: {
  fromCurrency: string;
  amount: string;
  feeMajor: number;
  recipientLabel: string;
  onConfirm: () => void;
  onBack: () => void;
  stage: Stage;
}) {
  const { t } = useTranslation();
  const busy = stage === 'signing' || stage === 'submitting' || stage === 'confirming';
  const amountNum = Number(amount) || 0;
  const net = Math.max(0, amountNum - feeMajor);
  const ctaLabel = (() => {
    switch (stage) {
      case 'signing': return t('sendSheet.signing');
      case 'submitting': return t('sendSheet.submitting');
      case 'confirming': return t('sendSheet.polling');
      default: return t('sendSheet.send');
    }
  })();

  return (
    <>
      <View style={styles.reviewHeader}>
        {!busy ? (
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        ) : <View style={{ width: 22 }} />}
        <Text style={styles.title}>{t('sendSheet.reviewTitle')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.reviewCard}>
        <ReviewRow label={t('sendSheet.reviewYouSend')} value={`${formatNum(amountNum)} ${fromCurrency}`} strong />
        <ReviewRow
          label={t('sendSheet.reviewFee')}
          value={formatPayoutFeeValue(feeMajor, fromCurrency, t)}
          highlight={feeMajor <= 0}
        />
        <View style={styles.reviewDivider} />
        <ReviewRow label={t('sendSheet.reviewRecipientGets')} value={`${formatNum(net)} ${fromCurrency}`} />
        <ReviewRow label={t('sendSheet.reviewRecipient')} value={recipientLabel} multiline />
      </View>

      <ConfirmButton busy={busy} enabled={!busy} label={ctaLabel}
        onPress={busy ? undefined : onConfirm} />
    </>
  );
}

function ReviewRow({
  label, value, strong, multiline, highlight,
}: { label: string; value: string; strong?: boolean; multiline?: boolean; highlight?: boolean }) {
  return (
    <View style={[styles.reviewRow, multiline && styles.reviewRowMultiline]}>
      <Text style={styles.reviewRowLabel}>{label}</Text>
      <Text
        style={[
          styles.reviewRowValue,
          strong && styles.reviewRowValueStrong,
          multiline && styles.reviewRowValueMultiline,
          highlight && styles.feeFreeText,
        ]}
        numberOfLines={multiline ? 3 : 1}
      >
        {value}
      </Text>
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
      <Text style={styles.resultBody}>{body ?? t('sendSheet.unknownError')}</Text>
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
        <View style={styles.pickerGrabber} />
        <View style={[styles.pickerHeader, styles.currencyPickerHeader]}>
          <Text style={styles.pickerTitle}>{t('sendSheet.pickCurrency')}</Text>
          <TouchableOpacity onPress={onCancel} hitSlop={12} accessibilityRole="button">
            <Ionicons name="close" size={22} color={colors.text.secondary} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={[styles.currencyPickerList, { minHeight: SEND_PICKER_LIST_MIN_HEIGHT }]}
          contentContainerStyle={styles.currencyPickerListContent}
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

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPayoutFeeValue(feeMajor: number, currency: string, t: (key: string) => string): string {
  if (feeMajor <= 0) return t('sendSheet.feeFree');
  return `${formatNum(feeMajor)} ${currency}`;
}

function sanitizeIbanInput(raw: string): string {
  return normalizeIbanAccount(raw);
}

function formatIbanDisplay(clean: string): string {
  if (!clean) return '';
  return clean.replace(/(.{4})/g, '$1 ').trim();
}

function resolveBankLookupName(bank: UrBankByIban): string {
  return (bank.name ?? bank.bankName ?? '').trim();
}

function payoutRecipientLabel(parts: {
  name?: string;
  bankName?: string;
  account?: string;
}): string {
  const name = (parts.name ?? '').trim();
  const bank = (parts.bankName ?? '').trim();
  const acct = maskAccount((parts.account ?? '').replace(/\s+/g, ''));
  const primary = name || acct;
  const segments: string[] = [];
  if (primary) segments.push(primary);
  if (bank) segments.push(bank);
  if (acct && acct !== primary && !segments.includes(acct)) segments.push(acct);
  return segments.join(' · ') || bank || acct;
}

function contactLabel(c: UrPayoutContact): string {
  return payoutRecipientLabel({
    name: c.name,
    bankName: getUrPayoutContactBankName(c),
    account: c.fullAccount ?? c.account,
  });
}

function maskAccount(account: string): string {
  const clean = (account || '').replace(/\s+/g, '');
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
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
  recipientScroll: { flexGrow: 0, flexShrink: 1 },
  recipientScrollContent: { paddingBottom: 8 },
  pickerSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.background.card,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: colors.border.primary,
    paddingHorizontal: 20, paddingTop: 8, maxHeight: '75%',
  },
  handleArea: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginBottom: 4 },
  handle: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border.primary },
  loadingBlock: { paddingVertical: 48, alignItems: 'center', gap: 12 },
  recipientContactsLoading: { paddingVertical: 20, alignItems: 'center' },
  loadingText: { fontSize: 13, color: colors.text.secondary, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '800', color: colors.text.primary, marginBottom: 16 },
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
  metaBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  metaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}44`,
    backgroundColor: `${colors.accent.gold}10`,
  },
  metaBadgeLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.accent.gold,
    opacity: 0.8,
    letterSpacing: 0.3,
  },
  metaBadgeValue: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.accent.gold,
    letterSpacing: 0.2,
  },
  feeFreeText: { color: colors.accent.gold, fontWeight: '700' },
  errText: { color: '#e57373', fontSize: 12, marginTop: 8, fontWeight: '600' },
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
  blockBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: colors.background.elevated, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: colors.accent.gold, marginBottom: 14,
  },
  blockBannerBody: { flex: 1 },
  blockBannerTitle: { fontSize: 13, fontWeight: '800', color: colors.text.primary, marginBottom: 2 },
  blockBannerText: { fontSize: 12, color: colors.text.secondary, lineHeight: 17 },
  // Recipient form
  reviewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border.primary, marginBottom: 10,
    backgroundColor: colors.background.elevated,
  },
  contactRowActive: { borderColor: colors.accent.gold },
  contactAvatar: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background.card,
  },
  contactName: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  contactSub: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
  field: { marginBottom: 12 },
  fieldRow: { flexDirection: 'row', gap: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, marginBottom: 6 },
  requiredMark: { color: colors.status.warning },
  requiredHint: { fontSize: 12, color: colors.text.tertiary, marginBottom: 12 },
  fieldInput: {
    backgroundColor: colors.background.elevated, borderRadius: 12, paddingHorizontal: 14,
    paddingVertical: 12, fontSize: 15, color: colors.text.primary,
    borderWidth: 1, borderColor: colors.border.primary,
  },
  fieldHint: { fontSize: 11, color: colors.text.tertiary, marginTop: 6 },
  selectInput: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.background.elevated, borderRadius: 12, paddingHorizontal: 14,
    paddingVertical: 13, borderWidth: 1, borderColor: colors.border.primary,
  },
  selectText: { fontSize: 15, color: colors.text.primary, fontWeight: '600' },
  selectMenu: {
    marginTop: 6, backgroundColor: colors.background.elevated, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border.primary, overflow: 'hidden',
  },
  selectMenuRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.primary,
  },
  selectMenuText: { fontSize: 14, color: colors.text.primary },
  // Searchable picker modal
  pickerModalRoot: { flex: 1, justifyContent: 'flex-end' },
  pickerBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  searchSheet: {
    maxHeight: '85%', minHeight: '55%',
    backgroundColor: colors.background.secondary,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 8,
  },
  pickerGrabber: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border.primary, marginBottom: 10,
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  pickerTitle: { fontSize: 17, fontWeight: '800', color: colors.text.primary },
  pickerSearch: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.background.elevated, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 4,
    borderWidth: 1, borderColor: colors.border.primary, marginBottom: 8,
  },
  pickerSearchInput: { flex: 1, fontSize: 15, color: colors.text.primary },
  pickerList: { flexGrow: 0 },
  pickerListEmpty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
  pickerEmpty: { fontSize: 14, color: colors.text.tertiary },
  pickerOptionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.primary,
  },
  pickerOptionText: { fontSize: 15, color: colors.text.primary, flex: 1, marginRight: 12 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14, paddingVertical: 8 },
  linkBtnText: { fontSize: 14, fontWeight: '700', color: colors.accent.gold },
  // Review
  reviewCard: {
    backgroundColor: colors.background.elevated, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: colors.border.primary, gap: 12,
  },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewRowMultiline: { alignItems: 'flex-start' },
  reviewRowLabel: { fontSize: 13, color: colors.text.secondary },
  reviewRowValue: { fontSize: 14, color: colors.text.primary, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  reviewRowValueMultiline: { flex: 1, lineHeight: 20 },
  reviewRowValueStrong: { fontSize: 16, fontWeight: '800' },
  reviewDivider: { height: 1, backgroundColor: colors.border.primary },
  // Result
  resultBlock: { alignItems: 'center', paddingVertical: 12 },
  resultIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  resultTitle: { fontSize: 20, fontWeight: '800', color: colors.text.primary, marginBottom: 8 },
  resultBody: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 20, lineHeight: 20 },
  // Currency picker (Send amount step)
  currencyPickerHeader: { marginBottom: 18 },
  currencyPickerList: { flexGrow: 0 },
  currencyPickerListContent: { gap: 8, paddingBottom: 4 },
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
