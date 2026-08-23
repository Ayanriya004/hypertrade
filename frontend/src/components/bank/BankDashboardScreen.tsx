/**
 * Bank hub — Cash & Card tabs.
 *
 * Two-tab layout (mirroring the Rewards/Referrals pattern):
 *
 *   - Cash tab : Wise-style multi-currency overview. Shows the user's
 *                IBAN-backed accounts as a horizontal carousel plus the
 *                recent transactions feed pulled from /api/ur/transactions.
 *   - Card tab : Active HyperTrade debit card view (card visual, View /
 *                Freeze / Settings, platform mobile-wallet CTA, card feed).
 *
 * Data plumbing lives in `useUrAccount`; this file is just composition.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Dimensions,
  Platform,
  RefreshControl,
  Animated,
  Easing,
  Image,
  ActivityIndicator,
  useWindowDimensions,
  type ImageSourcePropType,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { colors } from '../../theme/colors';
import { useAppStore } from '../../store/appStore';
import { useFundsPendingStore } from '../../store/fundsPendingStore';
import { useUrAccount } from '../../providers/UrAccountProvider';
import type { PendingIncomingEntry } from '../../hooks/useUrAccount';
import { useBankKycStart } from '../../hooks/useBankKycStart';
import { BankKycEmailLinkSheet } from './BankKycEmailLinkSheet';
import { useUrCard } from '../../hooks/useUrCard';
import { useBankApplyMode } from '../../hooks/useBankApplyMode';
import { useAuth, isUrTestKycBypass } from '../../providers/AuthContext';
import { HypertradeCardVisual } from './HypertradeCardVisual';
import { getIssuedCardLayout } from '../../assets/hypertradeCardLayout';
import { CardLimitRings } from './CardLimitRings';
import { CardSettingsSheet } from './CardSettingsSheet';
import { CardSecureFields, type CardSecureFieldsHandle } from './CardSecureFields';
import { CardRevealDevMock } from './CardRevealDevMock';
import {
  isCardRevealDevMockEnabled,
  mockCardPan,
  MOCK_CARD_EXPIRY,
  MOCK_CARD_CVV,
} from '../../lib/cardRevealDevMock';
import { AddToMobileWalletSheet } from './AddToMobileWalletSheet';
import {
  isMobileWalletProviderLinked,
  resolveMobileWalletOptions,
  type MobileWalletProvider,
} from '../../lib/mobileWallet';
import { BankPageHeader } from './BankPageHeader';
import {
  CurrencyAccountCard,
  // AddAccountTile, // trailing "Open new account" tile — re-enable when more currencies can be opened
} from './CurrencyAccountCard';
import { TransactionRow } from './TransactionRow';
import { BouncingDots } from '../BouncingDots';
import {
  BankTransactionListSkeleton,
  CurrencyAccountCarouselSkeleton,
} from '../skeleton/BankCashTabSkeleton';
import { BankCashContentSkeleton } from '../skeleton/BankDashboardSkeleton';
import { ShimmerBone, useShimmerX } from '../skeleton/ShimmerBone';
import { getUrTransactionRowKey } from '../../lib/urTransactionFormat';
import { txExplorerUrl } from '../../lib/explorer';
import { openHttpsUrl } from '../../lib/openHttpsUrl';
import { getDefaultMantleChainId } from '../../lib/mantleFiatBalance';
import { useDisplayCurrency } from '../../providers/CurrencyProvider';
import { kycCtaPhase, type KycCtaPhase } from '../../lib/sumsubKyc';
import { KycPromptScreen } from './KycPromptScreen';
import { CashHero, CardHero } from './BankKycHeroes';
import { RegionSelectButton } from './RegionSelectButton';
import { ResidenceSelectSheet } from './ResidenceSelectSheet';
import { FINMA_LOGO } from './FinmaPartnerNotice';
import type { UrCountry } from '../../lib/urSupportedCountries';
import { DigitalDepositBottomSheet } from './DigitalDepositBottomSheet';
import { AddMoneyChooserSheet, type AddMoneyChoice } from './AddMoneyChooserSheet';
import { BankTransferBottomSheet } from './BankTransferBottomSheet';
import { AccountInfoSheet } from './AccountInfoSheet';
import { ConvertBottomSheet } from './ConvertBottomSheet';
import { warmSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
// ON-CHAIN CARD BALANCES (disabled): CashTab used useSpendableMantleBalances to
// overlay Mantle spendable reads on carousel cards + headline total. Re-enable if
// indexer rounding/lag (e.g. JPY 721 vs 720.79) matters more than first-paint speed.
// import { useSpendableMantleBalances } from '../../hooks/useSpendableMantleBalances';
import { WithdrawBottomSheet } from './WithdrawBottomSheet';
import { SendBottomSheet } from './SendBottomSheet';
import { HypertradeUserTransferBottomSheet } from './HypertradeUserTransferBottomSheet';
import { InterestSignup } from './InterestSignup';
import { SelectRegionCta, BankApplyCtaLoading } from './SelectRegionCta';
import { BANK_KYC_PAUSED, BANK_SERVICE_PAUSED, BANK_DIGITAL_WITHDRAW_PAUSED } from '../../lib/bankKycPause';
import { BankMaintenanceBanner } from './BankMaintenanceBanner';
import type {
  CashAccountRow,
  UrBankAccount,
  UrTransaction,
  UrKycStatusResponse,
} from '../../lib/urApi';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ──────────────────────────────────────────────────────────────────────────── //
// Layout constants
// ──────────────────────────────────────────────────────────────────────────── //

const CARROUSEL_GAP = 12;
const CARROUSEL_SIDE_PAD = 20;
// Cards take ~78% of the screen so the next one peeks in (Wise-style).
const ACCOUNT_CARD_WIDTH = Math.round(SCREEN_WIDTH * 0.62);
const ACCOUNT_CARD_HEIGHT = Math.round(ACCOUNT_CARD_WIDTH * 0.62);

// Card-tab transaction types per UR. `CRD` is the confirmed card-spend code
// (authorize / increment / reverse all surface as CRD with merchant title,
// subtitle, mcc + "Refund (Card Spending)" for reversals). PAY/CSH kept as
// defensive aliases in case UR labels some card rows differently.
const CARD_TX_TYPES = new Set(['CRD', 'PAY', 'CSH']);

// Cold-start fast path fetches this many transactions (mirrors
// useUrAccount's TX_INITIAL_SIZE). If we got at least this many back there
// may be more, so we surface the "See all" CTA to fetch the full list.
const TX_INITIAL_FETCH = 5;

// ──────────────────────────────────────────────────────────────────────────── //
// Tab type
// ──────────────────────────────────────────────────────────────────────────── //

type Tab = 'cash' | 'card';

export function BankDashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  // Prefer Privy `useAuth` over zustand — store syncs in an effect after
  // `isReady`, so reading store here can flash SignedOut for one frame.
  const { isAuthenticated, getAccessToken, user } = useAuth();
  const connectedWalletAddress = useAppStore((s) => s.user?.wallet?.address ?? null);
  const markBankWithdrawIncoming = useFundsPendingStore((s) => s.setBankWithdraw);

  const [tab, setTab] = useState<Tab>('cash');
  // Add-money funnel: tap "Add money" → chooser sheet → either the existing
  // 7702/USDC sheet OR the new IBAN-display Cash sheet. Both states are
  // mutually exclusive in practice (chooser closes before child opens).
  const [chooserOpen, setChooserOpen] = useState(false);
  const [addMoneyOpen, setAddMoneyOpen] = useState(false);
  const [addCashOpen, setAddCashOpen] = useState(false);
  const [accountInfoOpen, setAccountInfoOpen] = useState(false);
  // Convert (FX) sheet — UR-internal USD24<->EUR24<->CHF24 swap on Mantle.
  // Submit is gated on UR-side Turnkey provisioning today (see
  // ConvertBottomSheet.tsx header notes). The sheet handles that gracefully.
  const [convertOpen, setConvertOpen] = useState(false);
  // Withdraw funnel — mirrors Add money: tap "Withdraw" → chooser sheet →
  // either the digital rail (fiat -> USDC to wallet) or the bank rail
  // (fiat -> external bank account). One button, two destinations.
  const [withdrawChooserOpen, setWithdrawChooserOpen] = useState(false);
  // Withdraw (cash-out) sheet — USD24/EUR24/CHF24 -> USDC via gasless EIP-2612
  // permit on-ramp (External Wallet Access). See WithdrawBottomSheet.tsx.
  // NOTE: submit is UR-region-gated on testnet today — sheet surfaces it as a
  // clean error; flow is otherwise fully wired (Adam pinged 2026-05-29).
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Send (cash pay-out) sheet — USD24/EUR24/CHF24 -> external bank account via
  // gasless EIP-2612 permit (External Wallet Access §6). Same testnet gates as
  // Withdraw (account limit + UR region); sheet surfaces them cleanly.
  // Reached via the withdraw chooser's "Bank transfer" card (no own button).
  const [sendOpen, setSendOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferCurrency, setTransferCurrency] = useState<string | null>(null);
  const [residenceOpen, setResidenceOpen] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<UrCountry | null>(null);
  // "haven't chosen yet" (→ Select your region) vs "My country isn't listed"
  // (→ notify-me waitlist).
  const [notListed, setNotListed] = useState(false);
  // ON-CHAIN CARD BALANCES (disabled): nonce bumped CashTab to revalidate Mantle
  // reads after refresh / post-tx. Cards now use UR API for instant paint; bottom
  // sheets still read on-chain via their own useSpendableMantleBalances hooks.
  // const [spendableRefreshNonce, setSpendableRefreshNonce] = useState(0);
  // const bumpSpendableRefresh = useCallback(() => {
  //   setSpendableRefreshNonce((n) => n + 1);
  // }, []);
  const {
    initializing,
    loading,
    balanceLoading,
    txLoading,
    serviceDown,
    link,
    profile,
    transactions,
    transactionsExpanded,
    expandTransactions,
    cashRows,
    usdRates,
    pendingIncoming,
    markIncoming,
    refresh,
    refreshSilent,
    startTransactionReconcilePoll,
  } = useUrAccount();

  // Reconcile balance + tx when returning to /bank (tab switch or stack pop)
  // without flashing the full-screen loaders.
  useFocusEffect(
    useCallback(() => {
      void refreshSilent();
      // bumpSpendableRefresh();
    }, [refreshSilent]),
  );

  // Cash route is only meaningful once UR has provisioned at least one IBAN
  // for the URID. We dim out the choice otherwise rather than hiding it,
  // so users know it's coming.
  const issuedBankAccounts: Record<string, UrBankAccount[]> = useMemo(() => {
    const raw = profile?.bankAccounts || {};
    const out: Record<string, UrBankAccount[]> = {};
    for (const [code, list] of Object.entries(raw)) {
      if (Array.isArray(list) && list.length > 0) {
        out[code.toUpperCase()] = list;
      }
    }
    return out;
  }, [profile?.bankAccounts]);

  // Bridged deposits still "incoming" — fed to the Add Money sheet so it can
  // refuse a new deposit while a prior one's source tx is unconfirmed (shared
  // Ambire nonce would make the second batch revert). Only entries with a
  // source tx hash qualify (same-chain Convert pills have none).
  const inFlightDeposits = useMemo(
    () =>
      Object.values(pendingIncoming).flatMap((e) =>
        (e.legTxHashes.length ? e.legTxHashes : e.sourceTxHash ? [e.sourceTxHash] : [])
          .map((h) => ({ sourceTxHash: h, sourceChainId: e.sourceChainId })),
      ),
    [pendingIncoming],
  );

  const hasIssuedIbans = Object.keys(issuedBankAccounts).length > 0;
  const urId = link?.ur_id ?? profile?.urId ?? null;
  const walletAddress = profile?.evmAddress ?? link?.evm_address ?? null;
  const privyUserId = user?.id ?? null;

  const isKycLive =
    profile?.chainStatus === 5 || isUrTestKycBypass(urId, privyUserId);
  const isFocused = useIsFocused();

  // Warm Mantle spendable balances so Convert / Send / Withdraw open instantly.
  useEffect(() => {
    if (!isAuthenticated || !walletAddress || !isKycLive) return;
    warmSpendableMantleBalances(getAccessToken, walletAddress);
  }, [isAuthenticated, walletAddress, isKycLive, getAccessToken]);

  /** Profile "Move" → /bank?addMoney=1 opens the add-money chooser once Live. */
  const { addMoney: addMoneyParam } = useLocalSearchParams<{ addMoney?: string }>();
  const wantAddMoneyChooser =
    addMoneyParam === '1' || addMoneyParam === 'true';
  const addMoneyNavHandledRef = useRef(false);

  useEffect(() => {
    if (!wantAddMoneyChooser) {
      addMoneyNavHandledRef.current = false;
      return;
    }
    if (addMoneyNavHandledRef.current || initializing || !isKycLive || !isFocused) return;

    addMoneyNavHandledRef.current = true;
    setTab('cash');
    // Open BEFORE clearing the param — clearing first re-runs this effect
    // with wantAddMoneyChooser=false and would cancel the pending open.
    const id = setTimeout(() => {
      setChooserOpen(true);
      router.setParams({ addMoney: '' });
    }, 400);
    return () => clearTimeout(id);
  }, [wantAddMoneyChooser, initializing, isKycLive, isFocused, router]);

  const handleAddMoneyChoice = useCallback((choice: AddMoneyChoice) => {
    if (choice === 'digital') setAddMoneyOpen(true);
    else if (choice === 'cash') setAddCashOpen(true);
  }, []);

  // Withdraw chooser routes to the same two rails in reverse: digital =
  // cash-out to USDC in the wallet, cash = pay-out to an external bank.
  const handleWithdrawChoice = useCallback((choice: AddMoneyChoice) => {
    if (choice === 'digital') {
      if (BANK_DIGITAL_WITHDRAW_PAUSED) return;
      setWithdrawOpen(true);
    } else if (choice === 'cash') {
      setSendOpen(true);
    }
  }, []);

  const handleDepositSuccess = useCallback(
    (
      incoming?: {
        currency: string;
        amount: number;
        sourceTxHash?: string;
        sourceChainId?: number;
      },
    ) => {
      if (incoming) {
        markIncoming(incoming.currency, incoming.amount, {
          sourceTxHash: incoming.sourceTxHash,
          sourceChainId: incoming.sourceChainId,
        }, { kind: 'deposit' });
      }
      // bumpSpendableRefresh();
      startTransactionReconcilePoll();
    },
    [markIncoming, startTransactionReconcilePoll],
  );

  // Self-serve KYC via wallet Full-Auth → Sumsub mobile SDK. The native SDK
  // only runs in a dev/production build (NFC); in Expo Go we surface a clear
  // "open in the app build" toast instead of crashing.
  const {
    kyc,
    startKyc,
    emailLinkOpen,
    closeEmailLink,
    handleEmailLinked,
  } = useBankKycStart({ onSuccess: () => void refresh() });
  const handleStartKyc = useCallback(
    (source: 'cash_tab' | 'card_tab' = 'cash_tab', step?: number | null) =>
      void startKyc(source, step),
    [startKyc],
  );

  // The region picker + apply/waitlist funnel is a PRE-URID gate: it exists so
  // a brand-new user can check country support (and join the waitlist for an
  // unsupported region) before minting. Once a URID is minted (`link`), the user
  // has already passed region gating and is mid-KYC — re-showing "Select your
  // region" on every relaunch would hide their real KYC state (e.g. "Under
  // review" / "Review & sign"), since ctaSlot replaces the primary CTA. So we
  // suppress the whole region/apply funnel for linked users.
  const isUridLinked = !!link;

  const regionSelector = isUridLinked ? undefined : (
    <RegionSelectButton
      selectedCountry={selectedCountry}
      onPress={() => setResidenceOpen(true)}
    />
  );

  const { applyMode, interestsLoaded, refreshInterests } = useBankApplyMode(
    selectedCountry,
    isAuthenticated,
    getAccessToken,
    notListed,
  );

  const applyCtaSlot = BANK_SERVICE_PAUSED ? undefined : BANK_KYC_PAUSED ? (
    <InterestSignup
      key="waitlist-paused"
      kind="bank"
      i18nPrefix="bankApply"
      onRegistered={refreshInterests}
      compact
    />
  ) : isUridLinked
    ? undefined
    : isAuthenticated && !interestsLoaded ? (
      <BankApplyCtaLoading compact />
    ) : applyMode === 'bank_waitlist' ? (
      <InterestSignup
        key={`waitlist-${selectedCountry?.code ?? 'globe'}`}
        kind="bank"
        i18nPrefix="bankApply"
        onRegistered={refreshInterests}
        compact
      />
    ) : applyMode === 'select_region' ? (
      <SelectRegionCta onPress={() => setResidenceOpen(true)} compact />
    ) : undefined;

  const cardTransactions = useMemo(
    () => transactions.filter((tx) => CARD_TX_TYPES.has(tx.type)),
    [transactions],
  );
  // Card spend (CRD/PAY/CSH) lives in the Card tab only; the Cash tab shows
  // the account-money feed (deposits, FX, withdrawals, payouts) so the two
  // tabs don't duplicate the same rows.
  const cashTransactions = useMemo(
    () => transactions.filter((tx) => !CARD_TX_TYPES.has(tx.type)),
    [transactions],
  );

  const onRefresh = useCallback(async () => {
    await refresh();
    // bumpSpendableRefresh();
  }, [refresh]);

  const handleTabSwitch = useCallback((next: Tab) => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
    setTab(next);
  }, []);

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <BankPageHeader backIcon="chevron-back" showNotifications={isAuthenticated} />
        {BANK_SERVICE_PAUSED ? <BankMaintenanceBanner /> : null}

        <View style={styles.tabBar}>
          <TabButton
            label={t('cash.tabCash')}
            icon="cash-outline"
            iconActive="cash"
            isActive={tab === 'cash'}
            onPress={() => handleTabSwitch('cash')}
          />
          <TabButton
            label={t('cash.tabCard')}
            icon="card-outline"
            iconActive="card"
            isActive={tab === 'card'}
            onPress={() => handleTabSwitch('card')}
          />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{
            paddingBottom: insets.bottom + 96,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            isAuthenticated ? (
              <RefreshControl
                refreshing={loading && !initializing}
                onRefresh={onRefresh}
                tintColor={colors.accent.gold}
              />
            ) : undefined
          }
        >
          {isAuthenticated && serviceDown && !BANK_SERVICE_PAUSED ? (
            <View style={styles.serviceBanner}>
              <Ionicons
                name="construct-outline"
                size={16}
                color={colors.accent.gold}
              />
              <Text style={styles.serviceBannerText}>
                {t('cash.serviceDown', 'Banking upgrade underway, retry shortly')}
              </Text>
            </View>
          ) : null}
          {tab === 'cash' ? (
            <CashTab
              isAuthenticated={isAuthenticated}
              initializing={initializing}
              balanceLoading={balanceLoading}
              txLoading={txLoading}
              link={link}
              urId={urId}
              privyUserId={privyUserId}
              chainStatus={profile?.chainStatus}
              kycStep={profile?.kycCurrentStep}
              onStartKyc={() => void handleStartKyc('cash_tab', profile?.kycCurrentStep)}
              kycBusy={kyc.launching}
              kycReview={kyc.status?.sumsub ?? null}
              regionSelector={regionSelector}
              applyCtaSlot={applyCtaSlot}
              cashRows={cashRows}
              usdRates={usdRates}
              pendingIncoming={pendingIncoming}
              transactions={cashTransactions}
              transactionsExpanded={transactionsExpanded}
              onExpandTransactions={expandTransactions}
              onSignIn={() => router.push('/login')}
              onAddMoney={() => setChooserOpen(true)}
              onConvert={() => setConvertOpen(true)}
              onWithdraw={() => setWithdrawChooserOpen(true)}
              onOpenAccountInfo={() => setAccountInfoOpen(true)}
              onSendToUser={(currency) => {
                setTransferCurrency(currency);
                setTransferOpen(true);
              }}
            />
          ) : (
            <CardTab
              isAuthenticated={isAuthenticated}
              initializing={initializing}
              link={link}
              privyUserId={privyUserId}
              chainStatus={profile?.chainStatus}
              kycStep={profile?.kycCurrentStep}
              onStartKyc={() => void handleStartKyc('card_tab', profile?.kycCurrentStep)}
              kycBusy={kyc.launching}
              regionSelector={regionSelector}
              applyCtaSlot={applyCtaSlot}
              cardTransactions={cardTransactions}
              onSignIn={() => router.push('/login')}
              usdRates={usdRates}
            />
          )}
        </ScrollView>
      </SafeAreaView>

      <AddMoneyChooserSheet
        visible={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={handleAddMoneyChoice}
        cashAvailable={hasIssuedIbans}
      />

      {/* Same chooser component, withdraw copy: digital = cash-out to USDC
        * (WithdrawBottomSheet), cash = pay-out to bank (SendBottomSheet). */}
      <AddMoneyChooserSheet
        mode="withdraw"
        visible={withdrawChooserOpen}
        onClose={() => setWithdrawChooserOpen(false)}
        onPick={handleWithdrawChoice}
      />

      <DigitalDepositBottomSheet
        visible={addMoneyOpen}
        onClose={() => setAddMoneyOpen(false)}
        cashRows={cashRows}
        inFlightDeposits={inFlightDeposits}
        onSuccess={handleDepositSuccess}
      />

      <BankTransferBottomSheet
        visible={addCashOpen}
        onClose={() => setAddCashOpen(false)}
        bankAccounts={issuedBankAccounts}
        urId={urId}
      />

      <AccountInfoSheet
        visible={accountInfoOpen}
        onClose={() => setAccountInfoOpen(false)}
        urId={urId}
        walletAddress={walletAddress}
        bankAccounts={issuedBankAccounts}
      />

      <ConvertBottomSheet
        visible={convertOpen}
        onClose={() => setConvertOpen(false)}
        cashRows={cashRows}
        // Rolling-30-day transfer limit (CHF, 2dp) from the profile the
        // dashboard already loaded — lets the sheet pre-flight a limit block
        // before the user signs, instead of burning a relayer tx on a revert.
        usedLimit={profile?.usedLimit}
        clientLimit={profile?.clientLimit}
        usdRates={usdRates}
        // Same pendingIncoming pattern as DigitalDepositBottomSheet —
        // the sheet emits the credited target amount, we snapshot the
        // current target-currency balance and let the hook poll until
        // it lands.
        onSuccess={(incoming) => {
          if (incoming) markIncoming(incoming.currency, incoming.amount, undefined, { kind: 'convert' });
          // bumpSpendableRefresh();
          startTransactionReconcilePoll();
        }}
      />

      <WithdrawBottomSheet
        visible={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        cashRows={cashRows}
        usedLimit={profile?.usedLimit}
        clientLimit={profile?.clientLimit}
        usdRates={usdRates}
        // Cash-out sends USDC cross-chain to the user's OWN connected wallet.
        // Surface a sticky "USDC incoming to Wallet Balance" banner (gated on
        // the dest chain being the wallet's Arbitrum, handled by the banner)
        // that self-clears once the USDC lands, then reconcile the tx list.
        onSuccess={(incoming) => {
          if (incoming) {
            markBankWithdrawIncoming(connectedWalletAddress, {
              amount: incoming.amount,
              startedAt: Date.now(),
              destChainId: incoming.destChainId,
            });
          }
          // bumpSpendableRefresh();
          startTransactionReconcilePoll();
        }}
      />

      <SendBottomSheet
        visible={sendOpen}
        onClose={() => setSendOpen(false)}
        cashRows={cashRows}
        // Same rolling-30-day limit pre-flight as Convert/Withdraw — all
        // outgoing fiat (incl. payouts) counts toward it.
        usedLimit={profile?.usedLimit}
        clientLimit={profile?.clientLimit}
        usdRates={usdRates}
        onSuccess={() => {
          // bumpSpendableRefresh();
          startTransactionReconcilePoll();
        }}
      />

      <HypertradeUserTransferBottomSheet
        visible={transferOpen}
        onClose={() => {
          setTransferOpen(false);
          setTransferCurrency(null);
        }}
        cashRows={cashRows}
        initialCurrency={transferCurrency}
        senderUrid={urId}
        usedLimit={profile?.usedLimit}
        clientLimit={profile?.clientLimit}
        usdRates={usdRates}
        onSuccess={() => {
          // bumpSpendableRefresh();
          startTransactionReconcilePoll();
          refresh();
        }}
      />

      <BankKycEmailLinkSheet
        visible={emailLinkOpen}
        onClose={closeEmailLink}
        onLinked={handleEmailLinked}
      />

      <ResidenceSelectSheet
        visible={residenceOpen}
        selectedCode={selectedCountry?.code ?? null}
        onClose={() => setResidenceOpen(false)}
        onSelect={(c) => {
          setSelectedCountry(c);
          setNotListed(false);
        }}
        onNotListed={() => {
          setSelectedCountry(null);
          setNotListed(true);
        }}
      />
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────── //
// Tab button
// ──────────────────────────────────────────────────────────────────────────── //

function TabButton({
  label,
  icon,
  iconActive,
  isActive,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tabButton, isActive && styles.tabButtonActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons
        name={isActive ? iconActive : icon}
        size={16}
        color={isActive ? colors.accent.gold : colors.text.tertiary}
      />
      <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ──────────────────────────────────────────────────────────────────────────── //
// Cash tab
// ──────────────────────────────────────────────────────────────────────────── //

/** Match `PENDING_INCOMING_POLL_MS` in useUrAccount — used when on-chain card overlay is enabled. */
// const SPENDABLE_BALANCE_POLL_MS = 8_000;

/** Map a KYC CTA phase (+ busy) to the primary button label. Shared by the
 *  Cash and Card KYC-gate screens so the step-aware copy stays consistent. */
function kycCtaLabel(t: TFunction, phase: KycCtaPhase, busy: boolean): string {
  if (busy) {
    return phase === 'sign' ? t('cash.kyc.ctaSigning') : t('cash.kyc.ctaBusy');
  }
  switch (phase) {
    case 'sign':
      return t('cash.kyc.ctaReviewSign');
    case 'review':
      return t('cash.kyc.ctaUnderReview');
    case 'rejected':
      return t('cash.kyc.ctaRetry');
    case 'continue':
      return t('cash.kyc.ctaContinue');
    default:
      return t('cash.kyc.ctaStart');
  }
}

interface CashTabProps {
  isAuthenticated: boolean;
  initializing: boolean;
  /** Balance / account cards still loading (post first-paint). */
  balanceLoading: boolean;
  /** Transaction list still loading. */
  txLoading: boolean;
  link: { ur_id: number } | null;
  urId: number | null;
  privyUserId: string | null;
  chainStatus: number | undefined;
  /** On-chain KYC step (0 UNKNOWN…3 SignFormA, 4 Review, 5 Rejected). Drives
   *  the step-aware CTA (sign / under-review / retry). */
  kycStep?: number | null;
  /** Launch the self-serve Sumsub KYC flow. */
  onStartKyc: () => void;
  /** True while the KYC SDK / signing is in flight (disables the CTA). */
  kycBusy: boolean;
  /** Latest Sumsub review summary — used by the test-only status line. */
  kycReview?: UrKycStatusResponse['sumsub'] | null;
  regionSelector: React.ReactNode;
  applyCtaSlot?: React.ReactNode;
  cashRows: CashAccountRow[];
  // ON-CHAIN CARD BALANCES (disabled) — props for CashTab spendable overlay:
  // walletAddress: string | null;
  // getAccessToken: () => Promise<string | null>;
  // spendableRefreshNonce: number;
  /** Per-currency USD rate from Fiat24CryptoRelay (USD always 1). */
  usdRates: Record<string, number>;
  /** Currency code → in-flight amount waiting to land. Drives the
   *  "+X CCY incoming" pill on the matching CurrencyAccountCard. */
  pendingIncoming: Record<string, PendingIncomingEntry>;
  transactions: UrTransaction[];
  /** True once the full transaction list has been fetched. */
  transactionsExpanded: boolean;
  /** Fetch the full transaction list (deferred behind "See all"). */
  onExpandTransactions: () => void;
  onSignIn: () => void;
  onAddMoney: () => void;
  onConvert: () => void;
  /** Opens the withdraw chooser (digital rail or bank rail) — the bank
   *  pay-out ("Send") no longer has its own quick-action button. */
  onWithdraw: () => void;
  onOpenAccountInfo: () => void;
  onSendToUser: (currency: string) => void;
}

function CashTab({
  isAuthenticated,
  initializing,
  balanceLoading,
  txLoading,
  link,
  urId,
  privyUserId,
  chainStatus,
  kycStep,
  onStartKyc,
  kycBusy,
  kycReview,
  regionSelector,
  applyCtaSlot,
  cashRows,
  usdRates,
  pendingIncoming,
  transactions,
  transactionsExpanded,
  onExpandTransactions,
  onSignIn,
  onAddMoney,
  onConvert,
  onWithdraw,
  onOpenAccountInfo,
  onSendToUser,
}: CashTabProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const handleOpenKycHelp = useCallback(() => {
    router.push('/bank-faq/kycDocuments');
  }, [router]);
  const { formatDisplayPrice, meta, isConverted } = useDisplayCurrency();
  const [seeAll, setSeeAll] = useState(false);

  // Defined here (before any early return) so hook order stays stable across
  // renders — moving it below the `initializing`/KYC guards would trip
  // React's "rendered more hooks than during the previous render".
  const handleSeeAll = useCallback(() => {
    if (!transactionsExpanded) {
      // First expand → fetch the full list from the server.
      onExpandTransactions();
    }
    setSeeAll((s) => !s);
  }, [transactionsExpanded, onExpandTransactions]);

  const isKycLive =
    chainStatus === 5 || isUrTestKycBypass(urId, privyUserId);

  /*
   * ON-CHAIN CARD BALANCES (disabled): overlay Mantle spendable reads on carousel
   * cards + headline total for indexer-accurate amounts (e.g. JPY 720.79 not 721).
   * Tradeoff: every bank tab visit waited on /ur/fx/info + RPC batch before cards
   * painted — too slow for a visual-first carousel. Cards use UR API again;
   * Convert / Send / Withdraw / P2P sheets still read on-chain for execution.
   *
   * const spendableBalances = useSpendableMantleBalances({
   *   active: isAuthenticated && isKycLive && !!walletAddress,
   *   walletAddress,
   *   getAccessToken,
   * });
   * const { revalidate: revalidateSpendable } = spendableBalances;
   *
   * useEffect(() => {
   *   if (spendableRefreshNonce === 0) return;
   *   void revalidateSpendable();
   * }, [spendableRefreshNonce, revalidateSpendable]);
   *
   * const hasPendingIncoming = Object.keys(pendingIncoming).length > 0;
   * const hadPendingIncomingRef = useRef(false);
   *
   * useEffect(() => {
   *   if (!isKycLive || !walletAddress || !hasPendingIncoming) return undefined;
   *   void revalidateSpendable();
   *   const id = setInterval(() => void revalidateSpendable(), SPENDABLE_BALANCE_POLL_MS);
   *   return () => clearInterval(id);
   * }, [isKycLive, walletAddress, hasPendingIncoming, revalidateSpendable]);
   *
   * useEffect(() => {
   *   if (hadPendingIncomingRef.current && !hasPendingIncoming) {
   *     void revalidateSpendable();
   *   }
   *   hadPendingIncomingRef.current = hasPendingIncoming;
   * }, [hasPendingIncoming, revalidateSpendable]);
   *
   * const displayCashRows = useMemo(() => {
   *   if (!spendableBalances.ready) return cashRows;
   *   return cashRows.map((row) => {
   *     const spendable = spendableBalances.byCurrency[row.currency];
   *     if (!spendable) return row;
   *     return {
   *       ...row,
   *       amount: spendable.amount,
   *       amountStr: spendable.amountStr,
   *     };
   *   });
   * }, [cashRows, spendableBalances.ready, spendableBalances.byCurrency]);
   *
   * const cardBalancePending =
   *   isKycLive &&
   *   !!walletAddress &&
   *   !balanceLoading &&
   *   cashRows.length > 0 &&
   *   !spendableBalances.ready;
   */

  const hasPendingIncoming = Object.keys(pendingIncoming).length > 0;

  // The total isn't trustworthy until balance has landed AND every non-USD
  // holding has an on-chain FX rate (Fiat24CryptoRelay). Cards render as
  // soon as balance lands; only the headline total waits.
  const nonUsdHoldings = cashRows.filter(
    (r) => r.currency !== 'USD' && r.amount > 0,
  );
  const hasFxRates =
    nonUsdHoldings.length === 0 ||
    nonUsdHoldings.every((r) => usdRates[r.currency] != null);
  const totalReady = !balanceLoading && hasFxRates;
  // ON-CHAIN CARD BALANCES (disabled): also gated headline total on spendable ready:
  // (!isKycLive || !walletAddress || spendableBalances.ready);
  // Keep bouncing dots until the USD-equivalent sum is complete. Do not gate
  // on `ratesLoading` — a silent focus refresh can finish balance first
  // without flipping that flag, which briefly showed USD-only totals when
  // EUR/JPY rates were still in flight (missing rate → 0 in the sum).
  const showTotalDots = !hasPendingIncoming && !totalReady;
  const showAccountsLoader = balanceLoading && cashRows.length === 0;

  if (!isAuthenticated) {
    return (
      <SignedOutBlock
        icon="lock-closed-outline"
        title={t('cash.signedOutTitle')}
        body={t('cash.signedOutBody')}
        ctaLabel={t('cash.signIn')}
        onPress={onSignIn}
      />
    );
  }

  if (initializing) {
    return <LoadingBlock />;
  }

  // No Tourist mode in HyperTrade: anyone who isn't `Live` on UR sees the
  // KYC sales pitch instead of the functional Cash tab. This covers:
  //   - users with no UR link yet (no URID minted)
  //   - users mid-KYC (Wait / Tourist / SoftBlocked / Closed)
  // Live users (chainStatus === 5) fall through to the IBAN + tx layout.
  if (!isKycLive) {
    const kycPhase = kycCtaPhase(kycStep, !!link);
    return (
      <KycPromptScreen
        hero={<CashHero />}
        badgeLabel={
          link
            ? t('cash.kyc.finishBadge')
            : t('cash.kyc.badge')
        }
        title={
          link
            ? t('cash.kyc.finishTitle')
            : t('cash.kyc.title')
        }
        subtitle={t('cash.kyc.subtitle')}
        features={[
          {
            icon: 'cash-outline',
            textLogo: FINMA_LOGO,
            text: t('cash.kyc.f1'),
          },
          {
            icon: 'card-outline',
            text: t('cash.kyc.f2'),
          },
          {
            icon: 'flash-outline',
            text: t('cash.kyc.f3'),
          },
          {
            icon: 'globe-outline',
            text: t('cash.kyc.f4'),
          },
        ]}
        ctaLabel={kycCtaLabel(t, kycPhase, kycBusy)}
        onStartKyc={onStartKyc}
        ctaDisabled={kycBusy || kycPhase === 'review'}
        ctaLoading={kycBusy}
        ctaSlot={applyCtaSlot}
        hideCta={BANK_SERVICE_PAUSED}
        showTermsFootnote={!applyCtaSlot && !BANK_SERVICE_PAUSED}
        onTermsPress={() => router.push('/terms')}
        regionSelector={BANK_SERVICE_PAUSED ? undefined : regionSelector}
        secondaryLabel={t('cash.kyc.helpLink')}
        onSecondary={handleOpenKycHelp}
      />
    );
  }

  // USD-equivalent total. Each non-USD balance is converted via the on-chain
  // Fiat24CryptoRelay rate (same source of truth as Convert). Only computed
  // once rates have settled — until then the header shows bouncing dots.
  const totalDisplay = cashRows.reduce((acc, r) => {
    const rate = usdRates[r.currency] ?? (r.currency === 'USD' ? 1 : 0);
    return acc + r.amount * rate;
  }, 0);

  // Header total only: USD-equivalent sum → user's homepage display currency.
  // Per-currency cards stay in native ledger currency.
  const totalFormatted = isConverted
    ? formatDisplayPrice(totalDisplay)
    : `≈ ${formatDisplayPrice(totalDisplay)}`;

  // We fetch the latest 5 on cold start and the full list on "See all".
  // `seeAll` only governs the client-side view once we've fetched ≥6.
  const visibleTransactions = seeAll ? transactions : transactions.slice(0, 6);

  return (
    <View>
      {/* TEMP (test only): the imported QA URID is chainStatus=5 (on-chain
        * Live) but kycCurrentStep=0 (never KYC'd), so it bypasses the gate.
        * This floating CTA lets us exercise the REAL Sumsub KYC flow without
        * losing dashboard access. Gated to the test URID only — never shown to
        * real users. Reuses the production `onStartKyc` launcher, so the
        * verification path we validate here is the same one the gate uses. */}
      {/*{isUrTestKycBypass(urId, privyUserId) ? (
        <TouchableOpacity
          style={styles.devVerifyButton}
          onPress={onStartKyc}
          disabled={kycBusy}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Verify identity (test)"
        >
          <Ionicons
            name="shield-checkmark-outline"
            size={16}
            color={colors.background.primary}
          />
          <Text style={styles.devVerifyButtonText}>
            {kycBusy ? 'Starting verification…' : 'Verify identity (test)'}
          </Text>
        </TouchableOpacity>
      ) : null}*/}
      {/* TEMP (test only): live KYC review outcome, so we can watch RED→GREEN
        * and see exactly which document to fix without running a script. */}
      {isUrTestKycBypass(urId, privyUserId) &&
      kycReview?.review_answer ? (
        <Text style={styles.devVerifyStatusText}>
          {`KYC: ${kycReview.review_answer}`}
          {kycReview.review_reject_type ? ` · ${kycReview.review_reject_type}` : ''}
          {kycReview.reject_labels && kycReview.reject_labels.length > 0
            ? `\n${kycReview.reject_labels.join(', ')}`
            : ''}
        </Text>
      ) : null}
      <View style={styles.greetingSection}>
        {urId != null ? (
          <TouchableOpacity
            style={styles.accountInfoChip}
            onPress={onOpenAccountInfo}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={t('cash.accountInfoA11y')}
          >
            <Ionicons name="person-circle-outline" size={20} color={colors.accent.gold} />
            <Text style={styles.accountInfoChipText}>
              {t('cash.accountInfo')}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.text.tertiary} />
          </TouchableOpacity>
        ) : null}
        {urId == null ? (
          <Text style={styles.greetingHello}>{t('cash.welcome')}</Text>
        ) : null}
        {showTotalDots ? (
          // No accurate number yet — bounce + opacity pulse (no shimmer sweep).
          <View style={styles.greetingTotalBlock}>
            <BouncingDots color={colors.text.primary} pulse />
            <Text style={styles.greetingTotalCue}>
              {t('cash.calculatingBalance', { currency: meta.code })}
            </Text>
          </View>
        ) : (
          <View style={styles.greetingTotalBlock}>
            <Text style={styles.greetingTotal}>{totalFormatted}</Text>
          </View>
        )}
      </View>

      {/* Quick actions — Add / Withdraw / Convert.
        *
        * HyperTrade context: we lead with Add money + Withdraw to reflect
        * the self-custody motto (users always see they can move funds out
        * at any time). UR's own UX guide groups "off-ramp" (USD24 -> USDC
        * to wallet) under "Convert", but for our audience "Withdraw" is
        * the clearer term and a stronger trust signal.
        *
        * Add and Withdraw are symmetric funnels: each opens a chooser sheet
        * with the same two rails (digital assets vs bank transfer).
        *
        *   - Add money: chooser → USDC -> USD24 (digital, gasless 7702 via
        *                /ur/deposit/execute-7702) OR SEPA/SWIFT in via IBAN.
        *   - Withdraw : chooser →
        *                digital: USD24/EUR24/CHF24 -> USDC to the wallet.
        *                WIRED via WithdrawBottomSheet → /ur/withdraw/{info,
        *                quote,execute}: gasless EIP-2612 permit on-ramp
        *                (External Mode; UR validates the permit + pays gas).
        *                bank: fiat out to an external bank account (cash
        *                pay-out). WIRED via SendBottomSheet → /ur/payout/*:
        *                gasless EIP-2612 permit → UR clientPayout (External
        *                Mode §6). Both share the testnet gates (account
        *                limit + UR region); the sheets surface them cleanly.
        *   - Convert  : intra-fiat FX swap, USD24 <-> EUR24 <-> CHF24
        *                (gasless via /ur/fx/execute-7702 + Fiat24CryptoRelay
        *                on Mantle). */}
      <View style={styles.quickActions}>
        <CardAction
          icon="add-outline"
          label={t('cash.addMoney')}
          onPress={onAddMoney}
        />
        <CardAction
          icon="arrow-down-outline"
          label={t('cash.withdraw')}
          onPress={onWithdraw}
        />
        <CardAction
          icon="swap-horizontal-outline"
          label={t('cash.convert')}
          onPress={onConvert}
        />
      </View>

      {showAccountsLoader ? (
        <CurrencyAccountCarouselSkeleton
          cardWidth={ACCOUNT_CARD_WIDTH}
          cardHeight={ACCOUNT_CARD_HEIGHT}
          sidePad={CARROUSEL_SIDE_PAD}
          gap={CARROUSEL_GAP}
        />
      ) : cashRows.length === 0 ? (
        <View style={styles.emptyAccountsBlock}>
          <Text style={styles.emptyAccountsText}>
            {t('cash.noAccounts')}
          </Text>
        </View>
      ) : (
        <>
          {/*
            Trailing "Open new account" tile — re-enable when more currencies can be opened:
            ListFooterComponent={() => (
              <AddAccountTile
                width={ACCOUNT_CARD_WIDTH}
                height={ACCOUNT_CARD_HEIGHT}
                onPress={() => showComingSoon(t)}
              />
            )}
          */}
          {/*
            ON-CHAIN CARD BALANCES (disabled): data={displayCashRows} balanceLoading={cardBalancePending}
          */}
          <FlatList
            data={cashRows}
            keyExtractor={(row) => row.currency}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: CARROUSEL_SIDE_PAD,
              gap: CARROUSEL_GAP,
              paddingTop: 4,
              paddingBottom: 8,
            }}
            snapToInterval={ACCOUNT_CARD_WIDTH + CARROUSEL_GAP}
            decelerationRate="fast"
            renderItem={({ item }) => (
              <CurrencyAccountCard
                row={item}
                width={ACCOUNT_CARD_WIDTH}
                height={ACCOUNT_CARD_HEIGHT}
                balanceLoading={balanceLoading}
                onSendToUser={() => onSendToUser(item.currency)}
              />
            )}
          />
        </>
      )}

      <TransactionsSectionHeader onOpenStatement={() => router.push('/bank-statement')} />

      {txLoading && transactions.length === 0 ? (
        <BankTransactionListSkeleton rowCount={4} />
      ) : visibleTransactions.length === 0 ? (
        <View style={styles.noTransactions}>
          <Ionicons name="receipt-outline" size={28} color={colors.text.muted} />
          <Text style={styles.noTransactionsText}>
            {t('cash.noTransactions')}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.transactionsList}>
            {visibleTransactions.map((tx, idx) => (
              <View key={getUrTransactionRowKey(tx, idx)}>
                <TransactionRow tx={tx} onPress={() => openTxOnExplorer(tx)} />
                {idx < visibleTransactions.length - 1 && (
                  <View style={styles.txDivider} />
                )}
              </View>
            ))}
          </View>
          {/* Show "See all" whenever we might have more than the initial
            * page (≥5 fetched and not yet expanded) or once the user has
            * expanded enough rows to collapse again. */}
          {(!transactionsExpanded && transactions.length >= TX_INITIAL_FETCH) ||
          transactions.length > 6 ? (
            <TouchableOpacity
              style={styles.seeAllFooter}
              onPress={handleSeeAll}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={seeAll ? t('cash.seeLess') : t('cash.seeAll')}
            >
              <Text style={styles.seeAllFooterText}>
                {seeAll ? t('cash.seeLess') : t('cash.seeAll')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────── //
// Card tab
// ──────────────────────────────────────────────────────────────────────────── //

interface CardTabProps {
  isAuthenticated: boolean;
  initializing: boolean;
  link: { ur_id: number } | null;
  privyUserId: string | null;
  chainStatus: number | undefined;
  kycStep?: number | null;
  onStartKyc: () => void;
  kycBusy: boolean;
  regionSelector: React.ReactNode;
  applyCtaSlot?: React.ReactNode;
  cardTransactions: UrTransaction[];
  onSignIn: () => void;
  usdRates: Record<string, number>;
}

function CardTab({
  isAuthenticated,
  initializing,
  link,
  privyUserId,
  chainStatus,
  kycStep,
  onStartKyc,
  kycBusy,
  regionSelector,
  applyCtaSlot,
  cardTransactions,
  onSignIn,
  usdRates,
}: CardTabProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const handleOpenKycHelp = useCallback(() => {
    router.push('/bank-faq/kycDocuments');
  }, [router]);
  const card = useUrCard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [revealReady, setRevealReady] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [panCopied, setPanCopied] = useState(false);
  const secureFieldsRef = useRef<CardSecureFieldsHandle>(null);
  const panCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walletRevealSessionRef = useRef(false);
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const [walletSheetProvider, setWalletSheetProvider] = useState<MobileWalletProvider>('apple_pay');
  const [walletSheetPreparing, setWalletSheetPreparing] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [creatingCard, setCreatingCard] = useState(false);

  const mobileWalletOptions = useMemo(
    () => resolveMobileWalletOptions({ cardCurrencies: card.card?.currencies }),
    [card.card?.currencies],
  );
  const showWalletButtons = card.available && mobileWalletOptions.length > 0;
  const showWalletSkeleton = mobileWalletOptions.length > 0 && !card.loaded;
  const { width: windowWidth } = useWindowDimensions();
  const issuedCardWidth = Math.max(240, Math.round(windowWidth - 64));
  const issuedCardLayout = useMemo(
    () => getIssuedCardLayout(issuedCardWidth),
    [issuedCardWidth],
  );

  const isTestBypass = isUrTestKycBypass(link?.ur_id, privyUserId);
  // Real Live users: silently load card data once so freeze/details are wired
  // to the backend. The test-bypass URID is skipped (no real issued card →
  // avoids a wallet-signature prompt that would only 404).
  React.useEffect(() => {
    return () => {
      if (panCopiedTimerRef.current) clearTimeout(panCopiedTimerRef.current);
    };
  }, []);

  const cardRevealMock = isCardRevealDevMockEnabled();
  const canRevealCard = Boolean(card.card?.cardToken) || cardRevealMock;
  const revealedDetails = useMemo(() => {
    if (!cardRevealMock || !revealReady) return undefined;
    return {
      pan: mockCardPan(card.card?.last4),
      expiry: MOCK_CARD_EXPIRY,
      cvv: MOCK_CARD_CVV,
    };
  }, [cardRevealMock, revealReady, card.card?.last4]);

  const handleRevealStatus = useCallback(
    (status: 'success' | 'copied' | 'error', reason?: string) => {
      if (status === 'success') {
        setRevealReady(true);
      } else if (status === 'copied') {
        setPanCopied(true);
        if (panCopiedTimerRef.current) clearTimeout(panCopiedTimerRef.current);
        panCopiedTimerRef.current = setTimeout(() => setPanCopied(false), 2000);
      } else if (status === 'error') {
        setWalletSheetOpen(false);
        setWalletSheetPreparing(false);
        if (walletRevealSessionRef.current) {
          setRevealed(false);
          setRevealReady(false);
        }
        setPanCopied(false);
        const detail = reason?.trim()
          ? reason.trim().length > 160
            ? `${reason.trim().slice(0, 157)}...`
            : reason.trim()
          : undefined;
        Toast.show({
          type: 'error',
          text1: t('cash.cardDetails.failed'),
          text2: detail,
          visibilityTime: detail ? 9000 : 2600,
        });
        // eslint-disable-next-line no-console
        console.log('[card reveal] failed:', reason ?? '(no reason)');
      }
    },
    [t],
  );

  React.useEffect(() => {
    if (walletSheetPreparing && revealReady) {
      setWalletSheetPreparing(false);
    }
  }, [walletSheetPreparing, revealReady]);

  const closeWalletSheet = useCallback(() => {
    setWalletSheetOpen(false);
    setWalletSheetPreparing(false);
  }, []);
  const { loaded: cardLoaded, loadCard } = card;
  React.useEffect(() => {
    // Auto-load card metadata for KYC-Live users AND configured test identities
    // (the sandbox test URID has a real issued card we want to surface).
    if (isAuthenticated && (chainStatus === 5 || isTestBypass) && !cardLoaded) {
      void loadCard();
    }
  }, [isAuthenticated, chainStatus, isTestBypass, cardLoaded, loadCard]);

  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.timing(slideUp, {
        toValue: 0,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeIn, slideUp]);

  if (!isAuthenticated) {
    return (
      <SignedOutBlock
        icon="card-outline"
        title={t('cash.cardSignedOutTitle')}
        body={t('cash.cardSignedOutBody')}
        ctaLabel={t('cash.signIn')}
        onPress={onSignIn}
      />
    );
  }

  if (initializing) {
    return <LoadingBlock />;
  }

  // KYC gate. Same model as the Cash tab: any non-Live user gets the
  // marketing/sales page with a Start KYC CTA instead of an inactive card.
  // Only the test URID bypasses (never `Live` on testnet); real users KYC.
  const isKycLive =
    chainStatus === 5 || isUrTestKycBypass(link?.ur_id, privyUserId);
  if (!isKycLive) {
    const kycPhase = kycCtaPhase(kycStep, !!link);
    return (
      <KycPromptScreen
        hero={<CardHero />}
        badgeLabel={
          link ? t('cash.kyc.cardFinishBadge') : t('cash.kyc.cardBadge')
        }
        title={t('cash.kyc.cardTitle')}
        subtitle={t('cash.kyc.cardSubtitle')}
        features={[
          {
            icon: 'phone-portrait-outline',
            text: t('cash.kyc.card.f1'),
          },
          {
            icon: 'logo-apple',
            text: t('cash.kyc.card.f2'),
          },
          {
            icon: 'cash-outline',
            text: t('cash.kyc.card.f3'),
          },
          {
            icon: 'earth-outline',
            text: t('cash.kyc.card.f4'),
          },
        ]}
        ctaLabel={kycCtaLabel(t, kycPhase, kycBusy)}
        onStartKyc={onStartKyc}
        ctaDisabled={kycBusy || kycPhase === 'review'}
        ctaLoading={kycBusy}
        ctaSlot={applyCtaSlot}
        hideCta={BANK_SERVICE_PAUSED}
        showTermsFootnote={!applyCtaSlot && !BANK_SERVICE_PAUSED}
        onTermsPress={() => router.push('/terms')}
        regionSelector={BANK_SERVICE_PAUSED ? undefined : regionSelector}
        secondaryLabel={t('cash.kyc.helpLink')}
        onSecondary={handleOpenKycHelp}
      />
    );
  }

  const handleCreateCard = async () => {
    if (creatingCard || card.loading) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync();
    setCreatingCard(true);
    try {
      const ok = await card.createCard();
      if (ok) {
        if (Platform.OS !== 'web') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
        Toast.show({
          type: 'success',
          text1: t('cash.card.createSuccessTitle', { defaultValue: 'Card created' }),
          text2: t('cash.card.createSuccessSubtitle', {
            defaultValue: 'Your virtual card is ready — tap View to see the details.',
          }),
          visibilityTime: 2800,
        });
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? '';
      Toast.show({
        type: 'error',
        text1: t('cash.card.createErrorTitle', { defaultValue: "Couldn't create card" }),
        text2: msg || t('cash.card.createErrorSubtitle', { defaultValue: 'Please try again in a moment.' }),
        visibilityTime: 3200,
      });
    } finally {
      setCreatingCard(false);
    }
  };

  const handleView = async () => {
    if (Platform.OS !== 'web') Haptics.selectionAsync();
    // Tapping again while revealed simply hides the details.
    if (revealed) {
      setRevealed(false);
      setRevealReady(false);
      setPanCopied(false);
      return;
    }
    if (revealBusy) return;
    setRevealBusy(true);
    try {
      if (cardRevealMock) {
        if (!card.loaded) {
          await card.loadCard();
        }
        setRevealReady(false);
        setRevealed(true);
        return;
      }
      // Always re-load /card so the display `cardToken` is fresh (UR expires it
      // after ~5 min). loadCard prompts one wallet signature — acceptable for a
      // sensitive reveal.
      const available = await card.loadCard();
      if (available) {
        setRevealReady(false);
        setRevealed(true);
      } else {
        Toast.show({
          type: 'info',
          text1: t('cash.cardSettings.lockedHint'),
          visibilityTime: 2200,
        });
      }
    } finally {
      setRevealBusy(false);
    }
  };

  const handleFreeze = () => {
    if (Platform.OS !== 'web') Haptics.selectionAsync();
    const next = !card.frozen;
    void card
      .setFrozen(next)
      .then(() => {
        Toast.show({
          type: 'success',
          text1: next ? t('cash.cardFrozen') : t('cash.cardUnfrozen'),
          visibilityTime: 1800,
        });
      })
      .catch(() => {
        Toast.show({ type: 'error', text1: t('cash.cardFreezeFailed') });
      });
  };
  const handleSettings = () => {
    if (Platform.OS !== 'web') Haptics.selectionAsync();
    setSettingsOpen(true);
  };
  const handleReportLost = () => {
    setSettingsOpen(false);
    showComingSoon(t, t('cash.cardSettings.report'));
  };
  const handleSelectCurrency = (currency: string) => {
    void card
      .setCurrency(currency)
      .then(() => {
        Toast.show({
          type: 'success',
          text1: t('cash.cardSettings.defaultCurrencyUpdated', { currency }),
          visibilityTime: 2000,
        });
      })
      .catch(() => {
        Toast.show({
          type: 'error',
          text1: t('cash.cardSettings.defaultCurrencyFailed'),
        });
      });
  };

  const handleAddToMobileWallet = async (provider: MobileWalletProvider) => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    if (walletBusy || revealBusy) return;

    const alreadyRevealed = revealed && revealReady;
    walletRevealSessionRef.current = !alreadyRevealed;
    setWalletBusy(true);
    setWalletSheetProvider(provider);
    setWalletSheetOpen(true);

    if (!alreadyRevealed) {
      setWalletSheetPreparing(true);
      setRevealReady(false);
      setRevealed(true);
    }

    try {
      if (cardRevealMock) {
        if (!card.loaded) {
          await card.loadCard();
        }
        return;
      }

      const available = await card.loadCard();
      if (!available) {
        closeWalletSheet();
        if (!alreadyRevealed) {
          setRevealed(false);
          setRevealReady(false);
        }
        Toast.show({
          type: 'info',
          text1: t('cash.cardSettings.lockedHint'),
          visibilityTime: 2200,
        });
        return;
      }

      if (!alreadyRevealed) {
        setRevealed(true);
      }
    } finally {
      setWalletBusy(false);
    }
  };

  return (
    <Animated.View style={{ opacity: fadeIn, transform: [{ translateY: slideUp }] }}>
      <View style={styles.cardVisualWrap}>
        <HypertradeCardVisual
          frozen={card.frozen}
          detailsLoading={!card.card?.last4 && !card.loaded && card.loading}
          last4={card.card?.last4}
          holderName={card.card?.cardHolder || undefined}
          maxWidth={issuedCardWidth}
          layout={issuedCardLayout}
          revealed={revealed && canRevealCard}
          revealLoading={revealed && canRevealCard && !revealReady}
          revealReady={revealed && revealReady}
          revealedDetails={revealedDetails}
          panCopied={panCopied}
          onCopyPan={() => secureFieldsRef.current?.copyPan()}
          secureContent={
            revealed && canRevealCard ? (
              cardRevealMock ? (
                <CardRevealDevMock
                  ref={secureFieldsRef}
                  last4={card.card?.last4}
                  onStatus={handleRevealStatus}
                />
              ) : card.card?.cardToken ? (
                <CardSecureFields
                  ref={secureFieldsRef}
                  cardToken={String(card.card.cardToken)}
                  layout={issuedCardLayout}
                  onStatus={handleRevealStatus}
                />
              ) : null
            ) : null
          }
        />
      </View>

      {!card.loaded ? (
        <CardActionsSkeleton />
      ) : card.available ? (
        <View style={styles.cardActionsRow}>
          <CardAction
            icon={revealed ? 'eye-off-outline' : 'eye-outline'}
            label={revealed ? t('cash.hide') : t('cash.view')}
            onPress={handleView}
            highlighted={revealed}
          />
          <CardAction
            icon={card.frozen ? 'snow' : 'snow-outline'}
            label={card.frozen ? t('cash.unfreeze') : t('cash.freeze')}
            onPress={handleFreeze}
            highlighted={card.frozen}
          />
          <CardAction
            icon="settings-outline"
            label={t('cash.settings')}
            onPress={handleSettings}
          />
        </View>
      ) : (
        // No card issued yet: the same template stays as a preview, but the
        // action row becomes a single "Create Card" CTA. On success the card
        // metadata loads and this swaps to the View / Freeze / Settings row.
        <View style={styles.createCardRow}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleCreateCard}
            disabled={creatingCard || card.loading}
            style={[styles.createCardBtn, (creatingCard || card.loading) && styles.createCardBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('cash.card.create', { defaultValue: 'Create Card' })}
          >
            <LinearGradient
              colors={[colors.accent.gold, colors.accent.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.createCardGradient}
            >
              {creatingCard ? (
                <BouncingDots color={colors.background.primary} dotSize={5} style={styles.createCardDots} />
              ) : (
                <Ionicons name="card-outline" size={18} color={colors.background.primary} />
              )}
              <Text style={styles.createCardText}>
                {creatingCard
                  ? t('cash.card.creating', { defaultValue: 'Creating' })
                  : t('cash.card.create', { defaultValue: 'Create Card' })}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      {showWalletSkeleton ? (
        <WalletButtonsSkeleton count={mobileWalletOptions.length} />
      ) : showWalletButtons ? (
        <View style={styles.walletButtonsRow}>
          {mobileWalletOptions.map((option) => {
            const linked = isMobileWalletProviderLinked(card.card?.activeTokens, option.provider);
            const walletName = t(option.nameKey);
            return (
              <View key={option.provider} style={styles.walletButtonCell}>
                <WalletButton
                  logo={option.logo}
                  prefix={linked ? 'Added to' : 'Add to'}
                  name={walletName}
                  onPress={() => void handleAddToMobileWallet(option.provider)}
                  disabled={linked || walletBusy || revealBusy}
                  loading={walletBusy && walletSheetProvider === option.provider}
                  linked={linked}
                />
              </View>
            );
          })}
        </View>
      ) : null}

      <CardLimitRings limits={card.limits} usdRates={usdRates} />

      <TransactionsSectionHeader onOpenStatement={() => router.push('/bank-statement')} />

      {cardTransactions.length === 0 ? (
        <View style={styles.noTransactions}>
          <Ionicons name="card-outline" size={28} color={colors.text.muted} />
          <Text style={styles.noTransactionsText}>
            {t('cash.noCardTransactions')}
          </Text>
          <Text style={styles.noTransactionsHint}>
            {t('cash.noCardTransactionsHint')}
          </Text>
        </View>
      ) : (
        <View style={styles.transactionsList}>
          {cardTransactions.map((tx, idx) => (
            <View key={getUrTransactionRowKey(tx, idx)}>
              <TransactionRow tx={tx} onPress={() => openTxOnExplorer(tx)} />
              {idx < cardTransactions.length - 1 && (
                <View style={styles.txDivider} />
              )}
            </View>
          ))}
        </View>
      )}

      <CardSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        available={card.available}
        frozen={card.frozen}
        freezeBusy={card.loading}
        onToggleFreeze={handleFreeze}
        onReportLost={handleReportLost}
        onOpenNotifications={() => {
          setSettingsOpen(false);
          router.push('/bank-notifications?tab=card');
        }}
        cardCurrency={card.card?.currency ?? null}
        currencyBusy={card.currencyBusy}
        onSelectCurrency={handleSelectCurrency}
      />

      <AddToMobileWalletSheet
        visible={walletSheetOpen}
        onClose={closeWalletSheet}
        provider={walletSheetProvider}
        cardHolder={card.card?.cardHolder}
        preparing={walletSheetPreparing}
      />
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────────────────── //
// Transactions header
// ──────────────────────────────────────────────────────────────────────────── //

function TransactionsSectionHeader({
  onOpenStatement,
}: {
  onOpenStatement: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.transactionsHeader}>
      <Text style={styles.transactionsTitle}>{t('cash.transactions')}</Text>
      <TouchableOpacity
        onPress={onOpenStatement}
        style={styles.statementButton}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel={t('cash.statementA11y')}
      >
        <Ionicons name="document-text-outline" size={22} color={colors.text.primary} />
      </TouchableOpacity>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────── //
// Small shared blocks
// ──────────────────────────────────────────────────────────────────────────── //

function CardAction({
  icon,
  label,
  onPress,
  highlighted,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  highlighted?: boolean;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      style={styles.cardActionWrap}
    >
      <View
        style={[
          styles.cardActionCircle,
          highlighted && { borderColor: colors.accent.gold, backgroundColor: 'rgba(92,225,230,0.08)' },
        ]}
      >
        <Ionicons
          name={icon}
          size={20}
          color={highlighted ? colors.accent.gold : colors.text.primary}
        />
      </View>
      <Text
        numberOfLines={1}
        style={[styles.cardActionLabel, highlighted && { color: colors.accent.gold }]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function CardActionsSkeleton() {
  const shimmerX = useShimmerX([-80, 80]);
  return (
    <View style={styles.cardActionsRow} accessibilityLabel="Loading">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.cardActionWrap}>
          <ShimmerBone shimmerX={shimmerX} style={styles.cardActionCircleSkeleton} />
          <ShimmerBone shimmerX={shimmerX} style={styles.cardActionLabelSkeleton} />
        </View>
      ))}
    </View>
  );
}

function WalletButtonsSkeleton({ count }: { count: number }) {
  const shimmerX = useShimmerX([-120, 120]);
  return (
    <View style={styles.walletButtonsRow}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.walletButtonCell}>
          <ShimmerBone
            shimmerX={shimmerX}
            style={styles.walletButtonSkeleton}
          />
        </View>
      ))}
    </View>
  );
}

/** Bold label width ≈ fontSize * 0.62 per char — use measured slot, not adjustsFontSizeToFit (flaky on Android). */
function fitWalletLabelSize(text: string, slotWidth: number, maxSize: number, minSize: number) {
  if (slotWidth <= 0 || text.length === 0) return maxSize;
  const fitted = Math.floor(slotWidth / (text.length * 0.62));
  return Math.max(minSize, Math.min(maxSize, fitted));
}

function WalletButton({
  logo,
  prefix,
  name,
  onPress,
  disabled = false,
  linked = false,
  loading = false,
}: {
  logo: ImageSourcePropType;
  /** Short top line, e.g. "Add to" / "Added to" (kept English for all locales). */
  prefix: string;
  /** Brand line under prefix, e.g. "Google Wallet". */
  name: string;
  onPress: () => void;
  disabled?: boolean;
  linked?: boolean;
  loading?: boolean;
}) {
  // Measure the button, then budget text width (pad + icon + gap) so we can
  // center the icon+label cluster without a flex-stretched left-pinned column.
  const [labelWidth, setLabelWidth] = useState(0);
  const prefixSize = fitWalletLabelSize(prefix, labelWidth, 10, 8);
  const nameSize = fitWalletLabelSize(name, labelWidth, 13, 9);

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${prefix} ${name}`}
      style={[styles.walletButton, disabled && styles.walletButtonDisabled]}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        // 12+12 pad, 20 icon, 8 gap
        const budget = Math.max(0, w - 12 * 2 - 20 - 8);
        if (budget > 0 && budget !== labelWidth) setLabelWidth(budget);
      }}
    >
      <LinearGradient
        colors={
          linked
            ? [colors.background.tertiary, colors.background.tertiary]
            : [colors.background.elevated, colors.background.tertiary]
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.walletButtonGradient}
      >
        {loading ? (
          <ActivityIndicator size="small" color={colors.text.primary} />
        ) : linked ? (
          <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
        ) : (
          <Image source={logo} style={styles.walletButtonLogo} resizeMode="contain" />
        )}
        <View style={[styles.walletButtonTextWrap, labelWidth > 0 ? { maxWidth: labelWidth } : null]}>
          <Text
            style={[
              styles.walletButtonPrefix,
              { fontSize: prefixSize },
              linked && styles.walletButtonTextLinked,
            ]}
            numberOfLines={1}
          >
            {prefix}
          </Text>
          <Text
            style={[
              styles.walletButtonName,
              { fontSize: nameSize },
              linked && styles.walletButtonTextLinked,
            ]}
            numberOfLines={1}
          >
            {name}
          </Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function SignedOutBlock({
  icon,
  title,
  body,
  ctaLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  ctaLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.signedOutWrap}>
      <View style={styles.signedOutIconCircle}>
        <Ionicons name={icon} size={28} color={colors.accent.gold} />
      </View>
      <Text style={styles.signedOutTitle}>{title}</Text>
      <Text style={styles.signedOutBody}>{body}</Text>
      <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.signedOutButtonWrap}>
        <LinearGradient
          colors={[colors.accent.gold, colors.accent.purple]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.signedOutButton}
        >
          <Text style={styles.signedOutButtonText}>{ctaLabel}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

function LoadingBlock() {
  return <BankCashContentSkeleton />;
}


// ──────────────────────────────────────────────────────────────────────────── //
// Helpers
// ──────────────────────────────────────────────────────────────────────────── //

function showComingSoon(t: TFunction, feature?: string) {
  Toast.show({
    type: 'info',
    text1: feature ? t('cash.comingSoon', { feature }) : t('cash.comingSoonDefault'),
    visibilityTime: 1800,
  });
}

function openTxOnExplorer(tx: UrTransaction) {
  if (tx.txHashUrl) {
    void openHttpsUrl(tx.txHashUrl).catch(() => {});
    return;
  }
  // UR fiat rails settle on Mantle; map to the active env's explorer.
  const url = tx.txHash ? txExplorerUrl(tx.txHash, getDefaultMantleChainId()) : null;
  if (url) void openHttpsUrl(url).catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────────── //
// Styles
// ──────────────────────────────────────────────────────────────────────────── //

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  headerRightSpacer: {
    width: 34,
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: colors.background.elevated,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  tabTextActive: {
    color: colors.accent.gold,
  },
  scroll: {
    flex: 1,
  },

  // Soft transient banner when UR's API gateway is down (HTTP 503). Shown
  // over the last-known data so the dashboard degrades gracefully.
  serviceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: `${colors.accent.gold}14`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}33`,
  },
  serviceBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.gold,
  },

  // Greeting
  greetingSection: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    gap: 8,
  },
  // TEMP (test only) — floating "Verify identity" CTA for the QA URID.
  devVerifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.accent.gold,
  },
  devVerifyButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.background.primary,
  },
  devVerifyStatusText: {
    marginHorizontal: 20,
    marginTop: 6,
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'center',
  },
  accountInfoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: `${colors.accent.gold}12`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}30`,
  },
  accountInfoChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent.gold,
  },
  greetingHello: {
    fontSize: 14,
    color: colors.text.tertiary,
    fontWeight: '500',
  },
  greetingTotal: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text.primary,
    letterSpacing: -0.5,
  },
  greetingTotalUnit: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  greetingTotalBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 38,
    alignSelf: 'center',
    maxWidth: '100%',
  },
  // Small "Calculating balance…" label under bouncing dots while total loads.
  greetingTotalCue: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.tertiary,
    textAlign: 'center',
  },
  // Quick actions — circle icons in a single row (Revolut/Card-tab style)
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    marginBottom: 18,
  },

  // Accounts carousel
  emptyAccountsBlock: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyAccountsText: {
    fontSize: 13,
    color: colors.text.tertiary,
  },

  // Transactions
  transactionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 20,
    marginBottom: 14,
  },
  statementButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transactionsTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text.primary,
  },
  seeAllFooter: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 2,
    marginBottom: 4,
  },
  seeAllFooterText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  transactionsList: {
    marginTop: 0,
    marginHorizontal: 4,
    backgroundColor: colors.background.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    overflow: 'hidden',
    marginBottom: 0,
  },
  txDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.primary,
    marginLeft: 64,
  },
  noTransactions: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  noTransactionsText: {
    fontSize: 13,
    color: colors.text.tertiary,
    fontWeight: '500',
  },
  noTransactionsHint: {
    fontSize: 11,
    color: colors.text.muted,
    paddingHorizontal: 40,
    textAlign: 'center',
  },

  // Card tab visual
  cardVisualWrap: {
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 24,
  },
  cardActionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 42,
    marginBottom: 20,
  },
  createCardRow: {
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  createCardBtn: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  createCardBtnDisabled: {
    opacity: 0.6,
  },
  createCardGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  createCardText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
    letterSpacing: 0.2,
  },
  createCardDots: {
    marginBottom: -2,
  },
  cardActionWrap: {
    alignItems: 'center',
    gap: 6,
  },
  cardActionCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActionCircleSkeleton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  cardActionLabelSkeleton: {
    width: 40,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.background.tertiary,
  },
  cardActionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  walletButtonsRow: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'stretch',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  walletButtonCell: {
    flex: 1,
    minWidth: 0,
  },
  walletButton: {
    width: '100%',
    alignSelf: 'stretch',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  walletButtonSkeleton: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  walletButtonDisabled: {
    opacity: 0.72,
  },
  walletButtonGradient: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
  },
  walletButtonLogo: {
    width: 20,
    height: 20,
    flexShrink: 0,
  },
  walletButtonTextWrap: {
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 1,
  },
  walletButtonPrefix: {
    fontWeight: '600',
    color: colors.text.tertiary,
    letterSpacing: 0.2,
  },
  walletButtonName: {
    fontWeight: '700',
    color: colors.text.primary,
  },
  walletButtonTextLinked: {
    color: colors.accent.gold,
  },

  // Signed out / empty
  signedOutWrap: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 48,
    paddingBottom: 24,
    gap: 10,
  },
  signedOutIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  signedOutTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
  },
  signedOutBody: {
    fontSize: 13,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 14,
  },
  signedOutButtonWrap: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  signedOutButton: {
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  signedOutButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.background.primary,
  },
});
