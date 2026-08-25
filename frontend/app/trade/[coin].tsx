import React, { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Keyboard,
  TextInput,
  Modal,
  ActivityIndicator,
  Image,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { PnlShareExportFrame } from '../../src/components/PnlShareExportFrame';
import { sharePnlPng } from '../../src/lib/sharePnlImage';
import ViewShot from 'react-native-view-shot';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchAssetDetail, fetchAssets, reportTrade } from '../../src/lib/api';
import { colors } from '../../src/theme/colors';
import { useAppStore } from '../../src/store/appStore';
import { AssetLogo } from '../../src/components/AssetLogo';
import { LeverageSlider } from '../../src/components/LeverageSlider';
import { TradeSimulator } from '../../src/components/TradeSimulator';
import { PortfolioTabs } from '../../src/components/PortfolioTabs';
import { TradingBookSwitcher } from '../../src/components/TradingBookSwitcher';
import { FloatingTradeAlert } from '../../src/components/FloatingTradeAlert';
import { DemoBadge } from '../../src/components/DemoMode';
import { CurrencyHint } from '../../src/components/CurrencyHint';
import { BouncingDots } from '../../src/components/BouncingDots';
import { useSharedAiTradeGuard } from '../../src/hooks/useSharedAiTradeGuard';
import { useActiveTradingBook } from '../../src/hooks/useActiveTradingBook';
import { overlaySignerAgentActive, useSignerTradingSetup } from '../../src/hooks/useSignerTradingSetup';
import { useClaimBannerTopInset, useTopStripContentHeight } from '../../src/components/ClaimTradingCreditBanner';
import { cancelOpenOrder, canUseCrossOnAsset, computeUnifiedSpotTransferableUsd, ensureAgentKey, estimateRestingOrdersInitMarginByDex, estimateRestingOrdersInitMarginUsd, estimateSpotOpenOrdersUsdcHoldUsd, getActiveAssetData, getHip3FeeParams, getHyperliquidTradingState, getOpenOrders, getPerpMarginSupport, getPerpMarginTiers, getSpotAssetData, getSpotBuilderFeeTenthsBps, getSpotClearinghouseState, getSpotSymbolMap, getUserFees, getUserFills, getUserFunding, isBuilderFeeApproved, isPooledAccountMode, isOrderAvailableHydrated, isRateLimitError, isWalletTypedDataSigningError, marketClosePosition, marketCloseSpotPosition, mergeRestAndStreamOpenOrders, modifyOpenOrder, parseFeeRateDecimal, placeOrder, placeReduceOnlyTpslTrigger, placeSpotOrder, prewarmOrderCaches, rotateAgentKey, setupTradingAccount, transferUsdBetweenSpotAndPerp, isTradingSetupComplete, markTradingSetupComplete, getPerpOrderAcceptanceError, type Eip1193Provider } from '../../src/lib/hyperliquid';
import {
  computeProtocolFeeRates,
  DEFAULT_PERP_MAKER_RATE,
  DEFAULT_PERP_TAKER_RATE,
  DEFAULT_SPOT_MAKER_RATE,
  DEFAULT_SPOT_TAKER_RATE,
  parseDeployerFeeScale,
  resolveBaseFeeRate,
} from '../../src/lib/hip3Fees';
import { useBuilderConfig } from '../../src/providers/BuilderConfigProvider';
import { useActiveEthereumWallet } from '../../src/hooks/useActiveEthereumWallet';
import { useSeamlessSetup } from '../../src/providers/SeamlessSetupProvider';
import { useHyperliquidAccountStream } from '../../src/lib/useHyperliquidAccountStream';
import { SPOT_TOGGLE_WHITELIST } from '../../src/lib/spotToggleWhitelist';
import { demoAllowsSpot } from '../../src/lib/demo';
import { useLiveAssetCtxs, useLivePrices, useOrderBook } from '../../src/providers/WebSocketProvider';
import { getPriceLookupKeys, normalizeDexPriceKey, pickPrice } from '../../src/lib/priceKeys';
import { formatDisplaySymbol } from '../../src/lib/displaySymbols';
import { showToast, showSuccessToast, showErrorToast } from '../../src/lib/toast';
import { humanizeHyperliquidError } from '../../src/lib/hyperliquidErrors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSavedLeverage, saveLeverageForSymbol, getSavedMarginType, saveMarginTypeForSymbol } from '../../src/lib/leveragePrefs';
import { Analytics } from '../../src/lib/analytics';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../../src/providers/CurrencyProvider';
import { useAuth } from '../../src/providers/AuthContext';

export default function TradeScreen() {
  const { t } = useTranslation();
  const dc = useDisplayCurrency();
  const { coin, market: marketParam } = useLocalSearchParams<{ coin: string; market?: string }>();
  const router = useRouter();
  // `market=spot` preserves the spot-aware UX that the asset page hands off,
  // so the Trade screen opens on the spot side (market pill, order book,
  // spot balance) instead of the perp default. Only applied on the first
  // mount — if the user then toggles the market pill manually, that local
  // state takes over.
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const spotFromRoute = (typeof marketParam === 'string' ? marketParam : Array.isArray(marketParam) ? marketParam[0] : '').toLowerCase() === 'spot';
  const wantSpotInitial = demoAllowsSpot(tradingEnv) && spotFromRoute;
  const { isAuthenticated } = useAppStore();
  const { wallet: embeddedWallet, address: activeAddr } = useActiveEthereumWallet();
  const embeddedAddress = (activeAddr || '') as `0x${string}`;
  const {
    tradingAddress: activeTradingAddress,
    vaultAddress,
    isDedicatedBook,
    activeTradingBook,
  } = useActiveTradingBook();
  const signerSetup = useSignerTradingSetup(isDedicatedBook);
  /** HL clearinghouse / orders / fills address (Dedicated sub or Main). */
  const tradingAddress = (activeTradingAddress || embeddedAddress || '') as `0x${string}`;
  const insets = useSafeAreaInsets();
  // Top strip (claim or demo banner) absolute-positions over the screen top.
  // This page has no Header, so we shift our SafeAreaView off the top edge
  // and pad explicitly when the strip is active. Mirror of asset/[coin].
  const topStripActive = useClaimBannerTopInset();
  const topStripContentHeight = useTopStripContentHeight();
  const topPadding = topStripActive ? insets.top + topStripContentHeight : 0;
  const safeAreaEdges = (topStripActive ? ['left', 'right', 'bottom'] : undefined) as
    | undefined
    | ('top' | 'bottom' | 'left' | 'right')[];
  const safeAreaTopPad = topStripActive ? { paddingTop: topPadding } : undefined;
  const { builderFeeRate } = useBuilderConfig();
  const { getAccessToken } = useAuth();

  const [marketType, setMarketType] = useState<'perp' | 'spot'>(wantSpotInitial ? 'spot' : 'perp');
  const [showMarketTypeModal, setShowMarketTypeModal] = useState(false);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [leverage, setLeverage] = useState(5);
  const [sizeUsdText, setSizeUsdText] = useState('');
  const [orderType, setOrderType] = useState<
    | 'market'
    | 'limit'
    | 'stop_market'
    | 'stop_limit'
    | 'take_market'
    | 'take_limit'
  >('market');
  // Default to 'cross' to avoid an isolated→cross flash on the
  // overwhelmingly common case of opening the trade page on a non-HIP-3
  // asset. The category default and saved-pref effects below still take
  // over once they resolve, and the position-lock effect always wins
  // when there's an existing open position on this asset.
  const [marginMode, setMarginMode] = useState<'isolated' | 'cross'>('cross');
  const [marginModeTouched, setMarginModeTouched] = useState(false);
  const [limitPxText, setLimitPxText] = useState('');
  const [triggerPxText, setTriggerPxText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
  /** Last hydrated orderable USDC — avoids flashing dex-only / $0 mid-load. */
  const lastKnownOrderAvailableRef = useRef<number | null>(null);
  // Snapshot of the size UI at submit-start. Live available-margin props can
  // thrash mid-flight (JIT sendAsset, WS clearinghouse, spot refetch), which
  // used to make the % slider / $ size bounce even though the order already
  // captured a fixed notional. We paint from this snapshot until submit ends.
  const frozenSizeRef = useRef<{
    displaySizePct: number;
    sizeUsdText: string;
    sizeUsd: number;
    sizeUnits: number;
  } | null>(null);
  useEffect(() => {
    if (!isSubmitting) {
      frozenSizeRef.current = null;
    }
  }, [isSubmitting]);
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [closingPositionKey, setClosingPositionKey] = useState<string | null>(null);
  const [closeAllLoading, setCloseAllLoading] = useState(false);
  const [cancelAllLoading, setCancelAllLoading] = useState(false);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [slEnabled, setSlEnabled] = useState(false);
  const [tpPxText, setTpPxText] = useState('');
  const [slPxText, setSlPxText] = useState('');

  // Position TP/SL modal (for live positions)
  const [posTpslModal, setPosTpslModal] = useState<null | {
    coin: string;
    entrySide: 'long' | 'short';
    entryPx: number;
    markPx: number;
    sizeUnits: number;
    marginUsedUsd?: number;
    leverage?: number;
  }>(null);
  const [posTpEnabled, setPosTpEnabled] = useState(false);
  const [posSlEnabled, setPosSlEnabled] = useState(false);
  const [posTpPxText, setPosTpPxText] = useState('');
  const [posSlPxText, setPosSlPxText] = useState('');
  const [posTpslLoading, setPosTpslLoading] = useState(false);
  const [infoModal, setInfoModal] = useState<null | { title: string; body: string }>(null);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'toPerp' | 'toSpot'>('toPerp');
  const [transferAmountText, setTransferAmountText] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [balanceModalOpen, setBalanceModalOpen] = useState(false);
  const [confirmOrderModalOpen, setConfirmOrderModalOpen] = useState(false);
  const [skipOrderConfirm, setSkipOrderConfirm] = useState(false);
  const [showOrderTypeModal, setShowOrderTypeModal] = useState(false);
  const [pnlShareModal, setPnlShareModal] = useState<null | {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
    leverage?: number;
  }>(null);
  const [pnlShareLoading, setPnlShareLoading] = useState(false);
  const pnlShareRef = useRef<React.ElementRef<typeof ViewShot> | null>(null);
  const [showOrderBook, setShowOrderBook] = useState(false);

  // Hyperliquid-style sizing: user picks leverage, and a size-% slider chooses how much of your
  // *max usable margin* to use (after protocol fee headroom). Then:
  //   marginUsed = maxUsableMargin * pct
  //   orderValue = marginUsed * leverage
  const [sizePct, setSizePct] = useState(0); // 0..100
  const [sizeMode, setSizeMode] = useState<'manual' | 'pct'>('manual');
  // Bouncing-dots overlay while the derived USD amount catches up (slider / Max).
  const [showCalculating, setShowCalculating] = useState(false);
  const [calculatingLayerMounted, setCalculatingLayerMounted] = useState(false);
  const calculatingOpacity = useRef(new Animated.Value(0)).current;
  const calculatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerCalculating = useCallback(() => {
    setShowCalculating(true);
    setCalculatingLayerMounted(true);
    if (calculatingTimeoutRef.current) {
      clearTimeout(calculatingTimeoutRef.current);
    }
    calculatingOpacity.stopAnimation();
    Animated.timing(calculatingOpacity, {
      toValue: 1,
      duration: 140,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // Hold briefly, then ease dots out while digits ease back in.
    calculatingTimeoutRef.current = setTimeout(() => {
      Animated.timing(calculatingOpacity, {
        toValue: 0,
        duration: 260,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setCalculatingLayerMounted(false);
          setShowCalculating(false);
        }
      });
      calculatingTimeoutRef.current = null;
    }, 130);
  }, [calculatingOpacity]);

  useEffect(() => () => {
    if (calculatingTimeoutRef.current) {
      clearTimeout(calculatingTimeoutRef.current);
    }
  }, []);

  // TODO: (later) add an "All / This symbol" selector for filtering positions/orders.
  // For now we always show ALL positions/orders.
  // const [positionsScope, setPositionsScope] = useState<'all' | 'current'>('all');
  const [portfolioTab, setPortfolioTab] = useState<'positions' | 'orders' | 'history'>('positions');

  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const setupPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [orderSuccessAlert, setOrderSuccessAlert] = useState<{ title: string; message: string } | null>(null);
  const orderSuccessAlertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In-page error banner. The global toast (`showToast`) renders in the
  // root layout, BENEATH this screen's native modal presentation, so
  // order-failure messages were appearing on the parent asset page after
  // the modal animated out. Mirror the success alert pattern so errors
  // stay attached to where the user actually placed the order.
  const [orderErrorAlert, setOrderErrorAlert] = useState<{ title: string; message: string } | null>(null);
  const orderErrorAlertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  const [agentPrivateKey, setAgentPrivateKey] = useState<string | null>(null);

  const decodedCoin = decodeURIComponent(coin || '');

  const { guard: sharedAiGuard, modal: sharedAiModal } = useSharedAiTradeGuard({
    symbol: decodedCoin,
    marketType,
    enabled: isAuthenticated && !isDedicatedBook,
  });

  const showOrderSuccessAlert = useCallback(() => {
    if (orderSuccessAlertTimeoutRef.current) {
      clearTimeout(orderSuccessAlertTimeoutRef.current);
    }
    setOrderSuccessAlert({
      title: t('trading.orderSubmitted'),
      message: t('trading.orderSubmittedSuccess'),
    });
    orderSuccessAlertTimeoutRef.current = setTimeout(() => {
      setOrderSuccessAlert(null);
      orderSuccessAlertTimeoutRef.current = null;
    }, 3000);
  }, [t]);

  const showOrderErrorAlert = useCallback((message: string, title?: string) => {
    if (orderErrorAlertTimeoutRef.current) {
      clearTimeout(orderErrorAlertTimeoutRef.current);
    }
    setOrderErrorAlert({
      title: title || 'Order rejected',
      message,
    });
    orderErrorAlertTimeoutRef.current = setTimeout(() => {
      setOrderErrorAlert(null);
      orderErrorAlertTimeoutRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (orderSuccessAlertTimeoutRef.current) {
        clearTimeout(orderSuccessAlertTimeoutRef.current);
      }
      if (orderErrorAlertTimeoutRef.current) {
        clearTimeout(orderErrorAlertTimeoutRef.current);
      }
    };
  }, []);

  const { data: asset } = useQuery({
    queryKey: ['asset', decodedCoin],
    queryFn: () => fetchAssetDetail(decodedCoin),
    enabled: !!decodedCoin,
    staleTime: 10_000,
    // Funding / OI / 24h stats in the header come from this payload (price
    // itself is WS) — keep the 30s cadence the old global default provided.
    refetchInterval: 30_000,
  });
  const isSpotOnly = asset?.isSpotOnly === true;
  const { data: hip3AssetsData } = useQuery({
    queryKey: ['hip3-assets'],
    queryFn: fetchAssets,
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });


  // Single account WS retargets to active book (Main or Dedicated sub).
  const stream = useHyperliquidAccountStream();
  const streamMatchesBook =
    !!tradingAddress &&
    !!stream.subscribedUser &&
    stream.subscribedUser.toLowerCase() === tradingAddress.toLowerCase();
  // When WS is live, HL provides positions/account in real-time.
  // Reduce REST polling to infrequent safety-net refreshes.
  const hlWsLive = stream.isConnected;

  const spotPair = useMemo(() => asset?.spotSymbol || asset?.symbol || '', [asset?.spotSymbol, asset?.symbol]);
  const { data: tradingState, refetch: refetchTradingState, isLoading: tradingStateLoading } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, tradingAddress],
    queryFn: () => getHyperliquidTradingState(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
  });

  // True once the FIRST REST snapshot has landed (and stays true across
  // subsequent refetches because react-query keeps `data` while
  // re-fetching). Used to gate setup-state writes/reads that depend on
  // REST-only fields (e.g. `accountAbstractionMode`) which the WS
  // synthesizer can't produce on its own.
  const tradingStateReady = !tradingStateLoading && !!tradingState;

  const { data: openOrders, refetch: refetchOpenOrders, isLoading: openOrdersLoading } = useQuery({
    queryKey: ['hl_open_orders', tradingEnv, tradingAddress],
    queryFn: () => getOpenOrders(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
  });

  const { data: userFills, refetch: refetchUserFills } = useQuery({
    queryKey: ['hl_user_fills', tradingEnv, tradingAddress],
    queryFn: () => getUserFills(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const { data: userFunding } = useQuery({
    queryKey: ['hl_user_funding', tradingAddress],
    queryFn: () => getUserFunding(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: spotState, isFetched: spotStateFetched, refetch: refetchSpotState } = useQuery({
    queryKey: ['hl_spot_state', tradingEnv, tradingAddress],
    queryFn: () => getSpotClearinghouseState(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 10_000,
    refetchInterval: hlWsLive ? 60_000 : 15_000,
  });

  const { data: spotSymbolMap } = useQuery({
    queryKey: ['hl_spot_symbol_map', tradingEnv],
    queryFn: getSpotSymbolMap,
    staleTime: 5 * 60 * 1000,
  });

  const { data: spotAssetData } = useQuery({
    queryKey: ['hl_spot_asset', tradingEnv, spotPair],
    queryFn: () => getSpotAssetData(spotPair),
    enabled: !!spotPair,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const canToggleSpot = useMemo(() => {
    if (!demoAllowsSpot(tradingEnv)) return false;
    if (isSpotOnly) return true;

    const base = String(spotAssetData?.baseCoin || asset?.symbol || '').toUpperCase();
    const baseWithoutU = base.startsWith('U') && base.length > 1 ? base.slice(1) : base;

    // Only allow the toggle for curated spot symbols (mirrors the homepage
    // spot list). Keeps users on deep perp books for coins with thin spot
    // liquidity (e.g. TAO, WLD) even if Hyperliquid lists a spot market.
    return !!spotAssetData?.spotSymbol && (SPOT_TOGGLE_WHITELIST.has(base) || SPOT_TOGGLE_WHITELIST.has(baseWithoutU));
  }, [tradingEnv, isSpotOnly, spotAssetData?.baseCoin, spotAssetData?.spotSymbol, asset?.symbol]);
  const spotAvailable = canToggleSpot;

  useEffect(() => {
    if (!demoAllowsSpot(tradingEnv) && marketType === 'spot') {
      setMarketType('perp');
    }
  }, [tradingEnv, marketType]);
  
  // Force spot mode for spot-only assets
  useEffect(() => {
    if (!demoAllowsSpot(tradingEnv)) return;
    if (isSpotOnly && marketType !== 'spot') {
      setMarketType('spot');
      setSide('long');
    }
  }, [tradingEnv, isSpotOnly, marketType]);

  // Reset to perp if user navigates to an asset that doesn't support spot
  useEffect(() => {
    if (marketType === 'spot' && !canToggleSpot && !isSpotOnly) {
      setMarketType('perp');
    }
  }, [canToggleSpot, isSpotOnly, marketType]);
  
  const orderBookCoin = useMemo(() => {
    if (marketType === 'spot') {
      return spotAssetData?.spotSymbol || asset?.spotSymbol || asset?.symbol || '';
    }
    const rawCoin = asset?.coin || '';
    if (rawCoin.includes(':')) return rawCoin;
    if (asset?.isHip3) return normalizeDexPriceKey(asset?.symbol || rawCoin, asset?.dex);
    return asset?.symbol || rawCoin;
  }, [asset?.coin, asset?.dex, asset?.isHip3, asset?.symbol, marketType, spotAssetData?.spotSymbol]);

  const { data: userFees } = useQuery({
    queryKey: ['hl_user_fees', tradingAddress],
    queryFn: () => getUserFees(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const hip3FeeCoin = asset?.isHip3 ? asset?.coin : undefined;
  const { data: hip3FeeParams } = useQuery({
    queryKey: ['hl_hip3_fee_params', hip3FeeCoin],
    queryFn: () => getHip3FeeParams(hip3FeeCoin!),
    enabled: !!hip3FeeCoin && String(hip3FeeCoin).includes(':'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Use asset.coin for margin tiers lookup (includes dex prefix for HIP-3 like "xyz:TSLA")
  const marginTiersCoin = asset?.isHip3 ? asset?.coin : asset?.symbol;
  const { data: marginTiers } = useQuery({
    queryKey: ['hl_margin_tiers', marginTiersCoin],
    queryFn: () => getPerpMarginTiers(marginTiersCoin!),
    enabled: !!marginTiersCoin,
    staleTime: 5 * 60 * 1000,
  });

  const { data: marginSupport } = useQuery({
    queryKey: ['hl_margin_support', marginTiersCoin],
    queryFn: () => getPerpMarginSupport(marginTiersCoin!),
    enabled: !!marginTiersCoin,
    staleTime: 5 * 60 * 1000,
  });

  // (Default margin mode per asset category is set further below, after
  // `currentPosition` is in scope, so the effect can bail when there's
  // an existing position to avoid a category-default → position-lock
  // flicker on entry.)

  // Reset "touched" when switching assets.
  useEffect(() => {
    if (!asset?.symbol) return;
    setMarginModeTouched(false);
  }, [asset?.symbol]);

  useEffect(() => {
    (async () => {
      const { agentPrivateKey: pk, agentAddress: addr } = await ensureAgentKey();
      setAgentPrivateKey(pk);
      setAgentAddress(addr);
    })();
  }, []);

  // Pre-warm order caches when asset is loaded to reduce order placement latency
  useEffect(() => {
    if (asset?.coin) {
      prewarmOrderCaches(asset.coin);
    }
  }, [asset?.coin]);

  const bookTradingState = useMemo(() => {
    const hip3Positions = (tradingState?.positions ?? []).filter((p: any) => String(p.coin).includes(':'));
    if (streamMatchesBook && stream.isConnected && stream.clearinghouseState) {
      const ch: any = stream.clearinghouseState;
      const streamAccountValue = parseFloat(ch?.marginSummary?.accountValue ?? '0') || 0;
      const streamCrossAccountValue = parseFloat(ch?.crossMarginSummary?.accountValue ?? '0') || 0;
      const streamCrossMaintMarginUsed = parseFloat(ch?.crossMaintenanceMarginUsed ?? '0') || 0;
      const streamWithdrawable = parseFloat(ch?.withdrawable ?? '0') || 0;
      const accountValueUsd = Number.isFinite(tradingState?.accountValueUsd) ? tradingState!.accountValueUsd : streamAccountValue;
      // Prefer REST-computed withdrawable when available (it now correctly
      // accounts for unified-mode resting orders + initial margins). Falls
      // back to HL's main-subaccount `withdrawable` field on stream-only
      // sessions.
      const withdrawableUsd = Number.isFinite(tradingState?.withdrawableUsd) ? tradingState!.withdrawableUsd : streamWithdrawable;
      // PERP-only equity (no spot). Stream's `marginSummary.accountValue`
      // is already perp-only for mainState; REST sums main + HIP3 dexes,
      // so prefer REST when available. Kept for display only — for liq
      // projections we use the per-dex cross-only value below instead.
      const perpAccountValueUsd = Number.isFinite(tradingState?.perpAccountValueUsd)
        ? tradingState!.perpAccountValueUsd
        : streamAccountValue;
      // Per-dex cross-only equity from `crossMarginSummary.accountValue`.
      // Stream carries this for the main dex only; HIP-3 dex values come
      // from the REST snapshot. This is the correct equity input for
      // HL's cross-liq formula — it excludes both spot balance and any
      // isolated-position equity that would otherwise inflate the
      // backing and push projected liq away from HL's reported numbers.
      // Build per-dex maps. Pull live values from BOTH the main
      // `clearinghouseState` and `clearinghouseStatesByDex` (delivered by
      // the `allDexsClearinghouseState` subscription, which carries
      // every HIP-3 dex too). This keeps HIP-3 cross-liq projections as
      // fresh as main-dex instead of relying on the 5s REST poll.
      const streamByDex: Record<string, any> = stream.clearinghouseStatesByDex ?? {};
      const perpCrossAccountValueByDex: Record<string, number> = {
        ...(tradingState?.perpCrossAccountValueByDex ?? {}),
      };
      const perpCrossMaintenanceMarginUsedByDex: Record<string, number> = {
        ...(tradingState?.perpCrossMaintenanceMarginUsedByDex ?? {}),
      };
      const perpWithdrawableByDex: Record<string, number> = {
        ...(tradingState?.perpWithdrawableByDex ?? {}),
      };
      const perpInitialMarginAvailableByDex: Record<string, number> = {
        ...(tradingState?.perpInitialMarginAvailableByDex ?? {}),
      };
      const isolatedMarginUsedByDex: Record<string, number> = {};
      const collectIso = (chState: any, dexKey: string) => {
        const positions = (chState?.assetPositions ?? []) as any[];
        positions.forEach((p) => {
          const lev = p?.position?.leverage;
          if (typeof lev !== 'object' || lev?.type !== 'isolated') return;
          const mu = parseFloat(p?.position?.marginUsed ?? '0');
          if (Number.isFinite(mu) && mu > 0) {
            isolatedMarginUsedByDex[dexKey] = (isolatedMarginUsedByDex[dexKey] ?? 0) + mu;
          }
        });
      };
      collectIso(ch, '');
      Object.entries(streamByDex).forEach(([dexName, chState]: [string, any]) => {
        if (dexName && chState) collectIso(chState, dexName);
      });

      // For Standard per-dex cross, HL liquidation docs use account_value
      // minus maintenance. `crossMarginSummary.accountValue` can be much
      // lower than the actual cross-backed account value after cross
      // positions exist (it behaved like remaining/free cross value in live
      // tests). Use marginSummary.accountValue minus isolated margin in the
      // same dex instead: isolated margin must not back cross liq, but the
      // remaining account value does.
      perpCrossAccountValueByDex[''] = Math.max(
        0,
        streamAccountValue - (isolatedMarginUsedByDex[''] ?? 0),
      ) || streamCrossAccountValue || tradingState?.perpCrossAccountValueByDex?.[''] || 0;
      perpCrossMaintenanceMarginUsedByDex[''] = streamCrossMaintMarginUsed
        || tradingState?.perpCrossMaintenanceMarginUsedByDex?.[''] || 0;
      perpInitialMarginAvailableByDex[''] = Math.max(
        0,
        streamAccountValue - (parseFloat(ch?.marginSummary?.totalMarginUsed ?? '0') || 0),
      );
      {
        const mainWd = parseFloat((ch as any)?.withdrawable ?? '0') || 0;
        perpWithdrawableByDex[''] = mainWd || tradingState?.perpWithdrawableByDex?.[''] || 0;
      }
      Object.entries(streamByDex).forEach(([dexName, chState]: [string, any]) => {
        if (!dexName || !chState) return;
        const av = parseFloat(chState?.crossMarginSummary?.accountValue ?? '0') || 0;
        const marginAv = parseFloat(chState?.marginSummary?.accountValue ?? '0') || 0;
        const marginUsed = parseFloat(chState?.marginSummary?.totalMarginUsed ?? '0') || 0;
        const mm = parseFloat(chState?.crossMaintenanceMarginUsed ?? '0') || 0;
        const wd = parseFloat(chState?.withdrawable ?? '0') || 0;
        const dexCrossEquity = Math.max(0, marginAv - (isolatedMarginUsedByDex[dexName] ?? 0));
        if (dexCrossEquity > 0) perpCrossAccountValueByDex[dexName] = dexCrossEquity;
        else if (av > 0) perpCrossAccountValueByDex[dexName] = av;
        if (mm >= 0) perpCrossMaintenanceMarginUsedByDex[dexName] = mm;
        if (wd >= 0) perpWithdrawableByDex[dexName] = wd;
        perpInitialMarginAvailableByDex[dexName] = Math.max(0, marginAv - marginUsed);
      });
      // Subtract resting orders' init-margin locks per-dex. HL's
      // `marginSummary.totalMarginUsed` only reflects FILLED positions —
      // a dex with two resting BRENTOIL limits otherwise looks
      // free even though each limit has reserved init margin out of
      // that dex's pool. Without this the HIP-3 slider cap
      // (`unifiedSpotTransferable + targetDexBalance`) overstates room
      // and HL rejects the next order at submit time.
      const restingOrdersInitMarginByDex = estimateRestingOrdersInitMarginByDex(stream.openOrders as any[]);
      for (const [dex, lock] of Object.entries(restingOrdersInitMarginByDex)) {
        if (perpInitialMarginAvailableByDex[dex] == null) continue;
        perpInitialMarginAvailableByDex[dex] = Math.max(
          0,
          perpInitialMarginAvailableByDex[dex] - (Number.isFinite(lock) ? lock : 0),
        );
      }
      // Unified-pool aggregates (live). In `unifiedAccount` /
      // `portfolioMargin` modes ALL USDC-backed cross dexes share one
      // pool; per-dex `crossMarginSummary.accountValue` is meaningless
      // (per HL docs). These three scalars are what TradeSimulator uses
      // to drive HL's exact liq formula in those modes.
      const totalCrossMaintenanceMarginUsedUsd = Object.values(perpCrossMaintenanceMarginUsedByDex)
        .reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      const totalIsolatedMarginUsedUsd = Object.values(isolatedMarginUsedByDex)
        .reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      // Total INITIAL margin used across every dex (main + HIP-3). Pairs with
      // `unifiedSpotTransferableUsd` below to match HL's strict spot-out
      // transfer constraint in unified mode.
      const totalCrossInitialMarginUsedUsdMain = (() => {
        const av = parseFloat(ch?.marginSummary?.accountValue ?? '0');
        const free = perpInitialMarginAvailableByDex[''] ?? 0;
        const used = (Number.isFinite(av) ? av : 0) - (Number.isFinite(free) ? free : 0);
        return Math.max(0, used);
      })();
      const totalCrossInitialMarginUsedUsdHip3 = Object.entries(streamByDex).reduce((sum, [dexName, st]: [string, any]) => {
        if (!dexName) return sum;
        const av = parseFloat((st as any)?.marginSummary?.accountValue ?? '0');
        const free = perpInitialMarginAvailableByDex[dexName] ?? 0;
        const used = (Number.isFinite(av) ? av : 0) - (Number.isFinite(free) ? free : 0);
        return sum + Math.max(0, used);
      }, 0);
      const totalCrossInitialMarginUsedUsd = totalCrossInitialMarginUsedUsdMain + totalCrossInitialMarginUsedUsdHip3;
      // Sum of |positionValue| across every CROSS position. Drives the 10%
      // floor in HL's `transfer_margin_required` rule (Margining docs).
      const sumCrossPositionValue = (assetPositions: any[]): number => {
        let s = 0;
        (assetPositions ?? []).forEach((ap) => {
          const lev = ap?.position?.leverage;
          const isCross = typeof lev === 'object' ? lev?.type === 'cross' : true;
          if (!isCross) return;
          const pv = Math.abs(parseFloat(ap?.position?.positionValue ?? '0'));
          if (Number.isFinite(pv)) s += pv;
        });
        return s;
      };
      const totalCrossPositionValueUsdMain = sumCrossPositionValue(ch?.assetPositions ?? []);
      const totalCrossPositionValueUsdHip3 = Object.entries(streamByDex).reduce((sum, [dexName, st]: [string, any]) => {
        if (!dexName) return sum;
        return sum + sumCrossPositionValue((st as any)?.assetPositions ?? []);
      }, 0);
      // HL's transfer rule (`max(initial, 0.10 × position_value)`) counts
      // RESTING limit orders' notional in `position_value`, not just open
      // positions. We pull the live open-orders list from the stream and
      // add their notional to the total so JIT funding pre-checks match
      // HL's actual server-side cap. Without this, a user with a $300
      // resting BTC limit and no positions still has $30 of spot locked,
      // but our slider would think the full spot pool is transferable
      // and JIT would be rejected with "Insufficient balance for token
      // transfer". Skip reduce-only / trigger / position-tpsl orders —
      // those don't reserve new margin.
      const sumOpenOrdersNotional = (orders: any[] | undefined): number => {
        if (!Array.isArray(orders)) return 0;
        let s = 0;
        for (const o of orders) {
          if (!o) continue;
          if (o.reduceOnly) continue;
          if (o.isTrigger) continue;
          if (o.isPositionTpsl) continue;
          const px = parseFloat(o?.limitPx ?? '0');
          const sz = parseFloat(o?.sz ?? o?.origSz ?? '0');
          if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
          const ntl = Math.abs(px * sz);
          if (Number.isFinite(ntl)) s += ntl;
        }
        return s;
      };
      const restingOrdersNotionalUsd = sumOpenOrdersNotional(stream.openOrders as any);
      const totalCrossPositionValueUsd =
        totalCrossPositionValueUsdMain +
        totalCrossPositionValueUsdHip3 +
        restingOrdersNotionalUsd;
      const spotStateLive = stream.spotState ?? null;
      const spotUsdcBalanceUsd = spotStateLive
        ? (() => {
            let total = 0;
            (spotStateLive?.balances ?? []).forEach((b: any) => {
              const coin = String(b?.coin ?? '').toUpperCase();
              const tokenIdx = b?.token;
              const isUsdc = coin === 'USDC' || tokenIdx === 0;
              if (!isUsdc) return;
              const v = parseFloat(b?.total ?? '0');
              if (Number.isFinite(v) && v > 0) total += v;
            });
            return total;
          })()
        : (tradingState?.spotUsdcBalanceUsd ?? 0);
      const spotUsdcHoldUsd = estimateSpotOpenOrdersUsdcHoldUsd(stream.openOrders as any);
      const hasBalance = accountValueUsd > 0.01 || withdrawableUsd > 0.01;
      const agentAddr = (stream.agentAddress as string | null)?.toLowerCase();
      const storedAgent = (agentAddress as string | null)?.toLowerCase();
      const isAgentActive = !!agentAddr && !!storedAgent && agentAddr === storedAgent && (stream.agentValidUntil ?? 0) > Date.now();
      // IMPORTANT: The stream agent fields are not always present/reliable.
      // Never override an "active" agent from the HTTP check with a false-y stream value.
      const httpAgentActive = !!tradingState?.isAgentActive;
      // Build cumFunding lookup from REST data (WS stream doesn't include it)
      const restCumFundingMap = new Map<string, any>();
      (tradingState?.positions ?? []).forEach((rp: any) => {
        if (rp.cumFunding) restCumFundingMap.set(rp.coin, rp.cumFunding);
      });
      const streamPositions = (ch?.assetPositions ?? []).map((p: any) => {
        const lev = p.position?.leverage;
        // Hyperliquid leverage can be an object { type: "cross"|"isolated", value: number } or just a number
        const marginType: 'cross' | 'isolated' =
          typeof lev === 'object' && lev?.type === 'cross' ? 'cross' : 'isolated';
        return {
          coin: p.position.coin,
          szi: p.position.szi,
          entryPx: p.position.entryPx,
          liquidationPx: p.position.liquidationPx,
          unrealizedPnl: p.position.unrealizedPnl,
          returnOnEquity: p.position.returnOnEquity,
          leverage: lev ?? null,
          marginUsed: p.position?.marginUsed ?? p.position?.marginUsedUsd ?? null,
          positionValue: p.position?.positionValue ?? p.position?.position_value ?? null,
          maxLeverage: p.position?.maxLeverage ?? null,
          marginType,
          cumFunding: p.position?.cumFunding ?? restCumFundingMap.get(p.position.coin) ?? null,
        };
      });
      // Live HIP-3 positions from `clearinghouseStatesByDex` (same WS
      // subscription that drives the per-dex margin maps above). Falls
      // back to REST `hip3Positions` if the stream entry is empty.
      const streamHip3Positions: any[] = [];
      Object.entries(streamByDex).forEach(([dexName, chState]: [string, any]) => {
        if (!dexName || !chState) return;
        const arr = (chState?.assetPositions ?? []) as any[];
        arr.forEach((p: any) => {
          const lev = p.position?.leverage;
          const marginType: 'cross' | 'isolated' =
            typeof lev === 'object' && lev?.type === 'cross' ? 'cross' : 'isolated';
          streamHip3Positions.push({
            coin: p.position.coin,
            szi: p.position.szi,
            entryPx: p.position.entryPx,
            liquidationPx: p.position.liquidationPx,
            unrealizedPnl: p.position.unrealizedPnl,
            returnOnEquity: p.position.returnOnEquity,
            leverage: lev ?? null,
            marginUsed: p.position?.marginUsed ?? p.position?.marginUsedUsd ?? null,
            positionValue: p.position?.positionValue ?? p.position?.position_value ?? null,
            maxLeverage: p.position?.maxLeverage ?? null,
            marginType,
            cumFunding: p.position?.cumFunding ?? restCumFundingMap.get(p.position.coin) ?? null,
          });
        });
      });
      const merged = new Map<string, any>();
      // Order: REST hip3 (oldest) → live stream hip3 (newer) → live main
      // (newest). Later writes win on key collision so live values trump
      // stale REST. Key by coin only (HL one-way mode → one position per
      // coin) so a same-coin size change overwrites instead of duplicates.
      [...hip3Positions, ...streamHip3Positions, ...streamPositions].forEach((p) =>
        merged.set(String(p.coin), p),
      );
      // Stable, deterministic ordering (alphabetical by symbol — same default
      // as Binance / Bybit / OKX). Hyperliquid's `assetPositions` array order
      // is not guaranteed to be stable between WS frames, so without sorting
      // here rows would visibly flip on every tick.
      const orderedPositions = Array.from(merged.values()).sort((a: any, b: any) =>
        String(a?.coin ?? '').localeCompare(String(b?.coin ?? ''), undefined, { sensitivity: 'base' }),
      );
      // Live unified-mode "free margin available for new MAIN-DEX orders":
      //   spotUsdc − isolated − existing cross initial margin
      //                       − resting orders' initial margin
      // HL's order-acceptance check is `accountValue ≥ initialMargin`, so
      // we subtract INITIAL (not maintenance) for both positions and
      // resting limit orders. Stream-driven so it tracks limit
      // place/cancel events instantly — without it, the slider/Max for
      // main-DEX BTC orders sees the full pool as available even after
      // the user has resting limits and HL rejects the next placement.
      const restingOrdersInitMarginUsdLive = estimateRestingOrdersInitMarginUsd(stream.openOrders as any);
      // Spot → perp transferable budget for unified mode using HL's
      // documented `max(initial, 0.10 × position_value)` rule. Resting
      // orders' init margin is also locked out of the spot pool (HL
      // doesn't surface those locks via `marginSummary.totalMarginUsed`
      // until they fill), so we pass it through here as well — without
      // this the HIP-3 slider lets users size into the
      // "Insufficient balance for token transfer" rejection path.
      const unifiedSpotTransferableUsd = computeUnifiedSpotTransferableUsd({
        spotUsdcBalanceUsd,
        totalCrossInitialMarginUsedUsd,
        totalCrossPositionValueUsd,
        totalIsolatedMarginUsedUsd,
        spotUsdcHoldUsd,
        restingOrdersInitMarginUsd: restingOrdersInitMarginUsdLive,
      });
      const isUnifiedAbstraction = isPooledAccountMode(tradingState?.accountAbstractionMode ?? null);
      const withdrawableUsdEffective = isUnifiedAbstraction
        ? Math.max(
            0,
            spotUsdcBalanceUsd
              - totalIsolatedMarginUsedUsd
              - totalCrossInitialMarginUsedUsd
              - restingOrdersInitMarginUsdLive,
          )
        : withdrawableUsd;
      return {
        accountValueUsd,
        perpAccountValueUsd,
        perpCrossAccountValueByDex,
        perpCrossMaintenanceMarginUsedByDex,
        perpWithdrawableByDex,
        perpInitialMarginAvailableByDex,
        accountAbstractionMode: tradingState?.accountAbstractionMode ?? null,
        userDexAbstractionEnabled: tradingState?.userDexAbstractionEnabled ?? null,
        spotUsdcBalanceUsd,
        spotUsdcHoldUsd,
        totalIsolatedMarginUsedUsd,
        totalCrossMaintenanceMarginUsedUsd,
        totalCrossInitialMarginUsedUsd,
        totalCrossPositionValueUsd,
        unifiedSpotTransferableUsd,
        withdrawableUsd: withdrawableUsdEffective,
        hasBalance,
        isAgentActive: httpAgentActive || isAgentActive,
        positions: orderedPositions,
      };
    }
    return tradingState;
  }, [
    agentAddress,
    streamMatchesBook,
    stream.agentAddress,
    stream.agentValidUntil,
    stream.clearinghouseState,
    stream.clearinghouseStatesByDex,
    stream.isConnected,
    stream.openOrders,
    stream.spotState,
    tradingState,
  ]);
  const effectiveTradingState = overlaySignerAgentActive(bookTradingState, {
    isDedicatedBook,
    ready: signerSetup.ready,
    isAgentActive: signerSetup.isAgentActive,
  });

  const isHlPooledAccount = isPooledAccountMode(effectiveTradingState?.accountAbstractionMode);

  // Effective cross-margin availability for THIS user on THIS asset.
  //
  // `marginSupport.supportsCross` only reflects the asset's metadata
  // (whether the asset itself allows cross). On HIP-3 dexes, several
  // assets (e.g. xyz:TSLA) have `supportsCross=true` at the asset level,
  // but HL's protocol still REJECTS cross orders on them unless the user
  // is in `unifiedAccount` or `portfolioMargin` mode — standard / default
  // users get a "switch to unified margin" prompt from HL itself when
  // they try to open a cross order on these assets.
  //
  // Without this gate, standard-mode users could pick "cross" on a HIP-3
  // asset and our preview would silently fall back to isolated math
  // (because the unified-pool inputs are zero in standard mode), making
  // the projected liq look "stuck" regardless of size — and the order
  // would be rejected by HL anyway. Disabling the cross button matches
  // both HL's UI and what the protocol actually allows.
  const effectiveSupportsCross =
    !!marginSupport?.supportsCross &&
    canUseCrossOnAsset(!!asset?.isHip3, effectiveTradingState?.accountAbstractionMode ?? null);

  const mergedSpotBalances = useMemo(() => {
    const restBals = (spotState?.balances ?? spotState?.spotState?.balances ?? []) as any[];
    const restEscrows = (spotState?.evmEscrows ?? spotState?.spotState?.evmEscrows ?? []) as any[];
    const streamBals = (stream.spotState?.balances ?? stream.spotState?.spotState?.balances ?? []) as any[];
    const streamEscrows = (stream.spotState?.evmEscrows ?? stream.spotState?.spotState?.evmEscrows ?? []) as any[];
    const byCoin = new Map<string, any>();
    const putBalance = (b: any) => {
      const key = String(b?.coin ?? b?.token ?? '').toUpperCase();
      if (!key) return;
      const prev = byCoin.get(key);
      const nextTotal = parseFloat(String(b?.total ?? '0'));
      const prevTotal = parseFloat(String(prev?.total ?? '0'));
      if (!prev || (Number.isFinite(nextTotal) && nextTotal > Math.max(0, Number.isFinite(prevTotal) ? prevTotal : 0))) {
        byCoin.set(key, b);
      }
    };
    restBals.forEach(putBalance);
    restEscrows.forEach((b: any) => putBalance({ ...b, hold: '0', entryNtl: b?.entryNtl ?? '0', isEvmEscrow: true }));
    streamBals.forEach(putBalance);
    streamEscrows.forEach((b: any) => putBalance({ ...b, hold: '0', entryNtl: b?.entryNtl ?? '0', isEvmEscrow: true }));
    return Array.from(byCoin.values());
  }, [spotState, stream.spotState]);

  const spotBalances = useMemo(() => {
    const usdc = mergedSpotBalances.find((b: any) => String(b?.coin ?? '').toUpperCase() === 'USDC');
    const total = parseFloat(usdc?.total ?? '0');
    const hold = parseFloat(usdc?.hold ?? '0');
    const available = Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(hold) ? hold : 0));
    return {
      total: Number.isFinite(total) ? total : null,
      hold: Number.isFinite(hold) ? hold : null,
      available,
      hasData: !!usdc,
    };
  }, [mergedSpotBalances]);

  const spotBaseAvailable = useMemo(() => {
    const base = (spotAssetData?.baseCoin || asset?.symbol || '').toUpperCase();
    const baseBal = mergedSpotBalances.find((b: any) => String(b?.coin ?? '').toUpperCase() === base);
    const total = parseFloat(baseBal?.total ?? '0');
    const hold = parseFloat(baseBal?.hold ?? '0');
    const available = Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(hold) ? hold : 0));
    const minLot = Math.pow(10, -(spotAssetData?.szDecimals ?? 0));
    const sellableAvailable = Number.isFinite(minLot) && minLot > 0
      ? Math.floor((available + 1e-12) / minLot) * minLot
      : available;
    return {
      available: sellableAvailable,
      hasData: !!baseBal,
    };
  }, [asset?.symbol, spotAssetData?.baseCoin, spotAssetData?.szDecimals, mergedSpotBalances]);

  const effectiveOpenOrders = useMemo(
    () =>
      mergeRestAndStreamOpenOrders(
        openOrders,
        streamMatchesBook ? stream.openOrders : undefined,
        streamMatchesBook && stream.isConnected,
      ),
    [openOrders, streamMatchesBook, stream.isConnected, stream.openOrders],
  );

  const filteredPositions = useMemo(
    () => (effectiveTradingState?.positions ?? []) as any[],
    [effectiveTradingState?.positions],
  );

  const filteredOpenOrders = useMemo(
    () => (effectiveOpenOrders ?? []) as any[],
    [effectiveOpenOrders],
  );

  const filteredFills = useMemo(
    () => (userFills ?? []) as any[],
    [userFills],
  );

  const openOrderCoins = useMemo(() => {
    const coins = (filteredOpenOrders ?? [])
      .map((o: any) => String(o?.coin ?? o?.order?.coin ?? o?.o?.coin ?? ''))
      .filter(Boolean);
    return Array.from(new Set(coins)).sort();
  }, [filteredOpenOrders]);

  const { data: activeAssetData } = useQuery({
    queryKey: ['hl_active_asset_data', tradingAddress, openOrderCoins.join('|')],
    queryFn: async () => {
      if (!openOrderCoins.length) return {};
      const entries = await Promise.all(
        openOrderCoins.map(async (coin) => {
          try {
            const data = await getActiveAssetData(tradingAddress, coin);
            return [coin, data] as const;
          } catch {
            return [coin, null] as const;
          }
        }),
      );
      const map: Record<string, any> = {};
      entries.forEach(([coin, data]) => {
        if (data) map[coin] = data;
      });
      return map;
    },
    enabled: !!tradingAddress && openOrderCoins.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const combinedSpotBalances = useMemo(
    () => (stream.spotState?.balances ?? spotState?.balances ?? spotState?.spotState?.balances ?? []) as any[],
    [stream.spotState?.balances, spotState],
  );

  const liveCoins = useMemo(() => {
    const coins = [
      ...(filteredPositions ?? []).map((p: any) => String(p.coin)),
      ...(filteredOpenOrders ?? []).map((o: any) => String(o.coin)),
    ];
    if (orderBookCoin) coins.push(String(orderBookCoin));
    getPriceLookupKeys({ coin: asset?.coin, symbol: asset?.symbol, isHip3: asset?.isHip3 === true, dex: asset?.dex }).forEach((key) => coins.push(key));
    if (marketType === 'spot' && spotAssetData?.spotSymbol) {
      coins.push(String(spotAssetData.spotSymbol));
    }
    const uniq = Array.from(new Set(coins)).filter(Boolean) as string[];
    uniq.sort();
    return uniq;
  }, [asset?.coin, asset?.dex, asset?.isHip3, asset?.symbol, filteredOpenOrders, filteredPositions, marketType, orderBookCoin, spotAssetData?.spotSymbol]);

  const livePrices = useLivePrices(liveCoins);
  // `activeAssetCtx` is perp-only. Spot mode already skips, but spot-only
  // assets (KNTQ/USDT) default to marketType='perp' for a frame before the
  // force-spot effect runs — guard isSpotOnly so we never send
  // Invalid subscription {"type":"activeAssetCtx","coin":"KNTQ"}.
  const liveAssetCtxs = useLiveAssetCtxs(
    marketType !== 'spot' && !isSpotOnly && orderBookCoin ? [orderBookCoin] : [],
  );
  const [priceNow, setPriceNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setPriceNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, []);
  const getFreshLivePrice = useCallback(
    (coin?: string | null) => {
      if (!coin) return undefined;
      const live = livePrices?.[coin];
      if (!live?.price || !live.time) return undefined;
      return priceNow - live.time <= 10_000 ? live.price : undefined;
    },
    [livePrices, priceNow],
  );
  const getFreshPickedPrice = useCallback(
    (input: Parameters<typeof pickPrice>[1]) => {
      for (const key of getPriceLookupKeys(input)) {
        const value = getFreshLivePrice(key);
        if (value !== undefined) return value;
      }
      return undefined;
    },
    [getFreshLivePrice],
  );
  const hip3Prices = useMemo(() => {
    const map: Record<string, string> = {};
    const assets = hip3AssetsData?.assets ?? [];
    assets.forEach((a: any) => {
      if (a?.isHip3 && a?.coin && a?.markPx) {
        map[String(a.coin)] = String(a.markPx);
      }
    });
    return map;
  }, [hip3AssetsData]);

  // Refs for price-dependent callbacks to avoid recreating them on every price tick
  const livePricesRef = useRef(livePrices);
  const hip3PricesRef = useRef(hip3Prices);
  useEffect(() => { livePricesRef.current = livePrices; }, [livePrices]);
  useEffect(() => { hip3PricesRef.current = hip3Prices; }, [hip3Prices]);

  const fundingRates = useMemo(() => {
    const map: Record<string, string> = {};
    const assets = hip3AssetsData?.assets ?? [];
    assets.forEach((a: any) => {
      if (a?.coin && a?.funding != null) {
        map[String(a.coin)] = String(a.funding);
      }
    });
    if (asset?.coin && asset?.funding != null) {
      map[String(asset.coin)] = String(asset.funding);
    }
    return map;
  }, [asset?.coin, asset?.funding, hip3AssetsData]);

  const currentMidPx = useMemo(() => {
    if (marketType === 'spot') {
      const spotKey = spotAssetData?.spotSymbol;
      const liveSpot = getFreshLivePrice(spotKey);
      const raw = liveSpot ?? spotAssetData?.midPx ?? spotAssetData?.markPx ?? '';
      const v = parseFloat(String(raw));
      if (Number.isFinite(v) && v > 0) return v;
      return 0;
    }
    // Perp order entry / simulation must not fall back to REST asset marks.
    // A stale REST mark can make the chart, PnL, and liquidation preview
    // look like BTC is trading at a different level than the order book.
    const raw =
      liveAssetCtxs?.[orderBookCoin]?.markPx ??
      getFreshPickedPrice({ coin: orderBookCoin, symbol: asset?.symbol, isHip3: asset?.isHip3 === true }) ??
      pickPrice(hip3Prices, { coin: orderBookCoin, symbol: asset?.symbol, isHip3: asset?.isHip3 === true }) ??
      '';
    const v = parseFloat(String(raw));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [
    asset?.markPx,
    asset?.oraclePx,
    hip3Prices,
    getFreshPickedPrice,
    marketType,
    orderBookCoin,
    liveAssetCtxs,
    spotAssetData?.markPx,
    spotAssetData?.midPx,
    spotAssetData?.spotSymbol,
  ]);

  const currentPosition = useMemo(() => {
    if (!asset) return null;
    const normalize = (v?: string) => (v ?? '').toLowerCase();
    const candidates = [orderBookCoin, asset?.coin, asset?.symbol, decodedCoin]
      .filter(Boolean)
      .map((v) => normalize(String(v)));
    const pos = filteredPositions.find((p: any) => candidates.includes(normalize(String(p?.coin))));
    if (!pos) return null;
    const rawSize = parseFloat(String(pos?.szi ?? 0));
    if (!Number.isFinite(rawSize) || rawSize === 0) return null;
    const side: 'long' | 'short' = rawSize >= 0 ? 'long' : 'short';
    const entryPx = parseFloat(String(pos?.entryPx ?? 0));
    // Extract leverage value from object { type, value } or direct number
    const levObj = pos?.leverage;
    const leverageValue = typeof levObj === 'object' && levObj?.value != null
      ? parseFloat(String(levObj.value))
      : parseFloat(String(levObj ?? ''));
    const leverage = Number.isFinite(leverageValue) ? leverageValue : undefined;
    const marginUsedUsd = Number.isFinite(parseFloat(String(pos?.marginUsed ?? '')))
      ? parseFloat(String(pos?.marginUsed))
      : undefined;
    const positionValue = parseFloat(String(pos?.positionValue ?? pos?.position_value ?? ''));
    const markPx = Number.isFinite(positionValue) && positionValue > 0
      ? Math.abs(positionValue) / Math.abs(rawSize)
      : undefined;
    const marginType = pos?.marginType as 'cross' | 'isolated' | undefined;
    const liquidationPx = parseFloat(String(pos?.liquidationPx ?? ''));
    return {
      entryPx,
      side,
      sizeUnits: Math.abs(rawSize),
      leverage,
      marginUsedUsd,
      markPx,
      marginType,
      liquidationPx: Number.isFinite(liquidationPx) && liquidationPx > 0 ? liquidationPx : undefined,
      source: pos?.source as string | undefined,
    };
  }, [asset, decodedCoin, filteredPositions, orderBookCoin]);

  // Resting limit orders for the SAME asset also lock margin mode and
  // leverage. HL treats both as per-asset settings, so placing a new
  // order at a different mode/leverage silently mutates every existing
  // resting order on that coin (e.g. user reported a 20x cross limit
  // flipping to 10x isolated when they placed a second order).
  // We surface the resting-order's settings so the UI can mute the
  // conflicting toggles BEFORE the user places, mirroring how Binance /
  // Bybit handle this case.
  const restingOrderLockForCoin = useMemo(() => {
    if (!asset || marketType !== 'perp') return null;
    const normalize = (v?: string) => (v ?? '').toLowerCase();
    const candidates = [orderBookCoin, asset?.coin, asset?.symbol, decodedCoin]
      .filter(Boolean)
      .map((v) => normalize(String(v)));
    const matchingOrders = (filteredOpenOrders ?? []).filter((o: any) => {
      if (!o) return false;
      if (o.reduceOnly) return false;
      if (o.isTrigger) return false;
      if (o.isPositionTpsl) return false;
      return candidates.includes(normalize(String(o?.coin)));
    });
    if (matchingOrders.length === 0) return null;
    let lockedMarginType: 'cross' | 'isolated' | undefined;
    let lockedLeverage: number | undefined;
    for (const o of matchingOrders) {
      let mt: 'cross' | 'isolated' | undefined;
      if (o?.marginType === 'cross' || o?.marginType === 'isolated') {
        mt = o.marginType;
      } else if (o?.isCross === true) {
        mt = 'cross';
      } else if (o?.isCross === false) {
        mt = 'isolated';
      }
      if (mt && !lockedMarginType) lockedMarginType = mt;
      const rawLev = o?.leverage;
      let lev: number | undefined;
      if (rawLev != null) {
        const parsed = typeof rawLev === 'object'
          ? parseFloat(String(rawLev?.value ?? '0'))
          : parseFloat(String(rawLev));
        if (Number.isFinite(parsed) && parsed > 0) lev = Math.round(parsed);
      }
      if (lev != null && lockedLeverage == null) lockedLeverage = lev;
      if (lockedMarginType && lockedLeverage != null) break;
    }
    if (!lockedMarginType && lockedLeverage == null) return null;
    return {
      marginType: lockedMarginType,
      leverage: lockedLeverage,
      count: matchingOrders.length,
    };
  }, [asset, decodedCoin, filteredOpenOrders, marketType, orderBookCoin]);

  // Lock margin mode to match existing position — can't mix cross/isolated
  // on the same asset. If no position but resting orders exist, lock to
  // the resting order's margin type so we don't silently mutate it on the
  // next placement.
  useEffect(() => {
    const lockedTo = currentPosition?.marginType ?? restingOrderLockForCoin?.marginType;
    if (lockedTo && marginMode !== lockedTo) {
      setMarginMode(lockedTo);
    }
  }, [currentPosition?.marginType, marginMode, restingOrderLockForCoin?.marginType]);

  // Default margin mode per asset. Skipped entirely when the user already
  // has an open position on this asset — the position-lock effect above is
  // the single source of truth in that case.
  //
  // We used to hard-code `isHip3 → isolated` here, which was correct when
  // HL only supported isolated on HIP-3 dexes, but several HIP-3 assets
  // (e.g. TSLA on `xyz`) now support cross margin. The hard-coded override
  // silently flipped the user back to isolated even when they explicitly
  // chose cross, which made the size slider look broken for those assets:
  // `estimateLiqPriceIsolated` is size-independent at fixed leverage, so
  // the projected liq stayed flat regardless of order size.
  //
  // Now we default to 'cross' whenever the asset actually supports it
  // AND the user's account mode allows cross on this asset (HIP-3 cross
  // requires unified/portfolio mode). Saved-preference loader below
  // applies the user's last choice on top once it resolves.
  useEffect(() => {
    if (!asset?.symbol) return;
    if (marginModeTouched) return;
    if (currentPosition?.marginType) return;
    if (!marginSupport) return; // wait until we know if cross is supported
    setMarginMode(effectiveSupportsCross ? 'cross' : 'isolated');
  }, [asset?.symbol, currentPosition?.marginType, marginModeTouched, marginSupport, effectiveSupportsCross]);

  // Force-flip to isolated if we're currently on cross but the user's
  // mode (or the asset metadata) doesn't actually allow it — e.g. user
  // switched HL abstraction mode in another tab, or saved-pref restored
  // 'cross' on a HIP-3 asset for a standard-mode user.
  useEffect(() => {
    if (!marginSupport) return;
    if (currentPosition?.marginType) return; // existing position locks margin mode
    if (!effectiveSupportsCross && marginMode === 'cross') {
      setMarginMode('isolated');
    }
  }, [marginMode, marginSupport, effectiveSupportsCross, currentPosition?.marginType]);

  // Lock leverage to match existing isolated position OR matching resting
  // orders' leverage. HL applies leverage at the asset level — changing it
  // here would silently re-leverage every resting order for this coin.
  // (For CROSS this also matters: HL uses the asset-level cross leverage
  // for all cross positions/orders. Pro exchanges lock the slider in both
  // cases when something already exists on the asset.)
  useEffect(() => {
    if (marketType !== 'perp') return;
    let lockedLev: number | undefined;
    if (marginMode === 'isolated' && Number.isFinite(currentPosition?.leverage as number) && (currentPosition?.leverage as number) > 0) {
      lockedLev = Math.max(1, Math.round(currentPosition!.leverage as number));
    } else if (
      restingOrderLockForCoin?.leverage != null &&
      restingOrderLockForCoin?.marginType === marginMode
    ) {
      lockedLev = Math.max(1, restingOrderLockForCoin.leverage);
    }
    if (lockedLev && leverage !== lockedLev) setLeverage(lockedLev);
  }, [
    currentPosition?.leverage,
    leverage,
    marginMode,
    marketType,
    restingOrderLockForCoin?.leverage,
    restingOrderLockForCoin?.marginType,
  ]);

  const isLeverageLocked = !!(
    marketType === 'perp' &&
    (
      (marginMode === 'isolated' && currentPosition?.leverage) ||
      (
        restingOrderLockForCoin?.leverage != null &&
        restingOrderLockForCoin?.marginType === marginMode
      )
    )
  );

  useEffect(() => {
    (async () => {
      try {
        const [confirmPref, orderBookPref] = await Promise.all([
          AsyncStorage.getItem('pref_skip_order_confirm'),
          AsyncStorage.getItem('pref_show_order_book'),
        ]);
        setSkipOrderConfirm(confirmPref === '1');
        setShowOrderBook(orderBookPref === '1');
      } catch {
        setSkipOrderConfirm(false);
        setShowOrderBook(false);
      }
    })();
  }, []);

  const toggleOrderBook = useCallback(() => {
    setShowOrderBook((prev) => {
      const next = !prev;
      AsyncStorage.setItem('pref_show_order_book', next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);

  const persistSkipOrderConfirm = useCallback(async (next: boolean) => {
    setSkipOrderConfirm(next);
    try {
      if (next) {
        await AsyncStorage.setItem('pref_skip_order_confirm', '1');
      } else {
        await AsyncStorage.removeItem('pref_skip_order_confirm');
      }
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    // Reload the env-scoped setup-complete flag whenever the trading env
    // flips. The SecureStore key includes the env suffix (see envScopedKey
    // in hyperliquid.ts) so reading it after a flip returns the OTHER
    // env's value — which is what we want, but only AFTER we re-read it.
    let isMounted = true;
    isTradingSetupComplete()
      .then((complete) => {
        if (isMounted) setSetupComplete(complete);
      })
      .catch(() => {
        // ignore storage errors
      });
    return () => {
      isMounted = false;
    };
  }, [tradingEnv]);

  useEffect(() => {
    // Mark setup complete ONLY when all three are true:
    //   1. HL reports an active agent for the user, AND
    //   2. The user has approved a builder fee high enough to cover our
    //      currently-configured per-order fee for this builder address.
    //   3. The user is in unified/portfolio mode, so trade balance, spot, and
    //      HIP-3 perps share the same USDC pool.
    //
    // Why both: HL agents and builder approvals are independent on-chain
    // state. A user with an active agent but no builder approval can still
    // sign orders, but HL will reject them ("builder fee has not been
    // approved"). Marking setup complete based on agent alone — the previous
    // behaviour — left those users locked out of trading because the setup
    // modal was suppressed by the cached setupComplete=true flag.
    //
    // Both pieces of state are env-scoped (mainnet vs testnet) so this
    // effect re-runs naturally when the user flips trading env. The async
    // builder-fee check is guarded by an `aborted` flag so a fast env flip
    // doesn't race a stale `setSetupComplete(true)` into the wrong env.
    //
    // CRITICAL: Bail out while REST tradingState hasn't shipped yet.
    // During the brief gap on mount (or between focus refetches) the
    // WS-derived `effectiveTradingState` can light up with
    // `isAgentActive=true` while `accountAbstractionMode` is still null
    // (only REST carries it). Without this guard the else-branch below
    // would falsely downgrade an already-correct `setupComplete=true`
    // and pop the seamless-trading modal even though nothing changed
    // on HL — see report 2026-05 of the modal flashing on the asset
    // page after a user navigates back.
    // Dedicated books have no extraAgents. Agent / builder / pooled-mode
    // one-tap is always the master signer — never the selected sub.
    const setupReady = isDedicatedBook ? signerSetup.ready : tradingStateReady;
    const setupAgentActive = isDedicatedBook
      ? signerSetup.isAgentActive
      : !!effectiveTradingState?.isAgentActive;
    const setupAbstraction = isDedicatedBook
      ? signerSetup.accountAbstractionMode
      : (effectiveTradingState?.accountAbstractionMode ?? null);
    if (!setupReady) return;
    if (!setupAgentActive) {
      setSetupComplete(false);
      return;
    }
    if (!embeddedAddress) return;
    // Same defensive guard for `accountAbstractionMode`. With WS-only
    // sessions the synthesizer in `effectiveTradingState` falls back
    // to `tradingState?.accountAbstractionMode ?? null`, so this can
    // be null for a tick after a refetch that hasn't merged yet. Let
    // the next render with a confirmed value drive the decision.
    if (setupAbstraction == null) return;
    let aborted = false;
    (async () => {
      try {
        const approved = await isBuilderFeeApproved(embeddedAddress);
        if (aborted) return;
        if (approved && isPooledAccountMode(setupAbstraction)) {
          setSetupComplete(true);
          markTradingSetupComplete().catch(() => { /* ignore storage errors */ });
        } else {
          // Agent active but builder not approved → ensure the setup flow
          // can re-trigger. Don't downgrade an already-complete state if
          // it was set by a successful setupTradingAccount() in this
          // session — that path already verified both pieces.
          setSetupComplete(false);
        }
      } catch {
        // Network failure → leave setupComplete as-is. Order placement
        // will surface a clear error if the user tries to trade without
        // builder approval, and they can re-enter setup from there.
      }
    })();
    return () => { aborted = true; };
  }, [
    isDedicatedBook,
    signerSetup.ready,
    signerSetup.isAgentActive,
    signerSetup.accountAbstractionMode,
    tradingStateReady,
    effectiveTradingState?.isAgentActive,
    effectiveTradingState?.accountAbstractionMode,
    embeddedAddress,
  ]);

  // Silent seamless-trading setup (background) + auto-renew before agent
  // expiry. Privy embedded wallets sign without a popup and the builder fee is
  // disclosed in the ToS, so we no longer prompt up-front — the modal below is
  // only a FALLBACK when a silent first-run attempt fails.
  // Silent setup now runs app-wide in SeamlessSetupProvider so its quiet
  // retries survive navigation between screens. Here we just consume its status
  // for the fallback-modal gate, and pause it while a manual "Activate" runs.
  const {
    autoSetupInFlight,
    autoSetupFailed,
    setupComplete: globalSetupComplete,
    pauseAutoSetup,
    resumeAutoSetup,
    isExternalWalletUser,
    requestExternalSetup,
  } = useSeamlessSetup();

  // Reflect a confirmed global setup into local state immediately, rather than
  // waiting for the next REST/WS-driven auto-mark pass.
  useEffect(() => {
    if (globalSetupComplete) setSetupComplete(true);
  }, [globalSetupComplete]);

  useEffect(() => {
    // Active Trader state machine: if user has balance but setup is not
    // complete => prompt to setup.
    //
    // We gate on `!setupComplete` rather than just `!isAgentActive` because
    // "setup complete" is a stricter check (agent active, builder fee
    // approved, and unified/portfolio mode — see the auto-mark effect above). A user with agent active
    // but builder unapproved would otherwise be locked out: order placement
    // would fail with "builder fee has not been approved" and no UI surface
    // would re-trigger the setup modal that re-runs approveBuilderFee.
    //
    // The 1500ms delay still holds open the cross-device case: a user whose
    // agent + builder are already approved on HL but whose local
    // setupComplete cache is empty (fresh device) gets a moment for the
    // auto-mark effect to flip the flag silently before we'd prompt.
    //
    // We also wait for `tradingStateReady` before arming the prompt:
    // during the initial mount window WS-derived `hasBalance` can be
    // true while REST hasn't yet shipped `accountAbstractionMode`, and
    // the auto-mark effect above can't confirm setupComplete yet. Without
    // this guard the modal could pop transiently before settling closed.
    if (setupPromptTimeoutRef.current) {
      clearTimeout(setupPromptTimeoutRef.current);
      setupPromptTimeoutRef.current = null;
    }

    if (setupComplete) {
      if (!setupLoading) setShowSetupModal(false);
      return;
    }

    if (!tradingStateReady) return;

    if (effectiveTradingState?.hasBalance && !setupComplete) {
      setupPromptTimeoutRef.current = setTimeout(() => {
        // Fallback only: surface the modal once the silent attempt has failed.
        if (
          !setupLoading &&
          !setupComplete &&
          effectiveTradingState?.hasBalance &&
          autoSetupFailed &&
          !autoSetupInFlight &&
          // External wallets use the guided ExternalWalletSetupModal (rendered
          // app-wide in SeamlessSetupProvider), never this embedded fallback.
          !isExternalWalletUser
        ) {
          setShowSetupModal(true);
        }
      }, 1500);
    } else if (!setupLoading) {
      setShowSetupModal(false);
    }

    return () => {
      if (setupPromptTimeoutRef.current) {
        clearTimeout(setupPromptTimeoutRef.current);
        setupPromptTimeoutRef.current = null;
      }
    };
  }, [tradingStateReady, effectiveTradingState?.hasBalance, setupComplete, setupLoading, autoSetupFailed, autoSetupInFlight]);

  const handleClose = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.back();
  }, [router]);

  const handleSideChange = useCallback((newSide: 'long' | 'short') => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
    setSide(newSide);
  }, []);

  const sizeUsd = useMemo(() => {
    const raw = sizeUsdText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : 0;
  }, [sizeUsdText]);

  const handleSizeUsdChange = useCallback((txt: string) => {
    if (isSubmitting) return;
    setSizeMode('manual');
    setSizeUsdText(txt);
  }, [isSubmitting]);

  const oraclePx = useMemo(() => {
    if (marketType === 'spot') {
      const v = parseFloat(String(spotAssetData?.markPx ?? spotAssetData?.midPx ?? '0'));
      if (Number.isFinite(v) && v > 0) return v;
      return 0;
    }
    const v = parseFloat(asset?.oraclePx || asset?.markPx || '0');
    return Number.isFinite(v) ? v : 0;
  }, [asset?.oraclePx, asset?.markPx, marketType, spotAssetData?.markPx, spotAssetData?.midPx]);

  const maxLeverageFromTiers = useMemo(() => {
    if (!marginTiers || marginTiers.length === 0) return 0;
    return Math.max(...marginTiers.map((t) => Number(t.maxLeverage) || 0));
  }, [marginTiers]);
  const maxLeverage = Math.max(1, asset?.maxLeverage ?? 0, maxLeverageFromTiers || 0);
  
  // Load saved leverage when symbol changes
  useEffect(() => {
    if (!marginTiersCoin || !maxLeverage) return;
    let cancelled = false;
    (async () => {
      const saved = await getSavedLeverage(
        tradingAddress || null,
        marginTiersCoin,
        maxLeverage,
      );
      if (!cancelled) {
        setLeverage(saved);
      }
    })();
    return () => { cancelled = true; };
  }, [tradingAddress, marginTiersCoin, maxLeverage]);

  // Load saved margin type when symbol or margin support changes.
  // Skipped when the user already has an open position on this asset —
  // HL doesn't allow mixing cross/isolated on the same asset, so the
  // position-lock effect must win. Without this guard, the saved pref
  // can race in between the category-default and the position lock and
  // cause a visible flicker (cross → isolated → cross).
  useEffect(() => {
    if (!marginTiersCoin || !marginSupport) return;
    if (currentPosition?.marginType) return;
    let cancelled = false;
    (async () => {
      const saved = await getSavedMarginType(
        tradingAddress || null,
        marginTiersCoin,
        effectiveSupportsCross,
      );
      if (!cancelled && !marginModeTouched) {
        setMarginMode(saved);
      }
    })();
    return () => { cancelled = true; };
  }, [tradingAddress, marginTiersCoin, marginSupport, effectiveSupportsCross, marginModeTouched, currentPosition?.marginType]);

  // Clamp leverage if maxLeverage changes
  useEffect(() => {
    setLeverage((cur) => Math.min(Math.max(1, cur), maxLeverage));
  }, [maxLeverage]);

  // We update size immediately inside `handleLeverageSelect` to avoid flicker in margin calculations while dragging.

  const limitPx = useMemo(() => {
    const raw = limitPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [limitPxText]);

  const perpOrderEntryPx = useMemo(() => {
    if (marketType !== 'perp') return 0;
    const isLimitExecution =
      orderType === 'limit' ||
      orderType === 'stop_limit' ||
      orderType === 'take_limit';
    if (isLimitExecution && Number.isFinite(limitPx ?? NaN) && (limitPx as number) > 0) {
      return limitPx as number;
    }
    // Market-style perp previews and sizing must follow the live mid. REST
    // oracle/mark fallback caused stale BTC previews (e.g. sim at 78.4k
    // while the order book/fill was around 78.1k).
    return Number.isFinite(currentMidPx) && currentMidPx > 0 ? currentMidPx : 0;
  }, [currentMidPx, limitPx, marketType, orderType]);

  const sizeUnits = useMemo(() => {
    if (!sizeUsd) return 0;
    if (marketType === 'spot' && orderType === 'limit' && Number.isFinite(limitPx ?? NaN)) {
      return sizeUsd / (limitPx as number);
    }
    const px = marketType === 'perp' ? perpOrderEntryPx : oraclePx;
    if (!Number.isFinite(px) || px <= 0) return 0;
    return sizeUsd / px;
  }, [limitPx, marketType, orderType, oraclePx, perpOrderEntryPx, sizeUsd]);

  const triggerPx = useMemo(() => {
    const raw = triggerPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [triggerPxText]);

  // Trigger-order flags. `isStopOrder` / `isTakeOrder` only differ for
  // direction validation (stop fires in the loss direction, take in the
  // profit direction — see HL's rules). Everything else in the UI treats
  // them the same via `isTriggerOrder`.
  const isStopOrder = orderType === 'stop_market' || orderType === 'stop_limit';
  const isTakeOrder = orderType === 'take_market' || orderType === 'take_limit';
  const isTriggerOrder = isStopOrder || isTakeOrder;
  const isLimitStyleTrigger = orderType === 'stop_limit' || orderType === 'take_limit';

  const hlAvailableUsd = effectiveTradingState?.withdrawableUsd ?? 0;
  const hlMainPerpTransferAvailableUsd = useMemo(() => {
    const v = effectiveTradingState?.perpWithdrawableByDex?.[''];
    const n = typeof v === 'number' ? v : Number(v ?? NaN);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }, [effectiveTradingState?.perpWithdrawableByDex]);
  const showSpotPerpTransferLink = !isHlPooledAccount;
  const dexKeyForLiq = (() => {
    const c = String(asset?.coin ?? '');
    return c.includes(':') ? c.split(':')[0] : '';
  })();
  const hlPerpOrderMarginAvailableUsd =
    effectiveTradingState?.perpInitialMarginAvailableByDex?.[dexKeyForLiq];
  const hlTransferablePerpUsd = useMemo(() => {
    if (marketType !== 'perp') return 0;
    const byDex = effectiveTradingState?.perpWithdrawableByDex ?? {};
    return Object.entries(byDex).reduce((sum, [dex, value]) => {
      if (dex === dexKeyForLiq) return sum;
      const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }, [dexKeyForLiq, effectiveTradingState?.perpWithdrawableByDex, marketType]);
  // Order ceiling.
  //   • Standard mode + perp: target dex pool + perp-to-perp transferable.
  //   • Unified mode + main perp: pooled margin available (= withdrawableUsd).
  //   • Unified mode + HIP-3 perp: STRICT spot transferable + target dex
  //     pool. The strict number matches HL's `sendAsset(spot → <dex>)`
  //     check — sizing the slider above this would inevitably hit
  //     "insufficient balance" or "insufficient margin" rejections.
  const isHip3Order = marketType === 'perp' && !!dexKeyForLiq;
  const unifiedSpotTransferableUsd = useMemo(() => {
    if (!isHlPooledAccount) return 0;
    return computeUnifiedSpotTransferableUsd({
      spotUsdcBalanceUsd: effectiveTradingState?.spotUsdcBalanceUsd ?? 0,
      totalCrossInitialMarginUsedUsd: (effectiveTradingState as any)?.totalCrossInitialMarginUsedUsd ?? 0,
      totalCrossPositionValueUsd: (effectiveTradingState as any)?.totalCrossPositionValueUsd ?? 0,
      totalIsolatedMarginUsedUsd: effectiveTradingState?.totalIsolatedMarginUsedUsd ?? 0,
      spotUsdcHoldUsd: (effectiveTradingState as any)?.spotUsdcHoldUsd ?? 0,
      restingOrdersInitMarginUsd: estimateRestingOrdersInitMarginUsd(stream.openOrders as any),
    });
  }, [
    isHlPooledAccount,
    effectiveTradingState,
    stream.openOrders,
  ]);
  const hlOrderAvailableUsdRaw = (() => {
    if (marketType !== 'perp') return hlAvailableUsd;
    if (!isHlPooledAccount) {
      return Number.isFinite(hlPerpOrderMarginAvailableUsd ?? NaN)
        ? Math.max(0, hlPerpOrderMarginAvailableUsd as number) + hlTransferablePerpUsd
        : hlAvailableUsd;
    }
    if (isHip3Order) {
      const targetDexBalance = Number.isFinite(hlPerpOrderMarginAvailableUsd ?? NaN)
        ? Math.max(0, hlPerpOrderMarginAvailableUsd as number)
        : 0;
      return unifiedSpotTransferableUsd + targetDexBalance;
    }
    return hlAvailableUsd;
  })();
  // Prefer waiting over flashing HIP-3 dex leftover or $0 while mode / spot hydrate.
  const spotBalancesHydrated =
    !embeddedAddress ||
    !!stream.spotState ||
    spotStateFetched ||
    !!tradingState;
  const orderAvailableHydrated = isOrderAvailableHydrated({
    accountAbstractionMode: effectiveTradingState?.accountAbstractionMode,
    isHip3Order,
    spotBalancesHydrated,
  });
  if (orderAvailableHydrated && Number.isFinite(hlOrderAvailableUsdRaw)) {
    lastKnownOrderAvailableRef.current = Math.max(0, hlOrderAvailableUsdRaw);
  }
  const showOrderAvailableAmount =
    orderAvailableHydrated || lastKnownOrderAvailableRef.current != null;
  const hlOrderAvailableUsd = orderAvailableHydrated
    ? hlOrderAvailableUsdRaw
    : (lastKnownOrderAvailableRef.current ?? 0);
  const projectedPerpDexFundingUsd = useMemo(() => {
    const existingNotional = currentPosition && Number.isFinite(perpOrderEntryPx) && perpOrderEntryPx > 0
      ? currentPosition.sizeUnits * perpOrderEntryPx
      : 0;
    const isPureReduction =
      !!currentPosition &&
      currentPosition.side !== side &&
      Number.isFinite(existingNotional) &&
      sizeUsd <= existingNotional + 1e-9;
    if (marketType !== 'perp' || isHlPooledAccount || isPureReduction) return 0;
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(leverage) || leverage <= 0) return 0;
    if (!Number.isFinite(hlPerpOrderMarginAvailableUsd ?? NaN)) return 0;
    if (!Number.isFinite(hlTransferablePerpUsd) || hlTransferablePerpUsd <= 0) return 0;
    const requiredMarginWithBuffer = (sizeUsd / Math.max(1, leverage)) * 1.05;
    const shortfall = requiredMarginWithBuffer - Math.max(0, hlPerpOrderMarginAvailableUsd as number);
    return Math.max(0, Math.min(shortfall, hlTransferablePerpUsd));
  }, [
    isHlPooledAccount,
    hlPerpOrderMarginAvailableUsd,
    hlTransferablePerpUsd,
    leverage,
    marketType,
    currentPosition,
    perpOrderEntryPx,
    side,
    sizeUsd,
  ]);
  const availableUsd = hlOrderAvailableUsd;
  // Cross-margin equity for liq projection. Must be:
  //   • Cross-only for THIS asset's dex (HL keeps each dex's cross pool
  //     independent, and within a dex isolated equity is not part of the
  //     cross pool — see HyperliquidTradingState.perpCrossAccountValueByDex
  //     for full rationale).
  //   • Indexed by dex name (HIP-3 coins are encoded as 'dexName:SYMBOL';
  //     main-dex coins use key '').
  // Falls back to `hlAvailableUsd` (withdrawable) only when no per-dex
  // cross AV is known, which conservatively underestimates equity rather
  // than overestimating it.
  const hlCrossAccountValueUsd = useMemo(() => {
    let base =
      effectiveTradingState?.perpCrossAccountValueByDex?.[dexKeyForLiq] ?? hlAvailableUsd;
    if (!Number.isFinite(base) || base <= 0) return Math.max(0, base || 0);

    // `crossMarginSummary.accountValue` comes from the account-state stream,
    // which updates on account events (fills, funding, etc.), not every
    // `allMids` tick. A fast move in an existing BTC cross position can make
    // the raw stream accountValue stale, causing a brand-new ETH cross preview
    // to look dangerously close to mark. Bring the pool equity forward by
    // adding live PnL deltas for existing cross positions in this same dex.
    let adjusted = base + projectedPerpDexFundingUsd;
    const toNum = (x: any) => {
      const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
      return Number.isFinite(n) ? n : NaN;
    };
    const positions = (effectiveTradingState?.positions ?? []) as any[];
    positions.forEach((p) => {
      if (p?.marginType !== 'cross') return;
      const coin = String(p?.coin ?? '');
      const posDexKey = coin.includes(':') ? coin.split(':')[0] : '';
      if (posDexKey !== dexKeyForLiq) return;

      const szi = toNum(p?.szi);
      const absSzi = Math.abs(szi);
      if (!Number.isFinite(szi) || !Number.isFinite(absSzi) || absSzi <= 0) return;

      const liveRaw =
        getFreshPickedPrice({ coin, isHip3: posDexKey !== '' }) ??
        pickPrice(hip3Prices, { coin, isHip3: posDexKey !== '' });
      const livePx = toNum(liveRaw);
      if (!Number.isFinite(livePx) || livePx <= 0) return;

      const positionValue = toNum(p?.positionValue ?? p?.position_value ?? p?.notional);
      const streamMark =
        Number.isFinite(positionValue) && positionValue > 0
          ? Math.abs(positionValue) / absSzi
          : NaN;
      if (!Number.isFinite(streamMark) || streamMark <= 0) return;

      adjusted += (livePx - streamMark) * szi;
    });

    return Math.max(0, adjusted);
  }, [
    dexKeyForLiq,
    effectiveTradingState?.accountAbstractionMode,
    effectiveTradingState?.perpCrossAccountValueByDex,
    effectiveTradingState?.positions,
    effectiveTradingState?.perpWithdrawableByDex,
    effectiveTradingState?.withdrawableUsd,
    getFreshPickedPrice,
    hip3Prices,
    hlAvailableUsd,
    projectedPerpDexFundingUsd,
  ]);
  // `crossMaintenanceMarginUsed` for the SAME dex pool. Sums every open
  // cross position's maintenance margin in the pool — this is the second
  // half of HL's `margin_available = accountValue − crossMaintenanceMarginUsed`
  // identity. Without it, projecting a NEW position on an asset where
  // the user has no existing same-asset position ignores the maintenance
  // margin already locked up by their other cross positions, and the
  // projected liq comes back far too safe (preview 96k vs. real 89k).
  const hlCrossMaintenanceMarginUsedUsd =
    effectiveTradingState?.perpCrossMaintenanceMarginUsedByDex?.[dexKeyForLiq] ?? 0;
  const rawAccountEquityUsd = hlCrossAccountValueUsd;
  // Equity passed to TradeSimulator's cross-liq projection. We do NOT
  // subtract resting open-order margin here — HL's own order-entry
  // preview uses raw `crossMarginSummary.accountValue` together with
  // `maintenance_margin_required` (which only counts OPEN positions, not
  // resting orders). Subtracting resting-order margin would make our
  // preview strictly more conservative than HL's and break parity when
  // users cross-check against the HL UI.
  const accountEquityUsd = Math.max(0, rawAccountEquityUsd);
  const crossLiqDebugInputs = useMemo(() => {
    if (!__DEV__) return null;
    const ch: any = stream.clearinghouseState ?? null;
    const dexState = dexKeyForLiq
      ? (stream.clearinghouseStatesByDex as any)?.[dexKeyForLiq]
      : ch;
    return {
      dexKeyForLiq,
      streamConnected: stream.isConnected,
      hasStreamCh: !!ch,
      rawMainMarginSummaryAccountValue: ch?.marginSummary?.accountValue ?? null,
      rawMainCrossMarginSummaryAccountValue: ch?.crossMarginSummary?.accountValue ?? null,
      rawMainCrossMaintenanceMarginUsed: ch?.crossMaintenanceMarginUsed ?? null,
      rawMainWithdrawable: ch?.withdrawable ?? null,
      rawDexMarginSummaryAccountValue: dexState?.marginSummary?.accountValue ?? null,
      rawDexCrossMarginSummaryAccountValue: dexState?.crossMarginSummary?.accountValue ?? null,
      rawDexCrossMaintenanceMarginUsed: dexState?.crossMaintenanceMarginUsed ?? null,
      rawDexWithdrawable: dexState?.withdrawable ?? null,
      rawDexMarginSummaryTotalMarginUsed: dexState?.marginSummary?.totalMarginUsed ?? null,
      effectiveWithdrawableUsd: effectiveTradingState?.withdrawableUsd ?? null,
      effectiveTransferablePerpUsd: hlTransferablePerpUsd,
      effectiveOrderAvailableUsd: hlOrderAvailableUsd,
      projectedPerpDexFundingUsd,
      effectiveUserDexAbstractionEnabled: effectiveTradingState?.userDexAbstractionEnabled ?? null,
      effectivePerpCrossAccountValueByDex: effectiveTradingState?.perpCrossAccountValueByDex ?? null,
      effectivePerpCrossMaintenanceMarginUsedByDex: effectiveTradingState?.perpCrossMaintenanceMarginUsedByDex ?? null,
      effectivePerpInitialMarginAvailableByDex: effectiveTradingState?.perpInitialMarginAvailableByDex ?? null,
      effectiveTotalIsolatedMarginUsedUsd: effectiveTradingState?.totalIsolatedMarginUsedUsd ?? null,
      positions: (effectiveTradingState?.positions ?? []).map((p: any) => {
        const szi = typeof p?.szi === 'number' ? p.szi : parseFloat(String(p?.szi ?? ''));
        const absSzi = Math.abs(szi);
        const positionValue = typeof p?.positionValue === 'number'
          ? p.positionValue
          : parseFloat(String(p?.positionValue ?? ''));
        const markPx = Number.isFinite(positionValue) && positionValue > 0 && absSzi > 0
          ? Math.abs(positionValue) / absSzi
          : NaN;
        const liqPx = typeof p?.liquidationPx === 'number'
          ? p.liquidationPx
          : parseFloat(String(p?.liquidationPx ?? ''));
        const levObj = p?.leverage && typeof p.leverage === 'object' ? p.leverage : null;
        const maxLevRaw = p?.maxLeverage ?? levObj?.maxLeverage ?? levObj?.value ?? p?.leverage;
        const maxLev = typeof maxLevRaw === 'number' ? maxLevRaw : parseFloat(String(maxLevRaw ?? ''));
        const sideSign = szi >= 0 ? 1 : -1;
        const mmr = Number.isFinite(maxLev) && maxLev > 0 ? 1 / (2 * maxLev) : NaN;
        const denom = Number.isFinite(mmr) ? 1 - mmr * sideSign : NaN;
        const impliedMarginAvailable = Number.isFinite(markPx) &&
          Number.isFinite(liqPx) &&
          liqPx > 0 &&
          absSzi > 0 &&
          Number.isFinite(denom) &&
          denom > 0
            ? ((markPx - liqPx) * absSzi * denom) / sideSign
            : null;
        return {
          coin: p?.coin,
          szi: p?.szi,
          entryPx: p?.entryPx,
          liquidationPx: p?.liquidationPx,
          marginType: p?.marginType,
          leverage: p?.leverage,
          maxLeverage: p?.maxLeverage,
          marginUsed: p?.marginUsed,
          positionValue: p?.positionValue,
          unrealizedPnl: p?.unrealizedPnl,
          impliedMarkPx: Number.isFinite(markPx) ? markPx : null,
          impliedMarginAvailable,
        };
      }),
    };
  }, [
    dexKeyForLiq,
    effectiveTradingState?.perpCrossAccountValueByDex,
    effectiveTradingState?.perpCrossMaintenanceMarginUsedByDex,
    effectiveTradingState?.perpInitialMarginAvailableByDex,
    effectiveTradingState?.positions,
    effectiveTradingState?.totalIsolatedMarginUsedUsd,
    effectiveTradingState?.userDexAbstractionEnabled,
    effectiveTradingState?.withdrawableUsd,
    hlOrderAvailableUsd,
    hlTransferablePerpUsd,
    projectedPerpDexFundingUsd,
    stream.clearinghouseState,
    stream.clearinghouseStatesByDex,
    stream.isConnected,
  ]);
  const availableUsdForTrade = useMemo(() => {
    if (marketType !== 'spot') return availableUsd;
    if (side === 'long') {
      return isHlPooledAccount
        ? Math.max(
            spotBalances.available,
            Math.max(
              0,
              (effectiveTradingState?.withdrawableUsd ?? 0) - ((effectiveTradingState as any)?.spotUsdcHoldUsd ?? 0),
            ),
          )
        : spotBalances.available;
    }
    const baseNotional = spotBaseAvailable.available * Math.max(0, currentMidPx || 0);
    return Number.isFinite(baseNotional) ? baseNotional : 0;
  }, [availableUsd, currentMidPx, effectiveTradingState, effectiveTradingState?.withdrawableUsd, isHlPooledAccount, marketType, side, spotBalances.available, spotBaseAvailable.available]);
  const spotBaseUsd = useMemo(() => {
    const v = spotBaseAvailable.available * Math.max(0, currentMidPx || 0);
    return Number.isFinite(v) ? v : 0;
  }, [currentMidPx, spotBaseAvailable.available]);
  const spotTotalUsd = useMemo(() => {
    const usdcBal = spotBalances.available;
    const v = usdcBal + spotBaseUsd;
    return Number.isFinite(v) ? v : 0;
  }, [spotBalances.available, spotBaseUsd]);
  const spotBreakdownText = useMemo(() => {
    if (!spotBalances.hasData && !spotBaseAvailable.hasData) return '--';
    const usdc = spotBalances.available.toFixed(2);
    const base = spotBaseAvailable.available.toFixed(4);
    const baseLabel = asset?.symbol?.toUpperCase() || 'BASE';
    return `$${usdc} usdc - ${base} ${baseLabel}`;
  }, [
    asset?.symbol,
    spotBalances.available,
    spotBalances.hasData,
    spotBaseAvailable.available,
    spotBaseAvailable.hasData,
  ]);
  const canSellSpot = marketType !== 'spot' || spotBaseAvailable.available > 0;

  const isTaker =
    orderType === 'market' ||
    orderType === 'stop_market' ||
    orderType === 'take_market';
  // builderFeeRate comes from useBuilderConfig() hook (server-driven)
  // Protocol fees: userFees × HIP-3 deployerFeeScale × growthMode (HL formula).
  // Live meta (getHip3FeeParams) is preferred; asset detail is fallback.
  // See: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
  const perpTakerFeeRate = resolveBaseFeeRate(
    parseFeeRateDecimal(userFees?.userCrossRate),
    DEFAULT_PERP_TAKER_RATE,
  );
  const perpMakerFeeRate = resolveBaseFeeRate(
    parseFeeRateDecimal(userFees?.userAddRate),
    DEFAULT_PERP_MAKER_RATE,
  );
  const spotTakerFeeRateHL = resolveBaseFeeRate(
    parseFeeRateDecimal((userFees as any)?.userSpotCrossRate),
    DEFAULT_SPOT_TAKER_RATE,
  );
  const spotMakerFeeRateHL = resolveBaseFeeRate(
    parseFeeRateDecimal((userFees as any)?.userSpotAddRate),
    DEFAULT_SPOT_MAKER_RATE,
  );
  const referralDiscount = parseFeeRateDecimal((userFees as any)?.activeReferralDiscount);

  const baseTakerFeeRate = marketType === 'spot' ? spotTakerFeeRateHL : perpTakerFeeRate;
  const baseMakerFeeRate = marketType === 'spot' ? spotMakerFeeRateHL : perpMakerFeeRate;

  const resolvedDeployerFeeScale =
    hip3FeeParams?.deployerFeeScale ?? parseDeployerFeeScale(asset?.deployerFeeScale, 1);
  const resolvedGrowthMode = hip3FeeParams?.growthMode ?? !!asset?.growthMode;

  const protocolFees = computeProtocolFeeRates({
    takerRate: baseTakerFeeRate,
    makerRate: baseMakerFeeRate,
    activeReferralDiscount: referralDiscount,
    kind: marketType === 'spot' ? 'spot' : 'perp',
    isHip3: !!asset?.isHip3 && marketType === 'perp',
    deployerFeeScale: resolvedDeployerFeeScale,
    growthMode: resolvedGrowthMode,
  });
  const takerFeeRate = protocolFees.takerRate;
  const makerFeeRate = protocolFees.makerRate;
  
  const protocolFeeRate = isTaker ? takerFeeRate : makerFeeRate;
  const spotBuilderFeeRate = getSpotBuilderFeeTenthsBps() * 0.00001;
  const builderFeeRateEffective = marketType === 'spot' ? spotBuilderFeeRate : builderFeeRate;
  const totalFeeRate = protocolFeeRate + builderFeeRateEffective;
  const spotTakerFeePct = (takerFeeRate + spotBuilderFeeRate) * 100;
  const spotMakerFeePct = (makerFeeRate + spotBuilderFeeRate) * 100;
  const estFeeUsd = sizeUsd > 0 ? sizeUsd * totalFeeRate : 0;
  const marginRequiredUsd = marketType === 'spot' ? sizeUsd : leverage > 0 ? sizeUsd / leverage : 0;
  const spotMinNotionalUsd = 10;
  const spotSlippageBps = 50;
  const spotMinSizeUnits = marketType === 'spot' ? Math.pow(10, -(spotAssetData?.szDecimals ?? 0)) : 0;
  const spotRefPx =
    marketType === 'spot'
      ? Math.max(
          0,
          orderType === 'limit' && Number.isFinite(limitPx ?? NaN) ? (limitPx as number) : currentMidPx || oraclePx,
        )
      : 0;
  const spotSizePow = Math.pow(10, spotAssetData?.szDecimals ?? 0);
  const spotSizeUnitsRaw = spotRefPx > 0 ? sizeUsd / spotRefPx : 0;
  const spotSizeUnitsRounded = spotSizePow > 0 ? Math.floor(spotSizeUnitsRaw * spotSizePow) / spotSizePow : 0;
  const spotPxForCheck =
    orderType === 'limit' && Number.isFinite(limitPx ?? NaN)
      ? (limitPx as number)
      : spotRefPx > 0
        ? spotRefPx * (side === 'long' ? 1 + spotSlippageBps / 10000 : 1 - spotSlippageBps / 10000)
        : 0;
  const spotNotionalRounded = spotSizeUnitsRounded * spotPxForCheck;
  const spotMinUsdRequired = useMemo(() => {
    if (marketType !== 'spot' || spotMinSizeUnits <= 0 || spotPxForCheck <= 0) return spotMinNotionalUsd;
    const minUnitsForNotional =
      Math.ceil(spotMinNotionalUsd / spotPxForCheck / spotMinSizeUnits) * spotMinSizeUnits;
    const v = minUnitsForNotional * spotPxForCheck;
    return Number.isFinite(v) ? v : spotMinNotionalUsd;
  }, [marketType, spotMinNotionalUsd, spotMinSizeUnits, spotPxForCheck]);
  // HL spot minimum (notional + size step)
  const belowSpotMin =
    marketType === 'spot' &&
    sizeUsd > 0 &&
    (sizeUsd + 1e-9 < spotMinUsdRequired || spotSizeUnitsRounded < spotMinSizeUnits);
  // Spot SELL margin check runs in BASE units instead of USD. When the slider
  // sits at 100%, `sizeUsd` is set to `spotBaseAvailable.available *
  // currentMidPx`. Both inputs float with the mid, but `sizeUsd` only
  // re-syncs when the %→$ effect runs — every live price tick the
  // `availableUsdForTrade` denominator moves relative to the fixed-point
  // `sizeUsd`, which flipped the Max button between enabled and
  // "margin insufficient" mid-order. Comparing base-unit size to
  // `spotBaseAvailable.available` (with a minLot-aware tolerance) decouples
  // the check from intra-tick mid drift — you can't sell more base than you
  // hold regardless of whether the USD denomination jiggled by a cent.
  const spotSellBaseTolerance =
    marketType === 'spot' && side === 'short'
      ? Math.max(Math.pow(10, -(spotAssetData?.szDecimals ?? 2)), 1e-9)
      : 1e-9;
  const notEnoughMargin =
    marketType === 'spot'
      ? side === 'short'
        ? sizeUnits > spotBaseAvailable.available + spotSellBaseTolerance
        : sizeUsd + estFeeUsd > availableUsdForTrade + 1e-9
      : marginRequiredUsd + estFeeUsd > availableUsd + 1e-9;
  const reduceOnlyEligible = useMemo(() => {
    if (marketType === 'spot') return false;
    if (!currentPosition || !Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(oraclePx) || oraclePx <= 0) return false;
    if (currentPosition.side === side) return false;
    const existingNotional = Math.abs(currentPosition.sizeUnits) * oraclePx;
    return sizeUsd <= existingNotional + 1e-9;
  }, [currentPosition, marketType, oraclePx, side, sizeUsd]);
  // "Zero budget" check — fires even when the user hasn't typed a size yet
  // so the action button shows "Margin insufficient" instead of looking
  // pressable. Hits the unified-mode 10%-rule case where transferable spot
  // collapses to $0 (an existing cross position pins the whole pool).
  const PERP_MIN_USABLE_USD_TRADE = 1;
  const noPerpBudget =
    marketType === 'perp' &&
    showOrderAvailableAmount &&
    Number.isFinite(availableUsd) &&
    availableUsd < PERP_MIN_USABLE_USD_TRADE;
  const noSpotBudget =
    marketType === 'spot' &&
    Number.isFinite(availableUsdForTrade) &&
    availableUsdForTrade < spotMinUsdRequired;
  const notEnoughMarginEffective =
    (notEnoughMargin && !reduceOnlyEligible) ||
    (noPerpBudget && !reduceOnlyEligible) ||
    noSpotBudget;
  const spotInvalidSize = marketType === 'spot' && belowSpotMin;

  // Match HL sizing behavior: order acceptance is `accountValue ≥ initialMargin`
  // regardless of abstraction mode (per HL margining docs — maintenance
  // margin only matters for liquidation, not order time). Reserve init
  // margin + once-on-notional fees:
  //   N/L + N × feeRate ≤ available
  //   maxMargin = available / (1 + L × feeRate)
  const maxUsableMarginUsd = useMemo(() => {
    const BUFFER_FACTOR = 0.995;
    if (marketType === 'spot') {
      if (side === 'short') {
        return Math.max(0, spotBaseAvailable.available * Math.max(0, currentMidPx || 0));
      }
      const denom = 1 + totalFeeRate;
      return Math.max(0, (availableUsdForTrade / denom) * BUFFER_FACTOR);
    }
    const a = Math.max(0, availableUsd);
    const L = Math.max(1, leverage);
    const denom = 1 + totalFeeRate * L;
    if (denom <= 0) return 0;
    return Math.max(0, (a / denom) * BUFFER_FACTOR);
  }, [availableUsd, availableUsdForTrade, currentMidPx, leverage, marketType, side, spotBaseAvailable.available, totalFeeRate]);

  const displaySizePct = useMemo(() => {
    // % mode: sizePct is the source of truth. Never snap the thumb to 0 just
    // because available balance briefly flickers (spot refetch / side flip /
    // WS lag) — that was the left-right slider glitch.
    if (sizeMode === 'pct') {
      return Math.max(0, Math.min(100, Math.round(sizePct)));
    }
    if (marketType === 'spot') {
      if (!Number.isFinite(availableUsdForTrade) || availableUsdForTrade <= 0) return 0;
      const pct = (sizeUsd / Math.max(0.01, availableUsdForTrade)) * 100;
      return Math.max(0, Math.min(100, Math.round(pct)));
    }
    const denom = maxUsableMarginUsd * Math.max(1, leverage);
    if (!Number.isFinite(denom) || denom <= 0) return 0;
    const pct = (sizeUsd / denom) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }, [availableUsdForTrade, leverage, marketType, maxUsableMarginUsd, sizeMode, sizePct, sizeUsd]);

  // While an order is submitting, paint the size UI from the snapshot taken
  // at click — not from live margin-derived values.
  const sizeSnap = isSubmitting ? frozenSizeRef.current : null;
  const uiDisplaySizePct = sizeSnap?.displaySizePct ?? displaySizePct;
  const uiSizeUsdText = sizeSnap?.sizeUsdText ?? sizeUsdText;
  const uiSizeUsd = sizeSnap?.sizeUsd ?? sizeUsd;
  const uiSizeUnits = sizeSnap?.sizeUnits ?? sizeUnits;
  const isSizeInputLocked = isSubmitting;

  // If user is typing a manual size, keep size-% in sync (for a nice HL-like feel).
  useEffect(() => {
    // Don't let live margin churn rewrite sizePct while an order is in flight.
    if (isSubmitting) return;
    if (sizeMode !== 'manual') return;
    if (!Number.isFinite(maxUsableMarginUsd) || maxUsableMarginUsd <= 0) return;
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return;
    const basis = marketType === 'spot' ? sizeUsd : sizeUsd / Math.max(1, leverage);
    const pct = (basis / maxUsableMarginUsd) * 100;
    setSizePct(Math.max(0, Math.min(100, Math.round(pct))));
  }, [isSubmitting, leverage, marketType, maxUsableMarginUsd, sizeMode, sizeUsd]);

  // When in % mode, keep the typed size synced to (maxUsableMargin * pct * leverage).
  useEffect(() => {
    // Skip while submitting — UI reads from frozenSizeRef instead, and writing
    // here would fight the freeze with thrashing live maxUsableMargin values.
    if (isSubmitting) return;
    if (sizeMode !== 'pct') return;
    if (!Number.isFinite(maxUsableMarginUsd) || maxUsableMarginUsd <= 0) {
      setSizeUsdText('');
      return;
    }
    const pct = Math.max(0, Math.min(100, sizePct));
    const basis = maxUsableMarginUsd * (pct / 100);
    const nextSize = marketType === 'spot' ? basis : basis * Math.max(1, leverage);
    setSizeUsdText(nextSize > 0 ? nextSize.toFixed(2) : '');
  }, [isSubmitting, leverage, marketType, maxUsableMarginUsd, sizeMode, sizePct]);

  const setSizeToMax = useCallback(() => {
    if (isSubmitting) return;
    triggerCalculating();
    setSizeMode('pct');
    setSizePct(100);
  }, [isSubmitting, triggerCalculating]);

  const handleSizePctSliderChange = useCallback((v: number) => {
    if (isSubmitting) return;
    triggerCalculating();
    setSizeMode('pct');
    setSizePct(v);
  }, [isSubmitting, triggerCalculating]);

  const transferAvailableUsd = useMemo(() => {
    if (isHlPooledAccount) return 0;
    return transferDirection === 'toPerp' ? spotBalances.available : hlMainPerpTransferAvailableUsd;
  }, [hlMainPerpTransferAvailableUsd, isHlPooledAccount, spotBalances.available, transferDirection]);

  useEffect(() => {
    if (transferModalOpen && !showSpotPerpTransferLink) {
      setTransferModalOpen(false);
      setTransferAmountText('');
    }
  }, [showSpotPerpTransferLink, transferModalOpen]);

  const handleTransferMax = useCallback(() => {
    if (!Number.isFinite(transferAvailableUsd)) return;
    // Reduce by 0.01 to avoid "not enough balance" errors from rounding/timing
    const maxAmount = Math.max(0, transferAvailableUsd - 0.01);
    setTransferAmountText(maxAmount > 0 ? maxAmount.toFixed(2) : '');
  }, [transferAvailableUsd]);

  const submitTransfer = useCallback(async () => {
    if (!embeddedAddress) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    const amountNum = parseFloat(transferAmountText.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      showToast(t('errors.enterValidAmount'));
      return;
    }
    if (amountNum < 1) {
      showToast('Minimum transfer amount is 1 USDC');
      return;
    }
    if (amountNum > transferAvailableUsd + 1e-9) {
      showToast(t('errors.amountExceedsBalance'));
      return;
    }
    if (isHlPooledAccount) {
      showToast(
        t('portfolio.unifiedNoTransferNeeded', 'Unified balances do not need spot/perp transfers.'),
        t('portfolio.transferUnavailable', 'Transfer unavailable'),
      );
      return;
    }
    setIsTransferring(true);
    try {
      if (!embeddedWallet) {
        showToast(t('errors.pleaseConnectWallet'));
        return;
      }
      const provider = (await embeddedWallet.getProvider()) as unknown as Eip1193Provider;
      await transferUsdBetweenSpotAndPerp({
        userWalletProvider: provider,
        userAddress: embeddedAddress,
        amountUsd: amountNum.toFixed(2),
        toPerp: transferDirection === 'toPerp',
      });
      refetchSpotState();
      refetchTradingState();
      setTransferAmountText('');
      setTransferModalOpen(false);
      showSuccessToast(t('portfolio.transferSubmitted'));
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Transfer failed';
      const h = humanizeHyperliquidError(msg);
      showToast(h.message, h.title);
    } finally {
      setIsTransferring(false);
    }
  }, [
    embeddedAddress,
    embeddedWallet,
    isHlPooledAccount,
    refetchSpotState,
    refetchTradingState,
    transferAmountText,
    transferAvailableUsd,
    transferDirection,
    t,
  ]);

  // Debounce ref for leverage save to avoid writing to AsyncStorage on every slider drag
  const saveLeverageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLeverageSelect = useCallback(
    (value: number) => {
      setLeverage(value);
      
      // Debounce the AsyncStorage write - only save after user stops dragging for 300ms
      if (saveLeverageTimeoutRef.current) {
        clearTimeout(saveLeverageTimeoutRef.current);
      }
      saveLeverageTimeoutRef.current = setTimeout(() => {
        if (marginTiersCoin) {
          saveLeverageForSymbol(
            tradingAddress || null,
            marginTiersCoin,
            value,
            true,
          );
        }
      }, 300);
    },
    [tradingAddress, marginTiersCoin],
  );

  const tpPx = useMemo(() => {
    const raw = tpPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [tpPxText]);

  const slPx = useMemo(() => {
    const raw = slPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [slPxText]);

  useEffect(() => {
    // Attached TP/SL only makes sense on non-trigger parent orders — a
    // stop/take order IS itself the trigger, so nested TP/SL would be
    // redundant and HL rejects it.
    if (!isTriggerOrder) return;
    if (tpEnabled) setTpEnabled(false);
    if (slEnabled) setSlEnabled(false);
    if (tpPxText) setTpPxText('');
    if (slPxText) setSlPxText('');
  }, [isTriggerOrder, slEnabled, slPxText, tpEnabled, tpPxText]);

  useEffect(() => {
    if (marketType !== 'spot') return;
    // Spot doesn't support any trigger orders (no perp engine).
    if (isTriggerOrder) {
      setOrderType('market');
    }
    if (tpEnabled) setTpEnabled(false);
    if (slEnabled) setSlEnabled(false);
    if (tpPxText) setTpPxText('');
    if (slPxText) setSlPxText('');
    if (triggerPxText) setTriggerPxText('');
  }, [marketType, orderType, slEnabled, slPxText, tpEnabled, tpPxText, triggerPxText, isTriggerOrder]);

  const tpEstPnlUsd = useMemo(() => {
    if (!tpEnabled || !tpPx || !oraclePx || !sizeUnits) return undefined;
    // For limit orders, use the limit price as the expected entry — not
    // the current oracle price — so the estimated gain makes sense.
    const entryRef = orderType === 'limit' && Number.isFinite(limitPx ?? NaN) ? (limitPx as number) : oraclePx;
    const delta = side === 'long' ? tpPx - entryRef : entryRef - tpPx;
    return delta * sizeUnits;
  }, [limitPx, oraclePx, orderType, side, sizeUnits, tpEnabled, tpPx]);

  const slEstLossUsd = useMemo(() => {
    if (!slEnabled || !slPx || !oraclePx || !sizeUnits) return undefined;
    const entryRef = orderType === 'limit' && Number.isFinite(limitPx ?? NaN) ? (limitPx as number) : oraclePx;
    const delta = side === 'long' ? entryRef - slPx : slPx - entryRef;
    return delta * sizeUnits;
  }, [limitPx, oraclePx, orderType, side, sizeUnits, slEnabled, slPx]);

  const posTpPx = useMemo(() => {
    const raw = posTpPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [posTpPxText]);

  const posSlPx = useMemo(() => {
    const raw = posSlPxText.replace(/[^0-9.]/g, '');
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }, [posSlPxText]);

  const posTpPnlUsd = useMemo(() => {
    if (!posTpslModal || !posTpEnabled || !posTpPx) return undefined;
    const { entryPx, entrySide, sizeUnits } = posTpslModal;
    // TP/SL orders always close the full position
    const delta = entrySide === 'long' ? posTpPx - entryPx : entryPx - posTpPx;
    return delta * sizeUnits;
  }, [posTpEnabled, posTpPx, posTpslModal]);

  const posSlPnlUsd = useMemo(() => {
    if (!posTpslModal || !posSlEnabled || !posSlPx) return undefined;
    const { entryPx, entrySide, sizeUnits } = posTpslModal;
    // TP/SL orders always close the full position
    const delta = entrySide === 'long' ? posSlPx - entryPx : entryPx - posSlPx;
    return delta * sizeUnits;
  }, [posSlEnabled, posSlPx, posTpslModal]);

  const getPosTpslRoePct = useCallback((pnlUsd: number | undefined) => {
    if (!posTpslModal || typeof pnlUsd !== 'number' || !Number.isFinite(pnlUsd)) return undefined;
    const directMargin = typeof posTpslModal.marginUsedUsd === 'number'
      ? posTpslModal.marginUsedUsd
      : parseFloat(String(posTpslModal.marginUsedUsd ?? ''));
    const fallbackMargin =
      Number.isFinite(posTpslModal.leverage) &&
      (posTpslModal.leverage as number) > 0 &&
      Number.isFinite(posTpslModal.entryPx) &&
      Number.isFinite(posTpslModal.sizeUnits)
        ? (posTpslModal.entryPx * posTpslModal.sizeUnits) / (posTpslModal.leverage as number)
        : NaN;
    const margin = Number.isFinite(directMargin) && directMargin > 0 ? directMargin : fallbackMargin;
    return Number.isFinite(margin) && margin > 0 ? (pnlUsd / margin) * 100 : undefined;
  }, [posTpslModal]);

  const existingPosTriggers = useMemo(() => {
    if (!posTpslModal) return [];
    const detectTpsl = (o: any): 'tp' | 'sl' | null => {
      const t =
        o?.tpsl ??
        o?.trigger?.tpsl ??
        o?.t?.trigger?.tpsl ??
        o?.orderType?.trigger?.tpsl ??
        null;
      return t === 'tp' || t === 'sl' ? t : null;
    };
    return (filteredOpenOrders ?? [])
      .filter((o: any) => String(o?.coin) === String(posTpslModal.coin))
      .map((o: any) => ({
        oid: o?.oid,
        coin: o?.coin,
        tpsl: detectTpsl(o),
        triggerPx: o?.triggerPx ?? o?.t?.trigger?.triggerPx ?? o?.orderType?.trigger?.triggerPx ?? null,
        sz: o?.sz ?? null,
      }))
      .filter((x: any) => x.tpsl === 'tp' || x.tpsl === 'sl');
  }, [filteredOpenOrders, posTpslModal]);

  const executeSubmitOrder = useCallback(async () => {
    Keyboard.dismiss();
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    if (!embeddedWallet) {
      showErrorToast(t('errors.walletNotReadyDescription'), t('errors.walletNotReady'));
      return;
    }
    if (!agentPrivateKey || !agentAddress) {
      showErrorToast(t('errors.agentKeyNotReady'), t('errors.tradingSetup'));
      return;
    }
    // If user dismissed the setup modal earlier, trying to submit should
    // surface it again. Gate on setupComplete (agent + builder approval),
    // not just agent active, so the "agent active but builder unapproved"
    // edge case routes back through setup instead of hitting an HL reject.
    if (!tradingStateLoading && effectiveTradingState?.hasBalance && !setupComplete) {
      if (isExternalWalletUser) {
        requestExternalSetup();
      } else {
        setShowSetupModal(true);
      }
      return;
    }
    if (!asset?.symbol) {
      showErrorToast(t('errors.waitForMarketData'), t('errors.assetNotReady'));
      return;
    }

    if (submitGuardRef.current) return;
    try {
      submitGuardRef.current = true;
      // Freeze the size UI to the exact notional we're about to send before
      // any JIT funding / clearinghouse updates can thrash maxUsableMargin.
      frozenSizeRef.current = {
        displaySizePct,
        sizeUsdText:
          sizeMode === 'pct'
            ? sizeUsd > 0
              ? sizeUsd.toFixed(2)
              : ''
            : sizeUsdText,
        sizeUsd,
        sizeUnits,
      };
      setIsSubmitting(true);
      if (notEnoughMarginEffective) {
        showToast(t('errors.notEnoughMargin'));
        return;
      }
      if (
        marketType === 'perp' &&
        (!Number.isFinite(perpOrderEntryPx) || perpOrderEntryPx <= 0)
      ) {
        showToast(t('errors.waitForMarketData'));
        return;
      }
      if (marketType === 'perp' && isTriggerOrder) {
        if (!Number.isFinite(triggerPx ?? NaN) || (triggerPx ?? 0) <= 0) {
          showToast(t('errors.enterStopPrice'));
          return;
        }
        if (isLimitStyleTrigger && (!Number.isFinite(limitPx ?? NaN) || (limitPx ?? 0) <= 0)) {
          showToast(t('errors.enterLimitPrice'));
          return;
        }
        // Direction validation per HL's canonical rules:
        //   Stop Buy → trigger > mid    Take Buy  → trigger < mid
        //   Stop Sell→ trigger < mid    Take Sell → trigger > mid
        const triggerRefPx = safeNum(currentMidPx || oraclePx);
        if (Number.isFinite(triggerRefPx) && triggerRefPx > 0) {
          if (isStopOrder) {
            if (side === 'long' && (triggerPx as number) <= triggerRefPx) {
              showToast(t('errors.longStopTriggerAbove'));
              return;
            }
            if (side === 'short' && (triggerPx as number) >= triggerRefPx) {
              showToast(t('errors.shortStopTriggerBelow'));
              return;
            }
          } else if (isTakeOrder) {
            if (side === 'long' && (triggerPx as number) >= triggerRefPx) {
              showToast(t('errors.longTakeTriggerBelow'));
              return;
            }
            if (side === 'short' && (triggerPx as number) <= triggerRefPx) {
              showToast(t('errors.shortTakeTriggerAbove'));
              return;
            }
          }
        }
      }
      // ─── HL path ─────────────────────────────────────────

      let res: any;
      if (marketType === 'spot') {
        if (!spotAvailable) {
          showToast(t('errors.spotTradingNotAvailable'));
          return;
        }
        if (side === 'short' && sizeUnits > spotBaseAvailable.available + 1e-9) {
          showToast(t('errors.notEnoughSpotBalance'));
          return;
        }
        const spotOrderSizeUnits = side === 'short' ? Math.min(sizeUnits, spotBaseAvailable.available) : undefined;
        if (__DEV__) {
          console.log('[TradeSpotSubmit]', {
            assetCoin: asset.coin,
            assetSymbol: asset.symbol,
            spotSymbol: spotAssetData?.spotSymbol,
            spotBaseCoin: spotAssetData?.baseCoin,
            side,
            orderType,
            sizeUsd,
            sizeUnits,
            spotOrderSizeUnits,
            spotBaseAvailable: spotBaseAvailable.available,
            currentMidPx,
            oraclePx,
            limitPx,
            szDecimals: spotAssetData?.szDecimals,
            pxDecimals: spotAssetData?.pxDecimals,
          });
        }
        res = await placeSpotOrder({
          agentPrivateKey: agentPrivateKey as `0x${string}`,
          symbol: spotAssetData?.spotSymbol || asset.symbol,
          side: side === 'long' ? 'buy' : 'sell',
          orderType: orderType === 'limit' ? 'limit' : 'market',
          sizeUsd,
          sizeUnits: spotOrderSizeUnits,
          referencePx: currentMidPx || oraclePx,
          limitPx,
          slippageBps: 50,
          vaultAddress,
        });
      } else {
        // JIT sendAsset funding for Standard-mode perp DEX balances.
        // `placeOrder` moves free USDC between main/xyz as needed before
        // opening orders; it no-ops for reduce-only or unified/portfolio.
        const isHip3Coin = String(asset.coin ?? '').includes(':');
        const dexKeyForJit = isHip3Coin ? String(asset.coin).split(':')[0] : '';
        const getFreshJitProvider = async () =>
          embeddedWallet
            ? ((await embeddedWallet.getProvider().catch(() => undefined)) as unknown as Eip1193Provider | undefined)
            : undefined;
        const submitPerpOrder = (jitProvider: Eip1193Provider | undefined) =>
          placeOrder({
            agentPrivateKey: agentPrivateKey as `0x${string}`,
            symbol: asset.coin, // Use coin (e.g., "xyz:XYZ100") instead of symbol (e.g., "NDX100") for API calls
            side,
            orderType,
            sizeUsd,
            oraclePx: perpOrderEntryPx,
            limitPx,
            triggerPx,
            referencePx: currentMidPx,
            reduceOnly: reduceOnlyEligible,
            leverage,
            isCross: marginMode === 'cross',
            marginSupport: marginSupport ?? undefined, // Pass pre-fetched margin support to avoid redundant API call
            userWalletProvider: jitProvider,
            userAddress: embeddedAddress,
            hip3DexBalanceUsd: isHip3Coin
              ? (effectiveTradingState?.perpCrossAccountValueByDex?.[dexKeyForJit] ?? 0)
              : undefined,
            mainDexAvailableUsdc: effectiveTradingState?.perpWithdrawableByDex?.[''] ?? 0,
            targetDexMarginAvailableUsd: effectiveTradingState?.perpInitialMarginAvailableByDex?.[dexKeyForJit],
            perpWithdrawableByDex: effectiveTradingState?.perpWithdrawableByDex,
            // Unified-mode JIT funding budget. Same helper that the slider/Max
            // uses, implementing HL's documented `max(initial, 0.10 × position_value)`
            // transfer rule. A 100% slider order can never exceed what HL will
            // actually let through `sendAsset(spot → <dex>)`.
            unifiedSpotPoolFreeUsd: isPooledAccountMode(effectiveTradingState?.accountAbstractionMode ?? null)
              ? computeUnifiedSpotTransferableUsd({
                  spotUsdcBalanceUsd: effectiveTradingState?.spotUsdcBalanceUsd ?? 0,
                  totalCrossInitialMarginUsedUsd: (effectiveTradingState as any)?.totalCrossInitialMarginUsedUsd ?? 0,
                  totalCrossPositionValueUsd: (effectiveTradingState as any)?.totalCrossPositionValueUsd ?? 0,
                  totalIsolatedMarginUsedUsd: effectiveTradingState?.totalIsolatedMarginUsedUsd ?? 0,
                  spotUsdcHoldUsd: (effectiveTradingState as any)?.spotUsdcHoldUsd ?? 0,
                  restingOrdersInitMarginUsd: estimateRestingOrdersInitMarginUsd(stream.openOrders as any),
                })
              : undefined,
            accountAbstractionMode: effectiveTradingState?.accountAbstractionMode ?? null,
            vaultAddress,
          });

        const jitProvider = await getFreshJitProvider();
        try {
          res = await submitPerpOrder(jitProvider);
        } catch (err: any) {
          if (!isHip3Coin || !isWalletTypedDataSigningError(err)) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 350));
          const refreshedJitProvider = await getFreshJitProvider();
          try {
            res = await submitPerpOrder(refreshedJitProvider ?? jitProvider);
          } catch (retryErr: any) {
            if (isWalletTypedDataSigningError(retryErr)) {
              throw new Error('Wallet signer is reconnecting. Please try again in a moment.');
            }
            throw retryErr;
          }
        }
      }

      const acceptanceError = getPerpOrderAcceptanceError(res);
      if (acceptanceError) {
        const h = humanizeHyperliquidError(acceptanceError);
        showErrorToast(h.message, h.title);
      } else {
        showOrderSuccessAlert();
        
        // Track trade with Firebase Analytics
        Analytics.logTrade(
          asset?.coin || coin || 'UNKNOWN',
          side === 'long' ? 'buy' : 'sell',
          sizeUsd,
          orderType,
          'trade_page'
        );

        // Report trade for rewards tracking (fire-and-forget)
        if (embeddedAddress && sizeUsd > 0) {
          getAccessToken().then((token) => {
            if (token) {
              reportTrade(embeddedAddress, token).catch(() => {});
            }
          });
        }
        
        // Reset size inputs after a successful submit to avoid "not enough margin" flash
        setSizeMode('manual');
        setSizePct(0);
        setSizeUsdText('');
        setLimitPxText('');
        setTriggerPxText('');
        setTpEnabled(false);
        setSlEnabled(false);
        setTpPxText('');
        setSlPxText('');
      }

      // Optional TP/SL reduce-only triggers (best-effort).
      if (marketType === 'perp' && ((tpEnabled && Number.isFinite(tpPx ?? NaN) && (tpPx ?? 0) > 0) || (slEnabled && Number.isFinite(slPx ?? NaN) && (slPx ?? 0) > 0))) {
        try {
          if (tpEnabled && tpPx && tpPx > 0) {
            await placeReduceOnlyTpslTrigger({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol: asset.coin,
              entrySide: side,
              sizeUsd,
              oraclePx: perpOrderEntryPx,
              triggerPx: tpPx,
              tpsl: 'tp',
              vaultAddress,
            });
          }
          if (slEnabled && slPx && slPx > 0) {
            await placeReduceOnlyTpslTrigger({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol: asset.coin,
              entrySide: side,
              sizeUsd,
              oraclePx: perpOrderEntryPx,
              triggerPx: slPx,
              tpsl: 'sl',
              vaultAddress,
            });
          }
        } catch (e: any) {
          // Use the in-page banner — same modal-stacking issue as the
          // main order-submit catch below: the global toast renders
          // beneath the trade page's modal on iOS so the user only
          // sees TP/SL failures after dismissing the whole screen.
          const tpslMsg = String(e?.message || t('errors.failedToSetTpsl'));
          const tpslHumanized = humanizeHyperliquidError(tpslMsg);
          showOrderErrorAlert(tpslHumanized.message, tpslHumanized.title);
        }
      }
      // Await the refetches so `isSubmitting` stays true until the new row
      // shows up in PortfolioTabs below. Without this the button flips from
      // "Submitting…" back to idle before HL's WS push / our REST refetch
      // lands, creating a visible gap between the success toast and the
      // order appearing in the list.
      const refetchTasks: Promise<unknown>[] = [refetchTradingState(), refetchOpenOrders()];
      if (marketType === 'spot') {
        refetchTasks.push(refetchSpotState(), refetchUserFills());
      }
      await Promise.allSettled(refetchTasks);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Order failed';
      const h = humanizeHyperliquidError(msg);
      // In-page banner — global toast lives behind the trade-page modal
      // on iOS native presentation, so order-failure messages would only
      // become visible AFTER the user dismissed the modal back to the
      // asset page. See `orderErrorAlert` declaration above.
      showOrderErrorAlert(h.message, h.title);
    } finally {
      setIsSubmitting(false);
      submitGuardRef.current = false;
    }
  }, [
    agentAddress,
    agentPrivateKey,
    asset?.symbol,
    embeddedWallet,
    isAuthenticated,
    isStopOrder,
    isTakeOrder,
    isTriggerOrder,
    isLimitStyleTrigger,
    hip3Prices,
    limitPx,
    livePrices,
    orderBookCoin,
    asset?.markPx,
    asset?.oraclePx,
    currentMidPx,
    oraclePx,
    perpOrderEntryPx,
    orderType,
    triggerPx,
    refetchOpenOrders,
    refetchSpotState,
    refetchTradingState,
    refetchUserFills,
    router,
    side,
    sizeUsd,
    sizeUsdText,
    sizeUnits,
    sizeMode,
    displaySizePct,
    effectiveTradingState?.hasBalance,
    setupComplete,
    tradingStateLoading,
    marketType,
    marginMode,
    notEnoughMarginEffective,
    reduceOnlyEligible,
    slEnabled,
    slPxText,
    tpEnabled,
    tpPxText,
    showOrderSuccessAlert,
    showOrderErrorAlert,
    t,
    getAccessToken,
    asset?.coin,
    coin,
    spotAvailable,
    vaultAddress,
  ]);

  // Pre-flight trigger validation. We run this BEFORE opening the confirm
  // modal so the toast fires immediately; otherwise the toast would be
  // shown while the modal is still in its close-fade animation and would
  // be invisible behind the backdrop.
  const validateTriggerPreflight = useCallback((): string | null => {
    if (marketType !== 'perp' || !isTriggerOrder) return null;
    if (!Number.isFinite(triggerPx ?? NaN) || (triggerPx ?? 0) <= 0) {
      return t('errors.enterStopPrice');
    }
    if (isLimitStyleTrigger && (!Number.isFinite(limitPx ?? NaN) || (limitPx ?? 0) <= 0)) {
      return t('errors.enterLimitPrice');
    }
    const triggerRefPx = safeNum(currentMidPx || oraclePx);
    if (!Number.isFinite(triggerRefPx) || triggerRefPx <= 0) return null;
    if (isStopOrder) {
      if (side === 'long' && (triggerPx as number) <= triggerRefPx) {
        return t('errors.longStopTriggerAbove');
      }
      if (side === 'short' && (triggerPx as number) >= triggerRefPx) {
        return t('errors.shortStopTriggerBelow');
      }
    } else if (isTakeOrder) {
      if (side === 'long' && (triggerPx as number) >= triggerRefPx) {
        return t('errors.longTakeTriggerBelow');
      }
      if (side === 'short' && (triggerPx as number) <= triggerRefPx) {
        return t('errors.shortTakeTriggerAbove');
      }
    }
    return null;
  }, [
    currentMidPx,
    isLimitStyleTrigger,
    isStopOrder,
    isTakeOrder,
    isTriggerOrder,
    limitPx,
    marketType,
    oraclePx,
    side,
    t,
    triggerPx,
  ]);

  const handleSubmitOrder = useCallback(() => {
    if (isSubmitting) return;
    const triggerErr = validateTriggerPreflight();
    if (triggerErr) {
      // Show as an in-app modal (same style as the Info explainer) so the
      // user cannot miss the reason. Toasts were getting hidden behind the
      // confirm modal's fade animation.
      setInfoModal({ title: t('errors.error'), body: triggerErr });
      return;
    }
    sharedAiGuard(() => {
      if (skipOrderConfirm) {
        executeSubmitOrder();
        return;
      }
      setConfirmOrderModalOpen(true);
    });
  }, [
    executeSubmitOrder,
    isSubmitting,
    sharedAiGuard,
    skipOrderConfirm,
    t,
    validateTriggerPreflight,
  ]);

  const orderTypeLabel = useMemo(() => {
    switch (orderType) {
      case 'market':
        return t('trading.market');
      case 'limit':
        return t('trading.limit');
      case 'stop_market':
        return t('trading.stopMarket');
      case 'stop_limit':
        return t('trading.stopLimit');
      case 'take_market':
        return t('trading.takeMarket');
      case 'take_limit':
        return t('trading.takeLimit');
      default:
        return t('trading.market');
    }
  }, [orderType, t]);

  const formatPrice = (price: string | null | undefined): string => {
    if (!price) return '--';
    const num = parseFloat(price);
    const abs = Math.abs(num);
    if (abs >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 100) return num.toFixed(2);
    if (abs >= 10) return num.toFixed(3);
    if (abs >= 1) return num.toFixed(3);
    if (abs >= 0.1) return num.toFixed(4);
    return num.toFixed(6);
  };

  const formatPriceNum = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 100) return n.toFixed(2);
    if (abs >= 10) return n.toFixed(3);
    if (abs >= 1) return n.toFixed(3);
    if (abs >= 0.1) return n.toFixed(4);
    return n.toFixed(6);
  };

  const safeNum = (x: any) => {
    const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const formatSignedUsd = (n: number): string => {
    if (!Number.isFinite(n)) return '--';
    const sign = n >= 0 ? '+' : '-';
    return `${sign}${Math.abs(n).toFixed(2)} USDC`;
  };

  const dcFormatPrice = useCallback((price: string | null | undefined): string => {
    if (!price) return '--';
    return dc.formatDisplayPrice(parseFloat(price));
  }, [dc.formatDisplayPrice]);

  const dcFormatPriceNum = useCallback((n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    return dc.formatDisplayPrice(n);
  }, [dc.formatDisplayPrice]);

  const dcFormatSignedUsd = useCallback((n: number): string => {
    if (!Number.isFinite(n)) return '--';
    return dc.formatDisplaySigned(n);
  }, [dc.formatDisplaySigned]);

  const normalizeTimeMs = useCallback((t: any) => {
    const raw = safeNum(t);
    if (!Number.isFinite(raw)) return NaN;
    return raw < 1e12 ? raw * 1000 : raw;
  }, [safeNum]);

  const openTimeByCoin = useMemo(() => {
    const state: Record<string, { size: number; openTime: number | null }> = {};
    const fills = Array.isArray(userFills) ? [...userFills] : [];
    fills.sort((a: any, b: any) => normalizeTimeMs(a?.time ?? a?.timestamp) - normalizeTimeMs(b?.time ?? b?.timestamp));
    fills.forEach((f: any) => {
      const coin = String(f?.coin ?? f?.symbol ?? f?.asset ?? f?.market ?? '');
      if (!coin) return;
      const time = normalizeTimeMs(f?.time ?? f?.timestamp);
      if (!Number.isFinite(time)) return;
      const sideRaw = String(f?.side ?? f?.dir ?? f?.orderSide ?? '').toLowerCase();
      const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
      const sz = safeNum(f?.sz ?? f?.size ?? f?.qty);
      if (!Number.isFinite(sz) || sz === 0) return;
      const delta = (isBuy ? 1 : -1) * Math.abs(sz);
      const current = state[coin] ?? { size: 0, openTime: null };
      const prevSize = current.size;
      const nextSize = prevSize + delta;
      if (prevSize === 0 && nextSize !== 0) {
        current.openTime = time;
      } else if (prevSize !== 0 && nextSize === 0) {
        current.openTime = null;
      } else if ((prevSize > 0 && nextSize < 0) || (prevSize < 0 && nextSize > 0)) {
        current.openTime = time;
      }
      current.size = nextSize;
      state[coin] = current;
    });
    const out: Record<string, number> = {};
    Object.entries(state).forEach(([coin, v]) => {
      if (Number.isFinite(v.openTime ?? NaN)) out[coin] = v.openTime as number;
    });
    return out;
  }, [normalizeTimeMs, userFills]);

  const fundingAccrued = useMemo(() => {
    const map: Record<string, number> = {};
    const entries = Array.isArray(userFunding) ? userFunding : [];
    entries.forEach((f: any) => {
      const coin = String(f?.coin ?? f?.symbol ?? f?.asset ?? f?.market ?? '');
      if (!coin) return;
      const openTime = openTimeByCoin[coin];
      if (!Number.isFinite(openTime)) return;
      const time = normalizeTimeMs(f?.time ?? f?.timestamp);
      if (!Number.isFinite(time) || time < openTime) return;
      const amount = safeNum(
        f?.funding ??
          f?.fundingUsd ??
          f?.amount ??
          f?.delta ??
          f?.pnl ??
          f?.fundingPayment ??
          f?.usd ??
          f?.value,
      );
      if (!Number.isFinite(amount)) return;
      map[coin] = (map[coin] ?? 0) + amount;
    });
    Object.keys(openTimeByCoin).forEach((coin) => {
      if (!Number.isFinite(openTimeByCoin[coin])) return;
      if (map[coin] === undefined) map[coin] = 0;
    });
    return map;
  }, [normalizeTimeMs, openTimeByCoin, safeNum, userFunding]);

  const formatShortTime = (ms: number | string | null | undefined): string => {
    const n = typeof ms === 'number' ? ms : parseFloat(String(ms ?? ''));
    if (!Number.isFinite(n)) return '--';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const capturePnlImage = useCallback(async () => {
    if (!pnlShareRef.current || !pnlShareModal) return;
    try {
      const result = await (pnlShareRef.current as any)?.capture?.({
        format: 'png',
        quality: 1,
        result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile',
      });
      if (!result) {
        showToast(t('errors.failedToGenerateImage'));
        return null;
      }
      return result as string;
    } catch (e: any) {
      showToast(e?.message ? String(e.message) : t('errors.failedToGenerateImage'));
      return null;
    }
  }, [pnlShareModal]);

  const handleSharePnl = useCallback(async () => {
    setPnlShareLoading(true);
    try {
      const result = await capturePnlImage();
      if (!result) {
        setPnlShareLoading(false);
        return;
      }
      if (Platform.OS === 'web') {
        const nav = (globalThis as any).navigator;
        if (!nav?.share) {
          showToast(t('errors.shareNotAvailable'));
          setPnlShareLoading(false);
          return;
        }
        await nav.share({ title: 'HyperTrade PnL', url: result });
        setPnlShareLoading(false);
        return;
      }
      await sharePnlPng(result);
      setPnlShareLoading(false);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      showToast(
        msg === 'share-unavailable'
          ? t('errors.sharingNotAvailable')
          : msg || t('errors.shareFailed'),
      );
      setPnlShareLoading(false);
    }
  }, [capturePnlImage, t]);

  // (kept for later) helper to detect TP/SL trigger orders in HL openOrders payloads
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getOrderTpsl = (o: any): 'tp' | 'sl' | null => {
    const t =
      o?.tpsl ??
      o?.trigger?.tpsl ??
      o?.t?.trigger?.tpsl ??
      o?.orderType?.trigger?.tpsl ??
      null;
    return t === 'tp' || t === 'sl' ? t : null;
  };

  const handleSetupTrading = useCallback(async () => {
    if (!embeddedWallet) {
      setSetupError('Embedded wallet not available yet.');
      return;
    }
    try {
      setSetupError(null);
      setSetupLoading(true);
      pauseAutoSetup();
      // Rotate agent key on each setup to avoid reusing an address whose nonce state might later be pruned.
      // See HL docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
      const rotated = await rotateAgentKey();
      setAgentPrivateKey(rotated.agentPrivateKey);
      setAgentAddress(rotated.agentAddress);

      const provider = (await embeddedWallet.getProvider()) as unknown as Eip1193Provider;
      await setupTradingAccount({
        userWalletProvider: provider,
        userAddress: embeddedAddress,
        agentAddress: rotated.agentAddress as `0x${string}`,
        agentPrivateKey: rotated.agentPrivateKey as `0x${string}`,
      });

      // Confirm the agent is active and account mode is unified before dismissing the modal.
      // HL can take a moment to reflect approvals; if we close immediately, the state machine reopens it.
      showToast(t('trading.confirmingSetup'));
      const deadline = Date.now() + 45_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        try {
          const next = await getHyperliquidTradingState(embeddedAddress);
          if (next.isAgentActive && isPooledAccountMode(next.accountAbstractionMode)) {
            confirmed = true;
            break;
          }
        } catch {
          // ignore transient network errors while polling
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      await refetchTradingState();

      if (confirmed) {
        showToast(t('trading.oneTapTradingEnabled'), t('trading.setupComplete'));
        await markTradingSetupComplete();
        setSetupComplete(true);
        setShowSetupModal(false);
      } else {
        setSetupError('Setup submitted but not fully confirmed yet. Wait ~30s and try again.');
        setShowSetupModal(true);
      }
    } catch (e: any) {
      setSetupError(e?.message ? String(e.message) : 'Setup failed');
    } finally {
      setSetupLoading(false);
      resumeAutoSetup();
    }
  }, [embeddedAddress, embeddedWallet, refetchTradingState, pauseAutoSetup, resumeAutoSetup]);

  const handleCancelOrder = useCallback(async (symbol: string, oid: number) => {
    try {
      setCancelingOrderId(oid);
      if (!agentPrivateKey) return;
      await cancelOpenOrder({
        agentPrivateKey: agentPrivateKey as `0x${string}`,
        symbol,
        oid,
        vaultAddress,
      });
      await refetchOpenOrders();
    } catch (e: any) {
      showToast(e?.message ? String(e.message) : t('errors.cancelFailed'), t('errors.cancelFailed'));
    } finally {
      setCancelingOrderId(null);
    }
  }, [agentPrivateKey, refetchOpenOrders, t, vaultAddress]);

  const handleModifyOrder = useCallback(async (payload: {
    symbol: string;
    oid: number;
    side: 'buy' | 'sell';
    sizeUnits: string;
    isSpot: boolean;
    reduceOnly?: boolean;
    cloid?: string | null;
    isTrigger?: boolean;
  tpsl?: 'tp' | 'sl';
  }, nextLimitPx: number) => {
    if (!agentPrivateKey) {
      showToast(t('errors.agentKeyNotReady'));
      return;
    }
    try {
      await modifyOpenOrder({
        agentPrivateKey: agentPrivateKey as `0x${string}`,
        symbol: payload.symbol,
        oid: payload.oid,
        side: payload.side,
        sizeUnits: payload.sizeUnits,
        limitPx: nextLimitPx,
        reduceOnly: payload.reduceOnly,
        cloid: payload.cloid,
        isTrigger: payload.isTrigger,
        tpsl: payload.tpsl,
        vaultAddress,
      });
      await refetchOpenOrders();
      showToast(t('trading.orderUpdated'));
    } catch (e: any) {
      throw e;
    }
  }, [agentPrivateKey, refetchOpenOrders, vaultAddress]);

  const handleMarketClose = useCallback(async (symbol: string, szi: string) => {
    if (!embeddedAddress || !embeddedWallet) return;
    try {
      setClosingPositionKey(`${symbol}:${szi}`);
      if (!agentPrivateKey) return;
      const isSpot = symbol.startsWith('@') || symbol.toUpperCase().includes('/USDC');
      let symbolOraclePx: number | undefined = (() => {
        const px =
          pickPrice(livePricesRef.current, { coin: symbol, isHip3: symbol.includes(':') }) ??
          pickPrice(hip3PricesRef.current, { coin: symbol, isHip3: symbol.includes(':') });
        return px ? parseFloat(px) : undefined;
      })();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (isSpot) {
            await marketCloseSpotPosition({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol,
              sizeUnits: szi,
              referencePx: symbolOraclePx,
              vaultAddress,
            });
          } else {
            await marketClosePosition({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol,
              szi,
              oraclePx: symbolOraclePx,
              vaultAddress,
            });
          }
          break;
        } catch (err: any) {
          if (attempt === 2 || !isRateLimitError(err)) throw err;
          await new Promise((r) => setTimeout(r, 6000));
          const refreshed =
            pickPrice(livePricesRef.current, { coin: symbol, isHip3: symbol.includes(':') }) ??
            pickPrice(hip3PricesRef.current, { coin: symbol, isHip3: symbol.includes(':') });
          if (refreshed) symbolOraclePx = parseFloat(refreshed);
        }
      }
      await Promise.all([
        refetchTradingState(),
        refetchOpenOrders(),
        refetchSpotState(),
        refetchUserFills(),
      ]);
      if (embeddedAddress) {
        getAccessToken().then((token) => {
          if (token) reportTrade(embeddedAddress!, token).catch(() => {});
        });
      }
    } catch (e: any) {
      const h = humanizeHyperliquidError(e?.message ? String(e.message) : '');
      showToast(h.message, h.title);
    } finally {
      setClosingPositionKey(null);
    }
  }, [agentPrivateKey, embeddedAddress, embeddedWallet, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, getAccessToken, vaultAddress]);

  const handleCloseAllPositions = useCallback(async () => {
    if (!embeddedAddress || !embeddedWallet) return;
    try {
      setCloseAllLoading(true);


      // --- Close HL positions ---
      if (filteredPositions.length > 0 && agentPrivateKey) {
        // Build spot positions from spot balances (same logic as PortfolioTabs).
        // Skip residue below HL's min spot lot (10^-szDecimals) and anything
        // under $1 — both are hidden in PortfolioTabs (the lot floor for
        // protocol-unsellable dust, the $1 cutoff because HL's $10 spot
        // order minimum makes sub-dollar balances unactionable anyway).
        // Close All shouldn't surface errors for rows the user doesn't see.
        const SPOT_DUST_USD = 1;
        const spotBalancesSource = stream.spotState?.balances ?? spotState?.balances ?? [];
        const byBase = spotSymbolMap?.byBase ?? {};
        const szDecimalsByBase = spotSymbolMap?.szDecimalsByBase ?? {};
        const szDecimalsBySymbol = spotSymbolMap?.szDecimalsBySymbol ?? {};
        const markPxBySymbol = spotSymbolMap?.markPxBySymbol ?? {};
        const markPxByBase = spotSymbolMap?.markPxByBase ?? {};
        const spotPositionsToClose: { symbol: string; szi: string }[] = [];

        spotBalancesSource.forEach((b: any) => {
          const base = String(b?.coin ?? '').toUpperCase();
          if (!base || base === 'USDC') return;
          const total = parseFloat(b?.total ?? '0');
          const hold = parseFloat(b?.hold ?? '0');
          const available = Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(hold) ? hold : 0));
          if (!Number.isFinite(available) || available <= 0) return;
          const spotSymbol = byBase[base];
          if (!spotSymbol) return;
          const szDec = Number(szDecimalsBySymbol[spotSymbol] ?? szDecimalsByBase[base]);
          const minLot = Number.isFinite(szDec) ? Math.pow(10, -szDec) : 0;
          if (Number.isFinite(minLot) && minLot > 0 && available < minLot) return;
          const markPxStr =
            markPxBySymbol[spotSymbol] ??
            markPxByBase[base] ??
            (pickPrice(livePricesRef.current, { coin: spotSymbol }) ?? pickPrice(hip3PricesRef.current, { coin: spotSymbol }));
          const markPxNum = markPxStr ? parseFloat(String(markPxStr)) : NaN;
          const valueUsd = Number.isFinite(markPxNum) ? available * markPxNum : NaN;
          if (Number.isFinite(valueUsd) && valueUsd < SPOT_DUST_USD) return;
          spotPositionsToClose.push({ symbol: spotSymbol, szi: String(available) });
        });

        // Close perp positions — wrap each so one failure doesn't abort the batch.
        // ONE reduce-only retry per leg with a fresh price. Catches HL's
        // per-order rejections (price-band, "zero size") that hit HIP-3
        // books harder because mid drifts ~200-400ms while the previous
        // leg signs/fills. Reduce-only ensures a retry can never oversell.
        // 429 backoff is ~6s (HL throttles abused addresses to 1/10s);
        // 200ms inter-leg pacing avoids triggering the throttle to begin
        // with. See `isRateLimitError` in hyperliquid.ts.
        for (let i = 0; i < filteredPositions.length; i++) {
          const p = filteredPositions[i];
          const szi = String(p?.szi ?? '');
          const symbol = String(p?.coin ?? '');
          if (!symbol || !szi) continue;
          if (i > 0) await new Promise((r) => setTimeout(r, 200));
          const isSpot = symbol.startsWith('@') || symbol.toUpperCase().includes('/USDC');
          let attemptOraclePx: number | undefined = (() => {
            const px =
              pickPrice(livePricesRef.current, { coin: symbol, isHip3: symbol.includes(':') }) ??
              pickPrice(hip3PricesRef.current, { coin: symbol, isHip3: symbol.includes(':') });
            return px ? parseFloat(px) : undefined;
          })();
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              if (isSpot) {
                await marketCloseSpotPosition({
                  agentPrivateKey: agentPrivateKey as `0x${string}`,
                  symbol,
                  sizeUnits: szi,
                  referencePx: attemptOraclePx,
                  vaultAddress,
                });
              } else {
                await marketClosePosition({
                  agentPrivateKey: agentPrivateKey as `0x${string}`,
                  symbol,
                  szi,
                  oraclePx: attemptOraclePx,
                  vaultAddress,
                });
              }
              break;
            } catch (err: any) {
              const tag = attempt === 2 ? 'final' : 'retrying';
              console.warn(`[CloseAll] Failed to close ${symbol} (${tag}): ${err?.message ?? err}`);
              if (attempt === 2) break;
              const wasRateLimited = isRateLimitError(err);
              await new Promise((r) => setTimeout(r, wasRateLimited ? 6000 : 350));
              const refreshed =
                pickPrice(livePricesRef.current, { coin: symbol, isHip3: symbol.includes(':') }) ??
                pickPrice(hip3PricesRef.current, { coin: symbol, isHip3: symbol.includes(':') });
              if (refreshed) attemptOraclePx = parseFloat(refreshed);
            }
          }
        }

        // Close spot positions
        for (const sp of spotPositionsToClose) {
          const symbolLivePrice = pickPrice(livePricesRef.current, { coin: sp.symbol }) ?? pickPrice(hip3PricesRef.current, { coin: sp.symbol });
          const symbolOraclePx = symbolLivePrice ? parseFloat(symbolLivePrice) : undefined;
          try {
            await marketCloseSpotPosition({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol: sp.symbol,
              sizeUnits: sp.szi,
              referencePx: symbolOraclePx,
              vaultAddress,
            });
          } catch (err: any) {
            console.warn(`[CloseAll] Failed to close spot ${sp.symbol}: ${err?.message ?? err}`);
          }
        }
      }

      showToast(t('portfolio.closedAllPositions'));
      await Promise.all([
        refetchTradingState(),
        refetchOpenOrders(),
        refetchSpotState(),
        refetchUserFills(),
      ]);
      if (embeddedAddress) {
        getAccessToken().then((token) => {
          if (token) reportTrade(embeddedAddress!, token).catch(() => {});
        });
      }
    } catch (e: any) {
      showToast(e?.message ? String(e.message) : t('errors.closeAllFailed'), t('errors.closeAllFailed'));
    } finally {
      setCloseAllLoading(false);
    }
  }, [agentPrivateKey, embeddedAddress, embeddedWallet, filteredPositions, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, spotState?.balances, spotSymbolMap?.byBase, stream.spotState?.balances, getAccessToken, vaultAddress]);

  const handleCancelAllOrders = useCallback(async () => {
    if (!embeddedAddress) return;
    try {
      setCancelAllLoading(true);
      if (!agentPrivateKey) return;
      for (const o of filteredOpenOrders) {
        const symbol = String(o?.coin ?? '');
        const oid = Number(o?.oid);
        if (!symbol || !Number.isFinite(oid)) continue;
        await cancelOpenOrder({
          agentPrivateKey: agentPrivateKey as `0x${string}`,
          symbol,
          oid,
          vaultAddress,
        });
      }
      showToast(t('portfolio.cancelledAllOrders'));
      await refetchOpenOrders();
    } catch (e: any) {
      showToast(e?.message ? String(e.message) : t('errors.cancelAllFailed'), t('errors.cancelAllFailed'));
    } finally {
      setCancelAllLoading(false);
    }
  }, [agentPrivateKey, embeddedAddress, filteredOpenOrders, refetchOpenOrders, t, vaultAddress]);

  // Memoized callbacks to prevent PortfolioTabs re-renders
  const handleOpenTpsl = useCallback((payload: any) => {
    setPosTpEnabled(false);
    setPosSlEnabled(false);
    setPosTpPxText('');
    setPosSlPxText('');
    setPosTpslModal(payload);
  }, []);

  const handleSharePositionPnl = useCallback((payload: any) => {
    setPnlShareModal(payload);
  }, []);

  const handleShareFillPnl = useCallback((payload: any) => {
    setPnlShareModal(payload);
  }, []);

  return (
    <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
      {orderSuccessAlert ? (
        <FloatingTradeAlert
          variant="success"
          title={orderSuccessAlert.title}
          message={orderSuccessAlert.message}
          top={(topStripActive ? topPadding : insets.top) + 8}
        />
      ) : null}
      {orderErrorAlert ? (
        <FloatingTradeAlert
          variant="error"
          title={orderErrorAlert.title}
          message={orderErrorAlert.message}
          top={(topStripActive ? topPadding : insets.top) + 8}
        />
      ) : null}
      <Modal visible={showSetupModal && !isExternalWalletUser} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {/* Demo-mode awareness pill — makes it unambiguous that this
                signature enables testnet trading, not real funds. Only
                rendered when the user is currently in demo env. */}
            {tradingEnv === 'demo' && (
              <View style={styles.demoSetupPill}>
                <Ionicons name="flask" size={12} color={colors.accent.gold} />
                <Text style={styles.demoSetupPillText}>{t('trading.demoModePillLabel')}</Text>
              </View>
            )}
            <Text style={styles.modalTitle}>{t('trading.activateSeamlessTrading', 'Activate seamless trading')}</Text>
            <Text style={styles.modalText}>
              {t(
                'trading.activateSeamlessTradingDescription',
                'Approve this free one-time setup to enable unified balances, one-tap orders, and builder-fee trading.',
              )}
            </Text>
            
            {!!setupError && <Text style={styles.modalError}>{setupError}</Text>}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={handleSetupTrading} disabled={setupLoading}>
                {setupLoading ? (
                  <ActivityIndicator color={colors.background.primary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>{t('trading.activateSeamlessTradingButton', 'Activate Trading')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!posTpslModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <KeyboardAwareScrollView
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
            bottomOffset={24}
          >
            <View style={styles.modalCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.modalTitle}>{t('trading.tpSl')}</Text>
              <TouchableOpacity onPress={() => setPosTpslModal(null)} disabled={posTpslLoading}>
                <Ionicons name="close" size={22} color={colors.text.primary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalText}>
              {posTpslModal ? `${formatDisplaySymbol(posTpslModal.coin)} · ${marginMode === 'cross' ? t('trading.cross') : t('trading.isolated')}` : ''}
            </Text>

            {posTpslModal ? (
              <View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.entryPrice')}</Text>
                  <Text style={styles.modalValue}>${formatPriceNum(posTpslModal.entryPx)}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.markPrice')}</Text>
                  <Text style={styles.modalValue}>${formatPriceNum(posTpslModal.markPx)}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.positionSize')}</Text>
                  <Text style={styles.modalValue}>{formatPriceNum(posTpslModal.sizeUnits)} {t('trading.units')}</Text>
                </View>
              </View>
            ) : null}

            <View style={{ marginTop: 12 }}>
              <View style={styles.tpSlRow}>
                <TouchableOpacity style={styles.tpSlToggle} onPress={() => setPosTpEnabled((v) => !v)} disabled={posTpslLoading}>
                  <Ionicons name={posTpEnabled ? 'checkbox' : 'square-outline'} size={18} color={colors.accent.gold} />
                  <Text style={styles.tpSlToggleText}>{t('trading.takeProfit')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.tpSlToggle} onPress={() => setPosSlEnabled((v) => !v)} disabled={posTpslLoading}>
                  <Ionicons name={posSlEnabled ? 'checkbox' : 'square-outline'} size={18} color={colors.accent.gold} />
                  <Text style={styles.tpSlToggleText}>{t('trading.stopLoss')}</Text>
                </TouchableOpacity>
              </View>

              {posTpEnabled ? (
                <View style={{ marginTop: 12 }}>
                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabelStandalone}>{t('trading.tpTriggerPrice')}</Text>
                    <TextInput
                      value={posTpPxText}
                      onChangeText={setPosTpPxText}
                      keyboardType="decimal-pad"
                      placeholder={posTpslModal ? formatPriceNum(posTpslModal.markPx) : '0'}
                      placeholderTextColor={colors.text.tertiary}
                      style={styles.input}
                    />
                    {posTpPx && posTpslModal ? (
                      (() => {
                        const roePct = getPosTpslRoePct(posTpPnlUsd);
                        if (typeof roePct !== 'number' || !Number.isFinite(roePct)) return null;
                        const isProfit = roePct > 0;
                        return (
                          <View style={[styles.percentBadge, { backgroundColor: `${isProfit ? colors.status.success : colors.status.error}20`, borderColor: isProfit ? colors.status.success : colors.status.error, marginTop: 6, alignSelf: 'flex-start' }]}>
                            <Text style={[styles.percentBadgeText, { color: isProfit ? colors.status.success : colors.status.error }]}>
                              {isProfit ? `+${roePct.toFixed(2)}% ROE ${t('trading.gain')}` : `${roePct.toFixed(2)}% ROE ${t('trading.loss')}`}
                            </Text>
                          </View>
                        );
                      })()
                    ) : null}
                  </View>
                  <Text style={styles.inputHint}>
                    {t('trading.estPnl')}:{' '}
                    {typeof posTpPnlUsd === 'number' && Number.isFinite(posTpPnlUsd)
                      ? `${formatSignedUsd(posTpPnlUsd)}`
                      : '--'}
                  </Text>
                </View>
              ) : null}

              {posSlEnabled ? (
                <View style={{ marginTop: 12 }}>
                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabelStandalone}>{t('trading.slTriggerPrice')}</Text>
                    <TextInput
                      value={posSlPxText}
                      onChangeText={setPosSlPxText}
                      keyboardType="decimal-pad"
                      placeholder={posTpslModal ? formatPriceNum(posTpslModal.markPx) : '0'}
                      placeholderTextColor={colors.text.tertiary}
                      style={styles.input}
                    />
                    {posSlPx && posTpslModal ? (
                      (() => {
                        const roePct = getPosTpslRoePct(posSlPnlUsd);
                        if (typeof roePct !== 'number' || !Number.isFinite(roePct)) return null;
                        const isLoss = roePct < 0;
                        return (
                          <View style={[styles.percentBadge, { backgroundColor: `${isLoss ? colors.status.error : colors.status.success}20`, borderColor: isLoss ? colors.status.error : colors.status.success, marginTop: 6, alignSelf: 'flex-start' }]}>
                            <Text style={[styles.percentBadgeText, { color: isLoss ? colors.status.error : colors.status.success }]}>
                              {roePct < 0 ? `${roePct.toFixed(2)}% ROE ${t('trading.loss')}` : `+${roePct.toFixed(2)}% ROE ${t('trading.gain')}`}
                            </Text>
                          </View>
                        );
                      })()
                    ) : null}
                  </View>
                  <Text style={styles.inputHint}>
                    {t('trading.estPnl')}:{' '}
                    {typeof posSlPnlUsd === 'number' && Number.isFinite(posSlPnlUsd)
                      ? `${formatSignedUsd(posSlPnlUsd)}`
                      : '--'}
                  </Text>
                </View>
              ) : null}
            </View>

            {existingPosTriggers.length ? (
              <View style={{ marginTop: 10 }}>
                <Text style={[styles.modalLabel, { marginBottom: 6 }]}>{t('trading.existingTpsl')}</Text>
                {existingPosTriggers.map((t: any) => (
                  <View key={String(t.oid)} style={styles.modalRow}>
                    <Text style={styles.modalValue}>
                      {t.tpsl?.toUpperCase()} @ {t.triggerPx ?? '--'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        if (!t.oid) return;
                        handleCancelOrder(String(t.coin), Number(t.oid));
                      }}
                      disabled={posTpslLoading || isSubmitting}
                    >
                      <Text style={styles.positionAction}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalSecondary}
                onPress={() => setPosTpslModal(null)}
                disabled={posTpslLoading}
              >
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={async () => {
                  if (!posTpslModal) return;
                  try {
                    setPosTpslLoading(true);
                    const tpPxNum = safeNum(posTpPx);
                    const slPxNum = safeNum(posSlPx);
                    const hasTp = posTpEnabled && Number.isFinite(tpPxNum) && tpPxNum > 0;
                    const hasSl = posSlEnabled && Number.isFinite(slPxNum) && slPxNum > 0;
                    if (!hasTp && !hasSl) {
                      showToast('Enter TP and/or SL trigger price');
                      return;
                    }

                    const oraclePxForUnits = posTpslModal.markPx;

                    if (!agentPrivateKey) {
                      showToast(t('errors.agentKeyNotReady'));
                      return;
                    }
                    // HL doesn't have a "modify TP/SL" endpoint — to
                    // edit an existing trigger we must cancel the old
                    // one first, otherwise placing a new TP/SL leaves
                    // BOTH live on the position. Cancellations for
                    // missing oids are tolerated silently so the
                    // place-step still runs even if state is stale.
                    const cancelExistingByType = async (kind: 'tp' | 'sl') => {
                      const matches = existingPosTriggers.filter((x: any) => x.tpsl === kind && x.oid != null);
                      for (const m of matches) {
                        try {
                          await cancelOpenOrder({
                            agentPrivateKey: agentPrivateKey as `0x${string}`,
                            symbol: String(m.coin),
                            oid: Number(m.oid),
                            vaultAddress,
                          });
                        } catch {
                          // Ignore — order may have already filled or been cancelled.
                        }
                      }
                    };

                    if (hasTp) {
                      await cancelExistingByType('tp');
                      // TP/SL orders always close the full position
                      const sizeUsd = posTpslModal.sizeUnits * oraclePxForUnits;
                      await placeReduceOnlyTpslTrigger({
                        agentPrivateKey: agentPrivateKey as `0x${string}`,
                        symbol: posTpslModal.coin,
                        entrySide: posTpslModal.entrySide,
                        sizeUsd,
                        oraclePx: oraclePxForUnits,
                        triggerPx: tpPxNum,
                        tpsl: 'tp',
                        vaultAddress,
                      });
                    }

                    if (hasSl) {
                      await cancelExistingByType('sl');
                      // TP/SL orders always close the full position
                      const sizeUsd = posTpslModal.sizeUnits * oraclePxForUnits;
                      await placeReduceOnlyTpslTrigger({
                        agentPrivateKey: agentPrivateKey as `0x${string}`,
                        symbol: posTpslModal.coin,
                        entrySide: posTpslModal.entrySide,
                        sizeUsd,
                        oraclePx: oraclePxForUnits,
                        triggerPx: slPxNum,
                        tpsl: 'sl',
                        vaultAddress,
                      });
                    }

                    showToast(t('trading.tpslOrdersPlaced'));
                    await refetchOpenOrders();
                    setPosTpslModal(null);
                  } catch (e: any) {
                    const msg = e?.message ? String(e.message) : 'Failed to place TP/SL';
                    const h = humanizeHyperliquidError(msg);
                    // Close the modal first so the in-page banner is
                    // visible — the modal sits ABOVE the toast layer on
                    // iOS native presentations and would hide the global
                    // toast otherwise (same fix as order-submit errors).
                    setPosTpslModal(null);
                    showOrderErrorAlert(h.message, h.title);
                  } finally {
                    setPosTpslLoading(false);
                  }
                }}
                disabled={posTpslLoading}
              >
                {posTpslLoading ? (
                  <ActivityIndicator color={colors.background.primary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>{t('trading.place')}</Text>
                )}
              </TouchableOpacity>
            </View>

            <Text style={[styles.modalText, { marginTop: 10, color: colors.text.tertiary }]}>
              {t('trading.reduceOnlyTpslDescription')}
            </Text>
            </View>
          </KeyboardAwareScrollView>
        </View>
      </Modal>

      <Modal visible={!!pnlShareModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.pnlModalCard}>
            <View style={styles.pnlModalHeader}>
              <Text style={styles.modalTitle}>{t('trading.sharePnl')}</Text>
              <TouchableOpacity onPress={() => setPnlShareModal(null)} disabled={pnlShareLoading}>
                <Ionicons name="close" size={20} color={colors.text.primary} />
              </TouchableOpacity>
            </View>
            <PnlShareExportFrame ref={pnlShareRef}>
              {pnlShareModal ? (
                <PnlShareCard
                  symbol={pnlShareModal.symbol}
                  direction={pnlShareModal.direction}
                  pnlPercent={pnlShareModal.pnlPercent}
                  entryPrice={pnlShareModal.entryPrice}
                  markPrice={pnlShareModal.markPrice}
                  leverage={pnlShareModal.leverage}
                />
              ) : null}
            </PnlShareExportFrame>
            <TouchableOpacity
              style={styles.pnlShareButton}
              onPress={handleSharePnl}
              disabled={pnlShareLoading}
              activeOpacity={0.85}
            >
              {pnlShareLoading ? (
                <ActivityIndicator color={colors.background.primary} />
              ) : (
                <Text style={styles.pnlShareButtonText}>{t('common.share')}</Text>
              )}
            </TouchableOpacity>

          </View>
        </View>
      </Modal>

      <Modal
        visible={showOrderTypeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOrderTypeModal(false)}
      >
        <TouchableOpacity 
          style={styles.modalBackdrop} 
          activeOpacity={1} 
          onPress={() => setShowOrderTypeModal(false)}
        >
          <View style={styles.modalCard}>
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>{t('trading.orderTypes')}</Text>
              <TouchableOpacity
                style={styles.infoIconButton}
                onPress={() => {
                  setShowOrderTypeModal(false);
                  // Small delay to ensure modal closes before opening info modal
                  setTimeout(() => {
                    setInfoModal({
                      title: t('trading.orderTypes'),
                      body: t('trading.orderTypesDescription'),
                    });
                  }, 100);
                }}
              >
                <Ionicons name="information-circle" size={16} color={colors.text.tertiary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalText}>{t('trading.chooseAdditionalOrderTypes')}</Text>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setOrderType('stop_market');
                setShowOrderTypeModal(false);
              }}
            >
              <Text style={styles.modalLabel}>{t('trading.stopMarket')}</Text>
              {orderType === 'stop_market' ? (
                <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
              ) : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setOrderType('stop_limit');
                setShowOrderTypeModal(false);
              }}
            >
              <Text style={styles.modalLabel}>{t('trading.stopLimit')}</Text>
              {orderType === 'stop_limit' ? (
                <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
              ) : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setOrderType('take_market');
                setShowOrderTypeModal(false);
              }}
            >
              <Text style={styles.modalLabel}>{t('trading.takeMarket')}</Text>
              {orderType === 'take_market' ? (
                <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
              ) : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setOrderType('take_limit');
                setShowOrderTypeModal(false);
              }}
            >
              <Text style={styles.modalLabel}>{t('trading.takeLimit')}</Text>
              {orderType === 'take_limit' ? (
                <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
              ) : null}
            </TouchableOpacity>
            <View style={styles.modalButtons}>
              <TouchableOpacity 
                style={styles.modalSecondary} 
                onPress={() => setShowOrderTypeModal(false)}
              >
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={transferModalOpen} transparent animationType="fade" onRequestClose={() => setTransferModalOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setTransferModalOpen(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('portfolio.transferFunds')}</Text>
            <Text style={styles.modalText}>{t('portfolio.transferFundsDescription')}</Text>
            <View style={styles.transferToggleRow}>
              <TouchableOpacity
                style={[styles.transferToggleButton, transferDirection === 'toPerp' && styles.transferToggleButtonActive]}
                onPress={() => setTransferDirection('toPerp')}
              >
                <Text style={[styles.transferToggleText, transferDirection === 'toPerp' && styles.transferToggleTextActive]}>
                  {t('portfolio.spotToPerp')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.transferToggleButton, transferDirection === 'toSpot' && styles.transferToggleButtonActive]}
                onPress={() => setTransferDirection('toSpot')}
              >
                <Text style={[styles.transferToggleText, transferDirection === 'toSpot' && styles.transferToggleTextActive]}>
                  {t('portfolio.perpToSpot')}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.transferAmountRow}>
              <Text style={styles.modalLabel}>{t('portfolio.amount')}</Text>
              <TouchableOpacity onPress={handleTransferMax}>
                <Text style={styles.transferMaxText}>{t('common.max')}</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              value={transferAmountText}
              onChangeText={setTransferAmountText}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.text.tertiary}
              style={styles.transferInput}
            />
            <Text style={styles.transferAvailableText}>
              {t('portfolio.available', { amount: Number.isFinite(transferAvailableUsd) ? transferAvailableUsd.toFixed(2) : '0.00' })}
            </Text>
            {transferDirection === 'toSpot' ? (
              <Text style={styles.transferWarningText}>
                {t('portfolio.transferWarning')}
              </Text>
            ) : null}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setTransferModalOpen(false)} disabled={isTransferring}>
                <Text style={styles.modalSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalPrimary} onPress={submitTransfer} disabled={isTransferring}>
                {isTransferring ? <ActivityIndicator color={colors.background.primary} /> : <Text style={styles.modalPrimaryText}>{t('portfolio.transfer')}</Text>}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={showMarketTypeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMarketTypeModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowMarketTypeModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.marketType')}</Text>
            <View style={styles.transferToggleRow}>
              <TouchableOpacity
                style={[styles.transferToggleButton, marketType === 'perp' && styles.transferToggleButtonActive]}
                onPress={() => {
                  setMarketType('perp');
                  setShowMarketTypeModal(false);
                }}
              >
                <Text style={[styles.transferToggleText, marketType === 'perp' && styles.transferToggleTextActive]}>{t('portfolio.perp')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.transferToggleButton,
                  marketType === 'spot' && styles.transferToggleButtonActive,
                  !spotAvailable && styles.modePillDisabled,
                ]}
                onPress={() => {
                  if (!spotAvailable) return;
                  setMarketType('spot');
                  setSide('long');
                  setShowMarketTypeModal(false);
                }}
                disabled={!spotAvailable}
              >
                <Text
                  style={[
                    styles.transferToggleText,
                    marketType === 'spot' && styles.transferToggleTextActive,
                    !spotAvailable && styles.modePillTextDisabled,
                  ]}
                >
                  {t('trading.spot')}
                </Text>
              </TouchableOpacity>
            </View>
            {!spotAvailable ? (
              <Text style={styles.modalText}>{t('trading.spotNotAvailable')}</Text>
            ) : null}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setShowMarketTypeModal(false)}>
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={balanceModalOpen} transparent animationType="fade" onRequestClose={() => setBalanceModalOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setBalanceModalOpen(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('portfolio.balanceBreakdown')}</Text>
            
            <>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>{t('portfolio.usdcBalance')}</Text>
                <Text style={styles.modalValue}>${spotBalances.available.toFixed(2)}</Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>{asset?.symbol?.toUpperCase() || t('common.asset')} {t('portfolio.balance')}</Text>
                <Text style={styles.modalValue}>
                  {spotBaseAvailable.available.toFixed(4)} {asset?.symbol?.toUpperCase() || ''}
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>{asset?.symbol?.toUpperCase() || t('common.asset')} {t('portfolio.valueUsd')}</Text>
                <Text style={styles.modalValue}>${spotBaseUsd.toFixed(2)}</Text>
              </View>
              <View style={[styles.modalRow, { borderTopWidth: 1, borderTopColor: colors.border.primary, marginTop: 8, paddingTop: 12 }]}>
                <Text style={[styles.modalLabel, { fontWeight: '800', color: colors.text.primary }]}>{t('portfolio.totalSpotBalance')}</Text>
                <Text style={[styles.modalValue, { fontWeight: '900', color: colors.accent.gold }]}>
                  ${spotTotalUsd.toFixed(2)}
                </Text>
              </View>
            </>

            {showSpotPerpTransferLink ? (
              <View style={styles.modalButtons}>
                <TouchableOpacity style={styles.modalPrimary} onPress={() => {
                  setBalanceModalOpen(false);
                  setTransferModalOpen(true);
                }}>
                  <Text style={styles.modalPrimaryText}>{t('portfolio.transfer')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={confirmOrderModalOpen} transparent animationType="fade" onRequestClose={() => setConfirmOrderModalOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setConfirmOrderModalOpen(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.confirmOrder')}</Text>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.side')}</Text>
              <Text style={styles.modalValue}>
                {marketType === 'spot' ? (side === 'long' ? t('trading.buy') : t('trading.sell')) : side === 'long' ? t('trading.long') : t('trading.short')}
              </Text>
            </View>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.market')}</Text>
              <Text style={styles.modalValue}>{marketType === 'spot' ? t('trading.spot') : t('portfolio.perp')}</Text>
            </View>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.symbol')}</Text>
              <Text style={styles.modalValue}>{asset?.symbol ?? '--'}</Text>
            </View>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.orderType')}</Text>
              <Text style={styles.modalValue}>{orderTypeLabel}</Text>
            </View>
            {isTriggerOrder ? (
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>
                  {isStopOrder ? t('trading.stopPrice') : t('trading.takePrice')}
                </Text>
                <Text style={styles.modalValue}>
                  {triggerPx ? `$${formatPriceNum(triggerPx)}` : '--'}
                </Text>
              </View>
            ) : null}
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.price')}</Text>
              <Text style={styles.modalValue}>
                {orderType === 'market'
                  ? (currentMidPx ? `$${formatPriceNum(currentMidPx)}` : '--')
                  : orderType === 'stop_market' || orderType === 'take_market'
                    ? t('trading.market')
                    : limitPx
                      ? `$${formatPriceNum(limitPx)}`
                      : '--'}
              </Text>
            </View>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.orderValue')}</Text>
              <Text style={styles.modalValue}>{sizeUsd > 0 ? `${sizeUsd.toFixed(2)} USDC` : '--'}</Text>
            </View>
            {marketType === 'perp' ? (
              <>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.leverage')}</Text>
                  <Text style={styles.modalValue}>{leverage}x</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.margin')}</Text>
                  <Text style={styles.modalValue}>{marginMode === 'cross' ? t('trading.cross') : t('trading.isolated')}</Text>
                </View>
              </>
            ) : null}

            <TouchableOpacity
              style={styles.confirmCheckboxRow}
              onPress={() => persistSkipOrderConfirm(!skipOrderConfirm)}
              activeOpacity={0.8}
            >
              <View style={[styles.confirmCheckbox, skipOrderConfirm && styles.confirmCheckboxChecked]}>
                {skipOrderConfirm ? <Ionicons name="checkmark" size={14} color={colors.background.primary} /> : null}
              </View>
              <Text style={styles.confirmCheckboxText}>{t('trading.doNotAskAgain')}</Text>
            </TouchableOpacity>

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setConfirmOrderModalOpen(false)}>
                <Text style={styles.modalSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={() => {
                  setConfirmOrderModalOpen(false);
                  executeSubmitOrder();
                }}
              >
                <Text style={styles.modalPrimaryText}>{t('trading.placeOrder')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {sharedAiModal}

      <View style={styles.header}>
        <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
          <Ionicons name="close" size={24} color={colors.text.primary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <AssetLogo symbol={asset?.symbol || ''} size={36} />
          <View style={styles.headerTitle}>
            <View style={styles.symbolRow}>
              <Text style={styles.symbol}>{asset?.symbol || '--'}</Text>
              {/* In demo mode the perp/spot badge is replaced with a DEMO
                  badge — testnet universe is vetted perps only so the
                  toggle is moot. */}
              {tradingEnv === 'demo' ? (
                <DemoBadge />
              ) : isSpotOnly ? (
                <View style={styles.marketBadge}>
                  <Text style={styles.marketBadgeText}>{t('trading.marketTypeSpot')}</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.marketBadge}
                  onPress={() => setShowMarketTypeModal(true)}
                >
                  <Text style={styles.marketBadgeText}>{marketType === 'spot' ? t('trading.marketTypeSpot') : t('trading.marketTypePerp')}</Text>
                  <Ionicons name="information-circle" size={10} color={colors.accent.gold} />
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.headerPriceBlock}>
              <View style={styles.headerPriceWithHint}>
                <Text style={styles.price}>
                  {currentMidPx ? `$${formatPriceNum(currentMidPx)}` : '--'}
                </Text>
                <CurrencyHint usd={currentMidPx ?? undefined} placement="inline" />
              </View>
              {typeof asset?.change24h === 'number' ? (
                <Text style={[styles.priceChangeBadge, { color: asset.change24h >= 0 ? colors.status.success : colors.status.error }]}>
                  {(asset.change24h >= 0 ? '+' : '') + asset.change24h.toFixed(2)}%
                </Text>
              ) : null}
            </View>
        </View>
        </View>
        <TouchableOpacity
          style={[styles.orderBookToggle, showOrderBook && styles.orderBookToggleActive]}
          onPress={toggleOrderBook}
        >
          <Ionicons
            name="stats-chart"
            size={18}
            color={showOrderBook ? colors.accent.gold : colors.text.tertiary}
          />
        </TouchableOpacity>
      </View>

      {/*
        LONG / SHORT row is rendered as a *sibling* above the ScrollView
        (not a sticky header) so it is always visible regardless of scroll
        position. We tried ScrollView.stickyHeaderIndices but on iOS the
        pinned child's width collapses and the two flex:1 buttons stack
        vertically. A plain sibling is trivially reliable.
      */}
      <View style={styles.sideSelectorPinned}>
        <TouchableOpacity
          style={[styles.sideButton, side === 'long' && styles.sideButtonLongActive]}
          onPress={() => handleSideChange('long')}
        >
          <Ionicons name="trending-up" size={20} color={side === 'long' ? '#fff' : colors.status.success} />
          <Text style={[styles.sideButtonText, side === 'long' && styles.sideButtonTextActive]}>
            {marketType === 'spot' ? t('trading.buy') : t('trading.long')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.sideButton, side === 'short' && styles.sideButtonShortActive, !canSellSpot && marketType === 'spot' && styles.sideButtonDisabled]}
          onPress={() => {
            if (marketType === 'spot' && !canSellSpot) {
              showToast(t('errors.noSpotBalanceToSell'));
              return;
            }
            handleSideChange('short');
          }}
          disabled={marketType === 'spot' && !canSellSpot}
        >
          <Ionicons name="trending-down" size={20} color={side === 'short' ? '#fff' : colors.status.error} />
          <Text style={[styles.sideButtonText, side === 'short' && { color: '#fff' }]}>
            {marketType === 'spot' ? t('trading.sell') : t('trading.short')}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 6 + Math.max(0, insets.bottom) }}
      >
        {showOrderBook ? <OrderBookCard coin={orderBookCoin} /> : null}

        {marketType === 'perp' ? (
          <View style={styles.section}>
            <View style={styles.modeRow}>
              <Text style={styles.sectionTitle}>{t('trading.margin')}</Text>
              <View style={styles.modePills}>
                <TouchableOpacity
                  style={[styles.infoIconButton, styles.modeInfoButton]}
                  onPress={() =>
                    setInfoModal({
                      title: t('trading.marginModes'),
                      body: t('trading.marginModesDescription'),
                    })
                  }
                >
                  <Ionicons name="information-circle" size={16} color={colors.text.tertiary} />
                </TouchableOpacity>
                {(() => {
                  // Resting limit orders also pin the asset's margin mode
                  // (HL flips them silently otherwise — see
                  // `restingOrderLockForCoin` derivation above).
                  const posLocked = currentPosition?.marginType ?? restingOrderLockForCoin?.marginType;
                  const isolatedDisabled = posLocked === 'cross';
                  const crossDisabled = !effectiveSupportsCross || posLocked === 'isolated';
                  return (
                    <>
                      <TouchableOpacity
                        style={[
                          styles.modePill,
                          marginMode === 'isolated' && styles.modePillActive,
                          isolatedDisabled && styles.modePillDisabled,
                        ]}
                        onPress={() => {
                          if (isolatedDisabled) return;
                          setMarginModeTouched(true);
                          setMarginMode('isolated');
                          if (marginTiersCoin && marginSupport) {
                            saveMarginTypeForSymbol(
                              tradingAddress || null,
                              marginTiersCoin,
                              'isolated',
                              effectiveSupportsCross,
                              true,
                            );
                          }
                        }}
                        disabled={isolatedDisabled}
                      >
                        <Text style={[
                          styles.modePillText,
                          marginMode === 'isolated' && styles.modePillTextActive,
                          isolatedDisabled && styles.modePillTextDisabled,
                        ]}>
                          {t('trading.isolated')}{posLocked === 'isolated' ? ' 🔒' : ''}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.modePill,
                          marginMode === 'cross' && styles.modePillActive,
                          crossDisabled && styles.modePillDisabled,
                        ]}
                        onPress={() => {
                          if (crossDisabled) return;
                          setMarginModeTouched(true);
                          setMarginMode('cross');
                          if (marginTiersCoin && marginSupport) {
                            saveMarginTypeForSymbol(
                              tradingAddress || null,
                              marginTiersCoin,
                              'cross',
                              effectiveSupportsCross,
                              true,
                            );
                          }
                        }}
                        disabled={crossDisabled}
                      >
                        <Text
                          style={[
                            styles.modePillText,
                            marginMode === 'cross' && styles.modePillTextActive,
                            crossDisabled && styles.modePillTextDisabled,
                          ]}
                        >
                          {t('trading.cross')}{posLocked === 'cross' ? ' 🔒' : ''}
                        </Text>
                      </TouchableOpacity>
                    </>
                  );
                })()}
              </View>
              {/* HIP-3 + standard-mode → cross is gated by HL itself; show
                  a hint instead of letting the user wonder why the toggle
                  is disabled (matches the pop-up HL's own UI shows). */}
              {!currentPosition?.marginType &&
                asset?.isHip3 &&
                !!marginSupport?.supportsCross &&
                !canUseCrossOnAsset(true, effectiveTradingState?.accountAbstractionMode ?? null) && (
                  null
                )}
            </View>
            <LeverageSlider
              min={1}
              max={maxLeverage}
              value={leverage}
              onChange={handleLeverageSelect}
              allowInput
              inputSuffix="x"
              disabled={isLeverageLocked}
            />
            {isLeverageLocked ? (
              <Text style={styles.leverageLockedHint}>
                🔒 {t('trading.leverageLocked', {
                  leverage: currentPosition?.leverage ?? restingOrderLockForCoin?.leverage,
                })}
              </Text>
            ) : null}
          </View>
        ) : null}
          
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('trading.orderTypes')}</Text>

          <View style={styles.orderTypeRow}>
            {[
              { key: 'market' as const, label: t('trading.orderTypeMarket') },
              { key: 'limit' as const, label: t('trading.orderTypeLimit') },
            ].map((o) => (
              <TouchableOpacity
                key={o.key}
                style={[styles.orderTypePill, orderType === o.key && styles.orderTypePillActive]}
                onPress={() => setOrderType(o.key)}
              >
                <Text style={[styles.orderTypePillText, orderType === o.key && styles.orderTypePillTextActive]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
            {marketType === 'perp' ? (
              <TouchableOpacity
                style={[styles.orderTypeMoreButton, isTriggerOrder && styles.orderTypeMoreButtonActive]}
                onPress={() => setShowOrderTypeModal(true)}
                accessibilityLabel={t('trading.moreOrderTypes')}
              >
                <Ionicons
                  name="chevron-down"
                  size={18}
                  color={isTriggerOrder ? colors.accent.gold : colors.text.tertiary}
                />
              </TouchableOpacity>
            ) : null}
          </View>
          {marketType === 'perp' && isTriggerOrder ? (
            <Text style={styles.orderTypeHint}>{orderTypeLabel}</Text>
          ) : null}

          {marketType === 'perp' && isTriggerOrder && (
            <View style={styles.inputRow}>
              <Text style={styles.inputLabelStandalone}>
                {isStopOrder
                  ? t('trading.orderTypeStopMarketTriggerPrice')
                  : t('trading.orderTypeTakeMarketTriggerPrice')}
              </Text>
              <TextInput
                value={triggerPxText}
                onChangeText={setTriggerPxText}
                keyboardType="decimal-pad"
                placeholder={currentMidPx ? formatPriceNum(currentMidPx) : asset?.markPx ? formatPrice(asset.markPx) : '0'}
                placeholderTextColor={colors.text.tertiary}
                style={styles.input}
              />
        </View>
          )}

          {(orderType === 'limit' || isLimitStyleTrigger) && (
            <View style={styles.inputRow}>
              <Text style={styles.inputLabelStandalone}>{t('trading.limitPrice')}</Text>
              <TextInput
                value={limitPxText}
                onChangeText={setLimitPxText}
                keyboardType="decimal-pad"
                placeholder={currentMidPx ? formatPriceNum(currentMidPx) : asset?.markPx ? formatPrice(asset.markPx) : '0'}
                placeholderTextColor={colors.text.tertiary}
                style={styles.input}
              />
        </View>
          )}

          <View style={styles.inputRow}>
            <View style={styles.inputLabelRow}>
              <Text style={styles.inputLabel}>{t('trading.sizeUsd')}</Text>
              <View style={styles.availableRow}>
                <TouchableOpacity onPress={setSizeToMax} disabled={isSizeInputLocked || !showOrderAvailableAmount || availableUsdForTrade <= 0}>
                  <Text style={styles.inputLabelRight}>
                    {t('trading.available', {
                      amount:
                        marketType === 'perp' && !showOrderAvailableAmount
                          ? '—'
                          : availableUsdForTrade.toFixed(2),
                    })}
                  </Text>
                </TouchableOpacity>
                {showSpotPerpTransferLink ? (
                  <TouchableOpacity onPress={() => setTransferModalOpen(true)}>
                    <Text style={styles.transferLink}>{t('portfolio.transfer')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            {/*
             * DISABLED: Trade Balance / perp·spot breakdown row + Balance modal trigger.
             * Kept for easy restore. Balance Modal JSX remains in tree.
             *
            <View style={styles.inputLabelRow}>
              <View />
              <View style={styles.availableRow}>
                <Text style={styles.availableSubLabel}>
                  {isHlPooledAccount
                      ? `${t('deposit.tradeBalance', 'Trade Balance')} $${(effectiveTradingState?.accountValueUsd ?? 0).toFixed(2)} · ${t('trading.spot')} ${spotBalances.hasData || spotBaseAvailable.hasData
                          ? `$${spotTotalUsd.toFixed(2)}`
                          : '--'}`
                    : `${t('portfolio.perp')} $${hlOrderAvailableUsd.toFixed(2)} · ${t('trading.spot')} ${spotBalances.hasData || spotBaseAvailable.hasData
                        ? `$${spotTotalUsd.toFixed(2)}`
                        : '--'}`}
                </Text>
                {canToggleSpot ? (
                  <TouchableOpacity onPress={() => setBalanceModalOpen(true)}>
                    <Text style={styles.transferLink}>{t('portfolio.balance')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            */}
            <View style={styles.inputShell}>
              <Animated.View
                style={{
                  opacity: calculatingOpacity.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0],
                  }),
                }}
                pointerEvents={showCalculating ? 'none' : 'auto'}
              >
                <TextInput
                  value={uiSizeUsdText}
                  onChangeText={handleSizeUsdChange}
                  editable={!isSizeInputLocked}
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.input}
                />
              </Animated.View>
              {calculatingLayerMounted ? (
                <Animated.View
                  style={[
                    styles.input,
                    styles.inputCalculating,
                    styles.inputOverlay,
                    { opacity: calculatingOpacity },
                  ]}
                  pointerEvents="none"
                >
                  <BouncingDots color={colors.text.primary} dotSize={6} pulse />
                </Animated.View>
              ) : null}
            </View>
            <View style={styles.inputHintShell}>
              <Animated.Text
                style={[
                  styles.inputHint,
                  {
                    opacity: calculatingOpacity.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 0],
                    }),
                  },
                ]}
              >
                ≈ {uiSizeUnits ? `${uiSizeUnits.toFixed(4)} ${asset?.symbol || ''}` : '--'}
              </Animated.Text>
              {calculatingLayerMounted ? (
                <Animated.View
                  style={[styles.inputHintRow, styles.inputHintOverlay, { opacity: calculatingOpacity }]}
                  pointerEvents="none"
                >
                  <Text style={styles.inputHint}>≈ </Text>
                  <BouncingDots
                    color={colors.text.tertiary}
                    dotSize={2}
                    pulse
                    style={styles.sizeHintDots}
                  />
                </Animated.View>
              ) : null}
            </View>
          </View>

          <LeverageSlider
            min={0}
            max={100}
            value={uiDisplaySizePct}
            onChange={handleSizePctSliderChange}
            label={t('trading.sizePercent')}
            allowInput
            inputSuffix="%"
            enableHaptics={false}
            labelStyle={styles.inputLabel}
            disabled={isSizeInputLocked}
          />
          
        {marketType === 'perp' && !isTriggerOrder ? (
        <View style={styles.tpSlRow}>
          <View style={styles.tpSlToggle}>
            <TouchableOpacity onPress={() => setTpEnabled((v) => !v)}>
              <Ionicons name={tpEnabled ? 'checkbox' : 'square-outline'} size={18} color={tpEnabled ? colors.accent.gold : colors.text.tertiary} />
            </TouchableOpacity>
              <TouchableOpacity 
              onPress={() =>
                setInfoModal({
                  title: t('trading.takeProfit'),
                  body: t('trading.takeProfitDescription'),
                })
              }
            >
              <DashedUnderline text={t('trading.takeProfit')} textStyle={styles.tpSlLink} />
              </TouchableOpacity>
          </View>
          <View style={styles.tpSlToggle}>
            <TouchableOpacity onPress={() => setSlEnabled((v) => !v)}>
              <Ionicons name={slEnabled ? 'checkbox' : 'square-outline'} size={18} color={slEnabled ? colors.accent.gold : colors.text.tertiary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() =>
                setInfoModal({
                  title: t('trading.stopLoss'),
                  body: t('trading.stopLossDescription'),
                })
              }
            >
              <DashedUnderline text={t('trading.stopLoss')} textStyle={styles.tpSlLink} />
            </TouchableOpacity>
        </View>
        </View>
        ) : null}

        {marketType === 'perp' && !isTriggerOrder && (tpEnabled || slEnabled) ? (
            <View style={styles.tpSlInputs}>
              {tpEnabled ? (
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabelStandalone}>{t('trading.tpPrice')}</Text>
                  <TextInput
                    value={tpPxText}
                    onChangeText={setTpPxText}
                    keyboardType="decimal-pad"
                    placeholder={asset?.markPx ? formatPrice(asset.markPx) : '0'}
                    placeholderTextColor={colors.text.tertiary}
                    style={styles.input}
                  />
                  <Text style={styles.inputHint}>
                    {t('trading.estGain')}:{' '}
                    {typeof tpEstPnlUsd === 'number' && Number.isFinite(tpEstPnlUsd)
                      ? `$${tpEstPnlUsd.toFixed(2)}`
                      : '--'}
                  </Text>
          </View>
              ) : null}

              {slEnabled ? (
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabelStandalone}>{t('trading.slPrice')}</Text>
                  <TextInput
                    value={slPxText}
                    onChangeText={setSlPxText}
                    keyboardType="decimal-pad"
                    placeholder={asset?.markPx ? formatPrice(asset.markPx) : '0'}
                    placeholderTextColor={colors.text.tertiary}
                    style={styles.input}
                  />
                  <Text style={styles.inputHint}>
                    {t('trading.estLoss')}:{' '}
                    {typeof slEstLossUsd === 'number' && Number.isFinite(slEstLossUsd)
                      ? `$${slEstLossUsd.toFixed(2)}`
                      : '--'}
                  </Text>
          </View>
              ) : null}
          </View>
          ) : null}

        </View>

        {marketType === 'perp' ? (
          <TradeSimulator
            entryPx={perpOrderEntryPx}
            side={side}
            sizeUsd={uiSizeUsd}
            sizeUnits={uiSizeUnits}
            leverage={leverage}
            orderType={orderType}
            takerFeeRate={takerFeeRate}
            makerFeeRate={makerFeeRate}
            marginTiers={marginTiers}
            marginMode={marginMode}
            accountEquityUsd={accountEquityUsd}
            crossMaintenanceMarginUsedUsd={hlCrossMaintenanceMarginUsedUsd}
            accountAbstractionMode={effectiveTradingState?.accountAbstractionMode ?? null}
            unifiedSpotUsdcBalanceUsd={effectiveTradingState?.spotUsdcBalanceUsd ?? 0}
            unifiedTotalIsolatedMarginUsedUsd={effectiveTradingState?.totalIsolatedMarginUsedUsd ?? 0}
            unifiedTotalCrossMaintenanceMarginUsedUsd={effectiveTradingState?.totalCrossMaintenanceMarginUsedUsd ?? 0}
            debugCrossLiqInputs={crossLiqDebugInputs}
            existingPosition={currentPosition}
            livePrice={currentMidPx}
            isCalculating={showCalculating}
            isLoading={!asset || !tradingState}
          />
        ) : (
          <LinearGradient
            colors={['#1a1a2e', '#16213e', '#0f0f1a']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summaryCard}
          >
            <View style={styles.summaryTitleRow}>
              <Text style={styles.summaryTitle}>{t('trading.orderSummary')}</Text>
              {(!asset || !tradingState) && <Text style={styles.loadingText}>{t('common.loading')}</Text>}
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t('trading.orderValue')}</Text>
              <View style={styles.summaryValueShell}>
                <Animated.Text
                  style={[
                    styles.summaryValue,
                    {
                      opacity: calculatingOpacity.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0],
                      }),
                    },
                  ]}
                >
                  {uiSizeUsd > 0 ? `$${uiSizeUsd.toFixed(2)}` : '--'}
                </Animated.Text>
                {calculatingLayerMounted ? (
                  <Animated.View style={[styles.summaryValueOverlay, { opacity: calculatingOpacity }]}>
                    <BouncingDots color={colors.text.primary} dotSize={5} pulse />
                  </Animated.View>
                ) : null}
              </View>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t('trading.price')}</Text>
              <Text style={styles.summaryValue}>
                {orderType === 'limit' && Number.isFinite(limitPx ?? NaN)
                  ? `$${formatPriceNum(limitPx as number)}`
                  : currentMidPx
                    ? `$${formatPriceNum(currentMidPx)}`
                    : '--'}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <TouchableOpacity
                onPress={() =>
                  setInfoModal({
                    title: t('trading.spotFees'),
                    body:
                      `${t('trading.taker')}: ${spotTakerFeePct.toFixed(4)}%\n` +
                      `${t('trading.maker')}: ${spotMakerFeePct.toFixed(4)}%`,
                  })
                }
                activeOpacity={0.7}
                style={styles.feesLabelContainer}
              >
                <DashedUnderline text={t('trading.fees')} textStyle={styles.summaryLabel} />
              </TouchableOpacity>
              <Text style={styles.summaryValue}>
                {uiSizeUsd > 0 ? `${spotTakerFeePct.toFixed(4)}% / ${spotMakerFeePct.toFixed(4)}%` : '--'}
              </Text>
            </View>
          </LinearGradient>
        )}

        <TouchableOpacity 
          style={[
            styles.tradeButton,
            side === 'long' ? styles.tradeButtonLong : styles.tradeButtonShort,
            (isSubmitting || notEnoughMarginEffective || spotInvalidSize || (marketType === 'spot' && side === 'short' && !canSellSpot)) &&
              styles.tradeButtonDisabled,
          ]}
          onPress={handleSubmitOrder}
          disabled={isSubmitting || notEnoughMarginEffective || spotInvalidSize || (marketType === 'spot' && side === 'short' && !canSellSpot)}
        >
          {isSubmitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
          <Text style={styles.tradeButtonText}>
              {spotInvalidSize
                ? `${t('trading.minimum')} $${spotMinUsdRequired.toFixed(2)}`
                : notEnoughMarginEffective
                  ? t('errors.notEnoughMargin')
                  : marketType === 'spot'
                    ? `${side === 'long' ? t('trading.buy') : t('trading.sell')} ${asset?.symbol ?? ''}`
                    : `${side === 'long' ? t('trading.openLong') : t('trading.openShort')} ${asset?.symbol ?? ''}`}
          </Text>
          )}
        </TouchableOpacity>

        <View style={styles.sectionDivider}>
          <View style={styles.sectionDividerLine} />
          <Text style={styles.sectionDividerText}>{t('portfolio.tradingActivity')}</Text>
          <View style={styles.sectionDividerLine} />
        </View>
        <TradingBookSwitcher variant="chips" />
        <PortfolioTabs
          portfolioTab={portfolioTab}
          onTabChange={setPortfolioTab}
          isInitialPortfolioLoading={!tradingStateReady}
          positions={filteredPositions}
          openOrders={filteredOpenOrders}
          fills={filteredFills}
          livePrices={livePrices}
          hip3Prices={hip3Prices}
          fundingRates={fundingRates}
          fundingAccrued={fundingAccrued}
          activeAssetData={activeAssetData}
          spotBalances={combinedSpotBalances}
          currentAssetSymbol={asset?.symbol}
          currentAssetMarkPx={asset?.markPx}
          assetRouteCoin={asset?.coin ?? decodedCoin}
          assetRouteIsSpot={marketType === 'spot'}
          marginMode={marginMode}
          closingPositionKey={closingPositionKey}
          cancelingOrderId={cancelingOrderId}
          isSubmitting={isSubmitting}
          pnlShareLoading={pnlShareLoading}
          isCloseAllLoading={closeAllLoading}
          isCancelAllLoading={cancelAllLoading}
          noHorizontalMargin
          onClosePosition={handleMarketClose}
          onCancelOrder={handleCancelOrder}
          onCloseAllPositions={handleCloseAllPositions}
          onCancelAllOrders={handleCancelAllOrders}
          onModifyOrder={handleModifyOrder}
          onOpenTpsl={handleOpenTpsl}
          onSharePositionPnl={handleSharePositionPnl}
          onShareFillPnl={handleShareFillPnl}
          formatPrice={dcFormatPrice}
          formatPriceNum={dcFormatPriceNum}
          formatSignedUsd={dcFormatSignedUsd}
          safeNum={safeNum}
          formatShortTime={formatShortTime}
          aiScopeAgentId={activeTradingBook.agentId}
        />
      </ScrollView>
      <Modal transparent visible={!!infoModal} animationType="fade" onRequestClose={() => setInfoModal(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setInfoModal(null)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{infoModal?.title ?? 'Info'}</Text>
            <Text style={styles.modalText}>{infoModal?.body ?? ''}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setInfoModal(null)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

type DashedUnderlineProps = {
  text: string;
  textStyle?: any;
};

const DashedUnderline = ({ text, textStyle }: DashedUnderlineProps) => {
  const [textWidth, setTextWidth] = useState(0);
  const dashWidth = 4;
  const dashGap = 1;
  const dashPattern = dashWidth + dashGap;
  const numDashes = textWidth > 0 ? Math.max(1, Math.floor(textWidth / dashPattern)) : 0;
  const underlineWidth = numDashes * dashWidth + (numDashes - 1) * dashGap;

  return (
    <View style={{ position: 'relative', alignSelf: 'flex-start' }}>
      <Text
        style={textStyle}
        onLayout={(e) => {
          const width = e.nativeEvent.layout.width;
          if (width > 0 && Math.abs(width - textWidth) > 0.5) {
            setTextWidth(width);
          }
        }}
      >
        {text}
      </Text>
      {textWidth > 0 && underlineWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            left: 0,
            width: underlineWidth,
            height: 1,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          {Array.from({ length: numDashes }).map((_, i) => (
            <View 
              key={i} 
              style={{
                width: dashWidth,
                height: 1,
                backgroundColor: colors.text.tertiary,
                marginRight: i < numDashes - 1 ? dashGap : 0,
              }} 
            />
          ))}
        </View>
      )}
    </View>
  );
};

type PnlShareCardProps = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnlPercent: number;
  entryPrice: number;
  markPrice: number;
  leverage?: number;
};

type OrderBookCardProps = {
  coin: string;
};

type OrderBookRowData = {
  key: string;
  price: string;
  size: string;
};

const OrderBookCard = memo(function OrderBookCard({ coin }: OrderBookCardProps) {
  const { t } = useTranslation();
  const orderBook = useOrderBook(coin);
  const orderBookDepth = 6;
  const [throttledBook, setThrottledBook] = useState(orderBook);
  const latestBookRef = useRef(orderBook);

  useEffect(() => {
    latestBookRef.current = orderBook;
  }, [orderBook]);

  useEffect(() => {
    const id = setInterval(() => {
      setThrottledBook(latestBookRef.current);
    }, 250);
    return () => clearInterval(id);
  }, []);

  const formatPrice = (price: string | null | undefined): string => {
    if (!price) return '--';
    const num = parseFloat(price);
    const abs = Math.abs(num);
    if (abs >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 100) return num.toFixed(2);
    if (abs >= 10) return num.toFixed(3);
    if (abs >= 1) return num.toFixed(3);
    if (abs >= 0.1) return num.toFixed(4);
    return num.toFixed(6);
  };

  const formatPriceNum = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 100) return n.toFixed(2);
    if (abs >= 10) return n.toFixed(3);
    if (abs >= 1) return n.toFixed(3);
    if (abs >= 0.1) return n.toFixed(4);
    return n.toFixed(6);
  };

  const orderBookView = useMemo(() => {
    const bidsRaw = (throttledBook?.bids ?? []).slice(0, orderBookDepth);
    const asksRaw = (throttledBook?.asks ?? []).slice(0, orderBookDepth);
    const bestBid = bidsRaw[0]?.px ? parseFloat(String(bidsRaw[0].px)) : NaN;
    const bestAsk = asksRaw[0]?.px ? parseFloat(String(asksRaw[0].px)) : NaN;
    const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? bestAsk - bestBid : NaN;
    const spreadPct =
      Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0
        ? (spread / bestBid) * 100
        : NaN;
    const bids: OrderBookRowData[] = bidsRaw.map((lvl) => ({
      key: String(lvl.px),
      price: formatPrice(String(lvl.px)),
      size: formatPrice(String(lvl.sz)),
    }));
    const asks: OrderBookRowData[] = asksRaw.map((lvl) => ({
      key: String(lvl.px),
      price: formatPrice(String(lvl.px)),
      size: formatPrice(String(lvl.sz)),
    }));
    return { bids, asks, spread, spreadPct };
  }, [orderBookDepth, throttledBook?.bids, throttledBook?.asks]);

  const renderAsk = useCallback(({ item }: ListRenderItemInfo<OrderBookRowData>) => (
    <View style={styles.orderBookRow}>
      <Text style={[styles.orderBookPrice, styles.orderBookAsk]}>{item.price}</Text>
      <Text style={styles.orderBookSize}>{item.size}</Text>
    </View>
  ), []);

  const renderBid = useCallback(({ item }: ListRenderItemInfo<OrderBookRowData>) => (
    <View style={styles.orderBookRow}>
      <Text style={[styles.orderBookPrice, styles.orderBookBid]}>{item.price}</Text>
      <Text style={styles.orderBookSize}>{item.size}</Text>
    </View>
  ), []);

  return (
    <View style={styles.orderBookCard}>
      <View style={styles.orderBookHeader}>
        <Text style={styles.sectionTitle}>{t('trading.orderBook')}</Text>
        <Text style={styles.orderBookSubText}>
          {Number.isFinite(orderBookView.spread)
            ? `${t('trading.spread')}: ${formatPriceNum(orderBookView.spread)} (${orderBookView.spreadPct.toFixed(3)}%)`
            : `${t('trading.spread')}: --`}
        </Text>
      </View>
      <View style={styles.orderBookColumns}>
        <View style={styles.orderBookCol}>
          <Text style={styles.orderBookColTitle}>{t('trading.asks')}</Text>
          {orderBookView.asks.length ? (
            <FlashList
              data={orderBookView.asks}
              renderItem={renderAsk}
              keyExtractor={(item) => `ask-${item.key}`}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews
            />
          ) : (
            <Text style={styles.orderBookEmpty}>--</Text>
          )}
        </View>
        <View style={styles.orderBookCol}>
          <Text style={styles.orderBookColTitle}>{t('trading.bids')}</Text>
          {orderBookView.bids.length ? (
            <FlashList
              data={orderBookView.bids}
              renderItem={renderBid}
              keyExtractor={(item) => `bid-${item.key}`}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews
            />
          ) : (
            <Text style={styles.orderBookEmpty}>--</Text>
          )}
        </View>
      </View>
    </View>
  );
});

const PnlShareCard = ({
  symbol,
  direction,
  pnlPercent,
  entryPrice,
  markPrice,
  leverage,
}: PnlShareCardProps) => {
  const { t } = useTranslation();
  const isProfit = pnlPercent >= 0;
  return (
    <View style={styles.pnlCard}>
      <View style={styles.pnlGlowTop} />
      <View style={styles.pnlGlowBottom} />

      <View style={styles.pnlHeader}>
        <View style={styles.pnlLogoWrap}>
          <Image source={require('../../assets/images/pnl-logo.webp')} style={styles.pnlLogo} />
        </View>
        <View style={styles.pnlTitleContainer}>
          <Text style={styles.pnlLogoText}>Hyper</Text>
          <MaskedView style={styles.pnlGradientMask} maskElement={<Text style={styles.pnlGradientText}>Trade</Text>}>
            <LinearGradient
              colors={[colors.accent.gold, colors.accent.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              <Text style={[styles.pnlGradientText, styles.pnlGradientFill]}>Trade</Text>
            </LinearGradient>
          </MaskedView>
        </View>
      </View>

      <View style={styles.pnlSymbolRow}>
        <Text style={styles.pnlSymbol}>{symbol}</Text>
        <View style={[styles.pnlDirectionPill, direction === 'LONG' ? styles.pnlDirectionLong : styles.pnlDirectionShort]}>
          <Text style={[styles.pnlDirectionText, direction === 'LONG' ? styles.pnlDirectionLongText : styles.pnlDirectionShortText]}>
            {direction}
            {leverage ? ` ${leverage}x` : ''}
          </Text>
        </View>
      </View>

      <View style={styles.pnlValueBlock}>
        <Text style={[styles.pnlPercent, isProfit ? styles.pnlPercentUp : styles.pnlPercentDown]}>
          {isProfit ? '+' : ''}
          {Number.isFinite(pnlPercent) ? pnlPercent.toFixed(2) : '0.00'}%
        </Text>
        <Text style={styles.pnlLabel}>PNL</Text>
      </View>

      <View style={styles.pnlPrices}>
        <View style={styles.pnlPriceCol}>
          <Text style={styles.pnlPriceLabel}>{t('trading.entryPrice')}</Text>
          <Text style={styles.pnlPriceValue}>${entryPrice.toLocaleString()}</Text>
        </View>
        <View style={styles.pnlPriceCol}>
          <Text style={styles.pnlPriceLabel}>{t('trading.markPrice')}</Text>
          <Text style={styles.pnlPriceValue}>${markPrice.toLocaleString()}</Text>
        </View>
      </View>

      <LinearGradient
        colors={[colors.accent.gold, colors.accent.blue, colors.accent.purple]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.pnlBottomBar}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.primary },
  closeButton: { padding: 8 },
  orderBookToggle: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  orderBookToggleActive: {
    backgroundColor: `${colors.accent.gold}20`,
    borderColor: colors.accent.gold,
  },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 8 },
  headerTitle: { marginLeft: 12, minWidth: 0, flexShrink: 1 },
  symbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  sectionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 10,
    marginHorizontal: 16,
    gap: 12,
  },
  sectionDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border.primary,
  },
  sectionDividerText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  marketBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}20`,
  },
  marketBadgeText: { color: colors.accent.gold, fontSize: 9, fontWeight: '800' },
  headerPriceBlock: { alignItems: 'flex-start' },
  headerPriceWithHint: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  price: { fontSize: 16, fontWeight: '800', color: colors.text.primary },
  priceChangeBadge: { fontSize: 12, fontWeight: '800', marginTop: 1 },
  content: { flex: 1, padding: 16 },
  sideSelectorPinned: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: colors.background.primary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  sideButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 12, backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary, gap: 8 },
  sideButtonLongActive: { backgroundColor: colors.status.success, borderColor: colors.status.success },
  sideButtonShortActive: { backgroundColor: colors.status.error, borderColor: colors.status.error },
  sideButtonDisabled: { opacity: 0.5 },
  sideButtonText: { fontSize: 16, fontWeight: '600', color: colors.text.secondary },
  sideButtonTextActive: { color: '#fff' },
  section: { marginBottom: 24 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
  leverageBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, gap: 4 },
  leverageValue: { fontSize: 14, fontWeight: '700' },
  leverageButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  leverageButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.accent.gold,
    borderWidth: 2,
    borderColor: colors.text.primary,
    shadowColor: '#000',
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 0.6,
    shadowRadius: 0,
    elevation: 4,
  },
  leverageButtonText: { fontSize: 14, fontWeight: '800', color: colors.background.primary },
  amountButtons: { flexDirection: 'row', gap: 8, marginTop: 12 },
  amountButton: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.background.tertiary, alignItems: 'center', borderWidth: 1, borderColor: colors.border.primary },
  amountButtonActive: { backgroundColor: `${colors.accent.gold}20`, borderColor: colors.accent.gold },
  amountButtonText: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },
  amountButtonTextActive: { color: colors.accent.gold },
  summaryCard: { backgroundColor: colors.background.card, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.primary },
  calculating: { opacity: 0.5 },
  summaryTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  summaryTitle: { color: '#A0A0A0', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  loadingText: { color: colors.accent.gold, fontSize: 11, fontWeight: '600' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  summaryLabel: { fontSize: 14, color: colors.text.secondary },
  summaryValue: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  feesLabelContainer: { alignItems: 'flex-start' },
  dashedUnderline: { flexDirection: 'row', marginTop: 2 },
  dash: { width: 6, height: 2, backgroundColor: colors.text.tertiary, borderRadius: 2 },
  tradeButton: { paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginBottom: 8, marginTop: 16 },
  tradeButtonLong: { backgroundColor: colors.status.success },
  tradeButtonShort: { backgroundColor: colors.status.error },
  tradeButtonText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  tradeButtonDisabled: { opacity: 0.55 },
  infoCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: `${colors.accent.gold}10`, padding: 12, borderRadius: 8, marginBottom: 32 },
  infoText: { fontSize: 13, color: colors.accent.gold },

  orderTypeRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  orderTypePill: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  orderTypePillActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  orderTypePillText: { color: colors.text.secondary, fontSize: 12, fontWeight: '700' },
  orderTypePillTextActive: { color: colors.accent.gold },
  orderTypeMoreButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  orderTypeMoreButtonActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  orderTypeHint: { marginTop: 6, color: colors.text.tertiary, fontSize: 11, fontWeight: '700' },
  leverageLockedHint: {
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },

  modeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  modePills: { flexDirection: 'row', gap: 8 },
  modePill: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modePillActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  modePillDisabled: { opacity: 0.5 },
  modePillText: { color: colors.text.secondary, fontSize: 12, fontWeight: '800' },
  modePillTextActive: { color: colors.accent.gold },
  modePillTextDisabled: { color: colors.text.tertiary },

  inputRow: { marginTop: 12 },
  inputLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  inputLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700' },
  inputLabelStandalone: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700', marginBottom: 8 },
  inputLabelRight: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700' },
  availableRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  transferLink: { color: colors.accent.gold, fontSize: 12, fontWeight: '800' },
  availableSubLabel: { color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.border.primary, backgroundColor: colors.background.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, color: colors.text.primary, fontSize: 14 },
  inputShell: { position: 'relative' },
  inputOverlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  inputCalculating: { alignItems: 'flex-start', justifyContent: 'center', minHeight: 46 },
  inputHintShell: { position: 'relative', minHeight: 17 },
  inputHintOverlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  inputError: { borderColor: colors.status.error },
  inputHint: { marginTop: 6, color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  inputHintRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 4 },
  sizeHintDots: { height: 10, justifyContent: 'center' },
  summaryValueShell: { position: 'relative', minWidth: 48, minHeight: 18, justifyContent: 'center' },
  summaryValueOverlay: { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  inputErrorText: { marginTop: 6, color: colors.status.error, fontSize: 11, fontWeight: '600' },
  percentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  percentBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },

  tpSlRow: { flexDirection: 'row', gap: 12, marginTop: 12, alignItems: 'center' },
  tpSlToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
  },
  tpSlToggleText: { color: colors.text.secondary, fontSize: 12, fontWeight: '800' },
  tpSlLinkContainer: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  tpSlLink: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '800',
  },
  tpSlLinkUnderline: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    right: 0,
    height: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tpSlDash: {
    width: 4,
    height: 1,
    backgroundColor: colors.text.tertiary,
  },
  tpSlDashGap: {
    width: 2,
    height: 1,
  },
  tpSlInputs: { marginTop: 8 },
  infoIconButton: { padding: 4, borderRadius: 999 },
  modeInfoButton: { paddingVertical: 6, alignSelf: 'center' },

  transferToggleRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 8 },
  transferToggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
    alignItems: 'center',
  },
  transferToggleButtonActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  transferToggleText: { color: colors.text.secondary, fontSize: 12, fontWeight: '800' },
  transferToggleTextActive: { color: colors.accent.gold },
  transferAmountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  transferMaxText: { color: colors.accent.gold, fontSize: 12, fontWeight: '800' },
  transferInput: {
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.text.primary,
    fontSize: 14,
  },
  transferAvailableText: { marginTop: 6, color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  transferWarningText: { marginTop: 6, color: colors.accent.gold, fontSize: 11, fontWeight: '700' },

  orderBookCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 16,
    backgroundColor: colors.background.card,
  },
  orderBookHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  orderBookSubText: { color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  orderBookColumns: { flexDirection: 'row', gap: 12 },
  orderBookCol: { flex: 1 },
  orderBookColTitle: { color: colors.text.tertiary, fontSize: 11, fontWeight: '800', marginBottom: 6 },
  orderBookRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  orderBookPrice: { fontSize: 12, fontWeight: '800' },
  orderBookAsk: { color: colors.status.error },
  orderBookBid: { color: colors.status.success },
  spotInfoCard: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.card,
  },
  spotInfoTitle: { color: colors.text.primary, fontSize: 12, fontWeight: '800', marginBottom: 4 },
  spotInfoText: { color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  orderBookSize: { color: colors.text.secondary, fontSize: 12, fontWeight: '700' },
  orderBookEmpty: { color: colors.text.tertiary, fontSize: 12, paddingVertical: 6 },

  positionsCard: { borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.primary, marginBottom: 16 },
  positionsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10 },
  positionsTitle: { color: colors.text.primary, fontSize: 14, fontWeight: '800' },
  positionsSub: { color: colors.text.tertiary, fontSize: 12, fontWeight: '600' },
  positionsEmpty: { color: colors.text.tertiary, fontSize: 12, paddingVertical: 6 },
  positionRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border.primary },
  positionTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  positionLeverage: {
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '900',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  positionCoin: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  positionAction: { color: colors.accent.gold, fontSize: 12, fontWeight: '800' },
  positionMeta: { color: colors.text.tertiary, fontSize: 12, marginTop: 2 },
  positionPnl: { fontSize: 12, fontWeight: '700', marginTop: 8 },

  portfolioTabs: { flexDirection: 'row', gap: 8, flex: 1 },
  portfolioTab: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  portfolioTabActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  portfolioTabText: { color: colors.text.secondary, fontSize: 12, fontWeight: '800' },
  portfolioTabTextActive: { color: colors.accent.gold },

  positionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sidePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  sidePillLong: { backgroundColor: `${colors.status.success}15`, borderColor: `${colors.status.success}55` },
  sidePillShort: { backgroundColor: `${colors.status.error}15`, borderColor: `${colors.status.error}55` },
  sidePillText: { fontSize: 11, fontWeight: '900' },
  sidePillTextLong: { color: colors.status.success },
  sidePillTextShort: { color: colors.status.error },

  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  metricItem: { width: '48%' },
  metricLabel: { color: colors.text.tertiary, fontSize: 11, fontWeight: '800' },
  metricValue: { color: colors.text.primary, fontSize: 12, fontWeight: '800', marginTop: 2 },
  metricSpacer: { height: 6 },
  metricButton: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  metricButtonText: { color: colors.accent.gold, fontSize: 11, fontWeight: '900' },

  modeTag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  modeTagIso: { backgroundColor: `${colors.accent.gold}10`, borderColor: `${colors.accent.gold}35` },
  modeTagCross: { backgroundColor: `${colors.accent.gold}18`, borderColor: `${colors.accent.gold}55` },
  modeTagText: { color: colors.text.secondary, fontSize: 11, fontWeight: '900' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center' },
  modalCard: { backgroundColor: colors.background.primary, borderRadius: 16, borderWidth: 1, borderColor: colors.border.primary, padding: 16 },
  modalTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { color: colors.text.primary, fontSize: 16, fontWeight: '900', marginBottom: 8 },
  // Demo-mode pill shown atop the setup modal when env is demo. Subtle gold
  // pill, leaves the modal layout untouched in mainnet flows.
  demoSetupPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: `${colors.accent.gold}20`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}55`,
    marginBottom: 10,
  },
  demoSetupPillText: { color: colors.accent.gold, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  modalText: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 12 },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  modalLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700' },
  modalValue: { color: colors.text.primary, fontSize: 12, fontWeight: '800' },
  modalError: { color: colors.status.error, fontSize: 12, fontWeight: '700', marginTop: 6 },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  modalSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modalSecondaryText: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  modalPrimary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.accent.gold },
  modalPrimaryText: { color: colors.background.primary, fontSize: 13, fontWeight: '900' },
  confirmCheckboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  confirmCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
  },
  confirmCheckboxChecked: {
    backgroundColor: colors.accent.gold,
    borderColor: colors.accent.gold,
  },
  confirmCheckboxText: { color: colors.text.secondary, fontSize: 12, fontWeight: '700' },

  positionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  positionShareButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },

  pnlModalCard: { backgroundColor: colors.background.primary, borderRadius: 16, borderWidth: 1, borderColor: colors.border.primary, padding: 16, gap: 12 },
  pnlModalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pnlShareShot: { alignItems: 'center' },
  pnlShareButton: {
    width: 320,
    alignSelf: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.gold,
  },
  pnlShareButtonText: { color: colors.background.primary, fontSize: 14, fontWeight: '900' },
  pnlHint: { color: colors.text.tertiary, fontSize: 11, textAlign: 'center' },

  pnlShareInline: {
    marginTop: 6,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  pnlShareText: { color: colors.accent.gold, fontSize: 11, fontWeight: '800' },
  pnlInlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pnlInlineButton: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },

  pnlCard: {
    width: 320,
    borderRadius: 18,
    backgroundColor: '#0d1117',
    padding: 16,
    overflow: 'hidden',
  },
  pnlGlowTop: {
    position: 'absolute',
    right: -60,
    top: -60,
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 209, 255, 0.18)',
  },
  pnlGlowBottom: {
    position: 'absolute',
    left: -40,
    bottom: -40,
    width: 140,
    height: 140,
    borderRadius: 999,
    backgroundColor: 'rgba(138, 92, 246, 0.18)',
  },
  pnlHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pnlLogoWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.background.tertiary,
  },
  pnlLogo: { width: '100%', height: '100%' },
  pnlTitleContainer: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  pnlLogoText: { color: colors.text.primary, fontSize: 16, fontWeight: '800' },
  pnlGradientMask: { height: 20, justifyContent: 'flex-start', marginTop: -2 },
  pnlGradientText: { fontSize: 16, fontWeight: '800', color: 'black' },
  pnlGradientFill: { opacity: 0 },

  pnlSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  pnlSymbol: { color: colors.text.primary, fontSize: 18, fontWeight: '800' },
  pnlDirectionPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  pnlDirectionLong: { backgroundColor: 'rgba(16, 185, 129, 0.18)', borderColor: 'rgba(16, 185, 129, 0.45)' },
  pnlDirectionShort: { backgroundColor: 'rgba(244, 63, 94, 0.18)', borderColor: 'rgba(244, 63, 94, 0.45)' },
  pnlDirectionText: { fontSize: 11, fontWeight: '800' },
  pnlDirectionLongText: { color: colors.status.success },
  pnlDirectionShortText: { color: colors.status.error },

  pnlValueBlock: { marginTop: 12 },
  pnlPercent: { fontSize: 40, fontWeight: '900' },
  pnlPercentUp: { color: colors.status.success },
  pnlPercentDown: { color: colors.status.error },
  pnlLabel: { color: colors.text.tertiary, fontSize: 12, marginTop: 2 },

  pnlPrices: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#1c2128', paddingTop: 10, flexDirection: 'row', gap: 16 },
  pnlPriceCol: { flex: 1 },
  pnlPriceLabel: { color: colors.text.tertiary, fontSize: 11, fontWeight: '700' },
  pnlPriceValue: { color: colors.text.primary, fontSize: 13, fontWeight: '700', marginTop: 4 },
  pnlBottomBar: { marginTop: 14, height: 4, borderRadius: 999 },
});
